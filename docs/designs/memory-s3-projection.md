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
2. **The memory pair is a pure function of the session's shown state plus its own
   fragments.** On a busting SOFT and on a defer, nothing that decides, renders or
   commits the m[0]/m[1] pair (the materialization decision, the m[1] composer, the
   mural and the cache commit) reads memory rows, the mutation log, or their `MAX(id)`
   heads, in TS OpenCode 1/2, Pi and Rust. A SOFT replays the memory blocks the HARD
   fold rendered byte for byte and appends this session's own agent fragments (TS and
   Pi). New compartments and the user-profile delta render as before.
3. **A defer replays stored bytes.** Unchanged.
3a. **Two named memory readers sit outside the pair.** Explicit `ctx_search`, and
   automatic search. Automatic search reads current memory only while it computes a
   new hint for a new user message (its visibility check is resolved lazily, at that
   point); the hint is persisted and replayed on every later pass for that message,
   which reads no memory. A hint is attached to the user message in the tail and never
   changes m[0]/m[1]. The Rust hint producer (`maybe_decide_live_user_hint`) is the same
   exception.
4. **Automated writers apply directly** to canonical rows once their deterministic
   gates pass, with `memory_history` for undo, and write no mutation-log row and no
   fragment. They reach a prompt only at that session's next natural HARD fold.
   - dreamer verify `update`: applies directly (`recordAutomatedMemoryEdit`).
   - dreamer expiry archive: applies directly (its `expires_at` was declared when
     the memory was written). Through the module it calls `memory.expire`, which
     rechecks ownership, active status and the declared expiry inside the transaction
     and archives with history and no log row; it is not the agent archive port.
    - dreamer verify `archive`: applies directly with undo history, no log row and
      no fragment.
    - curate: update, merge and archive apply directly in OpenCode and Pi. Module-owned
      rows go through `memory.curate`, with revision checks and no TypeScript fallback.
   - dreamer saves (a curate `write`) and retrospective learnings: inserted with
     `source_type = 'dreamer'`, no log row and no fragment.
   - The Rust module's `memory.set_verification` follows the same rules: a gated
      `update` and `archive` apply with history, a new revision and no log row.
    - historian turn two: gated edits and consolidations may apply; explicit `retire`
      and `promote_rule` decisions are dropped and logged. There is no proposal writer.
      The proposal tables shipped in schema version 99 remain unchanged for database compatibility.
5. **Agent `ctx_memory` edits apply immediately** through the shared applier
   (save, update, merge, archive) and record one immutable, pre-rendered fragment
   (`memory_agent_fragments`) for the session that made them. That session's next
   busting SOFT appends the fragment to m[1]. Every fragment leaves a visible trace:
   - its full lines when they fit the correction allowance (25% of the memory budget)
     minus a marker reserve, at most 40 full lines, and the refold headroom;
   - otherwise one short `<stale-memory … read-with="ctx_search"/>` marker, paid from a
     fixed marker reserve inside the allowance (200 tokens, or half the allowance when
     that is smaller) that full fragments never use;
   - once the reserve is spent, it joins one aggregate
     `<more-memory-edits count="N" ids="…" note="N more memory edits apply at the next
     rebuild; …"/>` line at the end, which lists ids up to 120 characters. Its bytes
     change as N grows (an m[1] change on a busting SOFT, like any append).

   Fragments and markers already shown never move or shrink. A merge shows the
   survivor's text unless this session's served manifest or committed fragments
   already show exactly that text (new, changed or unchanged survivor alike). An
   agent save that matches an existing memory this session does not show also gets a
   fragment. Pi's primary-agent paths use the same applier.
6. **`ctx_search` returns current database text, unlabelled.** A hit is hidden only
   while its *current* text is fully visible in the served pair (m[0] text, a fold
   m[1] addition, or a full agent fragment). A mural cue or a stale marker never
   hides a hit; an archived row is never "visible". Explicit-id search no longer
   returns archived or superseded rows.
7. **Memory corrections never authorize a HARD fold.** The refold backstop measures
   m[1] without its `<memory-updates>` block, and the old "more than 40 corrections"
   trigger is gone (TS and Pi). In Rust the SOFT correction count is always 0.

### Memory aggregates that remain, and the decision each feeds

All of these are read by a HARD fold only; none is read on a SOFT or defer pass.

| Aggregate | Host | Decision it feeds |
| --- | --- | --- |
| `MAX(memories.id)` in the fold's marker read | TS, Pi | The fold's `maxMemoryId` watermark, persisted with the cached pair; the fold's own m[1] admits rows above it (read under its writer). |
| `MAX(memory_mutation_log.id)` in the fold's marker read and under its writer | TS, Pi | The fold's mutation cursor, and the fold's stale check: a log row written between the fold's read and its writer retries the fold (contention). |
| Memory revision of the m0 composition (`max_memory_id`, mutation cursor) and its commit fence | Rust | Recorded with a HARD fold (including a pressure refold), and checked at that fold's commit. |

