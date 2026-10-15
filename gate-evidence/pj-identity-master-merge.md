# pj-identity merge of origin/master

Incoming revision: `6e2689b6360529453ea17cf7b75ca4216afd60ec`.
Identity base: `4fd9a03e6cc417befef150dd8ab98631d3054e97`.
The prepared task HEAD was `323f75376ddf06307bd30a385030e69e68759253`.
Two earlier interrupted worker attempts each produced an automatic commit
intended to save unfinished edits. Both commits are empty:
`git diff 4fd9a03e..323f7537` is empty. They were retained, not rewritten.

## Conflict resolutions

- `packages/plugin/package.json`: union the worker entry points in `build` and
  `build:v2`. Explicitly clean every worker entry in both output directories,
  including `project-pin-worker`, `raw-ordinal-warmup-worker`, and
  `compaction-marker-candidates-worker`.
- `packages/pi-plugin/package.json`: retain the same worker union in `build`
  and its cleanup list. Pi has no `build:v2` script; none was invented.
- `latch-permanence-guard.test.ts`: keep both process-exit PUBLICATION slots,
  which record installation of cleanup handlers for the pin writer and marker
  candidate workers. Both handlers must remain classified because neither
  records a permanent failure or absence verdict.
  Master's expanded slot-name scanner also discovers the branch's
  `workerUnavailableReported`; classify it as DIAGNOSTIC because it suppresses
  only duplicate log messages, not fallback writes. The guard initially failed
  on that previously unclassified slot. No production latch behavior changed.
- `project-identity.ts`: preserve home/directory eligibility and exact-directory
  `pj-` pin precedence, then honor master's `cache: false` for the Git-identity
  cache lookup and early return before publishing a Git result. All other
  fallback ordering remains the identity branch's. Clarify the read-only-probe
  documentation to distinguish authoritative pins from the Git cache. Extend
  the existing pin-precedence test with a `cache: false` assertion; its zero-Git
  call and unchanged-sidecar assertions cover that call too.
- `rust-mode-transform.ts`: retain type-only identity imports and master's
  `prepareCompactionMarkerCandidates` import. Keep preparation for either a
  materialized boundary or a pending marker before the existing writer wait.

These are additive combinations, not choices to discard either side's behavior.
`ARCHITECTURE.md` and `STRUCTURE.md` were not changed.

## Linux verification

All builds, tests, typechecks, and lint ran on the Linux runner. Tools:

- Bun `1.4.2 (744846f84)`; TypeScript `5.9.3`; Biome `2.5.1`.
- Cargo `1.99.0 (5f94df478 2026-08-27)`.
- rustfmt `1.10.0-stable (b940084d7e 2026-09-28)`.
- clippy `0.1.99 (b940084d7e 2026-09-28)`.
- Runner SQLite shell `3.46.1`, source id ending `69aalt1`.

Package runs explicitly unset `OPENCODE_DB` and use the repository's test
preloads. Rust runs use a throwaway HOME, XDG directories, TMPDIR, storage, and
host database; no opt-in private/live-store fixture variables were set.
No live stores were used.

### Distributions and static checks

- `bun install --frozen-lockfile`: checked 1,013 installs across 1,254 packages,
  no dependency or lockfile changes.
- `bun run build:dists`: passed plugin, plugin v2, and Pi builds, declaration
  generation, and both distribution imports (`dists LOAD OK`). The TUI generator
  checked nine files and changed none. Bundles contained 734, 776, and 1,046
  modules respectively, plus the three 22-module browser-transformer bundles.
- Immediately after building, a Bun script scanned every `.js` directly in
  each output directory for every `LATEST_SUPPORTED_VERSION = <number>`
  declaration. It required at least one match per directory and every match to
  equal 95. Results:
  - plugin: `index-vv4cqdm2.js`, 95;
  - plugin v2: `server-6j2f8ptv.js`, 95;
  - Pi: `index-exg8r4ve.js`, 95.
  The same script required all seven worker entry files in all three outputs:
  embedding, embedding-process, project-pin, migration, auto-search,
  raw-ordinal-warmup, and compaction-marker-candidates. All 24 artifact checks
  passed. This checks the emitted values, not a count of chunks or declarations.
  An earlier artifact-only job found no `dist` directory because remote jobs do
  not retain those outputs; building and inspecting in one job resolved that
  invocation issue.
