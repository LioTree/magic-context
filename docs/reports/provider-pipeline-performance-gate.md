# Provider pipeline performance gate: verified partial, cutover blocked

## Decision and evidence boundary

The four cutover requirements—ordinary latency (P1), rebuild latency (P2),
logical durable payload limits (P3), and 24-hour cache stability (P4)—are **not
passed**. No read-only ALF session capture or 24-hour ALF canary
was supplied. The owner approved a partial delivery: real-host lanes, a fail-closed
measurement gate, synthetic Mac early signals, an instrumentation plan and a canary
runbook. The canary must wait until the migration branch reaches master and ships.
This slice neither changes defaults nor adds production instrumentation. No operator
database, live configuration, external repository source or model credentials was read.

The host measurement rows name the provider pipeline on OpenCode **1.18.x** and
**2.0.x**, not Pi/OMP. They are **opt-in/excluded from default mode lanes and Rust
hermetic shards**, like `rust-plugin-stage-cache.test.ts`, whose measurement
requires a separately preserved older plugin bundle and therefore runs by hand.
Direct invocation tests routing using durable `host_runner_state`/entries
and tagged bytes at the recording provider, then compare the surviving wire prefix
across two turns. The OpenCode 1 lane checks host descriptors with `lsof`; the
OpenCode 2 runner performs its existing descriptor/write-fence checks.
Live measurement execution remains **blocked** here: the original Linux run reached both tests, but neither passed
its preflight because `MC_E2E_CK_SUBC_BIN` was absent. Supply a complete CI-built
module/daemon pair and the fault variant (`MC_E2E_CK_MC_PREBUILT_BIN`,
`MC_E2E_CK_SUBC_BIN`, `MC_E2E_CK_MC_DRIVE_FAULT_BIN`), matching this source revision,
plus the pinned hosts and `lsof`. These tests do not build an operator's daemon checkout.

```sh
bun test --max-concurrency=1 --timeout 600000 \
  packages/e2e-tests/tests/rust-provider-pipeline-opencode1.test.ts \
  packages/e2e-tests/tests/rust-provider-pipeline-opencode2.test.ts
```

### CI follow-up: opt-in registration, not a compatibility waiver

The reported CI run `38030290063` on `train/check-t2` at the original delivery
commit ran both previously Rust-only rows. OpenCode 2 failed the pinned-version
check; OpenCode 1 failed the nonempty durable-entry assertion. Those failures
were not established as passing locally, so these probes must not claim default
hermetic-shard coverage. The follow-up chooses the explicitly authorized opt-in
registration option: both rows use `tier: excluded` and
`invocation: {ts: false, rust: false}`. The assertions remain intact; no version
compatibility shim or weakened record assertion is introduced. The durable-entry
failure still needs investigation before the opt-in probe can pass.

The manifest continues to cover all 186 test files exactly once, with 67 TS and
59 Rust selections. Its validator asserts that neither measurement probe is
selected for either mode or either OpenCode Rust lane, and includes both in the
exact excluded list. `run-rust-hermetic-e2e.sh` and its shard selector consume
that manifest-derived Rust list; direct/glob `bun test` invocations do not.
An explicit invocation without its matching prebuilt input files throws an
`Opt-in <host> provider-pipeline probe requires <environment variable>` error.
Missing host binaries and unexpected version strings likewise name the host,
the required version family and the observed error/version. OpenCode 2 resolution
is deferred until after those input checks, so it cannot hide the missing-binary
diagnostic behind a module-load failure.

Follow-up verification: `bun run --cwd packages/e2e-tests test:validate-manifest`
on Linux/Bun 1.4.2: **7 passed, 0 failed, 79 assertions**, seven tests/two files.
The scoped TypeScript 5.9.3 check still reports only the two unchanged dependency
diagnostics recorded below, with no new helper diagnostics. This excludes the
probes from default shard selection; it does not claim a new CI run passed or
that either live-host measurement succeeded.

Restored-state verification also ran `bun test
packages/e2e-tests/scripts/select-rust-shard.test.ts`: **two passed, zero failed,
11 assertions**, covering the four disjoint manifest-derived shard partitions.
A staged/restored `NON-VACUITY BREAK` that re-admitted only the OpenCode 1 probe
as Rust-only made exactly `mode manifest validator > derives separate TS and Rust
invocation lists` fail (expected 59 selections, received 60); the other six tests
passed. The mutant changed one manifest file by +3/-3; diff-stat was empty before
mutation and after restore. The final manifest validation again passed all seven
tests with 79 assertions. Neither mutation nor a waived host assertion remains.

The explicit missing-input negative check ran both files with the three prebuilt
variables unset. Both failed before host startup, naming their host and
`MC_E2E_CK_SUBC_BIN`; the command exited 1 as required (zero host-test passes,
two expected preflight failures). The follow-up also reran the required repository
gates on Linux/Bun 1.4.2: build passed all three package builds, typecheck passed
all four package scripts, and lint passed 1,753 files (Biome 2.5.1). `npm run test`
reported **8,111 passed, nine skipped, one failed**, 8,121 tests/760 files. Its sole
failure was the unchanged temporary WASM bundle's unresolved
`onnxruntime-web/webgpu` dependency; no dashboard/Bun change was made here.

## Synthetic Mac signal — not P1 or P2 acceptance

Command, executed on the Mac with its local optimized real `McHandler` test
executable (not a remote binary):

```sh
bun packages/e2e-tests/scripts/provider-pipeline-synthetic.ts /tmp/provider-pipeline-synthetic-t2.json
```

Bun **1.4.2**, Cargo **1.99.0 (5f94df478 2026-08-27)**, darwin/arm64.
The fixture has **17,000 messages**, **10,200 tool-bearing assistant messages** and
**20,400 completed tool parts**. Each five-message cycle contains one user, three
assistants with text plus two tool results, and one final assistant. Prose/output
is deterministic fixture content; this is an explicit density assumption, not a
measurement of ALF's live distribution. The context window is 4,000,000 to keep
fixture pressure from being confused with engine throughput. There is no live
OpenCode subprocess in this replay: both host bindings use the real adapter and
real module test handler over a JSON-lines pipe, with isolated stores.

Original synthetic performance replay (T2), before the identity fix (five
full-request engine+codec samples per binding, including the cold
first sample; nearest-rank quantiles):

| Synthetic binding | full-request engine+codec p50 | p95 | Provider ordinary / rebuild |
| --- | ---: | ---: | --- |
| OpenCode 1 | 1835.369 ms | 35942.171 ms | blocked at bootstrap |
| OpenCode 2 | 2423.781 ms | 23248.332 ms | blocked at bootstrap |

The original OpenCode 1 and OpenCode 2 switch attempts returned exactly:

```json
{"code":"transient","message":"CK message block identity drift for mid synthetic-16998"}
```

The last successful step answer before that refusal was `wait`, reason
`Awaiting the next host status page`, `bound_ms: 1`. The test handler then refused
the final `compaction.step` carrying `prefix_rebuilding.reason: pipeline_switch`.
That replay recorded the refusal and left ordinary/rebuild statistics **null**;
it does not time full-request fallback as a provider pass. Its diagnostic process
exit 0 means the report was produced, not that the performance gate passed.
The identity mismatch is resolved by the follow-up below; the drift refusal has
not been waived. The earlier user-text-only bootstrap fixtures did not exercise
the same protected assistant identities.

An exploratory incremental-ingest alternative (about 5,667 three-message passes)
hit the 30-minute cap before emitting results. It was stopped, not counted as a
measurement. The final driver uses a bounded bootstrap instead; it never retries
that timed-out alternative. No live store was involved.

The reusable script measures provider adapter entry to native output installation
(`publishMessages` uses `splice`, not property assignment), including the fixture's
sync seam, before recording/serializing the served corpus. It gathers 20 ordinary
samples after three warmups, with three appends each. The fixture clock advances
between turns instead of assigning every request the same timestamp.
Rebuild comparisons publish a completed historical cycle and append an assistant
with a new model key, then copy both isolated fixture databases (`store.db` cache
and `context.db` authority) using `VACUUM INTO`, outside the timer while the handler
is idle. Both arms must perform the same visible HARD rebuild and serve equal
output. A returned but unapplied view, timeout or fallback is not a P2 sample.
However, full-request timings include engine, codec and pipe rather than the
complete legacy host handler; sync is a no-change fixture seam and there are no
mirror pages. Hook round-trip samples are **not module-only timings**. Those
limitations prevent claiming the same-store live P2 comparison
or the sync/mirror-inclusive live P1 measurement requested by the spec.

### Bootstrap identity diagnosis and source fix

The deterministic small reproducer is **two assistant messages**, with **one
completed tool part** in the first message and a completed text-only second
message. The first message can contain only the tool: parallel calls, attachments,
many parts and an unfinished newest assistant are not necessary. Seed it through
the full-request handler, publish a compartment covering ordinal 1, run the full
handler again, then switch pipelines. Without the fix, the final
`compaction.step` with `prefix_rebuilding.reason: pipeline_switch` refuses
`CK message block identity drift for mid covered` on both bindings. Publication
provides a small, deterministic protected identity without manufacturing a large
context or editing cache rows. Unprotected small tails can instead re-adopt a
different identity, hiding the incompatibility.

