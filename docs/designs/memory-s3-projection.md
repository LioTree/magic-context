# Memory S3: per-session applied projection (as built)

This records what slice S3 of the memory-lifecycle first release (campaign
`ct_00000000-0000-4938-98dd-b7265b3f4c00`) actually builds, and every place it
departs from the campaign spec and from `docs/designs/memory-lifecycle.md` §7–§8.
The departures follow an operator redesign after three cache-safety reviews of an
earlier S3 attempt found a new hole each round (`docs/reports/memory-s3-cache-review.md`,
`-re-review.md`, `-re-review-r3.md` on the earlier S3 branch). The diagnosis: SOFT passes
rebuilt the session's shown memory view by subtracting withheld operations from
shared canonical rows through a lossy, multi-writer mutation log, and that
subtraction cannot be made exact. The redesign deletes the recompute.

## The contract

1. **Only a HARD fold reads memory.** A HARD fold reads memory rows (and the
   mutation log) to build m[0] and its m[1], and records the session's applied
   tuple in the same writer transaction as the cached pair.
2. **A busting SOFT reads no memory rows and no mutation log** (TS OpenCode 1/2,
   Pi, Rust). It replays the memory blocks the HARD fold rendered byte for byte and
   appends this session's own agent fragments (TS and Pi). New compartments and the
   user-profile delta render as before.
3. **A defer replays stored bytes.** Unchanged.
4. **Automated writers apply directly** to canonical rows once their deterministic
   gates pass, with `memory_history` for undo, and write no mutation-log row and no
   fragment. They reach a prompt only at that session's next natural HARD fold.
   - dreamer verify `update`: applies directly (`recordAutomatedMemoryEdit`).
   - dreamer expiry archive: applies directly (its `expires_at` was declared when
     the memory was written).
   - dreamer verify `archive`: a pending proposal in `memory_tool_proposals`; the
     row stays live.
   - curate: proposals only (update, merge and archive), in OpenCode and Pi.
   - dreamer saves (a curate `write`) and retrospective learnings: inserted with
     `source_type = 'dreamer'`, no log row and no fragment.
   - The Rust module's `memory.set_verification` follows the same rules: a gated
     `update` applies with history and a new revision and no log row; `archive` is a
     pending `verify` proposal.
5. **Agent `ctx_memory` edits apply immediately** through the shared applier
   (save, update, merge, archive) and record one immutable, pre-rendered fragment
   (`memory_agent_fragments`) for the session that made them. That session's next
   busting SOFT appends the fragment to m[1] inside the correction allowance
   (25% of the memory budget, at most 40 full lines, and the refold headroom). A
   fragment that does not fit appends one short `<stale-memory … read-with="ctx_search"/>`
   marker; fragments already shown never move or shrink. Pi's primary-agent paths
   now use the same applier.
6. **`ctx_search` returns current database text, unlabelled.** A hit is hidden only
   while its *current* text is fully visible in the served pair (m[0] text, a fold
   m[1] addition, or a full agent fragment). A mural cue or a stale marker never
   hides a hit; an archived row is never "visible". Explicit-id search no longer
   returns archived or superseded rows.
7. **Memory corrections never authorize a HARD fold.** The refold backstop measures
   m[1] without its `<memory-updates>` block, and the old "more than 40 corrections"
   trigger is gone (TS and Pi). In Rust the SOFT correction count is always 0.

## Storage (v99 edited in place; v99 is unreleased)

- `memory_mutation_log`: `adoption_class` removed; `operation_id` added (with an
  index) as the all-or-nothing key for agent multi-row operations (merge, batch
  archive). NULL for every other row.
- `memory_applied_snapshots`: one row per (session, harness, project) holding the
  generation, the SHA-256 of the m[0] bytes it describes, the fold's memory blocks
  (`hard_memory_block`), the fragment watermark the fold covered, the fragments
  committed by later SOFT passes (`committed_fragments_json`) and a `legacy` flag.
  The slice-1 columns (m0/m1 bytes, mural payload/hash, applied revisions,
  selection/clock/policy metadata, admission ledger, correction receipts and
  cursors) are gone: the cached pair already holds the bytes, and nothing on SOFT
  needs the rest.
- `memory_applied_rows`: unchanged; the fold's text/cue/delta manifest with
  captured text and revision, used for search visibility.
- `memory_agent_fragments`: new, session-scoped (`SESSION_SCOPED_TABLES`, OpenCode 2
  relabel aggregate, Rust move inventory with id-preserving key policy).
- Upgrade: a cached pair with no applied tuple for its m[0] bytes is adopted as a
  `legacy` tuple whose memory blocks are the cached m[1] bytes; nothing is
  reconstructed from rows, no stale marker is invented and no HARD is requested.
