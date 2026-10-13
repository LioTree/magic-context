# Signed-thinking hold default-off gate verification

## Contract

`signed_thinking_hold: "off" | "on"` is a user-only setting, defaulting to `"off"`.
Project configuration is stripped before merging in TypeScript and ignored with a
warning in the Rust configuration reader. The setting does not disable the
existing current-turn cached-head veto, tag-target protections that refuse new edits
before current signed thinking (issue 630), or
strict thinking-binding recovery. The context.db v100 columns and store.db v67
fence are retained.

## Independent default-off differential before reconciliation

The source oracle is the commit shared by master and the train before the hold changes,
`9d26c87081a9925217fa09698ce08e7a092e1f4d`, extracted with `git archive` into an
isolated temporary root. The same seeded pass driver runs against the archived
source and the candidate; expected bytes are not derived from candidate code.

- TypeScript/OpenCode: 18 sessions, 504 passes (both store generations).
- Pi: 18 sessions, 504 passes.
- Rust: 36 sessions, 1008 passes across OpenCode, Claude Code and owned-Broca profiles.
- Seed: `630665`. Primary/subagent, signed/unsigned thinking, model classes,
  repeated replay, new user turns, pressure bands, flushes and queued drops are varied.
- Compare complete served-message JSON bytes and stored decisions, including tag,
  pending-operation and session metadata, plus Rust `CoreState` and its saved
  immutable edit/replay decisions (`FrozenUnit` records).
- Ignore only additive unrelated memory schema fields: TS
  `cached_m0_score_selection_watermark`, Rust `memory_projection` and
  `score_selection_watermark`. Newly introduced hold metadata must remain null;
  the new columns are absent from the oracle schema.
- A separate Rust regression seeds saved release obligations, then verifies that
  the disabled runtime preserves them unchanged and serves/plans exactly like a
  session without those obligations.

Commands run using Bun 1.4.2 and rustc/cargo 1.99.0:

```sh
bun test scripts/signed-thinking-hold-differential.test.ts --test-name-pattern '^signed-thinking hold off'
MC_HOLD_RUST_DIFFERENTIAL=1 bun test scripts/signed-thinking-hold-differential.test.ts --test-name-pattern 'Rust signed-thinking'
cargo test -p mc-module signed_thinking_hold_off_ignores_saved_release_obligations --lib
```

All passed on Linux. The first differential has 1010 assertions; the Rust
source differential has 1009 assertions. The Rust saved-obligation regression
runs one test.

### Mutation controls

Every mutation was applied over staged live files, with a non-empty working diff,
then restored from the index and touched; the working diff was empty after each
restore. No mutation is committed.

| Control | Result |
|---|---|
| Remove only the first-render conditional gate in TS | Differential stayed green. The generated corpus did not reach a signed-thinking request whose synthetic history/memory pair has never been cached. This control is not claimed as proof. |
| Leave the TS postprocess runtime consumer ungated (`holdEnabled = true`) | Only `signed-thinking hold off matches pre-hold served bytes and stored decisions (seed 630665)` failed, at OpenCode pass 37. Served bytes, reclaim watermark (9 versus 5), and caveman depth (1 versus 0) differed. |
| Leave Rust admission ungated (`hold_enabled = true`) | Only `transform::tests::signed_thinking_hold_off_ignores_saved_release_obligations` failed: a previously absent held-release obligation was written. |

## Opt-in audit parity before reconciliation

The audit source baseline is
`3549c4340ef37066f6690fb466824ac752ba0cbb`. Both baseline and candidate are run
in isolated subprocesses. Candidate fixtures explicitly opt in; their assertions
are unchanged.

```sh
bun test scripts/signed-thinking-hold-audits.test.ts
```

The comparison test passed (16 assertions). Default audits are **171 pass / 0 fail**
before and after. Strict audits are **141 pass / 30 fail** before and after, with
the following exact failure set. The strict suite intentionally exposes unfinished
lanes; this change does not finish them or weaken those assertions. In the literal
test names below, `m[0]/m[1]` denotes the synthetic history/memory pair and `recomp`
denotes recomputation of stored compartment summaries.

| Exact test name | Before | After |
|---|---|---|
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > compaction-marker summary retired by a bust: mid tool loop | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > frozen-sentinel first application | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > m[0]/m[1] re-render after a recomp clears the cached pair | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > processed image strip | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > release survives a restart: /ctx-flush | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > stale ctx_reduce strip | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > synthetic todo | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, subagent run > frozen-sentinel first application | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, subagent run > stale ctx_reduce strip | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > compaction-marker summary retired by a bust: mid tool loop | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > frozen-sentinel first application | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > m[0]/m[1] re-render after a recomp clears the cached pair | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > processed image strip | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > release survives a restart: /ctx-flush | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > stale ctx_reduce strip | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > synthetic todo | fail | fail |
| signed prefix audit: OpenCode 2, subagent run > frozen-sentinel first application | fail | fail |
| signed prefix audit: OpenCode 2, subagent run > stale ctx_reduce strip | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > frozen-sentinel first application | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > m[0]/m[1] re-render after a recomp clears the cached pair | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > release survives a restart: /ctx-flush | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > synthetic todo | fail | fail |

