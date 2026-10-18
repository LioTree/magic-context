//! The historian's model chain, per-model limits, variants, timeout and output cap,
//! resolved from ck-mc's own config.
//!
//! A host bridge that synchronizes its state sends the chain with `state_sync`, and a
//! conversation that has received one keeps using it. A conversation nobody sends a
//! chain for (a runner lane, or any host conversation without `state_sync`) resolves
//! the same settings here, from the user's trusted config, with the precedence and
//! defaults the TypeScript plugin uses. The committed fixture
//! `testdata/historian-config-resolution.json` is generated from the TypeScript code
//! (`packages/plugin/src/shared/historian-config-resolution.test.ts`, which also
//! fails when the TypeScript side drifts from it), and the tests below compare
//! against it.
use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::config_parity::{ConfigResolveRequest, CoreConfigResolver};
use crate::historian::HistorianModelLimits;
use mc_store::parity_schema_manifest::{CapabilityResult, Generation};

/// The per-attempt historian timeout when the config sets none. It must equal the
/// plugin's default, `DEFAULT_HISTORIAN_TIMEOUT_MS` in
/// packages/plugin/src/config/schema/magic-context.ts:20.
const DEFAULT_HISTORIAN_TIMEOUT_MS: u64 = 600_000;

/// Counter recorded on a provider conversation once a host has sent a historian chain
/// with `state_sync`. From then on the conversation keeps using the host's chain,
/// even an empty one, exactly as it did before ck-mc could resolve the chain itself.
pub(super) const CHAIN_SYNCED_COUNTER: &str = "historian_model_chain_synced";

/// The historian settings resolved for one harness.
#[derive(Debug, Clone, Default)]
pub(crate) struct ConfiguredHistorian {
    pub model_chain: Vec<String>,
    pub model_limits: BTreeMap<String, HistorianModelLimits>,
    pub model_variants: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub max_output_tokens: Option<u32>,
}

impl ConfiguredHistorian {
    /// The settings as transform-request fields, in the shape the TypeScript plugin
    /// sends them (`rustWrapupHistorianFields`, module-session-kernel.ts:105-166).
    pub(crate) fn request_fields(&self) -> Map<String, Value> {
        let mut fields = Map::new();
        fields.insert("historian_model_chain".into(), json!(self.model_chain));
        // Only the known limits, as the plugin sends them: an unknown one is absent,
        // not null.
        let limits: Map<String, Value> = self
            .model_limits
            .iter()
            .map(|(model, limits)| {
                let mut entry = Map::new();
                if let Some(context) = limits.context {
                    entry.insert("context".into(), json!(context));
                }
                if let Some(input) = limits.input {
                    entry.insert("input".into(), json!(input));
                }
                if let Some(output) = limits.output {
                    entry.insert("output".into(), json!(output));
                }
                (model.clone(), Value::Object(entry))
            })
            .collect();
        fields.insert("historian_model_limits".into(), Value::Object(limits));
        fields.insert("historian_model_variants".into(), json!(self.model_variants));
        fields.insert("historian_timeout_ms".into(), json!(self.timeout_ms));
        if let Some(max_output_tokens) = self.max_output_tokens {
            fields.insert(
                "historian_max_output_tokens".into(),
                json!(max_output_tokens),
            );
        }
        fields
    }
}

/// The value as a trimmed string, or `None` when it is not a string or is blank; the
/// plugin reads every model and qualifier this way (`readString`,
/// packages/plugin/src/shared/model-resolution.ts:20-24).
fn text(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The value when it is a JSON object; an array or scalar counts as absent, as in the
/// plugin's `asRecord` (packages/plugin/src/shared/model-resolution.ts:14-18).
fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}

/// One configured attempt: the model and its OpenCode variant or Pi thinking level.
#[derive(Debug, Clone, PartialEq)]
struct Attempt {
    model: String,
    qualifier: Option<String>,
}

/// One configured model entry: either a `provider/model` string, or an object with a
/// `model` string and an optional qualifier under `qualifier_key`. Anything else, or
/// a blank model, is no entry (`normalizeModelEntry`,
/// packages/plugin/src/shared/model-resolution.ts:43-61).
fn normalize(entry: &Value, qualifier_key: &str) -> Option<Attempt> {
    if entry.is_string() {
        return text(Some(entry)).map(|model| Attempt {
            model,
            qualifier: None,
        });
    }
    let entry = entry.as_object()?;
    Some(Attempt {
        model: text(entry.get("model"))?,
        qualifier: text(entry.get(qualifier_key)),
    })
}

/// Whether a model reads as `provider/model`: text on both sides of the first slash
/// (`isValidModelReference`, packages/plugin/src/shared/model-resolution.ts:63-66).
/// The plugin checks only fallbacks this way; a malformed primary is kept.
fn valid_reference(model: &str) -> bool {
    model
        .find('/')
        .is_some_and(|slash| slash > 0 && slash < model.len() - 1)
}

