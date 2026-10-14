# Claude Code reduction-to-native mapping

## Reproduction and cause

The new real-handler tests set up `fresh-after-native-summary` with no descent, an empty initial compaction, three tool exchanges, a mixed text/tool-use assistant, a tool-use-only assistant, tool-result users, and signed plus redacted thinking. First-head publication covers `[0,1)` verbatim. Subsequent low-pressure steps and three native hooks hold queued reductions. A separately permitted 95% pressure/cache-rebuilding step then selects four durable units:

- `red:m1#1` / `drop`: tool use inside the mixed assistant.
- `red:m2#0` / `drop`: its result.
- `red:m5#0` / `drop`: the sole tool use of another assistant.
- `red:m6#0` / `drop`: its result.

The fixture without any queued drops also selects these units. Its stored emergency assessment reports **12,142 selected reclaim tokens**; the queued variant reports **12,146**. Thus emergency reclaim is a concrete automatic reproducer on a fresh, never-summarized lineage. The queued variant additionally exercises the real `ctx_reduce` handler and durable queue; queued result drops themselves are block-granular (`selection.rs::select_agent_drops`). Large call arguments exceed the selector's small-input skeleton allowance, permitting full-call drops (`select_reductions_with_outcome` / `expand_arc`). A fresh lineage does not disable tail reclaim: no prior historian coverage is required for these selectors.

The fixtures enable smart drops, resolve a 4,000-token protected floor, and explicitly set the `ctx_reduce` exemplar count to zero so a short transcript has eligible old arcs. Legacy display-tag rows are seeded with the test-support API; hooks on this base record pass answers and do not mint native tags. All stores and histories are disposable test fixtures.

The shared assembly path (`transform.rs::build_output_with_tags`) collects full-drop tool IDs and filters matching call/result block indexes out of their owner messages. For a mixed assistant, text survives while tool use disappears. This is the concrete count mismatch: `codec_claude_code.rs::render` compares native spans with the shorter CK content vector. The generic compaction replacement builder also removes signed reasoning blocks after the first prefix edit, which independently needs native whole-turn translation.

Disabling only the new native adapter reproduces the reported handler refusal:

`misconfigured / signed_prefix_edit: native block removal requires a complete covered message`

This is a reconstructed real-handler regression, not a replay of THALAMUS's private longest-session capture: that capture was not provided, and no live store was opened. The exact automatic selector at THALAMUS turn 29 cannot be distinguished from the supplied refusal alone; queued drops, age/dedup/supersession/retirement and emergency full-call drops share the same failing assembly-to-native boundary. The adapter handles their output uniformly rather than changing selector behavior.

## Mapping and cut behavior

`providers/native_reductions.rs` translates an engine replacement only on the Claude Code lane, before native rendering and immutable publication:

- Surviving native messages retain every non-thinking block position. Text and supported tool-result text edits are spliced into original raw JSON. The existing block-count check remains; a separately authorized complete thinking strip constructs a shell with all thinking omitted before that check, so ordinary tool/text block loss still fails it.
- A removed or plain `[dropped]` result becomes exactly one `[dropped §N§]` placeholder using its persisted display tag. If there is no display tag, the original block is held and a reason is logged.
- Tool uses stay unchanged because this codec cannot author tool input skeleton edits. Sole-call/sole-result exchanges can disappear together. Mixed result carriers and unsafe role boundaries keep their messages.
- Thinking is never authored or partially neutralized. A genuinely rebuilding pass removes every thinking/redacted-thinking block in each affected turn while copying remaining blocks from original raw spans. If a call/result-only exchange is itself dropped, whole-message retirement remains possible; mixed user result carriers never lose their other user blocks. Identity/defer steps and hooks preserve thinking byte-exact, and an unpriced required head publication is held rather than refused.
- Unsupported/ambiguous block edits are held with diagnostic reasons. Unknown/duplicated native identities are not repaired; the existing encoder invariants still reject corruption.
- No lane-authored cache markers or separator messages are added.

The parent clarified that uncovered reductions must ride a prefix rewrite the engine already permits, not wait indefinitely for historian summaries. Native coverage therefore extends through the newest complete edited/removed message outside the engine-selected protected tail. All intervening original messages retain stored bytes unless they carry an expressible reduction. This native installation coverage is separate from, and does not advance, the historian boundary.

The parent further clarified the signed mixed-carrier edge: never delete other user text and never refuse it. On a true rebuild, the complete thinking strip leaves the tool use (and any assistant text) intact, then skeletons only the queued result. Native mapping reads the pre-selection queue for this case, filters current token/tool protections using the engine's validated tag snapshot, and replays already published result skeletons from the immutable view on future rewrites. A real-handler test removes the fulfilled queue in its disposable fixture before another rebuilding step, proving byte stability does not depend on accidentally re-reading that queue. The mixed-carrier test preserves the noncanonical `user data byte-exact\u0021` text block exactly; its extended coverage is through `m22` after additional protected tool exchanges.

The pre-existing required-head/signed-thinking test intentionally changes from a terminal refusal to a `noop` hold on non-rebuilding first publication, following that explicit parent instruction. The codec's direct signed-prefix and block-count invariant tests remain unchanged.

