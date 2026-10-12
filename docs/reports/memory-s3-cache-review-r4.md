# Independent memory S3 cache review, round 4

**Reviewed:** `fa2facc05d9a86d1bd9acc8d2dcc58f63b197b19`, on the migration development line based on `train/agent-move`. **Recommendation: do not merge as satisfying the stated no-read contract.** This delivery changes only this report and opt-in review evidence; no product implementation, migration, architecture or structure document changes.

**Terms:** m[0] is the session's frozen baseline prompt; m[1] is its cached delta. HARD rebuilds the baseline from current rows; SOFT refreshes the delta on an authorized opportunity; defer replays stored bytes. Canonical means current database state, not necessarily the prose already shown. A fragment is an immutable operation receipt rendered into m[1]. A witness is a regression test demonstrating an observable assertion. A watermark is an aggregate head such as `MAX(id)`, used to detect pending work. The Rust facade is the module's bound command interface used by the TypeScript hosts. An epoch bump invalidates a project's cached baseline and requests HARD.

Read [the replacement design](../designs/memory-s3-projection.md) first. The redesign does remove the lossy withholding/recompute mechanism. Its **memory-block renderer** is substantially safer: retained receipts, foreign-session isolation, operation-level fragments and legacy replay survive the exercised sequences. But the **complete pass** is not memory-read-free, automated expiry still uses Rust's agent archive command rather than an automated-history transaction, and the promised overflow signal can disappear entirely.

The three older reports are absent from this checkout; their original repository paths can be read at these historical commits:

- `ec4de73353:docs/reports/memory-s3-cache-review.md`;
- `9992ed046e:docs/reports/memory-s3-cache-re-review.md`;
- `6848dbbe9c:docs/reports/memory-s3-cache-re-review-r3.md`.

## Findings by severity

### P1 — automatic-search processing still reads canonical memory on non-HARD passes

This is a **real row/text read**, independent of any interpretation of aggregate watermarks. OpenCode's postprocessor calls `getVisibleMemoryIds` whenever automatic search is enabled, not only on HARD (`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:3710–3751`). OpenCode 2 uses the same transform factory (`packages/plugin/src/v2/hooks/context.ts:94,1694`). Pi does the same in its context handler (`packages/pi-plugin/src/context-handler.ts:3949–4002`).

`getVisibleMemoryIds` calls `readFullyVisibleMemoryIds`, which compares the served manifest and committed full fragments to **current canonical content/status**:

```sql
SELECT id, content, status FROM memories WHERE id IN (?)
```

See `inject-compartments.ts:249–289` and `memory/applied-projection.ts:301–364`. The cached-pair upgrade and non-persisted recovery visibility helpers also compare against current rows (`readServedTextVisibleMemoryIds`). Explicit `ctx_search` is allowed to do this; silently calling its visibility helper during every eligible transform is a different path.

The six handler/postprocessor witnesses assert unchanged m[0] / no HARD, reach the automatic-search call, and then fail because the actual canonical-text SELECT executed. The search runner is mocked to return a timeout/unchanged messages: **the read already occurs before the worker runs**, so the failure does not depend on an embedding service, search match, or hint being attached. A throwing loader alone could miss it: `getVisibleMemoryIds` catches errors and returns `null`. The independent observer records statement execution instead.

Rust has another direct path. `maybe_decide_live_user_hint` invokes `run_user_hint_lexical_search` for a new eligible authored user tail (`crates/mc-module/src/transform.rs:12635–12697`). That producer loads `load_visible_memory_candidates` and tokenizes canonical content (`:12743–12795`). `r4_automatic_hint_producer_reads_no_memory_rows` succeeds before renaming `memories`, then fails with `no such table: memories` after the rename. This is a producer-level witness, not a full host-wire test; the complete Rust pass also fails earlier at its watermark probe (next finding).

**Consequence:** the narrow m[0]/m[1] composer gate is not the promised whole-pass gate. Newly computed automatic hints still depend on other writers' current rows, outside the frozen memory pair. Existing persisted hints replay; that does not make a new hint a function of the session's shown memory and own fragments. The production search runner still requests the `memory` source (`auto-search-runner.ts:321–355`). I did not measure a provider-cache miss from this path; the prohibited reads are independently demonstrated.

**Required direction:** prevent automatic visibility/search helpers from loading current memories on non-HARD passes, or explicitly obtain a different contract that allows it. Do not relabel the composer-only tests as complete-pass proofs.

### P1 — module-routed expiry uses the Rust agent archive port: log row, no undo history

