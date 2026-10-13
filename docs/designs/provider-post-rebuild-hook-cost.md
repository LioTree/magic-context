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

The whole-stage estimates in the preceding table came from contended runs, not
clean p99 estimates. The sub-stage measurements below identify the hook costs.
**View materialization is rebuild work, not work performed by the first hook.**
It separately affects the P2 rebuild/full-array latency ratio; this profile does
not establish the required ≤1.10× ratio.

### Independent sub-stage profile (2026-10-13)

`provider-post-rebuild-profile.ts` measured five fresh 17,000-message conversations
for each host binding (OpenCode 1 and OpenCode 2),
back to back in one Linux `4c` job, on revision `901b351b6d512fff0ee1b5fe09d128e82ff0a165`.
Bun was 1.4.2 and Rust 1.99.0. Each fixture performed three full-request warmups,
provider bootstrap, one initial policy-warming hook, a five-message publication
and model-switch rebuild, then the measured first post-rebuild assistant hook.
The measured hook admitted the real next message: 17,002 fixture messages,
74,804 effective policy parts and 57,801 baseline measurement updates. Every
hook refroze its baseline, built a 573-byte summary and cleared zero change-log
rows. Every view materialization loaded one 28,245,519-byte immutable row and
cloned its engine representation for both applied and produced references.

Timers existed only in six generated source copies under
`$TMPDIR/magic-context/provider-post-rebuild-profile/`; production source hashes
were checked before and after. Direct calls awaited the real `McHandler` answer
without altering a product timeout or serving a diagnostic response to a host.
`lsof` confirmed that all fixture/oracle databases were under the scratch root.
The test-only assertion that independently recomputes and compares each replayed
policy summary was disabled for timing, matching `provider-pipeline-synthetic.ts`;
otherwise the test would add full-session work not present in production. No
algorithm or write ordering was replaced. The PSI/root-cgroup caveats below apply
before interpreting these figures as clean-run latency.
Raw timings, per-stage call counts, source hashes and pressure snapshots are in
`docs/reports/provider-post-rebuild-hook-cost-profile.json`. Reproduce from this
worktree with `bun packages/e2e-tests/scripts/provider-post-rebuild-profile.ts`
on `linux,4c`; the script creates and instruments only its scratch archive.

All times below are ms, shown as **median [min–max]** over five samples, not p99.
Stages are separately timed operations; hook “other” is the whole-hook duration
minus these non-overlapping timers and includes admission, normal answer/state
writes, serialization, teardown and diagnostic overhead.

| First post-rebuild hook work | OpenCode 1 | OpenCode 2 |
| --- | ---: | ---: |
| Read, JSON-decode and order effective parts | 280.928 [223.678–287.127] | 250.117 [249.374–277.842] |
| `channel1_inputs_from_parts`: inputs + baseline | 134.254 [98.299–139.263] | 114.843 [112.679–151.573] |
| Convert baseline for summary | 31.581 [19.679–39.978] | 24.314 [21.185–30.048] |
| Convert baseline to write-update JSON | 294.176 [205.065–315.636] | 280.550 [261.276–327.094] |
| Extract/clone baseline updates in store callback | 116.862 [82.982–129.703] | 111.379 [97.818–121.931] |
| Restate baseline measurements in SQL | 296.133 [208.053–309.902] | 238.336 [228.782–262.461] |
| Build bounded summary | 70.432 [44.493–76.212] | 54.992 [49.118–76.890] |
| Serialize summary JSON | 0.026 [0.017–0.039] | 0.058 [0.032–0.158] |
| Validate serialized summary | 0.018 [0.014–0.020] | 0.016 [0.015–0.018] |
| Write summary row | 4.411 [2.465–5.248] | 3.175 [2.211–4.219] |
| Clear change log (zero rows) | 0.054 [0.037–0.127] | 0.039 [0.036–0.050] |
| Wait for conversation lock | 0.005620 [0.004238–0.007734] | 0.004188 [0.003977–0.004789] |
| Whole hook | 1,436.334 [996.584–1,481.899] | 1,242.890 [1,178.013–1,390.072] |

The large cost is not serializing the bounded summary or clearing its log.
Baseline conversion/extraction and SQL restatement together are roughly half the
whole hook, with the full effective-part read/decode and input computation next.
A lock-wait fix would not address this fixture. The zero-row clear does not
establish deletion cost for a populated change log.

An earlier estimate attributed **1.2–1.6 s to prior views**; that range actually
covered the entire request preparation, not view loading alone. The independently
measured breakdown is:

