use super::*;

fn review_root() -> tempfile::TempDir {
    let root = std::env::temp_dir().join("magic-context/resident-all-lanes-review");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

fn normalize(value: &mut Value) {
    match value {
        Value::Object(map) => {
            // Independently created stores have different clocks and revision UUIDs.
            // Retain revision numbers and all content, counters, receipts and bytes.
            map.remove("computed_at_ms");
            map.remove("created_at_ms");
            map.remove("expiry_cutoff_ms");
            map.remove("last_committed_pass_at_ms");
            for (key, value) in map.iter_mut() {
                if key.ends_with("_json") && key != "replacement_json" {
                    if let Value::String(s) = value {
                        if let Ok(parsed) = serde_json::from_str::<Value>(s) {
                            *value = parsed;
                        }
                    }
                }
                normalize(value);
                if key == "native_compartment_source_revision" {
                    if let Value::Object(revision) = value {
                        revision.remove("generation");
                    }
                }
            }
        }
        Value::Array(entries) => entries.iter_mut().for_each(normalize),
        _ => {}
    }
}

fn difference(a: &Value, b: &Value, path: &str) -> Option<String> {
    if a == b {
        return None;
    }
    if let (Value::Object(a), Value::Object(b)) = (a, b) {
        for key in a.keys().chain(b.keys()) {
            if let Some(found) = difference(
                a.get(key).unwrap_or(&Value::Null),
                b.get(key).unwrap_or(&Value::Null),
                &format!("{path}.{key}"),
            ) {
                return Some(found);
            }
        }
    }
    if let (Value::Array(a), Value::Array(b)) = (a, b) {
        for (i, (a, b)) in a.iter().zip(b).enumerate() {
            if let Some(found) = difference(a, b, &format!("{path}[{i}]")) {
                return Some(found);
            }
        }
    }
    if let (Value::String(a), Value::String(b)) = (a, b) {
        let at = a
            .chars()
            .zip(b.chars())
            .position(|(a, b)| a != b)
            .unwrap_or(a.chars().count().min(b.chars().count()));
        return Some(format!(
            "{path} char={at}: on={:?} off={:?}",
            a.chars()
                .skip(at.saturating_sub(50))
                .take(180)
                .collect::<String>(),
            b.chars()
                .skip(at.saturating_sub(50))
                .take(180)
                .collect::<String>()
        ));
    }
    Some(format!(
        "{path}: on={} off={}",
        a.to_string().chars().take(400).collect::<String>(),
        b.to_string().chars().take(400).collect::<String>()
    ))
}

fn persisted(h: &McHandler, cc: bool, directory: &Path) -> Value {
    let k = Key::new(
        &h.facade_binding(7).unwrap(),
        if cc { "cc" } else { "s" },
        if cc { "claude-code" } else { "broca" },
    )
    .unwrap();
    let store = h.store.get().unwrap();
    let state = store.load(&k.engine_key()).unwrap();
    let conversation = store
        .load_provider_conversation(&k.store_key())
        .unwrap()
        .unwrap();
    let sql = rusqlite::Connection::open_with_flags(
        directory.join(if cc { "cc.db" } else { "store.db" }),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut receipt_query = sql.prepare("SELECT command_id,queued_at_ms,first_applied_at_ms IS NOT NULL,disposition FROM mc_reduce_command_ledger WHERE session_id=?1 ORDER BY command_id").unwrap();
    let receipts = receipt_query
        .query_map([k.engine_key()], |row| {
            Ok(json!({
                "command_id":row.get::<_,String>(0)?, "queued_at_ms":row.get::<_,i64>(1)?,
                "applied":row.get::<_,bool>(2)?, "disposition":row.get::<_,Option<String>>(3)?
            }))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    let mut value = json!({
        "record": store.load_provider_record(&k.store_key()).unwrap().map(|s| serde_json::from_str::<Value>(&s).unwrap()),
        "messages": store.load_provider_messages(&k.store_key(), &conversation.lineage_id).unwrap().iter().map(|message| json!({"ordinal":message.ordinal,"mid":message.mid,"bytes":message.message_bytes})).collect::<Vec<_>>(),
        "hook_answers": store.load_provider_hook_answers(&k.store_key()).unwrap().iter().map(|answer| json!({"subject":format!("{:?}",answer.answer.subject),"lineage":answer.lineage_id,"state":answer.state,"ordinal":answer.answer.ordinal,"ops":answer.answer.ops_json,"tags":answer.answer.tags})).collect::<Vec<_>>(),
        "conversation": conversation,
        "views": crate::providers::view_recipe::stored_views(store, &k.store_key()).iter().map(|view| json!({"version":view.version,"lineage_id":view.lineage_id,"range_from":view.range_from,"range_to":view.range_to,"replacement_json":view.replacement_json,"state":view.state})).collect::<Vec<_>>(),
        "tags": store.load_tags_for_session(&k.engine_key()).unwrap().iter().map(|tag| json!({"tag_number":tag.tag_number,"block_id":tag.block_id,"kind":tag.kind,"token_count":tag.token_count,"source_bytes":tag.source_bytes.as_ref()})).collect::<Vec<_>>(),
        "core": state.core,
        "meta": state.meta,
        "row_version": state.row_version,
        "compartments": store.load_compartments(&k.engine_key()).unwrap(),
        "pending_drops": store.load_pending_agent_drops(&k.engine_key()).unwrap().iter().map(|drop| json!({"id":drop.id,"target":drop.target_id,"queued_at_ms":drop.queued_at_ms,"command_id":drop.command_id,"applied":drop.command_first_applied_at_ms.is_some()})).collect::<Vec<_>>(),
        "receipts": receipts,
    });
    normalize(&mut value);
    value
}

async fn seeded_identity(
    cc: bool,
    initial_seed: u64,
    passes: u64,
    strict_storage: Option<&str>,
    drop_ordinal: u64,
) {
    let root = review_root();
    let dirs = [root.path().join("on"), root.path().join("off")];
    for dir in &dirs {
        std::fs::create_dir_all(dir).unwrap();
    }
    let project = root.path().join("project");
    let make = |i: usize| {
        if cc {
            claude(&dirs[i], &project, i == 0)
        } else {
            runner(&dirs[i], &project, i == 0)
        }
    };
    let mut pair = [make(0), make(1)];
    if cc {
        assert_eq!(
            super::super::super::claude_code_tests::setup(&pair[0]).await,
            super::super::super::claude_code_tests::setup(&pair[1]).await
        );
    } else {
        assert_eq!(
            invoke(&pair[0], "compaction.setup", &setup("s", "head")).await,
            invoke(&pair[1], "compaction.setup", &setup("s", "head")).await
        );
    }
    let mut seed = initial_seed;
    let mut applied = Value::Null;
    let mut newest = 100;
    let mut current = Value::Null;
    let mut lineage = "L";
    let mut folds = 0;
    let mut differences = BTreeMap::<String, u64>::new();
    for pass in 0..passes {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        if pass == 32 {
            drop(pair);
            pair = [make(0), make(1)];
            if cc {
                let ready = super::super::super::claude_code_tests::setup(&pair[0]).await;
                assert_eq!(
                    ready,
                    super::super::super::claude_code_tests::setup(&pair[1]).await
                );
                applied = json!({"compaction_id":ready["initial"]["compaction_id"],"version":ready["initial"]["version"]});
            }
        }
        let mut messages = if pass == 0 {
            (1..=newest)
                .map(|n| {
                    if cc {
                        cc_message(n, &format!("source {n}: café 🦀"))
                    } else {
                        user(n, &format!("source {n}: café 🦀"))
                    }
                })
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        if pass > 0 && seed & 3 != 0 {
            newest += 1;
            messages.push(if cc {
                cc_message(newest, &format!("append {seed}"))
            } else {
                user(newest, &format!("append {seed}"))
            });
        }
        if pass == 48 {
            if !cc {
                let mut fork = step("s", history(newest), Some(newest));
                fork["lineage_id"] = json!("fork");
                fork["request_id"] = json!(format!("fork-{initial_seed}"));
                let a = format!(
                    "{:?}",
                    pair[0]
                        .dispatch_value(7, json!({"method":"compaction.step","params":fork}))
                        .await
                );
                let b = format!(
                    "{:?}",
                    pair[1]
                        .dispatch_value(7, json!({"method":"compaction.step","params":fork}))
                        .await
                );
                assert_eq!(a, b, "seed={initial_seed} fork refusal");
                assert!(
                    a.contains("compaction lineage changed without setup"),
                    "{a}"
                );
            } else {
                lineage = "fork";
                messages = (81..=newest)
                    .map(|n| {
                        let mut message = cc_message(n, &format!("fork source {n}: {seed}"));
                        message["mid"] = json!(format!("fork-m{n}"));
                        message
                    })
                    .collect();
            }
        } else if pass > 48 && cc {
            for message in &mut messages {
                message["mid"] = json!(format!("fork-m{}", message["ordinal"].as_u64().unwrap()));
            }
        }
        if let Some(message) = messages.last() {
            current = message.clone();
        }
        for h in &pair {
            let k = Key::new(
                &h.facade_binding(7).unwrap(),
                if cc { "cc" } else { "s" },
                if cc { "claude-code" } else { "broca" },
            )
            .unwrap();
            let store = h.store.get().unwrap();
            store
                .replace_compartments(&k.engine_key(), &compartments(seed % 97, 80))
                .unwrap();
            store.arm_soft_refresh(&k.engine_key()).unwrap();
            if pass % 7 == 3 {
                let targets = [format!("m{drop_ordinal}#0")];
                let command = format!("review-drop-{pass}");
                let receipt = store
                    .append_pending_agent_drops_with_command(
                        &k.engine_key(),
                        Some(&command),
                        &targets,
                        pass as i64,
                        false,
                    )
                    .unwrap();
                assert!(!receipt.duplicate);
                assert!(
                    store
                        .append_pending_agent_drops_with_command(
                            &k.engine_key(),
                            Some(&command),
                            &targets,
                            pass as i64,
                            false
                        )
                        .unwrap()
                        .duplicate
                );
            }
        }
        let mut request = step(if cc { "cc" } else { "s" }, messages, Some(newest));
        request["harness"] = json!(if cc { "claude-code" } else { "broca" });
        request["request_id"] = json!(format!("seed-{initial_seed}-pass-{pass}"));
        request["now"] = json!(1000 + pass * 1000);
        request["lineage_id"] = json!(lineage);
        if cc && pass == 48 {
            request["descends_from"] = json!({"lineage_id":"L","through_ordinal":80});
        }
        if cc {
            request["served_through_ordinal"] = json!(newest);
        }
        if !applied.is_null() {
            request["last_applied"] = applied.clone();
        }
        let a = invoke(&pair[0], "compaction.step", &request).await;
        assert_eq!(
            a,
            invoke(&pair[1], "compaction.step", &request).await,
            "cc={cc} seed={initial_seed} pass={pass} served bytes/receipts"
        );
        let answer: Value = serde_json::from_slice(&a).unwrap();
        if answer["answer"] == "compaction_message" {
            folds += 1;
            applied = json!({"compaction_id":answer["compaction"]["compaction_id"],"version":answer["compaction"]["version"]});
        }
        let hook = if cc {
            json!({"session":"cc","harness":"claude-code","lineage_id":lineage,"step_id":format!("hook-{pass}"),
                "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"hook":"pre_user",
                "subject_mid":current["mid"],"subject_ordinal":newest,"message":current["message"],"raw_message":current["raw_message"],"blocks":[current["message"]["content"]]})
        } else {
            json!({"session":"s","harness":"broca","lineage_id":lineage,"step_id":format!("hook-{pass}"),"hook":"post_assistant","blocks":[format!("§999§ source {seed} café 🦀")]})
        };
        assert_eq!(
            invoke(&pair[0], "transform.hook", &hook).await,
            invoke(&pair[1], "transform.hook", &hook).await,
            "cc={cc} seed={initial_seed} pass={pass} hooks/tags"
        );
        let on_state = persisted(&pair[0], cc, &dirs[0]);
        let off_state = persisted(&pair[1], cc, &dirs[1]);
        if strict_storage == Some("pending_drops") && drop_ordinal > 80 && pass % 7 == 3 {
            assert_eq!(
                on_state["pending_drops"],
                json!([]),
                "live-tail drops must retire after a real fold"
            );
            assert_eq!(off_state["pending_drops"], json!([]));
        }
        for (field, actual) in on_state.as_object().unwrap() {
            if let Some(diff) = difference(actual, &off_state[field], field) {
                assert!(
                    strict_storage != Some(field.as_str()),
                    "cc={cc} seed={initial_seed} pass={pass} durable difference: {diff}"
                );
                // Keep running served-byte comparisons after a state mismatch so
                // one metadata difference cannot hide later behavioral failures.
                let count = differences.entry(field.clone()).or_default();
                if *count == 0 {
                    println!("REVIEW_STATE_DIFF cc={cc} seed={initial_seed} pass={pass} {diff}");
                }
                *count += 1;
            }
        }
    }
    assert!(
        folds >= passes * 5 / 8,
        "cc={cc} seed={initial_seed} only {folds} folds"
    );
    let stats = pair[0].provider_resident.stats();
    if passes > 4 {
        assert!(
            stats["containers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["tail_passes"].as_u64().unwrap() > 0),
            "resident not reached: {stats}"
        );
    }
    println!("REVIEW_IDENTITY cc={cc} seed={initial_seed} passes={passes} hooks={passes} folds={folds} restart={} fork_or_descent={} drops={} stored_state_differences={differences:?}", u8::from(passes > 32), u8::from(passes > 48), (0..passes).filter(|pass| pass % 7 == 3).count());
}

#[tokio::test]
async fn review_broca_three_seeds_64_passes_and_audit_durable_state() {
    for seed in [0x13a5u64, 0x72c0ffee, 0xdeadbeef] {
        seeded_identity(false, seed, 64, None, 81).await;
    }
}

#[tokio::test]
async fn review_claude_three_seeds_64_passes_and_audit_durable_state() {
    for seed in [0x13a5u64, 0x72c0ffee, 0xdeadbeef] {
        seeded_identity(true, seed, 64, None, 40).await;
    }
}

#[tokio::test]
async fn review_broca_strict_durable_policy_identity_witness() {
    seeded_identity(false, 0x13a5, 1, Some("conversation"), 81).await;
}

#[tokio::test]
async fn review_claude_strict_durable_policy_identity_witness() {
    seeded_identity(true, 0x13a5, 1, Some("conversation"), 40).await;
}

#[tokio::test]
async fn review_claude_covered_drop_retirement_identity_witness() {
    seeded_identity(true, 0x13a5, 4, Some("pending_drops"), 40).await;
}

#[tokio::test]
async fn review_claude_live_tail_drop_retires_with_residency_on_and_off() {
    seeded_identity(true, 0x13a5, 4, Some("pending_drops"), 81).await;
}

#[tokio::test]
async fn review_claude_absent_drop_is_not_retired_by_prefix() {
    seeded_identity(true, 0x13a5, 4, Some("pending_drops"), 0).await;
}

#[tokio::test]
async fn review_broca_strict_frozen_view_ack_identity_witness() {
    let root = review_root();
    let project = root.path().join("project");
    let mut states = vec![];
    for resident in [false, true] {
        let directory = root.path().join(if resident { "on" } else { "off" });
        std::fs::create_dir_all(&directory).unwrap();
        let h = runner(&directory, &project, resident);
        let setup: Value =
            serde_json::from_slice(&invoke(&h, "compaction.setup", &setup("s", "head")).await)
                .unwrap();
        let mut request = step("s", history(3), Some(3));
        request["last_applied"] = json!({"compaction_id":setup["initial"]["compaction_id"],"version":setup["initial"]["version"]});
        invoke(&h, "compaction.step", &request).await;
        let k = key(&h, "s", "broca");
        let views = h
            .store
            .get()
            .unwrap()
            ;
        let views = crate::providers::view_recipe::stored_views(views, &k.store_key());
        states.push(
            views
                .into_iter()
                .find(|view| Some(view.version) == setup["initial"]["version"].as_u64())
                .unwrap()
                .state,
        );
    }
    assert_eq!(states[0], "applied");
    assert_eq!(
        states[1], "applied",
        "acknowledged initial view must not remain produced in the resident delta writer"
    );
}

#[tokio::test]
async fn review_broca_cancelled_lease_wait_and_two_runs_do_not_reuse_stale_records() {
    let root = review_root();
    let project = root.path().join("project");
    let mut answers = vec![];
    for resident in [false, true] {
        let directory = root.path().join(if resident { "on" } else { "off" });
        std::fs::create_dir_all(&directory).unwrap();
        let scripted = Arc::new(Runner::default());
        let h =
            handler(&directory, scripted.clone()).with_startup_provider_resident_enabled(resident);
        let mut binding = h.facade_binding(7).unwrap();
        binding.project_root = project.clone();
        h.bind_route(7, binding);
        let h = Arc::new(h);
        let initial: Value =
            serde_json::from_slice(&invoke(&h, "compaction.setup", &setup("s", "head")).await)
                .unwrap();
        let k = key(&h, "s", "broca");
        let entered = Arc::new(Notify::new());
        let task = {
            let h = h.clone();
            let entered = entered.clone();
            let k = k.clone();
            tokio::spawn(async move {
                let _serial = h.provider_serial.lock_for(&k).await;
                let mut record = h.runner_record(h.store.get().unwrap(), &k).unwrap();
                record.pending_drops.insert(999);
                entered.notify_one();
                std::future::pending::<()>().await;
                record.publish();
            })
        };
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(!h
            .runner_record(h.store.get().unwrap(), &k)
            .unwrap()
            .pending_drops
            .contains(&999));
        *scripted.durable.lock().unwrap() = Some((h.provider_store.clone(), k.clone()));
        let mut coverage = compartments(1, 0);
        coverage[0].start_message = 0;
        h.store
            .get()
            .unwrap()
            .replace_compartments(&k.engine_key(), &coverage)
            .unwrap();
        scripted
            .pages
            .lock()
            .unwrap()
            .push_back(page(vec![user(1, "second")], None, 1));
        let mut request = step("s", vec![user(0, "first")], Some(1));
        request["more"] = json!(true);
        request["prefix_rebuilding"] = json!({"reason":"flush"});
        request["last_applied"] =
            json!({"compaction_id":initial["initial"]["compaction_id"],"version":50});
        let waited = invoke(&h, "compaction.step", &request).await;
        assert_eq!(
            serde_json::from_slice::<Value>(&waited).unwrap()["answer"],
            "wait"
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(5), scripted.ready.notified())
                .await
                .is_ok(),
            "resident={resident} calls={:?} record={:?}",
            scripted.calls.lock().unwrap(),
            h.provider_store.load(&k).unwrap()
        );
        let record = h.provider_store.load(&k).unwrap();
        assert!(record.wait_request.is_none());
        assert_eq!(record.messages["L"][&1].mid, "m1");
        let mut next = step("s", vec![], Some(1));
        next["request_id"] = json!("run-two");
        next["prefix_rebuilding"] = json!({"reason":"flush"});
        let second = invoke(&h, "compaction.step", &next).await;
        assert_eq!(
            serde_json::from_slice::<Value>(&second).unwrap()["answer"],
            "compaction_message"
        );
        answers.push((waited, second));
    }
    assert_eq!(answers[0], answers[1]);
}

#[tokio::test]
async fn review_broca_record_bytes_are_charged_discarded_and_cap_fallback_serves() {
    let root = review_root();
    let h = runner(root.path(), &root.path().join("project"), true);
    let k = key(&h, "large", "broca");
    let store = h.store.get().unwrap();
    let payload = "x".repeat(1024 * 1024);
    let mut record = h.runner_record(store, &k).unwrap();
    ingest(&mut record, "L", &[decode(&user(1, &payload)).unwrap()]).unwrap();
    record.save(&h.provider_store, &k).unwrap();
    record.publish();
    let stats = h.provider_resident.stats();
    assert!(
        stats["charged_bytes"].as_u64().unwrap() > payload.len() as u64 * 4,
        "Records were not charged: {stats}"
    );
    let mut record = h.runner_record(store, &k).unwrap();
    ingest(
        &mut record,
        "L",
        &[decode(&user(2, &"y".repeat(10 * 1024 * 1024))).unwrap()],
    )
    .unwrap();
    record.save(&h.provider_store, &k).unwrap();
    record.publish();
    let stats = h.provider_resident.stats();
    assert_eq!(
        stats["sessions"], 0,
        "oversize cache must be discarded: {stats}"
    );
    assert!(stats["oversize_discards"].as_u64().unwrap() > 0);
    assert_eq!(h.provider_store.load(&k).unwrap().messages["L"].len(), 2);

    let no_capacity = runner(
        &root.path().join("fallback"),
        &root.path().join("fallback-project"),
        true,
    )
    .with_startup_provider_resident_process_cap(0);
    invoke(&no_capacity, "compaction.setup", &setup("s", "head")).await;
    let answer = invoke(
        &no_capacity,
        "compaction.step",
        &step("s", history(3), Some(3)),
    )
    .await;
    assert_ne!(
        serde_json::from_slice::<Value>(&answer).unwrap()["answer"],
        "refuse"
    );
    assert_eq!(no_capacity.provider_resident.stats()["sessions"], 0);
}

#[tokio::test]
async fn review_broca_signed_thinking_holds_queued_work_with_residency_on_and_off() {
    let root = review_root();
    let project = root.path().join("project");
    let mut answers = vec![];
    for resident in [false, true] {
        let directory = root.path().join(if resident { "on" } else { "off" });
        std::fs::create_dir_all(&directory).unwrap();
        let h = runner(&directory, &project, resident);
        let mut binding = h.facade_binding(7).unwrap();
        binding.config.signed_thinking_hold = crate::config::SignedThinkingHold::On;
        h.bind_route(7, binding);
        let mut start = setup("s", "head");
        start["model"] = json!("anthropic/claude-opus-5-5");
        invoke(&h, "compaction.setup", &start).await;
        let k = key(&h, "s", "broca");
        let store = h.store.get().unwrap();
        let mut request = step("s", history(100), Some(100));
        request["model"] = start["model"].clone();
        invoke(&h, "compaction.step", &request).await;
        store
            .replace_compartments(&k.engine_key(), &compartments(1, 80))
            .unwrap();
        store.arm_soft_refresh(&k.engine_key()).unwrap();
        request["messages"] = json!([]);
        request["request_id"] = json!("head");
        let head: Value =
            serde_json::from_slice(&invoke(&h, "compaction.step", &request).await).unwrap();
        request["last_applied"] = json!({"compaction_id":head["compaction"]["compaction_id"],"version":head["compaction"]["version"]});
        request["request_id"] = json!("signed-tail");
        request["messages"] = json!([message(
            101,
            "assistant",
            json!([
                {"type":"reasoning","text":"private","signature":"signed"},
                {"type":"text","text":"answer"}
            ])
        )]);
        request["newest"] = json!({"ordinal":101,"mid":"m101"});
        invoke(&h, "compaction.step", &request).await;
        store
            .append_pending_agent_drops(&k.engine_key(), &["m81#0".into()], 100)
            .unwrap();
        store.arm_soft_refresh(&k.engine_key()).unwrap();
        request["request_id"] = json!("hold");
        request["messages"] = json!([]);
        request["step_kind"] = json!("tool_continuation");
        request["estimate"] = json!({"request_tokens":66000});
        let held = invoke(&h, "compaction.step", &request).await;
        assert!(store
            .load(&k.engine_key())
            .unwrap()
            .meta
            .held_release
            .is_some());
        assert_eq!(
            store
                .load_pending_agent_drops(&k.engine_key())
                .unwrap()
                .len(),
            1
        );
        answers.push(held);
    }
    assert_eq!(answers[0], answers[1]);
}

#[tokio::test]
async fn review_claude_hot_signed_prefix_edit_is_refused_with_residency_on_and_off() {
    let root = review_root();
    let project = root.path().join("project");
    let mut answers = vec![];
    for resident in [false, true] {
        let directory = root.path().join(if resident { "on" } else { "off" });
        std::fs::create_dir_all(&directory).unwrap();
        let h = claude(&directory, &project, resident);
        super::super::super::claude_code_tests::setup(&h).await;
        let k = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        let mut status = step(
            "cc",
            (1..=100)
                .map(|n| cc_message(n, &format!("source {n}")))
                .collect(),
            Some(100),
        );
        status["harness"] = json!("claude-code");
        status["served_through_ordinal"] = json!(100);
        invoke(&h, "compaction.step", &status).await;
        store
            .replace_compartments(&k.engine_key(), &compartments(1, 80))
            .unwrap();
        store.arm_soft_refresh(&k.engine_key()).unwrap();
        status["messages"] = json!([]);
        status["request_id"] = json!("head");
        let head: Value =
            serde_json::from_slice(&invoke(&h, "compaction.step", &status).await).unwrap();
        status["last_applied"] = json!({"compaction_id":head["compaction"]["compaction_id"],"version":head["compaction"]["version"]});
        let raw = r#"{ "role":"assistant", "content":[{"type":"thinking","thinking":"p\u0072ivate","signature":"signed"},{"type":"text","text":"§99§ answer"}] }"#;
        status["messages"] = json!([{"ordinal":101,"mid":"signed","message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw}]);
        status["newest"] = json!({"ordinal":101,"mid":"signed"});
        status["served_through_ordinal"] = json!(101);
        status["request_id"] = json!("signed");
        invoke(&h, "compaction.step", &status).await;
        store
            .replace_compartments(&k.engine_key(), &compartments(2, 80))
            .unwrap();
        store.arm_soft_refresh(&k.engine_key()).unwrap();
        status["messages"] = json!([]);
        status["request_id"] = json!("signed-edit");
        let result = invoke(&h, "compaction.step", &status).await;
        let answer: Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(answer["answer"], "refuse");
        assert_eq!(answer["provider_code"], "signed_prefix_edit");
        answers.push(result);
    }
    assert_eq!(answers[0], answers[1]);
}

#[tokio::test]
async fn review_claude_endpoint_and_unpaired_result_refuse_with_residency_on_and_off() {
    for (case, expected) in [
        ("endpoint", "native_endpoint_unrepresentable"),
        ("orphan", "invalid_signed_tool_boundary"),
    ] {
        let root = review_root();
        let project = root.path().join("project");
        let mut answers = vec![];
        for resident in [false, true] {
            let directory = root.path().join(if resident { "on" } else { "off" });
            std::fs::create_dir_all(&directory).unwrap();
            let h = claude(&directory, &project, resident);
            super::super::super::claude_code_tests::setup(&h).await;
            let k = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
            let store = h.store.get().unwrap();
            let mut messages = (1..=100)
                .map(|n| cc_message(n, &format!("source {n}")))
                .collect::<Vec<_>>();
            let native = if case == "endpoint" {
                json!({"role":"user","content":[{"type":"text","text":"covered"},{"type":"text","text":"must remain"}]})
            } else {
                json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"orphan","content":"result without call"}]})
            };
            messages[79] =
                json!({"ordinal":80,"mid":"m80","message":native,"raw_message":native.to_string()});
            let mut status = step("cc", messages, Some(100));
            status["harness"] = json!("claude-code");
            status["served_through_ordinal"] = json!(100);
            if case == "orphan" {
                let outcome = h
                    .dispatch_value(7, json!({"method":"compaction.step","params":status}))
                    .await;
                let diagnostic = format!("{outcome:?}");
                assert!(
                    diagnostic.contains("compaction range starts inside a tool arc"),
                    "{diagnostic}"
                );
                answers.push(diagnostic.into_bytes());
                continue;
            }
            invoke(&h, "compaction.step", &status).await;
            store
                .replace_compartments(&k.engine_key(), &compartments(1, 78))
                .unwrap();
            store.arm_soft_refresh(&k.engine_key()).unwrap();
            status["messages"] = json!([]);
            status["request_id"] = json!("warm");
            let head: Value =
                serde_json::from_slice(&invoke(&h, "compaction.step", &status).await).unwrap();
            assert_eq!(head["answer"], "compaction_message", "{case}: {head}");
            status["last_applied"] = json!({"compaction_id":head["compaction"]["compaction_id"],"version":head["compaction"]["version"]});
            store
                .replace_compartments(&k.engine_key(), &compartments(2, 80))
                .unwrap();
            store.arm_soft_refresh(&k.engine_key()).unwrap();
            status["request_id"] = json!(case);
            let result = invoke(&h, "compaction.step", &status).await;
            let answer: Value = serde_json::from_slice(&result).unwrap();
            assert_eq!(
                answer["answer"], "refuse",
                "resident={resident} {case}: {answer}"
            );
            assert_eq!(answer["provider_code"], expected);
            answers.push(result);
        }
        assert_eq!(answers[0], answers[1]);
    }
}
