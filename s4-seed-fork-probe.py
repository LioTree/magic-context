#!/usr/bin/env python3
"""Check recovery when the original staged summary itself crosses the fork."""
import os
from pathlib import Path
import subprocess
import tempfile

path = Path('crates/mc-module/src/providers/async_provider/cut_lineage_tests/slice4_review.rs')
source = path.read_bytes()
probe = r'''
#[tokio::test]
async fn s4_initial_seed_straddling_fork_probe() {
    let mut pair = Pair::open_with(Profile::OpenCode, false, Some("L"), false, false).await;
    pair.append(176);
    let mut rng = Rng(0xA806);
    let first = review_next_cut(&mut pair, &mut rng, 0, "child", false).await;
    let state = load(pair.resident.store(), &pair.reference).unwrap().unwrap();
    let old_cut_lineage = state.published_cuts[&first].lineage.clone();
    let end = state.cut_seed.as_ref().unwrap().recovery_history.iter().map(|c|c.end_message).max().unwrap() as u64;
    eprintln!("SEED FORK PROBE first={first} seed_history_end={end}");
    assert!(end > first, "fixture must straddle the original cut");
    let through = first;
    let parent = pair.transcript.lineage.lock().unwrap().clone();
    let digest = {
        let mut entries = pair.transcript.entries.lock().unwrap();
        entries.truncate(through as usize + 1);
        contract::digest::content_digest(&entries[through as usize].message)
    };
    *pair.transcript.lineage.lock().unwrap() = "seed-fork".into();
    pair.append_salted(4, 5123);
    {
        let mut entries = pair.transcript.entries.lock().unwrap();
        for entry in entries.iter_mut().filter(|entry| entry.ordinal > through) {
            entry.mid = format!("rewound-{}", entry.ordinal);
            entry.message["info"]["id"] = json!(entry.mid);
        }
    }
    let answer = pair.resident.dispatch(setup_request(&pair, "seed-fork", Some(json!({"lineage_id":old_cut_lineage,"through_ordinal":first-1})), "setup-seed-fork")).await;
    let initial_summaries = summaries_in(&answer);
    let decoded: Value = serde_json::from_str(&answer).unwrap();
    eprintln!("SEED FORK PROBE fresh-ID Setup answer={} initial_summary_ends={initial_summaries:?}", decoded["answer"]);
    assert_eq!(decoded["answer"], "ready", "{answer}");
    assert!(initial_summaries.iter().all(|end| *end <= through), "Setup serves removed message: fork through {through}, initial summaries {initial_summaries:?}");
    let before = newest_version(&pair);
    let outcome = resident_notice(&mut pair, &mut rng, Some(format!("{parent}:{through}:{digest}"))).await;
    eprintln!("SEED FORK PROBE notice={outcome}; {}", cut_prefix_report(&pair));
    assert_eq!(outcome, "ok");
    let outcome = publish_new_view(&mut pair, &mut rng, before).await;
    let (version, view, model, coverage) = newest_view(&pair).expect("fork must publish a view");
    let summaries = summaries_in(&model);
    let missing = missing_user_text(&pair, &model, &view, coverage);
    eprintln!("SEED FORK PROBE model view={version} summary_ends={summaries:?} missing_user_messages={missing:?} notice={outcome}");
    assert!(summaries.iter().all(|end| *end <= through), "summary includes replaced message: fork through {through}, summaries {summaries:?}");
}
'''
try:
    path.write_bytes(source + probe.encode())
    proc = subprocess.run(['cargo', 'test', '-p', 'mc-module', '--lib', 's4_initial_seed_straddling_fork_probe', '--', '--nocapture', '--test-threads=1'], env=dict(os.environ, RUSTC_WRAPPER='', CARGO_BUILD_RUSTC_WRAPPER=''))
    result = proc.returncode
finally:
    path.write_bytes(source)
    os.utime(path, None)
    assert path.read_bytes() == source
    print('SEED FORK PROBE restored original witness file byte-identically', flush=True)
raise SystemExit(result)
