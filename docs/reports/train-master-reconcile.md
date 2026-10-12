# Migration train / master reconciliation

## Merge boundary and release status

- Train parent: `3549c4340ef37066f6690fb466824ac752ba0cbb`.
- Incoming master parent: `62f20c02ff99d132dd67d4ad727330f5de855e14`.
- Reconciliation is a single ordinary merge commit, not a rebase or squash. The first attempt used `f6a40f570081b97686d95f09b38031bd3fee94ca`; master advanced during resolution. The uncommitted merge was restarted at `62f20c02`, retaining the combined resolutions. Subsequent master pushes were deliberately not chased.
- Master's LKG release accounting, Pi identity/per-pass/reclaim fixes, historian temperature, large-session composition optimizations, OMP dispatch/diagnostics, wrapup/boundary fixes, auto-search fixes and CLI doctor changes are merged along with the train features.
- **This report is not an all-green release approval.** The remaining strict signed-thinking audit findings, the SQLite salvage fixture, the WASM fixture and unavailable sibling-repository daemon fixtures are listed below. Nothing in this merge suppresses those gates.
- `docs/reports/migration-train-ship-readiness.md` is absent from this checkout; the historical report at `430b70ba6f` was consulted. Only this explicitly requested reconciliation report was created. `ARCHITECTURE.md` and `STRUCTURE.md` were not edited.

## All conflicted files and resolutions

There were 15 conflicted files (22 conflict regions). No whole-file side selection was used.

| Conflicted file | Combined resolution |
| --- | --- |
| `crates/mc-module/src/m0_compose.rs` | Reuse the caller's already-read `CompartmentScoreSnapshot`, not just bare compartments. Coverage, render-time importance and committed score watermark use the same snapshot. This retains master's single-read optimization and the train's rescore semantics. |
| `crates/mc-module/src/transform.rs` | HARD, recut and pressure-refold paths share their row/score snapshot with composition and coverage guards. Retain the marker probe's chosen composition/watermark, `MarkerMemorySource`, served memory projection, frozen cutoff and mural. Marker probes use the committed score watermark; independently authorized rebuilds use Latest. |
| `packages/e2e-tests/scripts/validate-mode-manifest.test.ts` | Keep both sides' manifest entries and test classifications. Update the exact inventory assertion to the combined 190 live e2e test files; the validator checks each path exactly once. |
| `packages/e2e-tests/tests/opencode2/marker-s3-runtime.test.ts` | Keep the train's lease-aware wait, additional eligible source, deterministic ownership-overlap control and completed-tool/output assertions; retain master's explicit `directRequested` positive control. The shared lease helper replaces master's direct count query without weakening the wait. |
| `packages/pi-plugin/src/context-handler.ts` | Keep trigger parking and materialization holds beside master's auto-search lifecycle and mutable reclaim-ride decision. Use master's atomic served-number publication/error containment while retaining train certification. Keep the bounded target-number loop and settle parked triggers after collecting served numbers. |
| `packages/pi-plugin/src/pi-lkg.ts` | Keep master's `PiLkgUncapturable` serialization failure for paired publication, and the train's `certify`-aware drop for standalone captures. Retain detached capture inputs, move digests and served-capture identity. |
| `packages/plugin/src/features/magic-context/dreamer/verify.ts` | Keep master's duplicate-memory hash refusal before applying an update; retain the train's gated canonical correction, undo history and no mutation-log publication on SOFT. |
| `packages/plugin/src/features/magic-context/storage-db.ts` | Install both the train's version-gated rescore/lifecycle schemas and master's connection-local tag identity revision trigger. No migration step or fence was changed. |
| `packages/plugin/src/features/magic-context/storage-meta.test.ts` | Retain explicit train runner/score/memory table cleanup assertions and master's per-execution transaction assertions over the complete table inventory. Replace the stale fixed prepare-call count with semantic coverage, because master's tombstone ownership bookkeeping adds preparation work. |
| `packages/plugin/src/features/magic-context/storage-session-tables.ts` | Retain reservation release, retained turn-two child cleanup and uncommitted publication deletion alongside master's harness-owner tombstone recording. Both inventories remain within the caller's cleanup transaction. |
| `packages/plugin/src/hooks/magic-context/compartment-runner-historian.ts` | Pass both `retainChild` and master's fallback/session-fallback accounting task to the fallback runner. Retain the independently auto-merged temperature and output-cap handling. |
| `packages/plugin/src/hooks/magic-context/lkg-persist.ts` | Accept both train force-save options and master's publication callback. A matching fingerprint skips work only when neither force nor a callback is present; safety metadata executes inside the slot transaction. Certification/supersession checks and chunk persistence remain intact. |
| `packages/plugin/src/hooks/magic-context/lkg-replay.ts` | Use master's shared bounded exact-field digest cache, provider-visible projection and versioned replay fence; retain the train's non-enumerable detached move digest. Pristine fields are captured before later message mutation. |
| `packages/plugin/src/v2/hooks/context.ts` | Keep the train's provider-aware system/slot entry handling and master's other entry fixes. Remove the obsolete checkout-claim branch, as explicitly approved: AGENT_SYNC draft 11 uses Entorhinal-driven move operations and MC-C16 is retired. No removed checkout client was resurrected. |
| `packages/plugin/src/v2/hooks/payload.ts` | Combine master's Anthropic empty-text omission/one-time diagnostics with the train's native-provider render caches, metadata/bridge retention and private cloning before publishing host drafts. Empty-content eligibility consults the correct saved template. |

