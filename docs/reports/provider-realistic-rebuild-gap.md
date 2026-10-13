# Realistic provider rebuild: measured gap and review boundary

Status: profiling and provider-only design, **no serving optimization**. The owner
replaced the rebuild/full-array ratio goal with absolute targets: ordinary ck-mc
hooks <=10 ms (network excluded) and fold/rebuild <100 ms, independent of session
age. The 1,500 ms product hook fence stays unchanged. The planned 24-hour ALF
canary (the owner's long-lived session) is not authorized by these measurements.

## Fixture and method

The new `--realistic` arm in `provider-preparation-timing.ts` seeds a legitimate
17,000-message stored lineage, then folds ordinals 1–16,500 into 2,300 compartments
and seeds 1,000 active project memories using test-only isolated-store APIs. The
live full-request input is the remaining **500** native messages, with explicit
absolute ordinals and a declared trim at the committed boundary. The provider
rebuild request has no new messages; the provider already owns the earlier
admissions. It nevertheless reconstructs all 17,000 stored messages today.

The large provider policy working set is **74,800 parts**. The normal fold leaves
three `core.frozen_units` in this fixture. This is **not** the owner's 72,000-unit
mode-2 engine state, and policy parts are not being mislabeled as frozen units.
Per the owner's direction, no invented frozen payloads or synthetic 72,000-unit
arm was added. Actual historically frozen reduction units would be a separate
population if a provider session carrying them is available.

Each sample forks store.db and context.db **before rebuild**. Preparation off/on
arms and the trimmed full-array side arm start from the same snapshot; order
alternates. A single existing compartment changes before each sample, followed by
a flush/model-switch HARD opportunity. The first hook admits the next assistant
message at ordinal 17,001; a following ordinary hook admits another message at
17,002. Preparation is controlled by the real off-by-default request flag. The
harness compares complete raw rebuild/first-hook/ordinary-hook answer bytes
between off/on arms; it reports misses rather than enlarging any host deadline.
The full-array path is measured as a **side column**, not the acceptance baseline
or an optimization target; its internal renderer epoch is not the provider epoch.

The profile overlay archives committed source and adds uniquely matched timers
only to a scratch source copy. Original source hashes are checked before and after.
Existing engine `TransformTimings` are copied into diagnostic records, including
nested composition timers; stage nesting is retained rather than added twice.
All fixture/oracle databases are below `$TMPDIR/magic-context/`; `lsof` isolation
checks and the trapped session.read runner remain active. No live store/config
paths were opened. Cargo compilation and execution were on Linux with 4 vCPUs.
Bun 1.4.2, Rust/Cargo 1.99.0; the remote runner did not refuse any job for
lack of available capacity.

Reproduction:

```sh
MC_TIMING_RESULT_OUT="$TMPDIR/provider-realistic-profile.json" \
  bun packages/e2e-tests/scripts/provider-preparation-timing.ts 100 --profile --realistic
```

The result records the fixture counts, full module/wall timings, every request's
stage durations/call counts, and CPU load/PSI/cpu.stat around each operation.
Instrumented timings are diagnostic, not an estimate of uncontended production
p99. Host/root-cgroup PSI and missing cpu.max do not prove the allocated job was
unthrottled. No CPU-share correction or exclusion of outliers is applied.

## Pilot (not p99 acceptance)

`docs/reports/provider-realistic-pilot.json` preserves the five-sample-per-binding
un-instrumented seed/trim validation. These five-sample nearest-rank p99 values are
maxima, not population-tail estimates. All 20 first hooks missed the product fence.

| Binding / preparation | Rebuild median ms | First-hook median ms | First-hook maximum ms | Trimmed full-array median ms |
| --- | ---: | ---: | ---: | ---: |
| OpenCode 1 / off | 10,130.996 | 3,928.802 | 4,134.991 | 530.501 |
| OpenCode 1 / on | 10,642.626 | 5,378.789 | 7,303.917 | 530.501 |
| OpenCode 2 / off | 9,375.048 | 2,840.872 | 3,073.604 | 457.178 |
| OpenCode 2 / on | 10,596.807 | 6,009.396 | 12,747.814 | 457.178 |

The old five-fresh-17k-message profile is retained in
`provider-rebuild-cost-before-profile.json` for provenance only. Its whole raw
array is an obsolete fixture for acceptance. A subsequently started 100-sample
old-shape run was cancelled when the owner replaced the target; no completed p99
or target claim is made from that cancelled run.

## 100-sample diagnostic profile

`docs/reports/provider-realistic-rebuild-profile.json` preserves all **400**
provider arms and **200** matched full-array side samples. Each of the four
provider lanes has 100 samples. The run took 8,168 s on Linux, 4 vCPUs, from
the harness at `3e08dfbd8b1651df4152cecfeb61ba94978ffbcc`; production Rust remained
the base revision's source. All 200 prepared first hooks consumed preparation.
All 400 off/on rebuild, first-hook and subsequent-hook byte comparisons passed;
**all 400 first hooks exceeded 1,500 ms**. Timing success means the observations
were collected, not that any performance target passed.

All table cells are **median [nearest-rank p99] ms**. OC1 and OC2 denote the
OpenCode 1 and OpenCode 2 host bindings. These are a repeated
synthetic-fixture population under measured contention, not a production p99
confidence bound.

| Binding / preparation | Whole rebuild | First hook | Following ordinary hook | Trimmed full-array side column |
| --- | ---: | ---: | ---: | ---: |
| OC1 / off | 9,363.849 [19,217.005] | 3,058.280 [9,913.499] | 5.322 [897.597] | 443.926 [1,242.377] |
| OC1 / on | 9,743.020 [22,419.375] | 5,466.581 [12,575.477] | 5.202 [1,611.482] | 443.926 [1,242.377] |
| OC2 / off | 10,711.057 [18,964.616] | 3,389.612 [7,117.447] | 7.391 [1,710.316] | 540.385 [1,943.833] |
| OC2 / on | 11,315.689 [22,087.036] | 5,982.851 [13,467.661] | 7.096 [2,796.724] | 540.385 [1,943.833] |

The ordinary medians meet 10 ms, but p99 does not. Above-10-ms ordinary counts are
31/100, 30/100, 44/100 and 38/100 respectively. The diagnostic result retains
ordinary module/wall/pressure observations, **not ordinary sub-stage profiles**;
the exact reason for their outliers is not established by this run. Neither root
PSI nor zero observed throttling counters justify labeling those outliers solely
CPU contention. First-hook “other” below also contains unseparated transaction,
admission/write, serialization and teardown work. Add those timers before an
ordinary-hook acceptance claim.

### Rebuild split and gap

| Work | OC1 off | OC1 on | OC2 off | OC2 on | Proposed destination budget |
| --- | ---: | ---: | ---: | ---: | --- |
| Replay stored lineage/overlays | 100.774 [238.715] | 96.213 [226.496] | 114.569 [240.640] | 115.484 [219.644] | Delta drain + validation: 5 ms combined |
| Native request conversion | 621.721 [1,348.780] | 614.954 [1,227.906] | 741.080 [1,601.651] | 728.507 [1,527.100] | Eliminate old-history conversion; tail/new inputs only |
| Prior-view materialization | 970.423 [1,923.216] | 948.483 [1,653.346] | 1,178.801 [2,455.022] | 1,095.061 [2,555.052] | Resident immutable descriptors/chunks, no full clone |
| Engine (inclusive) | 5,831.850 [10,174.364] | 5,703.150 [13,086.766] | 6,454.041 [13,217.010] | 6,493.252 [12,440.342] | Replace full-array wrapper with provider fold gate |
| ↳ Full projection | 228.677 [379.600] | 224.840 [414.832] | 232.605 [475.099] | 229.984 [523.223] | Admission-maintained projection; no fold re-projection |
| ↳ Cache-state read | 36.864 [79.314] | 36.098 [70.606] | 36.342 [76.282] | 35.402 [69.400] | Bounded header/revision checks in 5 ms allocation |
| ↳ Tag read/cache hydration | 15.530 [28.882] | 14.393 [26.819] | 12.664 [25.367] | 13.477 [27.021] | Resident/delta tags in shared gate/index allocation |
| ↳ m0/m1 composition | 32.976 [64.712] | 33.076 [66.970] | 37.500 [95.010] | 36.575 [87.090] | Changed fragment rendering/tokenization: 20 ms |
| ↳ Store commit | 3,928.493 [7,646.901] | 3,871.766 [10,468.428] | 3,951.321 [9,138.135] | 4,034.211 [9,749.915] | Delta checkpoint/view transaction: 20 ms combined |
| Engine-wrapper residual¹ | 1,293.309 [2,624.258] | 1,202.015 [2,757.035] | 1,721.921 [3,165.881] | 1,656.613 [3,986.340] | Remove full template/view clones and served-array comparisons |
| Native view build | 511.286 [963.210] | 491.065 [900.980] | 588.085 [1,120.109] | 562.346 [1,489.531] | Tail/frame finalization: 20 ms |
| View persistence (inclusive) | 62.726 [1,289.781] | 50.045 [4,630.025] | 79.085 [2,656.378] | 67.104 [2,693.621] | Same transaction allocation as checkpoint above |
| Response Value conversion | 7.600 [28.923] | 7.565 [16.581] | 8.225 [17.111] | 8.606 [18.332] | Encoding/publication + remaining work: 20 ms combined |
| Response encoding | 2.516 [6.355] | 3.457 [7.666] | 2.873 [7.767] | 3.891 [7.662] | Same encoding allocation, exact old serialization stage |
| Policy preparation | — | 651.565 [3,963.077] | — | 783.062 [3,576.386] | Maintained pending baseline/index, not a full array preparation |

¹ Per sample, outer engine timer minus `TransformTimings.total`; the residual
includes `transform::compaction::run`'s template cloning and served-view comparison/
allocation outside the inner transform. It is not a separate measured attribution
to any one of those operations. See `transform.rs:2587,2628-2648,2724-2739`.

Every rebuilt engine projects **17,000 messages / 57,800 blocks** and emits 500
tail messages. Every prior immutable row is **28,659,413 bytes** despite the short
live tail. This directly demonstrates that stored-history conversion/view work
has not become tail-bounded. The sub-100-ms target fails by about two orders of
magnitude even without ALF's reported large historical frozen-unit state.

### First-hook split and gap

| Work | OC1 off | OC1 on | OC2 off | OC2 on | Proposed destination budget |
| --- | ---: | ---: | ---: | ---: | --- |
| Effective parts read/decode | 284.479 [553.941] | Prepared path | 308.770 [609.566] | Prepared path | Delta-only policy state; 2.5 ms policy allocation |
| Inputs/baseline computation | 77.260 [164.898] | Prepared path | 89.729 [204.834] | Prepared path | Same policy allocation, actual admitted cut |
| Full bounded-summary build | 43.131 [92.236] | Prepared path | 47.214 [118.866] | Prepared path | Maintain exact aggregate/index changes |
| Baseline → write JSON | 270.358 [609.616] | 274.675 [593.304] | 306.823 [737.991] | 326.681 [692.685] | No full baseline array in hook write |
| Extract/clone update array | 112.698 [244.605] | 116.654 [269.627] | 131.760 [368.496] | 146.120 [313.167] | Delta rows only; transaction allocation 3 ms |
| SQL measurement restatement | 1,477.665 [4,782.754] | 3,188.953 [6,236.044] | 1,510.760 [2,809.626] | 3,393.915 [6,551.315] | Baseline descriptor/overlay needs durable representation approval |
| Change-log clear | 0.081 [0.360] | 674.006 [1,048.150] | 0.089 [0.357] | 712.497 [1,136.291] | Account bounded frontier, never bulk delete newer changes |
| Summary row write | 7.692 [14.298] | 7.925 [12.182] | 9.504 [19.855] | 9.436 [20.350] | Bounded checkpoint/summary transaction allocation 3 ms |
| Other² | 620.772 [7,318.899] | 1,084.969 [6,063.013] | 685.608 [4,010.791] | 1,136.461 [7,882.695] | Must split and bound before claiming <=10 ms |

² Per-sample whole diagnostic hook minus the non-overlapping hook timers.
Prepared computation/decoding is not separately instrumented in this table; do not
interpret “Prepared path” as zero work. Detailed remaining timers are in the JSON.

Each cold first hook reads 74,802 parts and supplies **57,800** baseline updates.
Preparation avoids the cold full input/summary computation, but still supplies the
same 57,800 updates. On this fixture it clears **56,102 change-log rows** versus
zero in the cold arm. A summary exists during prepared refreeze/restatement, so
the existing summary triggers record changes (`store_068_provider_policy_summaries.sql:46-69`);
that accounting explains an additional concrete stage, not a claim that it
explains every prepared/cold wall-time difference. “Consumed” does not mean cheap.

### Load, limits and representativeness

| Lane | 1-minute load range | Rebuild host PSI p99 % | First-hook host PSI p99 % |
| --- | ---: | ---: | ---: |
| OC1 off | 7.93–50.57 | 25.303 | 25.261 |
| OC1 on | 7.61–55.84 | 21.000 | 27.641 |
| OC2 off | 10.71–44.50 | 20.415 | 21.303 |
| OC2 on | 10.60–45.14 | 30.418 | 27.901 |

The exposed host/cgroup PSI totals match; cpuset is 0–31, nproc is 4, cpu.max is
absent and exposed throttling deltas are zero. These root/shared observations are
not per-job throttling evidence. Per-operation raw snapshots remain in the report.
The corpus matches counts/coverage but uses short synthetic compartment/memory
bodies, uniform importance and no captured historical reduction payloads. Its
33–38 ms composition median **does not reproduce ALF's reported 3.9 s composition
or 72,000 frozen units**. Fragment bytes, tier diversity, signed reasoning and
changed-memory stress remain additional acceptance populations. The 4 s provider
commit and bulk-baseline bottlenecks are directly measured here; fixes to them
cannot be replaced by an extrapolation from short-body composition.

## Scaling map: what the resident path must replace

This is a map of the engine/provider hot paths inspected, not a claim that every
transitive SQL writer was exhaustively audited. The resident-state design below
requires that write inventory before its revision/key coverage can be certified.
Inclusive parents and their children must not be summed.

| Stage | Scaling input today | Required replacement / target allocation | Source |
| --- | --- | --- | --- |
| Load/replay messages and overlays | All stored lineage messages + all live hook answers, although only 500 raw messages remain | Tail/native checkpoint plus incorporated event frontier; bounded delta drain within fold's 5 ms validation budget | `crates/mc-module/src/providers/compaction.rs:196-309,498-513`; message/answer loaders in `crates/mc-store/src/provider_log.rs:1372-1401` |
| Request conversion/projection | The rebuilt full lineage; provider decode clones ordinal-stamped native objects and original sidecars | Keep exact sidecars/CK projection from admission; project new messages only (hook decode budget 1 ms) | `crates/mc-module/src/providers/codec_opencode.rs:27-54`; `transform.rs:4403-4429,4514-4545` |
| Prior-view materialization | Entire typed view JSON, then two owned CK engine clones | Validate reference/eligibility separately; retain immutable view/chunk locators and bounded descended descriptors | `providers/compaction.rs:363-377,585-608` |
| Engine snapshot and tags | Full cache/frozen/identity snapshot; cold tag rows include source bytes. Warm tag cache already has generation/count/max checks, but downstream scans remain | Resident namespace snapshot + append/delta tag indexes; no full decode per fold | `transform.rs:4557-4567,11350-11564`; `mc-store/src/lib.rs:8712-8800,9743-9808` |
| Identity, coverage, planning/protection | Projected blocks, frozen-unit keys, tags/protected/reduced sets and sometimes compartments | Indexed boundary/identity and protection/window aggregates; fold gate budget 10 ms, hook policy budget 2.5 ms | `transform.rs:4557-4795,5034-5074,5121-5810` |
| HARD m0/m1 composition | Entire score-selected compartment snapshot and memory/workspace candidates; selection/sort; repeated render/token-fit attempts | Maintain ordered selection indexes, exact tier fragments/token counts and memory deltas; render only real changed fragments within 20 ms | `m0_compose.rs:248-335,386-445,530-670`; `m1_compose.rs:236-319,532-759`; `transform.rs:10387-10470` |
| Frozen/output caches and builder | Frozen-unit/set snapshots, per-mid/block indexes, per-message identities, tail output traversal and possible repeated builds | Paged persistent indexes and accepted normalized chunks; <=500-message tail plus changed frames within 20 ms | `transform.rs:7471-7829,17373-17963` |
| Durable engine/policy publication | Engine snapshot/identity writes and namespace-wide rewrite of every conversation's policy parts | Delta checkpoint/frontier; no all-part rewrite, within fold transaction's 20 ms budget; needs representation review | `transform.rs:7852-8051`; `mc-store/src/provider_log.rs:161-200` |
| Native view rendering | Re-decode native request, clone replacement and native values | Reuse the exact ingress/normalization-stage sidecar and render context; do not substitute raw lexemes or durable wire bytes | `providers/codec_opencode.rs:98-117`; `mc-module/src/lib.rs:15168-15190,15471-15517` |
| Durable view + response tree/encoding | Full typed HostView serialization, Value conversion and response serialization; unavoidable output-byte work | Separate exact durable and response-stage chunks with fresh envelope; encoding/publication allocation 20 ms only under explicit byte bound | `providers/compaction.rs:342-361,1313-1354` |
| Rebuild preparation | Full parts read, measurement array, summary build/serialize and derived payload publication | Resident original baseline + pending admitted-cut aggregates; avoid another O(parts) rebuild preparation | `providers/policy_summary_preparation.rs:27-93` |
| First hook policy fallback | All parts read/decode/order, full inputs/baseline and full summary walks | Indexed delta policy calculation preserving admitted newest cut; hook policy allocation 2.5 ms | `providers/policy_summary.rs:465-630,1139-1230`; `tail_hygiene.rs:835-869,937-1041` |
| Prepared first hook | Replay may still refresh the complete measured array and refreeze at the new cut | Incremental baseline descriptor and per-part overlays, not an earlier baseline publication | `providers/policy_summary_preparation.rs:108-259` |
| First hook measurement publication | Full baseline JSON update array, owned-array clone, per-part SQL restatement, summary-trigger/revision work | Bounded changed rows/frontier under 3 ms transaction budget; physical-vs-effective durable identity must be settled first | `providers/step_transform.rs:911-919`; `mc-store/src/provider_log.rs:438-461,1323-1355`; migration 68 summary triggers |
| Ordinary hook | New subject decode/project; bounded summary replay/window/arc/hint updates, or full fallback | All above fallback causes must be bounded or handled before ready-state admission; complete handler <=10 ms including lock/SQL/ops | `providers/step_transform.rs:571-969`; `providers/policy_summary.rs:737-1137` |

## Review boundary

`docs/designs/provider-resident-incremental-state.md` defines the proposed actor
shape, caps, authority/key tuples, recovery/checkpoint frontier, one fold gate,
latency allocations and independent byte/mutation controls. Restructuring is
required. Caching renderer output alone cannot meet these targets while the
provider reconstructs the full stored lineage and physically restates old parts.
No production Rust, migrations, configuration defaults, time limits, TypeScript
transform or mode-2 implementation has been changed. There is therefore no
post-optimization timing table or serving-cache mutation proof to claim yet.

## Verification of this profiling/design increment

- `bun test packages/e2e-tests/scripts/provider-post-rebuild-profile.test.ts`:
  2 tests, 25 assertions passed; Bun 1.4.2. Diagnostic source drift still refuses
  rather than silently omitting a stage.
- `bun packages/e2e-tests/scripts/pure-replay-differential.ts --provider-pipeline`:
  90 checks passed, no failures; Bun 1.4.2, Cargo/Rust 1.99.0. This reruns the
  shared fixture/driver infrastructure; it is not proof of a new serving cache.
- `bun packages/e2e-tests/scripts/provider-preparation-differential.ts 48`:
  96 paired pre-rebuild cases, 96 consumed preparations, exact answers,
  measurements and summaries passed; the same tool versions.
- `bun run --cwd packages/plugin typecheck` passed with the repository script.
  Scoped `bunx --no-install tsc --noEmit -p ../e2e-tests/tsconfig.provider-pipeline.json`
  from `packages/plugin` (TypeScript 5.9.3) reports the two inherited diagnostics
  at `e2e-tests/src/rust-harness.ts:805` and `plugin/src/hooks/magic-context/command-handler.ts:223`,
  as already documented in the performance-gate report. No changed-file diagnostic
  was reported; scoped editor diagnostics cover all three changed scripts with
  zero errors/warnings. The first root-level tsc invocation could not resolve an
  installed binary; the package-local installed compiler was used, not fetched.
- The 720+48 randomized Rust parity and signed-thinking audit were not rerun:
  production serving code is unchanged and implementation is awaiting design
  review. They remain mandatory gates, together with named mutations, for the
  future resident serving path. No mutation proof for unimplemented serving
  behavior is claimed.
- No manifest/lockfile changes or installs, no product deadline/default change,
  no migration, no live-store access and no ARCHITECTURE.md/STRUCTURE.md edits.

The project owner instructed: commit the design with the profile, then hold for
implementation authorization in this worker. Performance remains above target;
this increment delivers the review boundary, not a canary approval or a speedup.