## Package and crate gates before reconciliation

All executable verification ran on Linux. No live store was used: corpus and
narrow guards only create throwaway databases, while package/full Rust jobs
redirect HOME, TMPDIR and session/config roots under `$TMPDIR/magic-context/`.
The new Rust fixtures also constrain their own directories to that subtree.
Package
suites need distributions built in the **same** remote job and scoped Git
identity/safe-directory settings under the throwaway HOME. Without those
prerequisites, worker-loading and project-identity tests fail environmentally.

| Gate | Result |
|---|---|
| `bun run typecheck`; dedicated corpus `tsc --noEmit -p scripts/tsconfig.signed-thinking-hold.json` | Pass, TypeScript 5.9.3 |
| `bun run lint` | Pass, Biome 2.5.1; 1408 plugin, 282 Pi, 137 CLI and 6 retina files checked; existing warnings retained |
| `bun run build:dists` | Pass, two distributions load successfully; 9 compiled TUI files unchanged |
| Plugin full suite after build/Git setup | 8407 pass, 19 skip, 2 fail, 8428 total |
| Pi full suite after build/Git setup | 1856 pass, 9 skip, 0 fail, 1865 total |
| CLI suite | 631 pass, 2 skip in the main 633-test run; repair subprocess 9 pass, 1 fail |
| `cargo test -p mc-module -p mc-store` | Module unit target: 1927 pass, 27 ignored; subsequent real-daemon target failed because external artifacts were absent, so this combined command did not reach store tests |
| `cargo test -p mc-store` | 333 pass, 5 ignored; zero failures |
| `cargo test -p mc-module --test signed_thinking_prefix_audit` | 17 pass, zero failures, hold enabled |
| `cargo fmt --check`; `cargo clippy -p mc-module -p mc-store --all-targets -- -D warnings` | Pass |
| Focused schema/project security, latest-turn thinking, issue-630 Pi, bounded auto-search | 87 pass, zero failures |

Remaining unrelated failures:

- `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`:
  temporary generated bundle cannot resolve `onnxruntime-web/webgpu` (already
  documented in `docs/reports/provider-pipeline-master-trim-consequence.md`).
- `slow embedding aborts at the deadline, freezes skip bytes, and cannot land late`:
  known full-suite timing flake. Its unchanged focused file passes all 8 tests;
  see the same baseline qualification report.
- `doctor repair-db > backs up and salvages readable rows from a genuinely corrupted SQLite page`:
  replaying `.recover` output fails because this SQLite shell emits reserved
  `sqlite_sequence`, `sqlite_master` and `sqlite_stat1` writes that the replay rejects.
  The command and test are byte-identical to `9d26c87081` (Git blobs
  `a97c4a317a9b441a0c358bc62bbb4caa39e4ba16` and
  `ca579d151f3c90c047f666d4ed8791683771bcfc`).
- The four real-daemon artifact tests stop at `real_daemon.rs:1110` with
  `No such file or directory` before reaching transforms. No external checkout
  was accessed or built to work around this unavailable fixture.

The Linux runner initially refused 16-core jobs twice while permits were busy.
A 4-core package-scoped retry compiled and ran the differential;
later module/store suites and clippy ran with 16 requested cores. No Rust test or
build was run on macOS.

## Reconciliation follow-up completed for the supplied tip

Merged `85319552a5b6523470d2a79da4194ff9ca133a35` and the placeholder/system-injection
slice (s5), `2d19947cb6bd3724dad74f05073e1db08323f621`, directly so its new runtime
could be gated without waiting for a separate train integration. The resolutions retain master's
stable Pi identity resolver, mutable reclaim permission and atomic served-number publication.
New strip admission (refusing new removals before kept thinking) and consumers that spend
queued history-refresh permission are behind `signed_thinking_hold`.

Two Pi repairs remain always on: stable-ID migration cannot newly omit previously served text,
and a refused reminder edit withdraws only a decision added by that edit, never an existing
replay decision. Their handler/cleanup regression cases explicitly use `signedThinkingHold: "off"`.

The issue-665 Rust change prevents a held signed-thinking request from reporting a cache
bust and adds its always-on reset handling. Master `62f20c02` does **not** yet include
that merge, `1c947fb0e8` (the `signed_prefix_hold*` tests); the OpenCode/Pi revision is
also still pending. This branch neither implements nor verifies that unmerged reset.
Its preservation target is master's existing protections at `62f20c02`: all 14 focused
tests for latest-turn protection, rejection recovery and retained historical omissions pass
with the experimental hold off. Confirmation against the newer always-on Rust hold/reset
remains for the next train reconciliation. No unlanded implementation or shim was invented.