## Schema and retired-claim checks

- `context.db` steps 96, 97, 98, 99 and 100 remain unchanged and contiguous in `migrations.ts`; that entire file is byte-identical to the train parent.
- `store.db` registrations 64–69 are byte-identical to the train parent. Their ordered versions were compared to `[64,65,66,67,68,69]`; the corresponding migration definitions were retained. No compatibility migration, renumbering or shim was introduced.
- Full plugin migration tests and the `mc-store` suite exercised the retained schema chain on throwaway stores.
- No active `checkout-claim` import/reference remains under `packages`. The remaining mentions are retirement/history comments in `user-facing-codes.ts` and `opencode2/pins.test.ts`. Both OpenCode 2 pin tests pass, including the v1 entry hash after the deliberately retired check.

## Additional merge-integration repairs

1. Stage the train's Broca conformance executable through master's shared `tests/support/executable.rs` helper before spawning. The repository-wide Rust spawn guard checks train-born provider/host-runner/turn-two test sources too. The TypeScript e2e/rig spawn scanner also passes.
2. Allocate the new master executable-staging test's fixture through the train's registered temporary-directory helper. This satisfies the source temporary-directory policy without weakening it.
3. Wait for scheduled historian turn-two work in the turn-one review test's teardown, before closing its database. The wait uses the existing settle helper and a 3-second rejection deadline; runtime scheduling remains asynchronous and unchanged.
4. Bound the historical differential capture child at 30 seconds, matching the existing spawn deadline rather than Bun's implicit 5-second test timeout. This cleared a load-dependent timeout without changing what is compared.

## Reviewed cache-contract decisions

### SOFT memory and independent compose goldens

The task giver explicitly confirmed the train's reviewed policy:

> SOFT no longer picks up canonical memory rows; it replays served memory and waits for HARD.

Authorized session fragments still append through the train's projection. Master's old compose goldens encoded canonical memory pickup on SOFT, so their hashes could not be retained unchanged.

The replacement goldens were **not generated by the merged optimized composer**. For a one-off reference run:

- Replace `m0_compose.rs` and `decay_render.rs` with their complete source from `3549c434`.
- Restore `compose_hard_fold_m0` from the same train source.
- Route the merged fixture's fold calls through that train `compose_m0_from_store_timed` entry instead of the new preloaded-snapshot helper. The reference performs the separate composition read.
- Leave `m1_compose.rs` unchanged: it is byte-identical to the train parent and contains the reviewed served-memory/fragment policy.
- Temporarily omit the new helper-specific `compose_review_head` test module, which is not part of the golden generator.
- Run the existing generators over **all** four large-session seeds and four review worlds / three sessions. Restore the staged merged sources before comparison.

