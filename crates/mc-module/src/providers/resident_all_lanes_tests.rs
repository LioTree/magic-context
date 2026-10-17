use super::*;

#[path = "resident_all_lanes_review_tests.rs"]
mod independent_review;

fn synthetic() -> tempfile::TempDir {
    let root = std::env::temp_dir().join("magic-context/resident-all-lanes");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

fn raw(outcome: HandlerOutcome) -> Vec<u8> {
    match outcome {
        HandlerOutcome::Response(bytes) => bytes,
        other => panic!("{other:?}"),
    }
}

fn runner(dir: &Path, project: &Path, resident: bool) -> McHandler {
    let h =
        handler(dir, Arc::new(Runner::default())).with_startup_provider_resident_enabled(resident);
    let mut binding = h.facade_binding(7).unwrap();
    binding.project_root = project.into();
    h.bind_route(7, binding);
    h
}

async fn invoke(h: &McHandler, method: &str, params: &Value) -> Vec<u8> {
    let result = h
        .dispatch_value(7, json!({"method":method,"params":params}))
        .await;
    if !matches!(result, HandlerOutcome::Response(_)) {
        panic!("{method} request {}: {result:?}", params["request_id"]);
    }
    raw(result)
}

fn history(through: u64) -> Vec<Value> {
    (1..=through)
        .map(|ordinal| user(ordinal, &format!("source {ordinal}: café 🦀")))
        .collect()
}

fn compartments(pass: u64, through: u64) -> Vec<mc_store::StoredCompartment> {
    vec![mc_store::StoredCompartment {
        sequence: 1,
        start_message: 1,
        end_message: through as i64,
        end_message_id: format!("m{through}#0"),
        title: "synthetic history".into(),
        content: format!("history revision {pass}"),
        p1: Some(format!("history revision {pass}")),
        importance: 50,
        ..Default::default()
    }]
}

#[tokio::test]
async fn broca_resident_randomized_48_passes_are_byte_identical() {
    let root = synthetic();
    let a = root.path().join("on");
    let b = root.path().join("off");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let project = root.path().join("project");
    let mut on = runner(&a, &project, true);
    let mut off = runner(&b, &project, false);
    let start = setup("s", "head");
    assert_eq!(
        invoke(&on, "compaction.setup", &start).await,
        invoke(&off, "compaction.setup", &start).await
    );
    let mut applied = Value::Null;
    let mut newest = 100;
    let mut seed = 0x98ab76cdu64;
    let mut folds = 0;
    for pass in 0..48 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        if pass == 24 {
            drop(on);
            drop(off);
            on = runner(&a, &project, true);
            off = runner(&b, &project, false);
        }
        let hook = json!({"session":"s","harness":"broca","request_id":format!("hook-{pass}"),"lineage_id":"L","params":{},
            "hook":"post_assistant","step_id":format!("hook-{pass}"),"blocks":[format!("§999§ assistant {seed} café 🦀") ]});
        assert_eq!(
            invoke(&on, "transform.hook", &hook).await,
            invoke(&off, "transform.hook", &hook).await,
            "hook {pass}"
        );
        let mut appended = if pass == 0 { history(newest) } else { vec![] };
        if pass > 0 && seed & 1 == 0 {
            newest += 1;
            appended.push(user(newest, &format!("append {seed}")));
        }
        for h in [&on, &off] {
            let store = h.store.get().unwrap();
            let namespace = key(h, "s", "broca").engine_key();
            store
                .replace_compartments(&namespace, &compartments(seed % 97, 80))
                .unwrap();
            store.arm_soft_refresh(&namespace).unwrap();
            if pass % 7 == 3 {
                store
                    .append_pending_agent_drops(&namespace, &["m81#0".into()], pass)
                    .unwrap();
            }
        }
        let mut request = step("s", appended, Some(newest));
        request["request_id"] = json!(format!("step-{pass}"));
        request["now"] = json!(1000 + pass * 1000);
        if !applied.is_null() {
            request["last_applied"] = applied.clone();
        }
        let response = invoke(&on, "compaction.step", &request).await;
        assert_eq!(
            String::from_utf8(response.clone()).unwrap(),
            String::from_utf8(invoke(&off, "compaction.step", &request).await).unwrap(),
            "step {pass}"
        );
        let response: Value = serde_json::from_slice(&response).unwrap();
        if response["answer"] == "compaction_message" {
            folds += 1;
            applied = json!({"compaction_id":response["compaction"]["compaction_id"],"version":response["compaction"]["version"]});
        }
    }
    assert!(folds >= 40, "must exercise folds, not just noops: {folds}");
    let stats = on.provider_resident.stats();
    let tail_passes: u64 = stats["containers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["tail_passes"].as_u64().unwrap())
        .sum();
    assert!(
        tail_passes > 0,
        "must execute resident tails, not just hold a lease: {stats}"
    );
    println!("BROCA_DIFFERENTIAL passes=48 folds={folds} resident_tail_passes={tail_passes} hooks=48 restart=1 drops=7");
}

#[tokio::test]
async fn broca_resident_lineage_and_codec_are_not_interchangeable() {
    let root = synthetic();
    let h = runner(root.path(), &root.path().join("project"), true);
    invoke(&h, "compaction.setup", &setup("s", "head")).await;
    let store = h.store.get().unwrap();
    let key = key(&h, "s", "broca");
    for (lineage, text) in [("L", "first source"), ("fork", "different source")] {
        let mut record = h.runner_record(store, &key).unwrap();
        let mut message = user(1, text);
        message["mid"] = json!(format!("{lineage}-m1"));
        ingest(&mut record, lineage, &[decode(&message).unwrap()]).unwrap();
        record.save(&h.provider_store, &key).unwrap();
        let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step","serializer_profile":"owned-broca","session_id":key.engine_key(),"render_config":"","messages":[]})).unwrap();
        record.prepare(lineage, &mut request).unwrap();
        assert_eq!(request.messages.len(), 1);
        assert_eq!(
            request.messages[0].ck.content[0].kind,
            ck_wire::CkKind::Text { text: text.into() }
        );
        assert_eq!(request.messages[0].mid, format!("{lineage}-m1"));
        record.publish();
    }
}

#[tokio::test]
async fn broca_resident_does_not_admit_runner_host_plans() {
    let root = synthetic();
    let h = runner(root.path(), &root.path().join("project"), true);
    let binding = h.facade_binding(7).unwrap();
    assert!(!host_binding(&binding));
    let mut request = setup("s", "head");
    request["params"] = json!({"serializer_profile":"opencode-aisdk","observation":"answer"});
    assert_eq!(
        code(
            h.dispatch_value(7, json!({"method":"compaction.setup","params":request}))
                .await
        ),
        "invalid_params"
    );
}

fn claude(dir: &Path, project: &Path, resident: bool) -> McHandler {
    let h =
        super::super::claude_code_tests::handler(dir, super::super::claude_code_tests::thalamus())
            .with_startup_provider_resident_enabled(resident);
    let mut binding = h.facade_binding(7).unwrap();
    binding.project_root = project.into();
    binding.config.protected_tokens_user = Some(0);
    binding.config.protected_tools.clear();
    h.bind_route(7, binding);
    h
}

fn cc_message(ordinal: u64, text: &str) -> Value {
    let raw = format!(
        "{{ \"content\":{}, \"role\":\"user\" }}",
        serde_json::to_string(text).unwrap()
    );
    json!({"ordinal":ordinal,"mid":format!("m{ordinal}"),"message":serde_json::from_str::<Value>(&raw).unwrap(),"raw_message":raw})
}

#[tokio::test]
async fn claude_resident_randomized_48_passes_are_byte_identical() {
    let root = synthetic();
    let a = root.path().join("on");
    let b = root.path().join("off");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let project = root.path().join("project");
    let mut on = claude(&a, &project, true);
    let mut off = claude(&b, &project, false);
    let ready = super::super::claude_code_tests::setup(&on).await;
    assert_eq!(ready, super::super::claude_code_tests::setup(&off).await);
    let mut applied = Value::Null;
    let mut newest = 100;
    let mut seed = 0x55667788u64;
    let mut folds = 0;
    for pass in 0..48u64 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        if pass == 24 {
            drop(on);
            drop(off);
            on = claude(&a, &project, true);
            off = claude(&b, &project, false);
            let ready = super::super::claude_code_tests::setup(&on).await;
            assert_eq!(ready, super::super::claude_code_tests::setup(&off).await);
            applied = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
        }
        let mut appended = if pass == 0 {
            (1..=newest)
                .map(|ordinal| cc_message(ordinal, &format!("source {ordinal}: café 🦀")))
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        if pass > 0 && seed & 1 == 0 {
            newest += 1;
            appended.push(cc_message(newest, &format!("append {seed}")));
        }
        let current = if let Some(message) = appended.last() {
            message.clone()
        } else {
            cc_message(newest, &format!("source {newest}: café 🦀"))
        };
        // A MID already stored by a step cannot name different native JSON bytes.
        // Repeated hooks therefore reuse that message's original raw_message.
        let current = if pass > 0 && appended.is_empty() {
            let key = Key::new(&on.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
            let held = on
                .store
                .get()
                .unwrap()
                .load_provider_messages_since(&key.store_key(), "L", newest)
                .unwrap();
            let envelope: Value = serde_json::from_slice(&held[0].message_bytes).unwrap();
            json!({"ordinal":newest,"mid":format!("m{newest}"),"message":envelope["message"],"raw_message":envelope["raw_message"]})
        } else {
            current
        };
        let hook = json!({"session":"cc","harness":"claude-code","step_id":format!("hook-{pass}"),"lineage_id":"L",
            "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"hook":"pre_user",
            "subject_mid":current["mid"],"subject_ordinal":newest,"message":current["message"],"raw_message":current["raw_message"],
            "blocks":[current["message"]["content"]]});
        for h in [&on, &off] {
            let store = h.store.get().unwrap();
            let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
            let namespace = store
                .load_provider_conversation(&key.store_key())
                .unwrap()
                .unwrap()
                .engine_namespace;
            store
                .replace_compartments(&namespace, &compartments(seed % 97, 80))
                .unwrap();
            store.arm_soft_refresh(&namespace).unwrap();
            if pass % 7 == 3 {
                store
                    .append_pending_agent_drops(&namespace, &["m40#0".into()], pass as i64)
                    .unwrap();
            }
        }
        let mut request = step("cc", appended, Some(newest));
        request["harness"] = json!("claude-code");
        request["request_id"] = json!(format!("step-{pass}"));
        request["now"] = json!(1000 + pass * 1000);
        request["served_through_ordinal"] = json!(newest);
        if !applied.is_null() {
            request["last_applied"] = applied.clone();
        }
        let response = invoke(&on, "compaction.step", &request).await;
        assert_eq!(
            response,
            invoke(&off, "compaction.step", &request).await,
            "step {pass}"
        );
        assert_eq!(
            invoke(&on, "transform.hook", &hook).await,
            invoke(&off, "transform.hook", &hook).await,
            "hook {pass}"
        );
        let response: Value = serde_json::from_slice(&response).unwrap();
        if response["answer"] == "compaction_message" {
            folds += 1;
            applied = json!({"compaction_id":response["compaction"]["compaction_id"],"version":response["compaction"]["version"]});
        }
    }
    assert!(
        folds >= 2,
        "must exercise replacements as well as noops: {folds}"
    );
    let stats = on.provider_resident.stats();
    let tail_passes: u64 = stats["containers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["tail_passes"].as_u64().unwrap())
        .sum();
    assert!(
        tail_passes > 0,
        "must execute resident tails, not just hold a lease: {stats}"
    );
    println!("CLAUDE_DIFFERENTIAL passes=48 replacements={folds} resident_tail_passes={tail_passes} hooks=48 restart=1 drops=7");
}

fn cc_raw(ordinal: u64, raw: &str) -> Value {
    json!({"ordinal":ordinal,"mid":format!("m{ordinal}"),"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw})
}

/// Claude Code history whose message `call` is an assistant `tool_use` and
/// whose next message is the user `tool_result` answering it.
fn cc_tool_history(newest: u64, call: u64) -> Vec<Value> {
    (1..=newest)
        .map(|ordinal| {
            if ordinal == call {
                cc_raw(
                    ordinal,
                    r#"{"role":"assistant","content":[{"type":"tool_use","id":"toolu_boundary","name":"read","input":{"path":"a"}}]}"#,
                )
            } else if ordinal == call + 1 {
                cc_raw(
                    ordinal,
                    r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_boundary","content":"boundary result"}]}"#,
                )
            } else {
                cc_message(ordinal, &format!("source {ordinal}: café 🦀"))
            }
        })
        .collect()
}

/// When the history summary ends at a `tool_result` message, a resident
/// Claude Code fold renders the coverage boundary in front of its retained
/// tail. The boundary's paired `tool_use` lies in the previous message; without
/// it the renderer saw a covered span that split the tool exchange and refused
/// the fold as `invalid_signed_tool_boundary`. The resident fold must serve
/// exactly what the full rebuild (the non-resident oracle) serves.
#[tokio::test]
async fn claude_resident_fold_with_tool_result_boundary_matches_full_rebuild() {
    let root = synthetic();
    let a = root.path().join("on");
    let b = root.path().join("off");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let project = root.path().join("project");
    let on = claude(&a, &project, true);
    let off = claude(&b, &project, false);
    let ready = super::super::claude_code_tests::setup(&on).await;
    assert_eq!(ready, super::super::claude_code_tests::setup(&off).await);
    let boundary = 81;
    let mut newest = 100;
    let mut applied = Value::Null;
    let mut folds = 0;
    for pass in 0..8u64 {
        let appended = if pass == 0 {
            cc_tool_history(newest, boundary - 1)
        } else if pass % 2 == 0 {
            newest += 1;
            vec![cc_message(newest, &format!("append {pass}"))]
        } else {
            vec![]
        };
        for h in [&on, &off] {
            let store = h.store.get().unwrap();
            let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
            let namespace = store
                .load_provider_conversation(&key.store_key())
                .unwrap()
                .unwrap()
                .engine_namespace;
            store
                .replace_compartments(&namespace, &compartments(pass, boundary))
                .unwrap();
            store.arm_soft_refresh(&namespace).unwrap();
        }
        let mut request = step("cc", appended, Some(newest));
        request["harness"] = json!("claude-code");
        request["request_id"] = json!(format!("boundary-{pass}"));
        request["now"] = json!(1000 + pass * 1000);
        request["served_through_ordinal"] = json!(newest);
        if !applied.is_null() {
            request["last_applied"] = applied.clone();
        }
        let response = invoke(&on, "compaction.step", &request).await;
        assert_eq!(
            String::from_utf8_lossy(&response),
            String::from_utf8_lossy(&invoke(&off, "compaction.step", &request).await),
            "step {pass}"
        );
        let response: Value = serde_json::from_slice(&response).unwrap();
        if response["answer"] == "compaction_message" {
            folds += 1;
            applied = json!({"compaction_id":response["compaction"]["compaction_id"],"version":response["compaction"]["version"]});
        }
    }
    assert!(folds >= 2, "must exercise replacements: {folds}");
    let stats = on.provider_resident.stats();
    let tail_passes: u64 = stats["containers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["tail_passes"].as_u64().unwrap())
        .sum();
    assert!(
        tail_passes > 0,
        "must fold through the resident tail that renders the boundary: {stats}"
    );
}

/// Runs a Claude Code fold whose stored view ends at a `tool_result` boundary
/// (ordinal 81 of 100 messages) on a resident handler and on the non-resident
/// oracle, acknowledges it, then restarts both processes on the same stores and
/// repeats the host's declare and Setup. Returns the restarted resident handler,
/// the restarted oracle, and the `last_applied` value naming the Setup's view.
async fn claude_restarted_after_tool_result_fold(
    a: &Path,
    b: &Path,
    project: &Path,
) -> (McHandler, McHandler, Value) {
    let on = claude(a, project, true);
    let off = claude(b, project, false);
    let ready = super::super::claude_code_tests::setup(&on).await;
    assert_eq!(ready, super::super::claude_code_tests::setup(&off).await);
    let boundary = 81;
    let newest = 100;
    for h in [&on, &off] {
        let store = h.store.get().unwrap();
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let namespace = store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap()
            .engine_namespace;
        store
            .replace_compartments(&namespace, &compartments(0, boundary))
            .unwrap();
        store.arm_soft_refresh(&namespace).unwrap();
    }
    let mut request = step("cc", cc_tool_history(newest, boundary - 1), Some(newest));
    request["harness"] = json!("claude-code");
    request["request_id"] = json!("before-restart");
    request["now"] = json!(1000);
    request["served_through_ordinal"] = json!(newest);
    let response = invoke(&on, "compaction.step", &request).await;
    assert_eq!(
        String::from_utf8_lossy(&response),
        String::from_utf8_lossy(&invoke(&off, "compaction.step", &request).await),
        "fold before restart"
    );
    let response: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(response["answer"], "compaction_message", "{response}");
    // The host acknowledges the fold on its next step, so the fold's view is
    // the applied view that a restarted process restores from.
    let mut request = step("cc", vec![], Some(newest));
    request["harness"] = json!("claude-code");
    request["request_id"] = json!("acknowledge");
    request["now"] = json!(1500);
    request["served_through_ordinal"] = json!(newest);
    request["last_applied"] = json!({"compaction_id":response["compaction"]["compaction_id"],"version":response["compaction"]["version"]});
    assert_eq!(
        String::from_utf8_lossy(&invoke(&on, "compaction.step", &request).await),
        String::from_utf8_lossy(&invoke(&off, "compaction.step", &request).await),
        "acknowledgement before restart"
    );

    drop(on);
    drop(off);
    let on = claude(a, project, true);
    let off = claude(b, project, false);
    let ready = super::super::claude_code_tests::setup(&on).await;
    assert_eq!(ready, super::super::claude_code_tests::setup(&off).await);
    let applied = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
    (on, off, applied)
}

/// After a process restart, a Claude Code fold restores its resident state from
/// the stored view of the previous fold instead of replaying the whole native
/// history. The stored view here ends at a `tool_result` boundary, which the
/// restore must accept, and the restored fold must serve exactly what the full
/// rebuild (the non-resident oracle) serves.
#[tokio::test]
async fn claude_resident_restart_primes_from_stored_view_and_matches_full_rebuild() {
    let root = synthetic();
    let a = root.path().join("on");
    let b = root.path().join("off");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let project = root.path().join("project");
    let (mut on, mut off, mut applied) =
        claude_restarted_after_tool_result_fold(&a, &b, &project).await;
    let boundary = 81;
    let mut newest = 100;
    // The history compartments are not rewritten here, so the compartment source
    // revision recorded with the last fold's cut still equals the current one;
    // prime_resident_fold restores only when those two revisions match.
    for h in [&on, &off] {
        let store = h.store.get().unwrap();
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let namespace = store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap()
            .engine_namespace;
        store.arm_soft_refresh(&namespace).unwrap();
    }
    let store = on.store.get().unwrap();
    let key = Key::new(&on.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    // The first fold after the restart restores the resident state; the second
    // rewrites the history text (same compartment boundaries) so the restored
    // state has to serve a real replacement, not only a noop.
    for pass in 1..=2u64 {
        if pass == 2 {
            for h in [&on, &off] {
                let store = h.store.get().unwrap();
                let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
                let namespace = store
                    .load_provider_conversation(&key.store_key())
                    .unwrap()
                    .unwrap()
                    .engine_namespace;
                store
                    .replace_compartments(&namespace, &compartments(pass, boundary))
                    .unwrap();
                store.arm_soft_refresh(&namespace).unwrap();
            }
        }
        newest += 1;
        let mut request = step(
            "cc",
            vec![cc_message(newest, &format!("after restart {pass}"))],
            Some(newest),
        );
        request["harness"] = json!("claude-code");
        request["request_id"] = json!(format!("after-restart-{pass}"));
        request["now"] = json!(2000 + pass * 1000);
        request["served_through_ordinal"] = json!(newest);
        request["last_applied"] = applied.clone();
        let response = invoke(&on, "compaction.step", &request).await;
        assert_eq!(
            String::from_utf8_lossy(&response),
            String::from_utf8_lossy(&invoke(&off, "compaction.step", &request).await),
            "fold {pass} after restart"
        );
        let lease = on
            .provider_resident
            .begin(store.tag_cache_namespace(), &key)
            .unwrap()
            .unwrap();
        assert_eq!(
            lease.state.fold_tail_passes, pass,
            "a restarted Claude Code fold must restore from its stored view, not replay native history"
        );
        lease.publish();
        if pass == 2 {
            let response: Value = serde_json::from_slice(&response).unwrap();
            assert_eq!(response["answer"], "compaction_message", "{response}");
            applied = json!({"compaction_id":response["compaction"]["compaction_id"],"version":response["compaction"]["version"]});
        }
    }

    // Acknowledge the replacement served by the second fold above, restart the
    // process a second time, and make a Claude Code hook the first call after
    // that restart. The hook path restores the fold state on its own cold
    // rebuild, and the next fold runs on that restored state.
    let mut request = step("cc", vec![], Some(newest));
    request["harness"] = json!("claude-code");
    request["request_id"] = json!("acknowledge-replacement");
    request["now"] = json!(5000);
    request["served_through_ordinal"] = json!(newest);
    request["last_applied"] = applied;
    assert_eq!(
        String::from_utf8_lossy(&invoke(&on, "compaction.step", &request).await),
        String::from_utf8_lossy(&invoke(&off, "compaction.step", &request).await),
        "acknowledgement before the second restart"
    );
    drop(on);
    drop(off);
    on = claude(&a, &project, true);
    off = claude(&b, &project, false);
    let ready = super::super::claude_code_tests::setup(&on).await;
    assert_eq!(ready, super::super::claude_code_tests::setup(&off).await);
    let applied = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
    let store = on.store.get().unwrap();
    let key = Key::new(&on.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    // A message id (mid) already stored cannot be resent with a different
    // raw_message, so the hook repeats the newest message's stored raw_message.
    let held = store
        .load_provider_messages_since(&key.store_key(), "L", newest)
        .unwrap();
    let envelope: Value = serde_json::from_slice(&held[0].message_bytes).unwrap();
    let hook = json!({"session":"cc","harness":"claude-code","step_id":"hook-after-restart","lineage_id":"L",
        "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"hook":"pre_user",
        "subject_mid":format!("m{newest}"),"subject_ordinal":newest,"message":envelope["message"],
        "raw_message":envelope["raw_message"],"blocks":[envelope["message"]["content"]]});
    assert_eq!(
        invoke(&on, "transform.hook", &hook).await,
        invoke(&off, "transform.hook", &hook).await,
        "first hook after the second restart"
    );
    let lease = on
        .provider_resident
        .begin(store.tag_cache_namespace(), &key)
        .unwrap()
        .unwrap();
    assert!(
        lease.state.fold_view.is_some(),
        "the first hook after a restart must restore the fold state from the stored view"
    );
    lease.publish();
    for h in [&on, &off] {
        let store = h.store.get().unwrap();
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let namespace = store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap()
            .engine_namespace;
        store
            .replace_compartments(&namespace, &compartments(3, boundary))
            .unwrap();
        store.arm_soft_refresh(&namespace).unwrap();
    }
    newest += 1;
    let mut request = step("cc", vec![cc_message(newest, "after hook")], Some(newest));
    request["harness"] = json!("claude-code");
    request["request_id"] = json!("after-hook");
    request["now"] = json!(6000);
    request["served_through_ordinal"] = json!(newest);
    request["last_applied"] = applied;
    let response = invoke(&on, "compaction.step", &request).await;
    assert_eq!(
        String::from_utf8_lossy(&response),
        String::from_utf8_lossy(&invoke(&off, "compaction.step", &request).await),
        "fold after the hook"
    );
    let response: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(response["answer"], "compaction_message", "{response}");
    let lease = on
        .provider_resident
        .begin(store.tag_cache_namespace(), &key)
        .unwrap()
        .unwrap();
    assert_eq!(
        lease.state.fold_tail_passes, 1,
        "the fold after the restoring hook must run on the restored state"
    );
    lease.publish();
}

/// A restored fold state is an optimization. If restoring it from the stored view
/// fails after a restart, the first Claude Code hook must still answer, using the
/// full-rebuild path and the oracle's bytes, and the next fold replays the
/// stored rows in full.
#[tokio::test]
async fn claude_hook_after_failed_resident_restore_serves_the_full_rebuild() {
    let root = synthetic();
    let a = root.path().join("on");
    let b = root.path().join("off");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let project = root.path().join("project");
    let (on, off, applied) = claude_restarted_after_tool_result_fold(&a, &b, &project).await;
    let boundary = 81;
    let mut newest = 100;
    let store = on.store.get().unwrap();
    let key = Key::new(&on.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    // A message id (mid) already stored cannot be resent with a different
    // raw_message, so the hook repeats the newest message's stored raw_message.
    let held = store
        .load_provider_messages_since(&key.store_key(), "L", newest)
        .unwrap();
    let envelope: Value = serde_json::from_slice(&held[0].message_bytes).unwrap();
    let hook = json!({"session":"cc","harness":"claude-code","step_id":"hook-after-failed-restore","lineage_id":"L",
        "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"hook":"pre_user",
        "subject_mid":format!("m{newest}"),"subject_ordinal":newest,"message":envelope["message"],
        "raw_message":envelope["raw_message"],"blocks":[envelope["message"]["content"]]});
    super::super::compaction::FAIL_NEXT_RESIDENT_FOLD_RESTORE.with(|fail| fail.set(true));
    let served = on
        .dispatch_value(7, json!({"method":"transform.hook","params":&hook}))
        .await;
    assert!(
        !super::super::compaction::FAIL_NEXT_RESIDENT_FOLD_RESTORE.with(|fail| fail.get()),
        "the hook's cold rebuild must have attempted the restore"
    );
    let HandlerOutcome::Response(served) = served else {
        panic!("a failed restore must not fail the hook: {served:?}")
    };
    assert_eq!(
        served,
        invoke(&off, "transform.hook", &hook).await,
        "hook after the failed restore"
    );
    let lease = on
        .provider_resident
        .begin(store.tag_cache_namespace(), &key)
        .unwrap()
        .unwrap();
    assert!(
        lease.state.fold_view.is_none() && lease.state.fold_working.is_none(),
        "a failed restore must drop the partly built fold state"
    );
    lease.publish();
    for h in [&on, &off] {
        let store = h.store.get().unwrap();
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let namespace = store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap()
            .engine_namespace;
        store
            .replace_compartments(&namespace, &compartments(1, boundary))
            .unwrap();
        store.arm_soft_refresh(&namespace).unwrap();
    }
    newest += 1;
    let mut request = step(
        "cc",
        vec![cc_message(newest, "after failed restore")],
        Some(newest),
    );
    request["harness"] = json!("claude-code");
    request["request_id"] = json!("after-failed-restore");
    request["now"] = json!(2000);
    request["served_through_ordinal"] = json!(newest);
    request["last_applied"] = applied;
    let response = invoke(&on, "compaction.step", &request).await;
    assert_eq!(
        String::from_utf8_lossy(&response),
        String::from_utf8_lossy(&invoke(&off, "compaction.step", &request).await),
        "fold after the failed restore"
    );
    let response: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(response["answer"], "compaction_message", "{response}");
    let lease = on
        .provider_resident
        .begin(store.tag_cache_namespace(), &key)
        .unwrap()
        .unwrap();
    assert_eq!(
        lease.state.fold_tail_passes, 0,
        "without a restored state the fold must replay the stored rows in full"
    );
    lease.publish();
}
