use super::*;
use ck_wire::CkKind;

const MIXED: &str = r#"{ "role":"assistant", "content":[{"type":"text","text":"running"},{"type":"tool_use","id":"a","name":"ctx_reduce","input":{"tags":[1]}}] }"#;
const CALL: &str = r#"{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"read","input":{"path":"a"}}]}"#;
const RESULT: &str = r#"{ "role":"user", "content":[{"type":"tool_result","tool_use_id":"a","content":"large result"}] }"#;
const USER: &str = r#"{"role":"user","content":"question"}"#;
const ASSISTANT: &str = r#"{"role":"assistant","content":[{"type":"text","text":"answer"}]}"#;
const SIGNED: &str = r#"{ "role":"assistant", "content":[{"type":"thinking","thinking":"private","signature":"sig"},{"type":"redacted_thinking","data":"opaque"},{"type":"tool_use","id":"a","name":"read","input":{}}] }"#;

fn fixture(raw: &[&str]) -> (TransformRequest, transform::compaction::View) {
    let entries = raw
        .iter()
        .enumerate()
        .map(|(i, raw)| compact::status::StatusMessage {
            mid: format!("m{i}"),
            ordinal: i as u64,
            message: codec_claude_code::from_wire(&serde_json::from_str(raw).unwrap(), Some(raw))
                .unwrap(),
            raw_message: None,
        })
        .collect::<Vec<_>>();
    let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step","serializer_profile":"claude-code-anthropic","session_id":"cc","render_config":"","messages":[],"tool_present":false,"auto_search_enabled":false})).unwrap();
    codec::Codec::ClaudeCodeAnthropic
        .prepare_request(&mut request, &entries)
        .unwrap();
    let view = transform::compaction::View {
        compaction_id: "fixture".into(),
        version: 1,
        range: transform::compaction::Range {
            lineage_id: "fresh".into(),
            from: 0,
            to: raw.len() as u64,
        },
        replacement: request.messages.iter().map(|m| m.ck.clone()).collect(),
    };
    (request, view)
}

fn tags() -> BTreeMap<String, i64> {
    (0..20).map(|i| (format!("m{i}#0"), 40 + i)).collect()
}

fn apply(
    view: &mut transform::compaction::View,
    request: &TransformRequest,
    covered: Option<u64>,
    rebuild: bool,
    protected: &[String],
    tags: &BTreeMap<String, i64>,
) -> Option<u64> {
    native_reductions::apply(
        view,
        request,
        covered,
        rebuild,
        protected,
        tags,
        &BTreeSet::new(),
    )
}

fn final_bytes(
    request: &TransformRequest,
    view: &transform::compaction::View,
    covered: Option<u64>,
) -> Vec<Value> {
    let (mut wire, raw) = codec_claude_code::encode_view(view, request, covered).unwrap();
    let pins = McHandler::new().native_pins();
    let key = Key {
        project: PathBuf::from("/fixture"),
        session: "cc".into(),
        harness: "claude-code".into(),
        generation: Some(mc_store::provider_records::ProviderGeneration {
            profile: pins.profile_generation.clone(),
            provider: pins.provider_generation.clone(),
        }),
    };
    let ordinal = covered.unwrap_or(request.messages.last().unwrap().ordinal);
    let entry = &request.messages[ordinal as usize];
    let endpoint = compact::view::NativeEndpoint {
        message_id: entry.mid.clone(),
        part_index: entry.ck.content.len() as u64 - 1,
    };
    wire.raw_view = Some(Box::new(
        native_view::freeze(&key, view, Some(&endpoint), &raw).unwrap(),
    ));
    let answer = json!({"answer":"compaction_message","request_id":"fixture","compaction":wire,
        "coverage":{"end_mid":entry.mid,"ordinal":ordinal,"endpoint":endpoint}});
    claude_code_tests::validate_native_answer(&answer, &pins);
    let bytes = format!("[{}]", raw.join(","));
    let output: Vec<Value> = serde_json::from_str(&bytes).unwrap();
    thalamus_checks(&output);
    for _ in 0..3 {
        let mut replay = view.clone();
        let replay_coverage = apply(&mut replay, request, covered, true, &[], &tags());
        let (_, replay_raw) =
            codec_claude_code::encode_view(&replay, request, replay_coverage).unwrap();
        assert_eq!(replay_raw, raw);
    }
    output
}