The local TypeScript expiry branch writes undo history without a log row, but its module route uses the agent archive implementation instead:

- `dreamer/expire-memories.ts:47–105` sends `ctx_memory`, action `archive`, reason `expired`, to the module;
- the Rust facade archive implementation updates status and calls `append_memory_mutation_tx` (`crates/mc-store/src/lib.rs:6808–6869`);
- it neither calls `record_automated_memory_edit_tx` nor inserts `memory_history`.

The independent facade witness activates memory authority, inserts a row with a declared expiry, and submits the **same command shape** as the TS module router. It first asserts that the facade responded and the row became archived. Then:

```text
r4_module_routed_expiry_writes_history_and_no_mutation_log
expected (mutation-log rows, history rows): (0, 1)
observed:                              (1, 0)
```

No new Rust agent fragment is expected in S3; that approved S4 gap is not this finding. This is an **automated writer** emitting a forbidden prompt-mutation signal and omitting required undo history. Both OpenCode and Pi can use the shared dreamer module route. The log does not leak new prose through `compose_soft_m1`, but it still participates in the per-pass signal and this writer is not undo-recorded as promised.

**Required direction:** recheck declared expiry and write authority inside an automated archive transaction with history and no log/fragment. Verify archive must remain a proposal, not become an alternate direct-expiry shortcut.

### P2 — every host still queries memories and the mutation log for watermarks

Even with automatic search disabled, the whole-pass no-read assertion is false:

- TS `MARKER_CHANGE_PROBE_SQL` reads `MAX(memory.id)` from `memories`, filtering canonical status, expiry and sharing columns, and `MAX(id)` from `memory_mutation_log` (`inject-compartments.ts:1458–1499`). Uncached marker reads use the same underlying sources (`:1615–1649`). Pi uses the shared marker machinery.
- Rust `load_m1_revision_snapshot` reads both heads (`crates/mc-store/src/lib.rs:12661–12712`), and the in-session digest hashes both (`crates/mc-module/src/m1_compose.rs:71–129`).

The independent TS strict-observer test fails once for each harness. Four separate Rust full-transform tests warm a real HARD, verify that the unmodified next action is `SOFT` or `SOFT+`, then rename **one table at a time**. All four fail at the missing table, for both memory and log heads. These are not failures to reach the non-HARD premise.

The replacement design openly retains Rust memory watermarks (`memory-s3-projection.md:90`). The existing TS loader gate explicitly **exempts MAX/MIN/COUNT** (`shared/memory-projection-fixtures.test.ts:38–49`), while the Rust acceptance test renames tables only around `compose_soft_m1`, not around the preceding classifier/signal read (`m1_compose.rs:1861–1929`). Those tests prove a narrower claim and pass honestly under that narrower definition. They cannot prove that the entire non-HARD pass avoids reading memories and the mutation log.

No canonical prose entered the pair through these aggregates in the stress tests. Severity is lower than the row-reader above, but this is a **contract discrepancy**, not a passing read gate. Keeping the digest can also open an execute-band SOFT whose memory bytes do not change, as the design already acknowledges.

### P2 — a full correction allowance can omit even the promised stale marker

`composeSoftMemoryUpdates` preserves committed receipts, but when a marker itself cannot fit it logs a diagnostic and `break`s (`inject-compartments.ts:3430–3437`). It does **not** append a marker, and every later fragment waits behind that operation. The design's implementation comment acknowledges this third outcome; the task's ruling describes only full-fragment or short-marker outcomes.

The witness uses **500 tokens**, the production schema's minimum permitted memory budget (`config/schema/magic-context.ts:1511–1517`), not an invalid tiny configuration:

1. HARD serves `Marker baseline.`;
2. twenty small authorized agent updates are attempted on SOFT;
3. four full receipts remain visible, including `Adopted receipt 0.`;
4. an oversized agent save creates memory 2 and an immutable fragment;
5. SOFT keeps m[0], keeps those receipts, and defer replays exactly;
6. there is **no** `<stale-memory ids="2" …/>`.

The three `full allowance still gives an oversized operation a marker` tests fail at step 6. No correction-originated HARD occurs. It no longer discards the earlier adopted correction when a subsequent edit cannot fit, the specific retention failure reported in round 3, but still leaves an **unannounced pending edit** and head-of-line waiting. A later unchanged SOFT has no newly available allowance; “wait for a later pass” is not generally a recovery mechanism when shown fragments cannot shrink.

**Required direction:** explicitly reconcile the guarantee of a stale marker for every rejected fragment with a finite budget in which earlier fragments cannot shrink. Do not silently call the marker guarantee satisfied because the no-room diagnostic went to a log.