The refusing path is `providers::compaction` into the transform engine's
`apply_once`, then `enforce_block_identity` → `identity_drift_requires_reject` →
`TransformError::IdentityDrift`. The display implementation supplies the exact
error string. The source identity vector is stored in `mc_block_identities`
(`mc-store/src/lib.rs`); provider ingestion/publication also compares those vectors
in `mc-store/src/provider_log.rs`. Stored/incoming ordered-vector equality, and
transform rejection for covered messages, boundary anchors or frozen-unit targets,
are unchanged.

The disagreement is the **CK block serialization**, not a reordered call/result
arc or a prematurely identified newest message. Full-request TypeScript ingress
supplies parsed CK JSON without Rust codec metadata and without the default-false
`provider_executed` tool flag. Native provider decoding adds
`provider_extras._cortexkit_codec` (`blockIndex`, `nativeIndex`,
`decodedFingerprint`) for lossless native-part alignment, and serializes typed
fields in a different key order, including the false tool flag. The projection
previously fingerprinted that complete stamped serialization as source identity.
For the isolated `tool` fixture (`assistant response`, call id `tool-call-1`,
empty input, output `tool output`), the exact conflicting SHA-256 values were:

| Block | Persisted full-request/TS identity | Old native-provider identity |
| --- | --- | --- |
| text | `317feebdeae7407eb2e8f1be42afd5696e09bd9404a75e8f9e8188e6f22caa0d` | `5501e71f04452e47dd660c447944698c0185b98d114b15259799399be50b3855` |
| tool_call | `6707a48c7d0b32532cc10776b580e4050c65096ca42ec4a7ba4d4a94d9e416a9` | `0a39becdc242c774d3fda692f85308a92605c8691d036d05734b7926403dd0d8` |
| tool_result | `f3e9b44238d3fd7d4a1949418673a2fc33b5333d20d1003fdcc2117512683626` | `07db854df13ad18fc1b1da10bdbd800f60395758bd7a4a208b45188f7ba75659` |

`providers/codec_opencode.rs` now marks the message-level identity profile, and
`ck_wire::block_identity_fingerprint` reconstructs the legacy sorted source JSON
for that profile only. It excludes private block-origin coordinates and the
omitted false tool flag; real content, true flags, and non-codec provider extras
remain in the identity. Block bytes, `content_hash`, native origin stamps and
other decoder callers retain their old representation. No stored row is rewritten
to excuse a mismatch, and no check is weakened or bypassed.

The new differential switch case also covers two parallel tools, a result with a
PNG attachment, 32 tool parts in one message, and an unfinished newest assistant
whose tool result is complete. It requires no fallback, byte-identical serving,
and unchanged persisted identities (not re-adoption). A separate changed covered
tool-output case still refuses with the exact drift error. Rust controls pin
legacy/native identity equality and detect changed output, input, call id, tool
name and a true `provider_executed` flag.

Two restored mutation runs replaced the source identity basis with the old
stamped-wire hash. Only
`providers::codec_opencode::tests::opencode_source_identities_match_legacy_tool_ingress`
failed in the two-test Rust run; the content-drift test stayed green. Only
`OpenCode1/A10.legacy-tool-identity-switch` failed in the two-case adapter run,
with the provider rebuild request (`compaction.step`) refused for a covered
source-identity mismatch; the intentionally changed tool-output refusal case
stayed green. Each run had a one-file diff (+2/-7) while mutated and an empty
unstaged diff after restoring the staged live source.

### Follow-up synthetic P1 result; P2 remains blocked

Final command (Bun 1.4.2, Cargo 1.99.0, darwin/arm64, local optimized handler):

```sh
bun packages/e2e-tests/scripts/provider-pipeline-synthetic.ts /tmp/provider-identity-t2-delivery.json
```

Both **OpenCode 1 and OpenCode 2 bindings complete the provider switch**, with
17,000 base messages, 10,200 tool-bearing assistants and 20,400 completed tool
parts. Ordinary samples contain three appends and no fallback. These are
**synthetic measurements, not real-host or ALF acceptance**:

| Synthetic binding | Ordinary samples | P1 p50 | P1 p95 | Hook round-trip samples / p50 / p95 | P2 |
| --- | ---: | ---: | ---: | --- | --- |
| OpenCode 1 | 20 | 2670.971 ms | 3608.649 ms | 100 / 426 ms / 1139 ms | blocked |
| OpenCode 2 | 20 | 2150.691 ms | 2795.513 ms | 100 / 332 ms / 823 ms | blocked |

These ordinary-pass results exceed the P1 thresholds; completing bootstrap is
not performance acceptance. P2's five applied-view pairs were not obtained, so
`provider_rebuild` and `rebuild_vs_full_ratio` remain **null**, not fallback or
timeout timings. The only full-request rebuild sample per binding was 41770.998 ms
and 41785.057 ms respectively; a one-sample population is diagnostic, not a P2
quantile. The first provider attempt installed output after 31071.319 ms / 30717.605 ms
without applying a new view. A late `compaction_message` arrived on both bindings;
the subsequent diagnostic retry also failed to apply within its budget.

### Separate large-rebuild deadline diagnosis — not fixed here

The remaining stop is **not block identity drift, status-frame oversize or an
unfinished newest assistant**. The adapter's model-switch path calls
`ProviderClient.bootstrap` (`opencode-adapter.ts:1328-1363`), with the
30,000 ms bootstrap budget supplied at `opencode-adapter.ts:327,431-437`.
`ProviderClient.page` uses that budget for the request fence
(`provider-client.ts:790-803`). In `ProviderClient.send`, the timer expires while
the module call is outstanding (`provider-client.ts:532-563`); the aborted-call
catch returns `unavailable`, reason `timeout` (`:583-589`). The adapter's
`answer` returns false without applying a view (`opencode-adapter.ts:703-710`),
and `bootstrap` ends the attempt (`provider-client.ts:866-868`). Ordinary hooks
can still succeed and the existing prefix can still be served, with no module
error or full-request fallback in the fixture.

A read-only runtime wrapper around the real client methods observed a **701/702
byte status request**, 30,000 ms remaining budget, and timeout returns after
30000.969–30007.022 ms. This rules out the 3 MiB frame cap and pagination as the
stop in these runs. Draining the isolated handler's outstanding reply produced a
late `compaction_message`: the engine does finish, but the timed-out host attempt
does not apply it.

There is **no message-count predicate or deterministic size threshold** in this
path: the condition is response latency exceeding 30 seconds. The smallest
deterministic existing control has **one message**, with its real reply delayed
30,050 ms (`A10.bootstrap-timeout-full-request-late-retry`, still green). For
unmodified tool-dense workload probes on this machine, 7,500 base messages completed
all five rebuild pairs on both bindings (provider p95 7565.098 / 7805.188 ms).
The **smallest tested failing dense corpus was 15,000 base messages** on OpenCode 2,
at the first rebuild after 24 ordinary appends plus one model-switch append
(15,025 total messages, 18,000 base tool parts). OpenCode 1 completed all five at
that size. Both 16,000 and 17,000 base-message probes had timed-out attempts; exact
onset varies with CPU/cache load and must not be presented as a fixed session-size
limit or an exhaustively minimized latency boundary.

This is a **production deadline/liveness risk exposed by the synthetic backend**,
not just the driver's former one-pass assertion. It does **not establish that a
real session can never rebuild**: a 17,000-message OpenCode 1 probe and a
16,000-message OpenCode 2 probe applied a subsequent retry when the response fit
the budget; other retries exceeded it again. No live-host latency was measured.
The separate follow-up should profile the large native rebuild and its retry
epoch, then test whether repeated over-budget attempts can be acknowledged safely
without rebuilding forever. This slice leaves the deadline and retry policy alone.

The earlier measurement-driver assumptions were also corrected: an unchanged
flush may legitimately return noop; copying only `store.db` omitted the
`context.db` publication rows; full/plain-HARD versus provider-SOFT outputs are
not equivalent paired rebuilds. New pairs include authority snapshots and a
publication/model-switch trigger, and require an actually applied, matching view.
The original report had **no P1/P2 provider timings** (they were null), so none
are retroactively invalidated. Its pre-switch full-request-only p50/p95 figures
remain historical engine+codec diagnostics, **not P2 baselines**; they are not
comparable to the newly published/model-switched rebuild samples. Any exploratory
store-only clone comparison must be discarded. Per the reviewer decision, the
identity fix is delivered without a second production latency/policy fix.

