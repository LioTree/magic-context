# Provider-only ck-mc release gate

## Candidate and boundary

Base: `0f8f341c8c4b27df6bf9678e022250ef3a9b8ac4` (master's schema-95 storage code). This is a provider-only extraction, not the migration-train executable. The delivered task branch also has the local `train/provider-release` ref. No release artifact was built or placed; no OpenCode/Pi distribution was rebuilt. The conformance executable and comparison executable are debug builds.

The candidate serves runner-bound `compaction.setup`, `compaction.step`, `transform.declare`, and `transform.hook`, with durable answer/version/tag/catalog records at private store **65**. Context remains **95**. The existing configurable provider-runner target remains independent of the host producer target. Commons provider/runner roles are pinned to `90d5c5567ad7ec8dcc8d26252b1a759fdd49bb75` after the amendment update, with the approved stable-tool exception below. Runtime subc protocol remains `0.29.1`, client `0.26.1`, and the in-process daemon is master's `0.31.2`. This verifies the published v1 role wire contract with a scripted Broca runner, not Broca's own implementation or a production canary.

## Pin and prune: file/hunk dependency list

`git merge-base --is-ancestor <ref> 0f8f341c` returned 0 for S1 `50c6faa6cf`, its implementation `66aeb37afa`, and S2 `c5230e277b`. It returned 1 for S3 `727ee88592`, S4 `391290b223`, private v64 `90488bd9f2`, and retry fix `dff86491bf`.

| Source | Retained files/hunks | Dependencies and exclusions |
| --- | --- | --- |
| v64 `90488bd9f2` | Exact six-table SQL (including `cortexkit_fence`) in `store_064_move.sql`; opener's temporary writer guards, draining exceptions, root-pruning and pending-write fence checks | `move_inventory` supplies session owners/columns. No move coordinator, snapshot codec, export/import methods, move activation, or context served-capture tables. |
| S3 `f46b3546a5` | Provider role dependencies; `session_resolver`'s runner callback client and `RUNNER_BIND_HARNESS`; shared `broca-session-read-messages.json` | Existing SDK, configured route target, store handle and compaction engine seam. No new host adapter. |
| S3 `1fcc921a46` | `providers/{mod,records,codec,compaction,step_transform,tests}.rs`; `provider_records.rs`; exact migration `store_065_provider_records.sql` and registration | Opaque v65 records, fenced store transactions, existing engine tags, and master's context domain. No normalized v66 provider rows. |
| S3 `2fc38ae02d` | Catalog startup coordination, durable catalog admission/failure propagation, runner-bound tool join, `tests/catalog_startup.rs`, test route helper and catalog test visibility | Catalog discovery remains storage-independent while later stateful calls expose failed persistence. Owner classification covers the provider tables' `session` column. Context fence test stays 95, not the source branch's 96. |
| S4 `391290b223`, fixture origin `9e0e0b0aff` | Real executable/router conformance and committed shared-byte fixtures, crash markers, accepted/rejected views, paging/wait, protected drop acknowledgment | Uses v65 record loading through its public exported key, not normalized-record internals. Historical S4 REPORT.md is retained as history, not candidate gate evidence. |
| S4 `ca4c934395` | Runner internal TTL scheduling disabled; adapter allocations use the engine's exact `prefix_bust_permitted` | The runner owns cache-expiry signals; its absent last-response timestamp cannot authorize epoch-based idle execution. |
| S4 `0b81ddc155` | Exact permission and conformance controls | Its host-only transport replay extension requires the excluded host compaction pipeline and has no corresponding lane on master. It was not transplanted; existing master host serializer/transport regressions and executable comparisons are retained instead. |
| `dff86491bf` | Candidate-based retry allocation and `lost_broca_view_cannot_hide_independent_model_rebuild` regression in `transform.rs` | Small adapter hunk only. Master transform, signed-thinking handling and other host behavior are not replaced wholesale. |

The store inventory's **context** half stays at 95, including its existing columns and ownership classifications. Only the v64/v65 private-store objects/owner metadata change. The v63 regression rewind now removes later objects/temporary triggers and later ledger stamps; the immutable migration-63 SQL assertion is retained. An older migration test must not leave a v65 stamp and accidentally skip the migration it tests.

Explicitly absent: agent-move activation, context v96 served-capture markers, host-runner v97, rescore v98, memory lifecycle v99, held-release v100, normalized private-store v66 rows, and v68 policy summaries. Master's context schema fixture, fingerprint expectations, memory writers, host codecs and signed-thinking implementation are unchanged. Protection acknowledgment uses master's existing protected-token window; it does not introduce held-release schema.

## Isolated compatibility gate

All commands and fixtures use throwaway roots under `$TMPDIR/magic-context/<task>/`. Every executable has explicit `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR`; the harness also redirects HOME. None of the live stores/configs named in the brief were opened, read, written or migrated. No live daemon/module was touched.

`Rig::start` creates context.db by executing master's actual TypeScript `initializeDatabase` and `runMigrations`, not by importing the Rust schema fixture. It seeds a populated v63 private store using the original migration prefix, cache row/version, tool tag/source bytes, pending drop and paired single-store stamp. Each rig captures the entire context migration ledger (including descriptions/timestamps) and `sqlite_master` before candidate startup. It compares both after startup, restart and test completion: maximum upstream version 95, unchanged ledger, unchanged objects. Thus extra v96–v100 objects cannot hide behind an unchanged numeric ceiling. Existing fingerprint-enforcing domain connections are exercised by memory and historian writes.

Linux `lsof -p <ck-mc pid> -Fn` observes context.db/store.db and WAL/SHM handles and requires all database paths below that rig's root. Successful runs reported **10 isolated database handles per ck-mc startup**. The Mac no-Broca host-runner regression independently checks both throwaway daemon/module processes, with canonicalized roots for macOS `/var` symlinks.

Coverage:

- All four methods for head, worker and reader; initial view, below/crossed threshold, replacement, applied/rejected/stale answers and byte-stable served prompts.
- Runner setup rejects OpenCode observation/serializer selection before callbacks. Runner tool joining is project/session-bound, not incorrectly bound to the caller's `broca` body label.
- Paging, bounded waiting and ready callback; real kill after durable answer recording; resumed cursors, skipped allocated versions and catalog persistence. Hook tag allocation/live observation survives restart; signed/non-addressable content is preserved.
- Pending historian history stays deferred below threshold; protected drops remain queued until displaced by newer groups; current-output retries cannot resurrect independently rebuilt history or consumed drops.
- Actual `ctx_memory` tool publication, historian summary/fact publication, a fault between durable private-store publication and context writing, startup replay exactly once, revert re-cut, and reconnect boundary/generation recovery. Existing unit regressions additionally cover reconcile with present/absent materialized boundaries and source rewrites.
- Missing/mismatched single-store stamps, fresh install, migration/refusal cases and cache crash recovery remain covered by the module/store regression suites.
- A debug ck-mc built from the pinned base refuses candidate store65 by `store_ahead_of_binary`; a logical snapshot of **all** private-store rows, schema objects and ledger is unchanged. Whole-file bytes are not the right invariant for that refusal: SQLite may checkpoint an existing WAL when the final reader closes without changing logical state.
- Raw `tool.catalog` response bytes (including declared tool schemas/descriptions) match master's executable for all three presets. OpenCode and Claude Code actual `ck_messages` serialized bytes match master on the shared signed-reasoning/tool/media golden corpus, including candidate replay. Metrics/timing are not confused with served payload bytes. Shared Broca joint fixture bytes match the real encoder and replay through executable routes.

## Verification evidence

Toolchain: Cargo `1.99.0 (5f94df478 2026-08-27)`, rustc `1.99.0 (b940084d7 2026-09-28)`, rustfmt `1.10.0-stable`, Clippy `0.1.99`, Bun `1.4.2` on Linux. All Rust Linux gates use `runon: linux,8c`; commands needing local debug executables use `nice -n 10` on Mac. `cargo fetch` installed the new pinned provider/runner-role dependency records, their test-only protocol dependency and mc-module dependency edges; existing runtime workspace pins are unchanged. No JS manifest or lockfile changed.

- `cargo check --locked -p mc-store -p mc-module`: passed (2 requested crates and their dependency graphs).
- `cargo test --locked -p mc-store -p mc-core --lib`: passed, store **248**, core **22**; store **3** private-clone/performance cases ignored.
- `cargo test --locked -p mc-module --features drive-fault`: module library **1726 passed**, **22 ignored**; boundary-counter **1**, cold-flip **5**, fleet logging **1**, launch-nonce scan **2**, protection golden **1**, caveman differ **5**, and ordinary Broca conformance **15** all passed. The full command then encountered the expected missing-sibling source prerequisite in Linux `real_daemon` (four failures before any daemon was launched); those tests were rerun locally as required, not waived.
- Remaining Linux integration targets `scope_stamp_decode`, `serde_json_feature_fidelity`, `tag_cache_allocation`, and `temporal_mode_switch`: **2 + 1 + 1 + 1 passed**. `real_store_copy_migration` returned without migrating because `MC_REAL_STORE_COPY` was unset: **not claimed as a real-store-copy gate**. No private production snapshot was provided or read.
- Final `cargo test --locked -p mc-module --test broca_conformance --features drive-fault -- --include-ignored --test-threads=2 --nocapture`, with `MC_PROVIDER_BASELINE_CK_MC` pointing to the separate master debug target: **18 passed, 0 failed, 0 ignored**, 22.52 s after the amendment update. The earlier new publication assertion was corrected to the existing durable-publication contract; final complete rerun includes its recovery test.
- Mac `nice -n 10 cargo test --locked -j 4 -p mc-module --test real_daemon -- --test-threads=1 --nocapture`: **5 passed, 2 ignored** (85.28 s); the ignored cases require private sync/planning captures. `MC_TEST_SUBCONSCIOUS_ROOT` points to a task-owned clone of Cargo.lock's exact revision, not the parent/sibling checkout. The test still exports/validates only that committed revision. Its ck-mc startups reported **10–12 isolated database handles** through lsof.
- Mac niced no-Broca host-runner test: **1 passed**, with lsof proof; niced `real_daemon_store_ahead`: **1 passed**, using the same prebuilt lock-pinned debug daemon/CLI.
- Final `cargo fmt --check`: passed.
- Final `cargo clippy --locked --workspace --all-targets -- -D warnings`: passed, all four workspace crates and test/integration targets (default feature set). At the initial delivery, existing fault-only `AtomicUsize::fetch_update` deprecation warnings on rustc1.99 were not rewritten outside scope; the explicit follow-up below replaces those calls and passes fault-enabled strict clippy.
- Exact v64 SQL comparison against the exported `90488bd9f2` constant: **1 passed**. Migration v65 SQL is the unmodified blob from S3.
- AFT inspection was partial: its local diagnostic build did not complete and Linux-only conformance modules are unlinked on the Mac analyzer. The authoritative Linux cargo check, test compilation and all-targets clippy gates passed; partial IDE coverage is not presented as clean diagnostics.

Initial extraction failures were fixed rather than waived: omitted shared runner fixture, catalog helper visibility, v63 rewind hard-coded to the previous head, source-census placement of the test-only raw fixture builder, and missing runner host-setting rejection. A baseline debug target must be separate from the candidate target (Cargo's inherited target-dir can otherwise overwrite the executable being compared). The pending-publication test asserts success plus a durable pending replay, matching the existing writer's contract, rather than assuming the context-side fault must make publication fail.

## Non-vacuity controls and final runs

Each control was staged first, with an empty working diff; the mutation produced the non-empty diff shown below. After the named check, `git checkout -- <path> && touch <path>` restored the staged live source and `git diff --stat` was empty. No `NON-VACUITY BREAK` remains.

| Control | Exact red test | Other outcomes | Working diff during mutation / after restore |
| --- | --- | --- | --- |
| Neutralize all temporary writer guards | `move_fences::tests::durable_fences_cover_provider_catalog_and_record_writes_after_reopen` | Store target: **247 passed, only that 1 failed, 3 ignored**. Provider migration/atomic-record/catalog tests remained green. | `move_fences.rs`: 1 file, 2 insertions, 1 deletion / empty |
| Disable the runner host-setting fence | `compaction::runner_setup_refuses_host_only_settings_but_accepts_plain_setup` | Conformance: **14 passed, only that 1 failed, 3 baseline-dependent cases ignored**. Runner join, history deferral, joint fixture and signed-block hooks remained green. | `providers/compaction.rs`: 1 file, 3 insertions, 2 deletions / empty |
| Add `lkg_served_markers` to the actual context database after its schema snapshot, leaving the ledger at95 | `compatibility::schema95_and_populated63_survive_provider_restart` | Exact test: **0 passed, 1 failed**, 17 filtered. Failure: `context schema objects changed`; the module had booted and lsof observed its real database handles. This proves an unchanged numeric fence cannot hide an excluded object. | `broca_conformance/harness.rs`: 1 file, 2 insertions / empty |

Restored final gates: store **248/248**, core **22/22**, module library **1726**, executable conformance **18/18**, remaining module integration cases and local daemon cases as listed above. Specific restart controls include `catalog_and_hook_high_water_survive_a_fresh_handler`, `tags_become_live_on_second_page_and_drops_survive_restart`, and `wait_ready_names_request_only_after_durable_work_and_versions_resume`. The current-output regression `lost_broca_view_cannot_hide_independent_model_rebuild` passed in the module library run.

Comment review examined the new provider paths, compatibility harness, private fences and real-daemon fixture changes. Flagged jargon was clarified (version reservation, TTL ownership, catalog persistence, pending transcript subjects and unavailable tags); no behavior was changed by those rewrites. Historical upstream reports are not counted as candidate proof.

## Commons amendment pin and approved exception

The late SUBC amendment update was applied to the new roles and checked again. The task owner explicitly chose: keep master's tool-provider and tool-provider-conformance **0.5.0**; pin only the new provider/runner roles to commons **90d5c556**. Tool-provider **0.7.0**, its bind-mode contract and protocol0.31 belong to the next coordinated daemon cut, not this binary-only release. An exploratory all-role pin exposed the expected protocol0.29/0.31 ErrorBody mismatch in the existing tool conformance harness; it was reverted, not bridged with a shim or a runtime SDK upgrade.

Exact final resolved crates:

| Crate | Version | Source |
| --- | --- | --- |
| `cortexkit-role-compaction-provider` | **0.1.2** | Git `90d5c5567ad7ec8dcc8d26252b1a759fdd49bb75` |
| `cortexkit-role-step-transform-provider` | **0.1.2** | Same Git revision |
| `cortexkit-role-llm-runner` | **0.2.0** | Same Git revision, transitive runtime dependency |
| `cortexkit-role-llm-runner-conformance` | **0.2.0** | Same Git revision, dev-only |
| `cortexkit-role-harness` | **0.1.0** | Same Git revision for llm conformance; registry0.1.0 remains separately for stable tool conformance |
| `cortexkit-role-tool-provider` | **0.5.0** | Registry, approved master exception |
| `cortexkit-role-tool-provider-conformance` | **0.5.0** | Registry, approved master exception |

`cargo tree --locked -p mc-module --edges normal` was inspected: the **only runtime subc-protocol is0.29.1**, used consistently by tool-provider, module SDK, control and transport. Compaction/step/llm-runner role runtime dependencies contain serde/JSON types, not subc protocol types. Protocol **0.30.2** appears only through the dev-only llm conformance package. Protocol **0.31** is absent from the final lockfile. No new protocol types enter ck-mc's sent/received SDK frames, and no bind-mode support was activated.

The amended `RunError` requires `class`, `message` and `provider_code`, with optional diagnostic `provider_detail_code` and measured retry/reset/account/provider details. The new provider lane neither constructs nor deserializes that runner-owned typed `RunResult` error: its callbacks are `session.head`, `session.read` and `compaction.ready`, with generic JSON/transport-error handling. Existing Setup refusal fields are unchanged.

The existing historian and module-routed classify paths were inspected too: both share `HistorianProducer`, sending hand-built `session.send` JSON and polling `run.status`. Stream-error handling selects `class`/`message` and existing retry/reset metadata from generic JSON; it does not branch on `provider_code` or `provider_detail_code`. Generic subc error frames still use their separate `code`/`message` fields. Added typed diagnostic fields are tolerated, not fabricated, remapped or newly used for retry decisions. No parser/sender change is needed for this pin; diagnostic code propagation and the coordinated runner/SDK upgrade are not silently added to this release. See `docs/reports/llm-runner-mc-usage.md` and `historian_producer.rs`'s existing error/status parser tests, which passed in the amended **1726-test** library run.

The updated compaction role also adds optional `StepAnswer::CompactionMessage.coverage`. The construction now explicitly sets **None**. The role skips it on serialization and says absence leaves existing working-view handling unchanged; this release does not invent a covered-message/host trim marker from the half-open replacement range. The shared fixture bytes remain unchanged.

Amendment reruns on Linux8c: `cargo check --locked -p mc-store -p mc-module --all-targets` passed; module library **1726 passed, 22 ignored**; complete executable conformance including shared fixture encoding/replay and master catalog/legacy-byte comparisons **18/18 passed**; fmt and strict workspace all-targets clippy passed. One remote startup attempt was refused before process creation; its same remote retry ran successfully, with no local fallback. The late optional-coverage comment review had no flags. Earlier local sibling-daemon gates exercise unchanged SDK/protocol/host code and are recorded separately above.

## Placement and rollback limits

This is executable/source compatibility evidence on synthetic isolated data produced by master, not a production snapshot, a live Broca canary, a release-size claim or a placement authorization. Only ck-mc needs deployment for this provider surface; no context migration or host dist rebuild is required. A later v66–v68 migration train can apply its unchanged private-store migrations over these identical v64/v65 layouts. Rollback needs the paired pre-upgrade private-store/context backup and stopped writers: an old max63 executable cannot open a store already advanced to65. The live-store backup/drain/swap/canary work remains outside this task.

## Closure of independent review 78cfca2e

The independent report was cherry-picked from `78cfca2e` onto this task branch and is retained unchanged in `provider-release-review.md`: its placement block applies to candidate da10df31. The follow-up changes below close the specified findings without changing the schema95/private65 or SDK/role-pin boundary.

### Runner admission

`handle_provider_value` now checks the verified bind harness against `RUNNER_BIND_HARNESS` before declaration decoding, catalog lookup or state allocation. A body harness is only a conversation coordinate; it cannot grant admission. The release has no host provider lane. `route_unbound` matches the migration branch's refusal shape, with a runner-only reason rather than its host-or-runner allowance.

Permanent `compatibility::review_runner_admission_requires_runner_bind` exercises every new method under OpenCode, OpenCode2, Claude Code and Broca binds with bodies claiming either `runner` or `broca`, plus malformed bodies. All must refuse before decoding; the test verifies no callbacks or provider rows were created. Positive runner calls exercise all four methods and preserve distinct body-harness records/compaction IDs.

### Executable death matrix

`crash_cuts.rs` adds independent process-death/restart cases for SetupRecorded, MessagesIngested, WaitAnswered, WaitWorkDurable and HookStateRecorded. Each waits for the real executable marker, snapshots actual private rows, kills the process and restarts the same isolated root. Assertions cover Setup ID/input retention, transcript cursor equality, version/tag high-water marks, replay/application without duplicate views, and stale request/tag fencing. Wait cases page from a persisted prefix; hook recovery observes only the delivered replacement tag and retains the burned undelivered tag.

Wait markers record a durable answer/work boundary, not a transport-delivery acknowledgment. Parking the background task can stop the executable's executor before a Wait frame flushes. The tests therefore accept either an exact committed Wait reply or a killed/unknown outcome, and require the same persisted state and recovery in both cases. This is not a waived timeout. Initial tiny-message workloads correctly produced no replacement because no real reduction was eligible; the final cases publish actual schema95 history to create concrete rebuild work before testing reserved view recovery.

### Fault-enabled lint

All six fault-helper atomic calls now use `try_update` with identical orderings and decrement closures. No fault budget, production path or default feature was changed. Fault-enabled strict workspace clippy passed on Cargo/rustc/Clippy1.99.

Positive narrow gates before mutation: new crash cases **5/5**, admission **1/1**, module library **1726 passed/22 ignored**, and `cargo clippy --locked --workspace --all-targets --features drive-fault -- -D warnings` passed. Mutations and restored complete/local gates are recorded below.

### Follow-up mutation evidence

For every control, the specific source was staged in its live state and the full working diff was empty. The labelled mutation produced the nonempty diff below; the exact conformance test reached the selected marker (or actual admission reply) and failed on the intended assertion. Each run had **0 passed, 1 failed, 23 filtered**: no other test failed, but filtered tests are not counted as green. `git checkout -- <path> && touch <path>` then restored the staged source and a subsequent full `git diff --stat` was empty. The restored complete **24/24** run passed afterward. No `NON-VACUITY BREAK` remains in product sources.

| Control | Exact red test | Captured behavioral failure | Nonempty working diff / after restore |
| --- | --- | --- | --- |
| Disable runner-bind admission | `compatibility::review_runner_admission_requires_runner_bind` | `transform.declare admitted bind opencode from body runner` with real subscriptions returned | `providers/mod.rs`: +2/-1 / empty |
| Clear Setup before its saved cut | `crash_cuts::setup_recorded_survives_process_death` | `SetupRecorded lost the Setup inputs` | `providers/compaction.rs`: +2/-0 / empty |
| Remove ingested lineage before its saved cut | `crash_cuts::messages_ingested_survive_process_death` | `persisted lineage cursor` absent | `providers/compaction.rs`: +2/-0 / empty |
| Clear active wait-request ID before saving Wait | `crash_cuts::wait_answered_survives_process_death` | `WaitAnswered lost the active request fence`; Null instead of `wait-old` | `providers/compaction.rs`: +2/-1 / empty |
| Skip completed wait-work commit before marker | `crash_cuts::wait_work_durable_survives_process_death` | persisted `wait_request` remained active rather than cleared by completed work | `providers/compaction.rs`: +1/-1 / empty |
| Decrement reserved hook-tag high-water before saving | `crash_cuts::hook_state_recorded_survives_process_death` | `HookStateRecorded lost the reserved tag number`; 0 instead of 1 | `providers/step_transform.rs`: +2/-0 / empty |
| Skip final step-answer commit before existing marker | `compaction::kill_mid_request_retry_skips_reserved_version_preserves_cursor_and_fences_stale` | stored `ready` instead of `compaction_message` | `providers/compaction.rs`: +1/-1 / empty |

This closes the named admission and six-cut process-death matrix, not a universal mutation proof for every possible conformance clause or production traffic shape. The historical independent review remains an accurate account of its da10df31 candidate.

### Restored follow-up gates

All Linux lines ran foreground on **Linux8c**, one heavy job at a time, with Cargo/rustc1.99.0, rustfmt1.10.0-stable and Clippy0.1.99; throwaway XDG/config/state/runtime/store roots and lsof checks remain in force.

- `cargo check --locked -p mc-store -p mc-module --all-targets`: passed.
- `cargo test --locked -p mc-store -p mc-core --lib`: **248 store +22 core passed**, three private-clone/performance cases ignored.
- `cargo test --locked -p mc-module --lib --features drive-fault`: **1726 passed, 22 ignored**; includes the renamed atomic fault-budget operations.
- Nine retained module integration targets (boundary counter, cold flip, fleet logging, nonce scan, protection golden, scope stamps, serde fidelity, tag allocation, temporal switch): **15 passed**.
- Complete `cargo test --locked -p mc-module --test broca_conformance --features drive-fault -- --include-ignored --test-threads=2 --nocapture`: **24 passed, 0 failed, 0 ignored**, 16.24 s. The separate pinned-master debug baseline was rebuilt in a distinct target directory. Shared fixture bytes, declared/catalog tools, legacy host CK bytes, context95 compatibility and all newly permanent cases passed.
- `cargo fmt --check`: passed.
- `cargo clippy --locked --workspace --all-targets -- -D warnings`: passed.
- `cargo clippy --locked --workspace --all-targets --features drive-fault -- -D warnings`: passed, with no deprecated-atomic warnings waived.

Comment review clarified bind identity versus body data and the Wait transport race; those edits changed no behavior. Local daemon gates and final cleanliness checks follow. The first AFT diagnostic inspection was partial while local analysis was still running, and Linux-only test modules are not linked by the Mac analyzer. A subsequent authoritative scoped Rust diagnostic snapshot for `providers/mod.rs` and `lib.rs` reported **0 errors and 0 warnings for both files**, examining297 entries/236 inputs; checkout call-graph categories remained unavailable. The authoritative Linux target checks are recorded separately.

Local follow-up reruns on the same Cargo/rustc1.99 toolchain used `nice -n10`, four top-level build jobs and the task-owned exact subconscious source clone; no operator checkout or installed daemon was used:

- `cargo test --locked -j4 -p mc-module --test real_daemon -- --test-threads=1 --nocapture`: **5 passed, 2 ignored**,5.03 s. The ignored cases need private sync/planning captures. lsof observed8–11 database handles below the owning throwaway roots.
- `cargo test --locked -j4 -p mc-module --lib route_targets::tests::a_host_runner_starts_and_serves_without_broca_through_real_subc -- --ignored --exact --nocapture`: **1 passed**,2.91 s, with module/daemon lsof isolation.
- `cargo test --locked -j4 -p mc-module --test real_daemon_store_ahead -- --nocapture`: **1 passed**,2.27 s, using task-built lock-pinned debug daemon/CLI paths; candidate max65 still refuses fixture66 on health and transform.

The follow-up did not change manifests, lockfile, role/SDK pins, context schema, private-store migrations, host codecs, memory writers, ARCHITECTURE.md or STRUCTURE.md. No live-store access, placement, dist rebuild or release-artifact build occurred. The requested local `train/provider-release` ref is advanced to the follow-up HEAD together with the assigned task branch. Final source/comment review and whitespace/staged-scope checks completed before commit; temporary mutation/source-export scratch was removed.
