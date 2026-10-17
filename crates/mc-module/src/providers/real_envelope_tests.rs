//! Replay captured gateway metadata, substituting public synthetic bodies for hashes.
use super::*;
use std::io::Write;

struct ReplayResolver(String);

#[async_trait::async_trait]
impl crate::session_resolver::SessionResolver for ReplayResolver {
    async fn resolve_session(
        &self,
        _project_root: &Path,
        _harness: &str,
        _instance_token: &str,
    ) -> Result<
        Option<crate::session_resolver::ResolvedSession>,
        crate::session_resolver::SessionResolveError,
    > {
        Ok(Some(crate::session_resolver::ResolvedSession {
            session_id: self.0.clone(),
            last_traffic_ms: 1,
        }))
    }
}

#[derive(Clone, Default)]
struct LogWriter(Arc<Mutex<Vec<u8>>>);
impl Write for LogWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn body(ordinal: u64, newer_calls: &[u64], tool_words: usize) -> Value {
    if !newer_calls.is_empty() {
        if let Some(group) = newer_calls.iter().position(|n| *n == ordinal) {
            return json!({"role":"assistant","content":[{"type":"thinking","thinking":"synthetic reasoning","signature":format!("fixture-signature-{ordinal}")},{"type":"tool_use","id":format!("newer-{group}"),"name":"Read","input":{"file_path":"fixture.txt"}}]});
        }
        if let Some(group) = newer_calls.iter().position(|n| *n + 1 == ordinal) {
            let text = if tool_words == 0 {
                "tiny filler output data\n".into()
            } else {
                "one ".repeat(tool_words)
            };
            return json!({"role":"user","content":[{"type":"tool_result","tool_use_id":format!("newer-{group}"),"content":text}]});
        }
    }
    match ordinal {
        2 => {
            json!({"role":"assistant","content":[{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"fixture.txt"}}]})
        }
        3 => {
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"read-1","content":"marker fixture output that should eventually drop.\n"}]})
        }
        8 => {
            json!({"role":"assistant","content":[{"type":"thinking","thinking":"synthetic reasoning","signature":"fixture-signature"},{"type":"tool_use","id":"reduce-1","name":"ctx_reduce","input":{"drop":"2"}}]})
        }
        9 => {
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"reduce-1","content":"drop queued"}]})
        }
        n if n % 3 == 2 => {
            json!({"role":"assistant","content":[{"type":"thinking","thinking":"synthetic reasoning","signature":format!("fixture-signature-{n}")},{"type":"text","text":"synthetic answer"}]})
        }
        n if n % 3 == 1 => json!({"role":"system","content":"synthetic gateway context"}),
        _ => {
            json!({"role":"user","content":if ordinal >= 12 { "one ".repeat(1800) } else { "synthetic followup".into() }})
        }
    }
}

#[tokio::test]
async fn cc_recorded_real_envelopes_hold_protected_drop_with_reason() {
    replay(ORIGINAL, ORIGINAL_SHA, &[], 0, None).await;
}

#[tokio::test]
async fn cc_real_envelope_shape_with_three_newer_tool_groups_drains_at_execute() {
    replay(ORIGINAL, ORIGINAL_SHA, &[11, 14, 17], 800, Some(35)).await;
}

const ORIGINAL: &str = include_str!("../../testdata/cc-step-real-envelopes.json");
const ORIGINAL_SHA: &str = "ea64cda3a21b1a59c9ed4d463f94df73ce72b4f7f9fbcce7739729880a661961";
const READS: &str = include_str!("../../testdata/cc-step-real-envelopes-reads.json");
const READS_SHA: &str = "d213385da4224b73c30ae1d4f720f3629d4ee1f7664b90dc826460ece22ee4cd";

#[tokio::test]
async fn cc_recorded_reads_envelopes_hold_below_tool_mass_floor() {
    replay(READS, READS_SHA, &[14, 20, 26, 32], 0, None).await;
}

#[tokio::test]
async fn cc_recorded_reads_with_four_3kb_results_drain_at_first_execute() {
    replay(READS, READS_SHA, &[14, 20, 26, 32], 750, Some(47)).await;
}