Removed from non-HARD passes: the memory and log heads in the TS marker-change probe
and uncached marker read used by the materialization decision, the same reads in Pi's
decision, and in Rust the heads in `load_m1_revision_snapshot`, their slots in the m1
revision digest (now constant zeros) and the memory fence on SOFT commits. One-time
upgrade cost in Rust: a session whose stored digest was taken with nonzero memory heads
sees one pending m1 revision after upgrading, so at most one execute-band SOFT
re-records it (the memory bytes it serves are unchanged).

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
| Writer enumeration (all writers routed through the applier) | Routed: OpenCode and Pi agent tools; OpenCode and Pi curate (proposals); dreamer saves (no fragment); verify update and archive and expiry archive (shared TS dreamer code, used by both OpenCode and Pi); the Rust `memory.set_verification` update and archive; historian revision commit (turn two's `applyHistorianRevision`, reachable only on an enabled historian lane, and every production lane is dormant; it writes history and no log row). Retrospective learnings insert directly as `dreamer` rows with no log row or fragment; they cannot reach a SOFT, which reads no memory rows, and appear at the next HARD fold. They are model-written new rules that pass text gates (no raw quotes, dates, frustration markers or near-transcription) rather than grounded evidence, so ruling 4 could make them proposals later; this slice leaves them as inserts. Dashboard writers (Tauri; status, category and content edits, undo) stay in slice 11: content edits write mutation-log rows that no SOFT reads, and status/category edits still bump the eager workspace epoch. Rust's own agent merge/update/archive paths still write log rows that Rust SOFT does not read. |
| Dreamer save provenance | An `agent_save` with `sourceType: "dreamer"` keeps `source_type = 'dreamer'` and records no fragment; before, the applier stamped every save `agent` and recorded a fragment for the dreamer's own child session. |
| Rust applied projection | Read gate only (operator ruling). `compose_soft_m1` replays the memory blocks of the m1 body being served and reads no memory rows or mutation log; the row renderer `compose_m1_from_store` has no production caller (a HARD resets m1 to the placeholder). Agent fragments land in S4; `rust_soft_renders_no_agent_fragments_yet` pins the gap. The memory and mutation-log heads are no longer read for the m1 revision digest (their slots are constant zeros), so a memory change opens no execute-band SOFT; a SOFT records the revision even when m1 stays empty. |

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

### Round-4 review witnesses (`docs/reports/memory-s3-cache-review-r4.md`)

Each finding's witness is now a permanent package test, and each fix was shown to
turn its test red when removed:

| Finding | Permanent test(s) | Status |
| --- | --- | --- |
| P1 automatic search reads canonical memory | `a defer/busting postprocess pass reads memory only when automatic search computes a new hint` (OpenCode), `a Pi defer/busting context pass …` (Pi), Rust `automatic_hint_producer_is_a_named_memory_reader` | Contract narrowed by ruling: replaying passes read nothing; computing a new hint is the named reader. |
| P1 module-routed expiry used the agent archive | Rust `module_routed_expiry_writes_history_and_no_mutation_log`; `expire-memories.test.ts` asserts the `memory.expire` call | Fixed. |
| P2 watermark aggregates on every pass | Shared `SOFT and defer passes read no memory rows, mutation log or their heads` (aggregates now count, TS and Pi); Rust `soft_reads_no_memory_rows_or_watermark`, `soft_plus_reads_no_memory_rows_or_watermark`, `soft_reads_no_mutation_log_rows_or_watermark`, `soft_plus_reads_no_mutation_log_rows_or_watermark`, `memory_only_change_opens_no_execute_band_soft` | Fixed. |
| P2 full allowance omitted the marker | Shared `a full allowance still traces every rejected edit and never shrinks shown fragments` | Fixed: marker reserve plus aggregate line. The probe's literal expectation (`<stale-memory ids="2"`) stays red by ruling, because by then the reserve is spent and the edit is traced in the aggregate line instead. |
| P2 merge into an unshown survivor | Shared `a merge into an unshown existing survivor shows the survivor text`, plus the control `a merge into a shown survivor adds only the supersession` | Fixed. |
| P3 explicit save of an unshown duplicate | Shared `an explicit agent save of an unshown duplicate reaches its session` | Fixed. |
| Byte stability | Rust `foreign_hards_and_row_churn_preserve_the_served_pair_over_150_rounds`; the probe's 180-round TS/Pi replay, v98-shaped cache, schema and multi-row archive controls | Pass. |

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
