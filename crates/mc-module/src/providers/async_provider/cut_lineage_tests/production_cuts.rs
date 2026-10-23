//! Two real Setup descents per seeded session, against a full-input engine oracle.
use super::*;

fn compare_decisions(pair: &Pair, after: u64, seed: u64) -> usize {
    let resident = cut_seed::notice_trace::take(pair.resident.store() as *const McStore as usize);
    let oracle = cut_seed::notice_trace::take(pair.oracle.store() as *const McStore as usize);
    assert_eq!(
        resident, oracle,
        "{:?} seed {seed}: independent skip/run decisions; steps={:?}",
        pair.profile, pair.log
    );
    for sequence in after + 1..=pair.seq {
        assert!(
            oracle.iter().any(|(seen, _)| *seen == sequence),
            "{:?} seed {seed}: notice {sequence} has no decision trace",
            pair.profile
        );
    }
    oracle.len()
}

fn verify_passes(pair: &Pair, seed: u64) -> usize {
    let resident = cut_seed::pass_trace::take(pair.resident.store() as *const McStore as usize);
    let oracle = cut_seed::pass_trace::take(pair.oracle.store() as *const McStore as usize);
    let actions = |lines: &[String]| {
        lines
            .iter()
            .filter(|line| line.starts_with("action="))
            .count()
    };
    assert_eq!(actions(&resident), actions(&oracle), "{:?} seed {seed}: both providers must run the same engine passes; resident={resident:?} full={oracle:?}", pair.profile);
    assert_eq!(
        oracle
            .iter()
            .filter(|line| line.starts_with("full_input "))
            .count(),
        actions(&oracle),
        "{:?} seed {seed}: each full-input pass needs an exact source-identity proof: {oracle:?}",
        pair.profile
    );
    actions(&oracle)
}

async fn descend_pair(pair: &mut Pair, first: u64, child: &str) {
    let full = load(pair.oracle.store(), &pair.reference).unwrap().unwrap();
    let codec = codec::Codec::from_params(&Value::Object(full.setup.params.clone())).unwrap();
    let rows = tag_rows(&full, codec).unwrap();
    let mut request = serde_json::to_value(&full.setup).unwrap();
    request["lineage_id"] = json!(child);
    request["descends_from"] = json!({"lineage_id":full.lineage,"through_ordinal":first - 1});
    request["request_id"] = json!(format!("setup-{child}"));
    let label = format!("production cut Setup at {first}");
    let answer = pair
        .both(&label, |side| {
            let request = request.clone();
            Box::pin(async move {
                side.dispatch(json!({"method":"compaction.setup","params":request}))
                    .await
            })
        })
        .await;
    let answer: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(answer["answer"], "ready", "{answer}");
    *pair.transcript.lineage.lock().unwrap() = child.into();
    *pair.resident.runner.floor.lock().unwrap() = Some(first);

    // Setup has the same public semantics on both sides. Restore every source
    // row only on the oracle, and remove its seed/certificate: subsequent oracle
    // passes recompute from the full transcript, independently of cut facts.
    let store = pair.oracle.store();
    let mut oracle = pair
        .oracle
        .h
        .checkout(store, &pair.reference)
        .unwrap()
        .unwrap();
    oracle.entries = full.entries;
    oracle.cut_seed = None;
    oracle.cut_first_ordinal = None;
    oracle.logical_prefix = None;
    oracle.prefix_input_proof = None;
    oracle.aggregates = Default::default();
    oracle.entry_bytes = (None, 0);
    oracle.mid_index.clear();
    oracle.tag_index.clear();
    oracle.journal.persisted_through = None;
    oracle.journal.indexed_through = None;
    oracle.journal.truncate = Some(None);
    oracle.save(store, &rows).unwrap();
    pair.oracle.h.checkin(oracle);
    let held = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert_eq!(held.lineage_first_ordinal, first);
    assert_eq!(held.cut_seed.as_ref().unwrap().first_ordinal, first);
    assert!(held.entries.keys().all(|ordinal| *ordinal >= first));
    assert!(load(pair.oracle.store(), &pair.reference)
        .unwrap()
        .unwrap()
        .entries
        .contains_key(&0));
}

