# Adversarial review: provider post-rebuild hook cost

## Verdict: reject as written

Review target: `docs/designs/provider-post-rebuild-hook-cost.md`, against source
base `901b351b6d512fff0ee1b5fe09d128e82ff0a165`. This is a report and three opt-in
witness tests, **not a production implementation or a canary authorization**.
No live stores were opened. Rust execution was on Linux only.

Question labels used below: **(a)** served bytes, acknowledgements/receipts and
durable state; **(b)** cache inputs/invalidation; **(c)** warm versus uncached hook
policy; **(d)** proof coverage; **(e)** shipping order and smallest safe first step.

The immutable-row cache is feasible if it remains a cache of the existing
serialization stages, not a new renderer. Prewarm-first is the right sequencing,
but **calling the existing ordinary-hook computation before the next message and
publishing its baseline is not behavior-preserving**. An executed counterexample
produces different channel-1 append bytes despite equal effective token totals.
The design's requirement to use “the same inputs” leaves unspecified whether a
baseline mismatch is repaired before or after the next message is admitted, and
which newest-message boundary that repair freezes.

Required changes before implementation:

1. Keep baseline refreeze timing and its cut at the **actual hook's admitted
   newest message**. Prewarm may prepare data, but must not turn a pending
   refreeze into an already committed, shorter baseline. Compare cold and warm
   first hooks from the same pre-rebuild snapshot, including their operations and
   durable measurements, with the advancing-message input described in R1.
2. Specify separately the immutable-row byte representation, setup-answer
   representation, step-answer representation and native-message representation.
   Never splice a durable typed fragment into a Value-serialized step answer.
3. Specify a snapshot/publication protocol with a policy revision and atomic
   accounting of its change-log frontier. Store fencing and a summary settings
   key alone are not snapshot validation. Preserve current conversation counters
   when recording the answer.
4. Split the native-render dependency key from the immutable-view locator. List
   the complete dependency tuple below, including whole-prefix thinking ownership.
5. Make acceptance a genuine pre-rebuild, same-snapshot, cache-on/off trace
   differential. Existing named controls and same-state policy recomputation alone
   are insufficient. Keep the 1,500 ms fence and report misses as failures.

## Findings, ranked by severity

### R1 — Critical: early baseline publication changes the next hook's bytes

**Answers (a), (c), (d), (e).** The issue is not merely substituting engine
measurements for hook measurements. The time at which a mismatch is repaired
changes which message is frozen.

* Engine measurement excludes covered parts *before* attributing their tags or
  protection (`crates/mc-module/src/tail_hygiene.rs:609-630`). The engine nevertheless
  captures persisted tag identity separately in each provider part
  (`crates/mc-module/src/transform.rs:11866-11898`).
* The hook copies that measurement, adds active tag/protection/queue attribution,
  and only then zeroes covered/reduced parts
  (`crates/mc-module/src/transform.rs:12085-12118`). Thus a covered tagged user text
  has engine `tokens=0, tag_number=None`, but hook `tokens=0, tag_number=Some(1)`.
  Prefix comparison treats that as a mismatch; refresh increments generation and
  freezes again (`crates/mc-module/src/tail_hygiene.rs:747-824,938-1011`).
* A refreeze excludes **the current newest message**. The hook derives newest from
  all effective parts, including headers
  (`crates/mc-module/src/transform.rs:12082-12088,12136-12149`); the freeze splits at
  that position (`crates/mc-module/src/tail_hygiene.rs:835-868`). This cut is not an
  immutable property of the committed rebuild.

Executed input: ordinal 1 is a covered tagged user text; ordinal 2 is an assistant
message with four completed `read` tool arcs and large outputs, tags 2–5. The newest
three served tool tags remain protected even with a zero token floor
(`crates/mc-module/src/protection_window.rs:87-129`). Tag 2 is reclaimable. The next
ordinary post-tool subject at ordinal 3 is modeled with a reserved, unserved tag 6
and a small output. The witness assigns tag 6 explicitly rather than exercising
store reservation; admission initially captures unserved parts
(`crates/mc-module/src/providers/step_transform.rs:98-137`).

