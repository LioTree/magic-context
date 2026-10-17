use super::*;

fn normalized_receipt(mut value: Value) -> Vec<u8> {
    if let Some(compaction) = value.get_mut("compaction") {
        compaction["compaction_id"] = json!("independent-conversation");
    }
    serde_json::to_vec(&value).unwrap()
}

fn normalized_measurement(store: &McStore) -> Value {
    let mut value = serde_json::to_value(store.load("s").unwrap().meta.tail_hygiene_baseline).unwrap();
    if let Some(object) = value.as_object_mut() {
        object.remove("computed_at_ms");
    }
    value
}

fn acknowledge(request: &mut Value, view: &Value) {
    request["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
}

async fn run_sequence(harness: &str, random_seed: u64) {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (ha, mut ba, sa, _) = handler(a.path(), Arc::new(NoReads::default()));
    let mut ha = ha.with_startup_provider_resident_enabled(true);
    let (hb, mut bb, sb, _) = handler(b.path(), Arc::new(NoReads::default()));
    let mut hb = hb.with_startup_provider_resident_enabled(false);
    ba.harness = harness.into();
    bb.harness = harness.into();
    let mut views = Vec::new();
    let mut newest = 30;
    for (h, binding, store) in [(&ha, &ba, &sa), (&hb, &bb, &sb)] {
        let mut start = setup();
        start["harness"] = json!(harness);
        answer(h.provider_setup(binding.clone(), &start).await);
        let mut boot = step("initial", (1..=newest).map(message).collect(), newest);
        boot["harness"] = json!(harness);
        let initial = answer(h.provider_step(binding.clone(), &boot).await);
        store.replace_compartments("s", &compartments()).unwrap();
        store.arm_soft_refresh("s").unwrap();
        let mut fold = step("first", vec![], newest);
        fold["harness"] = json!(harness);
        acknowledge(&mut fold, &initial);
        views.push(answer(h.provider_step(binding.clone(), &fold).await));
    }
    let mut rng = random_seed;
    let mut choices = [0usize; 8];
    for pass in 0..48 {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let choice = ((rng >> 32) % 8) as usize;
        choices[choice] += 1;
        let mut appended = Vec::new();
        if choice == 0 || choice == 6 {
            newest += 1;
            let mut entry = message(newest);
            entry["message"]["parts"][0]["text"] = json!(format!("seed {random_seed}, pass {pass}: café 🦀 \\\" [mc:12]"));
            appended.push(entry);
        }
        if choice == 3 {
            // A new pool forces eviction/reload without replacing any durable row.
            ha.provider_resident = Arc::new(crate::providers::resident_hooks::ResidentHooks::enabled(true));
        }
        if choice == 4 {
            // Reconstruct serving handlers over the committed stores, discarding decoded caches.
            let mut next = McHandler::new();
            next.store.set(sa.clone()).ok().unwrap();
            next.provider_runner = Arc::new(NoReads::default());
            ha = next.with_startup_provider_resident_enabled(true);
            let mut next = McHandler::new();
            next.store.set(sb.clone()).ok().unwrap();
            next.provider_runner = Arc::new(NoReads::default());
            hb = next.with_startup_provider_resident_enabled(false);
        }
        let mut answers = Vec::new();
        for (index, (h, binding, store)) in [(&ha, &ba, &sa), (&hb, &bb, &sb)].into_iter().enumerate() {
            let mut rows = store.load_compartments("s").unwrap();
            match choice {
                1 => {
                    for row in &mut rows {
                        row.p1 = Some(format!("recompiled {random_seed}/{pass}/{}", row.sequence));
                        row.content = row.p1.clone().unwrap();
                    }
                }
                2 => {
                    // Repeatedly advance the cut so the retained prefix SHA must absorb new parts.
                    rows = vec![mc_store::StoredCompartment {
                        sequence: 1, start_message: 1, end_message: newest as i64 - 2,
                        end_message_id: format!("m{}#0", newest - 2), title: "advanced".into(),
                        content: format!("coverage advance {pass}"), p1: Some(format!("coverage advance {pass}")),
                        importance: 50, ..Default::default()
                    }];
                }
                5 => { rows.pop(); }
                7 => { rows = compartments(); }
                _ => {}
            }
            if matches!(choice, 1 | 2 | 5 | 7) {
                store.replace_compartments("s", &rows).unwrap();
            }
            store.arm_soft_refresh("s").unwrap();
            let mut request = step(&format!("review-{random_seed}-{pass}"), appended.clone(), newest);
            request["harness"] = json!(harness);
            if choice == 6 {
                request["model"] = json!(format!("model-{}", pass % 3));
                request["prefix_rebuilding"] = json!({"reason":"model_switch"});
            }
            acknowledge(&mut request, &views[index]);
            answers.push(answer(h.provider_step(binding.clone(), &request).await));
        }
        assert_eq!(normalized_receipt(answers[0].clone()), normalized_receipt(answers[1].clone()),
            "{harness}, seed {random_seed}, pass {pass}, choice {choice}: served receipt bytes");
        assert_eq!(normalized_measurement(&sa), normalized_measurement(&sb),
            "{harness}, seed {random_seed}, pass {pass}, choice {choice}: effective baseline");
        for (index, response) in answers.into_iter().enumerate() {
            if response["answer"] == "compaction_message" { views[index] = response; }
        }
    }
    assert!(choices.iter().all(|&count| count > 0), "all adversarial operations must execute: {choices:?}");
}

#[tokio::test]
async fn review_randomized_resident_sequence_matches_replay() {
    for harness in ["opencode", "opencode2"] {
        for seed in [0x91f02, 0x319fe, 0x7d00d] {
            run_sequence(harness, seed).await;
        }
    }
}

#[tokio::test]
async fn review_over_cap_policy_index_falls_back_without_refusal() {
    let mut results = Vec::new();
    for enabled in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (h, binding, store, _) = handler(dir.path(), Arc::new(NoReads::default()));
        let mut h = h.with_startup_provider_resident_enabled(enabled);
        let view = seed(&h, &binding, &store).await;
        // Saturate the derived policy index directly, keeping native replay small.
        // All inserted rows have a valid policy schema; the full path can rebuild it.
        store.execute_tag_sql_for_test("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100001), template AS (SELECT * FROM mc_provider_policy_parts_v1 LIMIT 1) INSERT INTO mc_provider_policy_parts_v1 SELECT conv_key,lineage_id,ordinal,'pressure-'||i,json_set(policy_json,'$.block_id','pressure-'||i,'$.measurement.key','pressure-'||i),session FROM template,n").unwrap();
        h.provider_resident = Arc::new(crate::providers::resident_hooks::ResidentHooks::enabled(enabled));
        store.arm_soft_refresh("s").unwrap();
        let mut request = step("over-cap", vec![], 30);
        acknowledge(&mut request, &view);
        let result = h.provider_step(binding, &request).await;
        assert!(result.is_ok(), "resident={enabled}: over-cap derived index must fall back, not refuse: {result:?}");
        results.push(normalized_receipt(serde_json::from_slice(&result.unwrap()).unwrap()));
    }
    assert_eq!(results[0], results[1]);
}

