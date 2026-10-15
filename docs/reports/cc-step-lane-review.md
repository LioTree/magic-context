# Claude Code step-lane correctness review

## Disposition

**Do not use this implementation as the byte-safe replacement for Thalamus's existing whole-message-array `transform` RPC yet.** Its new per-step provider path must preserve raw message bytes, reject transport cache markers, and never change any byte before retained signed thinking. Three synthetic duplicate-key tests fail those requirements, including an accepted byte edit before retained signed thinking. Ordinary noncanonical inputs and the captured request `14047-req-body` pass the exercised paths. This is a report-only review: no provider implementation, dependency pin, live store, architecture document or fixture baseline is changed.

Reviewed magic-context `3549c4340ef37066f6690fb466824ac752ba0cbb..67a49551e3c6729bc3496b935b67de7cf498c8c5` (ten provider files and `crates/mc-module/src/lib.rs`). The author branch is `alfonso/task/bg_b9fb561a42039b20-claude-code-step-lane-codec-m1-admission-m2-cach`. The M1–M8 design answers (`docs/designs/cc-step-contract-answers.md`) were supplied from master as a repository-free export. The two role crates and test vectors were supplied at commons `review/claude-code-step-lane`, `2bba392c`, in this isolated worktree. The commons branch and commit do not resolve in magic-context. All Rust execution used the remote Linux runner with four requested vCPUs (`linux,4c`) and four Cargo jobs (`-j 4`); its execution queue never rejected a job as full. Stores were temporary SQLite test stores only.

In this report, M1 means native-byte codec safety; M2 means attested host admission; M4 means trusted context geometry/protection evidence; M5 means cache policy/head identity; M7 means terminal refusal mapping; and M8 means capability negotiation/bootstrap/generation scope. A witness is a reproducible test: normal witnesses check preservation, while the three explicitly ignored duplicate-key witnesses demonstrate defects by failing their contract assertions.

## Findings with executable witnesses

The three tests below are deliberately `#[ignore]` in the normal review suite. Run them with `--ignored` to reproduce the normative assertions failing on the reviewed implementation. They are not mutations and do not change production code. Their full outputs are in `cc-step-lane-evidence/duplicate-counterexamples.{stdout,stderr}.txt`.

### 1. High: duplicate `content` lets the signed-prefix check accept a byte edit before effective retained thinking

`codec_claude_code.rs:283-293` and `:344-352` select the **first** raw `content` span with `.find`; decoding at `:74-78` uses serde's **last** duplicate member. The signed-prefix span is therefore not necessarily the span containing the effective signed block.

Witness: `duplicate_content_cannot_edit_bytes_before_effective_kept_thinking` in `crates/mc-module/src/providers/cc_step_lane_witnesses.rs`.

```json
{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"text","text":"before-second-content"}],"content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"text","text":"after-effective-thinking"}]}
```

Change decoded CK (CortexKit intermediate message) block 1's text to `changed`, then call `encode_view` with no authorized coverage/removal boundary. Rendering splices the first `content` array. The signed-prefix comparison only covers the first thinking block, so the encoder accepts it. The test independently asserts that the raw prefix before the **last** `content` changed, the overall raw message changed, and the parsed message stayed equal. The thinking in the effective last array remains retained, but bytes before it changed. Expected `signed_prefix_edit` does not occur. This directly violates the rule that no byte before retained signed thinking may change, even when a provider uses last-member JSON semantics.

The final commit `67a49551e3` adds a guard for opaque/non-string native thinking shapes: their retained prefixes are still compared. It correctly covers the ordinary single-content case, but does not resolve this first-span/last-value disagreement.

### 2. Medium: duplicate text field edits the shadowed value, silently losing the requested transformation

`codec_claude_code.rs:247-253,314-318` selects the first matching raw text member, whereas the decoded `CkKind::Text` represents the last one.

Witness: `duplicate_text_splice_must_change_effective_text_or_refuse`.

```json
{"role":"user","content":[{"text":"shadowed","text":"effective","type":"text"}]}
```

An authored text change to `edited` is accepted and emits:

```json
{"role":"user","content":[{"text":"edited","text":"effective","type":"text"}]}
```

The returned replacement still parses with text `effective`, not `edited`. No refusal signals that the intended edit was not applied. This is different from byte-exact replay of unchanged messages: an actual requested edit targets the wrong duplicate.

### 3. Medium: shadowed `content` bypasses transport-marker rejection

`codec_claude_code.rs:20-31,46-51` checks markers only after converting the raw object to `Value`; duplicate content has already collapsed. The raw bytes are nevertheless replayed intact.