async fn session(profile: Profile, number: u64, steps: u64) -> (usize, usize) {
    let mut rng = Rng(number.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    pair.oracle
        .h
        .provider_store
        .async_runtime
        .full_input_only
        .store(true, std::sync::atomic::Ordering::Relaxed);
    for side in [&pair.resident, &pair.oracle] {
        side.h
            .provider_store
            .async_runtime
            .record_notice_decisions
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    attest(&pair.resident);
    attest(&pair.oracle);
    pair.append(208 + rng.below(5) * 4);
    let mut previous = 0;
    let (mut decisions, mut passes) = (0, 0);
    for cut in 0..2 {
        if cut > 0 {
            pair.append(32);
        }
        let last = pair
            .transcript
            .entries
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .ordinal;
        let mut history_end = (last - 24) / 4 * 4 + 3;
        let reference = pair.reference.clone();
        pair.both("history for next production cut", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, history_end) })
        })
        .await;
        let sequence = pair.seq;
        pair.notice(&mut rng, None).await;
        decisions += compare_decisions(&pair, sequence, number);
        passes += verify_passes(&pair, number);
        let held = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        let first = *held
            .published_cuts
            .keys()
            .next_back()
            .expect("an adoptable published cut");
        assert!(
            first > previous,
            "each session must descend at two advancing cuts"
        );
        descend_pair(&mut pair, first, &format!("child-{cut}")).await;
        for _ in 0..steps {
            for side in [&pair.resident, &pair.oracle] {
                cut_seed::pass_trace::take(side.store() as *const McStore as usize);
                cut_seed::notice_trace::take(side.store() as *const McStore as usize);
            }
            let sequence = pair.seq;
            pair.cut_step(&mut rng, first, &mut history_end).await;
            decisions += compare_decisions(&pair, sequence, number);
            passes += verify_passes(&pair, number);
            pair.check_cut(first);
        }
        previous = first;
    }
    assert!(pair
        .resident
        .runner
        .reads_below_floor
        .lock()
        .unwrap()
        .is_empty());
    assert!(
        pair.engine_mismatches.borrow().is_empty(),
        "{profile:?} seed {number}: {:?}; steps={:?}",
        pair.engine_mismatches.borrow(),
        pair.log
    );
    (decisions, passes)
}

async fn differential(sessions: u64, steps: u64) {
    let first_seed = std::env::var("MC_PRODUCTION_CUT_FIRST_SEED")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(70_000);
    let mut tasks = Vec::new();
    let (mut decisions, mut passes) = (0, 0);
    for index in 0..sessions {
        tasks.push(tokio::spawn(session(
            PROFILES[((first_seed + index) % 4) as usize],
            first_seed + index,
            steps,
        )));
        if tasks.len() == 4 || index + 1 == sessions {
            for task in std::mem::take(&mut tasks) {
                let (seen, verified) = task.await.unwrap();
                decisions += seen;
                passes += verified;
            }
        }
    }
    eprintln!("production differential: {sessions} sessions x 2 advancing cuts x {steps} steps over 4 formats; {decisions} independent notice decisions matched; {passes} full-input passes proved every source identity; strict engine-state comparison; 0 divergences");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successive_production_cuts_match_full_processing() {
    differential(4, 6).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "long two-cut production differential; run explicitly"]
async fn successive_production_cuts_match_full_processing_over_many_sessions() {
    let sessions = std::env::var("MC_PRODUCTION_CUT_SESSIONS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let steps = std::env::var("MC_PRODUCTION_CUT_STEPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(24);
    differential(sessions, steps).await;
}