The witnesses use actual ingress decoding, projection, engine measurement and
`capture_provider_parts`, not invented baseline totals:

* `hookcost_review_covered_tag_forces_hook_refreeze` establishes the covered-part
  mismatch and generation **1 → 2**.
* `hookcost_review_eager_refreeze_before_append_changes_hook_bytes` emulates just
  baseline restatement/settings publication before admitting the next part. Early
  prewarm freezes **1** non-header part; the uncached first hook freezes **9**.
  Warm and cold effective token totals agree, but reclaimable frozen tool-output
  counts are **0 vs 1**, and `host_channel1` emits different serialized appends.

Witness source: `crates/mc-module/src/providers/step_transform_parity_tests.rs:1242-1448`.
The channel-1 housekeeping reminder uses that frozen-output count in its text
(`crates/mc-module/src/transform.rs:14698-14733`). Baseline scalar totals, delta,
length and stored measurements also differ. “No cadence advance” does **not** make
an early baseline change disposable.

The case uses an ordinary hook (`cache_busting=false`) and no model change,
concurrent writer, timeout or host acknowledgement. Prewarm before a new message
is already sufficient to break identity. A new header with zero content can also
move the cut; a first hook on the *same* newest message does not exercise this
counterexample. Reduced/sentinel arcs and covered tagged tool parts are additional
mismatch candidates: the engine excludes entire arcs early, whereas hook
attribution operates on captured parts
(`crates/mc-module/src/tail_hygiene.rs:577-620`; `crates/mc-module/src/transform.rs:11897-11898,12089-12116`).

**Required correction:** keep the original engine baseline as the reference and a
pending-refreeze state until the real hook has admitted its message. Preparing
hook-compatible measurements is useful; publishing a freshly frozen baseline
before that admission is not equivalent. A full recomputation over the already
restated *warm* state will faithfully return the wrong counterfactual answer.
An actual prewarm implementation is absent, so this is a witness against the
obvious proposed composition, not a claim about an implemented cache.

### R2 — Critical: immutable durable bytes are not step-response fragment bytes

**Answers (a), (b), (d).** Existing serialization stages differ:

* `save_host_view` serializes typed `HostView`, which embeds typed
  `CompactionMessage` (`crates/mc-module/src/providers/compaction.rs:81-92,342-360`).
* A host step embeds `view.wire` in `json!`, then serializes the resulting `Value`
  (`crates/mc-module/src/providers/compaction.rs:1313-1330`;
  `crates/mc-module/src/providers/mod.rs:110-112`). Setup instead serializes a typed
  `SetupAnswer` (`crates/mc-module/src/providers/compaction.rs:983-992`).
* The store enforces literal immutable replacement-string equality, not parsed
  equality, at an existing version
  (`crates/mc-store/src/provider_log.rs:1389-1404`).

Executed witness `hookcost_review_durable_wire_fragment_is_not_response_wire_fragment`
performs a real setup/rebuild against a temporary store, serializes the saved
view's typed wire object and compares it with the step's Value compaction object.
They are **JSON-equal and byte-unequal**. Substituting the durable fragment into
that actual answer leaves parsed JSON unchanged while changing answer bytes
(`crates/mc-module/src/providers/compaction_review_tests.rs:1152-1189`).

For native messages the current “raw” sidecar is a **Value**, not original input
JSON lexemes. Ingress decodes after stamping runner ordinals but restores the
original message *Value* in the sidecar
(`crates/mc-module/src/providers/codec_opencode.rs:27-55`). The answer serializer
therefore normalizes object key ordering and escape spellings. Caching original
transport substrings instead would preserve different ordering, whitespace,
Unicode escapes or slash escapes than the existing path. Conversely, reconstructing
native objects from CK alone can lose unknown envelope/part/state fields or
structural parts omitted from CK
(`crates/mc-module/src/codec/opencode.rs:191-200,861-887,1040-1059,1085-1145`).

