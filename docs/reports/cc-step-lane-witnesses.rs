//! Tests raw-message preservation, marker rejection, route admission and signed
//! thinking boundaries using synthetic Anthropic messages and temporary stores.
//! Registered in the provider unit suite so these safety checks run by default.
//! The stricter duplicate-key contract refuses ambiguous raw JSON before decode
//! or editing, instead of selecting one value from repeated object keys.
use super::claude_code_tests as cc;
use super::*;
use ck_wire::{CkKind, CkWireMessage};

fn response(outcome: HandlerOutcome) -> (Value, Vec<u8>) {
    let HandlerOutcome::Response(bytes) = outcome else {
        panic!("{outcome:?}")
    };
    (serde_json::from_slice(&bytes).unwrap(), bytes)
}
fn error_code(outcome: HandlerOutcome) -> String {
    match outcome {
        HandlerOutcome::Error { code, .. } | HandlerOutcome::ErrorWithDetail { code, .. } => code,
        other => panic!("expected named refusal, got {other:?}"),
    }
}
fn entry(raw: &str, ordinal: u64) -> compact::status::StatusMessage {
    compact::status::StatusMessage {
        raw_message: None,
        mid: format!("m{ordinal}"),
        ordinal,
        message: codec_claude_code::envelope(
            &serde_json::from_str(raw).unwrap(),
            Some(&json!(raw)),
        )
        .unwrap(),
    }
}
fn request(entries: &[compact::status::StatusMessage]) -> TransformRequest {
    let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step","session_id":"cc","messages":[],"render_config":"","tool_present":false,"auto_search_enabled":false})).unwrap();
    codec::Codec::ClaudeCodeAnthropic
        .prepare_request(&mut request, entries)
        .unwrap();
    request
}
fn view(request: &TransformRequest) -> transform::compaction::View {
    transform::compaction::View {
        compaction_id: "review".into(),
        version: 1,
        range: transform::compaction::Range {
            lineage_id: "L".into(),
            from: 0,
            to: request.messages.len() as u64,
        },
        replacement: request.messages.iter().map(|m| m.ck.clone()).collect(),
    }
}
fn fuzz_raw(seed: usize) -> String {
    let gap = ["", " ", "\n\t", "\r\n "][seed % 4];
    let block = match seed % 6 {
        0 => r#""a\u0062\n\"quoted\"☃""#.to_owned(),
        1 => r#"[{"text":"a\u0062","type":"text","extra":7}]"#.to_owned(),
        2 => format!(r#"[{{"signature":"{}","thinking":"p\u0072ivate","type":"thinking"}},{{"type":"text","text":"after"}}]"#, "sig\\u0041".repeat(if seed == 26 { 65536 } else { seed + 1 })),
        3 => r#"[{"data":"\u006fpaque==","type":"redacted_thinking"},{"type":"text","text":"after"}]"#.to_owned(),
        4 => r#"[{"type":"future","cache_control":{"opaque":"keep"},"payload":[1,{"type":"thinking"}]}]"#.to_owned(),
        _ => r#"[{"input":{"cache_control":{"user":"keep"},"text":"\u0061"},"name":"tool","id":"t","type":"tool_use"}]"#.to_owned(),
    };
    let role = if matches!(seed % 6, 2 | 3 | 5) {
        "assistant"
    } else {
        "user"
    };
    let fields = [
        format!(r#""role":"{role}""#),
        format!(r#""content":{gap}{block}"#),
        r#""extra":"same""#.into(),
    ];
    let order = [
        [0, 1, 2],
        [1, 2, 0],
        [2, 0, 1],
        [1, 0, 2],
        [0, 2, 1],
        [2, 1, 0],
    ][(seed / 4) % 6];
    format!(
        "{gap}{{{gap}{}{gap},{gap}{}{gap},{gap}{}{gap}}}{gap}",
        fields[order[0]], fields[order[1]], fields[order[2]]
    )
}

#[tokio::test]
async fn raw_fuzz_setup_step_admission_hook_and_identity_replacement() {
    for seed in 0..36 {
        let raw = fuzz_raw(seed);
        let dir = tempfile::tempdir().unwrap();
        let h = cc::handler(dir.path(), cc::thalamus());
        assert_eq!(cc::setup(&h).await["initial"]["replacement"], json!([]));
        let mut status = cc::step(&raw);
        if serde_json::from_str::<Value>(&raw).unwrap()["role"] == "assistant" {
            status["step_kind"] = json!("tool_step");
        }
        if seed % 6 == 5 {
            let result = r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"result"}]}"#;
            status["messages"].as_array_mut().unwrap().push(json!({"mid":"tool-result","ordinal":1,"message":serde_json::from_str::<Value>(result).unwrap(),"raw_message":result}));
            status["newest"] = json!({"mid":"tool-result","ordinal":1});
        }
        let (answer, _) = response(cc::call(&h, "compaction.step", status).await);
        assert!(
            matches!(
                answer["answer"].as_str(),
                Some("noop" | "compaction_message")
            ) || (matches!(seed % 6, 2 | 3)
                && answer["answer"] == "refuse"
                && answer["provider_code"] == "signed_prefix_edit"),
            "seed {seed}: {answer}"
        );
        let key = Key::new(
            &h.facade_binding(7).unwrap(),
            "cc",
            "claude-code",
        )
        .unwrap();
        let held = h
            .store
            .get()
            .unwrap()
            .load_provider_messages(&key.store_key(), "L")
            .unwrap();
        let stored: Value = serde_json::from_slice(&held[0].message_bytes).unwrap();
        assert_eq!(stored["raw_message"], raw, "seed {seed}");
        assert_eq!(
            stored["message"],
            serde_json::from_str::<Value>(&raw).unwrap()
        );
        let request = request(&[compact::status::StatusMessage {
            raw_message: None,
            mid: "m".into(),
            ordinal: 0,
            message: stored,
        }]);
        let (wire, encoded) =
            codec_claude_code::encode_view(&view(&request), &request, None).unwrap();
        assert_eq!(encoded, vec![raw.clone()], "seed {seed}");
        let bytes = codec_claude_code::answer_bytes(
            &json!({"answer":"compaction_message","compaction":wire}),
            &encoded,
        )
        .unwrap();
        let bytes = String::from_utf8(bytes).unwrap();
        assert!(
            bytes.contains(&format!("\"replacement\":[{raw}]")),
            "raw answer seed {seed}"
        );
        let hook = if request.messages[0].ck.role == "user" {
            "pre_user"
        } else {
            "post_assistant"
        };
        let blocks = request.messages[0]
            .ck
            .content
            .iter()
            .filter_map(|block| match &block.kind {
                CkKind::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let params = json!({"session":"cc","harness":"claude-code","lineage_id":"L","step_id":"hook","subject_mid":"m","subject_ordinal":0,"message":serde_json::from_str::<Value>(&raw).unwrap(),"raw_message":raw,"hook":hook,"blocks":blocks});
        assert_eq!(
            response(cc::call(&h, "transform.hook", params).await).0["answer"],
            "pass"
        );
    }
    eprintln!("REVIEW raw fuzz: 36 setup/step-admission/store/identity-encode/hook cases; 589824-byte escaped signature at seed 26; signed steps may safely refuse");
}

#[test]
fn raw_canonical_control_has_no_noncanonical_bytes() {
    let raw = r#"{"content":"ab","role":"user"}"#;
    let request = request(&[entry(raw, 0)]);
    let (wire, encoded) = codec_claude_code::encode_view(&view(&request), &request, None).unwrap();
    let bytes = codec_claude_code::answer_bytes(&json!({"compaction":wire}), &encoded).unwrap();
    assert!(String::from_utf8(bytes).unwrap().contains(raw));
}

#[test]
fn marker_transport_positions_are_exhaustively_refused() {
    for kind in [
        "text",
        "image",
        "document",
        "thinking",
        "redacted_thinking",
        "tool_use",
        "tool_result",
    ] {
        for marker in [json!({"type":"ephemeral"}), Value::Null] {
            let message = json!({"role":"user","content":[{"type":kind,"cache_control":marker}]});
            let result = codec_claude_code::envelope(&message, Some(&json!(message.to_string())));
            assert!(
                matches!(result, Err(HandlerOutcome::ErrorWithDetail { code, detail, .. }) if code == "invalid_params" && detail["field"] == "raw_message"),
                "top-level {kind}"
            );
        }
    }
    for kind in ["text", "image", "document"] {
        let message = json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":kind,"cache_control":{}}]}]});
        assert!(
            codec_claude_code::envelope(&message, Some(&json!(message.to_string()))).is_err(),
            "nested {kind}"
        );
    }
    eprintln!("REVIEW marker positions: 14 top-level + 3 nested refusals");
}

#[test]
fn marker_tool_inputs_and_unknown_blocks_are_kept() {
    for raw in [
        r#"{ "role":"assistant", "content":[{"type":"tool_use","id":"t","name":"tool","input":{"cache_control":{},"nested":{"cache_control":{}}}}]}"#,
        r#"{"role":"user","content":[{"type":"future","cache_control":{}},{"type":"tool_result","tool_use_id":"t","content":[{"type":"future","cache_control":{}},{"type":"thinking","cache_control":{}}]}]}"#,
    ] {
        assert_eq!(
            codec_claude_code::render(
                &codec_claude_code::decode_message(&entry(raw, 0))
                    .unwrap()
                    .ck
            )
            .unwrap(),
            raw
        );
    }
}

#[tokio::test]
async fn admission_spoofs_and_rebind_matrix() {
    let plan = json!({"serializer_profile":"claude-code-anthropic","observation":"answer"});
    for principal in [
        None,
        Some(subc_protocol::Principal::Direct),
        Some(subc_protocol::Principal::Reserved {
            module_id: "broca".into(),
        }),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let h = cc::handler(dir.path(), principal);
        assert_eq!(
            error_code(
                cc::call(
                    &h,
                    "transform.declare",
                    json!({"params":plan,"principal":{"reserved":"thalamus"}})
                )
                .await
            ),
            "claude_code_lane_requires_attested_host"
        );
    }
    let dir = tempfile::tempdir().unwrap();
    let h = cc::handler(dir.path(), cc::thalamus());
    for profile in ["owned-broca", "opencode-aisdk"] {
        assert_eq!(
            error_code(
                cc::call(
                    &h,
                    "transform.declare",
                    json!({"params":{"serializer_profile":profile,"observation":"answer"}})
                )
                .await
            ),
            "claude_code_lane_profile_mismatch"
        );
    }
    assert_eq!(error_code(cc::call(&h, "transform.declare", json!({"params":{"serializer_profile":"claude-code-anthropic","observation":"transcript"}})).await), "invalid_params");
    cc::setup(&h).await;
    let raw = r#"{"role":"user","content":"hello"}"#;
    response(cc::call(&h, "compaction.step", cc::step(raw)).await);
    h.bind_route(7, cc::binding(dir.path(), None));
    assert_eq!(
        error_code(cc::call(&h, "compaction.step", cc::step(raw)).await),
        "claude_code_lane_requires_attested_host"
    );
    let mut other = cc::binding(dir.path(), cc::thalamus());
    other.harness = "opencode".into();
    h.bind_route(7, other);
    assert_eq!(
        error_code(cc::call(&h, "compaction.step", cc::step(raw)).await),
        "claude_code_lane_profile_mismatch"
    );
    h.bind_route(7, cc::binding(dir.path(), cc::thalamus()));
    let mut status = cc::step(raw);
    status["params"] = json!({"serializer_profile":"opencode-aisdk","observation":"answer"});
    assert_eq!(
        error_code(cc::call(&h, "compaction.step", status).await),
        "claude_code_lane_profile_mismatch"
    );
}

#[test]
fn duplicate_content_cannot_edit_bytes_before_effective_kept_thinking() {
    let raw = r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"text","text":"before-second-content"}],"content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"text","text":"after-effective-thinking"}]}"#;
    let parsed: Value = serde_json::from_str(raw).unwrap();
    assert!(
        matches!(codec_claude_code::envelope(&parsed,Some(&json!(raw))),Err(HandlerOutcome::ErrorWithDetail { code,detail,.. }) if code=="invalid_params" && detail["field"]=="raw_message")
    );
    let same = r#"{"role":"user","content":"identical prefix bytes"}"#;
    let thinking = r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"s"}]}"#;
    let request = request(&[entry(same, 0), entry(same, 1), entry(thinking, 2)]);
    let mut output = view(&request);
    // Equal bytes do not authorize one gateway message ID to occupy another's
    // position before kept signed thinking.
    output.replacement.swap(0, 1);
    let result = codec_claude_code::encode_view(&output, &request, None);
    assert!(
        matches!(result, Err(HandlerOutcome::Error { code, .. }) if code == "signed_prefix_edit")
    );
}

