# Claude Code stored forms and setup lineages

## Scope

Both behavior changes are limited to the attested Claude Code / `claude-code-anthropic` host lane. OpenCode host setup and runner-backed setup retain their existing behavior. Broca's runner path is unchanged. Two store APIs support targeted message lookup and explicitly starting a separate root; only the Claude Code handler calls the new root-admission API. Ordinary step/hook admission still rejects undeclared additional roots.

No wire types, dependency pins, contract files, migrations, ARCHITECTURE.md, or STRUCTURE.md changed. Tests use throwaway stores, never live stores. This report directory was absent at the base and was created for the requested report.

## Reproduction

Real-handler regressions exercised both directions of the content form change:

- The original envelope check rejected a `message`/`raw_message` pair whose only difference was scalar content versus one text block (`invalid_params`, field `raw_message`). Both new known-MID direction tests were red before the implementation.
- When both fields carried the current form, resending a covered MID rejected immutable message admission (`invalid_params`, field `messages`). `cc_covered_form_flip_keeps_frozen_prefix_and_does_not_emit_unfrozen_tail` was red before the implementation.
- An unrelated second setup returned the old compaction ID and applied replacement. The setup regression was red on that ID reuse. Bypassing the new reset subsequently reproduced the next real step's `invalid_params`, field `lineage_id`, in `cc_setup_new_root_next_step_proceeds_without_old_view`.

## Message form behavior

`codec_claude_code::text_form_flip` accepts only a string against an array containing exactly one object with exactly `type: "text"` and `text` equal to the string. All fields outside `content`, including `role`, must match. Arrays with additional blocks or keys, changed text, changed roles, changed top-level fields, and same-form raw-byte reserialization remain conflicts. A form flip also requires all raw bytes outside the `content` value to remain identical; reordering or respacing the enclosing message does not become permissible merely because its content form changed.

The codec validates raw JSON with duplicate-key and transport-marker checks intact. Its parsed envelope follows the supplied raw bytes, even when the separate parsed `message` uses the other equivalent form. Before store admission, under the provider serialization lock, steps and hooks look up the stored MID/ordinal and substitute the entire first-stored envelope only for the exact form equivalence. The immutable store insertion guard is unchanged. Lookup follows declared ancestry and does not load the whole message log for a sparse resend.

CK decoding already projects either form into the same text block; the new fingerprint regression verifies identical `identity_by_mid` while rendering each input's original raw bytes. Message-level raw provenance is not normalized into a new wire form.

Coverage includes an in-array `role: system` message, both first-stored forms, repeated flips across steps and hooks, parsed/raw form disagreement, non-equivalent changes on steps and hooks, and a covered first user message. Frozen full and cut-prefix reads, plus repeated setup, continue to serve the first-stored bytes.

For the tail, the first-step frozen prefix contains only the covered message and has no retained-tail entries. Its inline replacement and view reads contain no unfrozen tail. Flipping the live tail while replaying that prefix remains a noop. MC does not re-emit that unfrozen tail; the gateway continues forwarding its current form. A later full view may include tail bytes only after freezing them; the existing full/cut view tests cover that distinction.

## Setup decision and contract basis

The requested contract was read from:

`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cortexkit-role-compaction-provider-0.2.0/CONTRACT.md`

Relevant pinned text:

- §4, lines 139–142: “a provider answers Setup for a session it has seen before, and its answer is well formed whatever it answered last time”. Lines 155–159 describe the usual initial empty range `{from: 0, to: 0}` and an empty replacement for a provider with no head.
- §6, lines 216–225: “Ordinals, the cursor and every range are in this lineage”; `descends_from` inherits only the prefix through the declared ordinal, which the provider must hold, and “It never guesses ancestry or history.”
- §6, lines 276–279: “Without `descends_from`, the provider's state for the old lineage says nothing about the new one. With it, only the declared prefix is inherited”.
- §8, lines 343–350: versions rise for every CompactionMessage of the session; the compaction ID is stable for one logical compaction lineage and a new ID is minted when a new one starts.

The chosen behavior is a new logical compaction for an unrelated Claude Code setup: new `compaction_id`, identity initial view, and a version above the session's existing high-water mark. The same reset is necessary if a descendant's cut does not contain the applied range. A declared descendant whose held prefix contains the applied range keeps the ID and exact replacement, while publishing a newly versioned frozen reference bound to the new lineage. Missing declared prefix returns `history_unreadable` rather than guessing.

The native conversation's engine namespace is immutable (the existing store trigger enforces this). Therefore setup uses the existing CAS-protected `reset_session_for_recomp` to clear cached heads, compartments, identity rows, and engine historian metadata without rotating that namespace. Provider counters and historian model-chain state are reset too. Explicit new-root admission archives old pending/live hook answers and their policy/drop state while retaining old message and frozen-view rows. Native view retrieval remains active-lineage scoped, so an old reference is refused on the new lineage even though its immutable stored bytes remain unchanged.

The next step on the unrelated root now produces a view containing only the new root's original. The descendant regression also resends an inherited MID in the opposite form and proceeds without changing stored bytes. Same-lineage transport setup still leaves the engine's frozen state untouched.

## Verification

All authoritative gates ran on the remote Linux runner with eight vCPUs (`runon: linux,8c`).

