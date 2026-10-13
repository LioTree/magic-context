# Provider-only resident incremental state

Status: **resident boundary approved; offline builder/inventory/schema proposal
only; migration and serving consumption await a separate review**. Ordinary
provider hooks must finish within 10 ms in the Rust `ck-mc` module handler
(network excluded); a provider
fold/rebuild must finish in less than 100 ms. The 1,500 ms product hook fence is
unchanged. TypeScript and full-array Rust (mode 2) are out of scope.

The realistic fixture and gap table are in
`docs/reports/provider-realistic-rebuild-gap.md`. It has 17,000 stored messages,
16,500 summarized messages, a 500-message raw tail, 2,300 compartments and 1,000
memories. Its large provider working set is **74,800 policy parts**, not 72,000
core frozen units: this fixture's normal fold leaves three stored frozen units. No
historical frozen payloads have been invented to imitate another engine's state.

## Why a renderer cache alone is insufficient

The current provider rebuild reconstructs the entire stored lineage, its overlays,
and prior views, then calls the full-array engine. That engine rewrites provider
policy and invalidates the bounded summary. The first hook can refreeze and write
measurements for tens of thousands of parts even when its input is one new part.
Compartment rendering is only one contributor. The proposed boundary is a new
**provider fold operation over maintained state**, not a cached invocation of
`transform_with_projection` with the old full-array inputs.

The following items state the approved effective-identity and bounded-output
contract used by the offline builder and the later serving design:

1. **Durable measurement representation.** Exact served bytes, acknowledgement
   bytes and every effective per-part measurement, policy decision and baseline
   scalar read from durable authority must remain unchanged. The owner approved
   generation/cut overlays and point overrides instead of eager physical-row
   restatement, provided **every reader** resolves through them, including export,
   diagnostics and dashboard paths. Literal private-cell identity is not the gate;
   every effective measurement remains an independent per-part assertion.
2. **Bounded output and delta.** No implementation returning a complete JSON answer
   can have a constant time bound independent of arbitrary output size or of an
   arbitrarily large mutation. It must at least write the answer's bytes. Normal
   all-tier decay at 2,300 compartments is explicitly in the <100 ms population
   and must use cached per-tier fragments. Truly unbounded body/all-new-content
   changes after model/renderer upgrades have separate measured bounds, never a
   hidden deadline increase.

No migration, resident serving cache, baseline overlay or response protocol change
has been implemented in this increment.

## Resident state and ownership

One namespace coordinator owns the engine snapshot shared by all conversations in
that engine namespace. Conversation actors own admission/receipts and lineage
references. This is stronger than a conversation-only mutex: two conversations
sharing an engine cannot publish incompatible resident snapshots. All writes use
the existing fenced store lease and durable transaction; memory becomes visible
only **after commit**. Producing a compaction response does not prove the host
applied it: only the host's validated id/version acknowledgement promotes the
produced view to applied.

Use immutable paged structures / `Arc` snapshots with bounded copy-on-write deltas,
not a deep-cloned array of 74,800 policy parts on every hook:

| Resident component | Contents / incremental owner |
| --- | --- |
| Authority header | Store-instance/lease identity, namespace, conversation tuple, accepted store/schema version, lineage ancestry/cut, policy revision, engine row version, incorporated event frontier, output version and served watermark. The coordinator advances it after the successful transaction. |
| Tail | Only unsummarized native `Value` objects, decoder sidecars and CK projection/coordinates; native envelopes, ignored/structural parts and unknown fields stay intact. Hook/pass admission appends or replaces the exact new subject; a proved descent truncates by ordinal. |
| Tags and treatments | Block/tag-number lookup, immutable source identity, served/active/protected/queued/consumed flags, tool-arc ownership, and historical treatment locators. Admission, acknowledgement, burn/drop, consumption and protection changes update only affected entries. Exact previously emitted reduction/drop payloads remain durably addressable for descent/retry; a rebuild does not replay their original covered raw messages. |
| Policy index | Header/nonheader ordering, prefix sums, baseline-generation/cut descriptors, exact measurement hashes, window/tag groups, tool-arc aggregates, real-user counts and ordered hint candidates. A hook updates new/changed parts and the affected groups/arcs. Preserve the original baseline until the actual admitted newest cut is known. |
| Render fragments | Exact compartment text and token counts per supported tier, plus memory/profile/doc fragments. Historian/domain events update content revisions; hooks only ingest their revision/delta events. Tier choice is separate from fragment identity. |
| Frozen output | Accepted frame/tail chunks and native-context decisions, including whole-prefix signed-thinking ownership. Fold replaces only changed chunks; hooks do not reinterpret accepted frozen bytes. |
| Decision state | Live calibration/model permission, cadence/grace, temporal timestamps, carrier, hints and scheduler scalars. Compute the real hook decision; do not cache operations. |