`native_cut::attach/validate` now includes covered original messages in the frozen cut prefix. Original parts after its inclusive endpoint still require exact identity, block count and verbatim bytes. The retained-tail handle contract is unchanged. First-head publication remains verbatim, identity/defer steps do not advance coverage, and `transform.hook` remains untouched.

## Tests and mutation evidence

Sixteen added tests cover mixed calls, sole-call pair retirement, one-placeholder result drops, unsupported/opaque/untagged holds, identity and rebuilding signed turns (including future opaque thinking shapes), contiguous tool arcs, assistant adjacency, in-array system ordering, zero lane cache markers, and thinking-only prevention. Every mapped answer is checked with the pinned commons **0.2.0** Claude Code validator. Mapper fixtures also check three exact-byte replays. All three real-handler sequences validate all emitted step answers, check all five THALAMUS final-byte constraints, perform three stable later steps, then emulate a native hook cut and recheck old full/cut view bytes.

Seventeen reported temporary source controls each produced exactly one named failing test, with no other test selected. Before each mutation the live sources were staged and the unstaged diff was empty. Each break had the required `NON-VACUITY BREAK` marker and a nonempty diff-stat; checkout plus touch restored an empty diff-stat. Controls covered adapter bypass, mixed call deletion, sole-call retirement, duplicate placeholders, unsupported tool-input edits, complete thinking stripping, orphaning calls, adjacent assistant insertion, system adjacency, emitted cache markers, thinking-only native bytes, an actual hook Replace operation, identity signed-turn holds, mixed user-message deletion, unpriced head publication, immutable skeleton absorption replay, and the fingerprint golden. Detailed machine-readable mutation evidence accompanies delivery. Superseded exploratory controls for the earlier whole-message thinking model are not counted; final thinking/identity/fingerprint controls were rerun after the parent's clarification.

## Verification

All Rust commands ran on Linux with eight requested vCPUs and `-j 8` where applicable.

Toolchain: `cargo 1.99.0 (5f94df478 2026-08-27)`, `rustc 1.99.0 (b940084d7 2026-09-28)`, `rustfmt 1.10.0-stable (b940084d7e 2026-09-28)`, `clippy 0.1.99 (b940084d7e 2026-09-28)`.

- `cargo check -p mc-module --all-targets -j 8`: passed.
- `cargo fmt --all -- --check`: passed, including final restored sources.
- `cargo clippy -p mc-module -j 8 --all-targets -- -D warnings`: passed, including final restored sources.
- `cargo test -p mc-module -j 8 --lib providers::native_reduction_tests:: -- --nocapture`: 16 passed after final source edits and mutation restores.
- `cargo test -p mc-module -j 8` (earlier implementation; final affected groups and differentials were rerun separately): library 2,126 passed / 33 ignored, and preceding integration targets passed. The 720-pass / 48-pass provider differential tests both passed byte comparisons, as did role conformance. The command eventually failed in four unrelated real-daemon tests because `real_daemon.rs:1101` requires an absent sibling `subconscious` checkout. It did not reach later targets/doc tests; no workaround or live-daemon access was attempted.
- Final restored source also passed the existing Claude Code handler group (15 tests), native codec group (10 tests), native-cut group (3 tests), and candidate group (3 passed / 1 exporter ignored). The private capture-backed codec test internally returns without replay when `MC_CC_CAPTURE` is absent; no private capture replay is claimed.
- Final provider differentials were rerun independently: 720 passes / 46,980 per-message byte comparisons / 1,850 summary replays, and 48 passes / 113 exact new-message comparisons, both passed.
- `cargo test -p mc-module -j 8 --test broca_conformance --features drive-fault`: 14 passed on the final source, including crash timing controls. The feature emits an unrelated deprecated `AtomicUsize::fetch_update` warning in `lib.rs:16485`; default all-target Clippy was clean.
- Candidate exporter: one ignored exporter test passed. The refreshed JSON golden is exporter output, not ordinary test-generated expectations.
- Scoped AFT inspection was provisional: its Rust inputs could not be fingerprinted. Linux package check/Clippy are the authoritative diagnostics.
- Comment review completed; terminology and reasons in the adapter/cut/test comments were clarified.

## Candidate fingerprint

No wire, role contract, epoch or migration change. The native cut source changed and the adapter is now included in the provider source fingerprint. Final exported values:

- `provider_generation`: `key-sha256:bd79d4ff9ddef35133b85e59c080798a63c6ee0a0ddccad43eaff9d309a8ab8f`
- Canonical bundle SHA-256 (excluding final LF): `bde249d95766a60fb59249a89fd99a165b3d29ac73d9665facfe811ab43787b7`
- `profile_generation`: `codec-sha256:ccb2a22c69d2976d2237e7b48bbd5b077a8c591a28e17b577b7b20c716469fcb`. The render-only complete-thinking-strip support changes this source fingerprint; native message decode/equivalence code is untouched.

Message ingest, stored-message equivalence, native message identities, OpenCode and Broca serializers, live hook reduction behavior, ARCHITECTURE.md and STRUCTURE.md were not edited. The only shared-engine edit exposes its existing flat-block-to-selector mapping helper to the native adapter for protected-tool accounting; the helper's implementation is unchanged.
