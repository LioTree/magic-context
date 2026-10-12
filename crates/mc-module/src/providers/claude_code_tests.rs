//! Claude Code routes require daemon-confirmed gateway identity; admitted message
//! IDs cannot later name different bytes. These tests do not use an LLM runner.
use super::*;

pub(super) fn binding(root: &Path, principal: Option<subc_protocol::Principal>) -> SessionBinding {
    SessionBinding {
        principal,
        project_root: root.into(),
        harness: "claude-code".into(),
        session: "cc".into(),
        model_key: None,
        history_budget_tokens: 4000.0,
        config: McModuleConfig {
            inject_docs: false,
            memory_enabled: false,
            ..Default::default()
        },
    }
}
pub(super) fn thalamus() -> Option<subc_protocol::Principal> {
    Some(subc_protocol::Principal::Reserved {
        module_id: "thalamus".into(),
    })
}
pub(super) fn handler(root: &Path, principal: Option<subc_protocol::Principal>) -> McHandler {
    let h = McHandler::new();
    let descriptor = StorageDescriptor {
        module_id: DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: root.join("cc.db").to_string_lossy().into(),
        },
    };
    h.store
        .set(Arc::new(McStore::open_for_test(&descriptor).unwrap()))
        .ok()
        .unwrap();
    h.bind_route(7, binding(root, principal));
    h
}
fn plan() -> Value {
    json!({"serializer_profile":"claude-code-anthropic","observation":"answer"})
}
pub(super) async fn call(h: &McHandler, method: &str, params: Value) -> HandlerOutcome {
    h.dispatch_value(7, json!({"method":method,"params":params}))
        .await
}
fn response(outcome: HandlerOutcome) -> Value {
    let HandlerOutcome::Response(bytes) = outcome else {
        panic!("{outcome:?}")
    };
    serde_json::from_slice(&bytes).unwrap()
}
fn code(outcome: HandlerOutcome) -> String {
    match outcome {
        HandlerOutcome::Error { code, .. } | HandlerOutcome::ErrorWithDetail { code, .. } => code,
        _ => panic!("{outcome:?}"),
    }
}
pub(super) async fn setup(h: &McHandler) -> Value {
    response(
        call(
            h,
            "transform.declare",
            json!({"session":"cc","harness":"claude-code","params":plan(),"preset":"head"}),
        )
        .await,
    );
    response(call(h,"compaction.setup",json!({"session":"cc","harness":"claude-code","request_id":"setup","params":plan(),"preset":"head","model":"fixture","context_window":100000,"composition":{},"lineage_id":"L","now":1})).await)
}
pub(super) fn step(raw: &str) -> Value {
    json!({"session":"cc","harness":"claude-code","request_id":"step","lineage_id":"L","step_id":"1","step_kind":"user_turn",
        "model":"fixture","context_window":100000,"estimate":{"request_tokens":1},"newest":{"mid":"m","ordinal":0},"after_ordinal":0,"messages":[{"mid":"m","ordinal":0,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw}],"now":2})
}

#[tokio::test]
async fn cc_principal_and_profile_pair_are_both_required_and_body_cannot_spoof() {
    for principal in [
        None,
        Some(subc_protocol::Principal::Direct),
        Some(subc_protocol::Principal::Reserved {
            module_id: "broca".into(),
        }),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path(), principal);
        assert_eq!(
            code(
                call(
                    &h,
                    "transform.declare",
                    json!({"params":plan(),"principal":"reserved:thalamus"})
                )
                .await
            ),
            "claude_code_lane_requires_attested_host"
        );
    }
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    for profile in ["owned-broca", "opencode-aisdk"] {
        assert_eq!(
            code(
                call(
                    &h,
                    "transform.declare",
                    json!({"params":{"serializer_profile":profile,"observation":"answer"}})
                )
                .await
            ),
            "claude_code_lane_profile_mismatch"
        );
    }
    assert_eq!(
        code(
            call(
                &h,
                "transform.declare",
                json!({"params":{"serializer_profile":"claude-code-anthropic"}})
            )
            .await
        ),
        "invalid_params"
    );
    let mut other = binding(dir.path(), None);
    other.harness = "opencode".into();
    h.bind_route(8, other);
    assert_eq!(
        code(
            h.dispatch_value(
                8,
                json!({"method":"transform.declare","params":{"params":plan()}})
            )
            .await
        ),
        "claude_code_lane_requires_attested_host"
    );
    let answer = setup(&h).await;
    assert_eq!(answer["answer"], "ready");
    assert_eq!(answer["initial"]["replacement"], json!([]));
}

