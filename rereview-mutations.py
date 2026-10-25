#!/usr/bin/env python3
"""Temporary mutants reverting async-provider and compaction regression fixes.

Each mutant edits production source, prints the mutated text, runs the named
tests, then restores the files byte for byte and checks their sha256.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

AP = "crates/mc-module/src/providers/async_provider.rs"
CR = "crates/mc-module/src/providers/async_provider/cut_runtime.rs"
CS = "crates/mc-module/src/providers/async_provider/cut_seed.rs"
FE = "crates/mc-module/src/providers/async_provider/frozen_edits.rs"

UNSEEN_CALL = """                    Box::pin(self.verify_unseen_descent(
                        &state,
                        lineage,
                        header,
                        self.notice_read_budget(),
                    ))
                    .await?"""

MUTANTS = [
    ("S4-01 fresh-from-zero Setup keeps copied summaries", [
        (AP, "            if state.cut_seed.is_none() {\n                // A lineage starting at zero can undo",
             "            if false {\n                // A lineage starting at zero can undo"),
    ], [["slice4_review::s4_01_"]]),
    ("S4-02 unverifiable lineage change keeps the old cut floor", [
        (AP, "                state.cut_seed = None;\n                state.cut_first_ordinal = None;\n                state.lineage_first_ordinal = 0;\n                state.save(store, &[])?;",
             "                state.save(store, &[])?;"),
    ], [["slice4_review::s4_02_"]]),
    ("S4-03 save prunes the cut registry with retired views", [
        (AP, "            self.retired_frozen.retain_from(floor);\n",
             "            self.retired_frozen.retain_from(floor);\n            self.published_cuts.retain(|_, cut| cut.version >= floor);\n"),
    ], [["slice4_review::s4_03_", "slice4_review::s4_08_superseded", "slice4_guards::m11_"]]),
    ("S4-04 host-cut Setup skips the coverage check", [
        (CR, "        if next < first as i64 {\n            return Err(error(\n                \"unknown_cut\",",
             "        if false {\n            return Err(error(\n                \"unknown_cut\","),
    ], [["slice4_review::s4_04_", "slice4_guards::m16_"]]),
    ("S4-05 both: restore drops pre-cut history and repair returns early", [
        (AP, ".is_some_and(|first| history.compartment.end_message < first as i64)", ".is_some_and(|_| false)"),
        (CR, "        if next >= seed.first_ordinal as i64 {\n            return Ok(());", "        if true {\n            return Ok(());"),
    ], [["slice4_review::s4_05_"]]),
    ("S4-05 site A only: restore drops wholly pre-cut history", [
        (AP, ".is_some_and(|first| history.compartment.end_message < first as i64)", ".is_some_and(|_| false)"),
    ], [["slice4_review::s4_05_"]]),
    ("S4-05/S4-06 site B only: repair_cut_history returns early", [
        (CR, "        if next >= seed.first_ordinal as i64 {\n            return Ok(());", "        if true {\n            return Ok(());"),
    ], [["slice4_review::s4_05_", "slice4_review::s4_06_"]]),
    ("S4-07 todo replay keeps the old lineage's todo fields", [
        (AP, "            meta.last_todo_state = todo.map(|todo| todo.state_json.clone());\n            meta.last_todo_state_owner_message_id = todo.map(|todo| todo.owner_message_id.clone());\n            meta.last_todo_state_hash = todo.map(|todo| todo.state_hash.clone());\n",
             ""),
    ], [["slice4_review::s4_07_"]]),
    ("S4-08 superseded same-cut stages are never reclaimed", [
        (AP, "        self.cleanup_retired_cut_stages(store)?;",
             "        // NON-VACUITY BREAK superseded cut stages are not reclaimed"),
    ], [["slice4_review::s4_08_"]]),
    ("HEAD proof bypassed: cut_supported ignored", [
        (AP, "                cut_supported\n                    && (!mapped.is_empty() || head.required_cut.is_some())",
             "                true\n                    && (!mapped.is_empty() || head.required_cut.is_some())"),
    ], [["a_zero_source_frozen_head_requires_its_cut_to_survive", "full_revert_does_not_revalidate_an_opaque_cut_head"]]),
    ("FORK descent: unseen-endpoint proof never attempted", [
        (AP, UNSEEN_CALL, "                    None"),
    ], [["cut_lineage_tests::"],
        ["--ignored", "slice4_review::s4_replay_host_campaign_seed", "ENV:MC_S4_REPLAY_SEED=3144134320", "ENV:MC_S4_REPLAY_PROFILE=3", "ENV:MC_S4_NO_REVERT=1"],
        ["--ignored", "slice4_review::s4_replay_host_campaign_seed", "ENV:MC_S4_REPLAY_SEED=3144134339", "ENV:MC_S4_REPLAY_PROFILE=2", "ENV:MC_S4_NO_REVERT=1"]]),
    ("NUMBERING: next_generation ignores cut and retired-stage generations", [
        (CR, ".fold(self.generation, u64::max)", ".fold(self.generation, |generation, _| generation)"),
    ], [["slice4_review::s4_0", "slice4_boundaries::", "slice4_guards::"], ["cut_lineage_tests::"]]),
    ("ARC: acknowledged native arcs not preserved", [
        (FE, "        tool_arcs::preserve_acknowledged_arcs(kept, &anchored, ranges);\n", ""),
    ], [["resync_keeps_an_acknowledged_native_result", "tool_arcs::tests"]]),
    ("PLACEMENT: seed capture accepts a summary past the cut", [
        (CS, "        if summary_end.is_none_or(|end| end > cut) {", "        if false {"),
    ], [["cut_lineage_tests::"]]),
]

# Cut descriptors now live outside the bounded cache. Revert the old retention
# policy in both places so the control still removes actual revert targets.
ST = "crates/mc-store/src/async_compaction.rs"
PRUNE_ANCHOR = "            if let Some(floor) = retain_views_from {\n"
meta_query = " FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot GLOB 'published-cut-meta:*' AND json_extract(view_json,'$.version')<?2"
pruned_slots = " UNION ALL ".join(
    "SELECT '" + prefix + "'||substr(slot,length('published-cut-meta:')+1)" + meta_query
    for prefix in ("published-cut:", "published-cut-meta:", "published-cut-root:", "published-cut-candidate:")
)
PRUNE_SQL = "DELETE FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot IN (" + pruned_slots + ")"
PRUNE_BREAK = PRUNE_ANCHOR + '                rows += conn.execute("' + PRUNE_SQL + '", params![session_ref,floor])? as u64; // NON-VACUITY BREAK retired views prune durable cut targets\n'
MUTANTS[2] = (MUTANTS[2][0], [
    (AP, "            self.retired_frozen.retain_from(floor);\n",
     "            self.retired_frozen.retain_from(floor);\n            self.published_cuts.retain(|_, cut| cut.version >= floor); // NON-VACUITY BREAK\n"),
    (ST, PRUNE_ANCHOR, PRUNE_BREAK),
], MUTANTS[2][2])
MUTANTS[3] = (MUTANTS[3][0], [
    (CR, "        if next < first as i64 {", "        if false { // NON-VACUITY BREAK host coverage/recovery omitted"),
], MUTANTS[3][2])
MUTANTS[5] = (MUTANTS[5][0], MUTANTS[5][1], [
    ["slice4_rereview::r05_restore_keeps_the_certified_prefix_without_a_cold_repair_backup"],
    ["slice4_review::s4_05_"],
])
MUTANTS[8] = (MUTANTS[8][0], MUTANTS[8][1], [
    ["slice4_review::s4_08_same_cut_supersession_reclaims_the_old_stage"],
    ["slice4_review::s4_08_superseded_cut_stages_are_removed"],
])
MUTANTS[10] = (MUTANTS[10][0], MUTANTS[10][1], [["slice4_rereview::r03_unseen_descent_is_attempted_on_the_notice_path"]])
MUTANTS[11] = (MUTANTS[11][0], MUTANTS[11][1], [["slice4_rereview::r03_generation_numbering_checks_cut_and_retired_stage_high_water"]])
MUTANTS[13] = (MUTANTS[13][0], MUTANTS[13][1], [["slice4_rereview::r03_capture_rejects_history_placed_after_its_wire_cut"]])
MUTANTS[7] = (MUTANTS[7][0], [(path, old, "            // NON-VACUITY BREAK todo rollback assignments removed\n") for path, old, _ in MUTANTS[7][1]], MUTANTS[7][2])
MUTANTS[12] = (MUTANTS[12][0], [(path, old, "        // NON-VACUITY BREAK native arc preservation call removed\n") for path, old, _ in MUTANTS[12][1]], MUTANTS[12][2])

EXPECTED_RED = {
    0: "s4_01_", 1: "s4_02_", 2: "s4_03_", 3: "s4_04_", 4: "s4_05_",
    6: "s4_06_", 7: "s4_07_", 8: "s4_08_same_cut_", 9: "", 10: "r03_unseen_descent_",
    11: "r03_generation_", 12: "resync_keeps_an_acknowledged_native_result", 13: "r03_capture_",
}


def sha(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def run(args):
    env = dict(os.environ, RUSTC_WRAPPER='', CARGO_BUILD_RUSTC_WRAPPER='')
    filters = []
    for arg in args:
        if arg.startswith('ENV:'):
            key, value = arg[4:].split('=', 1)
            env[key] = value
        else:
            filters.append(arg)
    ignored = [f for f in filters if f == '--ignored']
    names = [f for f in filters if f != '--ignored']
    command = ['cargo', 'test', '-p', 'mc-module', '--lib', '--', *names, *ignored, '--test-threads=1']
    print('  $', ' '.join(a for a in args if a.startswith('ENV:')), ' '.join(command), flush=True)
    try:
        proc = subprocess.run(command, env=env, capture_output=True, text=True,
                              timeout=int(os.environ.get('MUTANT_TIMEOUT', '300')))
    except subprocess.TimeoutExpired as expired:
        print(f'  HUNG after {expired.timeout}s', flush=True)
        return dict(exit=None, outcome='hung', failed=[], passed=[], summary=[], errors=[])
    out = proc.stdout + proc.stderr
    failed = sorted(set(re.findall(r'^test (\S+) \.\.\. FAILED$', out, re.M)))
    passed = re.findall(r'^test (\S+) \.\.\. ok$', out, re.M)
    summary = re.findall(r'^test result: .*$', out, re.M)
    errors = [line for line in out.splitlines() if line.startswith('error[') or (line.startswith('error:') and not line.startswith('error: test failed'))]
    reached = bool(failed or passed)
    outcome = ('reddened' if proc.returncode == 101 and len(failed) == 1 and not errors else
               'not_reached' if not reached or errors else 'undefended')
    result = dict(exit=proc.returncode, outcome=outcome, failed=failed, passed=passed, summary=summary, errors=errors)
    print('  RUN ' + __import__('json').dumps(result), flush=True)
    if errors or (proc.returncode and not failed):
        print(out[-4000:], flush=True)
    return result


def main():
    if sys.argv[1:] == ['--anchors']:
        count = 0
        for index, (_, edits, _) in enumerate(MUTANTS):
            for path, old, _ in edits:
                matches = open(path).read().count(old)
                print(f'REREVIEW ANCHOR {index} {path}: {matches}', flush=True)
                assert matches == 1, (index, path, matches, old[:100])
                count += 1
        print(f'REREVIEW ANCHOR SUMMARY {len(MUTANTS)} controls / {count} sites', flush=True)
        return
    selected = set(sys.argv[1:])
    records = []
    bad = []
    for index, (name, edits, runs) in enumerate(MUTANTS):
        if selected and str(index) not in selected:
            continue
        files = sorted({path for path, _, _ in edits})
        originals = {path: open(path, 'rb').read() for path in files}
        hashes = {path: sha(path) for path in files}
        applied = []
        print(f'=== MUTANT {index}: {name}', flush=True)
        try:
            for path, old, new in edits:
                text = open(path).read()
                assert text.count(old) == 1, (index, path, text.count(old), old[:100])
                at = text.index(old)
                text = text[:at] + new + text[at + len(old):]
                open(path, 'w').write(text)
                line = text[:at].count('\n') + 1
                evidence = f'{path}:{line}: {new.strip()}'
                applied.append(evidence)
                print('APPLIED ' + evidence, flush=True)
            for args in runs:
                shared = [arg for arg in args if arg == '--ignored' or arg.startswith('ENV:')]
                names = [arg for arg in args if arg != '--ignored' and not arg.startswith('ENV:')]
                for selector in names:
                    result = run(shared + [selector])
                    expected = 'red'
                    if (index == 5 and 's4_05_' in selector) or (index == 3 and 'm16_' in selector) or (index == 6 and 's4_05_' in selector) or (index == 12 and 'tool_arcs::tests' in selector):
                        expected = 'green'
                    # This extra diagnostic changes with cache representation;
                    # S4-03 and M11 are the required durable-retention controls.
                    if index == 2 and 's4_08_superseded' in selector:
                        expected = 'observed'
                    ok = (result['outcome'] == 'reddened' if expected == 'red' else
                          result['exit'] == 0 and bool(result['passed']) if expected == 'green' else
                          result['exit'] in (0, 101) and not result['errors'])
                    if expected == 'red' and result['failed']:
                        ok &= selector in result['failed'][0]
                    record = dict(index=index, control=name, selector=selector, expected=expected,
                                  applied=applied, **result)
                    records.append(record)
                    print('REREVIEW RESULT ' + json.dumps(record), flush=True)
                    if not ok:
                        bad.append((index, selector, result['outcome']))
        finally:
            for path in files:
                open(path, 'wb').write(originals[path])
            restored = all(sha(path) == hashes[path] for path in files)
            print(f'RESTORED {index} byte-identical={restored} hashes={hashes}', flush=True)
            assert restored
    print('REREVIEW MUTATION SUMMARY ' + json.dumps(records), flush=True)
    if bad:
        raise SystemExit(f'unexpected mutation results: {bad}')


if __name__ == "__main__":
    main()