Follow-up verification: Linux `cargo test -p mc-module --lib` passed **1857 tests**
(25 ignored), including all provider and step-transform controls; Linux
`cargo test -p mc-store` passed **314 tests** (5 ignored). T1
`pure-replay-differential.ts --provider-pipeline` passed **88 cases**: the original
84 plus the new success/refusal cases on both bindings. Plugin typecheck passed
with TypeScript 5.9.3. The provider-script typecheck still reports only the two
inherited errors listed in the original verification record below. A project-parsed
compiler check covered both edited scripts and 1,688 source files, allowing only
those exact two inherited diagnostics; no new diagnostics remained. Scoped edited
file diagnostics report no errors or warnings (one deprecated `context.exec` API
hint; call-graph health categories unavailable). Evidence is retained outside build directories
in `/tmp/provider-identity-t2-delivery.json`, `/tmp/provider-identity-t1.log`,
`/tmp/provider-identity-mutation.log`, `/tmp/provider-identity-switch-mutation.log`
and `/tmp/provider-rebuild-diagnose-{7500,15000,16000,17000-complete}.log`.

### Per-pass cost profile and bounded hook policy (follow-up)

All numbers in this section are **synthetic Mac measurements** (darwin/arm64,
Bun 1.4.2, Cargo 1.99.0, optimized test driver, the same 17,000-message
tool-dense fixture as above). They are not live, real-host or ALF acceptance.
The Mac was shared with other workers; absolute times varied by up to about 2×
between runs, so compare columns of one table, not across tables.

**Method.** Temporary, environment-gated wall timers (never committed) wrapped
each stage of `provider_host_hook` and `commit_provider_delta`, the host
`compaction.step` handler, the engine's existing per-pass profile spans and the
TypeScript adapter's `run`. One driver (`/tmp/ppperf/profile.ts`) bootstraps the
fixture, runs ordinary passes of three appends (five hooks per pass) and then
publication/model-switch rebuilds. A stage whose cost roughly doubles from 7.5k
to 17k messages is classed O(session).

Ordinary pass, OpenCode 1, base commit `a424544a`, ms per pass:

| Stage | 7.5k | 17k | Class |
| --- | ---: | ---: | --- |
| Five `transform.hook` calls in the module | 825 | 1618 | O(session) |
| ⤷ `policy_parts_tx`: read and JSON-decode every policy part of the lineage | 440 | 858 | O(session) |
| ⤷ `promote_tx`: `json_extract(tag_number)` UPDATE scans every part per promoted answer | 181 | 320 | O(session) |
| ⤷ `channel1_inputs_from_parts` over all parts | 74 | 159 | O(session) |
| ⤷ rest of the hook decision (cloning all parts, counters) | 48 | 102 | O(session) |
| ⤷ conversation row load/rewrite and policy totals (row carried the 3.3 MB last step answer) | 36 | 85 | O(session) |
| ⤷ `host_channel1` (clones the baseline with every frozen part) | 12 | 23 | O(session) |
| ⤷ message insert, lineage, plan, frontier, burns, answer insert | ≈12 | ≈18 | O(new) + row loads |
| TS `publishMessages` deep copy of the served window | — | 28.8 | O(session) |
| TS `scanWindow` id classification | — | 2.6 | O(session), host contract |
| TS `providerIncoming` map over the incoming array | — | 1.8 | O(session), host contract |
| TS save, model/inputs, manifest/flush, assemble | — | <1 | O(new)/O(1) |

One `compaction.step` rebuild at 15,000 messages, OpenCode 1, ms:

| Stage | Base `a424544a` | This change | Class |
| --- | ---: | ---: | --- |
| Whole `compaction.step` | 44,439 (host gave up at 30,000) | 5,606 | O(session) |
| Engine planning | 38,588 | 378 | was O(n²) |
| ⤷ `reasoning_budget_cutoff`: per-message native/frozen-unit searches | 38,269 | 22 | O(n²) → O(session) |
| Engine store commit (frozen state, tags, policy parts) | 2,037 | 1,506 | O(session) |
| Engine state evolution / protected floor / build output / projection | 880 / 739 / 320 / 160 | 841 / 697 / 300 / 179 | O(session) |
| Encode view (native replacement) | 645 | 721 | O(session) |
| Load applied/produced views and live answers | 422 | 433 | O(session) |
| Prepare request / commit status page / normalize | 194 / 242 / 66 | 197 / 241 / 74 | O(session) |
| Hook in the same pass | 555 | 2 | O(session) → O(new) |

**Fixes.**

- Host hooks keep a bounded policy summary (`providers/policy_summary.rs`) in
  the new `mc_provider_policy_summaries_v1` table: the per-part sums behind the
  channel-1 baseline, buckets, real-user and reclaimable-output counts, the
  tool-tag protection window groups, the newest protected arcs per tool and the
  four smallest hint candidates per tool tier. Triggers on the policy parts and
  consumed-tag tables log each changed row once, with its pre-change copy, in
  `mc_provider_policy_changes_v1`, but only while a summary exists. A hook
  replays only the changed rows and the parts sharing an arc or tag number with
  them, parts entering or leaving the window or a protected arc, and tags that
  cross the window cutoff. It rebuilds from every part when it cannot replay
  exactly: no summary, changed settings or lineage, a cache-busting pass, a
  baseline that must be refrozen, new rows ordered before known rows, more than
  4,096 logged changes, or a protected-arc or hint list that would need an
  untracked member. `ProviderHookContext.parts` now holds only the hooked and
  pass-appended messages' parts; lineage reads go through the bounded
  `ProviderPolicyIndex`.
- Store migration **68** (`store_068_provider_policy_summaries.sql`) adds the
  two tables, the triggers, and expression indexes on policy-part tag number and
  arc, a partial index for unserved parts and two partial indexes for the newest
  cadence answers. The schema-pinned move inventory is now version 68; both new
  tables are `LocalReset` (derived; an absent summary is rebuilt). Writer guards
  skip inventory tables a shorter migration chain has not created, so a
  migration-fence test can still open a version-66 store.
- The per-hook pending/live answer count (unused) is removed. The conversation
  row keeps a receipt of the last step answer (request id, answer kind,
  compaction id and version) instead of the multi-megabyte view, which stays in
  its view row. A step loads one view by version instead of every stored view.
- An engine rewrite of the policy parts uses one cached statement and leaves
  unchanged rows alone; a baseline refreeze restates measurements with a cached
  statement and skips rows whose stored text already matches.
- `reasoning_budget_cutoff`, the active Anthropic turn checks and
  `non_tag_messages` use per-pass maps instead of per-message linear searches.
- TypeScript: `publishMessages` copies with plain loops (same keys, order and
  `toJSON`/`__proto__` handling); the model fallback walks back from the newest
  message instead of copying and mapping the whole array.

**Remaining O(session) work.** No module work in an ordinary hook grows with the
session: SQLite steps per ordinary hook are 5,884 at both 1,000 and 17,000
messages, while the summary rebuild that the first hook performs costs 369,211
and 6,241,211 (`ordinary_hook_store_reads_do_not_grow_with_the_session`). After
the change an ordinary 17k pass spends about 2 ms per hook. The adapter still
does three O(window) things the host contract requires on every pass: it reads
every incoming id to detect appends, holes and reverts (≈2–4 ms at 17k), maps
the incoming array (≈2 ms), and deep-copies the served window it publishes
(≈7 ms at 17k), because OpenCode or later transforms may mutate published
objects. Reusing earlier copies would change that defensive contract and is not
done here. The first hook after a bootstrap or after a rebuild that rewrote the
policy parts rebuilds the summary; after a rebuild it usually also refreezes the
tail-hygiene baseline (the engine and host measurements disagree for covered
parts), restating every frozen part's measurement. That hook took 520–630 ms
at 17k, inside its 1,500 ms budget; before the cached change-only restatement
it took about 1.6 s, the hook timed out, and the host served that message
untagged, which failed the paired rebuild comparison at 17k. A HARD rebuild
itself re-renders the whole prefix, so the remaining ≈5.6 s at 15k is engine
work proportional to the session (store commit, state evolution, protection
floor, view encoding, view and answer loads).

Before/after, synthetic, `provider-pipeline-synthetic.ts` at each size (20
ordinary samples of three appends after three warmups; five paired rebuilds);
ms, p50 / p95:

| Binding, messages | Ordinary before | Ordinary after | Provider rebuild before | Provider rebuild after | Full-request engine+codec after |
| --- | ---: | ---: | ---: | ---: | ---: |
| OpenCode 1, 7,500 | 836 / 977 | 13.5 / 21.3 | 7,789 / 12,570 | 2,283 / 3,140 | 1,664 / 1,906 |
| OpenCode 2, 7,500 | 729 / 803 | 10.4 / 15.2 | 7,044 / 7,673 | 2,347 / 2,435 | 1,601 / 1,675 |
| OpenCode 1, 17,000 | 1,512 / 1,767 | 15.8 / 29.8 | blocked: 31,074 timeout, retry 28,426 | 5,968 / 6,283 | 4,793 / 4,823 |
| OpenCode 2, 17,000 | 1,838 / 1,981 | 19.1 / 29.0 | blocked: 30,795 timeout, retry 30,041 not applied | 5,792 / 6,089 | 4,498 / 4,983 |