fn thalamus_checks(output: &[Value]) {
    let mut markers = 0;
    let mut calls = BTreeSet::new();
    let mut results = BTreeSet::new();
    for (index, message) in output.iter().enumerate() {
        if index > 0 {
            assert!(
                !(message["role"] == "assistant" && output[index - 1]["role"] == "assistant"),
                "adjacent assistants"
            );
        }
        if message["role"] == "system" {
            assert!(
                output
                    .get(index + 1)
                    .is_none_or(|m| m["role"] == "assistant"),
                "stranded system"
            );
        }
        if let Some(blocks) = message["content"].as_array() {
            let mut only_thinking = !blocks.is_empty();
            for block in blocks {
                markers += usize::from(block.get("cache_control").is_some());
                only_thinking &= matches!(
                    block["type"].as_str(),
                    Some("thinking" | "redacted_thinking")
                );
                if block["type"] == "tool_use" {
                    let id = block["id"].as_str().unwrap();
                    assert!(calls.insert(id.to_owned()));
                    assert!(
                        output
                            .get(index + 1)
                            .and_then(|m| m["content"].as_array())
                            .is_some_and(|b| b.iter().any(|b| b["tool_use_id"] == id)),
                        "call orphan or noncontiguous result"
                    );
                }
                if block["type"] == "tool_result" {
                    let id = block["tool_use_id"].as_str().unwrap();
                    assert!(results.insert(id.to_owned()));
                    assert!(
                        index > 0
                            && output[index - 1]["content"]
                                .as_array()
                                .is_some_and(|b| b.iter().any(|b| b["id"] == id)),
                        "result orphan or noncontiguous call"
                    );
                }
            }
            assert!(!only_thinking, "thinking-only assistant");
        }
    }
    assert_eq!(calls, results);
    assert!(markers <= 4, "cache marker ceiling");
}

#[test]
fn cc_native_mixed_call_keeps_shell_and_drops_result() {
    let (req, mut view) = fixture(&[USER, MIXED, RESULT, ASSISTANT]);
    view.replacement[1].content.pop();
    view.replacement.remove(2);
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(
        codec_claude_code::render(&view.replacement[1]).unwrap(),
        MIXED
    );
    assert_eq!(output[2]["content"][0]["content"], "[dropped §42§]");
    assert_eq!(coverage, Some(2));
}

#[test]
fn cc_native_single_call_and_result_retire_together() {
    let (req, mut view) = fixture(&[USER, CALL, RESULT, ASSISTANT]);
    view.replacement.drain(1..3);
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(output.len(), 2);
    assert_eq!(coverage, Some(2));
}

#[test]
fn cc_native_result_drop_is_one_placeholder_in_original_shell() {
    let (req, mut view) = fixture(&[USER, MIXED, RESULT, ASSISTANT]);
    view.replacement[2].content.clear();
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(output[2]["content"][0]["content"], "[dropped §42§]");
    assert_eq!(
        codec_claude_code::render(&view.replacement[2]).unwrap(),
        RESULT.replace("large result", "[dropped §42§]")
    );
}

#[test]
fn cc_native_unsupported_edit_is_held_without_refusing_step() {
    let (req, mut view) = fixture(&[USER, CALL, RESULT, ASSISTANT]);
    if let CkKind::ToolCall { input, .. } = &mut view.replacement[1].content[0].kind {
        *input = json!({"changed":true});
    }
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    final_bytes(&req, &view, coverage);
    assert_eq!(view.replacement[1], req.messages[1].ck);
    assert_eq!(coverage, None);
}

#[test]
fn cc_native_signed_thinking_strip_is_complete_or_verbatim() {
    let (req, mut view) = fixture(&[USER, SIGNED, RESULT, ASSISTANT]);
    view.replacement[1]
        .content
        .retain(|b| matches!(b.kind, CkKind::ToolCall { .. }));
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(output.len(), 4);
    assert_eq!(output[1]["content"].as_array().unwrap().len(), 1);
    assert_eq!(output[1]["content"][0]["type"], "tool_use");
    assert_eq!(coverage, Some(2));
    let (_, mut view) = fixture(&[USER, SIGNED, RESULT, ASSISTANT]);
    view.replacement[1].content.clear();
    let coverage = apply(&mut view, &req, None, false, &[], &tags());
    final_bytes(&req, &view, coverage);
    assert_eq!(
        codec_claude_code::render(&view.replacement[1]).unwrap(),
        SIGNED
    );
}

#[test]
fn cc_native_contiguous_tool_arcs_hold_orphaning_removal() {
    let result_with_text = RESULT.replace(
        "] }",
        ", {\"type\":\"text\",\"text\":\"also user data\"}] }",
    );
    let (req, mut view) = fixture(&[USER, CALL, &result_with_text, ASSISTANT]);
    view.replacement.remove(1);
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(output[1]["content"][0]["type"], "tool_use");
    assert_eq!(output[2]["content"][1]["text"], "also user data");
}