#[test]
fn duplicate_text_splice_must_change_effective_text_or_refuse() {
    let raw = r#"{"role":"user","content":[{"text":"shadowed","text":"effective","type":"text"}]}"#;
    let parsed: Value = serde_json::from_str(raw).unwrap();
    assert!(
        matches!(codec_claude_code::envelope(&parsed,Some(&json!(raw))),Err(HandlerOutcome::ErrorWithDetail { code,detail,.. }) if code=="invalid_params" && detail["field"]=="raw_message")
    );
}

#[test]
fn duplicate_content_cannot_hide_transport_marker() {
    let raw = r#"{"role":"user","content":[{"type":"text","text":"shadowed","cache_control":{"type":"ephemeral"}}],"content":[{"type":"text","text":"effective"}]}"#;
    let parsed: Value = serde_json::from_str(raw).unwrap();
    let result = codec_claude_code::envelope(&parsed, Some(&json!(raw)));
    eprintln!("REVIEW shadowed marker admitted={}", result.is_ok());
    assert!(
        matches!(result, Err(HandlerOutcome::ErrorWithDetail { code, detail, .. }) if code == "invalid_params" && detail["field"] == "raw_message")
    );
}

#[test]
fn whole_message_cuts_and_opaque_thinking_preserve_fences() {
    let request = request(&[
        entry(
            r#"{"role":"assistant","content":[{"type":"thinking","signature":"s","thinking":{"future":"opaque"}},{"type":"tool_use","id":"t","name":"tool","input":{}}]}"#,
            0,
        ),
        entry(
            r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"result"}]}"#,
            1,
        ),
        entry(r#"{"role":"user","content":"tail"}"#, 2),
    ]);
    let mut output = view(&request);
    output.replacement = vec![
        CkWireMessage::synthetic_user_text("summary"),
        request.messages[2].ck.clone(),
    ];
    assert!(codec_claude_code::encode_view(&output, &request, Some(1)).is_ok());
    assert!(
        matches!(codec_claude_code::encode_view(&output, &request, Some(0)), Err(HandlerOutcome::Error { code, .. }) if code == "invalid_signed_tool_boundary")
    );
    assert!(
        matches!(codec_claude_code::encode_view(&output, &request, None), Err(HandlerOutcome::Error { code, .. }) if code == "signed_prefix_edit")
    );
}

