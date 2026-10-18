//! Mode-3 guidance parity: the `system_text` ck-mc's `tool.catalog` serves
//! must be byte-identical to the Magic Context guidance the standalone OpenCode
//! and Pi plugins put into a session's system prompt for the same
//! configuration.
//!
//! `testdata/standalone-guidance-parity.json` is captured from the plugins'
//! real composition entry points by `gen/gen-standalone-guidance.ts` (the
//! OpenCode system-transform handler and Pi's `composePiSystemPrompt`); a test
//! in `packages/plugin/src/shared/standalone-guidance-capture.test.ts` fails
//! when the capture is stale. Each row names one host, one session kind and one
//! configuration, and the digest of the guidance block that host appended
//! after its own prompt (empty when it appended none).
//!
//! A session kind maps to a catalog request the way a mode-3 runner asks:
//! an OpenCode or Pi primary session is the `head` preset, an OpenCode
//! subagent the `worker` preset, and both are compacted by Magic Context. A
//! session that cannot call `ctx_reduce` is checked both ways it can arise: the
//! configuration turns compaction's tool off, or the runner excludes the tool.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use super::*;
use crate::tool_catalog::{self, CatalogConfig};

const FIXTURE: &str = "testdata/standalone-guidance-parity.json";
const FORMAT: &str = "magic-context/standalone-guidance-parity/1";

/// The matrix the generator writes: three host and session kinds, two
/// surfaces, two languages and seven on/off inputs, plus four extra languages
/// per kind.
const EXPECTED_ROWS: usize = 3 * (2 * 2 * 128 + 4);

struct Fixture {
    override_sample: String,
    rows: Vec<Value>,
    texts: BTreeMap<String, String>,
}

fn fixture() -> Fixture {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(value["format"], FORMAT);
    Fixture {
        override_sample: value["override_sample"].as_str().unwrap().to_string(),
        rows: value["rows"].as_array().unwrap().clone(),
        texts: serde_json::from_value(value["texts"].clone()).unwrap(),
    }
}

