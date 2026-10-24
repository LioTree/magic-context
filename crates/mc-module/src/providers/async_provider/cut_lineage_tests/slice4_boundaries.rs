//! Host rewind shapes that must undo a cut whose head depends on removed rows.
use super::*;

fn replace_new_ids(pair: &Pair, through: u64, lineage: &str) {
    let mut previous = None;
    for entry in pair.transcript.entries.lock().unwrap().iter_mut() {
        if entry.ordinal > through {
            entry.mid = format!("{lineage}-m{}", entry.ordinal);
            match pair.profile {
                Profile::OpenCode => {
                    entry.message["info"]["id"] = json!(entry.mid);
                    for (index, part) in entry.message["parts"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .enumerate()
                    {
                        part["id"] = json!(format!("{}-p{index}", entry.mid));
                    }
                }
                Profile::Pi => {
                    entry.message["id"] = json!(entry.mid);
                    entry.message["parentId"] = json!(previous);
                }
                _ => {}
            }
        }
        previous = Some(entry.mid.clone());
    }
}

fn host_floor(
    pair: &Pair,
    through: u64,
    lineage: &str,
) -> Option<(u64, cut_runtime::PublishedCut)> {
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let selected = state
        .published_cuts
        .iter()
        .rev()
        .find(|(first, _)| first.saturating_sub(1) <= through)
        .map(|(first, cut)| (*first, cut.clone()));
    let head = selected
        .as_ref()
        .map(|(first, _)| cut_head(pair, lineage, *first));
    *pair.resident.runner.floor.lock().unwrap() = selected.as_ref().map(|(first, _)| *first);
    *pair.oracle.runner.floor.lock().unwrap() = None;
    for side in [&pair.resident, &pair.oracle] {
        *side.runner.head.lock().unwrap() = head.clone();
    }
    selected
}

async fn boundary_rewind(profile: Profile, fresh_ids: bool, setup: bool) {
    let end = if profile == Profile::Pi { 156 } else { 155 };
    let through = end - 1;
    let mut rng = Rng(0xB0155);
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    pair.append(180);
    review_history(&mut pair, end).await;
    pair.notice(&mut rng, None).await;
    let staged = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let first = *staged.published_cuts.keys().next_back().unwrap();
    descend_pair(&mut pair, first, "child").await;
    let parent = pair.transcript.lineage.lock().unwrap().clone();
    let digest = {
        let mut entries = pair.transcript.entries.lock().unwrap();
        entries.truncate(through as usize + 1);
        contract::digest::content_digest(&entries[through as usize].message)
    };
    let lineage = "host-rewind";
    *pair.transcript.lineage.lock().unwrap() = lineage.into();
    pair.append_salted(4, 5123);
    if fresh_ids {
        replace_new_ids(&pair, through, lineage);
    }
    let selected = host_floor(&pair, through, lineage);
    let before = newest_version(&pair);
    if setup {
        let descends = selected
            .as_ref()
            .map(|(first, cut)| json!({"lineage_id":cut.lineage,"through_ordinal":first-1}));
        let answer = pair
            .resident
            .dispatch(setup_request(&pair, lineage, descends, "boundary-rewind"))
            .await;
        let decoded: Value = serde_json::from_str(&answer).unwrap();
        assert_eq!(decoded["answer"], "ready", "{answer}");
        assert!(
            summaries_in(&answer).iter().all(|end| *end <= through),
            "Setup serves removed message: fork through {through}, initial {answer}"
        );
    } else {
        let outcome = resident_notice(
            &mut pair,
            &mut rng,
            Some(format!("{parent}:{through}:{digest}")),
        )
        .await;
        assert_eq!(outcome, "ok");
    }
    let outcome = publish_new_view(&mut pair, &mut rng, before).await;
    let (version, view, model, coverage) = newest_view(&pair).expect("rewind must publish");
    assert!(
        before.is_none_or(|old| version > old),
        "no new view: {outcome}"
    );
    assert!(
        summaries_in(&model).iter().all(|end| *end <= through),
        "fork through {through}: summary_ends={:?}",
        summaries_in(&model)
    );
    assert!(missing_user_text(&pair, &model, &view, coverage).is_empty());
    assert!(!load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap()
        .failed());
}

#[tokio::test]
async fn same_id_fork_at_the_seed_boundary_serves_no_removed_summary() {
    boundary_rewind(Profile::OpenCode, false, false).await;
}

#[tokio::test]
async fn fresh_id_setup_after_opencode_user_revert_serves_no_removed_summary() {
    boundary_rewind(Profile::OpenCode, true, true).await;
}

#[tokio::test]
async fn pi_tree_to_an_assistant_undoes_a_dependent_cut() {
    boundary_rewind(Profile::Pi, true, true).await;
}

#[tokio::test]
async fn legacy_seed_crossing_its_wire_cut_is_refused_then_restarts_fresh() {
    let mut pair = Pair::open_with(Profile::OpenCode, false, Some("L"), false, false).await;
    pair.append(180);
    let mut rng = Rng(0xB1E6);
    review_history(&mut pair, 155).await;
    pair.notice(&mut rng, None).await;
    let first = 156;
    descend_pair(&mut pair, first, "child").await;
    let store = pair.resident.store();
    let mut state = load(store, &pair.reference).unwrap().unwrap();
    let mut legacy = state.cut_seed.as_ref().unwrap().as_ref().clone();
    legacy.first_ordinal = 154;
    let mut cut = state.published_cuts.remove(&first).unwrap();
    cut.covered_through = None;
    state.published_cuts.insert(154, cut);
    state.setup.descends_from = Some(compact::lineage::DescendsFrom::new("L", 153));
    state.cut_first_ordinal = Some(154);
    state.cut_seed = Some(Arc::new(legacy.clone()));
    state.journal.cut_seed_dirty = true;
    state.pending_cut_seeds.insert(154, legacy);
    state.save(store, &[]).unwrap();
    review_restart(&pair);
    let answer = pair
        .resident
        .dispatch(setup_request(
            &pair,
            "child",
            Some(json!({"lineage_id":"L","through_ordinal":153})),
            "legacy-cut",
        ))
        .await;
    let decoded: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(decoded["answer"], "refuse", "{answer}");
    assert_eq!(decoded["code"], "unsafe_cut_seed", "{answer}");
    assert!(summaries_in(&answer).is_empty());
    *pair.transcript.lineage.lock().unwrap() = "fresh".into();
    *pair.resident.runner.floor.lock().unwrap() = None;
    *pair.resident.runner.head.lock().unwrap() = None;
    let answer = pair
        .resident
        .dispatch(setup_request(&pair, "fresh", None, "fresh-after-legacy"))
        .await;
    let decoded: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(decoded["answer"], "ready", "{answer}");
    let state = load(store, &pair.reference).unwrap().unwrap();
    assert!(state.cut_seed.is_none());
    assert!(state.cut_first_ordinal.is_none());
    assert_eq!(resident_notice(&mut pair, &mut rng, None).await, "ok");
}

#[tokio::test]
async fn oversized_prelude_defers_only_the_cut_until_a_normal_restart() {
    let mut pair = Pair::open_with(Profile::OpenCode, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0xB0D6);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    let store = Arc::clone(pair.resident.h.store.get().unwrap());
    cut_runtime::measurements::take(&store);
    let mut state = pair
        .resident
        .h
        .checkout(&store, &pair.reference)
        .unwrap()
        .unwrap();
    let old_cut = state.published_cuts[&100].version;
    let original = Arc::clone(&state.entries[&99]);
    let mut large = original.read().unwrap();
    // Opaque host metadata is not converted to a large-text descriptor. It
    // makes the historian-only suffix exceed its actual retained byte budget.
    large.message["info"]["opaque_metadata"] =
        json!("x".repeat(cut_seed::MAX_HISTORIAN_PRELUDE_BYTES + 1));
    state
        .entries
        .insert(99, Arc::new(HeldEntry::from_read(&large).unwrap()));
    store.arm_soft_refresh(&state.namespace()).unwrap();
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    let view = pair
        .resident
        .h
        .publish_async(0, &mut state, codec, true)
        .unwrap()
        .expect("view still publishes");
    assert!(view.cut.is_none());
    assert_eq!(state.published_cuts[&100].version, old_cut);
    state.save(&store, &[]).unwrap();
    assert!(store
        .load_async_compaction_view(&pair.reference, view.view_version)
        .unwrap()
        .is_some());
    state.entries.insert(99, original);
    pair.resident.h.checkin(state);

    // The next covered ordinary assistant is a new restart, so the oversized
    // earlier row is no longer in the prelude and cannot pin the old cut.
    pair.append(4);
    publish_history(&pair.resident, &pair.reference, 103);
    assert_eq!(
        resident_notice_at(&mut pair, 30_000, Some(view.view_version)).await,
        "ok"
    );
    let state = load(&store, &pair.reference).unwrap().unwrap();
    assert!(state.published_cuts.contains_key(&104));
    let stats = cut_runtime::measurements::take(&store);
    assert!(stats.deferred_cuts >= 1, "{stats:?}");
    assert!(stats.largest_deferred_bytes > cut_seed::MAX_HISTORIAN_PRELUDE_BYTES);
    assert!(stats.max_prelude_bytes <= cut_seed::MAX_HISTORIAN_PRELUDE_BYTES);
}

#[tokio::test]
async fn a_matching_version_cannot_announce_summary_dependencies_beyond_the_cut() {
    let mut pair = Pair::open_with(Profile::OpenCode, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0xB05);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    let store = pair.resident.store();
    let mut state = load(store, &pair.reference).unwrap().unwrap();
    let mut kept = state.published_cuts.remove(&100).unwrap();
    let raw = store
        .load_async_compaction_view(&pair.reference, kept.version)
        .unwrap()
        .unwrap();
    let mut view: view::CompactionView = serde_json::from_str(&raw).unwrap();
    let version = store
        .reserve_async_compaction_version(&pair.reference, kept.version)
        .unwrap();
    view.view_version = version;
    view.cut.as_mut().unwrap().through_ordinal = 98;
    view.digest = view.compute_digest();
    kept.version = version;
    kept.covered_through = Some(99);
    state.published_cuts.insert(99, kept);
    state.save(store, &[]).unwrap();
    store
        .save_async_compaction_view(
            &pair.reference,
            version,
            &serde_json::to_string(&view).unwrap(),
            "{}",
        )
        .unwrap();
    pair.resident.h.announce_async_views().await.unwrap();
    assert!(store
        .pending_async_compaction_views()
        .unwrap()
        .iter()
        .any(|(_, seen, _)| *seen == version));
}