### P2 — an agent merge into an unshown, unchanged survivor omits its prose

After an empty HARD, another writer inserts A and B. The session merges `[A,B]` using B's exact current content. This valid agent operation commits, but the only served fragment is:

```xml
<superseded id="1" by="2"/>
```

B's full text is absent from both m[0] and m[1]. The three `merge into an unshown existing survivor shows the survivor text` tests first assert an applied receipt and the supersession, then fail on the missing survivor prose.

`agentMutationFragment` decides to include the survivor only if it is new or its text changed (`lifecycle-applier.ts:419–434`). It does not know whether an unchanged survivor was actually shown by this session. Under the old additive path B could arrive from the current-row pool; that path is now intentionally gone. This is not a partially committed canonical operation: the operation/log/fragment transaction is atomic, but the fragment's **representation** is incomplete for this reachable session state.

The agent's tool arguments may still contain B's prose in the fresh conversation. The demonstrated defect is specifically missing memory-pair representation, not a claim that all outgoing conversation text lacks it. If merges are intended to authorize only retirement receipts for unchanged survivors, that exception needs an explicit product ruling; it is not covered by the all-or-nothing/complete-operation claim.

### P3 / contract clarification — an explicit save of an unshown duplicate writes no fragment

A foreign automated insertion after HARD is correctly unshown. The agent then explicitly saves identical content. The applier returns `applied` and the existing memory ID, but the next SOFT still does not show it. Fragment creation is guarded by `!match` (`lifecycle-applier.ts:199–239`). All three `explicit agent save of an unshown duplicate reaches its session` witnesses fail on absent text.

This may be an intentional **reinforcement-only** duplicate-save policy, rather than a new cache bug. The design's unqualified “agent save fragment” rule does not state that exception. Distinguish it from a genuinely inserted agent save, which does render and is covered by the passing existing tests. Resolve the contract before treating these three red assertions as mandatory merge blockers.

## Results in the requested review order

### 1. Read gate, caches, mural and search paths

| Surface | Evidence | Result |
| --- | --- | --- |
| TS/Pi memory-block composition | Existing loader-throw tests, with a HARD positive control; independent 180-round sequences also run SOFT with that gate on | Pass for **row/log loading by the composer**, excluding aggregate probes and automatic search |
| OpenCode 1/2 full postprocessing | Canonical-text observer before first HARD, then low/defer and execute-band calls with automatic search enabled | Fail: visibility helper executes a canonical-text SELECT on both opportunities |
| Pi context handler | Same observer around a warmed registered handler; unchanged stored m[0] before/after | Fail on both low/defer and execute-band calls |
| TS/Pi marker probe | Strict observer includes aggregate SELECTs | Fail for all three harness identities |
| Rust memory composer | Existing `soft_m1_reads_no_memory_rows_or_mutation_log`, tables renamed, row renderer as positive control | Pass |
| Rust complete transform | Separate `SOFT`/`SOFT+` and memory/log table-rename witnesses, with unmodified action controls | Fail on both tables and both actions |
| Rust automatic hint producer | Successful unmodified producer, then missing-memory-table control | Fail: canonical candidate loader is reached |
| Mural | SOFT uses frozen m[0] image/metadata; the examined SOFT functions do not resolve from the live mural pool | Source path supports the frozen-image claim; **no independent rendered-image/provider-wire stress run** |

Terminology matters: Rust's action string `SOFT+` is the uncommitted/replay opportunity, while its armed refresh is `SOFT`. The TS/Pi drivers use `busting=true` for refresh and `false` for defer. The handler witnesses label the lower/defer and higher execute-band opportunities explicitly; they do not equate a harness label with a measured provider-cache event.

The observer is installed before warming, so the prepared statements it sees are wrapped before reuse. It watches execution, not preparation, and records reads even when a helper catches an exception. It covers the existing unquoted `FROM`/`JOIN` memory/log statements used here; it is not an SQL parser or a kernel-level guarantee about arbitrary future query forms.

### 2. Byte stability

The independent deterministic stress uses seed `0x5a17`, **180 iterations for each TS harness identity** (540 total): own saves, updates, merges, multi-row archives, oversized saves, automated verify-style edits, foreign saves and foreign HARDs, and ordinary repeat/replay opportunities. It asserts:

- defer before refresh equals the previously served pair;
- every refresh remains non-HARD and retains identical m[0];
- previously shown correction/marker lines remain present;
- foreign/automated text never enters the pair on refresh;
- unchanged own-fragment state gives identical pairs;
- repeated refresh and defer are byte-identical;
- a subsequent HARD resets the fragment/marker surface.