- `bun run --cwd packages/{plugin,pi-plugin,cli} typecheck`, expanded to three
  commands: all passed. Plugin typecheck was repeated after its final test and
  documentation edits. TypeScript emits no output on success.
- `bun run --cwd packages/{plugin,pi-plugin,cli} lint`, expanded to three
  commands: all passed without fixes. Biome checked 1,447 / 351 / 146 files,
  reporting 11 / 67 / 1 non-fatal warnings respectively (and informational
  diagnostics). A formatting error in the added long latch-classification key
  was corrected before the final plugin lint pass.
- `cargo fmt --all --check`: passed, no output on success.
- `cargo clippy --workspace --all-targets -j 4 -- -D warnings`: passed all
  workspace targets, with the final `Finished dev profile` line.

### Package suites and focused reruns

- `bun run --cwd packages/plugin test`: 8,338 passed, 46 skipped, one failure
  across 821 files. The only failure was the missing DIAGNOSTIC classification
  described above. After correction, the focused guard/identity/differential
  run passed all 70 tests across four files, including all 11 campaign
  differential checks against `cc654a68fd0441d245712be76eb23087e70b7ef0`
  (v0.49.2). That command was:

  ```sh
  BUN_JSC_useOMGJIT=0 bun test --timeout 300000 \
    packages/plugin/src/config/latch-permanence-guard.test.ts \
    packages/plugin/src/features/magic-context/memory/project-identity.test.ts \
    packages/plugin/src/features/magic-context/memory/project-identity-cache.test.ts \
    packages/plugin/src/features/magic-context/memory/standalone-differential.test.ts
  ```

  After the additional read-only pin assertion, the first three files plus
  `schema-version-fence.test.ts` were rerun with a 30-second timeout: 62 passed,
  zero failed across four files, with 265 assertions.
  The existing `test.failing` lookup-recovery case remains an expected-failure
  check; its policy was not changed or claimed to be repaired.
  A final full plugin run after the regression assertion reported 8,330 passed,
  46 skipped and nine failures, all in `auto-search-bundle-review.test.ts`:
  those tests require distribution workers, which were absent in the new
  remote job. After `bun run build:dists` in the same job, the exact file rerun
  passed all nine cases (two optional native-host cases skipped), with 48
  assertions. Thus all 8,339 non-skipped tests passed across the final full run
  and its rebuilt-fixture rerun, not in one clean full invocation. No product
  or test source was changed for the missing-fixture failures.
- `bun run --cwd packages/pi-plugin test`: 2,337 passed, 40 skipped, zero
  failures across 240 files.
- `bun run --cwd packages/cli test`: first stopped on a 5-second hook timeout
  in `offline preflight upgrades v92 and seeds history revisions before
  invoking the engine`. With the supported timeout argument,
  `bun run --cwd packages/cli test --timeout 30000`, the regular subprocess
  passed all 741 tests (two skipped) across 61 files. The next isolated file
  reported nine passes and the baseline SQLite salvage failure below. The
  remaining three isolated CLI files were run separately with `bun test
  --timeout 30000`: `omp-helpers` eight passes, `opencode-helpers` ten passes,
  and `pi-helpers` eight passes. No CLI code or tests were changed to hide the
  failure.

### Remaining baseline failure and unavailable prerequisites

The CLI suite is **not completely green** on this runner:

```text
(fail) doctor repair-db > backs up and salvages readable rows from a genuinely corrupted SQLite page
SQLite salvage was unsuccessful: replaying .recover output failed:
object name reserved for internal use: sqlite_sequence
table sqlite_master may not be modified
object name reserved for internal use: sqlite_stat1
```

The implementation and test are unchanged from incoming master. To distinguish
this from an identity-merge regression, the exact master tree was exported
locally with `git archive 6e2689b6`, transferred as a temporary archive, extracted
on Linux, and run with the shared installed dependencies and its own source
and tsconfig aliases. Its exact salvage-only test failed identically: zero
passed, one failed, nine filtered out. The temporary archive was removed.
The first broad baseline attempt additionally lacked a pre-created test temp
parent; the exact rerun created that parent and had only the salvage failure.
An initial attempt to archive master on Linux could not see the incoming Git
object before the merge commit, so it did not run tests.