- Rust follow-through: `context-db-schema.sql` regenerated, the
  `memory_mutation_log` domain fingerprint updated, the move inventory updated for
  the new columns and table, and `INVENTORY_VERSION` bumped from 4 to 5.

## Deviations from the campaign spec and the design

| Spec / design text | As built |
| --- | --- |
| Slice 3 "populates [the slice-1 tables] and adds no migration" | v99 edited in place (operator ruling; v99 exists only on the migration branch). |
| "Every mutation-log row carries the applier's adoption class"; projection withholds `deferred` rows on SOFT | No adoption class. SOFT reads no log at all. Applier receipts still carry an `adoptionClass` field for TS/Rust receipt parity; nothing reads it. |
| Design §7 B2 projected revision pool, persisted admission ledger, A1/A2/A3 dependency withholding, per-operation correction budget | Deleted. SOFT = fold memory blocks + own agent fragments. `dependent_A3_waits_for_hard` is not built: no SOFT renders automated or foreign changes, so there is nothing to withhold. |
| Additive memories (historian promotions, other sessions' saves) ride the next priced SOFT via the `maxMemoryId` watermark | They wait for the next HARD fold. Only this session's own agent saves appear on SOFT (as fragments). |
| B3 one revision-qualified text/mural manifest | OpenCode and Pi read the mural pool in the same snapshot as the fold's m[0] memories, resolve the mural from that pool, and record cue ids in `memory_applied_rows`. A SOFT never resolves a mural (the frozen image replays). |
| B4 search returns current prose "with revision and pending-head-adoption status" | Unlabelled current text (operator ruling 3). |
| Writer enumeration (all writers routed through the applier) | Routed: OpenCode and Pi agent tools; OpenCode and Pi curate (proposals); dreamer saves (no fragment); verify update and archive and expiry archive (shared TS dreamer code, used by both OpenCode and Pi); the Rust `memory.set_verification` update and archive; historian revision commit (still disabled by `MEMORY_PROJECTION_READY = false`; when enabled it writes no log row). Retrospective learnings insert directly as `dreamer` rows with no log row or fragment; they cannot reach a SOFT, which reads no memory rows, and appear at the next HARD fold. They are model-written new rules that pass text gates (no raw quotes, dates, frustration markers or near-transcription) rather than grounded evidence, so ruling 4 could make them proposals later; this slice leaves them as inserts. Dashboard writers (Tauri; status, category and content edits, undo) stay in slice 11: content edits write mutation-log rows that no SOFT reads, and status/category edits still bump the eager workspace epoch. Rust's own agent merge/update/archive paths still write log rows that Rust SOFT does not read. |
| Dreamer save provenance | An `agent_save` with `sourceType: "dreamer"` keeps `source_type = 'dreamer'` and records no fragment; before, the applier stamped every save `agent` and recorded a fragment for the dreamer's own child session. |
| Rust applied projection | Read gate only (operator ruling). `compose_soft_m1` replays the memory blocks of the m1 body being served and reads no memory rows or mutation log; the row renderer `compose_m1_from_store` has no production caller (a HARD resets m1 to the placeholder). Agent fragments land in S4; `rust_soft_renders_no_agent_fragments_yet` pins the gap. The memory watermarks still feed the m1 revision digest, so a memory change opens one execute-band SOFT (which now renders unchanged memory bytes and records the revision even when m1 stays empty). |

## Tests

Shared regressions (`packages/plugin/src/shared/memory-projection-fixtures.test.ts`),
registered for OpenCode (`hooks/magic-context/memory-projection.test.ts`) and Pi
(`pi-plugin/src/memory-projection-pi.test.ts`):

- `SOFT and defer passes load no memory rows and no mutation log` — every statement
  loading `memories` or `memory_mutation_log` rows throws while the gate is on; the
  SOFT still renders the agent save and the defer replays it; a HARD fold under the
  same gate throws (positive control).
- `one session's HARD fold and agent edit leave another session's SOFT bytes unchanged`.
- `an over-allowance agent edit appends a stale marker and keeps the shown correction`.
- `a genuine HARD trigger shows automated memory changes held back on SOFT` (idle TTL).
- `external_repair_still_recuts` (project memory epoch bump still folds).
- `soft_keeps_admitted_membership_and_revisions`.
- `pending_lifecycle_cannot_manufacture_pressure_hard`.
- `current_revision_search_survives_old_prompt_exclusion`.
- `a pre-projection cached pair replays its memory bytes and appends only new fragments`.

TS only: `cue_visibility_does_not_hide_full_text`, `retired_rows_are_history_only`,
`dreamer saves record no agent fragment; agent saves do`
(`memory/applied-projection.test.ts`), `writes an automated dreamer row with no
mutation-log row and no agent fragment` (retrospective learnings), and the verify and
expiry tests (`dreamer/verify.test.ts`, `dreamer/task-executor.test.ts`; Pi runs the same
dreamer code). Pi: `routes primary write, update, merge and archive through the shared
applier`, `routes dreamer update, merge and archive to proposals and writes no log row
or fragment`, `resolves the mural from the fold's captured pool, not live rows`. Rust:
`verification_and_mapping_facades_are_fenced_hash_guarded_and_idempotent` (verify
update moves no m1 signal, writes history and no log row; archive is a `verify`
proposal and the row stays live), `soft_m1_reads_no_memory_rows_or_mutation_log`
(tables renamed away; the row renderer fails as the positive control),
`rust_soft_renders_no_agent_fragments_yet`, and
`public_memory_{update,insert}_waits_for_hard_and_a_genuine_hard_shows_it`.

Not built: `marker_probe_and_commit_ignore_pending_lifecycle` (Rust marker probe;
S4), `dashboard_approval_does_not_bump_epoch` (dashboard; slice 11),
`privacy_revocation_still_invalidates` (no TS privacy-revocation path exists to
exercise; the workspace-fingerprint HARD is unchanged), `concurrent_write_cannot_split_text_and_mural_manifest`
and `cue_only_correction_overrides_frozen_image` (need a rendered mural).

### Witness tests of the three earlier reviews

The witnesses were written against the deleted recompute API, so they cannot run
as written. Status of each:

| Witness | Status |
| --- | --- |
| `deferred_archive_keeps_applied_delta_until_hard`, `unadmitted_deferred_revision_does_not_leak_as_new_memory`, `live_successor_cannot_force_a_deferred_target_revision`, `live_correction_pressure_cannot_authorize_deferred_adoption`, `live_update_before_deferred_update_is_not_rendered_as_removal`, `merge_with_deferred_source_cannot_admit_dependent_successor`, `dependent_supersede_keeps_admitted_source_when_successor_is_deferred`, `oversized_successor_group_keeps_admitted_source_until_hard`, `deferred_archive_then_live_restore_and_edit_waits_until_hard`, `r3_merge_with_deferred_source_is_atomic_*`, `r3_deferred_edit_between_softs_keeps_baseline_and_delta_live_revisions`, `r3_long_cyclic_dependency_closure_withholds_every_touched_row`, `r3_all_live_supersession_cycle_terminates_without_forcing_a_replacement` | Not applicable: no deferred class, no SOFT row or log read, no forced successors. Covered by the gate, two-session, `soft_keeps_admitted…` and genuine-HARD tests. |
| `new_admission_priority_uses_creation_importance_not_current_importance`, `older_low_importance_waiting_admission_precedes_newer_high_importance`, `new_admission_near_size_threshold_withholds_correction_until_hard` | Not applicable: SOFT admits no new memories from rows. |
| `live_delta_correction_count_cannot_originate_a_hard_fold`, `correction_free_backstop_survives_outer_wrapper_threshold`, `withheld_update_and_forty_one_small_corrections_are_folded_at_next_hard` | Covered by `pending_lifecycle_cannot_manufacture_pressure_hard` (TS, Pi) and the restated Rust `memory_corrections_make_no_pressure_and_a_hard_keeps_ready_notes_out_of_m1`. |
| `correction_record_cap_withholds_a_multi_target_merge_whole`, `r3_null_id_multi_source_merge_is_not_partially_admitted_at_record_cap` | Mechanism gone: one agent operation is one fragment, rendered whole or as one marker. |
| `r3_oversized_edit_keeps_last_applied_correction` | Passes as `an over-allowance agent edit appends a stale marker and keeps the shown correction`. |
| `r3_upgrade_preserves_existing_null_id_correction_without_false_marker`, `upgrade_without_projection_replays_then_reorders_only_on_independent_soft` | Pass as `a pre-projection cached pair replays its memory bytes and appends only new fragments`. |
| `r3_stale_marker_replays_once_within_allowance_and_disappears_at_hard` | Markers replay on defer (overflow test) and a HARD fold resets the tuple; the "disappears at HARD" half is not asserted by a dedicated test. |
| `failed_projection_extension_rolls_back_cached_bytes_and_manifest` | The SOFT projection write shares the cached-pair transaction; the existing `rolls back refreshed bytes and their manifest together` (TS, Pi) passes. |
| `original_ctx_search_fixture_defers_replacement_without_hiding_search`, `upgrade_without_projection_keeps_edited_memory_searchable`, `upgrade_visibility_recognizes_complete_multiline_memory`, `fresh_contention_fallback_visibility_matches_actually_served_revision`, `fresh_recovery_visibility_recognizes_complete_multiline_memory` | Search follows current text (`current_revision_search_survives_old_prompt_exclusion`). The legacy and fresh-recovery visibility paths (`readServedTextVisibleMemoryIds`, `recordServedRecoveryTexts`) are kept but have no dedicated test in this slice. |