| Rebuild preparation work | OpenCode 1 | OpenCode 2 |
| --- | ---: | ---: |
| Whole preparation | 1,300.002 [1,210.168–1,413.297] | 1,454.688 [1,210.832–1,611.944] |
| Native request decode/projection in codec | 507.767 [443.113–548.280] | 559.555 [487.200–623.369] |
| Other work before views, including codec (inclusive) | 513.470 [448.801–560.278] | 569.266 [491.946–633.330] |
| Prior-view SQL row retrieval | 6.848 [6.425–7.954] | 7.843 [6.983–9.762] |
| JSON-decode `HostView` | 295.765 [272.452–318.488] | 336.419 [277.823–474.609] |
| Clone engine for applied reference | 236.273 [217.566–267.928] | 275.195 [217.587–335.731] |
| Clone engine for produced reference | 231.822 [218.067–351.960] | 242.338 [216.367–316.264] |
| Rebase lineage in loaded view | 0.000521 [0.000380–0.000741] | 0.001022 [0.000411–0.002695] |
| Whole prior-view materialization (inclusive) | 773.836 [715.692–877.100] | 880.621 [718.774–1,051.633] |
| Resolve/append pending drops | 0.108 [0.101–0.130] | 0.125 [0.110–0.153] |

The codec row is a child of “before views”; SQL/decode/clones/rebase are children
of “prior-view materialization”. Neither inclusive subtotal is added to its own
children. Per raw sample, preparation is before-views + views + drops, plus tiny
timer bookkeeping. Independently computed medians need not sum to the median
preparation total. Retrieving the row is cheap; decoding 28 MB and retaining two
owned engine clones dominates view work. The roughly 0.5–0.6 s codec work is a
separate preparation cost.

Contention was recorded around each fixture and separately around rebuild and
hook, using `/proc/loadavg`, host/cgroup CPU PSI `some total` and `cpu.stat`.
The host and exposed cgroup PSI deltas were identical in this runner, so each
cell below gives both. `nproc` was 4 throughout; exposed cpuset was `0-31`,
`cpu.max` was absent, and all exposed `nr_throttled` / `throttled_usec` deltas
were zero. These appear to be shared/root cgroup readings, **not proof that the
job itself was never throttled**. Lists of other jobs holding CPU permits are
omitted because the job cannot observe that executor state. PSI percentages use
the caller-observed wall interval, not a fabricated CPU-share correction.

| Binding/sample | Hook ms | Preparation ms | Views ms | Hook PSI Δ µs, host=cgroup | Rebuild PSI Δ µs, host=cgroup | Hook PSI % | 1-min load, measured start→end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| OC1/0 | 996.584 | 1,326.008 | 877.100 | 1,672 | 13,338 | 0.166 | 10.81→9.53 |
| OC1/1 | 1,078.780 | 1,210.168 | 715.692 | 3,131 | 62,668 | 0.288 | 7.71→6.98 |
| OC1/2 | 1,447.363 | 1,413.297 | 852.886 | 11,675 | 142,433 | 0.800 | 6.43→8.26 |
| OC1/3 | 1,436.334 | 1,300.002 | 773.836 | 33,459 | 85,795 | 2.319 | 11.67→12.16 |
| OC1/4 | 1,481.899 | 1,271.576 | 758.003 | 90,689 | 485,677 | 6.078 | 13.19→13.32 |
| OC2/0 | 1,178.013 | 1,450.015 | 880.621 | 1,055 | 100,270 | 0.089 | 15.15→14.49 |
| OC2/1 | 1,242.890 | 1,210.832 | 718.774 | 985 | 23,862 | 0.079 | 12.63→10.88 |
| OC2/2 | 1,213.137 | 1,454.688 | 861.552 | 9,152 | 147,991 | 0.750 | 11.62→11.54 |
| OC2/3 | 1,369.719 | 1,611.944 | 1,051.633 | 25,638 | 326,232 | 1.862 | 11.19→11.32 |
| OC2/4 | 1,390.072 | 1,569.886 | 936.424 | 145,326 | 997,078 | 10.388 | 11.02→11.65 |

There are low-pressure samples, but no blanket quiet-runner or p99 claim. The
stage ranking is useful; production timeout headroom, stored-state equivalence
and the ≤1.10× rebuild/full-array criterion still need their own acceptance
checks. Awaiting the handler directly for this diagnostic does not change the
host's 1,500 ms timeout.

The first hook's full path is identifiable in the code. An engine policy rewrite
invalidates the bounded summary. `policy_summary::channel1_inputs` then reads all
effective parts, JSON-decodes and orders them, computes the full channel-1 inputs
and baseline, and builds window/arc/hint summary state. If the baseline generation
changes, the hook serializes all baseline measurements; its transaction restates
changed measurement rows, saves the new summary and clears the accounted change
log. Engine and hook measurements disagree for some parts whose messages are
already represented by the compacted head, so an engine
baseline cannot simply be reused as a hook baseline. The independent timers
above now separate those operations, including serialization and lock wait.

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

Use clean same-allocation paired snapshots, record load/CPU-pressure deltas, and retain
five byte-equal pairs per binding. The present contended run cannot establish
those quantiles. Separately blocked are incomplete background byte/page ledger
and historian cadence, total SQL/logical-write coverage, raw response-wire bytes,
physical/hash provenance and timestamp-bound canary event/capture continuity.
Full-array stored-state differential proof and reconciliation merge/rerun are
still required. Neither this proposal nor the diagnostic meters authorize
switching on the provider pipeline for the ALF live canary.