Before, the base full-request arm measured 6,865 / 10,448 (OpenCode 1) and
6,046 / 6,507 (OpenCode 2) at 7,500 messages and 23,875 / 33,643 (two samples)
and 39,215 (one sample) at 17,000. After, every paired rebuild at both sizes
applied a view, did not fall back and served bytes equal to the full-request
output. Hook round trips were p50 1 ms, p95 2–5 ms. The synthetic ordinary
results are inside P1's thresholds, but P1 still requires the live,
instrumented measurement described below. P2 is still not met: the provider
rebuild is 1.25–1.47 × the full-request engine+codec time (the gate allows
1.10 ×); the extra is the host step's own O(session) work listed above.

**Correctness evidence (Linux unless noted).** `cargo test -p mc-module --lib`:
1,860 passed, 24 ignored. Every replayed summary in tests is checked against
the full computation (inputs and summary); the 720-pass corpus asserts 46,980
comparisons and replayed summaries 1,850 times, the HARD companion keeps 48
passes and 113 comparisons (768 total), and M4's
`r3_randomized_host_full_engine_240_passes` had 0 mismatches. The previously
ignored `bounded_policy_summary_does_not_return_the_entire_known_metadata_lineage`
now runs and passes. `cargo test -p mc-store`: 314 passed, 5 ignored. On the
Mac, `pure-replay-differential.ts --provider-pipeline` passed all 90 checks
with no failures (the earlier record counted 88 cases: the original 84 plus the
four identity cases), and the signed-thinking prefix audit's golden capture
(`MC_AUDIT_GOLDEN`, 706 captured passes) is byte-identical to the base commit.

## Fail-closed gate and input contract

```sh
bun packages/plugin/scripts/perf-audit/provider-pipeline-gate.ts capture/measurements.json
```

The script reads capture JSON and captured provider dumps only. It never opens a
live store. Exit **0** means all measured gates passed, **1** means a measured
threshold failed, **2** means evidence is absent/invalid (blocked). The exported
`MeasurementBundle` type in that script is the exact version-1 input schema.
Synthetic bundles, missing counters, unsupported host versions, wrong timer scope,
small corpora, empty timing populations and missing canary dumps cannot pass.

The collector must supply `measurement_kind: live`, `machine`, a
`session_copy_sha256`, `message_count`, `frozen_unit_count`, and
`timing_scope: handler_entry_to_output_assignment_including_sync_and_mirror`.
The minimum fixture is 7,500 messages/49,000 frozen units. Every pass supplies
`host`, `host_version`, `pipeline`, `pass_kind`, `appended`, `pass_ms`,
`hook_count`, `hook_module_ms` and every byte/page counter below. The hook population
must match its independently recorded count. Each host has at least 20
ordinary samples and five rebuild/full pairs. These minimum sample counts are
gate policy for meaningful quantiles, not additional spec performance targets.
Use nearest-rank p50/p95, reported separately per host, never pooled.
Full-request/rebuild pairs have unique `comparison_id` and identical
`starting_store_sha256`; zero full-request baselines are rejected.

| Criterion | Implemented threshold |
| --- | --- |
| P1 | Ordinary/no rebuild/≤3 appends: p50 ≤30 ms, p95 ≤120 ms; module hook p50 ≤5 ms |
| P2 | Rebuild p50 ≤1.10 × same-starting-store full-request p50 |
| P3 host | `host_logical_payload_bytes` ≤ `ingest_json_bytes` + `hook_ops_json_bytes` + 1024 |
| P3 module | `module_logical_payload_bytes` ≤ `appended_message_bytes` + `answer_json_bytes` + `tag_row_bytes` + 1024 |
| Background | Report `background_delta_bytes` alongside P3, **exclude** from both limits; ≤20 pages, each ≤1,000 rows |
| Physical | Report `host_db_bytes`, `host_wal_bytes`, `module_db_bytes`, `module_wal_bytes`; do not gate |
| P4 | ≥24h ALF canary; zero priced busts without an applied-view, declared-prefix-event or exit-pass ledger entry |

Both host populations require ordinary fixtures `large-replace`, `many-text-block`
and `post-publication`. The latter has zero appends and nonzero background bytes;
its message/ops/answer/tag budget components must all be zero, leaving only 1 KiB
of state on either side. Budget fields must come from independently counted
actual encoded payloads, not from expected values in a fixture or WAL growth.

P4 invokes `analyzeOpenCodeCacheBustSession` from `analyze-cache-busts.ts`, with
an exact session id, explicit captured Anthropic/OpenAI directories and explicit
start/end times. It requires observations within five minutes of both edges of
the ≥24h window. This edge tolerance is a coverage policy, not permission to
lose requests inside the window. `UNMETERED`/`LATENCY` observations block sign-off.
Each priced `BUST` must join the event ledger by exact request timestamp. The
ledger contains `at`, `kind: applied_view | host_prefix_event | exit_pass`, and
nonempty `evidence_id`. Duplicate event timestamps are rejected. The collector
must bind durable evidence to actual request timestamps; a nearest-in-time
scheduler decision is not authority to explain a provider-pipeline bust.
This gate trusts the capture collector's counters and ledger; it is not a
replacement for implementing/test-driving that collector.

## Exact instrumentation required before live measurements

**Original slice status, before the partial instrumentation follow-up below:** none
of the following production emitters was added by the original slice. Complete
and independently test them before enabling the canary. Append structured
pipeline fields to the existing
pass log and correlate module completion rows by pass id/request id/session/harness.
Do not sample or round before producing quantiles.

| Fields | Emission/accounting site | Reader |
| --- | --- | --- |
| `pass_id`, `session_id`, `host`, `host_version`, `pipeline`, `pass_kind`, `appended`, `pass_ms` | Begin at `createOpenCodeProviderTransform.run` entry in `host-runner/opencode-adapter.ts`; stop after actual `publishMessages` output splice. Include sync and bounded memory drain before installation. Classify applied rebuilds and exits explicitly; extend full-request handler logging to the same boundary. | Capture collector → gate P1/P2 |
| `hook_count`, `hook_module_ms`, module `request_id`/`pass_id` | `McHandler::provider_hook` / `provider_host_hook` in `crates/mc-module/src/providers/step_transform.rs`: monotonic entry through completed answer serialization; count issued hooks independently and record module duration separately from host transport duration. Missing timings for issued hooks block measurement. | Joined capture collector → gate P1; never substitute RPC duration |
| `ingest_json_bytes`, `hook_ops_json_bytes` | UTF-8 encoded admission `ingest` and persisted ops at `commitHostRunnerPass` in `storage-host-runner.ts`; count once per newly appended message, not the whole served array. | Gate P3 host budget |
| `host_logical_payload_bytes` | Count actual logical serialized transcript/ops and state values submitted to durable writes in `commitHostRunnerPass`/`writeState`, after successful transaction. Count rewrites as writes, not net database growth. | Gate P3 host actual |
| `appended_message_bytes`, `answer_json_bytes`, `tag_row_bytes`, `module_logical_payload_bytes` | `insert_message_tx`, `insert_tags_tx`, `commit_provider_delta`/`commit_provider_hook_with_parts` in `crates/mc-store/src/provider_log.rs`: actual UTF-8 message/answer/tag/state row payload written after commit. Idempotent no-op writes count zero; existing-message rewrites must be observable. Track state separately so message totals cannot borrow the background budget. | Gate P3 module budget and actual |
| `background_delta_bytes`, `background_page_rows` | Attribute state-sync delta writes in `syncModuleState`/`resolveStateSyncDeltas` (`module-state-sync.ts`) and corresponding module authority transactions; attribute memory-mirror page commits in the provider sync/drain path. Emit one combined pass ledger, with page row counts; prevent two separate drains from each consuming 20 pages. Include their time in `pass_ms`, never include their bytes in message payload actuals. | Gate P3 report/page bound; P1 includes elapsed work |
| `host_db_bytes`, `host_wal_bytes`, `module_db_bytes`, `module_wal_bytes` | Collector stats on isolated copy files immediately before/after each pass; retain both readings, checkpoints and deltas for diagnosis. The measurement bundle's pass rows contain after-pass sizes, which the gate's P3 output reports without a threshold. | Gate physical report only |
| `comparison_id`, `starting_store_sha256`, `session_copy_sha256`, message/frozen-unit counts, machine/build ids | Collector snapshots/checksums an isolated, checkpointed starting store before branching paired arms; bind host and module stores in the combined digest. Preserve provenance outside target/dist. | Gate P2 pair validation and fixture-size admission |
| `request_timestamp`, `provider_request_id`, `pass_id`, `event_kind`, `evidence_id` | At applied durable view (`commitHostRunnerAnswer`), declared `record.ts` prefix event, and durable `commitHostRunnerExit`, then bind the event to the request actually emitted by the host. Also log pipeline routing on every pass, including unavailable/refused passes; never infer from default config. | Collector's canary ledger → gate P4 exact timestamp join |
| Complete `.meta.json`, `.body.json`, `.response.json` dump triads, exact session id and timestamps, response usage meters | Existing provider wire capture; export all requests/responses for the canary, not just busts. Track capture sequence continuity and refusals so missing data cannot be signed off as stability. | `analyze-cache-busts.ts` CLI/API → gate P4 |