#[tokio::test]
async fn cc_frozen_plan_session_harness_and_raw_mid_are_fenced() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let raw = r#"{ "content" : "hello\u0021", "role":"user" }"#;
    let mut status = step(raw);
    status["messages"][0]
        .as_object_mut()
        .unwrap()
        .remove("raw_message");
    assert_eq!(
        code(call(&h, "compaction.step", status).await),
        "invalid_params"
    );
    for field in ["session", "harness"] {
        let mut status = step(raw);
        status[field] = json!("spoof");
        assert_eq!(
            code(call(&h, "compaction.step", status).await),
            "invalid_params"
        );
    }
    let mut status = step(raw);
    status["params"] = plan();
    status["params"]["extra"] = json!(true);
    assert_eq!(
        code(call(&h, "compaction.step", status).await),
        "invalid_params"
    );
    let answer = response(call(&h, "compaction.step", step(raw)).await);
    assert!(matches!(
        answer["answer"].as_str(),
        Some("noop" | "compaction_message")
    ));
    let key = Key::new(&binding(dir.path(), thalamus()), "cc", "claude-code").unwrap();
    let held = h
        .store
        .get()
        .unwrap()
        .load_provider_messages(&key.store_key(), "L")
        .unwrap();
    assert_eq!(held.len(), 1);
    let bytes: Value = serde_json::from_slice(&held[0].message_bytes).unwrap();
    assert_eq!(bytes["raw_message"], raw);
    assert_eq!(
        code(
            call(
                &h,
                "compaction.step",
                step(r#"{"content":"hello!","role":"user"}"#)
            )
            .await
        ),
        "invalid_params"
    );
    assert_eq!(
        code(
            call(
                &h,
                "compaction.step",
                step(r#"{"role":"user","content":"different"}"#)
            )
            .await
        ),
        "invalid_params"
    );
    h.bind_route(7, binding(dir.path(), None));
    assert_eq!(
        code(call(&h, "compaction.step", step(raw)).await),
        "claude_code_lane_requires_attested_host"
    );
}

#[tokio::test]
async fn cc_required_head_edit_before_kept_thinking_is_terminal_not_hook_pass() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let raw = r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"text","text":"answer"}]}"#;
    let mut status = step(raw);
    status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    let answer = response(call(&h, "compaction.step", status).await);
    assert_eq!(answer["answer"], "refuse");
    assert_eq!(answer["code"], "misconfigured");
    assert_eq!(answer["provider_code"], "signed_prefix_edit");
}

#[tokio::test]
async fn cc_hook_pass_is_durable_and_raw_retries_do_not_rewrite_signed_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let raw = r#"{"content":[{ "signature":"s", "thinking":"p\u0072ivate", "type":"thinking" },{"type":"text","text":"answer"}],"role":"assistant"}"#;
    let params = json!({"session":"cc","harness":"claude-code","lineage_id":"L","step_id":"s","params":plan(),"subject_mid":"m","subject_ordinal":0,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,
        "hook":"post_assistant","blocks":["answer"]});
    let answer = response(call(&h, "transform.hook", params.clone()).await);
    assert_eq!(answer["answer"], "pass");
    assert_eq!(response(call(&h, "transform.hook", params).await), answer);
    let key = Key::new(&binding(dir.path(), thalamus()), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    let held = store.load_provider_messages(&key.store_key(), "L").unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&held[0].message_bytes).unwrap()["raw_message"],
        raw
    );
    let answers = store.load_provider_hook_answers(&key.store_key()).unwrap();
    assert_eq!(
        answers.iter().map(|a| a.state.as_str()).collect::<Vec<_>>(),
        vec!["burned", "pending"]
    );
    assert!(answers
        .iter()
        .all(|a| a.answer.ops_json == "[]" && a.answer.tags.is_empty()));
}

#[tokio::test]
async fn cc_cache_policy_is_frozen_and_cold_rebuild_exposes_committed_head_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    let mut b = binding(dir.path(), thalamus());
    b.config
        .cache_ttl_by_model
        .insert("fixture".into(), "5m".into());
    h.bind_route(7, b.clone());
    let ready = setup(&h).await;
    assert_eq!(
        ready["cache_policy"]["marker_ttl"],
        json!({"intent":"authored","ttl":"5m"})
    );
    assert_eq!(ready["head_slots"], json!([]));
    b.config
        .cache_ttl_by_model
        .insert("fixture".into(), "1h".into());
    h.bind_route(7, b.clone());
    assert_eq!(setup(&h).await["cache_policy"], ready["cache_policy"]);
    let raw = r#"{ "content":"unsigned live text", "role":"user" }"#;
    let mut bootstrap = step(raw);
    bootstrap["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    bootstrap["messages"].as_array_mut().unwrap().push(json!({"mid":"tail","ordinal":1,"message":{"role":"user","content":"live tail"},"raw_message":r#"{"role":"user","content":"live tail"}"#}));
    bootstrap["newest"] = json!({"mid":"tail","ordinal":1});
    let first = response(call(&h, "compaction.step", bootstrap.clone()).await);
    let key = Key::new(&b, "cc", "claude-code").unwrap();
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
                content: "idle fold".into(),
                p1: Some("idle fold".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    let mut status = bootstrap;
    status["request_id"] = json!("cold");
    status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    if first["answer"] == "compaction_message" {
        status["last_applied"] = json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    }
    let HandlerOutcome::Response(bytes) = call(&h, "compaction.step", status).await else {
        panic!("cold rebuild failed")
    };
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(answer["answer"], "compaction_message");
    assert_eq!(answer["cache_policy"], ready["cache_policy"]);
    let row = store
        .load_provider_view(
            &key.store_key(),
            answer["compaction"]["version"].as_u64().unwrap(),
        )
        .unwrap()
        .unwrap();
    let committed: Value = serde_json::from_str(&row.replacement_json).unwrap();
    let raw = committed["raw_replacement"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(String::from_utf8(bytes).unwrap().contains(&raw.join(",")));
    assert_eq!(answer["head_slots"], committed["head_slots"]);
    assert_eq!(answer["head_slots"].as_array().unwrap().len(), 2);
    for slot in answer["head_slots"].as_array().unwrap() {
        let index = slot["index"].as_u64().unwrap() as usize;
        assert_eq!(slot["bytes_sha256"], sha256_hex(raw[index].as_bytes()));
        assert_eq!(
            slot["byte_length"].as_u64().unwrap(),
            raw[index].len() as u64
        );
    }
}
