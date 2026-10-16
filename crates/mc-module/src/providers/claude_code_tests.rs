//! Claude Code routes require the daemon to identify the caller as THALAMUS.
//! Stored message IDs retain their first bytes across scalar/single-text-block
//! form flips; all other changes remain conflicts. No LLM runner is used here.
use super::*;
#[path = "context_fixture_tests.rs"]
mod context_fixture_tests;
#[path = "g8_replay_tests.rs"]
mod g8_replay_tests;
#[path = "late_descent_tests.rs"]
mod late_descent_tests;
#[path = "native_endpoint_tests.rs"]
mod native_endpoint_tests;
#[path = "pending_hook_pairing_tests.rs"]
mod pending_hook_pairing_tests;
#[path = "tag_high_water_tests.rs"]
mod tag_high_water_tests;

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

pub(super) fn handler_with_admission_tags(root: &Path, enabled: bool) -> McHandler {
    let h = handler(root, thalamus());
    let mut pins = h.native_pins();
    pins.canonical_reduce = enabled;
    pins.guidance = enabled;
    *h.native_bundle_override.lock().unwrap() = Some(pins);
    h
}

pub(super) fn assert_admission_answer(answer: &Value, enabled: bool, tags: &[(usize, u64)]) {
    let expected = if enabled && !tags.is_empty() {
        json!({"answer":"ops","ops": tags.iter().map(|(block, number)| {
            json!({"op":"prepend","block":block,"text":format!("§{number}§ ")})
        }).collect::<Vec<_>>()})
    } else {
        json!({"answer":"pass"})
    };
    assert_eq!(answer, &expected);
}

pub(super) fn assert_stored_and_served_raw(
    h: &McHandler,
    mid: &str,
    ingress_raw: &str,
    served_raw: &str,
) {
    assert_stored_and_served_raw_in_lineage(h, "L", mid, ingress_raw, served_raw);
}

pub(super) fn assert_stored_and_served_raw_in_lineage(
    h: &McHandler,
    lineage: &str,
    mid: &str,
    ingress_raw: &str,
    served_raw: &str,
) {
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    let messages = store
        .load_provider_messages(&key.store_key(), lineage)
        .unwrap();
    let message = messages.iter().find(|message| message.mid == mid).unwrap();
    let stored: Value = serde_json::from_slice(&message.message_bytes).unwrap();
    assert_eq!(stored["raw_message"], ingress_raw);
    let decoded = codec::Codec::ClaudeCodeAnthropic
        .decode_message(&compact::status::StatusMessage {
            raw_message: None,
            mid: mid.into(),
            ordinal: message.ordinal,
            message: stored,
        })
        .unwrap();
    let tags = store
        .load_provider_hook_answers(&key.store_key())
        .unwrap()
        .into_iter()
        .filter(|answer| {
            answer.answer.subject.subject_mid == mid
                && matches!(answer.state.as_str(), "pending" | "live")
        })
        .flat_map(|answer| {
            answer
                .answer
                .tags
                .into_iter()
                .map(|tag| (tag.block_id, tag.number as u64))
        })
        .collect();
    assert_eq!(
        codec_claude_code::admission_served_bytes(ingress_raw.into(), &decoded.ck, &tags).unwrap(),
        served_raw
    );
}
struct LocalSessionResolver;

#[async_trait::async_trait]
impl crate::session_resolver::SessionResolver for LocalSessionResolver {
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
            session_id: "cc".into(),
            last_traffic_ms: 1,
        }))
    }
}

fn plan() -> Value {
    json!({"serializer_profile":"claude-code-anthropic","observation":"answer"})
}
pub(super) async fn call(h: &McHandler, method: &str, params: Value) -> HandlerOutcome {
    let outcome = h
        .dispatch_value(7, json!({"method":method,"params":params}))
        .await;
    if method == "compaction.step" {
        if let HandlerOutcome::Response(bytes) = &outcome {
            assert_native_range_endpoint(&serde_json::from_slice::<Value>(bytes).unwrap(), &params);
        }
    }
    outcome
}

pub(super) fn assert_native_range_endpoint(answer: &Value, status: &Value) {
    if answer["answer"] != "compaction_message" || answer["compaction"]["raw_view"].is_null() {
        return;
    }
    let coverage = &answer["coverage"];
    let endpoint = &coverage["endpoint"];
    assert_eq!(
        coverage["ordinal"].as_u64().unwrap().checked_add(1),
        answer["compaction"]["range"]["to"].as_u64(),
        "endpoint_range_to"
    );
    assert_eq!(coverage["end_mid"], endpoint["message_id"]);
    assert_eq!(answer["compaction"]["raw_view"]["endpoint"], *endpoint);
    let Some(source) = status["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|source| source["mid"] == endpoint["message_id"])
    else {
        // A descendant step can inherit originals already stored for its parent
        // instead of resending them. Production admission checks their original
        // content-block coordinates against the stored messages.
        return;
    };
    assert_eq!(
        source["ordinal"].as_u64().unwrap().checked_add(1),
        answer["compaction"]["range"]["to"].as_u64(),
        "endpoint_range_to"
    );
    assert_eq!(coverage["ordinal"], source["ordinal"]);
    assert_eq!(coverage["end_mid"], source["mid"]);
    let content = &source["message"]["content"];
    let last_part = if content.is_string() {
        0
    } else {
        content.as_array().unwrap().len() - 1
    };
    assert_eq!(endpoint["part_index"], json!(last_part));
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
async fn cc_required_head_edit_before_kept_thinking_is_held_on_non_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let raw = r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"text","text":"answer"}]}"#;
    let mut status = step(raw);
    status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    let answer = response(call(&h, "compaction.step", status).await);
    assert_eq!(answer["answer"], "noop");
}