#[tokio::test]
async fn review_external_native_edit_invalidates_cached_tail() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let mut answers = Vec::new();
    for (dir, enabled) in [(a.path(), true), (b.path(), false)] {
        let (h, binding, store, _) = handler(dir, Arc::new(NoReads::default()));
        let h = h.with_startup_provider_resident_enabled(enabled);
        let mut view = seed(&h, &binding, &store).await;
        store.arm_soft_refresh("s").unwrap();
        let mut request = step("prime-edit", vec![], 30);
        acknowledge(&mut request, &view);
        let primed = answer(h.provider_step(binding.clone(), &request).await);
        if primed["answer"] == "compaction_message" { view = primed; }
        let external = rusqlite::Connection::open(dir.join("store.db")).unwrap();
        let changed = external.execute("UPDATE mc_provider_messages_v1 SET message_bytes=CAST(json_set(CAST(message_bytes AS TEXT),'$.parts[0].text','externally changed café 🦀') AS BLOB) WHERE ordinal=25", []).unwrap();
        assert_eq!(changed, 1);
        drop(external);
        let mut rows = store.load_compartments("s").unwrap();
        rows[0].p1 = Some("force a visible fold after the external write".into());
        store.replace_compartments("s", &rows).unwrap();
        store.arm_soft_refresh("s").unwrap();
        request["request_id"] = json!("external-edit");
        acknowledge(&mut request, &view);
        answers.push(answer(h.provider_step(binding, &request).await));
    }
    assert_eq!(normalized_receipt(answers[0].clone()), normalized_receipt(answers[1].clone()));
    assert!(serde_json::to_string(&answers[0]).unwrap().contains("externally changed café"));
}

