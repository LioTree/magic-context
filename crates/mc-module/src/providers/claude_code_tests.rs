//! Claude Code routes require daemon-confirmed gateway identity; admitted message
//! IDs cannot later name different bytes. These tests do not use an LLM runner.
use super::*;

pub(super) fn binding(root: &Path, principal: Option<subc_protocol::Principal>) -> SessionBinding {
    SessionBinding {
        connection_incarnation: 0,
        native_generation: None,
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
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
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
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
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
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
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
    let row = crate::providers::view_recipe::stored_view(
        &store,
        &key.store_key(),
        answer["compaction"]["version"].as_u64().unwrap(),
    )
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
    let frozen: compact::view::FrozenView =
        serde_json::from_value(answer["compaction"]["raw_view"].clone()).unwrap();
    frozen.validate().unwrap();
    let full = format!("[{}]", raw.join(","));
    assert_eq!(
        frozen.payload,
        compact::view::RawPayload::Inline {
            bytes: full.clone()
        }
    );
    assert_eq!(
        frozen.endpoint,
        compact::view::NativeEndpoint {
            message_id: "m".into(),
            part_index: 0
        }
    );
    let mut read = json!({"request_id":"read","view_id":frozen.view.view_id,"version":frozen.view.version,"sha256":frozen.view.sha256,"byte_cursor":0});
    let page = response(call(&h, "compaction.view.read", read.clone()).await);
    assert_eq!(page["answer"], "page");
    assert_eq!(page["bytes"], full);
    read["sha256"] = json!("0".repeat(64));
    let rejected = response(call(&h, "compaction.view.read", read).await);
    assert_eq!(rejected["code"], "digest_mismatch");
    let cut = frozen
        .cut_replacement_ref
        .as_ref()
        .expect("native hook head reference");
    let cut_read = json!({"request_id":"head","view_id":cut.view_id,"version":cut.version,"sha256":cut.sha256,"byte_cursor":0});
    let head = response(call(&h, "compaction.view.read", cut_read.clone()).await);
    assert_eq!(head["answer"], "page");
    let prefix: Vec<Value> = serde_json::from_str(head["bytes"].as_str().unwrap()).unwrap();
    assert_eq!(prefix.len(), 2);
    assert!(!head["bytes"].as_str().unwrap().contains("live tail"));
    assert_eq!(
        frozen.retained_tail.as_ref().unwrap(),
        &vec![compact::view::RetainedPart {
            endpoint: compact::view::NativeEndpoint {
                message_id: "tail".into(),
                part_index: 0
            },
            engine_handle: "tail#0".into()
        }]
    );
    let mut applied = step(r#"{ "content":"unsigned live text", "role":"user" }"#);
    applied["newest"] = json!({"mid":"tail","ordinal":1});
    applied["last_applied"] = json!({"compaction_id":answer["compaction"]["compaction_id"],"version":answer["compaction"]["version"]});
    response(call(&h, "compaction.step", applied).await);
    h.bind_route(7, b.clone());
    setup(&h).await;
    let replay = response(call(&h, "compaction.view.read", cut_read.clone()).await);
    assert_eq!(replay["bytes"], head["bytes"]);
    drop(h);
    let h = handler(dir.path(), thalamus());
    h.bind_route(7, b.clone());
    setup(&h).await;
    let replay = response(call(&h, "compaction.view.read", cut_read.clone()).await);
    assert_eq!(replay["bytes"], head["bytes"]);
    let mut sibling = b.clone();
    sibling.session = "subagent".into();
    h.bind_route(7, sibling);
    response(
        call(
            &h,
            "transform.declare",
            json!({"session":"subagent","harness":"claude-code","preset":"head","params":plan()}),
        )
        .await,
    );
    let borrowed = response(call(&h, "compaction.view.read", cut_read).await);
    assert_eq!(borrowed["code"], "unknown_version");
    for slot in answer["head_slots"].as_array().unwrap() {
        let index = slot["index"].as_u64().unwrap() as usize;
        assert_eq!(slot["bytes_sha256"], sha256_hex(raw[index].as_bytes()));
        assert_eq!(
            slot["byte_length"].as_u64().unwrap(),
            raw[index].len() as u64
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cc_geometry_reserve_and_continuation_reach_the_real_engine() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    transform::compaction::LAST_NATIVE_REQUEST.with(|slot| slot.borrow_mut().take());
    let mut status = step(r#"{"role":"user","content":"native text"}"#);
    status["geometry"] = json!({"usable_soft":50000,"usable_hard":60000,"absolute_wall":100000,"derivation":"gateway"});
    status["output_reserve"] = json!(40000);
    status["mid_turn"] = json!(true);
    let answer = response(call(&h, "compaction.step", status).await);
    assert!(matches!(
        answer["answer"].as_str(),
        Some("noop" | "compaction_message")
    ));
    let (profile, geometry, mid_turn) = transform::compaction::LAST_NATIVE_REQUEST
        .with(|slot| slot.borrow_mut().take())
        .expect("actual engine call");
    assert_eq!(profile, "claude-code-anthropic");
    assert_eq!(
        geometry,
        Some(transform::TransformGeometry {
            usable_soft: 50000,
            usable_hard: 60000,
            absolute_wall: 100000,
            derivation: "gateway".into()
        })
    );
    assert!(mid_turn);
}

#[tokio::test]
async fn cc_invalid_geometry_and_unsupported_evidence_refuse_before_ingest() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let base = step(r#"{"role":"user","content":"native text"}"#);
    for (field, extra) in [
        (
            "geometry",
            json!({"geometry":{"usable_soft":0,"usable_hard":60000,"absolute_wall":100000,"derivation":"gateway"}}),
        ),
        (
            "geometry",
            json!({"geometry":{"usable_soft":50000,"usable_hard":90000,"absolute_wall":100000,"derivation":"gateway"},"output_reserve":20000}),
        ),
        ("geometry", json!({"output_reserve":1})),
        (
            "fill",
            json!({"fill":{"input_tokens":1,"basis":"measured","observed_request_id":"unadmitted"}}),
        ),
        (
            "channel2_receipt",
            json!({"channel2_delivered_id":"unsupported"}),
        ),
    ] {
        let mut status = base.clone();
        status
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(
            matches!(call(&h,"compaction.step",status).await,HandlerOutcome::ErrorWithDetail { code,detail,.. } if code=="invalid_params" && detail["field"]==field)
        );
    }
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    assert!(h
        .store
        .get()
        .unwrap()
        .load_provider_messages(&key.store_key(), "L")
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn cc_partial_engine_boundary_refuses_instead_of_snapping_whole_message() {
    for (part, expected) in [(0, "refuse"), (1, "compaction_message")] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path(), thalamus());
        setup(&h).await;
        let mut status = step(
            r#"{"role":"user","content":[{"type":"text","text":"covered"},{"type":"text","text":"must remain"}]}"#,
        );
        status["messages"].as_array_mut().unwrap().push(json!({"mid":"tail","ordinal":1,"message":{"role":"user","content":"live tail"},"raw_message":r#"{"role":"user","content":"live tail"}"#}));
        status["newest"] = json!({"mid":"tail","ordinal":1});
        status["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let first = response(call(&h, "compaction.step", status.clone()).await);
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        store
            .replace_compartments(
                &key.engine_key(),
                &[mc_store::StoredCompartment {
                    sequence: 1,
                    start_message: 0,
                    end_message: 0,
                    end_message_id: format!("m#{part}"),
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
        let answer = response(call(&h, "compaction.step", status).await);
        assert_eq!(answer["answer"], expected);
        if part == 0 {
            assert_eq!(answer["provider_code"], "native_endpoint_unrepresentable");
        } else {
            assert_eq!(
                answer["coverage"]["endpoint"],
                json!({"message_id":"m","part_index":1})
            );
        }
    }
}

#[tokio::test]
async fn cc_original_inbound_envelope_size_is_checked_before_normalized_params() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    let request =
        json!({"method":"compaction.step","params":step(r#"{"role":"user","content":"small"}"#)});
    let result = h
        .dispatch_value_with_inbound_bytes(7, request, Some(HOST_ENVELOPE_BYTES))
        .await;
    assert!(
        matches!(result,HandlerOutcome::ErrorWithDetail { code,detail,.. } if code=="invalid_params" && detail["field"]=="messages")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn cc_without_fill_uses_request_estimate_and_soft_geometry_and_folds() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    let mut b = binding(dir.path(), thalamus());
    b.config.execute_threshold_percentage = 65.0;
    h.bind_route(7, b);
    setup(&h).await;
    let mut status = step(r#"{"role":"user","content":"history"}"#);
    status["messages"].as_array_mut().unwrap().push(json!({"mid":"tail","ordinal":1,"message":{"role":"user","content":"tail"},"raw_message":r#"{"role":"user","content":"tail"}"#}));
    status["newest"] = json!({"mid":"tail","ordinal":1});
    status["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    status["geometry"] = json!({"usable_soft":50000,"usable_hard":60000,"absolute_wall":100000,"derivation":"gateway"});
    let first = response(call(&h, "compaction.step", status.clone()).await);
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
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
                content: "fold without fill".into(),
                p1: Some("fold without fill".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    status.as_object_mut().unwrap().remove("prefix_rebuilding");
    if first["answer"] == "compaction_message" {
        status["last_applied"] = json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    }
    for (tokens, soft, hard) in [
        (40000, 80.0, 40000.0 / 60000.0 * 100.0),
        (44000, 88.0, 44000.0 / 60000.0 * 100.0),
        (58000, 116.0, 58000.0 / 60000.0 * 100.0),
    ] {
        status["request_id"] = json!(format!("estimate-{tokens}"));
        status["estimate"]["request_tokens"] = json!(tokens);
        assert!(status.get("fill").is_none());
        assert!(status.get("previous_usage").is_none());
        let answer = response(call(&h, "compaction.step", status.clone()).await);
        let actual = transform::compaction::LAST_NATIVE_PRESSURE
            .with(|slot| slot.borrow_mut().take())
            .unwrap();
        assert!((actual.0 - soft).abs() < 0.001);
        assert!((actual.1 - hard).abs() < 0.001);
        if tokens == 40000 {
            assert_eq!(answer["answer"], "compaction_message");
            assert!(answer.to_string().contains("fold without fill"));
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cc_raw_history_size_does_not_silently_replace_the_supplied_pressure_estimate() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let raw = json!({"role":"user","content":"not a measured sample ".repeat(6000)}).to_string();
    assert!(mc_tokenizer::estimate_tokens(&raw) > 10000);
    let mut status = step(&raw);
    status["geometry"] = json!({"usable_soft":50000,"usable_hard":60000,"absolute_wall":100000,"derivation":"gateway"});
    response(call(&h, "compaction.step", status).await);
    let pressure = transform::compaction::LAST_NATIVE_PRESSURE
        .with(|slot| slot.borrow_mut().take())
        .unwrap();
    assert!((pressure.0 - 0.002).abs() < 0.000001);
}
