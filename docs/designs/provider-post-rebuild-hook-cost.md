# Provider post-rebuild hook cost: cache descriptors and prewarm

Status: proposal for review, **not authorized for implementation**. The canary
remains blocked; there is no 1.10× rebuild sign-off. P2 denotes the performance
criterion that provider rebuild p50 is no more than 1.10× a full-array transform
starting from the same durable snapshot. ALF is the owner's long-lived session
intended for the live canary. Deadlines, served bytes,
configuration defaults and migrations stay unchanged.

## What the profile establishes

The 17k-message Linux driver completed five byte-equal OpenCode 1 rebuild pairs
and three OpenCode 2 pairs before the next hook refused. That hook took
**1,493.849 ms inside the module**, leaving **6.151 ms** of its 1,500 ms fence for
transport and host work. The host timed out. A later contended rerun recorded
1,621.088 ms of module time and also refused. Refusing is correct: the previous
behavior could publish an untagged append while the module committed its tag.
The rebuild itself has a separate 30,000 ms budget.

| Work | Measured time / evidence | Where it runs now |
| --- | --- | --- |
| Replay stored messages and non-tag hook ops | 92–110 ms on applied rebuilds | `execute_host` |
| Prepare request, materialize previous views, resolve drops | 1.20–1.59 s | `execute_host`, before the engine |
| Engine | 4.32–5.52 s | rebuild step |
| Native view encoding | 1.15–1.35 s | rebuild step |
| First post-rebuild hook | outliers at 1.494 / 1.621 s, about 75k provider SQL result rows | hook transaction |
| Steady hooks (no policy rewrite/refreeze needed) | bounded-summary replay; prior 17k synthetic ordinary median ≈2 ms, documented in the performance-gate report | hook transaction |

These are contended diagnostic samples, not clean p99 estimates. A later byte-equal
OpenCode 1 pair measured 14,667.265 ms provider / 8,200.335 ms full (≈1.789×),
but stopped before a complete population. Internal hook
sub-stage times have not yet been measured independently; the 1.494 s must not
be invented as separate decode/tokenize/write numbers. **View materialization is
rebuild work, not work performed by the first hook.** It is a separate contributor
to P2 and competes for the same machine resources.

The first hook's full path is identifiable in the code. An engine policy rewrite
invalidates the bounded summary. `policy_summary::channel1_inputs` then reads all
effective parts, JSON-decodes and orders them, computes the full channel-1 inputs
and baseline, and builds window/arc/hint summary state. If the baseline generation
changes, the hook serializes all baseline measurements; its transaction restates
changed measurement rows, saves the new summary and clears the accounted change
log. Engine and hook measurements disagree for some parts whose messages are
already represented by the compacted head, so an engine
baseline cannot simply be reused as a hook baseline. The next profile should
split these reads/computation, baseline conversion/restatement and summary-write
stages, including serialization and lock wait.

## Proposed design

### 1. Disposable, bounded immutable-view cache and descriptors

Keep the existing durable immutable view row as authority. Cache raw serialized
view bytes plus compact engine/native offsets and descriptors, rather than an
unbounded decoded JSON graph. Initially permit at most the applied and produced
view per conversation, with a global byte limit and LRU eviction. Account retained
buffer and descriptor capacities, not just serialized lengths; an oversized entry
uses the uncached path. No limit changes the answer.

The key includes store instance/lease identity, project/session/harness,
compaction id and immutable version, codec/encoding identity, and the reference's
lineage/range/cut. A descent may share immutable bytes but has its own validated
range descriptor. Do not carry cache entries across store replacement, reopen,
reset, namespace/config/codec changes, invalidated views or missing durable rows.
A new produced/applied reference evicts obsolete entries. Restart starts empty.

The compaction interface should consume metadata descriptors for lineage/version
checks before requesting payload bytes. A changed candidate digest can establish
inequality cheaply; an equal digest must still use exact byte comparison, never
hash equality alone. Rejected-view and `matches_served` checks retain their
current semantics. Cache raw native fragments only when their sidecar, rendered
content, protected/signed-thinking ownership and codec inputs all match. Do not
reuse an old tail merely because its message id is unchanged.

Preserve response and served-message key order, escaping, unknown fields and
signatures. Moving from typed/Value serialization to raw fragments is not
assumed byte-equivalent: it needs an independent byte oracle, including response
assembly and final host output. The existing one-row applied/produced decode reuse
is a preliminary reduction, not this descriptor/cache implementation.

