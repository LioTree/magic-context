# Captured evidence (Linux, 4 vCPUs)

These are excerpts and count summaries copied from execution, not retained build artifacts. The witness programs reproduce the inventories. Publication UUIDs, temporary project paths and timestamps are intentionally not used as equivalence predicates.

## Tool versions

```
cargo 1.99.0 (5f94df478 2026-08-27)
rustc 1.99.0 (b940084d7 2026-09-28)
bun 1.4.2
TypeScript Version 5.9.3
```

## Independent ordinary TypeScript publication

Final `MC_S7_REVIEW=1 bun test .../footprint.test.ts`: **16 pass, 0 fail, 192 expect() calls**. All eight flag/authority combinations were exercised for each of one and two appended compartments. The OpenCode input database was byte-for-byte equal as a row inventory before and after each run.

Two-compartment, disabled-memory captured lifecycle rows:

```json
{"label":"append=2,memory=false,module=false,promote=false","tableCount":137,"stage":{"state":"published","stage":"turn_one"},"publication":{"publication_id":"45c35f0d-280b-40e3-829f-73ceca470b6e","project_path":"dir:e006b14d2177","source_session_id":"s7-r2-ts-session","commit_order":1,"committed_at":1791849557001},"activity":[{"sequence":1,"publication_id":"45c35f0d-280b-40e3-829f-73ceca470b6e","compartment_id":2,"committed_at":1791849557001},{"sequence":2,"publication_id":"45c35f0d-280b-40e3-829f-73ceca470b6e","compartment_id":3,"committed_at":1791849557001}],"facts":[]}
```

For every TS run the changed tables were `compartments` (+N), `compartment_history_versions` (one updated row), `memory_publications` (+1), `memory_stage_attempts` (+1), `memory_activity_ledger` (+N), `historian_runs` (+1), `session_meta` (+1), `subagent_invocations` (+1), and `sqlite_sequence` (one replaced and four inserted rows). In the enabled-memory / auto-promote / TS-authority case, additionally: `memories`, `memories_fts`, `memories_fts_docsize`, `memories_fts_idx`, `memory_decision_receipts`, `memory_journal` each +1; `memories_fts_data` two replaced rows plus a third inserted row; `sqlite_sequence` six inserted rather than four. In the enabled-memory / auto-promote / module-authority case, additionally: `memory_pending_facts` +1, and `sqlite_sequence` five inserted rather than four. All other inventoried tables were unchanged. Candidate blocks/links and proposals remained zero in every case. Memory off or auto-promote off: zero memories and zero pending facts under both authorities.

## Independent ordinary Rust publication

`s7_r2_dormant_rust_all_tables`: all **8** flag/authority combinations passed. Context inventory covered **136** tables, the separate module store **51** tables. For each ordinary one-compartment publish the changed context tables were `compartments` (+1), `compartment_history_versions` (one replaced row), `memory_publications` (+1), `memory_activity_ledger` (+1), `sqlite_sequence` (one replaced and two inserted rows). Only with memory + auto-promote on:

* Module authority: `memories`, `memories_fts`, `memories_fts_docsize`, `memories_fts_idx`, `memory_embedding_watermarks` each +1; `memories_fts_data` changed from 2 to 3 rows (2 replaced, 3 added); `sqlite_sequence` three inserted rather than two.
* TS authority: `memory_pending_facts` +1; `sqlite_sequence` three inserted rather than two.

All other context tables were unchanged. Ordered lifecycle counts `[publications,stages,activity,pending_facts,memories,proposals]` were `[1,0,1,0,0,0]` for all off/opt-out cases; `[1,0,1,0,1,0]` for module-owned promotion; `[1,0,1,1,0,0]` for TS-owned mirroring. The module-store changed-table list in every run was exactly:

```
mc_cache_state
mc_cache_state_digest
mc_chunk_transcripts
mc_compartment_dates
mc_pass_trace
```

## Default recovery fence and the outstanding error-path counterexample