fn sha256_of(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn flag(row: &Value, name: &str) -> bool {
    row[name]
        .as_bool()
        .unwrap_or_else(|| panic!("row has no {name}: {row}"))
}

/// The module configuration a row describes, as ck-mc holds it after reading
/// the user and project tiers.
fn module_config(row: &Value, override_sample: &str, compaction_enabled: bool) -> McModuleConfig {
    let mut config = default_test_config();
    config.compaction_enabled = compaction_enabled;
    config.memory_enabled = flag(row, "memory");
    config.smart_notes_enabled = flag(row, "smart_notes");
    config.catalog.dreamer_runnable = flag(row, "dreamer");
    config.temporal_awareness = flag(row, "temporal");
    config.caveman.enabled = flag(row, "caveman");
    config.language = row["language"].as_str().map(str::to_string);
    config.catalog.prompt_surface_default = Some(row["surface"].as_str().unwrap().to_string());
    config.catalog.prompt_surface_models = BTreeMap::new();
    config.catalog.tool_descriptions = BTreeMap::new();
    config.prompt_surface_guidance_override =
        flag(row, "override").then(|| override_sample.to_string());
    config
}

/// The catalog's `system_text.text` for `preset` with the composition a mode-3
/// runner admits: Magic Context compacts the session and is listed with the
/// tools it serves under this configuration and these params. The catalog
/// refuses a composition whose list differs from what it serves, so a wrong
/// list here fails the row loudly instead of comparing the wrong text.
fn served_text(preset: &str, params: Value, config: &CatalogConfig) -> Result<String, String> {
    let role = tool_catalog::Preset::parse(preset).expect("known preset");
    let excluded: Vec<&str> = params["exclude"]
        .as_array()
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let tools: Vec<Value> = tool_catalog::definition()
        .tools
        .iter()
        .filter(|tool| {
            let name = tool.name.as_str();
            role.serves(name, true)
                && !(name == "ctx_reduce" && !config.compaction_enabled)
                && !(name == "ctx_memory" && !config.memory_enabled)
                && !excluded.contains(&name)
        })
        .map(|tool| json!({"name": tool.name, "capabilities": tool.capabilities}))
        .collect();
    let admitted = json!({
        "preset": preset,
        "params": params,
        "composition": {
            "providers": [{"provider": crate::DEFAULT_MODULE_ID, "tools": tools}],
            "compaction": {"provider": crate::DEFAULT_MODULE_ID},
        },
        "system_text": {"preset": preset, "params": {}},
    });
    let answer = tool_catalog::catalog_answer(&admitted, config)
        .map_err(|error| format!("catalog refused: {error:?}"))?;
    Ok(answer["system_text"]["text"].as_str().unwrap().to_string())
}

/// Where two texts first differ, with a little context on each side.
fn first_difference(expected: &str, actual: &str) -> String {
    let at = expected
        .bytes()
        .zip(actual.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or(expected.len().min(actual.len()));
    let window = |text: &str| {
        let mut start = at.saturating_sub(60);
        while !text.is_char_boundary(start) {
            start -= 1;
        }
        let mut end = (at + 60).min(text.len());
        while !text.is_char_boundary(end) {
            end += 1;
        }
        format!("{:?}", &text[start..end])
    };
    format!(
        "first difference at byte {at} (expected {} bytes, served {}):\n  standalone: {}\n  ck-mc:      {}",
        expected.len(),
        actual.len(),
        window(expected),
        window(actual)
    )
}

#[test]
fn standalone_guidance_capture_is_complete_and_self_consistent() {
    let fixture = fixture();
    assert_eq!(fixture.rows.len(), EXPECTED_ROWS);
    for row in &fixture.rows {
        let sha = row["sha256"].as_str().unwrap();
        let text = fixture
            .texts
            .get(sha)
            .unwrap_or_else(|| panic!("no text for {row}"));
        assert_eq!(sha256_of(text), sha, "{row}");
        assert_eq!(text.len() as u64, row["bytes"].as_u64().unwrap(), "{row}");
    }
    // Every kind of row is present, so a generator that silently dropped a
    // host or a session kind cannot pass as a smaller matrix.
    for (harness, session) in [
        ("opencode", "primary"),
        ("opencode", "subagent"),
        ("pi", "primary"),
    ] {
        assert!(fixture
            .rows
            .iter()
            .any(|row| row["harness"] == harness && row["session"] == session));
    }
}

#[test]
fn catalog_system_text_matches_standalone_guidance_for_every_configuration() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for row in &fixture.rows {
        let expected = &fixture.texts[row["sha256"].as_str().unwrap()];
        let preset = match row["session"].as_str().unwrap() {
            "primary" => "head",
            "subagent" => "worker",
            other => panic!("unknown session kind {other}"),
        };
        // A session without ctx_reduce: compaction's tool off in config, and
        // the runner excluding the tool. One way when ctx_reduce is callable.
        let ways: Vec<(bool, Value)> = if flag(row, "ctx_reduce") {
            vec![(true, json!({}))]
        } else {
            vec![
                (false, json!({})),
                (true, json!({"exclude": ["ctx_reduce"]})),
            ]
        };
        for (compaction_enabled, params) in ways {
            let config = CatalogConfig::from_module_config(&module_config(
                row,
                &fixture.override_sample,
                compaction_enabled,
            ));
            let way = format!("compaction_enabled={compaction_enabled} params={params}");
            match served_text(preset, params, &config) {
                Ok(actual) if &actual == expected => {}
                Ok(actual) => failures.push(format!(
                    "{row} [{way}]\n{}",
                    first_difference(expected, &actual)
                )),
                Err(error) => failures.push(format!("{row} [{way}]: {error}")),
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures over {} rows (a row without ctx_reduce is checked two ways); first:\n{}",
        failures.len(),
        fixture.rows.len(),
        failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n\n")
    );
}