Witness: `duplicate_content_cannot_hide_transport_marker`.

```json
{"role":"user","content":[{"type":"text","text":"shadowed","cache_control":{"type":"ephemeral"}}],"content":[{"type":"text","text":"effective"}]}
```

The sidecar parses equal to the supplied message and is admitted. A `cache_control` member on a recognized top-level native text block remains in the raw bytes. Expected `invalid_params`, `detail.field=raw_message` does not occur. Markers inside tool inputs or opaque blocks are intentionally preserved; this marker is on a recognized top-level text block instead. Last-member parsers may ignore that shadowed block, so the demonstrated consequence is a raw-marker invariant bypass, not proof that Anthropic honors the marker.

**Repair direction, not implemented here:** make native field/span selection agree with duplicate-key parsing, and audit actual raw transport positions before collapsing keys. Where structural duplicate fields make interpretation ambiguous, a named `raw_message` refusal is safer than silent edits. Harmless repeated extras and unchanged noncanonical bytes must not be normalized as a shortcut. Re-run all three normative witnesses after a fix.

## Coverage and limits

### Byte provenance and final wire

- The new `raw_fuzz_setup_step_admission_hook_and_identity_replacement` test runs **36 deterministic synthetic cases**: all six message-member orders, four whitespace spellings, Unicode/string escapes, repeated extra keys, repeated equal text keys, scalar content, signed and redacted thinking, opaque blocks and tool inputs. Seed 26 has a **589,824-byte raw Unicode-escaped signature spelling** (`9 * 65,536` raw bytes; 262,144 decoded signature bytes). The earlier diagnostic in `cc-step-lane-evidence/restored-suite.stderr.txt` incorrectly said 655,360; the witness's diagnostic was corrected without changing its input or assertions. Tool-use cases include their result so the status does not end inside an open tool arc.
- Each case traverses ready setup's empty insertion, real status admission, durable message loading, an identity replacement encoded **from the stored raw sidecar**, actual answer-byte substitution, and an unchanged pre-user/post-assistant hook. Equality uses the original generated raw string, not a second serialization of the parsed value.
- Some signed steps safely return `refuse/misconfigured/signed_prefix_edit` because the engine attempts a block-count-changing replacement. The witness permits only that named signed refusal, then verifies the admitted raw bytes and identity codec output. It does **not** claim those steps published an identity compaction view. Initial witness iterations wrongly assumed every valid assistant status must yield noop/replacement; that assumption was removed, not a production test or contract.
- `provider_committed_replacement_keeps_noncanonical_unsigned_tail` additionally exercises **six actual cold-rebuild provider publications**. It loads the frozen provider view, checks its raw tail against the original noncanonical input, checks those bytes appear in the real returned response, requires two nonempty head slots, and verifies their hashes and lengths against the committed raw strings. This separates actual view publication from the constructed identity-codec control.
- The real author capture test ran with `MC_CC_CAPTURE` pointing at `local-ignore/cc-thinking-fixtures-20261012/14047-req-body`: **157,790 bytes**, SHA-256 **`ca6d004324b7d758d5fe7e17d6e637d468c873d7a4a4dbc7116e26e4c7cc314c`**, six message entries, one ordinary signed thinking block. It checks the actual raw answer substitution after narrow marker splicing. This capture is not redacted-thinking or arbitrary duplicate-key coverage. The initial run could not see the gitignored input on the remote runner; a temporary nonignored copy synchronized it, and the final remote command copied it back to the required `local-ignore` path before testing. Both copies and all supplied exports were deleted before commit. No private capture bytes are in this report or its witnesses.

### `cache_control`

`marker_transport_positions_are_exhaustively_refused` covers all seven specified top-level block types, with both an object marker and a null-valued member (**14** refusals), and the three specified nested tool-result child types (**3** refusals). `marker_tool_inputs_and_unknown_blocks_are_kept` proves exact roundtripping for marker-looking tool input, unknown top-level blocks, unknown nested children and nested thinking, which is outside the stated nested transport list. The implementation validates already-stripped sidecars; it does not strip markers itself on admission. The capture helper `strip_block`/`strip_array` in `codec_claude_code.rs:635-676` performs the narrowly scoped splice. The shadowed-content marker in finding 3 demonstrates why parse equivalence alone is insufficient.

### Admission and rebind

The new `admission_spoofs_and_rebind_matrix`, plus existing `cc_principal_and_profile_pair_are_both_required_and_body_cannot_spoof` and `cc_frozen_plan_session_harness_and_raw_mid_are_fenced`, establish:

| Attempt | Observed refusal |
| --- | --- |
| Body claims Thalamus; route principal absent/direct/reserved Broca | `claude_code_lane_requires_attested_host` |
| Bound Thalamus selects owned-Broca or OpenCode profile | `claude_code_lane_profile_mismatch` |
| Another principal selects Claude Code profile | `claude_code_lane_requires_attested_host` |
| Bound Thalamus + native profile, missing/non-answer observation | `invalid_params` naming the plan field |
| Same channel rebind loses Thalamus identity | `claude_code_lane_requires_attested_host` |
| Same channel retains Thalamus but rebinds harness to OpenCode | `claude_code_lane_profile_mismatch` |
| Mid-conversation plan changes serializer | `claude_code_lane_profile_mismatch` |
| Bound session/harness or otherwise frozen plan drifts | `invalid_params` |
| Same MID retries with parse-equal but byte-different raw JSON | `invalid_params` |

`lib.rs:14648-14664` stamps `SessionBinding.principal` from the daemon bind request; body principal is not authority. Rebinding to the identical attested principal, harness and plan remains valid (also used by the frozen-policy test); the tests do not assert that every same-identity rebind must be refused.

**Commons integration limit:** the implementation still pins commons `85c105df`, not `2bba392c`. At `2bba392c`, step CONTRACT §14.1 additionally requires a published, connection-scoped, frozen typed `claude_code` capability bundle. This range admits on principal/harness/profile/observation and does not publish or enforce that new bundle. Treat the passing M2 subset as implementation evidence, not completion of the M8 negotiation/generation work or permission for gateway cutover. The supplied commons contract also does not type the concrete `cache_policy`/`head_slots` payloads; agreement on those fields remains necessary.

### Signed thinking and boundaries

The existing historical-prefix, retained-block removal, complete-versus-split tool run, repeated-MID, opaque native thinking and required-head-edit tests passed after restoring controls. The new `whole_message_cuts_and_opaque_thinking_preserve_fences` uses an opaque thinking shape with a complete call/result pair: coverage through the result succeeds; coverage through only the call refuses `invalid_signed_tool_boundary`; removing uncovered thinking refuses `signed_prefix_edit`. Existing setup returns an empty initial insertion and hook answers persist `pass` with no ops/tags. No signature or redacted payload is authored. These checks do not rescue the duplicate-content bypass in finding 1.

### M5 and M7

- `cache_policy.rs:7-47` exposes frozen intent/provenance and `expiry_owner=runner`; no expiry scheduler was added by this diff. `cc_cache_policy_is_frozen_and_cold_rebuild_exposes_committed_head_bytes` proves a route-config TTL rebind cannot change the frozen policy. Head hashes at `:51-60` use emitted raw slot strings. The six new cold-rebuild witnesses independently compare these against persisted view strings. Authored `never` currently emits marker TTL `1h` but assumed lifetime `never`; this is explicitly asserted by the existing policy test, not newly inferred as a gateway TTL contract.
- `compaction.rs:514-537,675-680` maps typed `ProtectedToolResultsOverLimit` before transient conversion only on the Claude Code adapter. The restored terminal-refusal test checks correlation for lost/fresh requests, exact `window_too_small` and `protected_tool_results_over_limit`, nonretryability, no new view and durable admitted history. An unrelated engine error remains transient. The author commit `d43946c283` notes real final-wire evidence still depends on out-of-scope M4 context-geometry/protection plumbing; the adapter injection is a reached mapping test, **not** proof of actual live overflow reachability. There is no live runner exercise here.

### OpenCode and Broca baseline

The existing OpenCode golden/ingress/render tests, Broca raw-message byte-roundtrip test, provider regressions, Broca conformance and tool-provider conformance passed. `git diff --exit-code 3549c4340e 67a49551e3 -- crates/mc-module/src/providers/codec_opencode.rs crates/mc-module/testdata/codec crates/mc-module/tests/broca_conformance/fixtures` exited 0: the byte oracles and OpenCode codec are identical to base. Broca's **14** conformance tests include committed encoder bytes and shared fixture replay. This is fixture/conformance-backed byte identity; it is not a newly executed baseline binary for every possible caller. Full logs are retained in `cc-step-lane-evidence/`, outside build directories.

## Non-vacuity controls

Two of the change author's own controls were replayed (M1: neutralize kept-prefix comparison; M7: make protected-tail refusal transient), and two new controls added (marker refusal and raw-answer substitution). Each sequence staged the live files, confirmed empty unstaged `git diff --stat`, applied a marked `NON-VACUITY BREAK`, captured a nonempty stat, ran the named suite, restored with `git checkout -- <path> && touch <path>`, and captured an empty stat. No break remains. Machine-readable evidence is `cc-step-lane-evidence/mutation-evidence.json`; output pairs retain exact failing and unaffected test names.