Signed reasoning parts are deliberately not edited, and protected reasoning can
force restoration of the complete native parts vector
(`crates/mc-module/src/codec/opencode.rs:794-811,887-902,961-969,1005-1019`). Matching a
signature string is not permission to change anything preceding it.

**Required correction:** cache normalized bytes at the *specific existing stage*.
For a step-response raw-fragment encoder, build the fragment once through the
existing Value conversion, not by slicing the typed durable wire member. Do not
reuse an entire response across requests: request id, version/range, coverage,
answer kind and setup/step envelope are fresh inputs. Do not rewrite the durable
row to make its bytes resemble the response. Include an independent serializer
oracle and lexical input adversaries, rather than merely checking parsed equality.

### R3 — High: publication needs a policy snapshot fence, not just store fencing

**Answers (a), (b), (d).** The current same-conversation race protection is good:
`provider_step` holds `provider_serial` through synchronous `host_step`, hooks take
the same lock, and pass synchronization uses its nonblocking form
(`crates/mc-module/src/providers/compaction.rs:1498-1512`;
`crates/mc-module/src/providers/step_transform.rs:291-317,641-657`). Historian
publication also takes that conversation lock before checking ancestry and
publishing (`crates/mc-module/src/providers/historian.rs:180-225`). A prewarm placed
inside that existing critical section must **not** release the guard, spawn work,
or manufacture a historian barrier to shorten its measured time.

But the lock is per conversation (`crates/mc-module/src/providers/mod.rs:35-59`),
not per engine namespace or durable snapshot. Host namespaces default to the bound
session (`crates/mc-module/src/providers/compaction.rs:871-877`), so distinct harness
conversations can share one engine. An engine commit rewrites **all conversations
in that namespace**, drops their summaries/logs, and sets their engine policy
(`crates/mc-store/src/provider_log.rs:161-200`). The engine transaction validates
its row version and sections before writing
(`crates/mc-store/src/lib.rs:10975-11009`) and writes provider policy in that same
transaction (`crates/mc-store/src/lib.rs:11311-11334`). A later prewarm is a different
transaction; that accepted engine row version alone does not version ordinary
hook admissions or change-log accounting.

Concrete timing and concurrency cases that must be specified:

1. **Out-of-transaction preparation:** prepare from E1/parts P1; a namespace sibling
   commits E2 (dropping the summary and its log); then publish P1 and clear the
   current log. The summary's settings/generation key can coincide while its parts
   no longer do. `save_policy_summary_tx` deletes *all* accounted conversation
   changes (`crates/mc-store/src/provider_log/policy_index.rs:392-407`). Atomic stale
   publication is still stale publication.
2. **Overwrite after correct publication:** `host_step` reloads counters after the
   engine, copies them into its local `conversation`, then finally saves that
   whole conversation (`crates/mc-module/src/providers/compaction.rs:1304-1311,1325-1328`).
   Prewarm inserted after that reload can update baseline counters correctly and
   have the final `save_host_setup` overwrite them. Publish before that reload,
   or reload/merge in the final fenced write; never save old counters afterward.
3. **Crash/lost answer:** engine commit, immutable view save, receipt save and host
   acknowledgement are distinct cuts
   (`crates/mc-module/src/providers/compaction.rs:631-638,1295-1329`). A failed prewarm
   cannot roll the engine back or invent an applied receipt. Missing preparation
   after restart must use current authority and the normal hook timing, not assume
   that the committed engine had no work left.
4. **Revert/model/pass change:** descendants change effective cuts and shadowing;
   consumed tags deactivate effective parts
   (`crates/mc-store/src/provider_log/policy_index.rs:94-128,166-195`). A later pass
   changes model/eligible subjects and admits parts before policy computation
   (`crates/mc-module/src/providers/step_transform.rs:385-429`). Keep normal
   invalidation/replay and do not predict carrier, temporal mutation permission or
   cache busting. An ordinary pass preserves frozen calibration; a bust adopts the
   model (`crates/mc-module/src/transform.rs:11966-11979`). StepStatus model is not
   permission to price an ordinary prewarm in a new epoch.