#[tokio::test]
async fn review_coverage_advance_matches_fresh_prefix_authority() {
    let dir = tempfile::tempdir().unwrap();
    let (h, binding, store, key) = handler(dir.path(), Arc::new(NoReads::default()));
    let h = h.with_startup_provider_resident_enabled(true);
    let mut view = seed(&h, &binding, &store).await;
    for through in [20, 22, 24, 26] {
        let mut rows = store.load_compartments("s").unwrap();
        let previous = rows.last().unwrap().end_message;
        if through > previous {
            rows.push(mc_store::StoredCompartment {
                sequence: rows.last().unwrap().sequence + 1,
                start_message: previous + 1,
                end_message: through,
                end_message_id: format!("m{through}#0"),
                title: format!("new coverage {through}"),
                content: format!("new coverage {through}"),
                p1: Some(format!("new coverage {through}")),
                importance: 50,
                ..Default::default()
            });
        }
        rows[0].p1 = Some(format!("fold through {through}"));
        store.replace_compartments("s", &rows).unwrap();
        store.arm_soft_refresh("s").unwrap();
        let mut request = step(&format!("advance-{through}"), vec![], 30);
        acknowledge(&mut request, &view);
        let response = answer(h.provider_step(binding.clone(), &request).await);
        if response["answer"] == "compaction_message" { view = response; }
        let fresh = store.read_provider_resident_policy(&key.store_key(), |index, counters| {
            Ok(crate::providers::fold_prefix::FoldPrefix::build(&index.all_parts()?, &counters["engine_policy"]).unwrap())
        }).unwrap();
        let lease = h.provider_resident.begin(store.tag_cache_namespace(), &key).unwrap().unwrap();
        let retained = lease.state.fold_prefix.as_ref().unwrap();
        assert_eq!(retained.through, through as u64, "the fixture must really advance coverage");
        assert_eq!(retained.through, fresh.through);
        assert_eq!(retained.parts, fresh.parts);
        assert_eq!(retained.signature(&[]), fresh.signature(&[]), "advanced prefix must equal a fresh authority read");
        lease.publish();
    }
}

#[tokio::test]
async fn review_late_hook_answer_invalidates_same_ordinal_tail() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let mut answers = Vec::new();
    for (dir, enabled) in [(a.path(), true), (b.path(), false)] {
        let (h, binding, store, key) = handler(dir, Arc::new(NoReads::default()));
        let h = h.with_startup_provider_resident_enabled(enabled);
        let mut view = seed(&h, &binding, &store).await;
        store.arm_soft_refresh("s").unwrap();
        let mut request = step("prime-hook", vec![], 30);
        acknowledge(&mut request, &view);
        let primed = answer(h.provider_step(binding.clone(), &request).await);
        if primed["answer"] == "compaction_message" { view = primed; }
        let lineage = ProviderLineage { lineage_id: "L".into(), first_ordinal: 1, descends_from: None, through_ordinal: None };
        hook_answer(&store, &key, &lineage, &message(25), "pre_user",
            ("", json!([{"op":"append","block":0,"text":" late hook café 🦀"}]), &[0]));
        let mut rows = store.load_compartments("s").unwrap();
        rows[0].p1 = Some("force a visible fold after the hook".into());
        store.replace_compartments("s", &rows).unwrap();
        store.arm_soft_refresh("s").unwrap();
        request["request_id"] = json!("late-hook");
        request["served_through_ordinal"] = json!(30);
        acknowledge(&mut request, &view);
        answers.push(answer(h.provider_step(binding, &request).await));
    }
    assert_eq!(normalized_receipt(answers[0].clone()), normalized_receipt(answers[1].clone()));
    assert!(serde_json::to_string(&answers[0]).unwrap().contains("late hook café"));
}