#[test]
fn cc_native_arc_removal_never_exposes_adjacent_assistants() {
    // The preceding mixed assistant survives a partially dropped tool arc.
    let (req, mut view) = fixture(&[USER, MIXED, RESULT, ASSISTANT]);
    view.replacement[1].content.clear();
    view.replacement[2].content.clear();
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(output.len(), 4);
    assert_eq!(output[2]["content"][0]["content"], "[dropped §42§]");
}

#[test]
fn cc_native_system_followed_by_assistant_after_reduction() {
    let system = r#"{"role":"system","content":"in-array system"}"#;
    let (req, mut view) = fixture(&[USER, system, CALL, RESULT, USER]);
    view.replacement.drain(2..4);
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(output[2]["role"], "assistant");
    assert_eq!(output[3]["content"][0]["content"], "[dropped §43§]");
}

#[test]
fn cc_native_cache_controls_emit_no_lane_markers() {
    let (req, mut view) = fixture(&[USER, MIXED, RESULT, ASSISTANT]);
    view.replacement[2].content.clear();
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(
        output
            .iter()
            .filter_map(|m| m["content"].as_array())
            .flatten()
            .filter(|b| b.get("cache_control").is_some())
            .count(),
        0
    );
}

#[test]
fn cc_native_thinking_call_never_becomes_thinking_only() {
    let (req, mut view) = fixture(&[USER, SIGNED, RESULT, ASSISTANT]);
    view.replacement[1].content.pop();
    view.replacement.remove(2);
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(output.len(), 2);
    assert!(!output
        .iter()
        .filter_map(|m| m["content"].as_array())
        .flatten()
        .any(|b| b["type"] == "thinking" || b["type"] == "redacted_thinking"));
}

