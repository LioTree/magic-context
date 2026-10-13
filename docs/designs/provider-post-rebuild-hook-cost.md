# Provider post-rebuild hook cost: shadow preparation and admitted-cut finalization

Status: measured profile plus revised plan. Publishing a refrozen baseline before
the next message changed its cut; splicing durable typed JSON into a step answer
changed its bytes. That earlier proposal was **rejected** by the accepted review in
`docs/reviews/provider-post-rebuild-hook-cost-review.md`. No revised preparation
or consumption implementation is included in this revision of the plan. The next
increment is authorized in the sequence below; offline proofs precede any rollout.
The canary
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

## Revised smallest safe step (review R1–R5)

There is **no view cache, descriptor renderer or native-fragment splicing** in
this work. The R2 witness proves that durable typed `CompactionMessage` JSON and
Value-serialized step-answer JSON are equal as objects but unequal as bytes.
R4 additionally found that a view-row locator omits native rendering dependencies,
including signed-thinking ownership across the whole prefix. Both problems are
excluded here; any later view/native ratio optimization needs a separate review.

### 1. Monotone store policy revision before preparation

Add the next contiguous unreleased store migration and a namespace-scoped,
monotone provider-policy revision. Every write affecting ordinary-hook policy
inputs must bump it **inside the same transaction**: policy parts and their
measurements/protection, conversation settings/calibration/baseline, tags and
consumption, lineage/cuts, bounded summaries and change-log insertion/clearing.
Namespace rewrites invalidate every sharing conversation. Rollback rolls back
its bumps; overflow must fail rather than wrap or silently convert the counter to
a floating-point SQLite REAL value.

Use transaction-level SQL triggers where possible so other processes/direct SQL
writers cannot bypass a Rust call-site convention. Inventory all affected tables
and write paths, including deletion/reset/revert/namespace changes, in
`docs/reports/provider-policy-revision-write-sites.md`. Tests exercise each writer and fail if a policy write
skips revision advancement. Derived preparation storage is separate: writing
its cache entry does not change the cold policy inputs or recursively invalidate
its own revision key.

Store lease/schema fencing, a settings key and a maximum ordinal are not revision
validation. Every policy write listed above must bump the revision before a
preparation can be considered consumable. Do not replace that counter with a
full-policy reread/comparison inside the production hook.

### 2. Side-effect-free preparation after engine commit

Add a provider-only preparation API inside the existing `host_step` critical
section, after the engine's policy transaction commits and before the step answer
returns. Do not release the conversation guard, spawn the preparation or create
a historian barrier to move its cost out of rebuild timing.

Read a consistent policy snapshot and keep the **original** frozen baseline,
its part measurements, generation/length and newest existing-message boundary.
Also retain the effective ordered parts, trusted policy settings and a snapshot
revision token described below. Running today's pure full computation at this
point may report `needs_refreeze`; its resulting earlier-cut baseline is only a
diagnostic and must never become the original baseline for the next hook.

Preparation is disposable derived state, capped by part count and measured
retained bytes, with at most one pending entry per conversation and a process-wide
budget. A cap, restart, eviction or unsupported snapshot discards the entry and
uses the exact current path. Persist only a derived preparation row keyed by the
policy revision and retained original baseline/newest boundary; do not publish a
normal hook summary, baseline or change-log checkpoint before admission. Prepared
aggregates/measurement material must finalize the actual cut without a full policy
reread or equality verification in the production hook.

No tag allocation, operations, cadence/grace update, hint, historian work,
receipt/version allocation, served watermark, acknowledgement or policy write is
permitted. Do not call `commit_provider_hook_with_parts` as a shortcut: it also
admits/promotes/burns data. Shadow preparation cannot change the later
`save_host_setup` counters or be overwritten by a stale local conversation save,
because it has no durable counters to save.

### 3. Revision-checked finalization at the actual admitted cut

At the real hook, compare the stored preparation revision with the current
namespace policy revision **before that hook's own admission mutations**. Any
intervening writer, namespace sibling, settings/protection change or log update
that makes them differ takes today's exact cold path. Under the normal fenced
hook transaction, replay the actual admission/promotion/burn changes made by that
hook itself, finalize pending refreeze against the retained original baseline and
the actual admitted newest cut, then commit through the existing hook write path.
The hook's own changes advance the revision atomically with the same transaction.
There is no O(session) shadow verification or independent cold recomputation on
the production hook path.

Before the hook, pass synchronization can ingest the newly observed policy parts;
those writes advance the revision and cause a conservative cold fallback. Do not
ignore them or rebase a preparation onto an unverified snapshot just to obtain a
cache hit. Subsequent optimization of such misses requires its own exact replay
proof. Model/calibration, carrier, hints, cadence/grace and cache-busting permission
remain the real hook's decisions, not predictions from the per-step status record
available at preparation time.

A revision miss, changed ancestry or unaccounted consumed tag, replay cap/order
failure, cache-busting pass or unsupported delta follows today's exact computation
and existing refusal behavior. Never restore a stale baseline, clear newer log
rows, claim a larger hook deadline or modify full-array behavior to fit the cache.
If consumption is eventually authorized, final baseline/settings/measurement and
summary changes commit only through the normal hook transaction, with its existing
rollback semantics and exact accounted frontier.