Reference source SHA-256 receipts:

| Source | SHA-256 |
| --- | --- |
| Train `m0_compose.rs` | `66168a6e01a3155fe0505998a2dbccf307095f9e77568cda900c16a01874feb0` |
| Train `decay_render.rs` | `25ae79d444150e9aac865b61194496913f4e0c41ca35009b20356959c4e88516` |
| Train `compose_hard_fold_m0` function | `1b6328757bb9156f95465e7ffe011ca2d2135e4ff564d17c92cae2c2392e53c5` |

Generator commands (Linux, 16 CPUs):

```sh
MC_COMPOSE_GOLDEN_WRITE=1 cargo test -p mc-module --lib transform::compose_large_session::large_session_compose_differential -- --exact --nocapture
MC_REVIEW_GOLDEN_WRITE=1 cargo test -p mc-module --lib transform::compose_review_differential::compose_review_differential -- --exact --nocapture
```

The remote generator's `GOLDEN` output was copied back after restoring the merged sources:

| Committed golden | Rows | SHA-256 |
| --- | ---: | --- |
| `compose-large-session-golden.txt` | 244 (4 materializations + 240 passes; seeds 11–14) | `bcfc8ad979701f90a66cbead01ce21dafd5794081b0fd8b7eae58fc88ee5eab2` |
| `compose-review-differential-golden.txt` | 336 (4 worlds × 3 sessions × 28 rounds) | `5c45a9424863c033f3923964af95d253ab5008fc8b0cc7d56fd6844edf068e47` |

The restored, sped-up merged composer matches every row. Existing coverage/decision diversity checks were retained. The canonical-SOFT mutation below proves these are not merely new hashes accepted from the implementation under test.

### Versioned LKG digest comparison

The task giver approved retaining master's issue 653 `2.` digest format and adapting **only** `lkg_slots.input_content_digests` in the frozen pre-H4 comparison. Expected digests are recomputed with master's digest function from the frozen historical fixture's echoed pristine inputs, not from the new persisted values. The test asserts the `2.` prefix, 43-character base64url digest structure, array length and actual digest equality. Exact outgoing request bytes and every other write/column remain exact comparisons.

These twelve previously failing tests in `packages/plugin/src/v2/hooks/payload-review2.test.ts` now pass (the final name of each is shown):

- `setting-off differential v1 absent ordinary: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v1 absent checkpoint: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v1 absent restored: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v1 full_request ordinary: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v1 full_request checkpoint: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v1 full_request restored: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v2 absent ordinary: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v2 absent checkpoint: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v2 absent restored: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v2 full_request ordinary: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v2 full_request checkpoint: exact pre-H4 request and writes with versioned LKG digests`
- `setting-off differential v2 full_request restored: exact pre-H4 request and writes with versioned LKG digests`

All 16 historical lanes, the fixture inventory test and both turn-one review tests pass together: 19 tests, 567 assertions. A well-formed but wrong persisted digest is rejected by the adapted comparison, as demonstrated below.

## Non-vacuity / mutation receipts

Each control followed: stage the live files; confirm empty unstaged diff; apply a `NON-VACUITY BREAK`; capture nonempty diff; run the named check; restore with `git checkout -- <path>` and `touch`; capture empty unstaged diff. No mutant is committed.

