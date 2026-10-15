# Independent review: Claude Code generations, native views and hook cuts

Reviewed base: `7226c42d77baa6b60064bc728031fe8d03bf0e00`, including
`8e84bcf2` (generation-scoped identities and immutable plans), `f4cba11e`
(frozen native views and bounded reads) and `7226c42d` (replacement-head and
retained-tail mapping for native hooks).
This review changes no runtime implementation or capability fixture. It adds
four executable witnesses in a separate test-only module and this report.
Source citations below use the reviewed base; witness citations use the review commit.

## Findings, ranked

### P1 — an already-admitted old-generation step can commit and publish after route rebind

**Witness:**
`providers::cc_native_review_tests::review_witness_old_generation_step_commits_after_rebind`
(`crates/mc-module/src/providers/cc_native_review_tests.rs:206`).
The test passes because it demonstrates the defect, not because the stale call is safe.

The witness uses the real `dispatch_value` route through `cc::call`. It queues a
step for generation A at the admission lock, then queues a competing operation.
The fair mutex makes that competing operation acquire the lock between native
plan admission and `provider_step`'s second acquisition. While the old step is
pending, the test rebinds channel 7, changes the native pins to generation B,
and completes B's declare/Setup. Releasing A's lock still produces a
`compaction_message` response and writes A's original message. B's ledger stays
empty: this is a stale-operation/publication fence failure, **not** a generation
key collision. No sleeps, LLM calls or live stores are involved.

The current fence checks the connection incarnation only in
`admit_native_plan`, after its awaits and before installing the plan
(`crates/mc-module/src/providers/native_plan.rs:169-194`). Dispatch passes the
captured binding onward (`crates/mc-module/src/providers/mod.rs:304-315`).
`provider_step` subsequently awaits store access and the serial lock, then calls
`host_step` without validating that the binding is still current
(`crates/mc-module/src/providers/compaction.rs:1783-1797`). `host_step` commits
messages and later saves the view/answer
(`crates/mc-module/src/providers/compaction.rs:1348-1374,1563-1599`).
Rebind assigns a new incarnation and clears the route plan without invalidating
queued provider work (`crates/mc-module/src/lib.rs:5096-5119`).

**Required follow-up:** fence the final write/publication against the current
route incarnation and generation, coordinating that fence with rebind rather
than adding a check that can itself race. Audit the analogous post-admission
awaits in `transform.hook` and `compaction.view.read`. Their similar structure
is a code argument, not an additional executed witness. The existing rebind
regression covers calls initiated *after* rebind, not this in-flight interleaving.
Capability advertisement/selection remains held; that limits exposure but does
not establish the required late-write guarantee.

No additional P0, P2 or P3 correctness finding was established.

## Contract checks and limits

1. **Endpoint and selection:** the negotiated missing-endpoint test still returns
   terminal `native_endpoint_missing`; the selection-upgrade test returns
   `native_selection_frozen`. The unnegotiated no-cut path still bypasses
   `FrozenView` publication (`native_view.rs:16-34`) and the existing raw-byte
   provider/codec checks passed. No serializer or product source was changed.
2. **Hook mapping:** the new equal-message witness checks literal raw bytes and
   distinct ordered `left#0` / `right#0` handles, and rejects swap/removal even
   when the two messages have identical bytes. The edit witness goes through
   codec rendering of a real text edit before requiring
   `native_hook_cut_unrepresentable`, with no cut reference installed. Retained
   signed thinking whose binding would change is refused by the independent
   codec prerequisite (`signed_prefix_edit`) before a frozen head can be built.
   Existing nested-tool-result and explicit-empty-tail tests passed. No cut with
   a broken signed prefix was served. This is not a live Claude Code hook test.
3. **Isolation:** generation-key/lock/message/view persistence, route rebind,
   actual store reopen and sibling-session read refusals passed their existing
   tests. The in-flight publication exception is the P1 above.
4. **Bounded reads:** the existing UTF-8/digest/version/cursor page test passed;
   it verifies rejoined bytes and each escaped reply's strict envelope bound.
   The reader checks current lineage before validating a stored view
   (`native_view.rs:253-269`) and looks it up through the generation/session key.
   Frozen identity also binds the key and range (`native_view.rs:36-60`).