5. **Historian/domain publication:** same-conversation historian publication cannot
   interleave under the held guard, but publication before/after the request can
   change the next engine head. Host domain writes use their own immediate schema-
   fenced transaction (`crates/mc-module/src/host_store.rs:1057-1075,1124-1188`). Engine
   commits deliberately remember a domain snapshot and observe later writes on the
   next pass (`crates/mc-store/src/lib.rs:11011-11014`). Do not treat a host schema
   fence as a provider-policy revision, nor fold later history into a frozen view.

Acknowledgement validation must remain on the durable path: compaction id/version
before admission, structural rejection, promotion of the produced view to applied,
and validation that a descendant retains the compacted range
(`crates/mc-module/src/providers/compaction.rs:1022-1037,1188-1240`). The receipt
intentionally retains only identity/version
(`crates/mc-module/src/providers/compaction.rs:313-326`). Cache presence is neither
an acknowledgement nor proof that a row still exists or is eligible.

**Required correction:** either read/compute/publish under one current fenced
policy transaction, or validate a monotone revision covering namespace rewrites,
conversation policy rows, consumed tags, lineage and change-log frontier before
publishing, retrying/refusing on mismatch. Persist summary and any permitted
measurement/settings updates together without clearing newer changes. Preserve
original admission of messages, promotion of served answers, and invalidation of
unserved answers/tags; do not call the normal hook
commit API as a shortcut to prewarm, since it performs those actions
(`crates/mc-store/src/provider_log.rs:1249-1304,1307-1332`).

### R4 — High: the proposed cache key is a locator, not a complete render key

**Answer (b), with consequences for (a).** The named key/invalidation rules are
necessary, but “every codec input matches” is not a concrete enforceable tuple.
There are three different caches. They should have separate contracts:

| Cached object / input | Existing source of the input | Key or invalidation obligation |
| --- | --- | --- |
| Immutable view row | Conversation tuple, version, original lineage/range and literal replacement JSON (`crates/mc-store/src/provider_log.rs:1395-1426`) | Store-open/lease lifetime + conversation + compaction id/version/encoding identity; validate durable existence/eligibility. New paths/reopens/reset/replacement must not hit old memory. Proposed rules cover this in principle, not an implemented invalidation mechanism. |
| Materialized reference | Applied/produced reference, descended lineage and ancestor cut (`crates/mc-module/src/providers/compaction.rs:363-376,585-608,1207-1240`) | Separate validated reference descriptor. Do not change shared frozen bytes, reuse a prior reference's range validation, or let a digest match stand in for exact comparison. |
| Native sidecar | Complete original Value trees, info/time/unknown fields, ignored and structural parts, part ids, input ordinals, CK/native block-index mapping and message ordering (`crates/mc-module/src/providers/codec_opencode.rs:8-55`; `crates/mc-module/src/codec/opencode.rs:191-200,481-500,861-887`) | Exact normalized sidecar/decode dependency identity, not just mid or rendered scalar text. Ordinal changes affect fallback tool identity. Unknown fields can differ while CK projection remains equal. |
| Rendered content | Entire view replacement, roles/order, block input/output/attachments and source mapping (`crates/mc-module/src/providers/codec_opencode.rs:98-122`; `crates/mc-module/src/codec/opencode.rs:825-859,955-1023`) | Exact content/shape/mapping identity and codec version. Reuse only at the serialization stage whose bytes were validated. |
| Committed native context | `reasoning_clear_units`, `tag_numbers`, `mutation_exempt_mid`, `lineage_anchor_mid`, `transition_consumed`, `native_reasoning_keep_mids` (`crates/mc-module/src/providers/codec_opencode.rs:58-79,101-111`) | All six fields must participate; **whole prefix before kept thinking** must remain exact. A protection-owner change can restore an entire native vector, not only one reasoning block. |
| Native request finalization | Engine namespace/session id, serializer profile, complete CK ingress including role/synthetic/reasoning ownership, `mid_turn`, and explicit `provider_id` (which decides empty-content versus placeholder rendering) (`crates/mc-module/src/lib.rs:15344-15405`; `crates/mc-module/src/transform.rs:18169-18184,18219-18225`) | Include this request context, not only the six `NativeRenderContext` fields. A provider switch or a later assistant shell can alter reasoning clearing/exemption with unchanged rendered text. |
| Hook overlay input | Live answer state/lineage/cut, non-tag operations, target part id, filtering of channel-1-owned appends (`crates/mc-module/src/providers/compaction.rs:223-307`) | Replay overlay changes before render-key comparison. Same mid can have new temporal text, hints, tag stripping or unsigned tool output. |
| Fresh response envelope | Setup vs step, answer kind, request id, id/version/range, coverage; typed vs Value serialization (`crates/mc-module/src/providers/compaction.rs:983-992,1313-1330`) | Do not cache the complete answer under only a view key. Assemble fresh using the old envelope semantics. Include serialization-stage identity if retaining fragments. |
| Summary settings | Ancestry/cuts, namespace, coverage, resolved floor, tool ratio bits, normalized keep map, previous baseline generation and length (`crates/mc-module/src/providers/policy_summary.rs:177-234`) | Existing summary key covers these. New prepared-input objects additionally need original baseline identity and pending-refreeze/newest state, plus the publication revision from R3. |
| Summary facts | Effective ordered headers/nonheaders; measurement key/hash/kind/tokens and frozen tag/protection/queue facts; ordinal/index/id/role, tag kind/number/mass, tool name/arc, active/served/reduced/queued, real-user flags (`crates/mc-module/src/transform.rs:11997-12179`) | Row change replay or invalidate. Includes near-lineage shadowing and consumed tags; not just the engine row version. Preserve log caps/order failures and window/arc/hint fallback (`crates/mc-module/src/providers/policy_summary.rs:718-1060`). |
| Live hook-only inputs | Carrier, synchronized model/exact pass permission, preset, cadence/grace, temporal timestamps, hint eligibility and completion (`crates/mc-module/src/providers/step_transform.rs:759-789,833-943`) | Compute at the actual hook, never return cached operations. Carrier is applied to reusable summary output; baseline scalars/grace come from live previous state (`crates/mc-module/src/providers/policy_summary.rs:623-665`). |

Model/config/system/provider/historian changes that affect engine replacement or
native context are dependencies of a *new render*, even though they need not
invalidate immutable historical bytes. The engine reconstructs preserved provider,
system, upgrade and tagger inputs from metadata
(`crates/mc-module/src/providers/compaction.rs:509-565`). Derive render dependencies
from those actual outputs, not a vague “config changed” signal. Do not invalidate
the durable immutable object itself just to evict memory.

No claim is made that the existing summary key is itself broken: it caches sums,
not a whole `Channel1PolicyInputs` or hook decision, and reads the current baseline
scalars again. Extending it to cache those objects would require additional inputs.

### R5 — Medium: the current proof controls can bless the wrong equivalence

**Answer (d).** The proposal correctly asks for exact wire and functional-state
differentials (`docs/designs/provider-post-rebuild-hook-cost.md:125-135`). If those
are implemented against independently cloned **pre-engine/pre-prewarm** authority,
with a new message admitted before the first hook refreezes its baseline, they can
catch these counterexamples. The existing
controls do not already supply that proof:

* The Rust randomized overlay control compares selected text/tool output and a
  frozen reference digest, not the complete response/native request/state
  (`crates/mc-module/src/providers/step_transform_parity_tests.rs:404-452`). Its
  name is not a wire-byte guarantee.