#[test]
fn cc_native_identity_signed_turn_holds_preceding_reduction() {
    let signed_b = SIGNED.replace("\"a\"", "\"b\"");
    let result_b = RESULT.replace("\"a\"", "\"b\"");
    let (mut req, mut view) =
        fixture(&[USER, MIXED, RESULT, ASSISTANT, USER, &signed_b, &result_b]);
    req.mid_turn = true;
    req.model_key = Some("claude-sonnet-4".into());
    req.provider_id = Some("anthropic".into());
    view.replacement[2].content.clear();
    view.replacement[5].content.clear();
    let coverage = apply(&mut view, &req, None, false, &[], &tags());
    final_bytes(&req, &view, coverage);
    assert_eq!(coverage, None);
    assert_eq!(
        view.replacement,
        req.messages
            .iter()
            .map(|m| m.ck.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn cc_native_queued_drop_before_kept_thinking_is_held_on_rebuild() {
    let signed_b = SIGNED.replace("\"a\"", "\"b\"");
    let result_b = RESULT.replace("\"a\"", "\"b\"");
    let (req, mut view) = fixture(&[USER, MIXED, RESULT, ASSISTANT, USER, &signed_b, &result_b]);
    let pending = BTreeSet::from(["m2#0".into()]);
    let coverage = native_reductions::apply(
        &mut view,
        &req,
        None,
        true,
        &["m5".into()],
        &tags(),
        &pending,
    );
    assert_eq!(coverage, None);
    assert!(!native_reductions::pending_applied(
        &view,
        &req,
        &tags(),
        &pending,
        None
    ));
    assert_eq!(
        view.replacement,
        req.messages
            .iter()
            .map(|m| m.ck.clone())
            .collect::<Vec<_>>()
    );
    final_bytes(&req, &view, coverage);
}

#[test]
fn cc_native_pending_applied_excludes_acknowledged_but_not_unseen_results() {
    let (req, original) = fixture(&[USER, MIXED, RESULT]);
    let mut reduced = original.clone();
    let pending = BTreeSet::from(["m2#0".into()]);
    native_reductions::apply(&mut reduced, &req, None, true, &[], &tags(), &pending);
    assert!(native_reductions::pending_applied(
        &reduced,
        &req,
        &tags(),
        &pending,
        Some(&original)
    ));
    assert!(!native_reductions::pending_applied(
        &reduced,
        &req,
        &tags(),
        &pending,
        Some(&reduced)
    ));
    let mut unseen = original;
    unseen.range.to = 2;
    unseen.replacement.pop();
    assert!(native_reductions::pending_applied(
        &reduced,
        &req,
        &tags(),
        &pending,
        Some(&unseen)
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn cc_native_force_and_emergency_hold_drops_before_active_thinking() {
    let dir = tempfile::tempdir().unwrap();
    let h = claude_code_tests::handler(dir.path(), claude_code_tests::thalamus());
    claude_code_tests::setup(&h).await;
    let entries = |raw: &[String]| {
        raw.iter().enumerate().map(|(i, raw)| {
        json!({"mid":format!("m{i}"),"ordinal":i,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw})
    }).collect::<Vec<_>>()
    };
    let raw = [
        USER.into(),
        MIXED.into(),
        RESULT.into(),
        ASSISTANT.into(),
        USER.into(),
        CALL.replace("\"a\"", "\"b\""),
        RESULT.replace("\"a\"", "\"b\""),
        ASSISTANT.into(),
        USER.into(),
        CALL.replace("\"a\"", "\"c\""),
        RESULT.replace("\"a\"", "\"c\""),
        ASSISTANT.into(),
        USER.into(),
        SIGNED.replace("\"a\"", "\"d\""),
        RESULT.replace("\"a\"", "\"d\""),
    ];
    let mut status = claude_code_tests::step(USER);
    status["messages"] = json!(entries(&raw[..13]));
    status["newest"] = json!({"mid":"m12","ordinal":12});
    status["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let pins = h.native_pins();
    let first = step_answer(&h, &status, &pins).await;
    assert_eq!(first["answer"], "compaction_message", "{first}");
    let applied = &first["compaction"];
    status["last_applied"] =
        json!({"compaction_id":applied["compaction_id"],"version":applied["version"]});
    status["messages"] = json!(entries(&raw));
    status.as_object_mut().unwrap().remove("prefix_rebuilding");
    status["newest"] = json!({"mid":"m14","ordinal":14});
    status["mid_turn"] = json!(true);
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    store
        .seed_tags_for_test(
            &key.engine_key(),
            &[2, 6, 10, 14].map(|i| mc_store::TagMintInput {
                block_id: format!("m{i}#0"),
                kind: "tool_result".into(),
                token_count: 8000,
                source_bytes: raw[i].as_bytes().to_vec(),
            }),
            2,
        )
        .unwrap();
    store
        .append_pending_agent_drops(&key.engine_key(), &["m2#0".into()], 3)
        .unwrap();
    status["context_window"] = json!(200000);
    status["geometry"] = json!({"usable_soft":22000,"usable_hard":200000,"absolute_wall":200000,"derivation":"gateway"});
    for tokens in [20000, 21000] {
        status["request_id"] = json!(format!("held-pressure-{tokens}"));
        status["estimate"]["request_tokens"] = json!(tokens);
        let answer = step_answer(&h, &status, &pins).await;
        assert_eq!(answer["answer"], "noop", "{answer}");
        let pressure = transform::compaction::LAST_NATIVE_PRESSURE
            .with(|slot| slot.borrow_mut().take())
            .unwrap();
        assert!((pressure.0 - (tokens as f64 / 22_000.0 * 100.0)).abs() < 0.001);
        assert!(store
            .load_pending_agent_drops(&key.engine_key())
            .unwrap()
            .iter()
            .any(|drop| drop.target_id == "m2#0"));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cc_native_execute_drops_after_kept_thinking_preserve_prefix_bytes() {
    drop_after_kept_thinking(30000, 167000).await;
}

async fn drop_after_kept_thinking(tokens: u64, soft: u64) {
    let dir = tempfile::tempdir().unwrap();
    let h = claude_code_tests::handler(dir.path(), claude_code_tests::thalamus());
    let mut binding = claude_code_tests::binding(dir.path(), claude_code_tests::thalamus());
    binding.config.execute_threshold_percentage = 10.0;
    h.bind_route(7, binding);
    let ready = claude_code_tests::setup(&h).await;
    let mut raw = vec![
        USER.into(),
        MIXED.into(),
        RESULT.into(),
        ASSISTANT.into(),
        USER.into(),
        CALL.replace("\"a\"", "\"b\""),
        RESULT.replace("\"a\"", "\"b\""),
        ASSISTANT.into(),
        USER.into(),
        CALL.replace("\"a\"", "\"c\""),
        RESULT.replace("\"a\"", "\"c\""),
        ASSISTANT.into(),
        USER.into(),
        SIGNED.replace("\"a\"", "\"d\""),
        RESULT.replace("\"a\"", "\"d\""),
    ];
    for id in ["e", "f", "g"] {
        raw.extend([
            CALL.replace("\"a\"", &format!("\"{id}\"")),
            RESULT.replace("\"a\"", &format!("\"{id}\"")),
        ]);
    }
    let mut status = claude_code_tests::step(USER);
    status["messages"] = json!(raw.iter().enumerate().map(|(i, raw)| {
        json!({"mid":format!("m{i}"),"ordinal":i,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw})
    }).collect::<Vec<_>>());
    status["newest"] = json!({"mid":"m20","ordinal":20});
    status["mid_turn"] = json!(true);
    status["last_applied"] = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
    let pins = h.native_pins();
    assert_eq!(step_answer(&h, &status, &pins).await["answer"], "noop");
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    let tags = store
        .seed_tags_for_test(
            &key.engine_key(),
            &[2, 6, 10, 14, 16, 18, 20].map(|i| mc_store::TagMintInput {
                block_id: format!("m{i}#0"),
                kind: "tool_result".into(),
                token_count: 8000,
                source_bytes: raw[i].as_bytes().to_vec(),
            }),
            2,
        )
        .unwrap();
    store
        .append_pending_agent_drops(&key.engine_key(), &["m2#0".into(), "m14#0".into()], 3)
        .unwrap();
    status["request_id"] = json!("drop-after-kept-thinking");
    status["mid_turn"] = json!(false);
    status["context_window"] = json!(200000);
    status["estimate"]["request_tokens"] = json!(tokens);
    status["geometry"] = json!({"usable_soft":soft,"usable_hard":200000,"absolute_wall":200000,"derivation":"gateway"});
    let answer = step_answer(&h, &status, &pins).await;
    assert_eq!(answer["answer"], "compaction_message", "{answer}");
    assert_eq!(answer["coverage"]["ordinal"], 20);
    assert_eq!(
        answer["coverage"]["endpoint"],
        json!({"message_id":"m20","part_index":0})
    );
    let view = store
        .load_provider_view(
            &key.store_key(),
            answer["compaction"]["version"].as_u64().unwrap(),
        )
        .unwrap()
        .unwrap();
    let committed: Value = serde_json::from_str(&view.replacement_json).unwrap();
    let rendered = committed["raw_replacement"]
        .as_array()
        .unwrap()
        .iter()
        .map(|raw| raw.as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rendered.len(), raw.len());
    assert_eq!(rendered[..=13], raw[..=13]);
    assert_eq!(rendered[15..], raw[15..]);
    let result_tag = tags
        .iter()
        .find(|tag| tag.block_id == "m14#0")
        .unwrap()
        .tag_number;
    assert!(rendered[14].contains(&format!("[dropped §{result_tag}§]")));
    assert!(rendered[13].contains("\"signature\":\"sig\""));
    status["last_applied"] = json!({"compaction_id":answer["compaction"]["compaction_id"],"version":answer["compaction"]["version"]});
    for pass in 0..2 {
        status["request_id"] = json!(format!("same-execute-{pass}"));
        assert_eq!(step_answer(&h, &status, &pins).await["answer"], "noop");
    }
}

#[test]
fn cc_native_opaque_removal_and_untagged_result_drop_are_held() {
    let opaque = r#"{"role":"assistant","content":[{"type":"text","text":"answer"},{"type":"future","data":"verbatim"}]}"#;
    let (req, mut view) = fixture(&[USER, MIXED, RESULT, opaque]);
    view.replacement[2].content.clear();
    view.replacement[3].content.pop();
    let coverage = apply(&mut view, &req, None, true, &[], &BTreeMap::new());
    final_bytes(&req, &view, coverage);
    assert_eq!(coverage, None);
    assert_eq!(
        codec_claude_code::render(&view.replacement[3]).unwrap(),
        opaque
    );
    assert_eq!(
        codec_claude_code::render(&view.replacement[2]).unwrap(),
        RESULT
    );
}

async fn step_answer(
    h: &McHandler,
    status: &Value,
    pins: &hooks::claude_code::ClaudeCodeCapabilities,
) -> Value {
    let bytes = h
        .provider_step(h.facade_binding(7).unwrap(), status)
        .await
        .unwrap();
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    claude_code_tests::assert_native_range_endpoint(&answer, status);
    claude_code_tests::validate_native_answer(&answer, pins);
    answer
}

async fn read_view(h: &McHandler, reference: &Value) -> String {
    let bytes = h.provider_native_view_read(h.facade_binding(7).unwrap(), &json!({
        "request_id":"read", "view_id":reference["view_id"],"version":reference["version"],"sha256":reference["sha256"],"byte_cursor":0
    })).await.unwrap();
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(answer.get("next_byte_cursor").is_none());
    answer["bytes"].as_str().unwrap().into()
}

#[tokio::test]
async fn cc_native_fresh_lineage_drops_ride_rebuild_then_hook_cut_stays_stable() {
    fresh_sequence(true, false).await;
}

#[tokio::test]
async fn cc_native_fresh_lineage_emergency_reclaim_preserves_native_shells() {
    fresh_sequence(false, false).await;
}

#[tokio::test]
async fn cc_native_signed_mixed_result_carrier_strips_on_rebuild_and_holds_on_identity() {
    fresh_sequence(true, true).await;
}

async fn fresh_sequence(queue: bool, mixed: bool) {
    let dir = tempfile::tempdir().unwrap();
    let h = claude_code_tests::handler(dir.path(), claude_code_tests::thalamus());
    let mut binding = claude_code_tests::binding(dir.path(), claude_code_tests::thalamus());
    binding.config.protected_tokens_user = Some(4000);
    binding.config.protected_tools.clear();
    binding
        .config
        .protected_tools
        .insert("ctx_reduce".into(), 0);
    binding.config.smart_drops = true;
    h.bind_route(7, binding);
    let pins = h.native_pins();
    let plan = json!({"serializer_profile":"claude-code-anthropic","observation":"answer"});
    h.admit_native_plan(
        7,
        &h.facade_binding(7).unwrap(),
        "transform.declare",
        &json!({"preset":"head","params":plan,"composition":{},"claude_code":pins}),
    )
    .await
    .unwrap();
    let ready = h.provider_setup(h.facade_binding(7).unwrap(), &json!({
        "session":"cc","harness":"claude-code","request_id":"setup","preset":"head","params":plan,"composition":{},"claude_code":pins,
        "model":"fixture","context_window":100000,"lineage_id":"fresh-after-native-summary","now":1
    })).await.unwrap();
    let ready: Value = serde_json::from_slice(&ready).unwrap();
    assert_eq!(ready["answer"], "ready");
    let mut raw = vec![
        USER.to_owned(),
        MIXED.to_owned(),
        RESULT.to_owned(),
        ASSISTANT.to_owned(),
        USER.to_owned(),
        CALL.replace("\"a\"", "\"b\""),
        RESULT.replace("\"a\"", "\"b\""),
        ASSISTANT.to_owned(),
        USER.to_owned(),
        SIGNED.replace("\"a\"", "\"c\""),
        RESULT.replace("\"a\"", "\"c\""),
        ASSISTANT.to_owned(),
        USER.to_owned(),
    ];
    // The old control call has enough argument bytes for the selector to
    // delete it rather than keep real arguments. Its result is also large
    // enough for automatic reclaim before any historian summary exists.
    raw[2] = RESULT.replace("large result", &"old control result ".repeat(800));
    raw[1] = MIXED.replace(
        "\"tags\":[1]",
        &format!("\"payload\":\"{}\"", "old control input ".repeat(400)),
    );
    raw[5] = raw[5].replace(
        "\"path\":\"b\"",
        &format!("\"path\":\"{}\"", "old path ".repeat(400)),
    );
    if !queue {
        raw[5] = raw[5].replace("\"name\":\"read\"", "\"name\":\"ctx_reduce\"");
    }
    if mixed {
        raw[10] = raw[10].replace(
            "] }",
            ", {\"type\":\"text\",\"text\":\"user data byte-exact\\u0021\"}] }",
        );
    }
    if mixed {
        for n in 0..3 {
            let id = format!("live-{n}");
            raw.extend([
                CALL.replace("\"a\"", &format!("\"{id}\"")),
                RESULT.replace("\"a\"", &format!("\"{id}\"")),
                ASSISTANT.into(),
                USER.into(),
            ]);
        }
    }
    let entries = |raw: &[String]| {
        raw.iter().enumerate().map(|(i, raw)| json!({"mid":format!("m{i}"),"ordinal":i,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw})).collect::<Vec<_>>()
    };
    let mut status = json!({"session":"cc","harness":"claude-code","request_id":"first","lineage_id":"fresh-after-native-summary",
        "step_id":"1","step_kind":"user_turn","model":"fixture","context_window":100000,"estimate":{"request_tokens":1},
        "newest":{"mid":"m8","ordinal":8},"after_ordinal":0,"messages":entries(&raw[..9]),"now":2});
    let first = step_answer(&h, &status, &pins).await;
    assert_eq!(first["answer"], "compaction_message");
    assert_eq!(first["compaction"]["range"], json!({"from":0,"to":1}));
    let first_ref = &first["compaction"]["raw_view"];
    let first_bytes = read_view(&h, first_ref).await;
    assert!(first_bytes.ends_with(&format!(",{USER}]")));
    status["last_applied"] = json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});

    status["messages"] = json!(entries(&raw));
    status["newest"] = json!({"mid":format!("m{}", raw.len()-1),"ordinal":raw.len()-1});
    status["request_id"] = json!("append-signed-turn");
    assert_eq!(step_answer(&h, &status, &pins).await["answer"], "noop");

    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    let rows = store
        .seed_tags_for_test(
            &key.engine_key(),
            &[
                mc_store::TagMintInput {
                    block_id: "m2#0".into(),
                    kind: "tool_result".into(),
                    token_count: 4000,
                    source_bytes: raw[2].as_bytes().to_vec(),
                },
                mc_store::TagMintInput {
                    block_id: "m6#0".into(),
                    kind: "tool_result".into(),
                    token_count: 4000,
                    source_bytes: raw[6].as_bytes().to_vec(),
                },
                mc_store::TagMintInput {
                    block_id: "m10#0".into(),
                    kind: "tool_result".into(),
                    token_count: 100,
                    source_bytes: raw[10].as_bytes().to_vec(),
                },
                mc_store::TagMintInput {
                    block_id: "m12#0".into(),
                    kind: "message".into(),
                    token_count: 4000,
                    source_bytes: USER.as_bytes().to_vec(),
                },
            ],
            3,
        )
        .unwrap();
    if mixed {
        let inputs = [14, 18, 22]
            .into_iter()
            .map(|ordinal| mc_store::TagMintInput {
                block_id: format!("m{ordinal}#0"),
                kind: "tool_result".into(),
                token_count: 4000,
                source_bytes: raw[ordinal].as_bytes().to_vec(),
            })
            .collect::<Vec<_>>();
        store
            .seed_tags_for_test(&key.engine_key(), &inputs, 4)
            .unwrap();
    }
    if queue {
        let queued = h
            .handle_provider_reduce(
                7,
                &rows[..if mixed { 3 } else { 2 }]
                    .iter()
                    .map(|r| r.tag_number as u64)
                    .collect::<Vec<_>>(),
            )
            .await;
        assert!(matches!(queued, HandlerOutcome::Response(_)), "{queued:?}");
    }
    status["mid_turn"] = json!(true);
    for pass in 0..3 {
        let hook = json!({"session":"cc","harness":"claude-code","request_id":format!("hold-hook-{pass}"),"hook":"pre_user","phase":"before_write",
            "lineage_id":"fresh-after-native-summary","subject_mid":"m12","subject_ordinal":12,"blocks":["question"],"params":plan,"step_id":format!("hook-{pass}"),
            "message":serde_json::from_str::<Value>(USER).unwrap(),"raw_message":USER});
        let outcome = claude_code_tests::call(&h, "transform.hook", hook).await;
        let HandlerOutcome::Response(bytes) = outcome else {
            panic!("{outcome:?}")
        };
        let answer: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(answer["answer"], "pass");
        assert!(answer.get("ops").is_none());
        assert_eq!(read_view(&h, first_ref).await, first_bytes);
        status["request_id"] = json!(format!("hold-step-{pass}"));
        let answer = step_answer(&h, &status, &pins).await;
        assert_eq!(answer["answer"], "noop");
    }
    status["request_id"] = json!("rebuild");
    status["mid_turn"] = json!(false);
    status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    status["estimate"]["request_tokens"] = json!(95000);
    let rebuilt = step_answer(&h, &status, &pins).await;
    assert_eq!(rebuilt["answer"], "compaction_message", "{rebuilt}");
    println!("native coverage: {}", rebuilt["coverage"]);
    let durable = store.load(&key.engine_key()).unwrap();
    let emergency = store
        .load_meta(&key.engine_key())
        .unwrap()
        .meta
        .emergency_drop_assessment
        .unwrap();
    println!(
        "emergency selected reclaim tokens: {}",
        emergency.selected_reclaim_tokens
    );
    assert!(emergency.selected_reclaim_tokens > 0.0);
    let reductions = durable
        .core
        .frozen_units
        .iter()
        .filter(|u| u.key.starts_with("red:"))
        .map(|u| (&u.key, &u.kind))
        .collect::<Vec<_>>();
    println!("selected reductions: {reductions:?}");
    assert!(durable
        .core
        .frozen_units
        .iter()
        .any(|u| u.key == "red:m1#1" && u.kind == "drop"));
    if queue {
        assert!(durable
            .core
            .frozen_units
            .iter()
            .any(|u| u.key == "red:m5#0" && u.kind == "drop"));
    }
    let reference = &rebuilt["compaction"]["raw_view"];
    let bytes = read_view(&h, reference).await;
    let output: Vec<Value> = serde_json::from_str(&bytes).unwrap();
    thalamus_checks(&output);
    assert!(bytes.contains(&raw[1]));
    if queue {
        assert!(!bytes.contains(&raw[5]));
        assert!(!bytes.contains(&raw[6]));
    }
    assert!(
        bytes.contains(&format!("[dropped §{}§]", rows[0].tag_number)),
        "missing dropped-result placeholder"
    );
    if mixed {
        assert!(bytes.contains(r#"{"type":"text","text":"user data byte-exact\u0021"}"#));
        assert!(bytes.contains(&format!("[dropped §{}§]", rows[2].tag_number)));
        assert!(output
            .iter()
            .filter_map(|m| m["content"].as_array())
            .flatten()
            .any(|b| b["type"] == "tool_use" && b["id"] == "c"));
        assert!(!output
            .iter()
            .filter_map(|m| m["content"].as_array())
            .flatten()
            .any(|b| b["type"] == "thinking" || b["type"] == "redacted_thinking"));
    }
    assert!(rebuilt["coverage"]["ordinal"].as_u64().unwrap() >= 6);
    let cut_ref = &rebuilt["compaction"]["raw_view"]["cut_replacement_ref"];
    let cut = read_view(&h, cut_ref).await;
    thalamus_checks(&serde_json::from_str::<Vec<Value>>(&cut).unwrap());
    let covered = rebuilt["coverage"]["ordinal"].as_u64().unwrap();
    assert!(rebuilt["compaction"]["raw_view"]["retained_tail"]
        .as_array()
        .unwrap()
        .iter()
        .all(|part| part["endpoint"]["message_id"]
            .as_str()
            .unwrap()
            .trim_start_matches('m')
            .parse::<u64>()
            .unwrap()
            > covered));
    status["last_applied"] = json!({"compaction_id":rebuilt["compaction"]["compaction_id"],"version":rebuilt["compaction"]["version"]});
    status.as_object_mut().unwrap().remove("prefix_rebuilding");
    status["estimate"]["request_tokens"] = json!(1);
    for pass in 0..3 {
        status["request_id"] = json!(format!("stable-{pass}"));
        assert_eq!(step_answer(&h, &status, &pins).await["answer"], "noop");
        assert_eq!(read_view(&h, reference).await, bytes);
    }
    if mixed {
        // Simulate a fulfilled queue leaving this disposable store. A later
        // rewrite must replay the published result skeleton, not reread a drop.
        store
            .execute_tag_sql_for_test("DELETE FROM pending_agent_drops")
            .unwrap();
        assert!(store
            .load_pending_agent_drops(&key.engine_key())
            .unwrap()
            .is_empty());
        status["request_id"] = json!("later-rebuild");
        status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
        status["estimate"]["request_tokens"] = json!(95000);
        let later = step_answer(&h, &status, &pins).await;
        assert_eq!(later["answer"], "compaction_message");
        let later_bytes = read_view(&h, &later["compaction"]["raw_view"]).await;
        assert!(
            later_bytes.contains(&format!("[dropped §{}§]", rows[2].tag_number)),
            "published signed result skeleton was restored"
        );
        assert_eq!(later_bytes, bytes);
        status["last_applied"] = json!({"compaction_id":later["compaction"]["compaction_id"],"version":later["compaction"]["version"]});
        status.as_object_mut().unwrap().remove("prefix_rebuilding");
        status["estimate"]["request_tokens"] = json!(1);
    }
    status["messages"]
        .as_array_mut()
        .unwrap()
        .retain(|m| m["ordinal"].as_u64().unwrap() > covered);
    status["after_ordinal"] = json!(covered + 1);
    status["request_id"] = json!("after-hook-cut");
    assert_eq!(step_answer(&h, &status, &pins).await["answer"], "noop");
    assert_eq!(read_view(&h, cut_ref).await, cut);
    assert_eq!(read_view(&h, first_ref).await, first_bytes);
}

#[test]
fn cc_native_future_thinking_shape_strips_completely_on_rebuild_only() {
    let thinking = r#"{"role":"assistant","content":[{"type":"thinking","signature":"sig","opaque":true},{"type":"tool_use","id":"a","name":"read","input":{}}]}"#;
    let mixed_result = RESULT.replace("] }", ", {\"type\":\"text\",\"text\":\"user data\"}] }");
    let (req, mut view) = fixture(&[USER, thinking, &mixed_result, ASSISTANT]);
    view.replacement[2].content.clear();
    let coverage = apply(&mut view, &req, None, false, &[], &tags());
    assert_eq!(coverage, None);
    final_bytes(&req, &view, coverage);
    assert_eq!(
        codec_claude_code::render(&view.replacement[1]).unwrap(),
        thinking
    );
    view.replacement[2].content.clear();
    let coverage = apply(&mut view, &req, None, true, &[], &tags());
    let output = final_bytes(&req, &view, coverage);
    assert_eq!(output[1]["content"].as_array().unwrap().len(), 1);
    assert_eq!(output[1]["content"][0]["type"], "tool_use");
    assert_eq!(output[2]["content"][1]["text"], "user data");
}