5. **Migration:** the v69 SQL-seeded fixture with a legacy conversation,
   lineage, raw message BLOB, view and policy summary upgrades and reopens
   successfully. Migration 70 is additive in data/identity behavior, although
   it rebuilds the parent table and restores its triggers. The SQL depends on
   the prior provider schema/trigger definitions, **not on ordinal 70**: `_70`
   is a temporary table name, not a schema-version predicate. Registration in
   `mc-store/src/lib.rs:3275-3282`, the latest-version inventory, filename and
   tests must be consistently renumbered if the train resolves the other
   branch's migration collision. `store_070_provider_policy_revision.sql` is
   absent here; this review did not invent a shim or resolve that collision.
   There is no in-place downgrade. Store-ahead opens refuse by name before row
   access (`mc-store/src/lib.rs:8164-8182`); the refusal/no-write and older-store
   forward-migration tests passed. Rollback is documented as the previous
   binary plus the paired database backup, not just a binary downgrade
   (`docs/architecture/rust-module.md:55-65`,
   `docs/architecture/single-store-b2-offline.md:148-166`). Ordinary commons
   migrations are transactionally atomic per migration, not across the entire
   migration chain.
6. **Other profiles:** 23 provider conformance tests, 8 OpenCode codec tests and
   all 13 Broca/joint-fixture integration tests passed, including fixture digests
   and byte-identical encoding. The broad provider run also passed the Broca
   golden and OpenCode overlay differential checks.
7. **Actual capture:** SHA-256
   `ca6d004324b7d758d5fe7e17d6e637d468c873d7a4a4dbc7116e26e4c7cc314c`;
   the exact codec capture test ran **1 test, 1 passed, 0 skipped** on Linux.
   A temporary non-ignored `tmp-capture/14047-req-body` was copied into this
   worktree with mode 0600. Before the run, `git status --short --untracked-files=all`
   showed only `?? tmp-capture/14047-req-body`; `git ls-files` returned nothing
   for that path and `git check-ignore` returned 1. It was deleted immediately
   afterward; status was empty and `git ls-files` remained empty before any
   commit. No capture bytes or capture file are included in the review.
   The capture test strips transport cache markers by byte splice before codec
   round trip; this is not proof of native-hook publication or provider dispatch.

## Verification

All Cargo commands ran with `runon: linux,4c` and `-j 4`.
Versions: rustc `1.99.0 (b940084d7 2026-09-28)`, cargo
`1.99.0 (5f94df478 2026-08-27)`, rustfmt
`1.10.0-stable (b940084d7e 2026-09-28)`.

| Command/check | Result |
| --- | --- |
| `MC_CC_CAPTURE="$PWD/tmp-capture/14047-req-body" cargo test -p mc-module -j 4 --lib providers::codec_claude_code::tests::real_claude_code_capture_roundtrips_actual_raw_replacement_bytes -- --exact --nocapture` | 1 passed, no skip |
| `cargo test -p mc-module -j 4 --lib providers::cc_native_review_tests:: -- --nocapture` | 4 passed, including the P1 acceptance witness |
| `cargo test -p mc-module -j 4 --lib providers::native_ -- --nocapture` | 10 passed (cuts, plans, views and pages) |
| `cargo test -p mc-module -j 4 --lib providers::tests:: -- --nocapture` | 23 passed |
| `cargo test -p mc-module -j 4 --lib providers::claude_code_tests:: -- --nocapture` | 11 passed |
| `cargo test -p mc-module -j 4 --lib providers::codec_opencode:: -- --nocapture` | 8 passed |
| `cargo test -p mc-module -j 4 --lib providers::capability_candidate:: -- --nocapture` | 3 passed, 1 existing ignored export test |
| `cargo test -p mc-module -j 4 --test broca_conformance -- --nocapture` | 13 passed, including all joint fixtures |
| `cargo test -p mc-store -j 4 migration_70_preserves_legacy_keys_payloads_views_and_reopens -- --nocapture` | 1 passed |
| `cargo test -p mc-store -j 4 a_store_one_version_ahead_is_refused_by_name_without_reading_or_writing_it -- --nocapture` | 1 passed |
| `cargo test -p mc-store -j 4 equal_and_older_stores_still_open_and_the_older_one_migrates_forward -- --nocapture` | 1 passed |
| `cargo check -p mc-module -j 4 --all-targets` | passed, all targets of the reviewed package |
| `rustfmt --check --edition 2021 --config skip_children=true crates/mc-module/src/providers/mod.rs crates/mc-module/src/providers/cc_native_review_tests.rs` | passed, 2 files |