| Control | Sole red test (module prefix omitted) | Green controls | Nonempty stat; after restore |
| --- | --- | --- | --- |
| Author M1: neutralize kept-prefix comparison | `every_kept_signed_prefix_is_fenced_including_historical_turns` | synthetic roundtrip, raw/markers, identical-MID, complete-tool-run tests | codec: 5 lines, +3/-2; empty |
| Author M7: terminal adapter arm becomes transient | `protected_tail_refusal_precedes_outage_pass_and_never_publishes_a_view` | `unrelated_engine_errors_remain_transient_not_terminal_refusals` | compaction: 6 lines, +2/-4; empty |
| New: neutralize transport-marker rejection | `marker_transport_positions_are_exhaustively_refused` | `marker_tool_inputs_and_unknown_blocks_are_kept` | codec: 3 lines, +2/-1; empty |
| New: serialize parsed replacement instead of raw | `raw_fuzz_setup_step_admission_hook_and_identity_replacement` | `raw_canonical_control_has_no_noncanonical_bytes` | codec: 5 lines, +2/-3; empty |

The M1 control selects the author's five-test subset; the later `opaque_native_thinking_shapes_still_fence_their_signed_prefix` would also redden for that mutation and is excluded only to reproduce the original subset, not in restored verification. An initial typo selected zero tests for M7; that run was rejected as evidence and immediately replaced by the actual `terminal_refusal_tests` two-test run. The third author control (M2 host admission) was not replayed; the review scope requested two of the author's three controls.

## Reproduction

Use a **disposable, clean review worktree**, never a live store. Commands below are for Linux; invoke the remote build tool with `linux,4c` (four requested vCPUs) and do not run Rust on macOS. Repeated controls can leave source mutations if interrupted; restore the named source path before doing anything else. The Python script `cc-step-lane-review-runner.py` only registers test code or replaces exact, uniquely matched source text for a selected mutation; it does not run builds or touch stores.

```sh
python3 -I docs/reports/cc-step-lane-review-runner.py install
cargo check -p mc-module -j 4 --all-targets
cargo test -p mc-module -j 4 --lib providers::cc_step_lane_review:: -- --nocapture
# At reviewed head 67a49551e3, these ignored duplicate-key tests must fail:
# retained thinking prefix, effective text editing, and raw-marker rejection.
cargo test -p mc-module -j 4 --lib providers::cc_step_lane_review::duplicate_ -- --ignored --nocapture
# Supply the private request-body file at MC_CC_CAPTURE below.
# A run that skips the capture because this variable is unset is not proof.
MC_CC_CAPTURE="$PWD/local-ignore/cc-thinking-fixtures-20261012/14047-req-body" \
  cargo test -p mc-module -j 4 --lib providers:: -- --skip providers::historian:: --nocapture
cargo test -p mc-module -j 4 --test broca_conformance --features drive-fault
cargo test -p mc-module -j 4 --lib tests::tool_catalog_conformance::the_role_conformance_suite_passes_every_case_magic_context_can_run -- --exact
python3 -I docs/reports/cc-step-lane-review-runner.py remove
```

For each mutation, install the witnesses, stage **only** the specific live provider files and witness file, confirm the unstaged diff is empty, then run the selected action and its command:

```sh
git add crates/mc-module/src/providers/mod.rs crates/mc-module/src/providers/codec_claude_code.rs crates/mc-module/src/providers/compaction.rs crates/mc-module/src/providers/cc_step_lane_witnesses.rs
git diff --stat
python3 -I docs/reports/cc-step-lane-review-runner.py author-signed-prefix
cargo test -p mc-module -j 4 --lib providers::codec_claude_code::tests:: -- --skip opaque_native_thinking_shapes_still_fence_their_signed_prefix --skip real_claude_code_capture_roundtrips_actual_raw_replacement_bytes
git checkout -- crates/mc-module/src/providers/codec_claude_code.rs && touch crates/mc-module/src/providers/codec_claude_code.rs
git diff --stat
```

The other action/command pairs are:

- `author-terminal-refusal`: `cargo test -p mc-module -j 4 --lib providers::compaction::terminal_refusal_tests:: -- --nocapture`; restore `compaction.rs`.
- `review-marker`: `cargo test -p mc-module -j 4 --lib providers::cc_step_lane_review::marker_ -- --nocapture`; restore `codec_claude_code.rs`.
- `review-raw-answer`: `cargo test -p mc-module -j 4 --lib providers::cc_step_lane_review::raw_ -- --nocapture`; restore `codec_claude_code.rs`.