All **three** stress tests pass. The test is not its own renderer oracle: foreign text and retained receipt strings are checked against the actual earlier served pair; it does not compute a second expected pair using `composeSoftMemoryUpdates`.

Rust additionally passes a **150-iteration** full-transform stress of seeded inserts/updates, foreign-session HARDs, ordinary appended tail items, `SOFT+` and armed `SOFT` byte equality. It intentionally expects no Rust fragments. This Rust sequence does **not** exercise every merge/archive/batch tool variant; the approved fragment gap remains pinned by `rust_soft_renders_no_agent_fragments_yet` in the passing baseline suite.

Limits: these are synthetic pair/engine tests, not a recorded corpus or deployed host-wire matrix. The TS injector driver does not model all live host tail appends; the postprocessor/handler probes reach actual processing functions using fixture messages. Automatic-search workers are excluded from pair stress and exposed separately by finding 1. Therefore this is **not** a claim that complete provider bytes are a pure function of shown memory on every production pass.

### 3. Fragments and HARD folding

The earlier report demonstrated that an oversized second edit could erase the first correction already shown. That retention defect is repaired in the exercised sequence. Existing overflow tests and the randomized sequences preserve earlier full receipts, append deterministic markers when space exists, and replay those exact bytes. `writeHardProjection` captures the fragment watermark and starts a new committed list (`memory/applied-projection.ts:102–164`); later SOFT commits the new list with cached bytes in the same writer transaction (`inject-compartments.ts:3705–3817`).

The independent **42-row archive** test passes on all three TS harness identities: one operation key, one immutable fragment, 42 mutation rows with that key, identical receipt on retry, no partial `<removed>` admission at the 40-line cap, one marker, and no marker or retired prose after HARD. This is a concrete all-or-nothing and retry control, not an assumption based solely on the schema's `operation_id` index. Archive/merge fragments are recorded inside the canonical operation's immediate transaction (`lifecycle-applier.ts:438–648`).

HARD reads canonical state, rather than concatenating historical fragment text into m[0]. Resetting old fragments thus avoids receipt duplication; budgeted selection can still omit a large current memory. The tests do not promise that every current row fits the head. Marker disappearance at HARD, omitted as a dedicated assertion in the design's witness table, is now asserted by both the archive and stress controls. The remaining exceptions are no-room markers, unchanged unshown merge survivors and unshown duplicate saves, described above.

### 4. Writers, history and dashboard exceptions

| Writer | Path examined / executed coverage | Assessment |
| --- | --- | --- |
| TS primary `ctx_memory` | OpenCode tool branches use `applyAgentMemoryMutation` and `applyMemoryAdmission`; Pi primary tool branches use the same applier (`pi-plugin/src/tools/ctx-memory.ts:374,591`) | Canonical edits plus session fragment transaction; history for edits; duplicate/unshown-survivor exceptions above |
| Historian new admission | `applyMemoryAdmission` uses historian provenance and never emits an agent fragment for non-agent admissions (`lifecycle-applier.ts:204–239`) | No log/fragment admission; waits for HARD in the pair |
| Historian revision / turn-two correction | `MEMORY_PROJECTION_READY = false`; revision commit implementation remains present (`lifecycle-applier.ts:654–868`) | **Disabled writer**, not an exercised direct-update path. The design explicitly declares this gap; no enabled historian-revision proof is claimed |
| Verify update, TS shared by OpenCode/Pi | `dreamer/verify.ts:737–755`: gated rewrite plus `recordAutomatedMemoryEdit` | Direct row/history/revision, no log/fragment; relevant baseline tests pass |
| Verify archive, TS | `verify.ts:756–766` | `verify` proposal, row stays live; baseline tests pass |
| Verify update/archive, Rust | `mc-store/src/lib.rs:17355–17514`; `verification_and_mapping_facades_are_fenced_hash_guarded_and_idempotent` | Update records history/revision and no log; archive proposal; baseline test passes |
| Expiry, local TS | `expire-memories.ts:154–174` | Direct archive plus history, no log/fragment; baseline tests pass |
| Expiry, module route | `expire-memories.ts:47–105`, Rust facade archive | **Fail**, finding 2; real facade command witness reaches `(1 log, 0 history)` |
| Curate update/merge/archive | OpenCode `ctx-memory/tools.ts:646–654,755,823`; Pi `tools/ctx-memory.ts:729,870,935` | Proposals in the examined TS tool paths. Pi's primary-vs-dreamer routing baseline tests pass. An independent end-to-end module-owned curate task was **not** run |
| Dreamer save / retrospective memory | `applyMemoryAdmission` retains dreamer provenance and skips fragments; `retrospective-learnings.ts:170–189` inserts gated new dreamer rows directly | No log/fragment; relevant baseline tests pass. Retrospective new-row insertion is an explicit design exception, not an audited edit-history route |
| Rust primary agent edits | Existing store/tool log-writing paths remain | Approved S3 read-gate-only scope; no fragment parity claimed |
| Dashboard | `dashboard/src-tauri/src/db.rs:6134–6268,6271–6380,6386–6467` | Deferred to slice 11, not routed through the new applier |