#[tokio::test]
async fn review_appended_compartments_preserve_replay_identity() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (ha, ba, sa, _) = handler(a.path(), Arc::new(NoReads::default()));
    let ha = ha.with_startup_provider_resident_enabled(true);
    let (hb, bb, sb, _) = handler(b.path(), Arc::new(NoReads::default()));
    let hb = hb.with_startup_provider_resident_enabled(false);
    let mut views = [seed(&ha, &ba, &sa).await, seed(&hb, &bb, &sb).await];
    for through in [20, 22, 24, 26] {
        let mut answers = Vec::new();
        for (index, (h, binding, store)) in [(&ha, &ba, &sa), (&hb, &bb, &sb)].into_iter().enumerate() {
            let mut rows = store.load_compartments("s").unwrap();
            let previous = rows.last().unwrap().end_message;
            if through > previous {
                rows.push(mc_store::StoredCompartment {
                    sequence: rows.last().unwrap().sequence + 1,
                    start_message: previous + 1, end_message: through,
                    end_message_id: format!("m{through}#0"), title: format!("new coverage {through}"),
                    content: format!("new coverage {through}"), p1: Some(format!("new coverage {through}")),
                    importance: 50, ..Default::default()
                });
            }
            rows[0].p1 = Some(format!("fold through {through}"));
            store.replace_compartments("s", &rows).unwrap();
            store.arm_soft_refresh("s").unwrap();
            let mut request = step(&format!("append-compartment-{through}"), vec![], 30);
            acknowledge(&mut request, &views[index]);
            answers.push(answer(h.provider_step(binding.clone(), &request).await));
        }
        assert_eq!(normalized_receipt(answers[0].clone()), normalized_receipt(answers[1].clone()), "served receipt at coverage {through}");
        assert_eq!(normalized_measurement(&sa)["content_signature"], normalized_measurement(&sb)["content_signature"], "baseline content signature at coverage {through}");
        assert_eq!(normalized_measurement(&sa), normalized_measurement(&sb), "effective baseline at coverage {through}");
        for (index, response) in answers.into_iter().enumerate() {
            if response["answer"] == "compaction_message" { views[index] = response; }
        }
    }
}

#[tokio::test]
async fn review_concurrent_two_session_hooks_match_replay() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (ha, ba, _sa, _) = handler(a.path(), Arc::new(NoReads::default()));
    let ha = ha.with_startup_provider_resident_enabled(true);
    let (hb, bb, _sb, _) = handler(b.path(), Arc::new(NoReads::default()));
    let hb = hb.with_startup_provider_resident_enabled(false);
    for h in [&ha, &hb] {
        for session in ["s", "sibling"] {
            let mut binding = if std::ptr::eq(h, &ha) { ba.clone() } else { bb.clone() };
            binding.session = session.into();
            let mut start = setup(); start["session"] = json!(session);
            answer(h.provider_setup(binding, &start).await);
        }
    }
    for ordinal in 1..=12 {
        let mut replies = Vec::new();
        for (h, binding) in [(&ha, &ba), (&hb, &bb)] {
            let make_hook = |session: &str| {
                let mut p = json!({"session":session,"harness":"opencode","params":setup()["params"],
                    "lineage_id":"L","subject_mid":format!("m{ordinal}"),"subject_ordinal":ordinal,
                    "message":message(ordinal)["message"],"hook":"pre_user","blocks":[format!("raw {ordinal}")],"step_id":"step"});
                if ordinal > 1 { p["served_through_ordinal"] = json!(ordinal - 1); }
                p
            };
            let p = make_hook("s"); let q = make_hook("sibling");
            let mut sibling = binding.clone(); sibling.session = "sibling".into();
            let (left, right) = tokio::join!(h.provider_hook(binding.clone(), &p), h.provider_hook(sibling, &q));
            replies.push((left.unwrap(), right.unwrap()));
        }
        assert_eq!(replies[0], replies[1], "two concurrent session hooks at ordinal {ordinal}");
    }
    assert_eq!(ha.provider_resident.stats()["sessions"], 2);
}