#[tokio::test]
async fn cc_hook_pass_is_durable_and_raw_retries_do_not_rewrite_signed_bytes() {
    for tags_on in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler_with_admission_tags(dir.path(), tags_on);
        setup(&h).await;
        let raw = r#"{"content":[{ "signature":"s", "thinking":"p\u0072ivate", "type":"thinking" },{"type":"text","text":"answer"}],"role":"assistant"}"#;
        let params = json!({"session":"cc","harness":"claude-code","lineage_id":"L","step_id":"s","params":plan(),"subject_mid":"m","subject_ordinal":0,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,
        "hook":"post_assistant","blocks":["answer"]});
        let answer = response(call(&h, "transform.hook", params.clone()).await);
        assert_admission_answer(&answer, tags_on, &[(0, 1)]);
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
        for stored in &answers {
            assert_eq!(
                serde_json::from_str::<Value>(&stored.answer.ops_json).unwrap(),
                answer.get("ops").cloned().unwrap_or_else(|| json!([]))
            );
            if tags_on {
                assert_eq!(stored.answer.tags.len(), 1);
                assert_eq!(stored.answer.tags[0].number, 1);
                assert_eq!(stored.answer.tags[0].block_id, "m#1");
            } else {
                assert!(stored.answer.tags.is_empty());
            }
        }
        let served = if tags_on {
            raw.replacen(r#""answer""#, r#""§1§ answer""#, 1)
        } else {
            raw.into()
        };
        assert_stored_and_served_raw(&h, "m", raw, &served);
    }
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
            message_id: "tail".into(),
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
    assert_eq!(prefix.len(), 3);
    assert_eq!(head["bytes"], full);
    assert_eq!(frozen.retained_tail, Some(vec![]));
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
            json!({"geometry":{"usable_soft":50000,"usable_hard":60000,"absolute_wall":100001,"derivation":"gateway"}}),
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
                json!({"message_id":"tail","part_index":0})
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
    fold_with_catalog(dir.path(), dir.path(), Some(100000)).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cc_force_band_applies_queued_native_drop_without_broca() {
    queued_native_drop_without_broca(Some((20000, 22000))).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cc_emergency_band_applies_queued_native_drop_without_broca() {
    queued_native_drop_without_broca(Some((20000, 21000))).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cc_below_force_execute_applies_pending_native_drop_without_broca() {
    queued_native_drop_without_broca(Some((30000, 167000))).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cc_defer_holds_pending_native_drop_without_broca() {
    queued_native_drop_without_broca(None).await;
}

async fn queued_native_drop_without_broca(pressure: Option<(u64, u64)>) {
    let dir = tempfile::tempdir().unwrap();
    let mut h = handler(dir.path(), thalamus());
    // A 10% threshold admits the roughly 18%-full execute request, below the 85%
    // force threshold. The lower-pressure request reports an unfinished tool
    // turn, so the scheduler must defer ordinary execution until its boundary.
    let user_config = dir.path().join("magic-context.jsonc");
    std::fs::write(&user_config, r#"{"execute_threshold_percentage":10}"#).unwrap();
    let low_threshold_config =
        crate::config::ConfigCache::default().effective_for_paths(&user_config, dir.path());
    assert_eq!(
        low_threshold_config
            .resolve_execute_threshold(Some("fixture"))
            .percentage,
        10.0
    );
    let mut low_threshold_binding = binding(dir.path(), thalamus());
    low_threshold_binding.config = low_threshold_config;
    h.bind_route(7, low_threshold_binding);
    let initial = setup(&h).await;
    // The local resolver supplies a session identity for the ctx_reduce tool
    // call without starting the daemon. McHandler::new() has no Subc connection
    // file, so it cannot reach Broca, the service that runs historian summaries.
    h.session_resolver = Arc::new(LocalSessionResolver);
    assert_eq!(
        h.facade_binding(7)
            .unwrap()
            .config
            .historian_runner_for("claude-code")
            .kind,
        crate::historian_runner::HistorianRunnerKind::Broca
    );
    let thinking_and_call = r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private reasoning","signature":"sig-turn-1"},{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"notes.txt"}}]}"#;
    let tool_result = r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-1","content":"obsolete output from the first turn"}]}"#;
    let next_call = r#"{"role":"assistant","content":[{"type":"text","text":"Checking another source."},{"type":"tool_use","id":"read-2","name":"Read","input":{"file_path":"next.txt"}}]}"#;
    let next_result = r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-2","content":"additional output two"}]}"#;
    let third_call = r#"{"role":"assistant","content":[{"type":"text","text":"Checking one more source."},{"type":"tool_use","id":"read-3","name":"Read","input":{"file_path":"third.txt"}}]}"#;
    let third_result = r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-3","content":"additional output three"}]}"#;
    let fourth_call = r#"{"role":"assistant","content":[{"type":"text","text":"Checking the final source."},{"type":"tool_use","id":"read-4","name":"Read","input":{"file_path":"fourth.txt"}}]}"#;
    let fourth_result = r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-4","content":"additional output four"}]}"#;
    let assistant_reply =
        r#"{"role":"assistant","content":[{"type":"text","text":"I found the note."}]}"#;
    let followup = r#"{"role":"user","content":"Now summarize the next detail."}"#;

    let mut turn_one = step(r#"{"role":"user","content":"Read the note."}"#);
    turn_one["context_window"] = json!(200000);
    turn_one["estimate"]["request_tokens"] = json!(1);
    turn_one["geometry"] = json!({"usable_soft":167000,"usable_hard":200000,"absolute_wall":200000,"derivation":"gateway"});
    turn_one["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    turn_one["messages"].as_array_mut().unwrap().extend([
        json!({"mid":"call","ordinal":1,"message":serde_json::from_str::<Value>(thinking_and_call).unwrap(),"raw_message":thinking_and_call}),
        json!({"mid":"result","ordinal":2,"message":serde_json::from_str::<Value>(tool_result).unwrap(),"raw_message":tool_result}),
    ]);
    turn_one["newest"] = json!({"mid":"result","ordinal":2});
    let first = response(call(&h, "compaction.step", turn_one).await);
    assert!(matches!(
        first["answer"].as_str(),
        Some("noop" | "compaction_message")
    ));
    let applied_view = if first["answer"] == "compaction_message" {
        &first["compaction"]
    } else {
        &initial["initial"]
    };

    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    // Seed the numbered tag the main transform would have shown for the first
    // tool result. This test starts at the compaction route, which consumes
    // existing tags but does not create new ones, then calls ctx_reduce through
    // the same facade the model uses.
    store
        .seed_tags_for_test(
            &key.engine_key(),
            &[
                ("result#0", "obsolete output from the first turn"),
                ("result-2#0", "additional output two"),
                ("result-3#0", "additional output three"),
                ("result-4#0", "additional output four"),
            ]
            .map(|(block_id, source)| mc_store::TagMintInput {
                block_id: block_id.into(),
                kind: "tool_result".into(),
                token_count: 8000,
                source_bytes: source.as_bytes().to_vec(),
            }),
            2,
        )
        .unwrap();
    let result_tag = store
        .load_tag_numbers_for_session(&key.engine_key())
        .unwrap()
        .into_iter()
        .find(|tag| tag.block_id == "result#0")
        .expect("the first turn exposes a ctx_reduce tag for its tool result");
    let reduced = response(
        h.dispatch_value(
            7,
            json!({"name":"ctx_reduce","arguments":{"drop":result_tag.tag_number.to_string()}}),
        )
        .await,
    );
    assert!(reduced.to_string().contains("tag stamped"), "{reduced}");
    assert!(store
        .load_pending_agent_drops(&key.engine_key())
        .unwrap()
        .iter()
        .any(|drop| drop.target_id == "result#0"));
    let broca_error = match h.producer_factory.connect(dir.path()).await {
        Err(error @ HistorianProducerError::NoEndpoint { .. }) => error,
        _ => panic!("expected the absent Broca route to refuse connection"),
    };
    record_historian_connect_failure(
        store,
        &key.engine_key(),
        crate::now_ms(),
        &format!("producer connect: {broca_error}"),
        &h.connect_failure_commit_hook,
    )
    .unwrap();
    assert!(store
        .load_meta(&key.engine_key())
        .unwrap()
        .meta
        .historian
        .last_failure
        .is_some());

    let mut turn_two = step(r#"{"role":"user","content":"Read the note."}"#);
    turn_two["request_id"] = json!("turn-two");
    turn_two["context_window"] = json!(200000);
    turn_two["estimate"]["request_tokens"] = json!(pressure.map_or(20000, |(tokens, _)| tokens));
    turn_two["geometry"] = json!({"usable_soft":pressure.map_or(22000, |(_, soft)| soft),"usable_hard":200000,"absolute_wall":200000,"derivation":"gateway"});
    turn_two["last_applied"] =
        json!({"compaction_id":applied_view["compaction_id"],"version":applied_view["version"]});
    turn_two["messages"].as_array_mut().unwrap().extend([
        json!({"mid":"call","ordinal":1,"message":serde_json::from_str::<Value>(thinking_and_call).unwrap(),"raw_message":thinking_and_call}),
        json!({"mid":"result","ordinal":2,"message":serde_json::from_str::<Value>(tool_result).unwrap(),"raw_message":tool_result}),
        json!({"mid":"call-2","ordinal":3,"message":serde_json::from_str::<Value>(next_call).unwrap(),"raw_message":next_call}),
        json!({"mid":"result-2","ordinal":4,"message":serde_json::from_str::<Value>(next_result).unwrap(),"raw_message":next_result}),
        json!({"mid":"call-3","ordinal":5,"message":serde_json::from_str::<Value>(third_call).unwrap(),"raw_message":third_call}),
        json!({"mid":"result-3","ordinal":6,"message":serde_json::from_str::<Value>(third_result).unwrap(),"raw_message":third_result}),
        json!({"mid":"call-4","ordinal":7,"message":serde_json::from_str::<Value>(fourth_call).unwrap(),"raw_message":fourth_call}),
        json!({"mid":"result-4","ordinal":8,"message":serde_json::from_str::<Value>(fourth_result).unwrap(),"raw_message":fourth_result}),
        json!({"mid":"reply","ordinal":9,"message":serde_json::from_str::<Value>(assistant_reply).unwrap(),"raw_message":assistant_reply}),
        json!({"mid":"followup","ordinal":10,"message":serde_json::from_str::<Value>(followup).unwrap(),"raw_message":followup}),
    ]);
    turn_two["newest"] = json!({"mid":"followup","ordinal":10});
    let mut normal_geometry = turn_two.clone();
    normal_geometry["request_id"] = json!("normal-geometry");
    normal_geometry["estimate"]["request_tokens"] = json!(1000);
    normal_geometry["mid_turn"] = json!(true);
    normal_geometry["geometry"] = json!({"usable_soft":167000,"usable_hard":200000,"absolute_wall":200000,"derivation":"gateway"});
    let normal = response(call(&h, "compaction.step", normal_geometry).await);
    let normal_pressure = transform::compaction::LAST_NATIVE_PRESSURE
        .with(|slot| slot.borrow_mut().take())
        .expect("the defer CC pass reaches the engine");
    assert!((normal_pressure.0 - (1_000.0 / 167_000.0 * 100.0)).abs() < 0.001);
    assert_eq!(normal["answer"], "noop", "{normal}");
    assert!(store
        .load_pending_agent_drops(&key.engine_key())
        .unwrap()
        .iter()
        .any(|drop| drop.target_id == "result#0"));
    let Some((tokens, soft)) = pressure else {
        return;
    };
    let second = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        call(&h, "compaction.step", turn_two.clone()),
    )
    .await
    .expect("an execute-class step must not wait for unavailable Broca");
    let second = response(second);
    let pressure = transform::compaction::LAST_NATIVE_PRESSURE
        .with(|slot| slot.borrow_mut().take())
        .expect("the CC engine measured the request against usable_soft");
    assert!((pressure.0 - (tokens as f64 / soft as f64 * 100.0)).abs() < 0.001);
    assert_eq!(second["answer"], "compaction_message", "{second}");
    assert_eq!(second["compaction"]["range"], json!({"from":0,"to":11}));
    assert_eq!(
        second["coverage"],
        json!({"end_mid":"followup","ordinal":10,"endpoint":{"message_id":"followup","part_index":0}})
    );

    let mut repeated = turn_two.clone();
    repeated["request_id"] = json!("same-execute");
    repeated["last_applied"] = json!({"compaction_id":second["compaction"]["compaction_id"],"version":second["compaction"]["version"]});
    assert_eq!(
        response(call(&h, "compaction.step", repeated).await)["answer"],
        "noop"
    );

    let mut turn_three = turn_two;
    turn_three["request_id"] = json!("turn-three");
    turn_three["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    turn_three["last_applied"] = json!({"compaction_id":second["compaction"]["compaction_id"],"version":second["compaction"]["version"]});
    let third = response(call(&h, "compaction.step", turn_three).await);
    assert_eq!(third["answer"], "compaction_message", "{third}");

    for answer in [&second, &third] {
        validate_native_answer(answer, &h.native_pins());
        let version = answer["compaction"]["version"].as_u64().unwrap();
        let view = store
            .load_provider_view(&key.store_key(), version)
            .unwrap()
            .unwrap();
        let committed: Value = serde_json::from_str(&view.replacement_json).unwrap();
        let raw_replacement = committed["raw_replacement"].as_array().unwrap();
        let rendered = raw_replacement
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        let dropped_result = rendered
            .iter()
            .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
            .find(|message| {
                message["content"].as_array().is_some_and(|blocks| {
                    blocks.iter().any(|block| block["tool_use_id"] == "read-1")
                })
            })
            .expect("the replacement keeps the first tool result paired");
        assert!(
            dropped_result
                .to_string()
                .contains(&format!("[dropped §{}§]", result_tag.tag_number)),
            "{dropped_result}"
        );
        let rendered_messages = rendered
            .iter()
            .map(|raw| serde_json::from_str::<Value>(raw).unwrap())
            .collect::<Vec<_>>();
        if answer["compaction"]["version"] == second["compaction"]["version"] {
            assert!(rendered.contains(&thinking_and_call));
            assert_eq!(rendered[0], r#"{"role":"user","content":"Read the note."}"#);
        } else {
            assert!(rendered_messages.iter().all(|message| {
                message["content"].as_array().is_none_or(|blocks| {
                    blocks.iter().all(|block| {
                        block["type"] != "thinking" && block["type"] != "redacted_thinking"
                    })
                })
            }));
        }
        let call_index = rendered_messages
            .iter()
            .position(|message| {
                message["content"].as_array().is_some_and(|blocks| {
                    blocks
                        .iter()
                        .any(|block| block["type"] == "tool_use" && block["id"] == "read-1")
                })
            })
            .expect("the replacement keeps the first tool call");
        assert!(rendered_messages[call_index + 1]["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|block| {
                block["type"] == "tool_result" && block["tool_use_id"] == "read-1"
            })));
    }
}

async fn fold_with_catalog(db_root: &Path, route_root: &Path, window: Option<u64>) -> Vec<Value> {
    let h = handler(db_root, thalamus());
    let mut b = binding(route_root, thalamus());
    b.config.execute_threshold_percentage = 65.0;
    h.bind_route(7, b);
    response(
        call(
            &h,
            "transform.declare",
            json!({"session":"cc","harness":"claude-code","params":plan(),"preset":"head"}),
        )
        .await,
    );
    let mut setup_params = json!({"session":"cc","harness":"claude-code","request_id":"setup","params":plan(),"preset":"head","model":"fixture","composition":{},"lineage_id":"L","now":1});
    if let Some(window) = window {
        setup_params["context_window"] = json!(window);
    }
    response(call(&h, "compaction.setup", setup_params).await);
    let mut status = step(r#"{"role":"user","content":"history"}"#);
    if let Some(window) = window {
        status["context_window"] = json!(window);
    } else {
        status.as_object_mut().unwrap().remove("context_window");
    }
    status["messages"].as_array_mut().unwrap().push(json!({"mid":"tail","ordinal":1,"message":{"role":"user","content":"tail"},"raw_message":r#"{"role":"user","content":"tail"}"#}));
    status["newest"] = json!({"mid":"tail","ordinal":1});
    status["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    status["geometry"] = json!({"usable_soft":50000,"usable_hard":60000,"absolute_wall":100000,"derivation":"gateway"});
    let first = response(call(&h, "compaction.step", status.clone()).await);
    let mut answers = vec![first.clone()];
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
        answers.push(answer);
    }
    answers
}

#[tokio::test(flavor = "current_thread")]
async fn cc_absent_context_window_uses_attested_geometry_through_fold_identically() {
    let known = tempfile::tempdir().unwrap();
    let absent = tempfile::tempdir().unwrap();
    let expected = fold_with_catalog(known.path(), known.path(), Some(100000)).await;
    let actual = fold_with_catalog(absent.path(), known.path(), None).await;
    assert_eq!(
        actual, expected,
        "geometry-only steps must preserve the full native answer"
    );
}

#[tokio::test]
async fn cc_missing_context_window_and_geometry_refuse_before_ingest() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let mut status = step(r#"{"role":"user","content":"history"}"#);
    status.as_object_mut().unwrap().remove("context_window");
    let outcome = call(&h, "compaction.step", status).await;
    assert!(
        matches!(outcome, HandlerOutcome::Error { code, message } if code == "invalid_params" && message.contains("context_window") && message.contains("geometry.absolute_wall"))
    );
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    assert!(h
        .store
        .get()
        .unwrap()
        .load_provider_messages(&key.store_key(), "L")
        .unwrap()
        .is_empty());
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

pub(super) fn validate_native_answer(
    answer: &Value,
    pins: &hooks::claude_code::ClaudeCodeCapabilities,
) {
    let principal = hooks::claude_code::PRINCIPAL;
    let lane =
        hooks::claude_code::ClaudeCodeLane::admit(principal, "first-step", Some(pins.clone()))
            .unwrap();
    let typed: compact::answer::StepAnswer = serde_json::from_value(answer.clone()).unwrap();
    typed
        .validate_claude_code(&lane, principal, "first-step")
        .unwrap();
}

async fn native_read(h: &McHandler, reference: &compact::view::ViewRef) -> String {
    let params = json!({"request_id":"read","view_id":reference.view_id,"version":reference.version,"sha256":reference.sha256,"byte_cursor":0});
    let bytes = h
        .provider_native_view_read(h.facade_binding(7).unwrap(), &params)
        .await
        .unwrap();
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(answer["answer"], "page");
    assert!(answer.get("next_byte_cursor").is_none());
    answer["bytes"].as_str().unwrap().into()
}

#[tokio::test]
async fn cc_first_head_scalar_is_verbatim_stable_then_folded() {
    first_head_sequence(
        r#"{ "content":"caf\u00e9 first user", "role":"user" }"#,
        0,
        true,
    )
    .await;
}

#[tokio::test]
async fn cc_first_head_blocks_are_verbatim_stable_then_folded() {
    first_head_sequence(r#"{ "role":"user", "content":[ {"type":"text", "text":"caf\u00e9 first user"}, {"type":"text","text":"second part"} ] }"#, 1, false).await;
}

async fn first_head_sequence(first_raw: &str, last_part: u64, cut_unfolded: bool) {
    let dir = tempfile::tempdir().unwrap();
    // Project docs exist only in this throwaway fixture, never in a live store.
    std::fs::write(
        dir.path().join("ARCHITECTURE.md"),
        "# Fixture\nfirst-step-doc-evidence\n",
    )
    .unwrap();
    let h = handler(dir.path(), thalamus());
    let mut b = binding(dir.path(), thalamus());
    b.config.memory_enabled = true;
    b.config.inject_docs = true;
    h.bind_route(7, b);
    let project = dir.path().to_string_lossy();
    h.store
        .get()
        .unwrap()
        .insert_memory(mc_store::InsertMemoryInput {
            project_path: &project,
            route_project_root: None,
            category: "knowledge",
            content: "first-step-memory-evidence",
            source_session_id: None,
            source_type: Some("tool"),
            importance: Some(70),
            expires_at: None,
            metadata_json: None,
            now_ms: 1,
        })
        .unwrap();
    let pins = h.native_pins();
    let declare = json!({"preset":"head","params":plan(),"composition":{},"claude_code":pins});
    h.admit_native_plan(
        7,
        &h.facade_binding(7).unwrap(),
        "transform.declare",
        &declare,
    )
    .await
    .unwrap();
    let setup = json!({"session":"cc","harness":"claude-code","request_id":"setup","preset":"head","params":plan(),"composition":{},"claude_code":pins,"model":"fixture","context_window":100000,"lineage_id":"L","now":1});
    let bytes = h
        .provider_setup(h.facade_binding(7).unwrap(), &setup)
        .await
        .unwrap();
    let ready: Value = serde_json::from_slice(&bytes).unwrap();
    let typed: compact::setup::SetupAnswer = serde_json::from_value(ready.clone()).unwrap();
    assert!(matches!(typed, compact::setup::SetupAnswer::Ready { .. }));
    assert_eq!(ready["initial"]["range"], json!({"from":0,"to":0}));
    assert_eq!(ready["initial"]["replacement"], json!([]));
    assert!(ready["initial"].get("raw_view").is_none());
    validate_native_answer(
        &json!({"answer":"compaction_message","request_id":"setup","compaction":ready["initial"]}),
        &pins,
    );

    let mut status = step(first_raw);
    let tail_raw = r#"{ "role":"user", "content":"retained live tail" }"#;
    status["messages"].as_array_mut().unwrap().push(json!({"mid":"tail","ordinal":1,"message":serde_json::from_str::<Value>(tail_raw).unwrap(),"raw_message":tail_raw}));
    status["newest"] = json!({"mid":"tail","ordinal":1});
    let bytes = h
        .provider_step(h.facade_binding(7).unwrap(), &status)
        .await
        .unwrap();
    let first: Value = serde_json::from_slice(&bytes).unwrap();
    validate_native_answer(&first, &pins);
    assert_eq!(first["answer"], "compaction_message");
    assert_eq!(first["compaction"]["range"], json!({"from":0,"to":1}));
    assert_eq!(
        first["coverage"],
        json!({"end_mid":"m","ordinal":0,"endpoint":{"message_id":"m","part_index":last_part}})
    );
    let frozen: compact::view::FrozenView =
        serde_json::from_value(first["compaction"]["raw_view"].clone()).unwrap();
    assert_eq!(frozen.lineage_id, "L");
    assert_eq!(frozen.profile, pins.profile);
    assert_eq!(frozen.profile_generation, pins.profile_generation);
    assert_eq!(frozen.provider_generation, pins.provider_generation);
    assert_eq!(
        frozen.view.version,
        first["compaction"]["version"].as_u64().unwrap()
    );
    let prefix = native_read(&h, &frozen.view).await;
    assert!(prefix.ends_with(&format!(",{first_raw}]")));
    assert!(String::from_utf8(bytes)
        .unwrap()
        .contains(&format!(",{first_raw}]")));
    assert!(prefix.contains("first-step-memory-evidence"));
    assert!(prefix.contains("first-step-doc-evidence"));
    assert!(!prefix.contains("retained live tail"));
    assert_eq!(frozen.retained_tail, Some(vec![]));
    assert_eq!(
        native_read(&h, frozen.cut_replacement_ref.as_ref().unwrap()).await,
        prefix
    );
    status["last_applied"] = json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    if cut_unfolded {
        // The covered original can leave the host transcript: the cut prefix
        // already carries that same message verbatim until a summary supersedes it.
        status["messages"].as_array_mut().unwrap().remove(0);
        status["after_ordinal"] = json!(1);
    }
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    assert_eq!(
        store
            .load_meta(&key.engine_key())
            .unwrap()
            .meta
            .coverage_ordinal,
        None
    );
    for ordinal in 2..=3 {
        let raw = format!(r#"{{ "role":"user", "content":"later turn {ordinal}" }}"#);
        status["messages"].as_array_mut().unwrap().push(json!({"mid":format!("later-{ordinal}"),"ordinal":ordinal,"message":serde_json::from_str::<Value>(&raw).unwrap(),"raw_message":raw}));
        status["newest"] = json!({"mid":format!("later-{ordinal}"),"ordinal":ordinal});
        status["request_id"] = json!(format!("no-fold-{ordinal}"));
        let bytes = h
            .provider_step(h.facade_binding(7).unwrap(), &status)
            .await
            .unwrap();
        let answer: Value = serde_json::from_slice(&bytes).unwrap();
        validate_native_answer(&answer, &pins);
        assert_eq!(answer["answer"], "noop");
        assert_eq!(native_read(&h, &frozen.view).await, prefix);
        assert_eq!(
            store
                .load_meta(&key.engine_key())
                .unwrap()
                .meta
                .coverage_ordinal,
            None
        );
    }
    store
        .replace_compartments(
            &key.engine_key(),
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 0,
                end_message_id: format!("m#{last_part}"),
                title: "first user fold".into(),
                content: "real-fold-evidence".into(),
                p1: Some("real-fold-evidence".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    status["request_id"] = json!("fold");
    status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    status["estimate"]["request_tokens"] = json!(80000);
    let bytes = h
        .provider_step(h.facade_binding(7).unwrap(), &status)
        .await
        .unwrap();
    let folded: Value = serde_json::from_slice(&bytes).unwrap();
    assert_native_range_endpoint(&folded, &status);
    validate_native_answer(&folded, &pins);
    assert_eq!(folded["answer"], "compaction_message");
    assert_eq!(folded["compaction"]["range"], json!({"from":0,"to":4}));
    assert!(folded.to_string().contains("real-fold-evidence"));
    let folded_view: compact::view::FrozenView =
        serde_json::from_value(folded["compaction"]["raw_view"].clone()).unwrap();
    let folded_raw = native_read(&h, &folded_view.view).await;
    assert!(!folded_raw.contains(first_raw));
    assert!(folded_raw.contains(tail_raw));
    let cut = native_read(&h, folded_view.cut_replacement_ref.as_ref().unwrap()).await;
    assert!(cut.contains("real-fold-evidence"));
    assert_eq!(cut, folded_raw);
    let retained = folded_view.retained_tail.as_ref().unwrap();
    assert_eq!(
        retained
            .iter()
            .map(|part| part.engine_handle.as_str())
            .collect::<Vec<_>>(),
        Vec::<&str>::new()
    );
    assert_eq!(
        store
            .load_meta(&key.engine_key())
            .unwrap()
            .meta
            .coverage_ordinal,
        Some(0)
    );

    // The full-range cut installs the re-rendered tail as well as the summary.
    // No original in the replaced range remains in the host transcript.
    status["messages"].as_array_mut().unwrap().clear();
    status["after_ordinal"] = json!(4);
    status["last_applied"] = json!({"compaction_id":folded["compaction"]["compaction_id"],"version":folded["compaction"]["version"]});
    status.as_object_mut().unwrap().remove("prefix_rebuilding");
    status["estimate"]["request_tokens"] = json!(1);
    status["request_id"] = json!("after-hook-cut");
    let bytes = h
        .provider_step(h.facade_binding(7).unwrap(), &status)
        .await
        .unwrap();
    let after_cut: Value = serde_json::from_slice(&bytes).unwrap();
    validate_native_answer(&after_cut, &pins);
    assert_eq!(after_cut["answer"], "noop");
    assert_eq!(
        native_read(&h, folded_view.cut_replacement_ref.as_ref().unwrap()).await,
        cut
    );
    assert_eq!(native_read(&h, &frozen.view).await, prefix);
}

const FORM_SCALAR: &str = r#"{ "role":"system", "content":"cache marker text" }"#;
const FORM_BLOCKS: &str =
    r#"{ "role":"system", "content":[{"type":"text","text":"cache marker text"}] }"#;

#[tokio::test]
async fn cc_known_mid_string_then_blocks_keeps_first_bytes() {
    form_flip_sequence(FORM_SCALAR, FORM_BLOCKS).await;
}

#[tokio::test]
async fn cc_known_mid_blocks_then_string_keeps_first_bytes() {
    form_flip_sequence(FORM_BLOCKS, FORM_SCALAR).await;
}

async fn form_flip_sequence(first: &str, flipped: &str) {
    for tags_on in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler_with_admission_tags(dir.path(), tags_on);
        setup(&h).await;
        response(call(&h, "compaction.step", step(first)).await);
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        let original = store.load_provider_messages(&key.store_key(), "L").unwrap();
        for (turn, raw) in [flipped, first, flipped, first].into_iter().enumerate() {
            let mut status = step(raw);
            status["request_id"] = json!(format!("flip-{turn}"));
            // `message` can describe the first-stored form while `raw_message`
            // carries the form received from Claude Code on this turn.
            status["messages"][0]["message"] = serde_json::from_str::<Value>(first).unwrap();
            response(call(&h, "compaction.step", status).await);
            assert_eq!(
                store.load_provider_messages(&key.store_key(), "L").unwrap(),
                original
            );
        }
        let scalar = r#"{ "role":"assistant", "content":"hook text" }"#;
        let blocks = r#"{ "role":"assistant", "content":[{"type":"text","text":"hook text"}] }"#;
        let hook_first = if first == FORM_SCALAR { scalar } else { blocks };
        let hook_flip = if first == FORM_SCALAR { blocks } else { scalar };
        let mut first_answer = None;
        for (turn, raw) in [hook_first, hook_flip, hook_first, hook_flip]
            .into_iter()
            .enumerate()
        {
            let hook = json!({"session":"cc","harness":"claude-code","lineage_id":"L","step_id":format!("hook-{turn}"),"params":plan(),"subject_mid":"hook","subject_ordinal":1,"message":serde_json::from_str::<Value>(hook_first).unwrap(),"raw_message":raw,"hook":"post_assistant","blocks":["hook text"]});
            let answer = response(call(&h, "transform.hook", hook).await);
            assert_admission_answer(&answer, tags_on, &[(0, 1)]);
            if let Some(first) = &first_answer {
                assert_eq!(&answer, first);
            } else {
                first_answer = Some(answer);
            }
            let mut status = step(first);
            status["request_id"] = json!(format!("after-hook-{turn}"));
            status["messages"].as_array_mut().unwrap().push(json!({"mid":"hook","ordinal":1,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw}));
            status["newest"] = json!({"mid":"hook","ordinal":1});
            response(call(&h, "compaction.step", status).await);
            let held = store.load_provider_messages(&key.store_key(), "L").unwrap();
            assert_eq!(held[0], original[0]);
            assert_eq!(
                serde_json::from_slice::<Value>(&held[1].message_bytes).unwrap()["raw_message"],
                hook_first
            );
            let served = if tags_on {
                hook_first.replacen(r#""hook text""#, r#""§1§ hook text""#, 1)
            } else {
                hook_first.into()
            };
            assert_stored_and_served_raw(&h, "hook", hook_first, &served);
        }
    }
}

#[tokio::test]
async fn cc_known_mid_non_equivalent_changes_remain_conflicts() {
    for tags_on in [false, true] {
        for first in [FORM_SCALAR, FORM_BLOCKS] {
            let dir = tempfile::tempdir().unwrap();
            let h = handler_with_admission_tags(dir.path(), tags_on);
            setup(&h).await;
            response(call(&h, "compaction.step", step(first)).await);
            let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
            let store = h.store.get().unwrap();
            let original = store.load_provider_messages(&key.store_key(), "L").unwrap();
            for raw in [
                r#"{ "role":"system", "content":"changed text" }"#,
                r#"{ "role":"user", "content":"cache marker text" }"#,
                r#"{ "role":"system", "content":[{"type":"text","text":"cache marker text","extra":true}] }"#,
                r#"{ "role":"system", "content":[{"type":"text","text":"cache marker text"},{"type":"text","text":""}] }"#,
                r#"{ "role":"system", "content":"cache marker text", "extra":true }"#,
                if first == FORM_SCALAR {
                    r#"{ "content":[{"type":"text","text":"cache marker text"}], "role":"system" }"#
                } else {
                    r#"{ "content":"cache marker text", "role":"system" }"#
                },
                if first == FORM_SCALAR {
                    r#"{ "role":"system",  "content":[{"type":"text","text":"cache marker text"}] }"#
                } else {
                    r#"{ "role":"system",  "content":"cache marker text" }"#
                },
                if first == FORM_SCALAR {
                    r#"{"role":"system","content":"cache marker text"}"#
                } else {
                    r#"{"role":"system","content":[{"type":"text","text":"cache marker text"}]}"#
                },
            ] {
                assert_eq!(
                    code(call(&h, "compaction.step", step(raw)).await),
                    "invalid_params"
                );
                assert_eq!(
                    store.load_provider_messages(&key.store_key(), "L").unwrap()[0],
                    original[0]
                );
            }
            let hook_raw = r#"{ "role":"assistant", "content":"original hook" }"#;
            let mut hook = json!({"session":"cc","harness":"claude-code","lineage_id":"L","step_id":"hook-original","params":plan(),"subject_mid":"hook","subject_ordinal":1,"message":serde_json::from_str::<Value>(hook_raw).unwrap(),"raw_message":hook_raw,"hook":"post_assistant","blocks":["original hook"]});
            assert_admission_answer(
                &response(call(&h, "transform.hook", hook.clone()).await),
                tags_on,
                &[(0, 1)],
            );
            let held = store.load_provider_messages(&key.store_key(), "L").unwrap();
            let changed = r#"{ "role":"assistant", "content":[{"type":"text","text":"original hook","extra":true}] }"#;
            hook["message"] = serde_json::from_str::<Value>(changed).unwrap();
            hook["raw_message"] = json!(changed);
            assert_eq!(
                code(call(&h, "transform.hook", hook).await),
                "invalid_params"
            );
            assert_eq!(
                store.load_provider_messages(&key.store_key(), "L").unwrap(),
                held
            );
            let served = if tags_on {
                hook_raw.replacen(r#""original hook""#, r#""§1§ original hook""#, 1)
            } else {
                hook_raw.into()
            };
            assert_stored_and_served_raw(&h, "hook", hook_raw, &served);
        }
    }
}

#[test]
fn cc_form_flip_identity_fingerprints_match_without_rewriting_raw() {
    let project = |raw: &str| {
        let entry = compact::status::StatusMessage {
            raw_message: None,
            ordinal: 0,
            mid: "m".into(),
            message: super::codec_claude_code::from_wire(
                &serde_json::from_str::<Value>(raw).unwrap(),
                Some(raw),
            )
            .unwrap(),
        };
        let ingress = super::codec_claude_code::decode_message(&entry).unwrap();
        let projected = ck_wire::project_messages(std::slice::from_ref(&ingress)).unwrap();
        assert_eq!(super::codec_claude_code::render(&ingress.ck).unwrap(), raw);
        projected.identity_by_mid
    };
    assert_eq!(project(FORM_SCALAR), project(FORM_BLOCKS));
}

async fn native_setup_for_lineage(h: &McHandler, lineage: &str, descent: Option<Value>) -> Value {
    let pins = h.native_pins();
    let declare = json!({"preset":"head","params":plan(),"composition":{},"claude_code":pins});
    h.admit_native_plan(
        7,
        &h.facade_binding(7).unwrap(),
        "transform.declare",
        &declare,
    )
    .await
    .unwrap();
    let mut request = json!({"session":h.facade_binding(7).unwrap().session,"harness":"claude-code","request_id":format!("setup-{lineage}"),"preset":"head","params":plan(),"composition":{},"claude_code":pins,"model":"fixture","context_window":100000,"lineage_id":lineage,"now":1});
    if let Some(descent) = descent {
        request["descends_from"] = descent;
    }
    let bytes = h
        .provider_setup(h.facade_binding(7).unwrap(), &request)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn native_step(h: &McHandler, status: &Value) -> Value {
    let bytes = h
        .provider_step(h.facade_binding(7).unwrap(), status)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn cc_covered_form_flip_keeps_frozen_prefix_and_does_not_emit_unfrozen_tail() {
    for (first, flipped) in [
        (
            r#"{ "role":"user", "content":"first user" }"#,
            r#"{ "role":"user", "content":[{"type":"text","text":"first user"}] }"#,
        ),
        (
            r#"{ "role":"user", "content":[{"type":"text","text":"first user"}] }"#,
            r#"{ "role":"user", "content":"first user" }"#,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path(), thalamus());
        native_setup_for_lineage(&h, "L", None).await;
        let tail = r#"{ "role":"assistant", "content":"unfrozen tail" }"#;
        let tail_flip =
            r#"{ "role":"assistant", "content":[{"type":"text","text":"unfrozen tail"}] }"#;
        let mut status = step(first);
        status["messages"].as_array_mut().unwrap().push(json!({"mid":"tail","ordinal":1,"message":serde_json::from_str::<Value>(tail).unwrap(),"raw_message":tail}));
        status["newest"] = json!({"mid":"tail","ordinal":1});
        let answer = native_step(&h, &status).await;
        assert_eq!(answer["coverage"]["ordinal"], 0);
        let frozen: compact::view::FrozenView =
            serde_json::from_value(answer["compaction"]["raw_view"].clone()).unwrap();
        let prefix = native_read(&h, &frozen.view).await;
        assert!(prefix.ends_with(&format!(",{first}]")));
        assert!(!prefix.contains("unfrozen tail"));
        assert_eq!(frozen.retained_tail, Some(vec![]));
        status["last_applied"] = json!({"compaction_id":answer["compaction"]["compaction_id"],"version":answer["compaction"]["version"]});
        for (turn, raw) in [flipped, first, flipped].into_iter().enumerate() {
            status["messages"][0]["message"] = serde_json::from_str::<Value>(raw).unwrap();
            status["messages"][0]["raw_message"] = json!(raw);
            status["messages"][1]["message"] = serde_json::from_str::<Value>(tail_flip).unwrap();
            status["messages"][1]["raw_message"] = json!(tail_flip);
            status["request_id"] = json!(format!("covered-flip-{turn}"));
            assert_eq!(native_step(&h, &status).await["answer"], "noop");
            assert_eq!(native_read(&h, &frozen.view).await, prefix);
            assert_eq!(
                native_read(&h, frozen.cut_replacement_ref.as_ref().unwrap()).await,
                prefix
            );
        }
        let repeated_setup = native_setup_for_lineage(&h, "L", None).await;
        let repeated: compact::view::FrozenView =
            serde_json::from_value(repeated_setup["initial"]["raw_view"].clone()).unwrap();
        assert_eq!(native_read(&h, &repeated.view).await, prefix);
        assert!(!repeated_setup.to_string().contains("unfrozen tail"));
    }
}

#[tokio::test]
async fn cc_setup_unrelated_lineage_starts_fresh_but_descendant_keeps_applied_view() {
    for descendant in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path(), thalamus());
        native_setup_for_lineage(&h, "L", None).await;
        let raw = r#"{ "role":"user", "content":"old lineage original" }"#;
        let hook = json!({"session":"cc","harness":"claude-code","lineage_id":"L","step_id":"old-hook","params":plan(),"subject_mid":"m","subject_ordinal":0,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,"hook":"pre_user","blocks":["old lineage original"]});
        assert_eq!(
            response(call(&h, "transform.hook", hook).await)["answer"],
            "pass"
        );
        let mut status = step(raw);
        let produced = native_step(&h, &status).await;
        assert_eq!(produced["compaction"]["range"], json!({"from":0,"to":1}));
        status["last_applied"] = json!({"compaction_id":produced["compaction"]["compaction_id"],"version":produced["compaction"]["version"]});
        status["request_id"] = json!("ack-old");
        assert_eq!(native_step(&h, &status).await["answer"], "noop");
        let old_frozen: compact::view::FrozenView =
            serde_json::from_value(produced["compaction"]["raw_view"].clone()).unwrap();
        let old_bytes = native_read(&h, &old_frozen.view).await;
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        let old_row = store
            .load_provider_view(&key.store_key(), old_frozen.view.version)
            .unwrap()
            .unwrap();
        let descent = descendant.then(|| json!({"lineage_id":"L","through_ordinal":0}));
        let missing = native_setup_for_lineage(
            &h,
            "missing",
            Some(json!({"lineage_id":"L","through_ordinal":999})),
        )
        .await;
        assert_eq!(missing["answer"], "refuse");
        assert_eq!(missing["code"], "history_unreadable");
        assert_eq!(native_read(&h, &old_frozen.view).await, old_bytes);
        let ready = native_setup_for_lineage(&h, "new", descent.clone()).await;
        assert!(
            ready["initial"]["version"].as_u64().unwrap()
                > produced["compaction"]["version"].as_u64().unwrap()
        );
        if descendant {
            assert_eq!(
                ready["initial"]["compaction_id"],
                produced["compaction"]["compaction_id"]
            );
            assert_eq!(
                ready["initial"]["replacement"],
                produced["compaction"]["replacement"]
            );
            let frozen: compact::view::FrozenView =
                serde_json::from_value(ready["initial"]["raw_view"].clone()).unwrap();
            assert_eq!(frozen.lineage_id, "new");
            assert_eq!(native_read(&h, &frozen.view).await, old_bytes);
        } else {
            assert_ne!(
                ready["initial"]["compaction_id"],
                produced["compaction"]["compaction_id"]
            );
            assert_eq!(ready["initial"]["range"], json!({"from":0,"to":0}));
            assert_eq!(ready["initial"]["replacement"], json!([]));
            assert!(ready["initial"].get("raw_view").is_none());
            assert!(store
                .load_provider_hook_answers(&key.store_key())
                .unwrap()
                .iter()
                .all(|answer| answer.state == "burned"));
            let engine = store.load(&key.engine_key()).unwrap();
            assert!(!engine.meta.initialized);
            assert!(engine.core.frozen_units.is_empty());
        }
        let new_raw = r#"{ "role":"user", "content":"new lineage original" }"#;
        let mut next = step(new_raw);
        next["lineage_id"] = json!("new");
        next["request_id"] = json!("new-step");
        next["messages"][0]["mid"] = json!("new-mid");
        next["messages"][0]["ordinal"] = json!(if descendant { 1 } else { 0 });
        next["newest"] = json!({"mid":"new-mid","ordinal":if descendant {1} else {0}});
        next["last_applied"] = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
        if let Some(descent) = descent {
            assert_eq!(descent["lineage_id"], "L");
            let flipped =
                r#"{ "role":"user", "content":[{"type":"text","text":"old lineage original"}] }"#;
            next["messages"].as_array_mut().unwrap().insert(0, json!({"mid":"m","ordinal":0,"message":serde_json::from_str::<Value>(flipped).unwrap(),"raw_message":flipped}));
        }
        let next_answer = native_step(&h, &next).await;
        if descendant {
            assert_eq!(next_answer["answer"], "noop");
        } else {
            assert_eq!(next_answer["answer"], "compaction_message");
            assert!(next_answer.to_string().contains("new lineage original"));
            assert!(!next_answer.to_string().contains("old lineage original"));
        }
        assert_eq!(
            store
                .load_provider_view(&key.store_key(), old_frozen.view.version)
                .unwrap()
                .unwrap()
                .replacement_json,
            old_row.replacement_json
        );
        let read = json!({"request_id":"old-read","view_id":old_frozen.view.view_id,"version":old_frozen.view.version,"sha256":old_frozen.view.sha256,"byte_cursor":0});
        let bytes = h
            .provider_native_view_read(h.facade_binding(7).unwrap(), &read)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["answer"],
            "refuse"
        );
    }
}

#[tokio::test]
async fn cc_setup_new_root_next_step_proceeds_without_old_view() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    native_setup_for_lineage(&h, "L", None).await;
    let mut status = step(r#"{"role":"user","content":"old root"}"#);
    let first = native_step(&h, &status).await;
    status["last_applied"] = json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    status["request_id"] = json!("old-ack");
    assert_eq!(native_step(&h, &status).await["answer"], "noop");
    let ready = native_setup_for_lineage(&h, "unrelated", None).await;
    let mut next = step(r#"{"role":"user","content":"new root"}"#);
    next["lineage_id"] = json!("unrelated");
    next["messages"][0]["mid"] = json!("new-mid");
    next["newest"]["mid"] = json!("new-mid");
    next["last_applied"] = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
    let answer = native_step(&h, &next).await;
    assert_eq!(answer["answer"], "compaction_message");
    assert!(answer.to_string().contains("new root"));
    assert!(!answer.to_string().contains("old root"));
}

#[tokio::test]
async fn cc_setup_unknown_or_mismatched_parent_is_refused_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    identity_parent_after_empty_fork(&h).await;
    let pins = h.native_pins();
    let request = json!({"session":"fresh-provider-session","harness":"claude-code","request_id":"unknown-parent","preset":"head","params":plan(),"composition":{},"claude_code":pins,"model":"fixture","context_window":100000,"lineage_id":"child","descends_from":{"lineage_id":"unknown","through_ordinal":0},"now":1});
    let answer: Value = serde_json::from_slice(
        &h.provider_setup(h.facade_binding(7).unwrap(), &request)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(answer["code"], "history_unreadable");
    let ready = native_setup_for_lineage(
        &h,
        "child",
        Some(json!({"lineage_id":"parent","through_ordinal":0})),
    )
    .await;
    assert_eq!(ready["answer"], "ready");
    let mut changed = request.clone();
    changed["descends_from"] = json!({"lineage_id":"parent","through_ordinal":1});
    let result = h
        .provider_setup(h.facade_binding(7).unwrap(), &changed)
        .await;
    assert!(
        matches!(result, Err(HandlerOutcome::ErrorWithDetail { ref code, ref detail, .. }) if code == "invalid_params" && detail["field"] == "lineage_id")
    );
    let mut status = step(r#"{"role":"user","content":"bad descent"}"#);
    status["session"] = json!("fresh-provider-session");
    status["lineage_id"] = json!("child");
    status["descends_from"] = json!({"lineage_id":"unknown","through_ordinal":0});
    let result = h.provider_step(h.facade_binding(7).unwrap(), &status).await;
    assert!(
        matches!(result, Err(HandlerOutcome::ErrorWithDetail { ref code, ref detail, .. }) if code == "invalid_params" && detail["field"] == "lineage_id")
    );
}

#[tokio::test]
async fn cc_identity_parent_retained_n_continuation_keeps_history_and_hook_ancestry() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    let parent = identity_parent_after_empty_fork(&h).await;
    let mut page = step(r#"{"role":"user","content":"retained one"}"#);
    page["session"] = json!("fresh-provider-session");
    page["lineage_id"] = json!("parent");
    page["messages"][0]["mid"] = json!("retained-1");
    page["messages"][0]["ordinal"] = json!(1);
    let raw = r#"{ "role":"assistant", "content":"retained two" }"#;
    page["messages"].as_array_mut().unwrap().push(json!({"mid":"retained-2","ordinal":2,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw}));
    let dropped = r#"{"role":"user","content":"discarded parent tail"}"#;
    page["messages"].as_array_mut().unwrap().push(json!({"mid":"discarded-3","ordinal":3,"message":serde_json::from_str::<Value>(dropped).unwrap(),"raw_message":dropped}));
    page["newest"] = json!({"mid":"discarded-3","ordinal":3});
    page["more"] = json!(true);
    assert_eq!(native_step(&h, &page).await["answer"], "wait");
    let hook = json!({"session":"fresh-provider-session","harness":"claude-code","lineage_id":"parent","step_id":"parent-served","params":plan(),"subject_mid":"discarded-3","subject_ordinal":3,"message":serde_json::from_str::<Value>(dropped).unwrap(),"raw_message":dropped,"hook":"pre_user","blocks":["discarded parent tail"],"served_through_ordinal":3});
    assert_eq!(
        response(call(&h, "transform.hook", hook).await)["answer"],
        "pass"
    );
    let ready = native_setup_for_lineage(
        &h,
        "child-n",
        Some(json!({"lineage_id":"parent","through_ordinal":2})),
    )
    .await;
    assert!(
        ready["initial"]["version"].as_u64().unwrap()
            > parent["initial"]["version"].as_u64().unwrap()
    );
    let key = Key::new(
        &h.facade_binding(7).unwrap(),
        "fresh-provider-session",
        "claude-code",
    )
    .unwrap();
    let store = h.store.get().unwrap();
    let parent_messages = store
        .load_provider_messages(&key.store_key(), "parent")
        .unwrap();
    assert_eq!(parent_messages.len(), 4);
    assert_eq!(
        store
            .load_provider_messages(&key.store_key(), "child-n")
            .unwrap(),
        parent_messages[..3]
    );
    let lineage = store
        .load_provider_lineage(&key.store_key(), "child-n")
        .unwrap()
        .unwrap();
    assert_eq!(lineage.first_ordinal, 3);
    assert_eq!(lineage.descends_from.as_deref(), Some("parent"));
    let conversation = store
        .load_provider_conversation(&key.store_key())
        .unwrap()
        .unwrap();
    assert_eq!(conversation.cursor_frontier, 3);
    assert_eq!(conversation.served_through_ordinal, Some(2));
    let raw = r#"{"role":"user","content":"child hook"}"#;
    let hook = json!({"session":"fresh-provider-session","harness":"claude-code","lineage_id":"child-n","step_id":"child-hook","params":plan(),"subject_mid":"child-3","subject_ordinal":3,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,"hook":"pre_user","blocks":["child hook"]});
    assert_eq!(
        response(call(&h, "transform.hook", hook).await)["answer"],
        "pass"
    );
    let mut status = step(raw);
    status["session"] = json!("fresh-provider-session");
    status["lineage_id"] = json!("child-n");
    status["messages"][0]["mid"] = json!("child-3");
    status["messages"][0]["ordinal"] = json!(3);
    status["newest"] = json!({"mid":"child-3","ordinal":3});
    status["served_through_ordinal"] = json!(2);
    status["last_applied"] = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
    let answer = native_step(&h, &status).await;
    assert!(matches!(
        answer["answer"].as_str(),
        Some("noop" | "compaction_message")
    ));
    status["served_through_ordinal"] = json!(3);
    status["request_id"] = json!("child-n-served");
    native_step(&h, &status).await;
    native_setup_for_lineage(&h, "child-n", None).await;
    assert_eq!(
        store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap()
            .served_through_ordinal,
        Some(3)
    );
}

#[tokio::test]
async fn cc_legacy_identity_child_setup_refuses_missing_ancestry_then_repairs_on_setup() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    identity_parent_after_empty_fork(&h).await;
    let key = Key::new(
        &h.facade_binding(7).unwrap(),
        "fresh-provider-session",
        "claude-code",
    )
    .unwrap();
    let store = h.store.get().unwrap();
    let original = store
        .load_provider_view(&key.store_key(), 1)
        .unwrap()
        .unwrap();
    let mut legacy_view: Value = serde_json::from_str(&original.replacement_json).unwrap();
    legacy_view["engine"]["version"] = json!(4);
    legacy_view["engine"]["range"]["lineage_id"] = json!("legacy-child");
    legacy_view["wire"]["version"] = json!(4);
    let old_row = mc_store::provider_records::ProviderView {
        version: 4,
        lineage_id: "legacy-child".into(),
        replacement_json: legacy_view.to_string(),
        ..original.clone()
    };
    store
        .save_provider_view(&key.store_key(), &old_row)
        .unwrap();
    let mut conversation = store
        .load_provider_conversation(&key.store_key())
        .unwrap()
        .unwrap();
    let mut setup: Value =
        serde_json::from_str(conversation.setup_json.as_deref().unwrap()).unwrap();
    setup["setup"]["state"]["version_high_water"] = json!(4);
    for field in ["applied", "produced"] {
        setup[field]["version"] = json!(4);
        setup[field]["range"]["lineage_id"] = json!("legacy-child");
    }
    conversation.setup_json = Some(setup.to_string());
    conversation.lineage_id = "legacy-child".into();
    conversation.version_high_water = 4;
    store
        .save_provider_conversation(&key.store_key(), &conversation)
        .unwrap();
    // Simulate a persisted setup that published an identity [0,0) view for the
    // new lineage ID without saving its parent link.
    assert!(store
        .load_provider_lineage(&key.store_key(), "legacy-child")
        .unwrap()
        .is_none());
    let raw = r#"{"role":"user","content":"legacy child tail"}"#;
    let mut status = step(raw);
    status["session"] = json!("fresh-provider-session");
    status["lineage_id"] = json!("legacy-child");
    status["messages"][0]["mid"] = json!("legacy-tail");
    status["messages"][0]["ordinal"] = json!(1);
    status["newest"] = json!({"mid":"legacy-tail","ordinal":1});
    let result = h.provider_step(h.facade_binding(7).unwrap(), &status).await;
    assert!(
        matches!(result, Err(HandlerOutcome::ErrorWithDetail { ref code, ref detail, .. }) if code == "invalid_params" && detail["field"] == "lineage_id")
    );
    let ready = native_setup_for_lineage(
        &h,
        "legacy-child",
        Some(json!({"lineage_id":"parent","through_ordinal":0})),
    )
    .await;
    assert_eq!(ready["initial"]["version"], 5);
    assert_eq!(ready["initial"]["range"], json!({"from":0,"to":0}));
    assert_eq!(ready["initial"]["replacement"], json!([]));
    assert!(ready["initial"].get("raw_view").is_none());
    assert_eq!(
        store
            .load_provider_view(&key.store_key(), 4)
            .unwrap()
            .unwrap()
            .replacement_json,
        old_row.replacement_json
    );
    assert_eq!(
        store
            .load_provider_view(&key.store_key(), 1)
            .unwrap()
            .unwrap()
            .replacement_json,
        original.replacement_json
    );
    status["last_applied"] = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
    let answer = native_step(&h, &status).await;
    assert!(matches!(
        answer["answer"].as_str(),
        Some("noop" | "compaction_message")
    ));
}

async fn late_identity_parent_descent(first_hook: bool, retained: u64) {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    identity_parent_after_empty_fork(&h).await;
    if retained > 1 {
        let mut page = step(r#"{"role":"user","content":"retained parent text"}"#);
        page["session"] = json!("fresh-provider-session");
        page["lineage_id"] = json!("parent");
        let template = page["messages"][0].clone();
        page["messages"] = json!((1..=retained)
            .map(|ordinal| {
                let mut message = template.clone();
                message["ordinal"] = json!(ordinal);
                message["mid"] = json!(format!("parent-{ordinal}"));
                message
            })
            .collect::<Vec<_>>());
        page["newest"] = json!({"mid":format!("parent-{retained}"),"ordinal":retained});
        page["more"] = json!(true);
        assert_eq!(native_step(&h, &page).await["answer"], "wait");
    }
    let key = Key::new(
        &h.facade_binding(7).unwrap(),
        "fresh-provider-session",
        "claude-code",
    )
    .unwrap();
    let store = h.store.get().unwrap();
    let parent_messages = store
        .load_provider_messages(&key.store_key(), "parent")
        .unwrap();
    assert_eq!(
        store
            .load_provider_view(&key.store_key(), 1)
            .unwrap()
            .unwrap()
            .range_to,
        0
    );

    // The pinned setup type has no descends_from field. A host using that type
    // must send its previous transcript lineage and last retained ordinal on
    // its first step or hook instead.
    let ready = native_setup_for_lineage(&h, "late-child", None).await;
    assert_eq!(ready["initial"]["version"], 4);
    assert_eq!(ready["initial"]["range"], json!({"from":0,"to":0}));
    let identity = store
        .load_provider_view(&key.store_key(), 4)
        .unwrap()
        .unwrap();
    let root = store
        .load_provider_lineage(&key.store_key(), "late-child")
        .unwrap()
        .unwrap();
    assert_eq!(root.descends_from, None);
    assert!(store
        .load_provider_messages(&key.store_key(), "late-child")
        .unwrap()
        .is_empty());
    let descent = json!({"lineage_id":"parent","through_ordinal":retained - 1});
    let raw = r#"{"role":"user","content":"late child text"}"#;
    if first_hook {
        let hook = json!({"session":"fresh-provider-session","harness":"claude-code","lineage_id":"late-child","descends_from":descent,"step_id":"late-first-hook","params":plan(),"subject_mid":"late-mid","subject_ordinal":retained,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,"hook":"pre_user","blocks":["late child text"]});
        let outcome = call(&h, "transform.hook", hook).await;
        assert!(
            matches!(outcome, HandlerOutcome::Response(_)),
            "first hook: {outcome:?}"
        );
        assert_eq!(response(outcome)["answer"], "pass");
    }
    let mut status = step(raw);
    status["session"] = json!("fresh-provider-session");
    status["lineage_id"] = json!("late-child");
    status["messages"][0]["mid"] = json!("late-mid");
    status["messages"][0]["ordinal"] = json!(retained);
    status["newest"] = json!({"mid":"late-mid","ordinal":retained});
    status["last_applied"] = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
    if !first_hook {
        status["descends_from"] = descent.clone();
    }
    let result = h.provider_step(h.facade_binding(7).unwrap(), &status).await;
    assert!(
        result.is_ok(),
        "setup without ancestry, first step: {result:?}"
    );
    let answer: Value = serde_json::from_slice(&result.unwrap()).unwrap();
    assert!(matches!(
        answer["answer"].as_str(),
        Some("noop" | "compaction_message")
    ));
    if answer["answer"] == "compaction_message" {
        assert!(answer["compaction"]["version"].as_u64().unwrap() > 4);
    }
    let lineage = store
        .load_provider_lineage(&key.store_key(), "late-child")
        .unwrap()
        .unwrap();
    assert_eq!(lineage.descends_from.as_deref(), Some("parent"));
    assert_eq!(lineage.through_ordinal, Some(retained - 1));
    assert_eq!(lineage.first_ordinal, retained);
    let messages = store
        .load_provider_messages(&key.store_key(), "late-child")
        .unwrap();
    assert_eq!(
        &messages[..retained as usize],
        &parent_messages[..retained as usize]
    );
    assert_eq!(messages.len(), retained as usize + 1);
    assert_eq!(
        store
            .provider_frontier(&key.store_key(), "late-child")
            .unwrap(),
        retained + 1
    );
    assert_eq!(
        store
            .load_provider_view(&key.store_key(), 4)
            .unwrap()
            .unwrap()
            .replacement_json,
        identity.replacement_json
    );
    status["descends_from"] = descent;
    status["request_id"] = json!("repeat-descent");
    native_step(&h, &status).await;
    status.as_object_mut().unwrap().remove("descends_from");
    status["request_id"] = json!("omit-descent");
    native_step(&h, &status).await;
    status["descends_from"] = json!({"lineage_id":"parent","through_ordinal":retained});
    let result = h.provider_step(h.facade_binding(7).unwrap(), &status).await;
    assert!(
        matches!(result, Err(HandlerOutcome::ErrorWithDetail { ref code, ref detail, .. }) if code == "invalid_params" && detail["field"] == "lineage_id")
    );
}

#[tokio::test]
async fn cc_setup_without_parent_first_step_establishes_identity_parent_descent() {
    late_identity_parent_descent(false, 1).await;
}

#[tokio::test]
async fn cc_setup_without_parent_first_step_retains_n_parent_messages() {
    late_identity_parent_descent(false, 3).await;
}

#[tokio::test]
async fn cc_setup_without_parent_first_hook_establishes_identity_parent_descent() {
    late_identity_parent_descent(true, 1).await;
}

#[tokio::test]
async fn cc_setup_root_with_mismatched_prefix_or_nonidentity_view_refuses_reparenting() {
    for applied_view in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path(), thalamus());
        identity_parent_after_empty_fork(&h).await;
        native_setup_for_lineage(&h, "occupied", None).await;
        let key = Key::new(
            &h.facade_binding(7).unwrap(),
            "fresh-provider-session",
            "claude-code",
        )
        .unwrap();
        let store = h.store.get().unwrap();
        let raw = r#"{"role":"user","content":"occupied root"}"#;
        let mut hook = json!({"session":"fresh-provider-session","harness":"claude-code","lineage_id":"occupied","step_id":"occupied-hook","params":plan(),"subject_mid":"occupied-mid","subject_ordinal":0,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,"hook":"pre_user","blocks":["occupied root"]});
        if applied_view {
            // Normally a non-identity view requires messages. Isolate the view
            // fence with a temporary fixture so the message fence cannot mask it.
            let mut view = store
                .load_provider_view(&key.store_key(), 4)
                .unwrap()
                .unwrap();
            view.version = 5;
            view.range_to = 1;
            let mut frozen: Value = serde_json::from_str(&view.replacement_json).unwrap();
            frozen["engine"]["version"] = json!(5);
            frozen["engine"]["range"]["to"] = json!(1);
            frozen["wire"]["version"] = json!(5);
            frozen["wire"]["range"]["to"] = json!(1);
            view.replacement_json = frozen.to_string();
            store.save_provider_view(&key.store_key(), &view).unwrap();
        } else {
            assert_eq!(
                response(call(&h, "transform.hook", hook.clone()).await)["answer"],
                "pass"
            );
            assert_eq!(
                store
                    .load_provider_messages(&key.store_key(), "occupied")
                    .unwrap()
                    .len(),
                1
            );
        }
        let before = store
            .load_provider_lineage(&key.store_key(), "occupied")
            .unwrap()
            .unwrap();
        let mut status = step(raw);
        status["session"] = json!("fresh-provider-session");
        status["lineage_id"] = json!("occupied");
        status["messages"][0]["mid"] = json!("new-mid");
        status["messages"][0]["ordinal"] = json!(1);
        status["newest"] = json!({"mid":"new-mid","ordinal":1});
        status["descends_from"] = json!({"lineage_id":"parent","through_ordinal":0});
        let expected_field = if applied_view {
            "lineage_id"
        } else {
            "messages"
        };
        let result = h.provider_step(h.facade_binding(7).unwrap(), &status).await;
        assert!(
            matches!(result, Err(HandlerOutcome::ErrorWithDetail { ref code, ref detail, .. }) if code == "invalid_params" && detail["field"] == expected_field),
            "occupied root reparented: {result:?}"
        );
        hook["descends_from"] = status["descends_from"].clone();
        hook["subject_ordinal"] = json!(1);
        let outcome = call(&h, "transform.hook", hook).await;
        assert!(
            matches!(outcome, HandlerOutcome::ErrorWithDetail { ref code, ref detail, .. } if code == "invalid_params" && detail["field"] == expected_field),
            "occupied hook reparented: {outcome:?}"
        );
        assert_eq!(
            store
                .load_provider_lineage(&key.store_key(), "occupied")
                .unwrap()
                .unwrap(),
            before
        );
    }
}

#[tokio::test]
async fn cc_late_descent_refuses_unknown_parent_and_unheld_cut_without_adoption() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    identity_parent_after_empty_fork(&h).await;
    native_setup_for_lineage(&h, "late-child", None).await;
    let key = Key::new(
        &h.facade_binding(7).unwrap(),
        "fresh-provider-session",
        "claude-code",
    )
    .unwrap();
    let store = h.store.get().unwrap();
    let root = store
        .load_provider_lineage(&key.store_key(), "late-child")
        .unwrap()
        .unwrap();
    let raw = r#"{"role":"user","content":"late child text"}"#;
    let mut status = step(raw);
    status["session"] = json!("fresh-provider-session");
    status["lineage_id"] = json!("late-child");
    status["descends_from"] = json!({"lineage_id":"unknown","through_ordinal":0});
    let answer = native_step(&h, &status).await;
    assert_eq!(answer["code"], "history_unreadable");
    let hook = json!({"session":"fresh-provider-session","harness":"claude-code","lineage_id":"late-child","descends_from":status["descends_from"],"step_id":"unknown-hook","params":plan(),"subject_mid":"late-mid","subject_ordinal":1,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,"hook":"pre_user","blocks":["late child text"]});
    let outcome = call(&h, "transform.hook", hook).await;
    assert_eq!(code(outcome), "history_unreadable");
    status["descends_from"] = json!({"lineage_id":"parent","through_ordinal":999});
    let answer = native_step(&h, &status).await;
    assert_eq!(answer["code"], "history_unreadable");
    assert_eq!(answer["detail"]["history_gap_from"], 1);
    assert_eq!(
        store
            .load_provider_lineage(&key.store_key(), "late-child")
            .unwrap()
            .unwrap(),
        root
    );
    assert!(store
        .load_provider_messages(&key.store_key(), "late-child")
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn cc_late_descent_admission_rolls_back_on_conflicting_retained_message() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    identity_parent_after_empty_fork(&h).await;
    native_setup_for_lineage(&h, "late-child", None).await;
    let key = Key::new(
        &h.facade_binding(7).unwrap(),
        "fresh-provider-session",
        "claude-code",
    )
    .unwrap();
    let store = h.store.get().unwrap();
    let root = store
        .load_provider_lineage(&key.store_key(), "late-child")
        .unwrap()
        .unwrap();
    let mut status = step(r#"{"role":"user","content":"changed retained message"}"#);
    status["session"] = json!("fresh-provider-session");
    status["lineage_id"] = json!("late-child");
    status["descends_from"] = json!({"lineage_id":"parent","through_ordinal":0});
    let result = h.provider_step(h.facade_binding(7).unwrap(), &status).await;
    assert!(
        matches!(result, Err(HandlerOutcome::ErrorWithDetail { ref code, ref detail, .. }) if code == "invalid_params" && detail["field"] == "messages")
    );
    assert_eq!(
        store
            .load_provider_lineage(&key.store_key(), "late-child")
            .unwrap()
            .unwrap(),
        root
    );
    assert!(store
        .load_provider_messages(&key.store_key(), "late-child")
        .unwrap()
        .is_empty());
    let parent = store
        .load_provider_messages(&key.store_key(), "parent")
        .unwrap();
    status["messages"][0] = json!({"mid":parent[0].mid,"ordinal":0,"message":serde_json::from_slice::<Value>(&parent[0].message_bytes).unwrap()["message"],"raw_message":serde_json::from_slice::<Value>(&parent[0].message_bytes).unwrap()["raw_message"]});
    native_step(&h, &status).await;
    assert_eq!(
        store
            .load_provider_lineage(&key.store_key(), "late-child")
            .unwrap()
            .unwrap()
            .descends_from
            .as_deref(),
        Some("parent")
    );
}

async fn identity_parent_after_empty_fork(h: &McHandler) -> Value {
    native_setup_for_lineage(h, "L", None).await;
    let old = native_step(h, &step(r#"{"role":"user","content":"old root"}"#)).await;
    assert_eq!(old["answer"], "compaction_message");
    let mut fresh = h.facade_binding(7).unwrap();
    fresh.session = "fresh-provider-session".into();
    h.bind_route(7, fresh);
    let parent = native_setup_for_lineage(h, "parent", None).await;
    assert_eq!(parent["initial"]["version"], 1);
    assert_eq!(parent["initial"]["range"], json!({"from":0,"to":0}));
    let mut status = step(
        r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"text","text":"answer"}]}"#,
    );
    status["session"] = json!("fresh-provider-session");
    status["lineage_id"] = json!("parent");
    status["geometry"] = json!({"usable_soft":50000,"usable_hard":60000,"absolute_wall":100000,"derivation":"gateway"});
    status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    status["request_id"] = json!("parent-step");
    assert_eq!(native_step(h, &status).await["answer"], "noop");
    parent
}

#[tokio::test]
async fn cc_identity_parent_continuation_advances_version_and_step_proceeds() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    let parent = identity_parent_after_empty_fork(&h).await;
    let ready = native_setup_for_lineage(
        &h,
        "child",
        Some(json!({"lineage_id":"parent","through_ordinal":0})),
    )
    .await;
    let mut next = step(r#"{"role":"user","content":"child text"}"#);
    next["session"] = json!("fresh-provider-session");
    next["lineage_id"] = json!("child");
    next["messages"][0]["mid"] = json!("child-mid");
    next["messages"][0]["ordinal"] = json!(1);
    next["newest"] = json!({"mid":"child-mid","ordinal":1});
    next["last_applied"] = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
    // MC's setup extension saves the parent link; omit descends_from here to
    // exercise calls that send only lineage_id.
    let result = h.provider_step(h.facade_binding(7).unwrap(), &next).await;
    assert!(
        ready["initial"]["version"] == 4 && result.is_ok(),
        "identity parent version={}, descendant version={}, first step={result:?}",
        parent["initial"]["version"],
        ready["initial"]["version"]
    );
    let answer: Value = serde_json::from_slice(&result.unwrap()).unwrap();
    assert!(matches!(
        answer["answer"].as_str(),
        Some("noop" | "compaction_message")
    ));
    assert_eq!(ready["initial"]["replacement"], json!([]));
    assert!(ready["initial"].get("raw_view").is_none());
    if answer["answer"] == "compaction_message" {
        assert!(answer.to_string().contains("child text"));
    }
    assert!(!answer.to_string().contains("old root"));
}
