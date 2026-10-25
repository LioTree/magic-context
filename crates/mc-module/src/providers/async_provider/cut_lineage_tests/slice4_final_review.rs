//! Opt-in independent campaigns for retained cuts and branch selection.
use super::*;

fn enabled() -> bool {
    std::env::var("MC_REVIEW_S4FINAL").as_deref() == Ok("1")
}

fn complete_tool_pairs(pair: &Pair, served: &[Value]) -> Vec<String> {
    let source = pair.transcript.entries.lock().unwrap();
    let mut fallback = BTreeMap::new();
    for window in source.windows(2) {
        let call = &window[0].message["message"]["content"];
        let result = &window[1].message["message"]["toolCallId"];
        if let Some(id) = result.as_str() {
            for part in call.as_array().into_iter().flatten() {
                if part["type"] == "toolCall" && part["id"].is_null() {
                    fallback.insert(part["arguments"].to_string(), id.to_owned());
                }
            }
        }
    }
    let ids = |messages: &[Value]| {
        let (mut calls, mut results) = (
            std::collections::BTreeSet::new(),
            std::collections::BTreeSet::new(),
        );
        for envelope in messages {
            let message = envelope.get("message").unwrap_or(envelope);
            if message["role"] == "toolResult" {
                if let Some(id) = message["toolCallId"].as_str() {
                    results.insert(id.to_owned());
                }
            }
            for part in message["parts"].as_array().into_iter().flatten() {
                if part["type"] == "tool" {
                    let id = part["callID"].as_str().unwrap().to_owned();
                    calls.insert(id.clone());
                    if part["state"]["status"] == "completed" && !part["state"]["output"].is_null()
                    {
                        results.insert(id);
                    }
                }
            }
            for part in message["content"].as_array().into_iter().flatten() {
                match part["type"].as_str() {
                    Some("tool_use" | "toolCall" | "tool_call") => {
                        if let Some(id) = part
                            .get("id")
                            .or_else(|| part.get("tool_call_id"))
                            .and_then(Value::as_str)
                            .or_else(|| {
                                fallback
                                    .get(&part["arguments"].to_string())
                                    .map(String::as_str)
                            })
                        {
                            calls.insert(id.to_owned());
                        }
                    }
                    Some("tool_result") => {
                        if let Some(id) = part
                            .get("tool_use_id")
                            .or_else(|| part.get("tool_call_id"))
                            .and_then(Value::as_str)
                        {
                            results.insert(id.to_owned());
                        }
                    }
                    _ => {}
                }
            }
        }
        (calls, results)
    };
    let original = source.iter().map(|e| e.message.clone()).collect::<Vec<_>>();
    let (source_calls, source_results) = ids(&original);
    let (calls, results) = ids(served);
    let complete = source_calls
        .intersection(&source_results)
        .collect::<std::collections::BTreeSet<_>>();
    calls
        .symmetric_difference(&results)
        .filter(|id| complete.contains(id))
        .cloned()
        .collect()
}