* Bounded-policy checks clear baseline part arrays and compare structured
  baselines/users/output counts/hints, then summary structs
  (`crates/mc-module/src/providers/policy_summary.rs:1246-1277`;
  `crates/mc-module/src/providers/policy_summary_review_tests.rs:279-301`). They
  recompute over the same already committed state, so can validate a semantically
  wrong early refreeze. They do not compare the measurements persisted by cold
  first-hook refreeze against those persisted by earlier warm refreeze.
* The host differential records `JSON.stringify` of per-message objects at its
  fake provider boundary, plus selected durable state
  (`packages/e2e-tests/scripts/provider-pipeline-differential.ts:169-178,494-497,732-739,832-860,888-917`).
  It forwards module bytes (`:245-251`) but does not assert their complete raw
  equality. Parsed JSON plus a fresh stringify can conceal R2's response-order
  change.
* The 706-pass signed-thinking result is reported as a golden capture
  (`docs/reports/provider-pipeline-performance-gate.md:449-452`). I did not verify
  that capture's implementation; it must not be counted as proof of new cache
  keys, durable summary publication or crash cuts.

Minimum additions to the acceptance plan:

1. Independent old-path exact answer bytes for both setup and step, including
   response assembly, retries, coverage and final host/provider request capture.
   Include lexical key/escape variants, opaque/structural parts, unknown fields,
   mixed attachments, repeated tool ids and signed/redacted reasoning. For kept
   signed thinking, compare the **entire preceding byte prefix**, not just its
   signature/content. Do not reconstruct both sides with the new encoder.
2. Paired cold/warm traces from the same snapshot *before* engine commit, with
   first ordinary hooks on the same message, a new post-tool message, a new user
   header, multiple native parts, and no carrier. Keep original baseline cut,
   generation, scalar fields and each restated measurement in state comparison.
   Then cover real cache-busting hooks, grace and cadence, queued/consumed tags,
   oldest hints, retries and a descendant cutting through the compacted range.
3. Deterministic interleavings at engine commit, preparation read, publication,
   view save, receipt save, serialization and acknowledgement. Add sibling
   conversations sharing a namespace, a full-array engine writer, historian
   publication, model/pass changes and a revert. Add a failpoint *inside* baseline/
   summary publication and verify rollback plus recovery, not merely a no-summary
   return. Force durable row removal while memory is hot and conflicting state
   transitions; hits must not mask refusal or resurrect views.
4. Named mutation controls: neutralize pending-refreeze/newest tracking, substitute
   a typed durable wire fragment, omit each native-context/key field, omit baseline
   restatement, clear changes newer than the prepared snapshot, publish before
   engine commit and skip the final counter reload. For each, record the exact
   failing byte/state test and unaffected controls, with a verified restore. Merely
   causing a parser exception or refusing all requests is not a byte/state proof.
5. Separately test bounds and identity: global retained capacities and shared
   buffers, descriptors and in-flight entries, oversize admission and eviction,
   store reopen/reset/replacement, corrupt offsets/buffers, descriptor UTF-8/JSON
   boundaries and ancestry validation. Eviction must change neither answer nor
   receipt; a supposedly disposable cache must not keep authority alive.

The design's five byte-equal rebuild pairs per binding are correctness spot
checks, not enough to establish a hook p99 or a stable median ratio. Record sample
count, failures, allocation/load and confidence/dispersion; include policy
preparation, lock wait, serialization, sync/drain and output publication in the
rebuild time (`docs/designs/provider-post-rebuild-hook-cost.md:137-154`). Moving work
under 30 seconds can still increase rebuild time and contention; this review does
not establish either performance target.

## Sequencing: prewarm preparation first, native byte cache later

**Answer (e): yes to separating the work, no to shipping the described eager
baseline publication alone.** Part 1 solves rebuild ratio contributors but adds a
second byte encoder, descriptor validation and eviction lifecycle. None is needed
to investigate the first-hook blocker. Part 2 must first be reformulated so it
prepares the *uncached hook's future computation*, not today's completed hook
baseline.