Proposed retained-memory caps: 128 MiB per namespace actor and 512 MiB process-wide,
including shared allocations once, keys, capacities, pending copy-on-write pages
and in-flight responses. These are reviewable caps, **not measured size claims**.
The fixture must fit after measured retained-capacity accounting. Persist covered
payload pages and evict cold pages/actors without retaining authority through a
cache entry. A cap miss cannot cause a full-lineage replay disguised as a fast
hook; it must trigger checkpoint recovery/admission backpressure under unchanged
product fences. Decide the cold-admission contract before enablement.

## Complete validity keys, not message-id caches

Every hit requires the current authority header and a complete key. A digest is a
locator; collision-safe equality or immutable durable identity establishes the
input. Namespace/reopen/reset/lease replacement and renderer upgrades invalidate
old memory. External writers must advance a transactionally maintained revision
or append an accounted change event; in-process conventions alone are insufficient.

| Cached object | Required key / invalidation |
| --- | --- |
| Compartment fragment | Renderer-format version; exact tuple of every renderer-read field (sequence/order, bounds/boundary id, title, episode/date metadata, importance and full content/p1/p2/p3 including absent/null distinction); selected tier; fixed render options/escaping. Token counts also key tokenizer implementation/encoding version. Model calibration is applied separately unless the estimator itself depends on it. Selection key additionally contains score/history revisions, budgets, pressure and decay settings. Content+tier alone is not a complete key. |
| Memory/profile/docs fragment | Content and revision, project/workspace membership and visibility/classification/sharing, expiry cutoff at the authorized materialization, order, supersession/mutation frontier, category/format, budget, profile version, docs file identity/options, tokenizer/renderer identity. An ordinary hook must not advance frozen expiry. |
| Native render | Exact CK content/shape/order and normalized native sidecar identity/coordinates; serializer, provider/model/system/upgrade/render epochs and mid-turn context; reasoning-clear units, tag map, mutation exemption, lineage anchor, transition-consumed state and kept-thinking mids. Signed thinking means provider-authenticated reasoning blocks. Preserve every preceding native message/part byte as well as the reasoning payload and signature. |
| Policy snapshot | Original baseline identity/generation/length/cut and measurement hashes, lineage/coverage, resolved floor/tool keep map, calibration, protection/queue/consumption facts and namespace policy revision + accounted frontier. Newest-message finalization uses actual admission, never the rebuild's shorter cut. |
| Frozen chunk/view | Store instance + conversation/namespace + immutable view/version/encoding identity and durable eligibility; reference lineage/range separately validated. Missing/removed rows cannot be resurrected by a hit. |

Typed durable HostView bytes and Value-serialized step-answer bytes are distinct
representations. Retain separately normalized fragments at those exact stages;
never splice the typed durable wire object into a step response. Setup/step kind,
request id, version/range and coverage form fresh envelopes. No whole-response
reuse, no original transport lexeme reuse, and no changes to durable serialization
merely to make reuse easier.

The independent oracle must compare the following boundaries, not one generic
JSON-equivalence check:

| Boundary | Required identity |
| --- | --- |
| Admitted message BLOB | Same normalized native-message serialization that the old status/hook writer saves, with the same ordinal/id validation. The checkpoint is additional derived storage, not a replacement lexeme source. |
| Hook answer row and counters | Same `ops_json`, answer policy/counter JSON and tag rows at each admitted/served cut, using the existing writer/serializer. |
| Immutable view row | Same typed HostView serialized string at the same id/version/range. A derived chunk buffer does not redefine immutable-row equality. |
| Setup and step response | Full raw response bytes from the old setup typed serializer or step Value serializer respectively, including envelope order, coverage and fresh request/version fields. |
| Final provider request | Exact ordered native messages/parts and the entire prefix before protected signed reasoning; CK canonical-message fingerprints are additional assertions, not substitutes. |
| Measurements | Before any representation approval: same physical per-part measurement JSON. If an overlay is approved: every reader's effective per-part measurement must match the old independently materialized row, not merely its summed totals; raw-table differences must be enumerated rather than hidden in the comparator. |

## Durable checkpoint, invalidation and restart

A proposed provider-only checkpoint stores (1) a small validated authority header,
(2) compact policy aggregates and baseline-generation/cut descriptors, (3) native
raw-tail/projection pages, (4) accepted render chunks and fragment locators, and
(5) indexes/locators for historical tags and treatments. It must be published in
one transaction with the exact event frontier it accounts for. A bounded journal
records admission, answer promotion/burn, protection, lineage, historian,
compartment, memory and calibration changes. Store migration 70's namespace
provider-policy revision covers policy inputs, but is not a complete render/domain
revision vector; it is
necessary but does **not** by itself encode all rendering/domain changes.