Repeat the same staged-live, nonempty-stat, restore-and-touch, empty-stat sequence for each action. Never commit the temporary module registration or any mutant. Removing the `mod cc_step_lane_review;` registration from `providers/mod.rs` with the script's `remove` action returns the shipped sources to HEAD; the only delivered changes are this report and public witnesses/evidence.

## Verification record

Toolchain: `rustc 1.99.0 (b940084d7 2026-09-28)`; `cargo 1.99.0 (5f94df478 2026-08-27)`.

- `cargo check -p mc-module -j 4 --all-targets`: passed with temporary witness module installed; dev-profile check completed in 34.46 s.
- Restored `MC_CC_CAPTURE=... cargo test -p mc-module -j 4 --lib providers:: -- --skip providers::historian:: --nocapture`: **165 passed, 0 failed, 5 ignored** (two existing ignored tests and three known-defect review witnesses), 170 selected, 1347.51 s. Includes all seven unignored new tests and the real capture. The earlier broad provider run covered historian too: 183 passed, two ignored, only missing-file capture failed; the fixture rerun and final suite corrected that infrastructure failure. Historian was not rerun after codec/adapter-only controls.
- `cargo test -p mc-module -j 4 --test broca_conformance --features drive-fault`: **14 passed**; fixture encoder and replay remain byte-exact. Existing unrelated deprecated `fetch_update` warning under `drive-fault` was not changed.
- Tool-provider role conformance: **1 enclosing test passed**, checking advertised supported cases and skipping unsupported-capability cases according to the existing harness.
- Three duplicate-key witnesses: **three expected failures**, not a green correctness gate.
- Four mutation suites: sole intended red in each, with four/one/one/one unaffected tests respectively. After reverting all deliberately injected mutations, the selected production tests pass.
- Scoped `inspect` was partial because Rust diagnostics for the detached report file were not published; the Linux all-target check is authoritative. Python diagnostics had zero findings.
- Final review-artifact validation on Linux, Python 3.14.4: one Python syntax check, four exact mutation anchors, one JSON document and four bounded mutation proofs passed. The diagnostic-only signature-size correction was followed by another passing `cargo check -p mc-module -j 4 --all-targets` (4.26 s).
- Final head-slot witness strengthening requires exactly two slots instead of allowing an empty hash-check loop: Linux all-target check passed (8.53 s), and `provider_committed_replacement_keeps_noncanonical_unsigned_tail` passed again (1 test, six publications, 5.22 s).
- No manifests/lockfiles changed; no install required. No live stores, parent checkout, macOS Rust build, architecture/structure edits or private fixture publication occurred.

## Repair and permanent regression gates

The review above records the original implementation at `67a49551e3`. The
provider suite now includes the witnesses by default; none of the three defect
witnesses is ignored.

The stricter contract introduced after `67a49551e3` makes Claude Code admission
refuse duplicate object keys at every depth with
`invalid_params` naming `raw_message`. Decoded key names are compared, so escaped
spellings of the same key also conflict. This rule applies to opaque data and
tool input as well as transport fields: no duplicate-key JSON is spliced or
forwarded. Native rendering and raw-answer serialization revalidate stored raw
provenance written before this change, rather than trusting the old admission
rule that allowed duplicates.

The check that prevents edits before retained signed thinking now compares the
gateway's message ID (MID), ordinal and position for every preceding message,
in addition to the original byte-prefix comparison. Equal-content messages
cannot replace or reorder one another before a retained thinking signature.
`duplicate_content_cannot_edit_bytes_before_effective_kept_thinking` retains
its original duplicate-content input as an admission-refusal assertion and
also swaps two distinct MIDs with identical raw bytes.
`duplicate_text_splice_must_change_effective_text_or_refuse` now requires
admission refusal rather than allowing an edit to choose a duplicate-key winner.
This intentionally tightens the accepted-input contract. The passing raw-byte
fuzz corpus therefore uses unique object keys;
noncanonical whitespace, escapes, unknown blocks and large signatures remain.

`cc-step-lane-review-runner.py` offers three repair controls: `identity-prefix`,
`duplicate-key-marker`, and `duplicate-key-text`. Each temporarily reintroduces
a codec defect to prove that the corresponding test fails. Stage the live files
and verify an empty unstaged diff before applying a control. Run the exact named
test, then restore the mutated codec from the index and touch it. The
`NON-VACUITY BREAK` marker identifies deliberately damaged source, which must
never be committed.
