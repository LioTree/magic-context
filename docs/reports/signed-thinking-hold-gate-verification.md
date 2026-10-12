# Signed-thinking hold default-off gate verification

## Contract

`signed_thinking_hold: "off" | "on"` is a user-only setting, defaulting to `"off"`.
Project configuration is stripped before merging in TypeScript and ignored with a
warning in the Rust configuration reader. The setting does not disable the
existing current-turn cached-head veto, tag-target protections that refuse new edits
before current signed thinking (issue 630), or
strict thinking-binding recovery. The context.db v100 columns and store.db v67
fence are retained.

## Independent default-off differential

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

All executable verification ran on Linux. Stores and session/config roots were
in-memory or under `$TMPDIR/magic-context/`; no live store was used. Package
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