| Mutated control | Expected red | Observed result | Applied / restored diff |
| --- | --- | --- | --- |
| `m1_compose.rs`: change projected SOFT's independent composer to canonical `compose_m1_from_store` with its real memory budget | `transform::compose_large_session::large_session_compose_differential` | Exactly 1 failed, 0 passed, 1972 filtered; first difference seed 11 / pass 0, unchanged m0, canonical m1 `f909bc9…` instead of served `2b0276c…` | 1 file, +5/-2; empty after restore |
| Same canonical-SOFT control, separate invocation | `transform::compose_review_differential::compose_review_differential` | Exactly 1 failed, 0 passed, 1972 filtered; first difference w0/s0/r12, `ae43ca439d47` instead of reference `63a010b9257e` | Same nonempty diff; empty after restore |
| `broca_conformance/harness.rs`: bypass staging at its actual `Command::new` site | `private_permissions_source_test::binary_spawn_paths_are_staged_before_exec` | Only the named guard failed. `the_creator_scan_flags_planted_direct_store_creators`, `binary_spawn_scan_rejects_direct_build_artifacts`, `data_store_creators_use_the_private_permission_helper` stayed green | 1 file, +2/-1; empty after restore |
| `lkg-persist.ts`: persist valid-looking `2.` + 43 `A` characters instead of the content digest | `setting-off differential v1 absent ordinary: exact pre-H4 request and writes with versioned LKG digests` | Exactly 1 failed, 0 passed, 16 filtered; format assertion accepted the mutant, exact independently computed digest comparison rejected it | 1 file, +2/-1; empty after restore |

## Verification environment and receipts

All builds, lint, typechecks and suites ran on Linux (`linux,8c`; Rust workspace commands `linux,16c`). No Rust workspace or full suite was run on the Mac. There were remote capacity/queue refusals, not a “no remote runner” failure; those commands were retried on Linux, never moved to the Mac.

Tool versions: Bun 1.4.2 (744846f84), TypeScript 5.9.3, Biome 2.5.1, rustc/cargo 1.99.0 (b940084d7 / 5f94df478), clippy 0.1.99, rustfmt 1.10.0-stable.

Every run used a throwaway HOME, XDG_CONFIG_HOME, XDG_DATA_HOME and TMPDIR under `$TMPDIR/magic-context/bg_bb3341919fdd7252`. The initial isolated HOME hid the runner's Git ownership trust and caused project identity failures. Individual reruns reproduced them; the subsequent full suites used `GIT_CONFIG_COUNT=1`, key `safe.directory`, value exactly this worktree's `$PWD`, set inside the command. No wildcard trust or host Git configuration was written. That cleared the Pi/project-identity failures. Building and testing in the same remote job also cleared missing dist-worker failures.

No live OpenCode/CortexKit store, config or Pi session was opened or migrated. Local package installation used the same throwaway host root: `bun install --frozen-lockfile --ignore-scripts` installed 4 packages. Remote plugin/Pi scripts also performed their frozen-lockfile installs. No manifest/lockfile changes beyond the incoming master merge were introduced.

