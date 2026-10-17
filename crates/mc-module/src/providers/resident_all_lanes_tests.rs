use super::*;

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