#[tokio::test]
async fn review_memory_epoch_and_lane_rebuild_match_replay() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (ha, mut ba, sa, _) = handler(a.path(), Arc::new(NoReads::default()));
    let ha = ha.with_startup_provider_resident_enabled(true);
    let (hb, mut bb, sb, _) = handler(b.path(), Arc::new(NoReads::default()));
    let hb = hb.with_startup_provider_resident_enabled(false);
    ba.config.memory_enabled = true; bb.config.memory_enabled = true;
    let mut views = [seed(&ha, &ba, &sa).await, seed(&hb, &bb, &sb).await];
    for pass in 0..6 {
        let mut answers = Vec::new();
        for (index, (h, binding, store)) in [(&ha, &ba, &sa), (&hb, &bb, &sb)].into_iter().enumerate() {
            let key = Key::new(binding, "s", "opencode").unwrap();
            let work = h.provider_work(store, binding.clone(), key).unwrap();
            match pass {
                0 => { store.insert_memory(mc_store::InsertMemoryInput {
                    project_path: &work.project_path, route_project_root: None, category: "architecture",
                    content: "independent review memory café 🦀", source_session_id: Some("s"),
                    source_type: Some("historian"), importance: Some(50), expires_at: None,
                    metadata_json: None, now_ms: 1,
                }).unwrap(); }
                1 => { store.set_project_memory_epoch_for_test(&work.project_path, 17).unwrap(); }
                2 => { store.set_project_memory_epoch_for_test(&work.project_path, 18).unwrap(); }
                _ => {}
            }
            store.arm_soft_refresh("s").unwrap();
            let mut request = step(&format!("memory-recomp-{pass}"), vec![], 30);
            acknowledge(&mut request, &views[index]);
            if pass == 3 { request["prefix_rebuilding"] = json!({"reason":"pipeline_switch"}); }
            if pass == 4 { request["model"] = json!("changed-model"); request["prefix_rebuilding"] = json!({"reason":"model_switch"}); }
            answers.push(answer(h.provider_step(binding.clone(), &request).await));
        }
        assert_eq!(normalized_receipt(answers[0].clone()), normalized_receipt(answers[1].clone()), "memory/epoch/recomp pass {pass}");
        assert_eq!(normalized_measurement(&sa), normalized_measurement(&sb));
        for (index, response) in answers.into_iter().enumerate() { if response["answer"] == "compaction_message" { views[index] = response; } }
    }
}

#[tokio::test]
async fn review_native_recomp_reset_remains_usable() {
    for enabled in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (h, binding, store, _) = handler(dir.path(), Arc::new(NoReads::default()));
        let h = h.with_startup_provider_resident_enabled(enabled);
        seed(&h, &binding, &store).await;
        let before = store.load("s").unwrap();
        let result = store.reset_session_for_recomp("s", before.row_version);
        assert!(result.is_ok(), "resident={enabled}: native recomp must accept the codec's own persisted format: {result:?}");
        assert!(!store.load("s").unwrap().meta.initialized);
    }
}