Do not treat this as permission to add a migration. First inventory every write
site, including direct SQL, namespace siblings, full-array writers, revert,
reset/import, store replacement and historian/domain transactions. Decide the
schema and obtain approval before building it. Reusing current revision/section
indexes is preferable where they can provide the same contract.

Concretely, the proposed header validates the tuple `(store instance/lease,
namespace engine row version, namespace policy revision, lineage ancestry/cut,
domain revision vector, accounted namespace event sequence)`. The journal sequence
is namespace-wide, not a conversation-local hook counter. Existing engine-policy
rewrites affect every namespace-sharing conversation; they invalidate/recover the
whole coordinated snapshot. Admission, answer promotion/burn, consumption, policy
measurements/settings and their change-log accounting advance the sequence in
their existing transaction. Compartment/history/score, memory/mutation/workspace,
profile/docs and renderer revisions form the domain vector; their exact existing
snapshot cuts must be preserved, not inferred from the policy counter alone.
Where a domain write cannot atomically append the proposed store event, use its
durable revision and indexed delta cursor, validate the snapshot before checkpoint
publication, and retain later changes for the next authorized gate. The write-site
inventory must prove that this covers each writer before calling the key complete.

A baseline descriptor binds the original baseline generation/length and hash to
the admitted lineage ancestry, coverage, actual newest ordinal **and first part
position of that message**, plus the accounted transaction/event frontier. A
header-only new message advances that cut too. After a mismatch, the new descriptor
and measurement overlay publish with the real hook's admission/write transaction;
the earlier prepared projection is never the authoritative admitted boundary.
Overlay reads resolve the generation/cut descriptor first, then point overrides;
part update, move/delete, revert, consumption and namespace rewrite must have
explicit equivalent summary invalidation or replay events. Summed totals alone
cannot establish per-part measurement identity.

On restart:

1. Open only the bound, fenced store; validate checkpoint schema/renderer versions,
   store identity, checksum, namespace row version and accounted revision/frontier.
2. Load the compact working header/aggregates and <=500-message tail. Map immutable
   historical payload/index pages by locator without decoding all prior messages,
   hook answers or policy parts. Load only pages requested by changed/eligible
   groups, not the 17,000-message transcript.
3. Replay durable **events after the checkpoint**, in transaction order, before
   admitting a hook. Journal retention/checkpoint frequency must bound this work;
   unbounded recovery lag is not a 10 ms hook.
4. Missing/corrupt/stale checkpoint: refuse fast consumption and recover off the
   serving request before declaring the actor ready. Do not mint tags, promote a
   view, clear a newer log or serve a stale prefix. A background rebuild of derived
   state may occur during startup, but must be reported as startup recovery cost,
   not excluded from a purported fast first-hook result.

A compact checkpoint restores only the active header and bounded needed pages,
not the whole historical arena. Valid-checkpoint restart is
its own population and targets the same <=10 ms / <100 ms. Missing/corrupt/stale
checkpoints recover off the serving path and refuse with a named retryable code.
Recovery startup cost and refusal count must be reported. Loading the entire cold
legacy state on that first request does not meet this contract.

## One fold gate: what it reads and renders

The hook transaction updates resident delta state and checkpoints its bounded
changes. The fold gate reads the current header/revisions, resident usage and
scheduler scalars, active tail, changed compartment/memory descriptors and pending
treatment/answer events. It does **not** load all provider messages, all hook
answers, a full frozen-state JSON row, all tags or all policy parts.

The gate still makes the same HARD (authorized head refreeze), SOFT (incremental
refresh) or defer (preserve the frozen prefix) decision and preserves model,
protection, lineage, expiry and temporal permissions. It updates ordered
selection indexes and prefix token sums from deltas; cached text does not grant
permission to fold a later historian result into an older frozen view. For
compartments whose selected tier/content did not change, reuse the accepted exact
fragment. For changed tiers, use that tier's independently validated fragment or
render only that compartment. Memory changes update the ordered eligible set;
reordering/budget effects are real deltas, not ignored invalidations.

Use indexed prefix accounting for baseline refreeze at the actual admitted newest
message. Record the original engine baseline and pending mismatch; no earlier
baseline publication. Reconcile affected tag/window/tool-arc groups, then commit
the same scalars, measurements and policy decisions through the reviewed durable
representation. Global changes (model/calibration, protection floor, reset or
all-tier reselection) require separate bounded algorithms or an explicitly
unsupported fast case; they cannot silently call the full-array engine.

