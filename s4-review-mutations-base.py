#!/usr/bin/env python3
"""Remove one slice-4 guard at a time and run the async-provider tests.

Each mutant edits one tracked file in place, prints the mutated line, runs
the non-ignored `providers::async_provider` tests and restores the file from
a copy under $TMPDIR (never git). Prints the failing test names per mutant.
"""
import os, re, shutil, subprocess, sys, tempfile, hashlib

ROOT = os.getcwd()
AP = "crates/mc-module/src/providers/async_provider.rs"
CR = "crates/mc-module/src/providers/async_provider/cut_runtime.rs"
CS = "crates/mc-module/src/providers/async_provider/cut_seed.rs"
MUTANTS = [
 ("M01 descending Setup: cut lineage must equal descends_from lineage", CR,
  "            .filter(|cut| cut.lineage == descends.lineage_id)\n",
  "            // NON-VACUITY BREAK lineage filter removed\n"),
 ("M02 keep_published_cut: produced view renders below the cut", CR,
  "        if self.produced_view.iter().any(|held| {",
  "        if false && self.produced_view.iter().any(|held| { // NON-VACUITY BREAK"),
 ("M03 forward_parent_history: child history unchanged since staging", CR,
  "                == parent.revision\n        {",
  "                == parent.revision\n            || store.compartment_source_revision(&parent.namespace).map_err(transient)? != parent.revision // NON-VACUITY BREAK\n        {"),
 ("M04 skip check: pending parent history forces a pass", AP,
  "        if state.pending_parent_history.is_some() {\n            return Ok(false);",
  "        if false && state.pending_parent_history.is_some() { // NON-VACUITY BREAK\n            return Ok(false);"),
 ("M05 announce: view whose cut is not the kept cut is withheld", AP,
  "                    || view.cut.as_ref().is_some_and(|cut| {",
  "                    || false && view.cut.as_ref().is_some_and(|cut| { // NON-VACUITY BREAK"),
 ("M06 read: never below the cut's first ordinal", AP,
  "        from = from.max(state.cut_first_ordinal.unwrap_or(0));",
  "        // NON-VACUITY BREAK from = from.max(state.cut_first_ordinal.unwrap_or(0));"),
 ("M07 cut only above the lineage's first ordinal", AP,
  "            .filter(|first| *first > state.lineage_first_ordinal);",
  "            .filter(|first| *first > 0); // NON-VACUITY BREAK"),
 ("M08 fresh start: notice first_ordinal must equal session.head", CR,
  "            if header.parse::<u64>().ok() != Some(first) {",
  "            if false && header.parse::<u64>().ok() != Some(first) { // NON-VACUITY BREAK"),
 ("M09 ctx_reduce: summarized tags removed after the catch-up read", AP,
  "                (targets, unknown) = resolve(&state)?;\n                unknown.retain(|number| !summarized.contains(number));",
  "                (targets, unknown) = resolve(&state)?; // NON-VACUITY BREAK"),
 ("M10 descending Setup: applied = the cut's view", CR,
  "        state.applied = Some(cut.version);",
  "        // NON-VACUITY BREAK state.applied = Some(cut.version);"),
 ("M11 save: published cuts pruned with retired views", AP,
  "            self.published_cuts.retain(|_, cut| cut.version >= floor);",
  "            // NON-VACUITY BREAK published_cuts retain removed"),
 ("M12 publish: split the head at the restart point", AP,
  "            cut_runtime::split_head_at(&mut ranges, first);",
  "            // NON-VACUITY BREAK cut_runtime::split_head_at(&mut ranges, first);"),
 ("M13 descending Setup: a repeated Setup is idempotent", CR,
  "        if state.setup.descends_from == request.descends_from && state.lineage == request.lineage_id\n",
  "        if false && state.setup.descends_from == request.descends_from && state.lineage == request.lineage_id // NON-VACUITY BREAK\n"),
 ("M14 seed capture: cut must be a historian restart point", CS,
  "        if !aggregates.historian_input.is_start(first) {",
  "        if false && !aggregates.historian_input.is_start(first) { // NON-VACUITY BREAK"),
 ("M15 seed capture: cut must not split a tool arc", CS,
  "                    } if !calls.contains(id) => return Ok(Err(CaptureRefusal::SplitsToolArc)),",
  "                    } if false && !calls.contains(id) => return Ok(Err(CaptureRefusal::SplitsToolArc)), // NON-VACUITY BREAK"),
 ("M16 seed capture: summaries must cover every row below the cut", CS,
  "            || next <= cut as i64",
  "            || false && next <= cut as i64 // NON-VACUITY BREAK"),
]

def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()

def run_tests(label):
    env = dict(os.environ, RUSTC_WRAPPER="", CARGO_BUILD_RUSTC_WRAPPER="")
    cmd = ["cargo", "test", "-q", "-p", "mc-module", "--lib", "providers::async_provider", "--", "--test-threads=4"]
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=int(os.environ.get("MUT_TIMEOUT", "2400")))
    out = proc.stdout + proc.stderr
    failed = sorted(set(re.findall(r"^    (providers::\S+)$", out, re.M)))
    summary = [l for l in out.splitlines() if l.startswith("test result")]
    compile_err = [l for l in out.splitlines() if l.startswith("error[") or l.startswith("error:")][:3]
    print(f"{label}: exit {proc.returncode}; {summary[-1] if summary else 'no summary'}; failed={failed}; errors={compile_err}", flush=True)
    if not summary or failed:
        tail = [l[:300] for l in out.splitlines() if "panicked" in l or "FAILED" in l or "error" in l.lower()][:12]
        print(f"{label}: output lines {tail}", flush=True)
    return failed

only = sys.argv[1:]
scratch = tempfile.mkdtemp(prefix="s4mut-", dir=os.environ.get("TMPDIR"))
if not only or "baseline" in only:
    run_tests("BASELINE (no mutation)")
for name, path, old, new in MUTANTS:
    if only and name.split()[0] not in only:
        continue
    source = open(path).read()
    count = source.count(old)
    if count != 1:
        print(f"{name}: SKIPPED, pattern found {count} times", flush=True)
        continue
    backup = os.path.join(scratch, os.path.basename(path))
    shutil.copyfile(path, backup)
    before = sha(path)
    try:
        open(path, "w").write(source.replace(old, new))
        mutated = [l.strip() for l in open(path).read().splitlines() if "NON-VACUITY BREAK" in l]
        print(f"{name}: mutated {path}: {mutated}", flush=True)
        run_tests(name)
        if name.startswith("M11"):
            # Is the refused revert to an earlier cut (S4-03) this prune?
            env = dict(os.environ, RUSTC_WRAPPER="", CARGO_BUILD_RUSTC_WRAPPER="")
            proc = subprocess.run(["cargo", "test", "-q", "-p", "mc-module", "--lib", "slice4_review::s4_03", "--", "--ignored", "--test-threads=1"], env=env, capture_output=True, text=True, timeout=900)
            lines = [l for l in (proc.stdout + proc.stderr).splitlines() if "test result" in l or "Setup {" in l]
            print(f"{name}: s4_03 under the mutant: exit {proc.returncode}; {[l[:300] for l in lines[:3]]}", flush=True)
    finally:
        shutil.copyfile(backup, path)
        os.utime(path)
        print(f"{name}: restored {path} identical={sha(path) == before}", flush=True)