| Gate | Result |
| --- | --- |
| `bun run build` | Passed: plugin/v2, Pi and CLI bundles; 9 TUI generated files checked, 0 changed. |
| `bun run typecheck` | Passed: all 4 scripted package lanes (plugin, Pi, CLI, retina-local-fs). |
| `bun run lint` | Passed: 1460 plugin + 317 Pi + 138 CLI + 6 retina files. Existing warnings/info retained, no errors. |
| Targeted e2e `tsc --noEmit` | Passed for executable-staging and manifest-validator edits; the e2e package has no typecheck script, so an explicit bundler-resolution/no-emit invocation was used. |
| `bun run --cwd packages/plugin test` | Last full run: 8646 passed, 27 skipped, 2 failed / 8675 tests, 828 files. One was the known WASM fixture; the other was a 5-second differential child timeout, subsequently fixed and all 19 affected tests passed. This is not represented as an all-green full-suite run. |
| `bun run --cwd packages/pi-plugin test` | Passed: 2149 tests, 32 skipped, 0 failed / 2181 tests, 217 files. |
| `bun run --cwd packages/cli test` | Standard process passed 640 tests, 2 skipped. Separate repair-db process passed 9 and failed 1; see remaining failures. Earlier FTS-map fault-injection timing failure passed its isolated rerun. |
| `test:validate-manifest` and `validate-mode-manifest` | Passed: 7 tests / 81 assertions; standalone TS manifest invocation list validated; combined inventory 190. |
| E2e executable staging + OpenCode 2 pins | Passed: 5 tests / 35 assertions, including both source spawn scans and entry/release pins. |
| Both signed-thinking audits, default mode | Passed: 171 tests / 27880 assertions. Default mode reports exposed lanes; it is not strict safety approval. |
| Both signed-thinking audits, `MC_AUDIT_STRICT=1` | Failed: 141 passed / 30 failed. Repeated as separate plugin and Pi files: plugin 92/24, Pi 49/6. Exact remaining names follow. |
| `cargo test --workspace` | Executed. Initial module run 1941 passed / 3 failed / 29 ignored; all 3 failures were isolated and fixed (reference goldens, Broca staging). Later module lib run passed 1940 / 29 ignored / 4 filtered; the 4 lengthy previously-passing tests were separately covered, including the final 720-pass and bounded-policy reruns. All other crates passed. Real-daemon integration requires an unavailable sibling checkout; see below. |
| `cargo test -p mc-store -p mc-core -p mc-tokenizer` | Passed: mc-store 333 + 7 integration, 5 ignored; mc-core 22; tokenizer 2 + 4 + 1 tests. Four empty/doc-test targets also exited cleanly. |
| `cargo test -p mc-module --lib compose_` | Passed after restore/final borrow cleanup: 15 passed, 4 intentionally ignored. Both independently generated goldens and publication/snapshot controls pass. |
| `cargo test -p mc-module --lib private_permissions_source_test` | Passed after restoration: all 4 guards/controls. |
| `cargo test -p mc-module --lib tool_catalog_conformance` | Passed: 1 role-conformance suite test. |
| `cargo test -p mc-module --test broca_conformance` | Passed: 13 real provider/subc-wire conformance tests. |
| `cargo test -p mc-module --lib providers::policy_summary::review_tests` | Passed: 13 tests, including 600 production and 600 out-of-band write sequences compared with full computation. |
| `cargo test -p mc-module --lib bounded_policy_summary_does_not_return_the_entire_known_metadata_lineage` | Passed: 1 bounded-summary test. |
| `cargo test -p mc-module --lib r2_review_720_pass_differential_with_new_seeds_and_real_reduce -- --nocapture` | Passed: 720 passes, 46980 per-message byte comparisons, 1850 checked summary replays, seeds 81ac0023 / 519e72a0 / 9c340162 / a107d891. |
| `cargo fmt --check` | Passed (rustfmt 1.10.0). |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed after removing needless snapshot borrows; all 4 workspace crates/all targets checked. |
| Scoped diagnostics | Authoritative TypeScript reports: 0 errors. Other inspection categories were unavailable; the CLI typecheck gates above are authoritative. |
| Comment review | Sidekick reviewed uncommitted comments; its broad results included inherited comments and path gaps. A second narrowed request covered the new comments, but returned a truncated review receipt. Newly authored comments were also checked directly; no unrelated imported-comment cleanup was performed. |

## Remaining failures (not concealed)

### Known WASM fixture environment

`packages/plugin/src/features/magic-context/memory/transformers-node-wasm.test.ts`:

- `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`.
- Reproduced alone before classifying it. The test-owned temporary bundle cannot resolve the external `onnxruntime-web/webgpu` package. The task giver confirmed this is a known environmental fixture failure. Production bundle builds pass; no dependency-resolution shim was added.

### Linux SQLite salvage fixture

`packages/cli/src/commands/doctor-repair-db.test.ts`:

- `doctor repair-db > backs up and salvages readable rows from a genuinely corrupted SQLite page`.
- Reproduced alone: code 2; replaying `.recover` output rejects reserved `sqlite_sequence`, writes to `sqlite_master`, and absent/reserved `sqlite_stat1`. The other 9 repair-db tests pass. This merge does not alter the salvage code or rewrite this expectation. Rerun with the supported recovery shell environment and investigate separately if it persists.

### Unavailable sibling repository for daemon integration

`crates/mc-module/tests/real_daemon.rs`:

- `daemon_artifacts_are_built_and_copied_once`
- `hostless_store_init_first_transform_through_real_daemon`
- `mc_pipe_only_supervision_through_real_daemon`
- `mc_transform_spine_through_real_daemon`