```
test historian::tests::s7_r2_default_fence_survives_reopen_and_releases_once ...
S7_R2_FENCE dispatch=123 timeout=600000 probes=3 expiry=600123 fence=1800123 reopen=3 pre_fence_starts=0 boundary_starts=1
ok

test historian::tests::s7_r2_late_typed_error_must_not_abandon_fresh_attempt ...
S7_R2_LATE_ERROR seq=2 state=Idle run=None failure=Some("producer reattach output (...old-key...): RunFailed { run_id: \"old-provider-run\", detail: \"late old failure\", classification: Some(ErrorClassification { class: Transient, retry_after_secs: None }), class_field_present: true }")
assertion `left == right` failed: late error from attempt 1 abandoned attempt 2
  left: Idle
 right: AwaitingProducer
FAILED

failures:
    historian::tests::s7_r2_late_typed_error_must_not_abandon_fresh_attempt
test result: FAILED. 2 passed; 1 failed
S7_R2_EXPECTED_RED late_typed_error; other 2 independent witnesses passed
```

This deliberately interleaves the component API using an await hook and the real durable state-transition functions. It does not show that today's guarded production scheduler reaches that interleaving.

## Five mutation runs

All controls began with their live files staged and empty `git diff --stat`. Each applied source included `NON-VACUITY BREAK`. Each was restored with `git checkout -- <path> && touch <path>`; every post-restore `git diff --stat` was empty.

| Control | Applied diff | Exact failure and capture | Other selected tests |
|---|---|---|---|
| A1: suppress tombstone persistence | `historian_recovery.rs`: 2 insertions, 1 deletion | `historian::tests::s7_review_witness_unknown_outcome_has_a_deadline`: `left: AwaitingProducer`, `right: Idle`, eight reattachments eight days later | `s7_review_witness_disabled_memory_does_not_queue_facts`, `s7_review_witness_dormant_publish_has_no_new_rows` passed |
| A2: `collect_facts: true` | `historian.rs`: 2 insertions, 2 deletions | `historian::tests::s7_review_witness_disabled_memory_does_not_queue_facts`: `memory.enabled=false still persisted a provider-emitted fact; left: 1; right: 0` | deadline and dormant-publish witnesses passed |
| A3: `lifecycle_enabled()` returns true, constant left false | `historian_stage.rs`: 1 insertion, 1 deletion | `historian::tests::s7_review_witness_dormant_publish_has_no_new_rows`: `left: [1,1,1,0,0,0]`, `right: [1,0,1,0,0,0]` | deadline and disabled-memory witnesses passed |
| R1: bypass ordinary publication/activity transaction writes | `context_writes.rs`: 2 insertions | `historian::tests::s7_review_witness_dormant_publish_has_no_new_rows`: `left: [0,0,0,0,0,0]`, `right: [1,0,1,0,0,0]` | deadline and disabled-memory witnesses passed |
| R2: set minimum unknown fence to zero | `historian_recovery.rs`: 1 insertion, 1 deletion | `historian::tests::s7_r2_default_fence_survives_reopen_and_releases_once`: `left: Number(1200123)`, `right: 1800123` | `historian::tests::unknown_budget_is_durable_and_expiring_fence_discards_late_reply` passed (its 1-hour timeout does not depend on the floor) |

A1–A3 had exactly 2 pass / 1 fail each. R1 had exactly 2 pass / 1 fail. R2 had exactly 0 pass / 1 fail in its target run and 1 pass / 0 fail in its companion run. No compilation failure was counted as a reddened control.

## Restored gates

* Original `witnesses`: 3 module + 1 store named witnesses passed.
* `historian_producer` filter: 33 passed, including dormant identity, lost-send acknowledgement identity, distinct attempt identity, queue/retract behavior, queue and steer serializer goldens. Includes injected snapshot/control tests and one content-language test.
* `tests::gate_a2`: 9 passed (7 existing + 2 injected); killed-host/restart/token and retained-child cases.
* `the_historian_claim_lane_answers_the_wire_a2_codes_against`: 1 passed, the actual host-wire golden (not conflated with the `gate_a2` file filter).
* TS host compatibility + host-runner suite: 18 passed in the combined host/footprint run; its eight then-failing multi-compartment fixture cases were amended to provide the required lookahead and suffix metadata. Final footprint-only rerun passed all 16.
* Repository plugin typecheck (three tsc invocations) passed. Explicit r2 witness tsc passed after correcting nullable database and generic fixture typing.

Early fixture-only failures: a nonexistent `lane` SQL column was removed; a second simultaneous McStore open hit its exclusive lease and was replaced by a shared-store hook (the separate default-fence test really closes/reopens); an untagged error used the unknown-outcome branch and was replaced with the intended typed `RunFailed`; the expected-red parser was narrowed from a newline-matching character class to `\S+`; the two-compartment reply initially lacked lookahead and valid suffix metadata. None is reported as a production failure.