The smallest safe initial production step would be:

1. Add a **side-effect-free, shadow preparation API** for ordinary policy inputs
   under the existing step guard, after the engine commits. It must read current
   effective parts/settings, retain the original baseline and newest boundary,
   and report whether refreeze will be required. Use the existing full computation
   as the oracle, with no tag, cadence, grace, hint, historian, receipt or served
   writes. Measure read/decode, computation, baseline serialization/restatement
   and publication stages separately as the design itself requests
   (`docs/designs/provider-post-rebuild-hook-cost.md:37-47`).
2. For a baseline that remains valid, normal bounded-summary preparation is the
   straightforward reusable subset. For R1's mismatch case, retain a bounded
   prepared snapshot or compact pending-refreeze aggregates that can finalize
   against **the actual newly admitted parts and newest cut**. On the hook, verify
   its policy revision, replay the real changes, refreeze using the original
   baseline, and commit the usual measurements/settings/summary with the usual
   hook transaction. A revision miss, cap failure or cache-busting pass follows
   the current exact path/refusal; there is no larger deadline.
3. Start in shadow mode comparing the real first-hook result with the preparation,
   including baseline parts and append bytes. Only enable consumption after
   counterfactual state/byte tests and timing establish that it is useful. A full
   reread or parsed snapshot is an acceptable first correctness experiment; it is
   not a promise to meet 250 ms or 1.10×. Serialization/restatement left in the
   first hook can still dominate, and the valid-baseline-only subset does **not**
   remove the demonstrated canary blocker.

This leaves the full-array path and native response assembly untouched. If compact
pending-refreeze finalization cannot preserve R1 or cannot fit the hook fence, keep
preparation non-serving and leave the canary blocked. Do not “fix” the witness by
making full-array behavior adopt the earlier cut. Add the immutable-row cache and
native fragments only as a separately reviewed ratio optimization once the
preparation contract is proven.

## Executed witnesses and verification

All witnesses are gated by `MC_HOOKCOST_REVIEW=1`; without it they return before
fixture work. They are positive counterexample assertions, not fault-injection
proofs for an implementation that does not yet exist.

Command, run on Linux with **4 vCPUs**:

```text
rustc --version && cargo --version && MC_HOOKCOST_REVIEW=1 cargo test -p mc-module hookcost_review_ -- --nocapture
rustc 1.99.0 (b940084d7 2026-09-28)
cargo 1.99.0 (5f94df478 2026-08-27)
```

Captured substantive output (the run executed three tests, not just a filtered or
skipped suite):

```text
typed durable CompactionMessage and Value response compaction are JSON-equal but byte-unequal; substituting the durable fragment changes the encoded answer
hookcost_review_durable_wire_fragment_is_not_response_wire_fragment ... ok
covered#0: engine tag=None, hook tag=Some(1), tokens=0; baseline generation 1 -> 2
hookcost_review_covered_tag_forces_hook_refreeze ... ok
before next message: prewarm baseline_len=1; after next message: cold baseline_len=9, warm baseline_len=1; reclaimable tool outputs cold=1 warm=0; equal effective totals but different channel-1 append bytes
hookcost_review_eager_refreeze_before_append_changes_hook_bytes ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 1955 filtered out
```

The raw-fragment witness uses only a temporary store. The policy witnesses use
in-memory projections/metadata and the shipped policy computation; they emulate
baseline publication explicitly and do not introduce a prewarm implementation.
No pre-existing tests were weakened or expectations inverted. No manifest or
lockfile changed. `cargo fmt --all -- --check` also passed on Linux with
`rustfmt 1.10.0-stable (b940084d7e 2026-09-28)` (silent-on-success exit 0).
The large controls named by the design were inspected, not all
rerun; no live canary, performance rerun or crash-injection implementation was
attempted. The measured counterexample is sufficient to reject the eager-refreeze
composition, not to certify a corrected design.