The module/host counter accounting needs tests for large replace answers, many
text blocks, zero-appends after memory publication, retries, no-change sync and
the combined 20-page bound. Actual write totals and budget components must be
independent. The initial implementation did not emit the pass, payload, page or
ledger fields in this table; the follow-up below distinguishes the implemented
counters from the still-missing meters.

## Canary runbook after shipment and instrumentation

1. **Session:** use the owner's long-lived live **ALF head session**, not the
   synthetic fixture, a fork, or a worker child. Record its exact OpenCode session
   id as `ALF_SESSION_ID`, host generation/version, model, build revisions and
   copy provenance in the capture. No id was supplied for this partial. Obtain it
   from the running host/owner at rollout; never enumerate the operator's stores
   from an editing worktree. Abort if exact session or capture provenance is absent.
2. First run paired isolated-copy P1/P2/P3 measurement on the shipped binary with
   the instrumentation above. Keep source stores read-only; all writes target
   separately owned throwaway copies. Verify the gate's required fixtures and both
   pinned host versions. Resolve the tool-dense bootstrap's `CK message block
   identity drift` refusal first: it prevents provider admission and leaves no
   ordinary/rebuild population to measure.
3. With owner approval, set the ALF host's **user-level** config to
   `transform_mode: "rust"`, `rust_pipeline: "provider"`, with compaction **enabled**.
   Restart that host to recreate its transform dependencies, preserving its session.
   Project config strips `rust_pipeline`; it is absent from the live-reload path
   list, so a project edit or ordinary live-config refresh is not a rollout.
   Verify a logged provider pass and durable runner admission, not
   merely the config text. Choice is process-wide; do not promise per-session
   isolation if the host serves other sessions. Do not alter defaults for other users.
4. Capture ≥24 continuous hours of this session after successful bootstrap. Set
   explicit `OPENCODE_ANTHROPIC_AUTH_DUMP_DIR` and `OPENCODE_OPENAI_AUTH_DUMP_DIR` for
   the host's existing authenticated-provider dump capture, and retain its complete
   dump triads, host `MAGIC_CONTEXT_LOG_PATH`, module timing/write ledger, config/build
   provenance and applied-view/prefix/exit ledger. Check that the installed provider
   adapters actually write both bodies and metered responses before starting the
   clock; directory variables alone do not enable an adapter lacking capture support.
   This repository's live-provider helper identifies Anthropic's auth config via
   `OPENCODE_ANTHROPIC_AUTH_FILE` (its fixture disables `dump.enabled`) and OpenAI's
   via `OPENCODE_OPENAI_AUTH_FILE` (its fixture disables `dump` and
   `CORTEXKIT_OPENAI_AUTH_DUMP`). Adapter implementations are not in this worktree:
   verify the shipped adapters' enablement instructions and observed triads rather
   than assuming that reversing those disable controls enables capture.
   Restrict artifacts: request dumps can contain sensitive user content. Do not
   commit them. Export to a permission-restricted read-only capture directory outside
   regenerable build output; export an untruncated machine-readable measurement bundle.
5. Record ISO `CANARY_START`/`CANARY_END` spanning at least 24h. Analyze the complete
   explicit capture (no request `--limit` and no live database reads):

   ```sh
   bun packages/plugin/scripts/analyze-cache-busts.ts \
     --session "$ALF_SESSION_ID" \
     --anthropic-dir "$CAPTURE/anthropic" --openai-dir "$CAPTURE/openai" \
     --mc-log "$CAPTURE/host.log" \
     --since "$CANARY_START" --until "$CANARY_END" --all-rows --all-busts \
     > "$CAPTURE/cache-bust-analysis.txt"
   bun packages/plugin/scripts/perf-audit/provider-pipeline-gate.ts \
     "$CAPTURE/measurements.json" > "$CAPTURE/gate-result.json"
   ```

   Analyzer success alone does not prove P4: every priced bust must also join the
   durable event ledger; gate exit 0 and an independent completeness check are required.
   Apply the table's P1–P4 thresholds exactly. Missing meters, dropped captures,
   unexplained busts, missing payload counters or a shorter window block cutover.
6. **Off/rollback:** change the effective `rust_pipeline` back to `"full_request"`
   (leave Rust mode and compaction enabled) in user config, then restart the host.
   Preserve runner rows; do not erase evidence or reset
   namespaces manually. Zero-divergence sessions roll back without a rebuild;
   diverged sessions use the declared fresh-namespace rebuild once. Record that exit
   pass and keep collecting through recovery. An unexpected bust aborts the canary
   and keeps default-provider cutover blocked until resolved and remeasured.

## Verification record

- Linux Bun 1.4.2: gate + manifest validator: **13 passed**, 0 failed, 86 assertions.
  In the original partial, inventory assertions increased from 184 to 186 files
  and 59 to 61 Rust entries for the two new host probes. The CI follow-up retains
  186 files but restores the Rust count to 59 because those probes are now opt-in.
  No host-byte or durable-record behavior assertion was reversed.
- Gate's P3 non-vacuity control: ignored host payload overruns only on append passes.
  `P3 gates logical payload while reporting and excluding background delta bytes`
  alone failed; the other six gate tests passed. Restored from the staged live file;
  diff-stat was one file/+1/-1 while mutated and empty after restoration.
  A preliminary broader mutation also reddened the zero-append test (five passed,
  two failed), then was restored before applying the selective control. Neither
  mutation remains in this tree.
- Root required Linux gates: `npm run build` passed all three package builds;
  `npm run typecheck` passed all four package scripts; `npm run lint` passed
  (Biome 2.5.1: 1,352 + 258 + 137 + 6 = **1,753 files**, existing warnings).
  TypeScript **5.9.3**. Root `npm run test` failed at plugin: **8,110 passed,
  9 skipped, 2 failed**, 8,121 tests/760 files. Failures were unchanged
  `Node WASM Transformers fixture > builds with real fs and persists a model for
  offline reuse` (cannot resolve `onnxruntime-web/webgpu` from temp bundle) and
  `sqlite writer diagnostics > a writer that waited for the lock reports the wait,
  not its short hold` (309 ms against <250 ms). Root chaining therefore did not
  reach the other packages' test scripts.
- Focused unchanged failure files: six tests, three passed/three failed. WASM
  failure reproduced; sqlite wait passed, while `a writer that held the lock reports
  the hold, not its quick acquisition` and `a fast writer stays out of the log`
  failed with extra diagnostic rows. No unrelated source or expectation was edited.
- `tsc --noEmit -p packages/e2e-tests/tsconfig.provider-pipeline-gate.json` passed.
  The broader `tsconfig.provider-pipeline.json` reports only two inherited errors:
  unchanged `src/rust-harness.ts:805`'s SDK `session.get` type and plugin
  `command-handler.ts:223`'s readonly `[ignore]` assignment. No new-file diagnostics
  remain. Scoped AFT diagnostics: four of four files authoritative, 0 errors/warnings;
  call-graph health categories were unavailable (partial inspection).
- Real-host tests: **0 passed/2 failed preflights**, absent prebuilt daemon. No
  claim of real-host execution beyond that preflight. Synthetic final Mac replay:
  ten full-engine samples and two provider refusals recorded above, not acceptance.
- Mac `provider-pipeline-differential.ts --case OpenCode1/T2.timing-boundary
  --case OpenCode2/T2.timing-boundary`: **two passed**, no failures, Bun 1.4.2 /
  Cargo 1.99.0. Both append and no-append timed passes reach output installation
  without fallback, preserve bytes, and exclude corpus serialization from timing.
- `cargo fmt --all`, `git diff --check` and `git diff --cached --check` passed.
  Read-only independent comment review completed; clarified the four requirements,
  physical-size report, bootstrap refusal, user-only/restart rollout and default
  cutover wording. No package-manager manifest or lockfile changed; no install needed.

### Outstanding gates

P1, P2, P3 and P4 remain unpassed. The identity refusal is resolved. After the
per-pass cost follow-up, the synthetic ordinary pass is inside P1's thresholds
and 17,000-message rebuilds apply within the bootstrap budget, but P2's
rebuild-to-full ratio (1.25–1.47 ×) is still above 1.10 ×, and none of this is a
live measurement. Next actions are: reduce the host step's own work in a
rebuild; run the two real-host lanes with the matching binaries;
land the separate production instrumentation/capture collector; ship; obtain an
authorized ALF copy and live session id; then run and retain the paired measurement
and full 24-hour canary. Switching the default to the provider pipeline is not
authorized by this partial.

## Partial production-meter follow-up (train 3549c434)

**Not a canary sign-off.** The setting stays off by default. This follow-up adds
real provider-pass/RPC and provider-store diagnostic meters and fixes an unsafe
hook deadline outcome. It does **not** complete the instrumentation table above,
prove P2, or replace the live collector. Missing measurements are explicitly
identified in the host row's `partial_fields` and the module store row's
`sql_rows_complete=false` / `logical_payload_complete=false`. A collector must
reject those rows for a gate that requires complete totals.

### Real emission and accounting boundaries

- `opencode-adapter.ts` emits `rust pass: decision=… reason=provider_pipeline …
  provider_meters={…}` to the normal session log. The pass starts before hydration,
  includes sync, embedding-watermark drain, hooks, durable writes and actual output
  publication, and reports unrounded wall-clock milliseconds. Named stages are
  bootstrap, state sync, hook transport, rebuild and publication; other host work
  remains in the whole-pass time. Transport time is **not** module-only time.
- Each row has a fresh pass id, exact session/harness, routing (including
  full-request exits), append/hook/RPC counts, request ids, applied rebuilds,
  historian pump calls, retries, fallbacks and recovery notifications. These
  counters increment at the call/admission/commit points, not by summing successful
  outcomes. Asynchronous historian pumps run outside the foreground pass context;
  their later traffic cannot inflate an already-emitted foreground row. Pump calls
  are not historian fire/no-fire cadence decisions.
- `SubcModuleTransport` counts actual encoded request payloads at `client.request`,
  including each `reply.page`. It records failed and unanswered requests as well
  as answers. Response bytes are the UTF-8 JSON encoding of decoded response
  objects, including page envelopes, **not** the original wire-frame bytes.
  Authentication and route-open/close management traffic are outside this metric.
  The subc client does not expose raw receive-frame lengths here.
- Host runner transactions stage an independent actual payload-cell ledger and
  separate ingest/ops budget counters. Only COMMIT merges that ledger into the
  pass. Rewrites of state/view cells count again; transaction rollback contributes
  zero. Structural ingest-flag, lineage and pruning updates are not yet covered,
  so `host_logical_payload_bytes` is explicitly partial, not a complete P3 actual.
- The module emits `provider module complete` with method, request id,
  session/harness, issued hook count, exact serialized success-body length and
  monotonic entry-to-serialization duration (including lock wait). Error envelope
  bytes are not counted as success bodies. `provider rebuild stages` splits replay,
  preparation, engine and native encoding under the step's request-id span.
- Provider-store result rows count before mapping/filtering, including capped reads
  discarded wholesale. They cover `provider_log` and `policy_index`; they are not
  sums of effective policy outcomes or the existing policy index's diagnostic
  `rows_read`. SQL scalar queries contribute one result row. Neither SQLite's
  internal scan/index visits nor engine/context-domain/state-sync result rows are
  covered. A safe row-trace API is not available in pinned rusqlite 0.32.1; no
  unsafe tracing hook or library/schema migration was introduced.
- Store message, stored answer JSON, inserted tag cells and selected hook-state
  cells have separate byte counters plus an independent actual payload counter.
  The fenced admission/hook transaction owns their rollback journal. Duplicate
  message admissions and ignored tag inserts count zero. Engine/cache-state,
  policy-part/summary/view writes and expression-based policy/state rewrites are
  not included, and unjournaled engine tag writes are deliberately excluded.

**Still required before a canary:** complete host/module logical-write coverage;
engine/context-domain/state-sync SQL row coverage (or an explicit gate contract
for result-row scope); exact response-wire bytes if requested by the collector;
combined state-sync/memory-mirror byte/page ledger and its 20-page bound;
historian fire/no-fire cadence; host-version provenance; physical before/after
sizes and combined-store hashes; request-timestamp-bound durable event ledger and
capture continuity. Unknown fields must not be supplied as zero. No live store,
configuration or ALF session was inspected to fill these gaps.

### Correctness before latency

The first Linux 17k synthetic baseline failed paired equality on the second
rebuild: the provider output omitted the agent-visible tag prefix `§37517§`
from `rebuild-1`, while the full request retained it. The requests therefore
contained different text bytes. A hook can commit its tag remotely after the host's deadline;
previously the adapter treated that unavailable answer as permission to freeze
and publish an untagged raw append. That makes the host and module disagree.

An expired/late/aborted hook now throws an explicit `EmergencyFailClosedError`
before committing/publishing that append. An already-active rebuild step crossing
its fence also refuses instead of publishing an old view as a successful rebuild.
Before a provider view is installed, a failed initial bootstrap still routes the
turn through the existing full-array Rust transform instead of installing a
provider view. It has not acknowledged provider bytes. Ordinary transport unavailability
policy is unchanged. Tests on both bindings force a real short hook timer and an
active step's late fence and assert refusal, no output publication and no hidden
fallback. The existing unavailable-pass test was not rewritten into its opposite.

### Rebuild diagnosis and before/after numbers

The baseline ran on Linux `ck-motor`, Rust 1.99.0, Bun 1.4.2, optimized test driver,
with 17,000 base messages, 20 ordinary samples and five attempted rebuild pairs.
The timing driver alone disables test-only recomputation of every replayed
summary against its full-policy reference; otherwise those independent test
assertions would add O(session) work to the measured fast path. Correctness runs
keep that recomputation enabled. Byte equality failed before all five pairs completed,
so this is **not** a p50/p95 population and supplies no accepted P2 ratio.

| Measurement (ms unless noted) | Before follow-up, contended Linux | After follow-up |
| --- | ---: | --- |
| Message/hook replay, two paired attempts | 150.360–167.148 | 92–110 (first isolated after run) |
| Request preparation / previous views / drops | 1,933.844–2,033.296 | 1,198–1,588 (first isolated after run) |
| Engine | 5,879.951–7,274.023 | 4,322–5,522 (first isolated after run) |
| Native view encoding | 1,336.416–1,474.488 | 1,153–1,350 (first isolated after run) |
| Same-starting-store full-handler time, two attempts | 7,102.5 / 9,626.5 | Later byte-equal diagnostic pair: 8,200.335 full / 14,667.265 provider |
| Paired rebuild p50 / ratio | Invalid population: provider and full request differed at tag `§37517§` | Not established; 1.10× not claimed |
| First post-rebuild hook's 1,500 ms fence | At least one answer missed its fence | 1,493.849 ms module (6.151 ms margin); later 1,621.088 ms; both refuse safely |

The 1,500 ms hook budget does **not** apply to the rebuild's engine/preparation/
encoding stages: those share the 30,000 ms bootstrap budget. The later isolated
after runs expose 1,493.849 ms and 1,621.088 ms module-only post-rebuild hook
outliers, with 75,061 / 75,057 provider result rows. They leave essentially no
transport margin or exceed the hook fence outright. The earlier Mac 520–630 ms
summary-refreeze numbers are not substituted for these Linux observations.

Small provider-only reductions avoid decoding the same immutable applied/produced
view twice, skip a second live-answer load when there are no pending drops, and
avoid reapplying empty hook operations. They retain both references' descended
lineages and the same served bytes. Five OpenCode 1 and three OpenCode 2 after
pairs matched bytes before the first isolated run's OpenCode 2 refusal. A later
run matched one OpenCode 1 pair (14,667.265 / 8,200.335 ms, ratio ≈1.789) before
a subsequent hook refused. Neither run forms a complete P2 population; neither
establishes a timing improvement under equal load. The reviewer requested a
reviewed design, not further implementation or a larger deadline. The proposal
is `docs/designs/provider-post-rebuild-hook-cost.md`; it covers bounded immutable
view descriptors, exact policy prewarm within the rebuild, acknowledgement
invariants and independent cached/uncached byte/state proofs.

### Isolation, shared hooks and verification status

Synthetic and differential host fixtures now create unique directories under
`$TMPDIR/magic-context/provider-performance/` and
`$TMPDIR/magic-context/provider-suite/`. Each driver fixture proves open host/module
DB paths with `lsof` before use; failures to observe stores or any non-scratch store
abort the run. The measured baseline's root was
`/motor-home/tmp/magic-context/provider-performance/run-pMnyYG`; all observed
`context.db`, `store.db`, WAL and SHM files were beneath it, including oracle arms.
Only generated overlays of this worktree's sources are compiled. No operator store
or configuration was opened, and no Rust build was run on the Mac.

Shared production files touched are `crates/mc-store/src/lib.rs` (module export),
`crates/mc-store/src/provider_log.rs` (row mappers and the tag insertion helper),
`crates/mc-store/src/provider_log/policy_index.rs` (row mappers), and
`packages/plugin/src/hooks/magic-context/module-transport.ts` (request/reply-page
boundary). The shared transport returns the original promise when no pass context
exists; row hooks do not allocate or lock without their thread-local provider
context. Tag-byte string conversion is guarded by that context. The full-array
transform implementation, defaults, migrations, ARCHITECTURE.md and STRUCTURE.md
are unchanged. Whole full-array served-byte **and stored-state** differential
verification is still required; the small transport test proves only unchanged
request/response bytes, not database parity.

Focused Linux evidence before the final retry/step tests: five independent store
meter tests passed; the real module-completion test passed; 98 plugin meter,
adapter and transport tests passed. Rust workspace baseline passed its 1,926 module
unit tests but failed four real-daemon tests because the sibling daemon checkout
was absent (confirmed known by the reviewer). These are not meter failures.
TypeScript 5.9.3 plugin typecheck passed locally with reviewer permission after
Linux refused the queue. Plugin lint (Biome 2.5.1) passed over 1,410 files, with
59 existing warnings and nine informational findings. Seventeen independent host
counter neutralizations each reddened exactly its selected test and were restored;
`provider-meter-mutations.json` retains the names and nonempty/empty diff-stat pairs.
Final Rust mutations, complete plugin suite, 768-pass Rust parity, 90/90 provider
suite, 706-pass signed-thinking audit and bounded-policy identity remain required.

After-run and final correctness jobs were refused with
`queue_wait_exceeded: waiting_on=permits; held_permits=64/64`, first at 16c and
then at 4c. Recorded holder set at accepted time `1791841407775`:
`01a131a2-6c0b-7560-a1cb-49d1bc55e203` (8c, since `1791834098006`),
`01a131dd-2783-768d-b9c7-fd4b1d416fcd` (8c),
`01a131e5-a80a-7202-8eeb-1d131d6a35f8` (8c),
`01a1320c-238b-744e-9b60-ef847df6f264` (4c),
`01a1320d-d5ab-7649-9d23-489d51597288` (8c),
`01a13210-6283-767e-85a2-de452dfcdf5c` (8c),
`01a13210-88a8-748d-9ff4-11abeecaf40d` (4c), and
`01a13210-fca5-736d-b3ea-25e3b2405029` (16c). No runner load average was obtained;
the rejection happened before the requested command could execute. The reviewer
permitted local TypeScript-only targeted gates, not local Rust or a full Mac
plugin suite, and requested queued 4c Rust retries. A clean same-run baseline/after
measurement must record actual load as well as permit occupancy. No reconciliation
landing notice has yet been received; its merge and rerun are also pending.

### Final execution update and blocked work

Capacity later freed for 4c jobs. Rust 1.99.0 / Cargo 1.99.0 workspace execution
passed 1,928 module unit tests (27 ignored), including the 720+48 randomized/HARD
corpus and bounded-policy summary/identity checks. It then reached the fifth
missing-sibling daemon test,
`a_module_on_a_store_ahead_of_it_refuses_on_health_and_on_transform`, which failed
trying to run `cargo build -p subc-core --bins` in an absent checkout. The four
previously confirmed daemon tests had been explicitly skipped, not fixed. The
remaining workspace packages passed separately: core 22, store 338 (5 ignored),
tokenizer 3 unit + 4 golden + 1 allocation tests. `cargo fmt --check` and workspace
`cargo clippy --workspace --all-targets -- -D warnings` passed.

The isolated provider differential passed **90/90** on Linux, including both 17k
bootstrap populations (9,911 / 5,963 ms complete, 4,316 / 4,263 ms slowest page).
The full plugin suite ran on Linux: 8,411 passed, 19 skipped, 10 failed. Failures
were the unrelated Node-WASM scratch import of `onnxruntime-web/webgpu` and nine
worker-bundle checks needing missing ignored `dist/auto-search-worker.js` outputs.
A subsequent Linux `bun run build` passed (plugin/v2, Pi and CLI bundles, nine TUI
outputs unchanged). Frozen install checked 1,010 installs / 1,251 packages with no
changes. No manifests or locks changed. The final three touched plugin test files
passed **104 tests** locally with reviewer permission. Plugin TypeScript 5.9.3
typecheck passed again on Linux; final formatting/lint passed locally (1,410 files,
59 warnings, nine infos). There are **27** restored independent mutation controls:
17 host/transport and 10 Rust store/module controls, each with exactly one selected
red test. All remaining tests were explicitly filtered, not claimed green in a
mutant run. `provider-meter-mutations.json` records each neutralized counter,
exact failing test, failure summary and nonempty/empty mutation/restoration diff
stats; it proves those checks detect missing accounting.

A same-allocation archive-baseline/after attempt recorded load averages
31.25/24.75/22.49 initially and 20.21/20.80/21.44 finally. Baseline byte parity
failed; the after build exposed cross-arm shared Cargo artifact contamination
(`provider_meters` absent in the baseline store artifact), so its result was
rejected. An independent candidate target eliminated that artifact mismatch.
Its load averages went from 22.72/21.85/21.73 to 9.10/13.62/18.24; the later
sample-printing run went from 13.62/13.83/16.28 to 19.48/16.02/16.39. Both were
contended and stopped on an explicit hook refusal. Future before/after arms need
separate Cargo target directories and clean, contemporaneous permit/load records;
the earlier refused-job holder list is historical, not a claim about these runs.

**Blocked:** the owner's long-lived ALF session canary and the P2 criterion
(provider rebuild p50 ≤1.10× the paired full-array baseline), complete production-meter coverage,
full-array functional stored-state differential, clean before/after timing and
reconciliation merge/rerun. The 706-pass signed-thinking comparison still needs its
independent baseline capture. The follow-up design is delivered for review only;
no cache/prewarm implementation, deadline change or default switch is included.


## Preparation continuation after the landed reconciliation (2026-10-13)

This section supersedes the *execution status* in the previous update, not the
live-session acceptance criteria. The retry starts from the reviewed revision
fence in `d56295e9` and the preserved preparation implementation in `8a1779717b`.
The landed train `85319552a5b6523470d2a79da4194ff9ca133a35` was merged in
`429da816c3`; the larger `train/check-stack2` integration was not merged. Cargo
allocation is **Linux, 4 vCPUs**, as specified in the retry ruling. No Rust build
or test ran on the Mac.

### Deferred preparation and independent controls

The successful rebuild step prepares derived policy only when the new user-only,
**off-by-default** `rust_provider_preparation` control is enabled. The actual hook
validates the stored namespace revision before its own admission, checks settings,
original baseline, ancestry, format/checksum/caps and cut, replays its admitted
changes, and finalizes the actual newest cut. Any mismatch uses the existing cold
computation. Preparation does not publish a baseline, hook summary, served
watermark, cadence/grace or acknowledgement. The `rust_pipeline` default, the
full-array implementation and migrations were not changed by this continuation;
migration 70 is the previously committed revision fence, not a new retry edit.

The positive R1 witness independently retains the old engine baseline, admits
ordinal 3, **actually consumes** preparation, freezes nine parts (not one), counts
one reclaimable tool output, and matches cold baseline and channel-1 append bytes.
Fifteen companion cases cover namespace sibling/settings revision changes, shared
consumed and covered tags, invalid key/original baseline/cut, cap/checksum, eviction,
restart, disabled consumption, cache bust, ancestry change and an unadvanced cut.
A reopened valid preparation can be reused only after the same revision checks;
an absent/evicted entry follows the cold path. The changed-log test separately
proves the builder is not invoked and the unaccounted frontier is not cleared.

`MC_HOOKCOST_REVIEW=1 cargo test -p mc-module --lib hookcost_review -- --nocapture`
passed **19 tests**: the 16 positive/mismatch cases and all three unchanged review
witnesses. `provider-preparation-mutations.json` records five staged, individually
reddened and restored controls: early baseline publication, omitted admitted parts,
revision equality bypass, erased unaccounted changes and settings validation bypass.
Each focused mutant run selected one test and failed exactly that test; all other
tests were filtered, not claimed to pass. The restored hook/store suites passed.

`bun packages/e2e-tests/scripts/provider-preparation-differential.ts 48` passed
**96/96 same-pre-rebuild-snapshot pairs**, 48 per binding, with **96 actual
consumptions**. It compares raw rebuilt, first-hook and acknowledgement/next-step
answers, exact append ops, policy measurements, bounded summaries, baseline/settings/
grace, functional answer/tag state and receipts. The disabled arm writes zero
preparation rows, and preparation leaves pre-admission measurements and normal
summaries identical to the cold arm. Independent tag allocation wall-clock
`created_at_ms` fields and asynchronous `historian_*` bookkeeping are excluded
from *functional state* comparisons; no field is excluded from served-answer byte
comparisons. Acknowledgement replay uses valid unique tool-use IDs; repeated-call
subjects remain covered by the unchanged 90-check suite. The offline fixture
predeclares pass model/carrier controls before the fork: it does not prove a live
host's synchronization will preserve a preparation hit. Synchronization writes
still invalidate the revision conservatively.

### Reconciliation gates

Tool versions: Bun **1.4.2**, TypeScript **5.9.3**, Biome **2.5.1**, Cargo/Rust
**1.99.0**, rustfmt **1.10.0-stable**.

- `cargo test --workspace` passed **1,965 module unit tests** (29 ignored), including
  the **720+48 = 768** randomized/HARD byte corpus, bounded-policy full/replay
  identity controls, and the new preparation tests. The run then stopped at four
  unrelated `real_daemon` integration tests: `subconscious_root` at
  `tests/real_daemon.rs:1101` requires an absent sibling `subconscious` checkout.
  The changed provider behavior is independently exercised by the unit tests and
  real-handler fixture driver; no sibling checkout or live store was substituted.
- `cargo test -p mc-store -p mc-core -p mc-tokenizer` passed **345 store** (5 ignored),
  **22 core**, and **7 tokenizer unit + 2 history-cache + 4 golden + 1 allocation**
  tests. `cargo fmt --all --check` and
  `cargo clippy -p mc-store -p mc-module --all-targets -- -D warnings` passed.
- `bun packages/e2e-tests/scripts/pure-replay-differential.ts --provider-pipeline`
  passed **90/90**, including scratch 17k bootstrap totals of **5,897 / 5,007 ms**
  and maximum pages of **3,558 / 3,427 ms** for OpenCode 1 / 2.
- The complete plugin suite ran **8,692 tests**: **8,653 pass, 27 skip, 12 fail**.
  Two failures were missing generated configuration/schema updates for the new
  opt-in; both generators were run and the follow-up seven-file configuration/
  provider suite passed **183/183**. The remaining ten match the previous baseline
  limitations: Node-WASM offline import and worker-bundle checks requiring ignored
  built distribution files. No unrelated test assertion was changed.
- Plugin `typecheck` passed its three configured TypeScript checks. Plugin `lint`
  passed **1,462 files** with 59 existing warnings and nine infos. The additional
  E2E provider-pipeline typecheck includes both preparation scripts and reported
  only two pre-existing import-closure errors (`rust-harness.ts:805` missing
  `session.get`, `command-handler.ts:223` read-only ignore marker). Scoped diagnostics
  for all three edited E2E scripts were authoritative: **zero errors/warnings**.
- The reconciliation lockfile was installed locally with
  `bun install --frozen-lockfile`: four packages installed, no lockfile changes.
  A concurrent remote gate was refused while another job owned this workspace;
  it was rerun sequentially on Linux, not locally.

The production-meter limitation remains explicit: store row/write scopes are still
partial, the complete physical/logical ledger and historian fire/no-fire cadence
are not delivered by this preparation experiment. Existing missing counters must
not be treated as zero. The ALF canary and the **≤1.10×** rebuild/full-array sign-off
remain separate, blocked acceptance decisions.


### 17k paired setting-off / setting-on results

Candidate `89e11baee3`, after the train merge, ran
`bun packages/e2e-tests/scripts/provider-preparation-timing.ts 100` on Linux/4c.
There were **100 pairs per binding**, **400 measured arms**, **200 actual
consumptions**, and **200 exact rebuilt/first-hook answer-byte comparisons**.
Every pair branches *before* rebuild from the same durable snapshot; arm order
alternates off/on and on/off. Before the fork, the fixture records the upcoming
model ID, lineage and appended-message ID in the stored pass context, which the
hook uses to select its policy settings and append carrier. It uses the same
17,000-message population as the earlier profile and waits directly
for the real handler. It does not increase the production hook's **1,500 ms**
deadline or test live-host synchronization/cache-hit frequency. Quantiles are
nearest-rank over all 100 observations; deadline misses are not excluded.

| Binding / metric (ms) | Before: preparation off | After: preparation on |
|---|---:|---:|
| OpenCode 1 first-hook module p50 | 1,019.10 | 752.43 |
| OpenCode 1 first-hook module p99 | 1,327.00 | 1,026.61 |
| OpenCode 1 first-hook wall p50 / p99 | 1,019.43 / 1,327.37 | 752.66 / 1,027.11 |
| OpenCode 1 complete rebuild module p50 / p99 | 7,948.02 / 11,731.50 | 8,306.49 / 11,839.50 |
| OpenCode 1 preparation inside rebuild p50 / p99 | 0 / 0 | 420.19 / 623.65 |
| OpenCode 1 hooks beyond 1,500 ms (of 100) | 1 | 0 |
| OpenCode 2 first-hook module p50 | 1,112.41 | 823.75 |
| OpenCode 2 first-hook module p99 | 1,320.68 | 1,515.24 |
| OpenCode 2 first-hook wall p50 / p99 | 1,112.74 / 1,321.08 | 823.93 / 1,515.50 |
| OpenCode 2 complete rebuild module p50 / p99 | 8,086.91 / 10,236.34 | 8,640.26 / 11,481.59 |
| OpenCode 2 preparation inside rebuild p50 / p99 | 0 / 0 | 441.91 / 530.64 |
| OpenCode 2 hooks beyond 1,500 ms (of 100) | 0 | 2 |

The first-hook p50 falls about **26%** for both bindings, but preparation costs
**420–442 ms p50 inside rebuild**. Complete rebuild p50 rises **4.5% / 6.8%**
(on/off ratios **1.045 / 1.068**); these are **not** ratios to the full-array path.
OpenCode 2's prepared p99 still exceeds the product hook fence. This is useful
reuse evidence, not a canary approval or a ≤250 ms module-p99 result.

The 4,444-second run observed `nproc=4`, host load1 **1.78–26.71**, and host CPU
PSI `some avg10` **0.08–60.88%**. Hook and rebuild pressure deltas are captured
separately. The pressure reader reported the same host and cgroup PSI text,
`cpuset=0-31` and no `cpu.max`; do not interpret those fields as independent
per-job throttling measurements. The summary retains quantiles, all per-arm
pressure ranges/totals and representative raw before/after snapshots in
`provider-preparation-timing.json`. The complete sample stream is reproducibly
emitted by the harness; it is not claimed to be retained in that summary.
An earlier 100-sample attempt hit the caller's 30-minute hard timeout, not a stuck
compile lock. The completed run used a two-hour cap and was awaited to exit zero.
The five-pair smoke run was not used for a p99 acceptance claim.

**Stop point for P2:** this policy-only preparation does not reduce the rebuild's
full history replay, engine request conversion or response/native encoding, and
adds measured work to that step. No new paired full-array ratio is claimed; the
original **1.25–1.47× versus ≤1.10×** failure remains unclosed. Reaching that target
requires a separately reviewed design reducing rebuild replay/conversion/encoding
or reusing the *exact response-wire* view/native material, with revision/ancestry/
cut validity, acknowledgements and lexical serialization independently proved.
The durable typed fragment is already known to be JSON-equal but byte-unequal to
the response fragment; substituting it is not an acceptable optimization. The
current implementation still decompresses/decodes retained measurements and
restates a potentially large admitted baseline in the hook. It does not implement
native/view caching or a process-wide retained-preparation budget. No such design
change, deadline relaxation, full-array edit or live enablement is included.

### Independent signed-thinking capture and packaging follow-up

The signed-thinking gate was recaptured from independent source trees:
`d56295e9096fb0c2f883058a4d82709d8773c023` versus candidate `89e11baee3`, with
separate Cargo target directories. Remote `.git` is read-only, so the ancestor
was archived locally and expanded inside this worktree's scratch directory rather
than creating a remote git worktree. The ancestor frozen npm install could not
fetch in the offline runner. For the source differential, both arms therefore
used the candidate's frozen installed npm dependency set, explicitly controlling
that factor; this is **not** a verification of the ancestor's packaged dependency
resolution. Rust source and targets remained independent. Explicit `./` Bun test
paths prevented the candidate from discovering the nested ancestor's tests.
An earlier filter-style invocation accidentally selected both trees (171 extra
failing tests); that capture was rejected, not treated as a behavioral regression.

Each arm ran **four configurations** (rejected/prefix-bound model classes × default/
strict), each with **171 TS/Pi tests and 17 Rust audit tests**, all passing in the
final isolated capture. The previously named 706-pass audit now emits **3,543
captured passes per model/mode**, covering all five hosts. The unchanged
`scripts/signed-thinking-differential.sh --compare-only` inventory/eligibility/
exact-wire comparator passed **7,892 comparisons**, with **no additions or
exceptions**. Both model-class inventories were **7,086 files per arm**, and
independently captured manifest hashes matched. `provider-preparation-signed-thinking.json`
retains those counts, source SHAs, dependency-control limitation and manifest hashes.
No signed-thinking test contract or comparator exception was changed.

Finally, Linux `bun run build` passed the plugin/v2, Pi and CLI bundles and checked
nine unchanged TUI files. Rechecking `auto-search-bundle-review.test.ts` after that
build passed **9 tests, 2 skips**, with its normal `lsof` scratch-store evidence.
Together with the regenerated-schema/configuration follow-up, only the original
unrelated Node-WASM scratch-module resolution failure remains from the complete
plugin run. Root `bun run typecheck` also passed all **seven configured TypeScript
checks across four packages**; root `bun run lint` passed **1,923 files** with 123
existing warnings and ten infos, no errors. Final scoped diagnostics again covered
all three E2E scripts with zero errors/warnings (two deprecated-API hints).
Offline real-handler runs also used the driver's `lsof` fence: every
observed `.db`, WAL and SHM path was beneath its declared throwaway
`$TMPDIR/magic-context/provider-preparation-*/run-*/stores` root. No live store,
configuration or session directory was opened, read, migrated or written.

**Delivery scope:** the five-step guarded-preparation experiment is implemented
and its correctness/timing gates are recorded. Complete production meters, live
ALF canary approval, a full packaged-ancestor audit and the ≤1.10× rebuild sign-off
are **not delivered**. Keep both provider/preparation rollout defaults unchanged.