Dashboard detail matters: content edits and archive/delete operations queue mutation rows, with no agent fragments. **Restore/pin/unpin into an injectable status** fan out eager workspace epoch bumps; archive is log-only, not an eager epoch bump. Category edits queue their visibility change and bump epochs. Thus the design note's shorthand “status/category edits still bump” is overbroad for archive. Eager epoch changes legitimately reach the next pass through an existing **HARD**, not by sneaking prose through SOFT. Log-only dashboard changes remain absent from the memory pair until HARD, but are not invisible to the watermark and automatic-search paths identified above. No dashboard `memory_history` undo consumer was found in the examined Tauri source; undo/approval coverage remains a slice-11 gap, not a tested S3 promise.

### 5. Migration, fixture, fingerprint and move inventory

The new literal legacy-cache probe passes for each harness identity: a populated **v98-shaped** database with nonempty multiline corrections and additions is upgraded using migration 99. Canonical prose changes after the cached correction; first defer and first SOFT preserve the cached pair exactly, invent no marker, keep edited current prose searchable, and then append only the new own fragment.

A stronger independent control uses the **actual old renderer** exported from `5b8c9a2d313959bc427cc177e99587c9dbf48ab1` (the ancestor before memory-lifecycle scaffolding). That snapshot's fence is v97. Its database is moved to **v98 using the current, pre-memory migration 98** before the old renderer warms and emits a real cached multiline correction. At that point the persisted migration head is asserted to be 98. Close/reopen through current `initializeDatabase` and `runMigrations`, then compare first defer and SOFT against the actually emitted old pair. All **three** hosts' renderer controls pass, 21 assertions total. This is an original-runtime byte control over a real populated v98 database; it is not a claim that the exported binary itself advertised a v98 fence or that a live store was sampled.

Schema follow-through also passes:

- `r4 generated context schema matches committed Rust fixture` compares actual generator stdout against `crates/mc-module/tests/fixtures/context-db-schema.sql`, byte for byte, including the current v100 fence;
- `host_store::tests::domain_fingerprints_match_the_committed_schema_snapshot` passes in the Rust baseline suite; the memory log fingerprint is `3df65a4de3a311e953e06adbe65c53f168c51e9847322130b5adff823ff6bb91` (`host_store.rs:365–368`);
- inventory version is **5**; fragments ship by session with `PreserveOrRefuseCollision`, not remapped IDs, because stored watermarks/receipts reference those IDs (`mc-store/src/move_inventory.rs:9,2698–2761`);
- `v99_memory_inventory_ships_session_state_and_keeps_project_history_together` and `host_runner_inventory_ships_whole_v87_harness_aggregates` pass (`move_inventory.rs:3868–3938`);
- TS session deletion and OpenCode 2 relabel inventories include fragments (`storage-session-tables.ts:87`, `opencode2-relabel.ts:127–128`).

The generator equality check has a non-vacuity control: stage the live state and fixture, confirm empty unstaged diff, append one `NON-VACUITY BREAK` comment to the fixture, capture **one file / one insertion**, run only the named schema test, observe **that test alone red** (27 other tests filtered), restore from the index and touch the fixture, then confirm empty unstaged diff. The final fixture is unchanged. This proves the comparison is not reading a file against itself; it is not a schema-semantic mutation proof for every domain table.

No upgrade from the earlier, unreleased, differently shaped **v99** is certified. The approved in-place-v99 ruling excludes that compatibility problem; `CREATE TABLE IF NOT EXISTS` should not be mistaken for such a migration. No compatibility shim was introduced.

### 6. Earlier reviews' witness claims

The original tests cannot be run unchanged against the deleted recompute API. Their observable requirements are not all interchangeable, so the design's table was checked by group:

| Earlier witness names / family | Assessment at this revision |
| --- | --- |
| `deferred_archive_keeps_applied_delta_until_hard`; `unadmitted_deferred_revision_does_not_leak_as_new_memory`; `live_successor_cannot_force_a_deferred_target_revision`; `live_update_before_deferred_update_is_not_rendered_as_removal`; `merge_with_deferred_source_cannot_admit_dependent_successor`; `dependent_supersede_keeps_admitted_source_when_successor_is_deferred`; `oversized_successor_group_keeps_admitted_source_until_hard`; `deferred_archive_then_live_restore_and_edit_waits_until_hard` | **Validly not applicable to the deleted recompute mechanism.** No SOFT memory composer consults canonical eligibility or subtracts deferred log edits. Foreign/automated changes retain the pair in the existing and independent stress tests. This does not excuse the separate automatic-search row reads. |
| `r3_merge_with_deferred_source_is_atomic_*`; `r3_deferred_edit_between_softs_keeps_baseline_and_delta_live_revisions`; `r3_long_cyclic_dependency_closure_withholds_every_touched_row`; `r3_all_live_supersession_cycle_terminates_without_forcing_a_replacement` | **Validly not applicable as log/dependency-closure algorithms.** No SOFT closure or forced-successor traversal remains. Grouped and NULL log IDs alike cannot be partially interpreted by that removed algorithm. New TS agent operation atomicity is checked independently by the 42-row fragment control; Rust fragment atomicity remains out of scope. |
| `new_admission_priority_uses_creation_importance_not_current_importance`; `older_low_importance_waiting_admission_precedes_newer_high_importance`; `new_admission_near_size_threshold_withholds_correction_until_hard` | **Validly not applicable to current-row SOFT admission.** Foreign row selection/order now waits for HARD. An own agent fragment is not a re-ranked row admission. |
| `live_correction_pressure_cannot_authorize_deferred_adoption`; `live_delta_correction_count_cannot_originate_a_hard_fold`; `correction_free_backstop_survives_outer_wrapper_threshold`; `withheld_update_and_forty_one_small_corrections_are_folded_at_next_hard` | **Mechanism restated, broadly supported, not all old fixtures re-executed.** Existing `pending_lifecycle_cannot_manufacture_pressure_hard` passes; the independent overflow/archive/stress controls stay non-HARD. Rust `memory_corrections_make_no_pressure_and_a_hard_keeps_ready_notes_out_of_m1` passes in the full baseline suite. No dedicated independent outer-wrapper-threshold counterfactual was added; ordinary pair stress is not proof of every pressure threshold. |
| `correction_record_cap_withholds_a_multi_target_merge_whole`; `r3_null_id_multi_source_merge_is_not_partially_admitted_at_record_cap` | The old log-grouping cap is gone. **New representation control passes:** 42-row batch archive emits one marker and no partial full receipts. A 42-source merge is not independently exercised here. |
| `r3_oversized_edit_keeps_last_applied_correction` | **Repaired in the restated existing test**, and retained receipt stress passes. The no-room-marker finding is a different remaining defect. |
| `r3_upgrade_preserves_existing_null_id_correction_without_false_marker`; `upgrade_without_projection_replays_then_reorders_only_on_independent_soft` | **Repaired replay requirement.** Literal populated-cache and original-renderer upgrade controls pass. Reselection/reordering on SOFT is now intentionally absent; that part is not a requirement of the replacement design. |
| `r3_stale_marker_replays_once_within_allowance_and_disappears_at_hard` | Marker replay passes when a marker fits; independent archive/HARD control now asserts disappearance. **Not a universal marker guarantee** when the allowance is full. |
| `failed_projection_extension_rolls_back_cached_bytes_and_manifest` | Existing `rolls back refreshed bytes and their manifest together` TS/Pi tests pass in baseline package suites. Same cached-pair writer transaction remains; no new independent multi-process rollback test. |
| `original_ctx_search_fixture_defers_replacement_without_hiding_search`; `upgrade_without_projection_keeps_edited_memory_searchable` | Current-text exclusion logic exists and existing current-revision tests pass; the literal upgrade probe also asserts that changed canonical text is not hidden. Automatic search invokes that same otherwise-useful helper at the prohibited time. |
| `upgrade_visibility_recognizes_complete_multiline_memory`; `fresh_contention_fallback_visibility_matches_actually_served_revision`; `fresh_recovery_visibility_recognizes_complete_multiline_memory` | **Still a coverage gap, not validly dismissed as deleted API.** The legacy/recovery served-text helpers remain (`applied-projection.ts:370–442`). Upgrade byte preservation includes multiline corrections, but does not prove complete multiline exclusion or actual contention/fresh-recovery visibility. The design acknowledges these missing dedicated tests; no blanket “all search witnesses pass” claim is justified. |