### Reconciled independent oracle and isolation

The current oracle is the hold-free master source `62f20c02ff99d132dd67d4ad727330f5de855e14`.
The older `9d26c87081` results above remain historical evidence, not the current comparison:
master's served-tag publication is deliberately preserved instead of discarding its stored
`piServedTagNumbers` safety metadata. Both sources use the same project directory path,
but independent HOME/XDG roots so the candidate cannot inherit the oracle's session ledgers.
Expected bytes and decisions still come from independent archived source, with exact equality.

Rust oracle build caches are keyed by the source revision. `git archive` preserved old
source-file modification times, so Cargo initially reused stale tokenizer metadata lacking
`history_render_paragraph_counts` and `estimate_history_render_tokens`, although both
functions were in the archived source. A revision-isolated cache fixes the build without
changing source or expected output. The final Rust comparison passes all 1008 records
and 1009 assertions.

All resumed checks used Linux with four requested CPUs. The TS/Pi differential passes all
1008 records and 1010 assertions. Forcing the reconciled TS consumer's `holdEnabled = true`
reddens only that differential, first diverging at its OpenCode record 37: served bytes,
the highest reclaimed tool-tag number (watermark), and text-compression depth differ.
This proves the comparison notices the enabled hold, rather than passing vacuously.
The applied mutation was +1/-1 in one file, with an empty working diff before applying it
and after restoring/touching the staged file; no mutant remains. The restored comparison passes.

### Reconciled opt-in audit comparison

The source baseline for enabled behavior is the unmodified placeholder/system-injection
admission tip (s5), `2d19947cb6bd`. Normal audits pin known unfinished behavior; strict
mode (`MC_AUDIT_STRICT=1`) instead makes those open binding violations red. The
comparison test passes with 16 assertions: default audits are **179 pass / 0 fail** before
and after; strict audits are **154 pass / 25 fail** before and after. All 25 strict failures
already existed at the baseline, and their exact unchanged names are listed below.


| Exact current test name | Before s5 source | After gated merge |
|---|---|---|
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > compaction-marker summary retired by a bust: mid tool loop | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > m[0]/m[1] re-render after a recomp clears the cached pair | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > processed image strip | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > release survives a restart: /ctx-flush | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > stale ctx_reduce strip | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > synthetic todo | fail | fail |
| signed prefix audit: OpenCode 1 TS mode, subagent run > stale ctx_reduce strip | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > compaction-marker summary retired by a bust: mid tool loop | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > m[0]/m[1] re-render after a recomp clears the cached pair | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > processed image strip | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > release survives a restart: /ctx-flush | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > stale ctx_reduce strip | fail | fail |
| signed prefix audit: OpenCode 2, primary mid tool loop > synthetic todo | fail | fail |
| signed prefix audit: OpenCode 2, subagent run > stale ctx_reduce strip | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > m[0]/m[1] re-render after a recomp clears the cached pair | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > release survives a restart: /ctx-flush | fail | fail |
| signed prefix audit: Pi/OMP, primary mid tool loop > synthetic todo | fail | fail |

### Reconciled package and focused checks

| Gate | Current result |
|---|---|
| Package typechecks and dedicated driver typecheck | Pass, TypeScript 5.9.3 |
| `bun run build:dists` | Pass; both built distributions load; 9 TUI compiled files unchanged |
| `bun run lint` | Pass, Biome 2.5.1; 1461 plugin, 318 Pi, 138 CLI and 6 retina files checked |
| Full plugin suite | 8655 pass, 30 skip, 1 baseline WASM fixture failure (8686 tests) |
| Full Pi suite | 2157 pass, 43 skip, 0 fail (2200 tests) |
| CLI suite | 640 pass, 2 skip in main run; separate repair subprocess 9 pass, 1 unchanged SQLite `.recover` failure |
| Rust compilation, `cargo test -p mc-module --no-run` | Pass; all 21 module test executables compiled |
| Enabled Rust signed-thinking prefix audit | 17 pass, 0 fail |
| Disabled Rust saved-obligation regression | 1 pass, 0 fail |
| Rust fmt and all-target mc-module/mc-store clippy | Pass |
| Existing master latest-turn, rejection-recovery and historical-omission regressions | 14 pass, 0 fail |
| Reconciled `mc-store` suite | 333 pass, 5 ignored, 0 fail |
| Enabled s5 strip, history, reminder and trigger-parking probes | 27 pass; the single known restart-durability reproducer remains red |