Each was repeated alone and fails at `subconscious_root()` because the isolated Linux workspace has no sibling `subconscious` checkout. No sibling repository was read and no live daemon was used. The Broca conformance harness runs its own throwaway daemon and passes. Provision the declared sibling fixture on CI for these four tests.

### Strict signed-thinking findings

These are behavioral audit findings, **not environmental failures**. Default-mode green audits explicitly do not prove these lanes safe. Each audit file was repeated alone in strict mode. No assertions were rewritten or skipped. Exact failed names are recorded next.

- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > m[0]/m[1] re-render after a recomp clears the cached pair`
- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > synthetic todo`
- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > processed image strip`
- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > stale ctx_reduce strip`
- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > frozen-sentinel first application`
- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > release survives a restart: /ctx-flush`
- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held`
- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop`
- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn`
- `signed prefix audit: OpenCode 1 TS mode, primary mid tool loop > compaction-marker summary retired by a bust: mid tool loop`
- `signed prefix audit: OpenCode 1 TS mode, subagent run > stale ctx_reduce strip`
- `signed prefix audit: OpenCode 1 TS mode, subagent run > frozen-sentinel first application`
- `signed prefix audit: OpenCode 2, primary mid tool loop > m[0]/m[1] re-render after a recomp clears the cached pair`
- `signed prefix audit: OpenCode 2, primary mid tool loop > synthetic todo`
- `signed prefix audit: OpenCode 2, primary mid tool loop > processed image strip`
- `signed prefix audit: OpenCode 2, primary mid tool loop > stale ctx_reduce strip`
- `signed prefix audit: OpenCode 2, primary mid tool loop > frozen-sentinel first application`
- `signed prefix audit: OpenCode 2, primary mid tool loop > release survives a restart: /ctx-flush`
- `signed prefix audit: OpenCode 2, primary mid tool loop > mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held`
- `signed prefix audit: OpenCode 2, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop`
- `signed prefix audit: OpenCode 2, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn`
- `signed prefix audit: OpenCode 2, primary mid tool loop > compaction-marker summary retired by a bust: mid tool loop`
- `signed prefix audit: OpenCode 2, subagent run > stale ctx_reduce strip`
- `signed prefix audit: OpenCode 2, subagent run > frozen-sentinel first application`
- `signed prefix audit: Pi/OMP, primary mid tool loop > m[0]/m[1] re-render after a recomp clears the cached pair`
- `signed prefix audit: Pi/OMP, primary mid tool loop > synthetic todo`
- `signed prefix audit: Pi/OMP, primary mid tool loop > frozen-sentinel first application`
- `signed prefix audit: Pi/OMP, primary mid tool loop > release survives a restart: /ctx-flush`
- `signed prefix audit: Pi/OMP, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop`
- `signed prefix audit: Pi/OMP, primary mid tool loop > prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn`

## Delivery inventory and evidence retention

This merges 251 commits reachable from the incoming master parent but not the train parent. Incoming files such as release notes and existing evidence reports were merged unchanged, not authored as extra scope. The declaration's changed-files inventory includes the merge imports as well as manual resolutions.

Raw Linux stdout/stderr receipts were copied outside all regenerable build directories to:

`/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_bb3341919fdd7252/verification/`

The important receipts are `bash-7eee5ef6c8a69b27` (independent reference generation), `bash-bbe7998c2902655d` (canonical-SOFT mutants), `bash-d41b48d86a7f2c93` (spawn guard mutant), `bash-52340785e8ff0e2c` (wrong versioned digest mutant), `bash-94632b8c321660ae` (final Rust clippy/compose/policy/720-pass gates), `bash-e56de3060c2193cd` (full Pi and CLI suites), `bash-2236c23e2ba02d84` (last full plugin and isolated strict audits), `bash-6f7968a13042fea6` (final typecheck/lint and 19 changed tests), and `bash-9d0352fcbe39e588` (e2e typecheck, staging, pins and manifest). Each has `.stdout.log` and `.stderr.log` suffixes. The report embeds the material results so reviewers need not rely on expiring tool transcripts.

## Remaining Rust integration targets after the daemon stop

The targets after `real_daemon` in Cargo's ordering were explicitly run rather than left unverified:

- `scope_stamp_decode`: 2 passed.
- `serde_json_feature_fidelity`: 1 passed.
- Rust `signed_thinking_prefix_audit`: 17 passed (this does not clear the separate TypeScript strict audit findings).
- `tag_cache_allocation`: 1 passed.
- `temporal_mode_switch`: 1 passed.
- `real_store_copy_migration`: its test process exited successfully, but **the migration lane was not exercised** because `MC_REAL_STORE_COPY` was unset. No real-store copy was requested or read; synthetic store migrations are covered by mc-store's suite.
- `real_daemon_store_ahead`: `a_module_on_a_store_ahead_of_it_refuses_on_health_and_on_transform` failed, then failed again in its own exact-name invocation. Its test-owned Cargo build of `subc-core --bins` cannot run because the required sibling subconscious working directory is absent (`No such file or directory` at line 438). This is a fifth unavailable sibling-repository fixture, not a cleared gate.

Receipts for these runs (`bash-94b3e2bf674b1db8` and `bash-7c5080273230a263`) are retained with the other verification logs.

## CI follow-up: formatting and Linux executable-busy race

The task giver reported failures on reconciled tip `8c9cd5e9` in CI run `38317900632`: Rust formatting and an `ExecutableFileBusy` spawn in Broca conformance. This follow-up does not revisit the migration/cache reconciliation or its remaining release findings.

- Applied the requested `cargo fmt --all`. Outside the launcher changes, the only formatter adjustment is a line wrap in `transform.rs`.
- The shared `tests/support/executable.rs` now has a process-local registry of per-content/name/signing-identifier `OnceLock` cells. Concurrent callers await the same staging result. Rebuilt source bytes at the same path use a different cell; no source-path-only freshness shortcut was introduced.
- Explicitly close the temporary executable's write descriptor before signing and publication. A returned staging path therefore cannot race its initializer's open writer.
- All clients of the shared Rust staging helper use the shared spawn retry: Broca conformance, real daemon and store-ahead rigs, fleet logging's output launch, and route-target process tests. Only `ExecutableFileBusy` is retried, up to 20 attempts with 50 ms between attempts (19 waits at most); exhaustion returns the error to the caller's existing loud failure path. Other errors fail immediately.
- Added eight-thread simultaneous staging/spawning coverage: 64 successful launches must observe one path and one published inode. A separate Linux test first proves an open writer really prevents exec, then verifies successful launch after its release. Deterministic tests assert 20-attempt exhaustion, exact 50 ms backoff, successful transient retry, and no retry for unrelated errors. The original content/permission test also covers rebuilding the same source path.

Verification ran on `linux,4c`, with a throwaway HOME/XDG/TMPDIR under the task root:

| Follow-up check | Result |
| --- | --- |
| `cargo fmt --all --check` | Passed; rustfmt 1.10.0-stable. |
| `cargo test -p mc-module --test executable_staging` | 6 passed, including 64 concurrent real launches and the real open-writer control. |
| `cargo test -p mc-module --test fleet_logging` | 1 passed. |
| `cargo test -p mc-module --lib private_permissions_source_test` | 4 passed, including the existing staged-executable source guard. |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed; clippy 0.1.99, rustc/cargo 1.99.0. |
| `cargo test -p mc-module --test broca_conformance --features drive-fault` | Three consecutive runs passed: 14/14, 14/14, 14/14. Each includes the originally reported failing compaction test and the fault/retry test. |
| Scoped Rust diagnostics | Authoritative reports for four files: 0 errors/warnings. |
| Sidekick comment review | All 8 changed Rust files reviewed; 3 changed comment blocks examined, none flagged. |

The drive-fault build emitted the existing `Atomic::fetch_update` deprecation warning in `lib.rs`; it is unrelated to this fix and was not changed. No live stores, configuration or sessions were accessed, and no Rust build or full suite ran on the Mac. Raw follow-up stdout/stderr are retained in the task verification directory as `ci-followup.stdout.log` and `ci-followup.stderr.log`.