The cut rule from review R1 is non-negotiable. On
`hookcost_review_eager_refreeze_before_append_changes_hook_bytes`, publishing
before ordinal 3 is admitted freezes one part; the cold hook after that admission
freezes nine. Equal token totals are insufficient. Finalization must reproduce
that nine-part baseline, one reclaimable tool output and exact channel-1
reclaim-reminder append bytes.

### 4. Off-by-default consumption; equality proof is offline

A new off-by-default setting gates consumption. With it off, the cold hook remains
authoritative, answer bytes and functional policy state match today's behavior,
and no extra O(session) verification is added to the production hook. Preparation
remains non-serving derived data; its work is inside the 30 s rebuild budget and
its costs are explicitly measured.

The equality proof runs offline: copy the durable session snapshot before rebuild
into two isolated stores, run preparation/finalization in one and the untouched
cold hook in the other. Compare the
prepared/finalized first hook with the untouched cold hook: ordered baseline parts,
measurements, baseline generation/length, summary, full encoded answer and exact
channel-1 append bytes. Use the real hook's current cadence/grace state, not a
prepared or advanced state. A miss/cap/cache-bust follows the exact cold path; a
comparison failure blocks rollout, not a hidden rewrite of the cold reference.

No product shadow reread/recomputation is used to certify equality inside the
1,500 ms hook. No consumption enablement in any live session is included in this
work. Preparation, normal finalization and their revision bumps are separately
timed with Linux pressure-stall information (CPU PSI) and load averages. First
post-rebuild p50/p99 with consumption enabled determines whether reuse is useful;
no current result claims it is.

## Acknowledgements and acceptance

Acknowledgements, receipts, immutable view eligibility and step response encoding
are unchanged. Preparation neither marks a produced view applied nor advances a
served frontier. Lost/late answers, structural rejection, descent, restart and
missing preparation use the durable normal path. No native fragments are consumed.

Keep all three accepted review witnesses as written, with
`MC_HOOKCOST_REVIEW=1`: eager-refreeze-before-append and covered-tag refreeze in
`step_transform_parity_tests.rs`, and durable/response fragment inequality in
`compaction_review_tests.rs`. Add a positive warm/cold test using the exact
`hookcost_review_eager_refreeze_before_append_changes_hook_bytes` fixture. The negative
witness must still demonstrate one versus nine parts for eager publication; the
new deferred path must match the independently captured cold nine-part result
and append bytes after ordinal 3 is admitted. Add covered-tag mismatch, consumed
shared tag, namespace sibling commit, ancestry/cut, cache-bust, overflow/cap,
restart and changed-log-frontier cases.

Acceptance splits twin arms from the **same pre-rebuild durable snapshot**, then
runs rebuild and advancing real hooks with preparation off/on. Compare exact
encoded hook/step answers, full served requests, acknowledgements/receipts and
functional stored policy state at each cut. Do not compare two paths after both
have both adopted a baseline published before the actual new parts are admitted,
derive the expected value from the prepared
result, or accept parsed JSON equality as byte equality. Verify zero preparation
writes and unchanged cold output/state with consumption disabled.

Mutation controls must publish the baseline early, omit the newest admitted parts,
ignore a revision component, clear unaccounted changes and consume preparation
without validation. Their specific byte/state tests must fail. Retain the 720-pass
randomized plus 48-pass full-rebuild (HARD) tests in `step_transform_parity_tests.rs`,
`pure-replay-differential.ts --provider-pipeline` (90 checks), the 706-pass
`signed-thinking-differential.sh` audit and bounded-policy byte-identity controls
before any consumption enablement. Include cuts after engine commit, preparation,
real admission, normal baseline write, answer serialization and host acknowledgement.

## Timing targets and blocked work

The measured first-hook cost is predominantly reading/decoding all parts plus
baseline conversion/extraction/restatement, not the 573-byte summary write. The
revised experiment must report how much of that work preparation can safely reuse
at the actual admitted cut. Initial shadow mode is a correctness experiment, not a
promise of ≤250 ms module p99 or ≤1.10× rebuild/full-array p50. Do not infer p99
from five diagnostic samples. Keep the 1,500 ms hook and 30,000 ms rebuild budgets.

The first post-rebuild consumption measurement must report p50 and p99 for the
17,000-message fixture used by `provider-post-rebuild-profile.ts`, recording CPU
PSI/load and sample count, with setting-on/off correctness controls. The plan does not promise ≤250 ms or a useful speedup;
no live setting is enabled until independent review accepts the exactness and
measured benefit.

The new consumption setting is disabled by default. A serving path remains gated on exact R1 reproduction,
same-snapshot byte/state controls, revision-fence tests and useful end-to-end timings
with PSI/load records. View/native caching is excluded and needs its own review
for the ratio criterion. The ALF canary, live consumption, ≤1.10× sign-off and
complete production-meter coverage remain blocked. Background ledger/cadence,
total SQL/write coverage, raw response wire bytes, capture/event provenance and
reconciliation gates remain separate requirements specified in
`docs/reports/provider-pipeline-performance-gate.md`.