An earlier broad `providers::` run excluding `providers::historian::` ran 199
cases: **195 passed, 1 failed, 3 ignored**. Its sole failure was the candidate
fingerprint golden because witnesses were initially placed in the source files
hashed into provider-generation identity. The witnesses were moved to their own
`#[cfg(test)]` module, preserving those files and the candidate fixture exactly.
The impacted candidate gate and all final focused gates above were rerun green;
the 26-minute differential suite was not redundantly rerun after test relocation.
The broad run's capture test reported its documented environment-variable skip;
the separate actual-capture gate above is the capture evidence. A first witness
compile had an unqualified `CkKind` test import; it was fixed before passing runs.
The editor's code-health inspection was partial: rust-analyzer could not resolve
the existing test module, now at `crates/mc-module/src/providers/cc_step_lane_witnesses.rs`;
the Linux all-target check is the authoritative type/diagnostic gate.

## Mutation controls

All three author mutation checks were **rerun**, rather than relying on the commit
messages: SQL native-pin immutability, endpoint invention, and full-view-as-head.
Two additional hook-mapping controls were run against the final review module.
Each control followed the staged-state safety procedure: stage the specific
file(s), verify empty `git diff --stat`, apply a marked mutation, capture a
nonempty stat, run the gate, restore with `git checkout -- <path> && touch <path>`,
and capture an empty stat. No mutant is committed. The exact marker was
`NON-VACUITY BREAK` in every temporary mutation.

| Control / gate | Only failing test | Passing tests in that invocation | Applied / restored unstaged stat |
| --- | --- | --- | --- |
| Author: remove `OLD.native_pins_json IS NOT NEW.native_pins_json`; `cargo test -p mc-module -j 4 --lib providers::native_plan:: -- --skip review_ --nocapture` | `native_route_plan_rebind_epoch_and_plan_drift_refuse` | `native_generations_isolate_messages_views_locks_and_survive_restart`, `native_selection_cannot_silently_upgrade_within_a_generation`, `internal_selected_bundle_freezes_full_declare_and_setup_without_publication` | `store_070_provider_generations.sql`: 1 insertion, 1 deletion / empty |
| Author: invent the endpoint from `engine.range.to`; `cargo test -p mc-module -j 4 --lib providers::native_view::tests:: -- --nocapture` | `negotiated_native_publication_requires_original_endpoint` | `frozen_native_view_preserves_actual_signed_bytes_and_rejects_scope_or_digest_drift`, `frozen_pages_rejoin_utf8_and_refuse_wrong_identity_digest_and_cursor` | `native_view.rs`: 5 insertions, 8 deletions / empty |
| Author: use all raw messages as the cut head; `cargo test -p mc-module -j 4 --lib providers::native_cut::tests:: -- --skip review_ --nocapture` | `hook_cut_head_excludes_retained_parts_and_nested_children_keep_top_level_handles` | `hook_cut_all_history_has_explicit_empty_tail_and_replay_references_are_version_scoped`, `hook_cut_changed_or_removed_native_tail_refuses_without_snapping` | `native_cut.rs`: 2 insertions, 1 deletion / empty |
| New: remove the retained identity/ordinal comparison in `attach`; `cargo test -p mc-module -j 4 --lib providers::cc_native_review_tests:: -- --nocapture` | `review_hook_cut_identical_messages_keep_distinct_ordered_handles` | `review_hook_cut_rendered_tail_edit_refuses_before_reference_publication`, `review_hook_cut_retained_signed_thinking_rejects_changed_binding`, `review_witness_old_generation_step_commits_after_rebind` | `native_cut.rs`: 2 insertions, 2 deletions / empty |
| New: remove equality with the original rendered tail bytes; same review-module gate | `review_hook_cut_rendered_tail_edit_refuses_before_reference_publication` | `review_hook_cut_identical_messages_keep_distinct_ordered_handles`, `review_hook_cut_retained_signed_thinking_rejects_changed_binding`, `review_witness_old_generation_step_commits_after_rebind` | `native_cut.rs`: 1 insertion, 1 deletion / empty |

The new identity mutation failed the assertion that a refused cut must not have
an attached replacement-head reference:
the later cut validator still rejected the swap, but the missing early identity
check allowed an attached reference to be constructed first. That red result
must not be described as an actually served swapped tail. The byte-comparison
control failed the exact `native_hook_cut_unrepresentable` refusal assertion.
The endpoint control still refused downstream, with the wrong provider code
(`native_hook_cut_unrepresentable` instead of `native_endpoint_missing`). The
full-head control was caught by the cut validator at attachment. These controls
prove the named tests exercise the relevant conditions; they are not findings
that the unmutated implementation serves those malformed cuts.