The design also explicitly defers the Rust marker probe, dashboard approval, privacy-revocation and rendered-mural concurrency/cue override tests. Those are genuine unverified edges, not successful tests. Source inspection of the frozen SOFT renderer supports removing the old row/log dependency witnesses; it does not establish a whole-host no-read invariant or every remaining search/mural edge.

### 7. Product consequence and scope of latency changes

Other writers' **additive memories** now wait for HARD in the memory pair, as intended. The existing genuine-HARD tests and independent foreign-HARD stresses confirm this. Automated verify content changes also wait, and proposal-only archive/curate operations leave canonical rows live until review. An own newly inserted agent save still rides the session fragment path; Rust deliberately does not yet have that path.

Other behavior explicitly documented by the redesign includes current, unlabelled explicit search; no archived/superseded explicit-ID result; frozen mural reuse; and removal of correction-originated HARD pressure. The following are not established as intended exceptions to the task's contract: transform-time canonical search reads, aggregate/log probes on non-HARD passes, module-routed expiry without history, and silent no-marker waiting. The duplicate-save reinforcement exception is identified separately rather than asserted to be a new regression. No empirical claim that “nothing else changed” can be made without the missing deployed host/provider matrix.

## Executed gates and reproducibility

All suites and compiler gates ran **on Linux, `runon: "linux,8c"`**, sequentially. No network-enabled remote lane was used. Tool versions: **Bun 1.4.2 (`744846f84`)**, **TypeScript 5.9.3**, **Cargo 1.99.0 (`5f94df478`)**, **rustc 1.99.0 (`b940084d7`)**, installed **Biome 2.5.1**. The prepared local build was reported successful by the task launcher; this review did not rebuild product bundles or use that as a host proof.

| Command/check | Result |
| --- | --- |
| `BUN_JSC_useOMGJIT=0 bun test packages/plugin/src/hooks/magic-context/memory-projection.test.ts packages/plugin/src/features/magic-context/memory/applied-projection.test.ts packages/pi-plugin/src/memory-projection-pi.test.ts` | **21 pass, 0 fail**, 205 assertions, 3 files |
| `bun run --cwd packages/plugin test` | Baseline at reviewed commit: **8,282 pass, 19 skip, 11 fail**, 8,312 tests / 785 files, 339,728 assertions; exit 1 |
| `bun run --cwd packages/pi-plugin test` | **1,844 pass, 9 skip, 0 fail**, 1,853 tests / 185 files, 95,635 assertions |
| `cargo test -p mc-module -p mc-store --lib --offline -- --test-threads=8` | **mc-module: 1,893 pass, 24 ignored, 0 fail; mc-store: 328 pass, 5 ignored, 0 fail** |
| `bun run --cwd packages/plugin typecheck` | Passed, three compiler invocations |
| `bun run --cwd packages/pi-plugin typecheck` | Passed, two compiler invocations |
| `packages/plugin/node_modules/.bin/tsc --noEmit -p docs/reports/probes/memory-s3-r4.tsconfig.json` | Passed after explicit package type roots were added; the initial probe-only attempt could not resolve Node/Bun type libraries from the docs directory |
| Opt-in TS/Pi review harness with historical export enabled | **13 pass, 18 intentional fail**, 31 tests / 1 file, 9,784 assertions; final compiler and Biome checks pass (2 files linted, no fixes) |
| Opt-in Rust review patch, `cargo test -p mc-module --lib --offline r4_ -- --test-threads=8` | **1 pass, 6 intentional fail**, 1,917 filtered; all seven tests compiled and ran |
| Schema generator non-vacuity control | Named schema test alone red; fixture restored and unchanged |
| `inspect` on report/probes | **PARTIAL**, docs files have no covering LSP project/producer and call-graph analysis was unavailable; explicit compiler/lint checks are authoritative |

The plugin baseline's eleven failed names are: `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`; `slow embedding aborts at the deadline, freezes skip bytes, and cannot land late`; and nine `review bundle:` worker tests (OpenCode/Bun, OpenCode/Node, OpenCode2/Node, Pi/Node, OMP/Node, plus packed OpenCode/Bun, packed OpenCode2/Node, packed Pi/Node, packed OMP/Node). This full sweep ran before review probes were added, with unchanged product code. These are **baseline failures at fa2facc0**, not claimed fixed, not evidence that the package release gate is green, and not attributed to memory S3 without an independent cause investigation. Frozen installs in both package scripts checked 1,010 installs / 1,251 packages with **no changes**; no manifest or lockfile changed. The plugin/Pi chained command stopped at plugin failure; Pi was then run separately, not counted as having run through the failed chain.