Assemble native frames/tail from the preserved normalized chunks and fresh
envelope, then persist the produced immutable view and receipt using their
original representations and eligibility rules. Exact emitted byte count remains
a lower bound on work. The output budget must be measured alongside latency.

## Latency budget and acceptance, not a speedup claim

Budget allocations below are design constraints for the stated fixture, not
results. p99 must cover the entire ck-mc handler including lock wait, transaction,
serialization and publication; network is separately reported. Summing component
p99s is not a total-p99 estimate.

| Ordinary hook work | Budget ms | Required bound |
| --- | ---: | --- |
| Decode/project new subject | 1.0 | New native parts only; record their bytes. |
| Admit/promote/burn and update resident indexes | 1.5 | Delta answers/tags/parts, no old-row walk. |
| Window/arc policy + real cadence/hint/temporal decision | 2.5 | Indexed aggregates and bounded hint refill; preserve admitted cut. |
| Fenced durable delta writes + checkpoint frontier | 3.0 | Fixed-size header and changed records only; no bulk baseline restatement. |
| Ops envelope encoding, lock and publication | 2.0 | Small fresh answer; measured contention, not ignored wait. |
| **Whole hook** | **<=10.0** | Includes first hook after fold and recovery-ready first hook. |

| Fold work | Budget ms | Required bound |
| --- | ---: | --- |
| Revision/snapshot validation and drain changes | 5 | Indexed headers and bounded journal delta. |
| Shared gate, coverage and selection-index updates | 10 | Tail/delta plus logarithmic index queries, not all compartments. |
| Render/tokenize changed compartment and memory fragments | 20 | Real changed fragment bytes; untouched tiers reusable. |
| Native tail/frame finalization | 20 | <=500 raw messages + changed frames, signed prefix intact. |
| Delta checkpoint/view/receipt transaction | 20 | No rewrite of all conversation policy parts; include immutable view bytes and checkpoint bytes in the write measurement. |
| Exact answer assembly/encoding/publication + remaining work | 20 | Measured bounded output, no durable/response fragment substitution. |
| **Whole fold** | **<100** | Leave at least 5 ms headroom; verify real total, not these estimates. |

First implement a read-only resident-state builder and compare its snapshots with
today's provider authority offline. Then a gated provider-only delta hook/fold API.
No serving consumption until the following controls pass:

- Fork **before** each rebuild from identical durable snapshots. Compare complete
  raw setup/step/hook responses, ordered host/provider requests, receipts, tag
  identity/state, baseline scalars and every effective measurement at each cut.
  Retain an independent old Value serializer oracle, not a new encoder on both arms.
- Run `provider-preparation-differential.ts`,
  `pure-replay-differential.ts --provider-pipeline`, the 720 seeded append passes
  and 48 full-rebuild/HARD passes comparing provider and full-engine outputs, and
  the signed-thinking differential. Add long-covered-lineage fixtures, real
  advancing post-tool/user/header/no-carrier hooks, opaque/structural/unknown
  native fields, lexical ordering/escapes and whole signed-thinking byte prefixes.
- Force restart/eviction/cap, missing immutable rows, checkpoint corruption, journal
  gaps, stale publication, sibling namespaces, external full-array commits,
  historian/memory/workspace revisions and lineage cuts. A miss cannot serve old
  state or clear unaccounted changes.
- One named mutation control for each serving change/key: omit a delta/revision,
  publish the baseline before admission, move the newest cut, omit each native
  context input, change a cached compartment's tier/content/date, bypass receipt
  eligibility, splice typed durable JSON into the step, and lose the final counter
  reload. Record the exact failing byte/state test and unaffected controls, with a
  non-empty mutation diff and empty restored diff. No mutation is currently claimed
  for a serving change: there is no serving implementation in this design increment.
- Measure module median/p99 across ages and compartment counts with fixed tail and
  change sizes, then across delta/body sizes. Record retained bytes, response bytes,
  SQL rows/writes, CPU PSI/load, startup/ready-state recovery and refusal counts.
  The target is absolute latency, not a ratio to the full-array side column.

The next review must establish resolver coverage, journal publication and compact
recovery before any migration or serving consumption. Review
`provider-checkpoint-journal-schema.md` and
`../reports/provider-resident-reader-writer-inventory.md`, plus the offline
resident snapshot proofs. The boundary/effective-identity/ordinary-decay and
compact valid-restart contracts are approved; concrete migrations and serving
consumption are not. Until those later proofs and review, the canary remains
blocked and production serving paths remain unchanged.