fn checked(pair: &Pair, seed: u64, before: Option<u64>) -> (usize, usize) {
    let counts = (decisions_agree(pair, seed), verify_passes(pair, seed));
    assert!(
        content_problems(pair, before).is_empty(),
        "{:?} seed {seed}: {:?}",
        pair.profile,
        content_problems(pair, before)
    );
    assert!(
        pair.engine_mismatches.borrow().is_empty(),
        "{:?}",
        pair.engine_mismatches.borrow()
    );
    let mut review = pair.review.borrow_mut();
    review.check_served_edits();
    assert!(
        review.violations.is_empty(),
        "{:?} seed {seed}: {:?}",
        pair.profile,
        review.violations
    );
    assert!(pair
        .resident
        .runner
        .reads_below_floor
        .lock()
        .unwrap()
        .is_empty());
    if let Some((version, _, model, _)) = newest_view(pair) {
        if before.is_none_or(|before| version > before) {
            let messages: Vec<Value> = serde_json::from_str(&model).unwrap();
            assert_eq!(
                complete_tool_pairs(pair, &messages),
                Vec::<String>::new(),
                "{:?} seed {seed}: incomplete tool pair",
                pair.profile
            );
        }
    }
    counts
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "independent final review; requires MC_REVIEW_S4FINAL=1"]
async fn final_pair_checker_detects_removed_results_in_every_codec() {
    if !enabled() {
        return;
    }
    for profile in PROFILES {
        let pair = Pair::open_with(profile, false, Some("L"), false, false).await;
        pair.append(4);
        let mut served = pair
            .transcript
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.message.clone())
            .collect::<Vec<_>>();
        assert!(complete_tool_pairs(&pair, &served).is_empty());
        if profile == Profile::OpenCode {
            served[1]["parts"][1]["state"]
                .as_object_mut()
                .unwrap()
                .remove("output");
        } else {
            served.remove(2);
        }
        let expected = if profile == Profile::Pi {
            "synth-tool-2-1-todowrite-70cae7347fcc"
        } else {
            "call1"
        };
        assert_eq!(
            complete_tool_pairs(&pair, &served),
            vec![expected.to_owned()],
            "{profile:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "independent final review; requires MC_REVIEW_S4FINAL=1"]
async fn final_fresh_campaign_matches_full_processing() {
    if !enabled() {
        return;
    }
    let mut seeds = Rng(15_506_593_889_518_924_707);
    let (mut decisions, mut passes, mut sessions, mut host_rewinds) = (0, 0, 0, 0);
    for profile in PROFILES {
        for _ in 0..4 {
            let seed = seeds.next();
            let mut rng = Rng(seed);
            let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
            review_enable(&pair);
            attest(&pair.resident);
            attest(&pair.oracle);
            pair.append(120 + 4 * rng.below(12));
            let mut previous = 0;
            for cut in 0..3 {
                if cut != 0 {
                    pair.append(48 + 4 * rng.below(8));
                }
                let first = review_next_cut(
                    &mut pair,
                    &mut rng,
                    previous,
                    &format!("fresh-{seed}-{cut}"),
                    rng_seed_bit(seed, cut),
                )
                .await;
                // The production runner reports its physical floor after descent.
                *pair.resident.runner.head.lock().unwrap() =
                    Some(cut_head(&pair, &format!("fresh-{seed}-{cut}"), first));
                let (d, p) = checked(&pair, seed, None);
                decisions += d;
                passes += p;
                for _ in 0..16 {
                    let before = newest_version(&pair);
                    match rng.below(8) {
                        0 => {
                            review_restart(&pair);
                            pair.notice(&mut rng, None).await;
                        }
                        1 => {
                            pair.append_salted(4 + 4 * rng.below(3), seed ^ pair.seq);
                            pair.notice(&mut rng, None).await;
                        }
                        2 => {
                            review_complete_turn(&pair);
                            review_ride(&mut pair, "surface_change").await;
                        }
                        3 => {
                            let last = newest_ordinal(&pair);
                            if last > first + 16 {
                                let end = (first + 4 + rng.below(last - first - 12)) / 4 * 4 + 3;
                                review_history(&mut pair, end).await;
                            }
                            review_complete_turn(&pair);
                            pair.notice(&mut rng, None).await;
                        }
                        4 => {
                            let held = newest_view(&pair)
                                .map(|(v, view, _, _)| (v, serde_json::to_string(&view).unwrap()));
                            pair.notice(&mut rng, None).await;
                            if let (Some(held), Some((v, view, _, _))) = (held, newest_view(&pair))
                            {
                                if v == held.0 {
                                    assert_eq!(
                                        serde_json::to_string(&view).unwrap(),
                                        held.1,
                                        "a reused view changed bytes"
                                    );
                                }
                            }
                        }
                        5 => {
                            let tags = pair.window_tags(first);
                            if !tags.is_empty() {
                                let tag = tags[rng.below(tags.len() as u64) as usize];
                                pair.review.borrow_mut().requested.insert(tag);
                                let request = json!({"name":"ctx_reduce","arguments":{"drop":tag.to_string()}});
                                pair.both("fresh drop", |side| {
                                    Box::pin(side.dispatch(request.clone()))
                                })
                                .await;
                            }
                            pair.notice(&mut rng, None).await;
                        }
                        _ => {
                            pair.append(1 + rng.below(6));
                            pair.notice(&mut rng, None).await;
                        }
                    }
                    let (d, p) = checked(&pair, seed, before);
                    decisions += d;
                    passes += p;
                    pair.check_cut(first);
                }
                if matches!(profile, Profile::OpenCode | Profile::Pi) {
                    slice4_boundaries::campaign_host_rewind(&mut pair, seed, cut).await;
                    host_rewinds += 1;
                    let (d, p) = checked(&pair, seed, None);
                    decisions += d;
                    passes += p;
                }
                previous = first;
            }
            sessions += 1;
            eprintln!("FINAL campaign {profile:?} seed={seed} clean");
        }
    }
    eprintln!("FINAL campaign sessions={sessions} host_rewinds={host_rewinds} decisions={decisions} full_passes={passes}");
}

fn rng_seed_bit(seed: u64, cut: u64) -> bool {
    (seed >> cut) & 1 != 0
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "independent final review; requires MC_REVIEW_S4FINAL=1"]
async fn final_f01_named_setup_after_refusal_cannot_restore_another_branch() {
    if !enabled() {
        return;
    }
    let mut failures = Vec::new();
    for profile in PROFILES {
        let (mut pair, _, saved_a, first) = same_ordinal_branches(profile, 6, true).await;
        let state = load_head(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert!(state.cached_cut(first).unwrap().lineage != "lineage-A");
        let mut rng = Rng(467_088_571_471_423_312);
        *pair.transcript.lineage.lock().unwrap() = "unidentified-fork".into();
        *pair.resident.runner.floor.lock().unwrap() = Some(first);
        *pair.resident.runner.head.lock().unwrap() =
            Some(cut_head(&pair, "unidentified-fork", first));
        let refusal = resident_notice(&mut pair, &mut rng, None).await;
        assert!(refusal.contains("cut_rebootstrap_required"), "{refusal}");
        *pair.transcript.entries.lock().unwrap() = saved_a[..first as usize + 8].to_vec();
        let request = setup_request(
            &pair,
            "named-A-return",
            Some(json!({"lineage_id":"lineage-A","through_ordinal":first-1})),
            "named-A-return",
        );
        let initial = pair.resident.dispatch(request).await;
        assert_eq!(
            serde_json::from_str::<Value>(&initial).unwrap()["answer"],
            "ready"
        );
        assert!(
            initial.contains("branch-A-only-summary") && !initial.contains("branch-F-only-summary")
        );
        *pair.transcript.lineage.lock().unwrap() = "named-A-return".into();
        *pair.resident.runner.head.lock().unwrap() = Some(cut_head(&pair, "named-A-return", first));
        // No oracle prefix restoration participates in this reproduction.
        let outcome = resident_notice(&mut pair, &mut rng, None).await;
        let (_, _, model, _) = newest_view(&pair).unwrap();
        let a = model.contains("branch-A-only-summary");
        let f = model.contains("branch-F-only-summary");
        eprintln!("FINAL F01 resident-only {profile:?}: initial=A notice={outcome} served_A={a} served_F={f}");
        assert!(pair
            .resident
            .runner
            .reads_below_floor
            .lock()
            .unwrap()
            .is_empty());
        if !a || f {
            failures.push(format!(
                "{profile:?}: explicit Setup served A, next notice served_A={a}, served_F={f}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "WRONG_BRANCH after named rebootstrap: {failures:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "independent final review; requires MC_REVIEW_S4FINAL=1"]
async fn final_hundreds_of_cuts_revisit_every_evicted_target() {
    if !enabled() {
        return;
    }
    let mut seeds = Rng(467_088_571_471_423_312);
    for profile in PROFILES {
        let seed = seeds.next();
        if std::env::var("MC_S4FINAL_PROFILE")
            .ok()
            .is_some_and(|wanted| wanted != format!("{profile:?}"))
        {
            continue;
        }
        let mut rng = Rng(seed);
        let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
        review_enable(&pair);
        pair.append(120);
        let mut targets = Vec::new();
        let (mut decisions, mut passes) = (0, 0);
        for round in 0..200 {
            pair.append_salted(8, seed ^ round);
            review_complete_turn(&pair);
            let end = (newest_ordinal(&pair) - 12) / 4 * 4 + 3;
            review_history(&mut pair, end).await;
            let before = newest_version(&pair);
            pair.notice(&mut rng, None).await;
            let (d, p) = checked(&pair, seed, before);
            decisions += d;
            passes += p;
            let state = load_head(pair.resident.store(), &pair.reference)
                .unwrap()
                .unwrap();
            let cut = state.newest_published_cut().unwrap();
            assert_eq!(cut.first_ordinal, end + 1);
            targets.push((
                end + 1,
                cut.lineage.clone(),
                cut.head.clone(),
                cut.generation,
            ));
            assert!(state.published_cuts.len() <= 4);
            assert!(state.retired_cut_stages.len() <= 8);
            if [3, 49, 199].contains(&round) {
                let rows = pair
                    .resident
                    .store()
                    .load_async_compaction_rows(&pair.reference)
                    .unwrap()
                    .unwrap();
                let bytes: usize = rows.baselines.iter().map(|(s, v)| s.len() + v.len()).sum();
                eprintln!("FINAL retention {profile:?} cuts={} descriptors={} record={} loaded_baselines={bytes}", round + 1, state.published_cuts.len(), rows.state.len());
                let value: Value = serde_json::from_str(&rows.state).unwrap();
                let mut fields = value
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(name, v)| (v.to_string().len(), name.clone()))
                    .collect::<Vec<_>>();
                fields.sort_by(|a, b| b.cmp(a));
                eprintln!(
                    "FINAL hot-fields {profile:?} cuts={} largest={:?} baseline_sizes={:?}",
                    round + 1,
                    &fields[..fields.len().min(6)],
                    rows.baselines
                        .iter()
                        .map(|(slot, v)| (slot, v.len()))
                        .collect::<Vec<_>>()
                );
            }
        }
        let messages = pair.transcript.entries.lock().unwrap().clone();
        let all_entries = load(pair.oracle.store(), &pair.reference)
            .unwrap()
            .unwrap()
            .entries;
        // Visit every saved target, not just the oldest; randomize the order so
        // recovery cannot accidentally rely on monotonic rewind positions.
        for n in (1..targets.len()).rev() {
            let j = rng.below((n + 1) as u64) as usize;
            targets.swap(n, j);
        }
        let key = load_head(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap()
            .key
            .engine_key();
        let mut evicted = 0;
        for (index, (first, parent, head, generation)) in targets.into_iter().enumerate() {
            if pair
                .resident
                .store()
                .load_namespace_head(&format!("{key}:async:{generation}"))
                .unwrap()
                .is_none()
            {
                evicted += 1;
            }
            *pair.transcript.entries.lock().unwrap() = messages[..first as usize + 8].to_vec();
            let lineage = format!("undo-{seed}-{index}");
            let request = setup_request(
                &pair,
                &lineage,
                Some(json!({"lineage_id":parent,"through_ordinal":first-1})),
                &format!("undo-{index}"),
            );
            review_restart(&pair);
            let answer = pair
                .both("deep shuffled undo", |side| {
                    Box::pin(side.dispatch(request.clone()))
                })
                .await;
            let answer: Value = serde_json::from_str(&answer).unwrap();
            assert_eq!(
                answer["answer"], "ready",
                "{profile:?} target={first}: {answer}"
            );
            assert_eq!(
                answer["initial"]["replacement"],
                serde_json::from_str::<Value>(&head).unwrap()
            );
            *pair.transcript.lineage.lock().unwrap() = lineage.clone();
            *pair.resident.runner.floor.lock().unwrap() = Some(first);
            *pair.resident.runner.head.lock().unwrap() = Some(cut_head(&pair, &lineage, first));
            pair.cut_checkpoints.clear();
            pair.cut_checkpoints.push(first);
            pair.cut_checkpoint_lineages.clear();
            pair.cut_checkpoint_lineages.insert(first, parent);
            let mut full = load(pair.oracle.store(), &pair.reference).unwrap().unwrap();
            full.entries.clear();
            for (ordinal, entry) in &all_entries {
                full.entries.insert(*ordinal, Arc::clone(entry));
            }
            restore_oracle_prefix(&pair, full, first);
            let before = newest_version(&pair);
            pair.notice(&mut rng, None).await;
            let (d, p) = checked(&pair, seed, before);
            decisions += d;
            passes += p;
            pair.check_cut(first);
            if (index + 1) % 50 == 0 {
                eprintln!("FINAL undo-progress {profile:?} visited={}", index + 1);
            }
        }
        assert!(evicted >= 196);
        eprintln!("FINAL retention {profile:?} seed={seed} cuts=200 revisited=200 evicted={evicted} decisions={decisions} full_passes={passes}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "independent final review; requires MC_REVIEW_S4FINAL=1"]
async fn final_same_ordinal_branches_refuse_ambiguity_and_return_exact_heads() {
    if !enabled() {
        return;
    }
    let mut seeds = Rng(15_506_593_889_518_924_707 ^ 0xC07B_A11C);
    for profile in PROFILES {
        let seed = seeds.next();
        let mut rng = Rng(seed);
        let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
        review_enable(&pair);
        pair.append(120);
        let original = pair.transcript.entries.lock().unwrap().clone();
        let mut targets = Vec::new();
        for branch in 0..8 {
            let lineage = format!("branch-{seed}-{branch}");
            *pair.transcript.entries.lock().unwrap() = original[..20].to_vec();
            pair.append_salted(100, seed.wrapping_add(branch));
            // Two branches deliberately share the physical cut identity while
            // retaining different summarized histories. A head alone is ambiguous.
            if branch < 2 {
                pair.transcript.entries.lock().unwrap()[99] = original[99].clone();
            }
            for side in [&pair.resident, &pair.oracle] {
                *side.runner.floor.lock().unwrap() = None;
                *side.runner.head.lock().unwrap() = None;
            }
            pair.cut_checkpoints.clear();
            pair.cut_checkpoint_lineages.clear();
            *pair.transcript.lineage.lock().unwrap() = lineage.clone();
            let request = setup_request(&pair, &lineage, None, &format!("branch-setup-{branch}"));
            let answer = pair
                .both("independent branch", |side| {
                    Box::pin(side.dispatch(request.clone()))
                })
                .await;
            assert_eq!(
                serde_json::from_str::<Value>(&answer).unwrap()["answer"],
                "ready"
            );
            pair.notice(&mut rng, None).await;
            branch_summary(&mut pair, &format!("only-{seed}-{branch}"), 99).await;
            pair.notice(&mut rng, None).await;
            checked(&pair, seed, None);
            let state = load_head(pair.resident.store(), &pair.reference)
                .unwrap()
                .unwrap();
            let cut = state.newest_published_cut().unwrap();
            assert_eq!(cut.first_ordinal, 100);
            targets.push((
                lineage,
                cut.head.clone(),
                pair.transcript.entries.lock().unwrap().clone(),
                load(pair.oracle.store(), &pair.reference)
                    .unwrap()
                    .unwrap()
                    .entries,
            ));
        }
        let mut head = cut_head(&pair, "nameless-fork", 100);
        head["cut"]["mid"] = json!(original[99].mid);
        head["cut"]["digest"] = json!(contract::digest::content_digest(&original[99].message));
        *pair.transcript.lineage.lock().unwrap() = "nameless-fork".into();
        let mut unmatched = head.clone();
        unmatched["cut"]["digest"] = json!("f".repeat(64));
        for side in [&pair.resident, &pair.oracle] {
            *side.runner.floor.lock().unwrap() = Some(100);
            *side.runner.head.lock().unwrap() = Some(unmatched.clone());
        }
        let outcome = pair.notice(&mut rng, None).await;
        assert!(
            outcome.contains("cut_rebootstrap_required"),
            "{profile:?}: {outcome}"
        );
        for side in [&pair.resident, &pair.oracle] {
            *side.runner.head.lock().unwrap() = Some(head.clone());
        }
        let outcome = pair.notice(&mut rng, None).await;
        assert!(
            outcome.contains("cut_rebootstrap_required"),
            "{profile:?}: {outcome}"
        );
        let state = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert!(state.cut_seed.is_none() && state.produced_view.is_none());
        // Resume the oracle's full-history reads after the shared refusals.
        *pair.oracle.runner.floor.lock().unwrap() = None;
        *pair.oracle.runner.head.lock().unwrap() = None;
        review_enable(&pair);
        for (index, (parent, head, messages, entries)) in targets.into_iter().enumerate() {
            *pair.transcript.entries.lock().unwrap() = messages[..108].to_vec();
            let lineage = format!("return-{seed}-{index}");
            let request = setup_request(
                &pair,
                &lineage,
                Some(json!({"lineage_id":parent,"through_ordinal":99})),
                &lineage,
            );
            let answer = pair
                .both("return exact publishing branch", |side| {
                    Box::pin(side.dispatch(request.clone()))
                })
                .await;
            let decoded: Value = serde_json::from_str(&answer).unwrap();
            assert_eq!(decoded["answer"], "ready", "{answer}");
            assert_eq!(
                decoded["initial"]["replacement"],
                serde_json::from_str::<Value>(&head).unwrap()
            );
            assert!(answer.contains(&format!("only-{seed}-{index}")), "{answer}");
            *pair.transcript.lineage.lock().unwrap() = lineage.clone();
            *pair.resident.runner.head.lock().unwrap() = Some(cut_head(&pair, &lineage, 100));
            pair.cut_checkpoints.clear();
            pair.cut_checkpoints.push(100);
            pair.cut_checkpoint_lineages.clear();
            pair.cut_checkpoint_lineages.insert(100, parent);
            let mut full = load(pair.oracle.store(), &pair.reference).unwrap().unwrap();
            full.entries.clear();
            for (ordinal, entry) in &entries {
                full.entries.insert(*ordinal, Arc::clone(entry));
            }
            restore_oracle_prefix(&pair, full, 100);
            // Check the branch marker before the generic differential assertion
            // so a wrong summary produces a small, independent witness.
            pair.record_only = true;
            pair.notice(&mut rng, None).await;
            let (_, _, resident_model, _) = newest_view(&pair).unwrap();
            let (versions, _) = pair.oracle.views(&pair.reference);
            let oracle_view: view::CompactionView =
                serde_json::from_str(&versions.last().unwrap().1).unwrap();
            let oracle_model = String::from_utf8(pair.model_bytes(&oracle_view)).unwrap();
            let marker = format!("only-{seed}-{index}");
            assert!(
                oracle_model.contains(&marker),
                "full processing must retain the selected branch"
            );
            eprintln!("FINAL branch-return {profile:?} seed={seed} selected={index} resident_markers={:?} full_marker={marker}", (0..8).filter(|branch| resident_model.contains(&format!("only-{seed}-{branch}"))).collect::<Vec<_>>());
            assert!(resident_model.contains(&marker), "WRONG_BRANCH {profile:?}: explicit Setup returned {marker}, but its next notice served an abandoned branch summary");
            pair.record_only = false;
            pair.compare("returned branch notice");
            checked(&pair, seed, None);
        }
        eprintln!("FINAL branches {profile:?} seed={seed} variants=8 exact_returns=8 ambiguous_head=refused");
    }
}