### Opt-in review tests

The `.probe.ts` file is deliberately outside the default package suites. Its red expectations are review evidence, not changes to existing passing tests:

```sh
BUN_JSC_useOMGJIT=0 bun test ./docs/reports/probes/memory-s3-r4.probe.ts --timeout 30000
packages/plugin/node_modules/.bin/tsc --noEmit -p docs/reports/probes/memory-s3-r4.tsconfig.json
```

TS/Pi failure-name suffixes, each instantiated for `opencode`, `opencode2`, `pi`:

- `r4 strict SOFT gate includes memory and log watermark SELECTs`;
- `r4 full allowance still gives an oversized operation a marker`;
- `r4 merge into an unshown existing survivor shows the survivor text`;
- `r4 explicit agent save of an unshown duplicate reaches its session`.

Additionally, `opencode` and `opencode2` each fail `r4 SOFT/defer postprocess auto-search reads no canonical text` and `r4 SOFT+ postprocess auto-search reads no canonical text`; Pi fails the corresponding two `context handler` names. Those **18** failures are explained above. The unmodified stress, atomic archive, literal upgrade and generated-schema controls pass.

The original-renderer upgrade controls are opt-in because they need a historical export. Reproduce inside a disposable scratch directory in this worktree, not another checkout:

```sh
mkdir -p .review-v98
git archive 5b8c9a2d313959bc427cc177e99587c9dbf48ab1 \
  packages/plugin/src packages/plugin/package.json packages/plugin/tsconfig.json \
  packages/pi-plugin/src packages/pi-plugin/package.json packages/pi-plugin/tsconfig.json \
  | tar -x -C .review-v98
ln -s ../../../packages/plugin/node_modules .review-v98/packages/plugin/node_modules
ln -s ../../../packages/pi-plugin/node_modules .review-v98/packages/pi-plugin/node_modules
MC_R4_V98_EXPORT="$PWD/.review-v98" BUN_JSC_useOMGJIT=0 \
  bun test ./docs/reports/probes/memory-s3-r4.probe.ts --timeout 30000
rm -rf .review-v98
```

The Rust evidence is preserved as an **opt-in patch**, so the delivery does not change product source or the ordinary Rust suite. Apply it only to a clean disposable reviewed checkout, run, and reverse it:

```sh
git apply docs/reports/probes/memory-s3-r4-rust.patch
cargo test -p mc-module --lib --offline r4_ -- --test-threads=8
git apply -R docs/reports/probes/memory-s3-r4-rust.patch
```

Six exact Rust red names:

- `tests::r4_module_routed_expiry_writes_history_and_no_mutation_log`;
- `transform::tests::r4_automatic_hint_producer_reads_no_memory_rows`;
- `transform::tests::r4_soft_reads_no_memory_watermark`;
- `transform::tests::r4_soft_plus_reads_no_memory_watermark`;
- `transform::tests::r4_soft_reads_no_mutation_log_watermark`;
- `transform::tests::r4_soft_plus_reads_no_mutation_log_watermark`.

Only `transform::tests::r4_rust_150_rounds_foreign_hards_and_row_churn_preserve_served_pair` passes in that seven-test selection. Both patched source files were restored before delivery; the patch contains only new tests/helper code, no production behavior edits.

## Isolation and remaining release gates

The required rule is retained verbatim:

> never open/read/write/migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`); every host run goes through a throwaway root (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/<task>/`), proven by `lsof`. Clean up throwaway roots.

**No deployed OpenCode/Pi host or Rust daemon was launched in this review.** Therefore there is no real-host `lsof` receipt, no local niced host result, and no claim that fixture harness identities are real-host evidence. All executed new tests use fresh fixture databases or in-memory databases on Linux and clean their temporary database roots; the historical source export is disposable and removed before delivery. No live store or operator configuration was opened, copied, inspected or migrated. The original-renderer control reads repository history, not operator data.

Still required before an all-host cache-safety signoff: deployed OpenCode 1/2, Pi and Rust-daemon read instrumentation with `lsof` isolation receipts; a long real provider-wire replay including actual ordinary tail appends; rendered-mural byte/cue/concurrency assertions; complete multiline and fresh-contention visibility witnesses; enabled historian-revision and module-owned curate writer coverage; and dashboard approval/undo coverage when slice 11 lands. The report's reproduced no-read and expiry failures do not depend on those missing host gates, but its passing synthetic controls must not be promoted into them.