#[tokio::test]
#[ignore = "subprocess fixture killed by review_kill_during_fold_reopens_with_full_replay_bytes"]
async fn review_fold_crash_child() {
    use std::io::Write;
    let dir = std::path::PathBuf::from(std::env::var_os("MC_REVIEW_FOLD_CRASH_DIR").unwrap());
    let (h, binding, store, _) = handler(&dir, Arc::new(NoReads::default()));
    let h = h.with_startup_provider_resident_enabled(true);
    let view = seed(&h, &binding, &store).await;
    store.prepare_provider_wal();
    let mut rows = store.load_compartments("s").unwrap();
    rows[0].p1 = Some("crash fold visible delta".into());
    store.replace_compartments("s", &rows).unwrap();
    store.arm_soft_refresh("s").unwrap();
    let mut request = step("interrupted-fold", vec![], 30);
    acknowledge(&mut request, &view);
    std::fs::write(dir.join("pending.json"), serde_json::to_vec(&request).unwrap()).unwrap();
    crate::transform::install_transform_attempt_hook("s", || {
        println!("REVIEW_FOLD_IN_PROGRESS");
        std::io::stdout().flush().unwrap();
        loop { std::thread::park(); }
    });
    let _ = h.provider_step(binding, &request).await;
    panic!("the parent must kill the child during the fold attempt");
}

#[tokio::test]
async fn review_kill_during_fold_reopens_with_full_replay_bytes() {
    use std::io::BufRead;
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "providers::compaction::host_tests::resident_restart_tests::independent_review::review_fold_crash_child", "--ignored", "--nocapture"])
        .env("MC_REVIEW_FOLD_CRASH_DIR", a.path())
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            if line.unwrap().contains("REVIEW_FOLD_IN_PROGRESS") { let _ = send.send(()); }
        }
    });
    let reached = receive.recv_timeout(Duration::from_secs(20)).is_ok();
    let _ = child.kill(); child.wait().unwrap(); reader.join().unwrap();
    assert!(reached, "must reach the real transform attempt before SIGKILL");
    // Copy both closed crash databases (the provider store and the session
    // context store), each with its committed WAL. Copying only store.db pairs
    // the copy with an empty context.db, which is a different conversation.
    for database in ["store.db", "context.db"] {
        for suffix in ["", "-wal"] {
            let name = format!("{database}{suffix}");
            let source = a.path().join(&name);
            if source.exists() { std::fs::copy(source, b.path().join(name)).unwrap(); }
        }
    }
    let (ha, ba, sa, _) = handler(a.path(), Arc::new(NoReads::default()));
    let ha = ha.with_startup_provider_resident_enabled(true);
    let mut request: Value = serde_json::from_slice(&std::fs::read(a.path().join("pending.json")).unwrap()).unwrap();
    request["request_id"] = json!("after-crash");
    let actual = answer(ha.provider_step(ba, &request).await);
    let (hb, mut bb, sb, _) = handler(b.path(), Arc::new(NoReads::default()));
    let hb = hb.with_startup_provider_resident_enabled(false);
    bb.project_root = a.path().into();
    let expected = answer(hb.provider_step(bb, &request).await);
    assert_eq!(normalized_receipt(actual), normalized_receipt(expected));
    assert_eq!(normalized_measurement(&sa), normalized_measurement(&sb));
}


fn branch_message(ordinal: u64, branch: &str) -> Value {
    let mid = format!("{branch}-m{ordinal}");
    json!({"ordinal":ordinal,"mid":mid,"message":{"info":{"id":mid,"role":"assistant","time":{"created":1}},"parts":[
        {"id":format!("{branch}-p{ordinal}"),"type":"tool","tool":"bash","callID":format!("{branch}-call{ordinal}"),
         "state":{"status":"completed","input":{"command":"inspect"},"output":format!("{branch} output {ordinal} café 🦀 ").repeat(60)}}]}})
}