#[tokio::test]
async fn provider_committed_replacement_keeps_noncanonical_unsigned_tail() {
    for seed in [0, 1, 4, 12, 13, 16] {
        let raw = fuzz_raw(seed);
        let dir = tempfile::tempdir().unwrap();
        let h = cc::handler(dir.path(), cc::thalamus());
        cc::setup(&h).await;
        let mut status = cc::step(r#"{"role":"user","content":"settled history"}"#);
        status["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        status["messages"].as_array_mut().unwrap().push(json!({"mid":"tail","ordinal":1,"message":serde_json::from_str::<Value>(&raw).unwrap(),"raw_message":raw}));
        status["newest"] = json!({"mid":"tail","ordinal":1});
        let (first, _) = response(cc::call(&h, "compaction.step", status.clone()).await);
        let key = Key::new(
            &h.facade_binding(7).unwrap(),
            "cc",
            "claude-code",
        )
        .unwrap();
        let store = h.store.get().unwrap();
        store
            .replace_compartments(
                &key.engine_key(),
                &[mc_store::StoredCompartment {
                    sequence: 1,
                    start_message: 0,
                    end_message: 0,
                    end_message_id: "m#0".into(),
                    title: "history".into(),
                    content: "summary".into(),
                    p1: Some("summary".into()),
                    importance: 50,
                    ..Default::default()
                }],
            )
            .unwrap();
        status["request_id"] = json!("cold");
        status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
        if first["answer"] == "compaction_message" {
            status["last_applied"] = json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
        }
        let (answer, bytes) = response(cc::call(&h, "compaction.step", status).await);
        assert_eq!(
            answer["answer"], "compaction_message",
            "seed {seed}: {answer}"
        );
        let committed = store
            .load_provider_view(
                &key.store_key(),
                answer["compaction"]["version"].as_u64().unwrap(),
            )
            .unwrap()
            .unwrap();
        let frozen: Value = serde_json::from_str(&committed.replacement_json).unwrap();
        assert!(frozen["raw_replacement"]
            .as_array()
            .unwrap()
            .contains(&json!(raw)));
        let wire = String::from_utf8(bytes).unwrap();
        assert!(
            wire.contains(&raw),
            "seed {seed} committed raw absent from wire"
        );
        assert_eq!(frozen["head_slots"].as_array().unwrap().len(), 2);
        for slot in frozen["head_slots"].as_array().unwrap() {
            let index = slot["index"].as_u64().unwrap() as usize;
            let committed_raw = frozen["raw_replacement"][index].as_str().unwrap();
            assert_eq!(slot["bytes_sha256"], sha256_hex(committed_raw.as_bytes()));
            assert_eq!(slot["byte_length"], committed_raw.len());
        }
    }
    eprintln!("REVIEW actual provider wire: 6 cold-rebuild committed replacements preserve unsigned raw tail and hash committed head bytes");
}