- Cargo: `cargo 1.99.0 (5f94df478 2026-08-27)`.
- `cargo fmt --all -- --check`: passed; `rustfmt 1.10.0-stable (b940084d7e 2026-09-28)`. Local `cargo fmt --all` applied formatting; the gate ran on Linux.
- `cargo clippy -p mc-module -p mc-store --all-targets -- -D warnings`: passed for both changed packages; `clippy 0.1.99 (b940084d7e 2026-09-28)`.
- Final impacted gates after tightening byte equality outside `content`: Claude Code handler suite 22 passed; codec suite 10 passed in the harness, with the private real-capture case explicitly skipped because `MC_CC_CAPTURE` was unavailable. No private capture or live-store access was attempted. All seven new regressions were also included in the earlier complete library run.
- `cargo test -p mc-module`: library 2,119 passed, 33 ignored; preceding integration targets, including default Broca (13 tests), passed. The command then encountered four environmental failures in `tests/real_daemon.rs:1101`: `fs::canonicalize(workspace.parent().join("subconscious"))` returned ENOENT. The remote worktree has no sibling `subconscious` checkout. Failing names: `daemon_artifacts_are_built_and_copied_once`, `hostless_store_init_first_transform_through_real_daemon`, `mc_transform_spine_through_real_daemon`, `mc_pipe_only_supervision_through_real_daemon`. One other real-daemon test passed and two were ignored. Remaining integration targets after that failure were not reached. No compatibility shim or cross-checkout build was introduced.
- The complete library run passed OpenCode's `r2_review_720_pass_differential_with_new_seeds_and_real_reduce` (720 passes / 46,980 comparisons) and `r2_published_hard_failures_and_new_seeded_switch_controls_match_full_engine` (48-pass HARD companion / 113 new-message comparisons).
- Final frozen-view/plan/cut regression subset: `cargo test -p mc-module --lib providers::native_` — 10 passed. Final candidate subset: `cargo test -p mc-module --lib providers::capability_candidate::` — 3 passed, 1 exporter ignored; the exporter had already been run explicitly. Restored non-equivalent-change test passed separately after the final mutation.
- `cargo test -p mc-store --lib provider_log`: 30 passed, 1 ignored.
- `cargo test -p mc-module --test broca_conformance --features drive-fault`: 14 passed, including executable crash/fence and committed byte-fixture controls. No Broca fixture changed.
- The complete package run preceded the final tightening of raw-byte equality outside `content`; only the affected Claude Code and codec gates were rerun afterward. Scoped AFT inspection was provisional: it could not fingerprint Rust inputs and its checkout call graph was not ready. Cargo compilation and strict clippy provide the authoritative type/diagnostic checks.
- Sidekick reviewed changed code comments; unclear terminology was replaced with explicit field names and signature/lineage reasons.

## Mutation observations

Every mutation used the safe indexed-state sequence: stage the live files; empty `git diff --stat`; apply an intentional temporary guard bypass to prove a test detects it; capture a nonempty diff; run exact named tests; restore with `git checkout -- <path> && touch <path>`; capture an empty diff. No mutation is present in the delivered tree. Each selected red test was the sole failing test; the separately selected control passed.

| Control | Sole red test (`providers::claude_code_tests::` prefix) | Separate passing control | Diff while mutated / after restore |
|---|---|---|---|
| Disable stored-form substitution in `codec_claude_code.rs` | `cc_covered_form_flip_keeps_frozen_prefix_and_does_not_emit_unfrozen_tail` (immutable admission refused field `messages`) | `cc_form_flip_identity_fingerprints_match_without_rewriting_raw` | 1 file, +2/−1 / empty |
| Accept extra text-block keys in `codec_claude_code.rs` | `cc_known_mid_non_equivalent_changes_remain_conflicts` (unexpected successful noop) | `cc_form_flip_identity_fingerprints_match_without_rewriting_raw` | 1 file, +2/−1 / empty |
| Disable unrelated applied-prefix reset in `compaction.rs` | `cc_setup_unrelated_lineage_starts_fresh_but_descendant_keeps_applied_view` (old ID reused) | `cc_covered_form_flip_keeps_frozen_prefix_and_does_not_emit_unfrozen_tail` | 1 file, +2/−1 / empty |
| Ignore raw bytes outside `content` in `codec_claude_code.rs` | `cc_known_mid_non_equivalent_changes_remain_conflicts` (unexpected successful noop after enclosing member reordering) | `cc_form_flip_identity_fingerprints_match_without_rewriting_raw` | 1 file, +2/−1 / empty |
| Bypass reset for the direct next-step witness in `compaction.rs` | `cc_setup_new_root_next_step_proceeds_without_old_view` (field `lineage_id` refused) | `cc_form_flip_identity_fingerprints_match_without_rewriting_raw` | 1 file, +2/−1 / empty |

## Candidate bundle

The existing exporter was invoked as `cargo test -p mc-module --lib providers::capability_candidate::print_candidate_bundle -- --exact --ignored --nocapture`, selecting only the opt-in exporter test and printing its output. Its output refreshed `crates/mc-module/testdata/codec/claude-code-capability-candidate.json`; the final pinned-byte gate was rerun separately.

- `profile_generation`: `codec-sha256:d560edb95f39c7ca161560d8d954a19425efa77da56d70290cade8b5f26e58a4`.
- `provider_generation`: `key-sha256:682e8553d522a6b87975b2e1329b79ba5c211be067f43feb2513e2d8e1706b59` (unchanged: records, native plan, view, and cut sources did not change).
- Exported canonical bundle SHA-256: `1f34f0c73f15741d354627d0b3e48cd0726a79bcc221742304d03b7f6a24eb4b`.