/// Between folds, the conversation forks to new lineages whose fork point is
/// after the summarized prefix (ordinal 20), and the session configuration
/// (protected tokens, protected tools, history budget) changes. The resident
/// step engine keeps decoded tail, hygiene and serialized output caches across
/// those changes; it must still serve exactly what the non-resident test
/// oracle serves on the same operations.
#[tokio::test]
async fn review_tail_descent_and_config_changes_match_replay() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (ha, mut ba, sa, _) = handler(a.path(), Arc::new(NoReads::default()));
    let ha = ha.with_startup_provider_resident_enabled(true);
    let (hb, mut bb, sb, _) = handler(b.path(), Arc::new(NoReads::default()));
    let hb = hb.with_startup_provider_resident_enabled(false);
    let mut views = [seed(&ha, &ba, &sa).await, seed(&hb, &bb, &sb).await];
    let mut lineage = "L".to_string();
    let mut newest = 30u64;
    for pass in 0..10 {
        let mut descent = None;
        let mut appended = Vec::new();
        match pass {
            0 => { descent = Some(("L".to_string(), 27u64)); lineage = "c1".into(); newest = 28; appended.push(branch_message(28, "c1")); }
            1 => { for binding in [&mut ba, &mut bb] { binding.config.protected_tokens_user = Some(1500); } }
            2 => { descent = Some(("c1".to_string(), 25)); lineage = "c2".into(); newest = 27; appended.extend([branch_message(26, "c2"), branch_message(27, "c2")]); }
            3 => { for binding in [&mut ba, &mut bb] { binding.config.protected_tools.insert("bash".into(), 3); } }
            4 => { newest = 28; appended.push(branch_message(28, "c2")); }
            5 => { for binding in [&mut ba, &mut bb] { binding.history_budget_tokens = 1500.0; } }
            6 => { for binding in [&mut ba, &mut bb] { binding.config.protected_tools.clear(); binding.config.protected_tokens_user = Some(0); } }
            7 => { descent = Some(("c2".to_string(), 28)); lineage = "c3".into(); newest = 29; appended.push(branch_message(29, "c3")); }
            _ => {}
        }
        let mut answers = Vec::new();
        for (index, (h, binding, store)) in [(&ha, &ba, &sa), (&hb, &bb, &sb)].into_iter().enumerate() {
            let mut rows = store.load_compartments("s").unwrap();
            rows[0].p1 = Some(format!("visible fold {pass}"));
            store.replace_compartments("s", &rows).unwrap();
            store.arm_soft_refresh("s").unwrap();
            let mut request = step(&format!("descent-config-{pass}"), appended.clone(), newest);
            request["lineage_id"] = json!(lineage);
            request["newest"]["mid"] = json!(appended.last().map_or_else(|| format!("{lineage}-m{newest}"), |m| m["mid"].as_str().unwrap().to_string()));
            if let Some((parent, through)) = &descent {
                request["descends_from"] = json!({"lineage_id":parent,"through_ordinal":through});
            }
            acknowledge(&mut request, &views[index]);
            answers.push(h.provider_step(binding.clone(), &request).await);
        }
        let render = |answer: &Result<Vec<u8>, HandlerOutcome>| match answer {
            Ok(bytes) => normalized_receipt(serde_json::from_slice(bytes).unwrap()),
            Err(error) => format!("refusal {error:?}").into_bytes(),
        };
        assert_eq!(String::from_utf8_lossy(&render(&answers[0])), String::from_utf8_lossy(&render(&answers[1])),
            "pass {pass} lineage {lineage}: served receipt");
        assert_eq!(normalized_measurement(&sa), normalized_measurement(&sb), "pass {pass}: effective baseline");
        for (index, answer) in answers.into_iter().enumerate() {
            if let Ok(bytes) = answer {
                let value: Value = serde_json::from_slice(&bytes).unwrap();
                if value["answer"] == "compaction_message" { views[index] = value; }
            }
        }
    }
}