/// The primary and fallback attempts configured under `historian.<harness>`, resolved
/// as `resolveHistorianModel` does (packages/plugin/src/shared/model-resolution.ts:112-128).
fn attempts(settings: &Value, harness: &str) -> (Option<Attempt>, Vec<Attempt>) {
    let historian = record(settings.get("historian"));
    // OMP falls back to the Pi block when its own is absent or null, as
    // `resolveHarnessBlock` does (packages/plugin/src/shared/model-resolution.ts:30-36).
    let selected = match harness {
        "omp" => historian
            .and_then(|h| h.get("omp"))
            .filter(|v| !v.is_null())
            .or_else(|| historian.and_then(|h| h.get("pi"))),
        _ => historian.and_then(|h| h.get(harness)),
    };
    let Some(block) = record(selected) else {
        return (None, Vec::new());
    };
    let qualifier_key = if harness == "opencode" {
        "variant"
    } else {
        "thinking_level"
    };
    // The primary's qualifier is its own, else the one written beside it in the block
    // (`resolvePrimaryEntry`, packages/plugin/src/shared/model-resolution.ts:92-101).
    let primary = block
        .get("model")
        .and_then(|entry| normalize(entry, qualifier_key))
        .map(|mut attempt| {
            attempt.qualifier = attempt
                .qualifier
                .or_else(|| text(block.get(qualifier_key)));
            attempt
        });
    // Fallbacks are one value or a list, kept in declaration order, without malformed
    // references, and deduplicated by model plus qualifier, so one model with two
    // qualifiers stays two attempts (`resolveFallbackEntries`,
    // packages/plugin/src/shared/model-resolution.ts:77-90).
    let mut fallbacks: Vec<Attempt> = Vec::new();
    if let Some(value) = block.get("fallback_models") {
        let values = value
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(std::slice::from_ref(value));
        for value in values {
            if let Some(attempt) = normalize(value, qualifier_key) {
                if valid_reference(&attempt.model) && !fallbacks.contains(&attempt) {
                    fallbacks.push(attempt);
                }
            }
        }
    }
    (primary, fallbacks)
}