### 2. Prewarm the exact next ordinary-hook policy during the rebuild

Run prewarm **inside `host_step`, after the engine's provider-policy changes are
durable and before the completed rebuild answer is serialized**. Its time is
therefore inside the 30 s rebuild budget, not hidden background work or a larger
hook deadline. It runs even if the host later rejects/loses the view; its cache is
derived from the committed engine state, not from an invented acknowledgement.

Prewarm uses the same effective lineage, engine namespace/coverage, resolved
protected-token floor, protected-tool window, model calibration, baseline
generation/length and hook-compatible part measurements as the uncached hook.
Validate the summary's lineage/settings/baseline key against current inputs;
`transform::channel1_inputs_from_parts` over every effective part remains the
independent full-computation reference. Prewarm computes
only reusable inputs/summary state: **no tag allocation, hook answer, cadence
advance, hint delivery, served watermark or historian barrier**. Publish baseline
restatement and summary atomically in a fenced transaction; failure leaves no
partial summary. Changes between engine commit and prewarm must be accounted for
or cause a retry/refusal, not a stale cache publication.

The subsequent hook admits its real message, applies changed-row replay and makes
its normal decision. Prewarm cannot predict that message's carrier, temporal
permission, hints or operations. Existing key changes, ancestry/cut changes,
consumed tags, logged-change cap/ordering failures and untracked window/arc/hint
members invalidate or rebuild the summary exactly as today. Cache-busting hooks
still take their exact path; they must not silently use an ordinary prewarm.

A safety-first prewarm that rereads everything merely moves ≈1.5 s into rebuilds
and may **worsen P2**. The performance version should share the rebuild's parsed
policy parts/projection traversal and construct hook-compatible measurements once,
without substituting the engine's different measurements. This requires an
explicit data handoff/summary publication API; do not expose or mutate full-array
behavior to obtain it. If sharing cannot preserve the full oracle, retain the
uncached computation and report the missed target.

## Acknowledgements and byte-identity proof

No wire acknowledgement changes are proposed. The host still durably commits the
issued fence and applies a validated view before acknowledging it. Prewarm and
cache fill do not mark a produced view applied or advance a served frontier.
Lost/late answers, non-structural retries, structural rejection, repeated request
ids, descents and crashes continue to use the durable view/version receipts.
Missing/corrupt/evicted cache data reloads authority or visibly refuses.

Acceptance needs cache enabled/disabled differentials over exact encoded answers,
acknowledgements, final served requests **and functional stored state**. Retain the
768-pass randomized/HARD comparison, 90-check host suite, 706-pass signed-thinking
comparison and bounded-policy identity controls. Add restart/eviction/oversize,
all cache-key invalidators, summary rollback and crash cuts around engine commit,
prewarm publication, answer serialization and host acknowledgement. Force the
1.5 s timeout and prove refusal or a provably exact replay. Mutations must neutralize
key components, return stale descriptors, omit restatement and publish before
commit; each corresponding named byte/state check must fail when its mutation is
applied. An equality test over parsed JSON alone is
not sufficient for ordering/escaping/signature preservation.

## Expected numbers and rollout blocks

Planning targets, **not measured promises**:

- Post-rebuild ordinary-hook module p99 ≤250 ms, with a stretch goal ≤50 ms;
  end-to-end hook p99 ≤500 ms leaves ≥1,000 ms against the unchanged 1,500 ms
  fence. Measure failures as failures, not successful latency samples.
- Paired rebuild/full-array p50 ≤1.10×. With a 6–7 s full baseline, all additional
  provider work must fit roughly 600–700 ms. Avoiding 1.2–1.6 s of prior-view
  materialization and sharing the full policy traversal are necessary candidates;
  prewarm alone is not evidence of meeting this budget. Report P2 including
  prewarm, persistence, response encoding, sync/drain and actual output publication.

Use clean same-allocation paired snapshots, record load/permit holders, and retain
five byte-equal pairs per binding. The present contended run cannot establish
those quantiles. Separately blocked are incomplete background byte/page ledger
and historian cadence, total SQL/logical-write coverage, raw response-wire bytes,
physical/hash provenance and timestamp-bound canary event/capture continuity.
Full-array stored-state differential proof and reconciliation merge/rerun are
still required. Neither this proposal nor the diagnostic meters authorize
switching on the provider pipeline for the ALF live canary.