async fn replay(
    fixture: &str,
    fixture_sha: &str,
    newer_calls: &[u64],
    tool_words: usize,
    expected_apply: Option<u64>,
) {
    let logs = LogWriter::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .with_writer(move || writer.clone())
        .finish();
    let _subscriber = tracing::subscriber::set_default(subscriber);
    assert_eq!(
        format!("{:x}", sha2::Sha256::digest(fixture.as_bytes())),
        fixture_sha
    );
    let rows: Vec<Value> = serde_json::from_str(fixture).unwrap();
    assert_eq!(
        rows.len(),
        if fixture_sha == ORIGINAL_SHA { 16 } else { 20 }
    );
    let newer_tools = expected_apply.is_some();
    let first_execute = if fixture_sha == ORIGINAL_SHA { 35 } else { 47 };
    let dir = tempfile::tempdir().unwrap();
    let mut h = handler(dir.path(), thalamus());
    let session = rows[0]["params"]["session"].as_str().unwrap();
    let lineage = rows[0]["params"]["lineage_id"].as_str().unwrap();
    let mut route = binding(dir.path(), thalamus());
    route.session = session.into();
    // Disable idle-expiry scheduling so only input pressure can grant Execute.
    // The default TTL provenance otherwise overrides the adapter's never value.
    route
        .config
        .cache_ttl_by_model
        .insert("claude-sonnet-5-5".into(), "never".into());
    h.bind_route(7, route);
    h.session_resolver = Arc::new(ReplayResolver(session.into()));
    let mut setup_params = rows[0]["params"].clone();
    // Default builds remove the claude_code setup selection because they do not
    // publish the candidate capability bundle; candidate builds select it.
    if !cfg!(feature = "advertise-claude-code-candidate") {
        setup_params.as_object_mut().unwrap().remove("claude_code");
    }
    response(call(&h, "transform.declare", setup_params.clone()).await);
    let initial = response(call(&h, "compaction.setup", setup_params.clone()).await);
    let key = Key::new(&h.facade_binding(7).unwrap(), session, "claude-code").unwrap();
    let store = h.store.get().unwrap();
    let mut installed = initial["initial"].clone();
    let mut next_ordinal = 0;
    let mut target_tag = None;
    let mut applied_at = None;
    for row in &rows[1..] {
        let sequence = row["sequence"].as_u64().unwrap();
        let mut params = row["params"].clone();
        let newest = params["newest"]["ordinal"].as_u64().unwrap();
        let count = params["messages"]["count"].as_u64().unwrap();
        assert_eq!(newest + 1 - next_ordinal, count);
        let mut messages = Vec::new();
        for ordinal in next_ordinal..=newest {
            let message = body(ordinal, newer_calls, tool_words);
            let raw = serde_json::to_string(&message).unwrap();
            let mid = if ordinal == newest {
                params["newest"]["mid"].as_str().unwrap().to_owned()
            } else {
                format!("fixture-{ordinal}")
            };
            let result = message["content"]
                .as_array()
                .and_then(|blocks| blocks.iter().find(|block| block["type"] == "tool_result"));
            let hook = if result.is_some() {
                Some("post_tool")
            } else if message["role"] == "assistant" {
                Some("post_assistant")
            } else if message["role"] == "user" {
                Some("pre_user")
            } else {
                None
            };
            if let Some(hook) = hook {
                let blocks: Vec<&str> = if let Some(text) = message["content"].as_str() {
                    vec![text]
                } else {
                    message["content"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|block| {
                            block["text"].as_str().or_else(|| block["content"].as_str())
                        })
                        .collect()
                };
                let mut hook_params = json!({"session":session,"harness":"claude-code","lineage_id":lineage,"step_id":params["step_id"],"params":plan(),"subject_mid":mid,"subject_ordinal":ordinal,"message":message,"raw_message":raw,"hook":hook,"blocks":blocks});
                if let Some(result) = result {
                    hook_params["subject_part"] = result["tool_use_id"].clone();
                    hook_params["tool_call_id"] = result["tool_use_id"].clone();
                    hook_params["tool"] = json!(if ordinal == 9 { "ctx_reduce" } else { "Read" });
                    hook_params["is_error"] = json!(false);
                }
                let answer = response(call(&h, "transform.hook", hook_params).await);
                if ordinal == 3 {
                    target_tag = answer["ops"][0]["text"]
                        .as_str()
                        .and_then(|s| s.trim().trim_matches('§').parse::<u64>().ok());
                    assert_eq!(target_tag, Some(2));
                }
                if ordinal == 8 {
                    let reduced = response(h.dispatch_value(7, json!({"name":"ctx_reduce","arguments":{"drop":target_tag.unwrap().to_string()}})).await);
                    assert!(reduced.to_string().contains("tag stamped"), "{reduced}");
                }
            }
            messages.push(json!({"mid":mid,"ordinal":ordinal,"message":message,"raw_message":raw}));
        }
        next_ordinal = newest + 1;
        params["messages"] = json!(messages);
        // Each database creates its own view identity. Set last_applied to this
        // replay's installed view where the recording acknowledged its own view.
        params["last_applied"] =
            json!({"compaction_id":installed["compaction_id"],"version":installed["version"]});
        let answer = response(call(&h, "compaction.step", params).await);
        if answer["answer"] == "compaction_message" {
            installed = answer["compaction"].clone();
        }
        let status = response(
            h.dispatch_value(
                7,
                json!({"method":"session.status","v":1,"session_id":session}),
            )
            .await,
        );
        assert_eq!(status["step_lane"]["protected_tokens"]["floor"], 1920);
        if sequence == first_execute {
            let tags = store.load_tags_for_session(&key.engine_key()).unwrap();
            let meta = store.load_meta(&key.engine_key()).unwrap().meta;
            let ratio = meta
                .decision_calibration
                .as_ref()
                .map_or(1.0, |c| c.tools_ratio);
            let mass: i64 = tags
                .iter()
                .filter(|tag| tag.kind == "tool_result" && tag.block_id != "fixture-3#0")
                .map(|tag| tag.token_count)
                .sum();
            let calibrated_mass = (mass as f64 * ratio).ceil() as u64;
            let expected_mass = match (newer_calls.len(), tool_words) {
                (0, 0) => 2,
                (4, 0) => 22,
                (3, 800) => 2405,
                (4, 750) => 3006,
                _ => unreachable!(),
            };
            assert_eq!(calibrated_mass, expected_mass);
            eprintln!("tool_words={tool_words} newer_calls={} local_newer_tool_mass={mass} tools_ratio={ratio} calibrated_newer_tool_mass={calibrated_mass} floor=1920", newer_calls.len());
            assert_eq!(calibrated_mass >= 1920, newer_tools);
        }
        let pressure = transform::compaction::LAST_NATIVE_PRESSURE
            .with(|slot| slot.borrow_mut().take())
            .unwrap();
        let estimate = row["params"]["estimate"]["request_tokens"]
            .as_u64()
            .unwrap();
        assert!((pressure.0 - estimate as f64 / 24000.0 * 100.0).abs() < 0.001);
        assert!((pressure.1 - estimate as f64 / 72000.0 * 100.0).abs() < 0.001);
        eprintln!(
            "sequence={sequence} tokens={estimate} answer={} queued={} applied={} holds={}",
            answer["answer"],
            status["step_lane"]["queued_drops"]["total_count"],
            status["step_lane"]["applied_drops_last_step"],
            status["step_lane"]["queued_drops"]["holds"]
        );
        if status["step_lane"]["applied_drops_last_step"] == 1 {
            assert_eq!(answer["answer"], "compaction_message");
            assert_eq!(applied_at, None, "a queued drop applies only once");
            applied_at = Some(sequence);
            let view = store
                .load_provider_view(&key.store_key(), installed["version"].as_u64().unwrap())
                .unwrap()
                .unwrap();
            assert!(view
                .replacement_json
                .contains(&format!("[dropped §{}§]", target_tag.unwrap())));
            let committed: Value = serde_json::from_str(&view.replacement_json).unwrap();
            assert!(
                !committed["raw_replacement"]
                    .to_string()
                    .contains("fixture-signature"),
                "an edit before later thinking must strip its signature"
            );
        } else if sequence != 5 {
            assert_eq!(answer["answer"], "noop", "sequence={sequence}");
        }
        if sequence >= 15 && (!newer_tools || sequence < first_execute) {
            assert_eq!(status["step_lane"]["queued_drops"]["total_count"], 1);
            assert_eq!(status["step_lane"]["applied_drops_last_step"], 0);
        }
        if !newer_tools && sequence >= first_execute {
            assert_eq!(
                status["step_lane"]["queued_drops"]["holds"],
                json!([{"tag_id":2,"reason":"protection_window"}])
            );
        } else {
            assert_eq!(status["step_lane"]["queued_drops"]["holds"], json!([]));
        }
        if newer_tools && sequence >= first_execute {
            assert_eq!(status["step_lane"]["queued_drops"]["total_count"], 0);
        }
    }
    assert_eq!(applied_at, expected_apply);
    let logs = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    let notices = logs
        .lines()
        .filter(|line| line.contains("reason=protection_window"))
        .collect::<Vec<_>>();
    assert_eq!(notices.len(), usize::from(!newer_tools), "{logs}");
    if !newer_tools {
        assert!(notices[0].contains("tag=2"));
        assert!(notices[0].contains(&format!("session={}", key.engine_key())));
        assert!(notices[0].contains("scheduler=Execute"));
    }
}
