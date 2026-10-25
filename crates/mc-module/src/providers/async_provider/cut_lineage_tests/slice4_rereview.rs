//! Witnesses from the independent re-review of the slice-4 fix round. Each
//! test pins one finding of `.cortexkit/internal-docs/reviews/
//! mode3-slice4-fix-rereview.md` and is ignored with that finding's id.
use super::*;

/// A cut lineage whose runner forks it at an endpoint ck-mc has not read
/// yet, after rewriting a held window row, so neither descent proof holds.
/// The runner keeps the physical cut: its `session.head` for the new
/// lineage reports the same first ordinal and cut message, and it refuses
/// reads below the cut. Checks the notice outcomes, the reads below the cut,
/// the failure state and whether a newer view was served: returns an empty
/// string when all hold, otherwise a diagnostic naming what went wrong.
async fn unverifiable_fork_in_a_cut_lineage(profile: Profile) -> String {
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0x5E5E_0001);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    descend_pair(&mut pair, 100, "child").await;
    pair.append(8);
    review_complete_turn(&pair);
    let mut trail = vec![resident_notice(&mut pair, &mut rng, None).await];
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let first = state.lineage_first_ordinal;
    let last = *state.entries.last_key_value().unwrap().0;
    // The runner edited a held row inside the window, then forked two rows
    // past what ck-mc has read.
    pair.append(2);
    let through = last + 2;
    let digest = {
        let mut entries = pair.transcript.entries.lock().unwrap();
        entries[(first + 1) as usize] = message(profile, first + 1, 90_123);
        contract::digest::content_digest(&entries[through as usize].message)
    };
    *pair.transcript.lineage.lock().unwrap() = "edited-fork".into();
    pair.append_salted(2, 6_007);
    review_complete_turn(&pair);
    *pair.resident.runner.head.lock().unwrap() = Some(cut_head(&pair, "edited-fork", first));
    let before = newest_version(&pair);
    trail.push(resident_notice(&mut pair, &mut rng, Some(format!("child:{through}:{digest}"))).await);
    for _ in 0..3 {
        pair.append(4);
        review_complete_turn(&pair);
        let applied = newest_version(&pair);
        trail.push(resident_notice_at(&mut pair, 30_000, applied).await);
    }
    let newest = newest_version(&pair);
    trail.push(publish_new_view(&mut pair, &mut rng, newest).await);
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let reads = pair.resident.runner.reads_below_floor.lock().unwrap().clone();
    let served = newest_view(&pair)
        .filter(|(version, ..)| before.is_none_or(|before| *version > before))
        .map(|(version, view, model, coverage)| {
            (
                version,
                summaries_in(&model),
                missing_user_text(&pair, &model, &view, coverage),
            )
        });
    let healthy = trail.iter().all(|outcome| !outcome.contains("Err") && !outcome.contains("error"))
        && reads.is_empty()
        && !state.failed()
        && served.as_ref().is_some_and(|(_, _, missing)| missing.is_empty());
    if healthy {
        String::new()
    } else {
        format!(
            "{profile:?}: cut at {first}, held through {last}, fork through {through}: notices {trail:?}; reads below the cut {reads:?}; failed {}; cut_first_ordinal {:?}, lineage_first_ordinal {}; new view (version, summaries, missing user text) {served:?}; namespace compartments end at {:?}",
            state.failed(),
            state.cut_first_ordinal,
            state.lineage_first_ordinal,
            compartment_ends(&pair.resident, &pair.reference),
        )
    }
}

/// R-01. An unverifiable fork inside a cut lineage resets the record and
/// drops the cut floor. The runner still begins the forked lineage at the
/// cut, so the reset must rebuild from the cut with the history that covers
/// the rows below it, and keep publishing, without reading below the cut.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "R-01: an unverifiable fork in a cut lineage must keep publishing from the cut"]
async fn r01_unverifiable_fork_in_a_cut_lineage_keeps_publishing_from_the_cut() {
    let mut problems = Vec::new();
    for profile in PROFILES {
        let problem = unverifiable_fork_in_a_cut_lineage(profile).await;
        if !problem.is_empty() {
            problems.push(problem);
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Sizes after each of `rounds` historian publications that advance the cut
/// without the runner descending: (registered cuts, record JSON bytes,
/// staged namespaces that still have a head, bytes of the baseline rows
/// every load of the record reads).
async fn registry_growth(profile: Profile, rounds: u64) -> Vec<(usize, usize, usize, usize)> {
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0x5E5E_0002);
    let mut sizes = Vec::new();
    for _ in 0..rounds {
        pair.append(8);
        review_complete_turn(&pair);
        let newest = newest_ordinal(&pair);
        review_history(&mut pair, (newest - 12) / 4 * 4 + 3).await;
        pair.notice(&mut rng, None).await;
        let state = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        let staged = state
            .published_cuts
            .values()
            .filter(|cut| {
                pair.resident
                    .store()
                    .load_namespace_head(&format!(
                        "{}:async:{}",
                        state.key.engine_key(),
                        cut.generation
                    ))
                    .unwrap()
                    .is_some()
            })
            .count();
        let loaded = pair
            .resident
            .store()
            .load_async_compaction_rows(&pair.reference)
            .unwrap()
            .unwrap()
            .baselines
            .iter()
            .map(|(slot, json)| slot.len() + json.len())
            .sum::<usize>();
        sizes.push((
            state.published_cuts.len(),
            serde_json::to_string(&state).unwrap().len(),
            staged,
            loaded,
        ));
    }
    sizes
}

/// R-02. The cut registry is never pruned: every publication that advances
/// the cut adds an entry holding that cut's rendered head, kept in the
/// record saved whenever a notice completes normal processing, plus a
/// staged namespace and a seed row that every load of the record reads.
/// The record must stay bounded by the window, not grow with the number
/// of cuts a long session has published.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "R-02: the published-cut registry, its heads in the record and its staged namespaces grow with every advancing cut"]
async fn r02_cut_registry_stays_bounded_over_many_advancing_cuts() {
    let sizes = registry_growth(Profile::Broca, 24).await;
    let (early_cuts, early_bytes, _, early_loaded) = sizes[5];
    let (late_cuts, late_bytes, late_staged, late_loaded) = *sizes.last().unwrap();
    eprintln!(
        "R-02 growth (cuts, record bytes, staged namespaces, loaded baseline bytes) per round: {sizes:?}"
    );
    assert!(
        late_cuts <= early_cuts.max(4)
            && late_bytes <= early_bytes * 2
            && late_loaded <= early_loaded * 2,
        "after 6 publications: {early_cuts} cuts, record {early_bytes} bytes, loaded baselines {early_loaded} bytes; after {}: {late_cuts} cuts, record {late_bytes} bytes, {late_staged} staged namespaces, loaded baselines {late_loaded} bytes; per round {sizes:?}",
        sizes.len()
    );
}