The s5 opt-in reproducer `a kept history refresh survives restart until safe release`
is a documented pre-existing limitation in `docs/reports/signed-thinking-s03a-review.md`:
the history-refresh trigger is process-local. Its assertion is unchanged. The full opt-in
probe run reports 27 pass / 1 fail; the positive-control run excludes only that named
reproducer and reports 27 pass / 0 fail / 1 filtered. No hold durability work was added.

The source comments were reviewed and unclear new explanations rewritten. The merged
lockfile/package changes were installed with `bun install --frozen-lockfile` (four packages
installed), and the package suites above were rerun in the isolated worktree. All resumed
verification commands explicitly requested `linux,4c`; no live stores or external checkout
were used.

## Directed cold-bootstrap coverage (first-render gap closed)

The randomized corpus did not start with signed thinking already present and both
cached head columns missing. A directed source-oracle case now covers that state
through the real OpenCode and Pi transforms, with `signedThinkingHold: "off"`:

- Fresh in-memory session; `cached_m0_bytes` and `cached_m1_bytes` are both null.
- A real user message followed by signed Opus 5.5 thinking and eligible text after
  that boundary. Twenty later tool results put the text outside the protected tail.
- No previous transform pass, no pending materialization or operations, no history
  publication, no subagent execute, no idle expiry and no force-band pressure.
  OpenCode's scheduler is explicitly deferred; Pi has warm TTL, 20% usage and an
  already-current stable-ID scheme, so migration does not supply another trigger.
- The independent master baseline `62f20c02` selects the strongest stored text
  compression tier (`caveman_depth=3`) solely on the first-render opportunity.
  The candidate must match the complete served bytes and stored
  decisions, not just a derived permission flag. Independent HOME/XDG roots and
  the same project path are retained.

The corresponding Rust first-render path is an uninitialized-cache HARD classifier
bootstrap, not a separate TS/Pi `firstRenderBust` permission expression. The directed
Rust corpus covers OpenCode, Claude Code and owned-Broca profiles with no prior
m[0]/m[1], no flush/force/history trigger and signed thinking already present. Both
master and the disabled candidate initialize the cache and freeze m[0]/m[1]; their
complete served bytes, metadata and core decisions must match. The test compares
actual output and stored state, rather than treating a permission predicate as proof
that bootstrap did or did not happen.

Command, on Linux with four requested CPUs (Bun 1.4.2, cargo 1.99.0):

```sh
MC_HOLD_RUST_COLD_DIFFERENTIAL=1 bun test scripts/signed-thinking-hold-differential.test.ts
```

### Exact first-render mutation receipts

| Applied control | Only failing test | Other executed tests that stayed green | Observable difference |
|---|---|---|---|
| TS: replace `!(holdEnabled && freezeM0M1)` with `!freezeM0M1` in `firstRenderBust` | `OpenCode cold signed-thinking bootstrap matches master bytes and decisions` | Existing randomized TS/Pi differential (1008 request records), Pi cold case, Rust cold case | Served text differs; compression depth 3 → 0; reclaim watermark 23 → 0 |
| Pi: replace `!(holdEnabled && protectedSignedPrefix)` with `!protectedSignedPrefix` in `firstRenderBust` | `Pi cold signed-thinking bootstrap matches master bytes and decisions` | Existing randomized TS/Pi differential (1008 request records), OpenCode cold case, Rust cold case | Served text differs; compression depth 3 → 0; reclaim watermark 23 → 0; protection-floor decisions differ |
| Rust: force the newly classified cold signed bootstrap to `PassPlan::Defer` | `Rust cold signed-thinking bootstrap matches master bytes and decisions` | Existing randomized TS/Pi differential (1008 request records) and both host cold cases | Synthetic head bytes disappear, m[0]/m[1] units are absent, and initialization/fold metadata differ |

Every control was applied over staged live files with an empty working diff. A
`NON-VACUITY BREAK` comment marked each temporary source edit as a deliberate
break proving the corresponding comparison could fail. The controls ran separately.
TS and Pi each produced a one-file
+2/-1 diff; Rust produced a one-file +4/-0 diff. Each run reported exactly three
passes and one failure, with the unrelated long Rust randomized differential
explicitly skipped. Each mutant was restored from the index and touched, with an
empty working diff afterward. No production change is committed for this coverage.

The originally undefended TS first-render control is now defended by its directed
cold case; the earlier green result in the **Mutation controls** table remains only
as historical evidence of the coverage gap that prompted this addition.

Final restored verification: **4 passed / 1 skipped / 0 failed**, 1029 assertions
(the existing TS/Pi randomized differential and all three directed cold cases).
The skipped test is only the separate long randomized Rust differential; the
three-profile directed Rust fixture executes in both independent source trees.
TypeScript 5.9.3 checks, Biome 2.5.1 checks for the touched scripts, Rust formatting
and targeted mc-module cold-corpus clippy all pass.