Two daemon integration targets, `real_daemon` and `real_daemon_store_ahead`,
were not run: the Linux job has no required sibling `../subconscious` checkout.
CI provisions the lock-pinned source for these tests. They should run on the
check branch before promotion; no production source was patched or sibling
checkout manufactured to bypass that prerequisite.

### mc-module results

Commands used `--offline --locked`, `-p mc-module`, `-j 4`, and
`CARGO_BUILD_JOBS=4`. CARGO_HOME and RUSTUP_HOME were retained while HOME and XDG
paths were redirected. Git archives in the standalone differential needed this
invocation-only setting inside the remote job:

```sh
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$PWD"
```

- `cargo test --offline --locked -p mc-module --lib --bins -j 4 --no-fail-fast`:
  1,872 library tests passed, two failed, 29 ignored; the binaries had five
  passes and one empty target. Both failures were rerun exactly and passed:
  - `host_store::tests::the_context_db_path_follows_the_hosts_own_resolution_order`:
    the initial isolation storage basename was `storage`, but this test asserts
    the normal `magic-context` basename. Correcting the invocation to use
    `$isolation/data/cortexkit/magic-context` passed the one test.
  - `tests::binding_projects::on_bind_latency_distribution_isolated`: the
    near-deadline reply failed to publish a pin during the loaded full run.
    An isolated exact rerun passed, including its child process and 50 samples
    in each mode. Observed p99: immediate 7.217 ms, near-deadline 498.337 ms,
    never-responding 502.619 ms. No timing assertions or production code changed.
  Thus all 1,874 non-ignored library tests passed across the full and exact
  reruns, not in a single clean full run.
- `cargo test --offline --locked -p mc-module --doc -j 4`: completed, zero
  doctests were present.
- `cargo test --offline --locked -p mc-module --test <target> -j 4 --no-fail-fast`
  passed for each of these targets:

  | Target | Reported passes |
  | --- | ---: |
  | boundary_counter_durability | 1 |
  | cold_flip_adversarial | 5 |
  | executable_staging | 2 |
  | fleet_logging | 1 |
  | launch_nonce_source_scan | 2 |
  | protection_window_golden | 1 |
  | real_store_copy_migration | 1 |
  | scope_stamp_decode | 2 |
  | serde_json_feature_fidelity | 1 |
  | standalone_differential | 1 |
  | tag_cache_allocation | 1 |
  | temporal_mode_switch | 1 |

  These are 19 reported passes, of which 18 executed checks:
  `real_store_copy_migration` returns immediately when `MC_REAL_STORE_COPY` is
  unset, so this is not a live-store migration proof. The standalone case
  `standalone_identity_and_prefix_bytes_match_the_pre_campaign_base` executed
  and passed against the pinned v0.49.2 source. The 29 ignored library cases
  include private-fixture tests and subprocess helpers; the latency helper was
  exercised through its parent, not separately enabled with all ignored tests.

## Latch-guard non-vacuity control

The final implementation was staged and `git diff --stat` was empty. The
`workerUnavailableReported` classification key was temporarily replaced with
`NON-VACUITY BREAK`. This left the production pin writer's
`workerUnavailableReported` slot unclassified, so the guard had to reject the
inventory despite the replacement entry still being present.

- During mutation: `packages/plugin/src/config/latch-permanence-guard.test.ts`,
  one file changed, one insertion and one deletion.
- Command: `BUN_JSC_useOMGJIT=0 bun test
  packages/plugin/src/config/latch-permanence-guard.test.ts` on Linux.
- Only failed test: `latch permanence classification guard > classifies every
  production one-shot verdict-shaped slot`; zero passed, one failed.
- Failure explicitly named
  `packages/plugin/src/features/magic-context/memory/project-pin-writer.ts:workerUnavailableReported`.
- Restored with `git checkout --
  packages/plugin/src/config/latch-permanence-guard.test.ts` and `touch`;
  `git diff --stat` was empty again. The restored guard passed in both focused
  runs. The later formatting-only adjustment retained the classification.

## Repository fences

- All four brief-named plugin paths exist in this checkout; no compatibility
  shims were introduced.
- `git ls-files -ci --exclude-standard -- .cortexkit`: no output.
- `git diff --cached --name-only -- ARCHITECTURE.md STRUCTURE.md`: no output.
- `git diff --check`: passed before staging and commit.