/// Resolve the historian settings for a conversation of `harness` from trusted
/// effective settings (the shape [`trusted_settings`] returns).
///
/// `settings` is the validated config object: `historian.<harness>.model`,
/// `historian.<harness>.fallback_models`, the OpenCode `variant` or Pi/OMP
/// `thinking_level`, `historian.maxTokens` and `historian_timeout_ms`.
///
/// The chain is the primary followed by the fallbacks, each model once in its first
/// position. That is the chain the OpenCode bridge sent with `state_sync`
/// (packages/plugin/src/hooks/magic-context/host-runner/opencode-adapter.ts:737-743,764)
/// and the one `rustWrapupHistorianFields` builds
/// (packages/plugin/src/hooks/magic-context/module-session-kernel.ts:111-118). A
/// model's variant is the qualifier of its first attempt, so a qualifier written only
/// on a later attempt of the same model is dropped (same file, :119-127).
///
/// The plugin looks up per-model context and output limits in the host's model
/// catalog (same file, :128-156). ck-mc has no catalog, so every chain model gets an
/// empty entry, which is what the plugin sends for a model its catalog does not
/// know. The historian window then comes from the user-tier
/// `historian.context_limit_tokens` the module already applies to every firing.
pub(crate) fn resolve(settings: &Value, harness: &str) -> ConfiguredHistorian {
    // Both OpenCode hosts read the `opencode` block, as the dreamer's model
    // resolution does (dream_runner.rs `resolve_task_models`).
    let harness = if harness == "opencode2" {
        "opencode"
    } else {
        harness
    };
    let (primary, fallbacks) = attempts(settings, harness);
    let mut resolved = ConfiguredHistorian {
        // The configured timeout, else the plugin's default, as the plugin's historian
        // sampler reads it (packages/plugin/src/hooks/magic-context/hook.ts:323).
        timeout_ms: settings
            .get("historian_timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_HISTORIAN_TIMEOUT_MS),
        // `historian.maxTokens` caps the output; unset stays unset and the module
        // applies its own default, as the plugin passes it
        // (packages/plugin/src/hooks/magic-context/host-runner/bridge-deps.ts:42).
        max_output_tokens: settings
            .pointer("/historian/maxTokens")
            .and_then(Value::as_u64)
            .and_then(|tokens| u32::try_from(tokens).ok()),
        ..ConfiguredHistorian::default()
    };
    for attempt in primary.into_iter().chain(fallbacks) {
        if resolved.model_chain.contains(&attempt.model) {
            continue;
        }
        if let Some(qualifier) = attempt.qualifier {
            resolved
                .model_variants
                .insert(attempt.model.clone(), qualifier);
        }
        resolved
            .model_limits
            .insert(attempt.model.clone(), HistorianModelLimits::default());
        resolved.model_chain.push(attempt.model);
    }
    resolved
}

/// The user's trusted effective settings for `project_root`, loaded the way the
/// TypeScript plugin loads them (user tier with the selected profile, project tier
/// under the trust rules; model choice stays user-tier only). A config that needed
/// repair still yields its recovered settings, as the plugin runs on them too. When
/// no config can be loaded at all the result is empty, so the chain is empty and the
/// historian reports `no_models` rather than guessing.
pub(crate) fn trusted_settings(resolver: &dyn CoreConfigResolver, project_root: &Path) -> Value {
    match resolver.resolve(&ConfigResolveRequest {
        user_config_path: String::new(),
        project_root: project_root.to_string_lossy().into_owned(),
        generation: Generation(0),
    }) {
        CapabilityResult::Available { value } | CapabilityResult::Degraded { value, .. } => {
            value.settings
        }
        CapabilityResult::Unavailable { reason } => {
            tracing::warn!(
                code = %reason.code,
                "mc-module: historian config unavailable; resolving no historian models"
            );
            json!({})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../testdata/historian-config-resolution.json");

    /// Every case of the TypeScript-generated matrix resolves to exactly the fields
    /// the plugin resolves for it.
    #[test]
    fn configured_historian_matches_typescript_fixture() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 20, "the matrix must not shrink unnoticed");
        for case in cases {
            let resolved = resolve(&case["config"], case["harness"].as_str().unwrap());
            assert_eq!(
                Value::Object(resolved.request_fields()),
                case["expected"],
                "{}",
                case["name"]
            );
        }
    }

    /// The fallback models follow the primary in the resolved chain.
    #[test]
    fn configured_historian_chain_keeps_fallbacks() {
        let settings = json!({"historian":{"opencode":{
            "model":"fixture-a/main",
            "fallback_models":["fixture-b/fallback",{"model":"fixture-c/second","variant":"max"}]}}});
        let resolved = resolve(&settings, "opencode");
        assert_eq!(
            resolved.model_chain,
            ["fixture-a/main", "fixture-b/fallback", "fixture-c/second"]
        );
        assert_eq!(
            resolved.model_variants.get("fixture-c/second").map(String::as_str),
            Some("max")
        );
    }

    #[test]
    fn opencode2_reads_the_opencode_block() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            if case["harness"] == "opencode" {
                assert_eq!(
                    Value::Object(resolve(&case["config"], "opencode2").request_fields()),
                    case["expected"],
                    "{}",
                    case["name"]
                );
            }
        }
    }

    /// The loader reads the user's config file under a throwaway home, applies the
    /// trust rules (a project file cannot choose the model), and the resolution runs
    /// on what it returns.
    #[test]
    fn trusted_settings_read_user_config_and_ignore_project_models() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let xdg = root.path().join("xdg");
        let project = root.path().join("project");
        std::fs::create_dir_all(xdg.join("cortexkit")).unwrap();
        std::fs::create_dir_all(project.join(".cortexkit")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            xdg.join("cortexkit/magic-context.jsonc"),
            r#"{
                // user tier
                "historian_timeout_ms": 90000,
                "historian": {"maxTokens": 12000, "opencode": {"model": {"model": "fixture-a/main", "variant": "high"}, "fallback_models": ["fixture-b/fallback"]}}
            }"#,
        )
        .unwrap();
        std::fs::write(
            project.join(".cortexkit/magic-context.jsonc"),
            r#"{"historian": {"opencode": {"model": "fixture-evil/project"}}}"#,
        )
        .unwrap();
        let resolver = crate::config_parity::TrustedConfigResolver::new(
            home,
            BTreeMap::from([("XDG_CONFIG_HOME".to_string(), xdg.display().to_string())]),
        );
        let settings = trusted_settings(&resolver, &project);
        let resolved = resolve(&settings, "opencode");
        assert_eq!(
            resolved.model_chain,
            ["fixture-a/main", "fixture-b/fallback"]
        );
        assert_eq!(
            resolved.model_variants.get("fixture-a/main").map(String::as_str),
            Some("high")
        );
        assert_eq!(resolved.timeout_ms, 90_000);
        assert_eq!(resolved.max_output_tokens, Some(12_000));
    }

    #[test]
    fn trusted_settings_without_any_config_resolve_no_models() {
        let root = tempfile::tempdir().unwrap();
        let resolver = crate::config_parity::TrustedConfigResolver::new(
            root.path().join("home"),
            BTreeMap::from([(
                "XDG_CONFIG_HOME".to_string(),
                root.path().join("xdg").display().to_string(),
            )]),
        );
        let settings = trusted_settings(&resolver, &root.path().join("project"));
        let resolved = resolve(&settings, "opencode");
        assert!(resolved.model_chain.is_empty());
        assert_eq!(resolved.timeout_ms, DEFAULT_HISTORIAN_TIMEOUT_MS);
        assert_eq!(resolved.max_output_tokens, None);
    }
}
