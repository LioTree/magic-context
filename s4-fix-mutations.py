#!/usr/bin/env python3
"""Run isolated red controls, restoring byte-identical sources after each run."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

scope = {}
source = Path('s4-review-mutations-base.py').read_text()
exec(source[:source.index('\ndef sha(')], scope)
AP, CR, CS = (scope[k] for k in ('AP', 'CR', 'CS'))
controls = []
for label, path, old, new in scope['MUTANTS']:
    ident = label.split()[0]
    if ident == 'M11':
        old = '            self.retired_frozen.retain_from(floor);'
        new = old + '\n            self.published_cuts.retain(|_, cut| cut.version >= floor); // NON-VACUITY BREAK'
    if ident == 'M12':
        path = AP
        old = '        let cut_first = coverage\n            .and_then(|through| through.checked_add(1))'
        new = '        let cut_first = coverage\n            .and_then(|through| state.aggregates.historian_input.restart_at_or_below(through)) // NON-VACUITY BREAK cut placed inside its summary'
    if ident == 'M14':
        old = '        if !aggregates.historian_input.is_start(historian_window.from) {'
        new = '        if false && !aggregates.historian_input.is_start(historian_window.from) { // NON-VACUITY BREAK unproved historian restart accepted'
    controls.append((ident, path, old, new, 'slice4_guards::' + ident.lower() + '_'))
controls += [
    ('S4-01', AP, '            if state.cut_seed.is_none() {', '            if false && state.cut_seed.is_none() { // NON-VACUITY BREAK', 'slice4_review::s4_01_'),
    ('S4-02', AP, '                state.cut_first_ordinal = None;', '                // NON-VACUITY BREAK old cut floor retained', 'slice4_review::s4_02_'),
    ('S4-03', AP, '            self.retired_frozen.retain_from(floor);', '            self.retired_frozen.retain_from(floor);\n            self.published_cuts.retain(|_, cut| cut.version >= floor); // NON-VACUITY BREAK', 'slice4_review::s4_03_'),
    ('S4-04', CR, '        if next < first as i64 {', '        if false && next < first as i64 { // NON-VACUITY BREAK', 'slice4_review::s4_04_'),
    ('S4-05', AP, '        template.declared_trim = template\n            .logical_prefix\n            .as_ref()\n            .and_then(|prefix| prefix.declared_cut_trim());', '        template.declared_trim = None; // NON-VACUITY BREAK omitted closed-cut trim declaration', 'slice4_review::s4_05_'),
    ('S4-06', CR, '        let Some(seed) = self.recovery_seed(store)? else {', '        if std::hint::black_box(true) { return Ok(()); } // NON-VACUITY BREAK cut recovery omitted\n        let Some(seed) = self.recovery_seed(store)? else {', 'slice4_review::s4_06_'),
    ('S4-07', AP, '            let todo = seed.as_ref().and_then(|seed| seed.todo.as_ref());', '            let todo = None::<&cut_seed::SeedTodo>; // NON-VACUITY BREAK pre-cut todo rollback omitted', 'slice4_review::s4_07_'),
    ('S4-08', AP, '        self.cleanup_retired_cut_stages(store)?;', '        // NON-VACUITY BREAK superseded stages retained', 'slice4_review::s4_08_same_cut_supersession_'),
]
controls.append(('ARCHIVE', 'crates/mc-store/src/async_compaction.rs',
    '                    .prepare("SELECT slot,view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot NOT GLOB \'undo-native-edits:*\'")?',
    '                    .prepare("SELECT slot,view_json FROM mc_async_compaction_baselines WHERE session_ref=?1")? // NON-VACUITY BREAK archive hydrated on ordinary loads',
    'undo_edit_archives_are_not_hydrated_on_ordinary_loads'))
placement_old = '        let cut_first = coverage\n            .and_then(|through| through.checked_add(1))'
placement_bad = '        let cut_first = coverage\n            .and_then(|through| state.aggregates.historian_input.restart_at_or_below(through)) // NON-VACUITY BREAK cut placed inside its summary'
for ident, test in [
    ('B-POS-SAME', 'same_id_fork_at_the_seed_boundary_serves_no_removed_summary'),
    ('B-POS-FRESH', 'fresh_id_setup_after_opencode_user_revert_serves_no_removed_summary'),
    ('B-POS-PI', 'pi_tree_to_an_assistant_undoes_a_dependent_cut'),
]:
    controls.append((ident, AP, placement_old, placement_bad, 'slice4_boundaries::' + test))
controls += [
    ('B-CANONICAL', AP, '            cut_runtime::split_head_at(&mut ranges, first);', '            // NON-VACUITY BREAK coalesced head not split at cut', 'successive_production_cuts_keep_only_the_window'),
    ('B-BUDGET', CS, '            if bytes > MAX_HISTORIAN_PRELUDE_BYTES {', '            if false && bytes > MAX_HISTORIAN_PRELUDE_BYTES { // NON-VACUITY BREAK oversized prelude accepted', 'slice4_boundaries::oversized_prelude_defers_only_the_cut_until_a_normal_restart'),
    ('B-ANNOUNCE', AP, '.is_none_or(|end| end > cut.through_ordinal)', '.is_none_or(|_| false) // NON-VACUITY BREAK head support not checked', 'slice4_boundaries::a_matching_version_cannot_announce_summary_dependencies_beyond_the_cut'),
    ('B-LEGACY', CS, '.is_some_and(|(cut, end)| end <= cut)', '.is_some_and(|_| true) // NON-VACUITY BREAK unsafe old seed accepted', 'slice4_boundaries::legacy_seed_crossing_its_wire_cut_is_refused_then_restarts_fresh'),
    ('B-FROZEN', 'crates/mc-module/src/providers/async_provider/frozen_edits.rs', '.is_some_and(|old| old.ack_version > part.ack_version)', '.is_some_and(|_| false) // NON-VACUITY BREAK old cut overwrites newer bytes', 'an_older_cut_cannot_overwrite_newer_acknowledged_bytes'),
    ('B-PRIVATE-VIEW', 'crates/mc-store/src/async_compaction.rs', 'UPDATE mc_async_compaction_views SET view_json=?3 WHERE session_ref=?1 AND version=?2 AND announced=0', 'UPDATE mc_async_compaction_views SET view_json=?3 WHERE session_ref=?1 AND version=?2 /* NON-VACUITY BREAK immutable view guard removed */', 'only_an_unannounced_view_can_drop_a_deferred_cut'),
    ('B-ISOLATION', CS, '            context_sources,\n            time_basis,', '            context_sources: { let mut sources = context_sources; sources.insert(cut, self.entries[&cut].inbound()?); sources }, // NON-VACUITY BREAK historian row enters engine context\n            time_basis,', 'historian_prelude_is_not_live_or_model_input'),
]
if sys.argv[1:] == ['--anchors']:
    for ident, path, old, new, filt in controls:
        count = Path(path).read_text().count(old)
        print(f'ANCHOR {ident} {path}: {count}', flush=True)
        assert count == 1, (ident, count)
    print(f'ANCHOR SUMMARY {len(controls)} controls checked', flush=True)
    raise SystemExit(0)
selected = set(sys.argv[1:])
results = []
for ident, path, old, new, filt in controls:
    if selected and ident not in selected:
        continue
    p = Path(path)
    original = p.read_bytes()
    text = original.decode()
    if text.count(old) != 1:
        raise RuntimeError(f'{ident}: expected one mutation anchor, found {text.count(old)}')
    with tempfile.TemporaryDirectory(prefix='s4-control-', dir=os.environ.get('TMPDIR')) as tmp:
        backup = Path(tmp) / p.name
        backup.write_bytes(original)
        try:
            mutated = text.replace(old, new)
            if ident == 'B-BUDGET':
                anchor = '        if bytes > MAX_HISTORIAN_PRELUDE_BYTES {\n            return Ok(Err(CaptureRefusal::HistorianPreludeOversize));'
                assert mutated.count(anchor) == 1
                mutated = mutated.replace(anchor, '        if false && bytes > MAX_HISTORIAN_PRELUDE_BYTES { // NON-VACUITY BREAK final byte fence omitted\n            return Ok(Err(CaptureRefusal::HistorianPreludeOversize));')
            p.write_text(mutated)
            lines = [line.strip() for line in p.read_text().splitlines() if 'NON-VACUITY BREAK' in line]
            stat = subprocess.check_output(['git', 'diff', '--stat', '--', path], text=True).strip()
            print(f'CONTROL {ident} {path}: {lines}; diff={stat!r}', flush=True)
            proc = subprocess.run(['cargo', 'test', '-p', 'mc-store' if path.startswith('crates/mc-store/') else 'mc-module', '--lib', filt, '--', '--test-threads=1'], text=True, capture_output=True, timeout=1200,
                                  env=dict(os.environ, RUSTC_WRAPPER='', CARGO_BUILD_RUSTC_WRAPPER=''))
            out = proc.stdout + proc.stderr
            failed = re.findall(r'^test (\S+) \.\.\. FAILED$', out, re.M)
            summary = [line for line in out.splitlines() if line.startswith('test result:')]
            errors = [line for line in out.splitlines() if line.startswith('error[')]
            outcome = 'reddened' if proc.returncode != 0 and len(failed) == 1 and filt.split('::')[-1] in failed[0] and not errors else 'undefended'
            result = dict(id=ident, path=path, filter=filt, outcome=outcome, failed=failed, summary=summary, errors=errors, applied=stat)
            if outcome != 'reddened':
                print(out[-6000:], flush=True)
            print('RESULT ' + json.dumps(result), flush=True)
            results.append(result)
        finally:
            shutil.copyfile(backup, p)
            os.utime(p, None)
            assert p.read_bytes() == original
            stat = subprocess.check_output(['git', 'diff', '--stat', '--', path], text=True).strip()
            print(f'RESTORED {ident}: diff={stat!r}', flush=True)
            assert not stat, 'stage live implementation before running mutations'
print('MUTATION SUMMARY ' + json.dumps(results), flush=True)
if any(r['outcome'] != 'reddened' for r in results):
    sys.exit(1)