fn tag_dump(dir: &std::path::Path) -> Vec<(i64, String)> {
    let mut rows = Vec::new();
    for database in ["store.db", "context.db"] {
        let Ok(conn) = rusqlite::Connection::open_with_flags(dir.join(database), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { continue };
        let Ok(mut statement) = conn.prepare("SELECT tag_number, block_id FROM mc_tags ORDER BY tag_number, block_id") else { continue };
        rows.extend(statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().map(Result::unwrap));
    }
    rows
}

/// Summaries advance to cover every message the session has, so the fold's
/// unsummarized tail is empty, and later folds append one message at a time.
/// The resident step engine's fold must serve what the non-resident test
/// oracle serves, never a refusal. The tag-table comparison
/// is a guard for a tail with no tagged blocks; this fixture mints no tags, so
/// today only the receipt and baseline comparisons can fail.
#[tokio::test]
async fn review_summaries_covering_the_newest_message_match_replay() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (ha, ba, sa, _) = handler(a.path(), Arc::new(NoReads::default()));
    let ha = ha.with_startup_provider_resident_enabled(true);
    let (hb, bb, sb, _) = handler(b.path(), Arc::new(NoReads::default()));
    let hb = hb.with_startup_provider_resident_enabled(false);
    let mut views = [seed(&ha, &ba, &sa).await, seed(&hb, &bb, &sb).await];
    let mut newest = 30u64;
    let mut differences = Vec::new();
    for pass in 0..4 {
        let mut answers = Vec::new();
        let appended = if pass == 0 { vec![] } else { newest += 1; vec![message(newest)] };
        for (index, (h, binding, store)) in [(&ha, &ba, &sa), (&hb, &bb, &sb)].into_iter().enumerate() {
            let mut rows = store.load_compartments("s").unwrap();
            let through = if pass == 0 { 30 } else { newest as i64 - 1 };
            let last = rows.last().unwrap().clone();
            if through > last.end_message {
                rows.push(mc_store::StoredCompartment {
                    sequence: last.sequence + 1, start_message: last.end_message + 1, end_message: through,
                    end_message_id: format!("m{through}#0"), title: format!("cover {through}"),
                    content: format!("cover {through}"), p1: Some(format!("cover {through}")),
                    importance: 50, ..Default::default()
                });
            }
            rows[0].p1 = Some(format!("visible fold {pass}"));
            store.replace_compartments("s", &rows).unwrap();
            store.arm_soft_refresh("s").unwrap();
            let mut request = step(&format!("covered-{pass}"), appended.clone(), newest);
            acknowledge(&mut request, &views[index]);
            answers.push(h.provider_step(binding.clone(), &request).await);
        }
        let render = |answer: &Result<Vec<u8>, HandlerOutcome>| match answer {
            Ok(bytes) => String::from_utf8_lossy(&normalized_receipt(serde_json::from_slice(bytes).unwrap())).into_owned(),
            Err(error) => format!("refusal {error:?}"),
        };
        // Collect every difference rather than stopping at the first, so one run
        // shows whether a refusal is followed by further divergence.
        if render(&answers[0]) != render(&answers[1]) {
            let (left, right) = (render(&answers[0]), render(&answers[1]));
            let at = left.bytes().zip(right.bytes()).take_while(|(l, r)| l == r).count().saturating_sub(80);
            let window = |text: &str| text.get(at..).unwrap_or(text).chars().take(400).collect::<String>();
            differences.push(format!("pass {pass}: served receipt, first difference near byte {at}\n  resident: {}\n  replay:   {}", window(&left), window(&right)));
        }
        if tag_dump(a.path()) != tag_dump(b.path()) {
            differences.push(format!("pass {pass}: minted tags\n  resident: {:?}\n  replay:   {:?}", tag_dump(a.path()), tag_dump(b.path())));
        }
        if normalized_measurement(&sa) != normalized_measurement(&sb) {
            differences.push(format!("pass {pass}: effective baseline differs"));
        }
        for (index, answer) in answers.into_iter().enumerate() {
            if let Ok(bytes) = answer {
                let value: Value = serde_json::from_slice(&bytes).unwrap();
                if value["answer"] == "compaction_message" { views[index] = value; }
            }
        }
    }
    let key = Key::new(&ba, "s", "opencode").unwrap();
    let lease = ha.provider_resident.begin(sa.tag_cache_namespace(), &key).unwrap().unwrap();
    println!("REVIEW_COVERED_TAIL_PASSES={} TAGS={}", lease.state.fold_tail_passes, tag_dump(a.path()).len());
    lease.publish();
    assert!(differences.is_empty(), "resident differs from replay:\n{}", differences.join("\n"));
}
