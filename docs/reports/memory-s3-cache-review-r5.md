# Independent memory S3 cache review, round 5

**Reviewed:** `9c50835a8eae4a1857049571c546100a084ba531`, the six commits after `fa2facc05d9a86d1bd9acc8d2dcc58f63b197b19`. **Recommendation: do not sign off the complete round-5 claims yet.** The narrowed memory-pair gate, automated expiry route, overflow replay, and served-state survivor/duplicate fixes pass the independent checks below. The automatic-search **never recompute an already-served message** claim fails in two reachable TypeScript host paths. This delivery changes only this report and opt-in review evidence; no product code, schema, `ARCHITECTURE.md`, or `STRUCTURE.md` changes.

Read [the round-4 report](memory-s3-cache-review-r4.md) and [the replacement design](../designs/memory-s3-projection.md). This review uses the following accepted contract:

1. Only the memory pair's decisions/renderers/commit must avoid memory rows and logs on SOFT. Automatic search and explicit `ctx_search` may read current memory outside that pair. A hint is computed once for a new user message, persisted, and replayed thereafter.
2. Module-routed expiry rechecks the declared expiry inside an automated transaction, with undo history but no log row or fragment.
3. Non-HARD memory/log aggregates that drive no decision are removed, including Rust's m1 digest slots; remaining aggregates must name their decision.
4. Full fragments leave a marker reserve; after it is exhausted, rejected operations join one aggregate line. Earlier shown full fragments/individual markers never shrink.
5. A merge includes an unchanged survivor's text if this session has not shown it.
6. An explicit save matching an unshown duplicate emits a fragment.

m[0]/m[1] denote the frozen baseline and its cached delta. HARD rebuilds them from canonical rows, busting SOFT refreshes the delta with the session's authorized receipts, and defer replays cached bytes without refreshing. Rust calls its replay opportunity `SOFT+` and its armed refresh `SOFT`. A fragment is an immutable operation receipt; a served manifest records the exact text/representation last shown by a session. Pending fragments are stored but not yet shown/committed to the pair. A witness is a named test checking an observable assertion. A user tail means the user's message is the last element of the current message array. A hint is separate tail text, not a memory receipt.

## Findings by severity

### P1 — a retryable search exception leaves an already-served user tail eligible for a fresh hint

OpenCode's runner catches a search exception and returns `search-failure` **without persisting a hint/no-hint decision or a sticky skip** (`packages/plugin/src/hooks/magic-context/auto-search-runner.ts:367–375`). Pi does the same (`packages/pi-plugin/src/auto-search-pi.ts:469–477`). Both subsequent invocations can search again if the same user ID is still the physical tail. Neither knows that the previous request already served that tail without a hint.

The independent sequence is:

1. Warm a real memory pair and submit user `u1`.
2. Make only the search worker throw a transient error. The runner/processor returns normally with `Explain cache ownership` and no hint.
3. Submit the same ID/text on another defer, or after an answered-tail revert, model fold, or database reopen.
4. Let the worker return one result. The same message now has an additional `<ctx-search-hint>` block.

All **12 runner witnesses** fail: for each of `opencode`, `opencode2`, `pi`, `r5 a search exception cannot rewrite an already-served user tail after {defer,revert,model fold,reopen}`. The actual postprocessing functions confirm that the runner defect is not masked by a host-level veto: all three `r5 a full host processor cannot retry a served search exception` witnesses fail. The second returned request contains the new hint. OpenCode catches optional search failures and continues (`transform-postprocess-phase.ts:3718–3744`); Pi's local catch also continues to the normal `{ messages }` result (`context-handler.ts:3949–4003,4483–4488`).

Captured mismatch:

```text
Expected: Explain cache ownership
Received: Explain cache ownership

<ctx-search-hint>
Your memory may contain 1 related fragment:
- Independent search-only hint
...
</ctx-search-hint>
```

The worker result is mocked deliberately: the property under test is durable decision/eligibility handling, not search relevance, embeddings, or a provider service. The real runner and real host processor execute. In the runner variants the pair itself stays byte-identical; the defect rewrites the **tail**, not m[0]/m[1]. An ordinary timeout is different: the existing timeout tests pass because that path freezes the skip. Rust propagates a lexical-search failure instead of completing that transform, so this particular served-exception failure is not established for Rust.

**Required direction:** once a pass returns a served search omission, freeze that decision for its user ID. If search exceptions really must be retryable, retry before serving, or bind a later result to a new user message; the physical-tail check alone cannot establish freshness. The existing Pi test `does not persist no-hint decisions for retryable search errors` intentionally requires no persisted decision after a retryable search error, leaving the same ID eligible for a later search. Changing it requires an explicit explanation of the served-byte contract, not merely changing its expected value.

### P1 — cache-busting branch pruning forgets a served hint, so restoration recomputes it

Successful decisions are ordinarily durable and replay correctly. However, OpenCode prunes decisions absent from the current message array on a full-feature cache-busting pass (`transform-postprocess-phase.ts:3753–3767`). Pi has the corresponding resolved-ID, nonempty-set, cache-busting cleanup (`context-handler.ts:8484–8509`). `pruneAutoSearchHintDecisions` actually deletes those entries from persisted JSON (`storage-meta-persisted.ts:1829–1847`). Reintroducing the same previously served ID is therefore not replay-only.

The independent host-processor test first serves `u1` with `Independent search-only hint`, then serves a truncated branch containing `u2`. A real model change forces that second pass to bust. The test **asserts that the saved `u1` decision was removed**, changes only the worker's next result, and restores the original `u1` ID/text. The returned request contains `Recomputed changed hint` instead of the first hint. All three `r5 a full host processor preserves a served hint when a truncated branch is restored` tests fail at the byte-content assertion, after the pruning prerequisite succeeds.

This is a conditional revert/restore path, not a claim that every host revert prunes: a plain non-busting disappearance did not prune in the initial control. A successful hint followed by a defer, an assistant-tail revert that leaves the ID represented, a model fold with the ID still present, and reopen all pass. The failure specifically requires an intervening cache-busting pass that no longer includes the anchor. No actual deployed `/undo` command was launched; the processors receive the corresponding truncated/restored message arrays.

**Required direction:** distinguish “not in this served branch/window” from “may never reappear.” Retain enough immutable decision state to replay an already-served ID after branch restoration, or document a different contract. Under the never-recompute contract stated above, deleting the decision and searching again is not compliant, even though a model switch independently invalidates the provider cache.

### P3 — the design still contains obsolete descriptions of removed watermarks

The contract and aggregate table correctly describe the removal, but the Rust deviation row still says memory watermarks feed the m1 digest and open one execute-band SOFT (`memory-s3-projection.md:131`). That contradicts its own lines 87–93 and the current zero slots in `m1_compose.rs:261–273`. The shared `mustMaterialize` commentary also still describes additive memories riding the old row watermark and reconciliation cursor (`inject-compartments.ts:2020–2023`). These are stale descriptions, not evidence of a surviving read. They were not edited in this report-only task.

## Results in the requested order

### (a) Automatic search and memory-pair separation

| Sequence | OpenCode 1/2 and Pi | Rust |
| --- | --- | --- |
| New eligible message, successful hint | One worker search and one lazy visibility resolution per tested ID | One lexical search for the new user block |
| Repeat/defer after successful decision | Exact hint replay, no second search, same memory pair | Exact tail and pair replay, no second lexical query |
| Assistant-tail revert retaining the hinted ID | Pass | Pass |
| Model change while the hinted ID remains | Hint replay passes; HARD itself may legitimately rebuild the pair | HARD observed, hint unchanged, query count unchanged |
| Close/reopen persistent fixture DB | Hint replay passes after clearing process caches | Store dropped/reopened; hint replay and query count pass |
| Returned search exception, then same physical tail | **Fail**, including all four lifecycle variants and actual processors | Error propagates; no completed served-skip proof of the TS failure |
| Cache-busting truncated branch, then restored served ID | **Fail**, actual processors prune and recompute | Not independently exercised in the Rust patch |

The Rust probe uses a low-pressure new user tail after an existing HARD, asserts `SOFT+`, and compares actual m[0]/m[1] before/after the hint. It also checks defer, assistant-tail revert, model HARD, and true store reopen. The query counter is reset after the **different baseline user message's** decision, and persisted rows are counted for `u#0`, not for the whole session. Those fixture distinctions mattered: the initial probe incorrectly counted the baseline's legitimate query/no-hint row; that fixture-induced failure was corrected and is not a product finding.

The existing named-reader probes and 55 automatic-search regressions pass. Some named-reader tests stub the runner itself, so they establish the placement of the lazy resolver, not real hint durability. The new probes run the real producers/processors and stub only search result production. None of these tests is a recorded provider-cache-hit measurement or a deployed-host run.

### (b) Aggregate overflow, replay, and HARD folding

The independent aggregate test passes for all three TS/Pi drivers at the valid minimum **500-token memory budget**:

- Thirty authorized updates exhaust full-fragment space and the individual-marker reserve.
- Exactly one `<more-memory-edits count="N" …/>` line is present. Every previously shown full receipt/individual marker remains verbatim.
- Repeated busting SOFT, defer, an identical operation-key retry, automated canonical edits, another session's save/HARD, and close/reopen all leave the pair and aggregate line identical.
- One new own operation increments N by exactly one. Foreign changes and replays do not increment it.
- A subsequent HARD shows the final current own text once, includes the foreign current rule, removes the old aggregate/receipts, and is stable on the next SOFT. Earlier updates to the same row are superseded revisions, not additional canonical rules to concatenate.

The implementation derives the line from persisted overflow IDs/count and the next own fragment ID (`inject-compartments.ts:3431–3540`), with stable first-occurrence ID order and a bounded ID listing (`:3401–3412`). It does not reread canonical rows to regenerate overflow. The tests compare actual previously served bytes rather than computing an expected pair with the composer. The aggregate is an intentionally mutable summary; the “earlier fragments never shrink” assertion applies to the already-shown full receipts and individual markers, not to freezing an aggregate while N grows.

The round-4 test `full allowance still gives an oversized operation a marker` expects a separate `<stale-memory ids="2"` for the last edit and still fails for all three hosts. The observed replacement is:

```xml
<more-memory-edits count="18" ids="1,2" note="18 more memory edits apply at the next rebuild; read them with ctx_search"/>
```

Replacing the last edit's separate marker with the aggregate is the accepted overflow policy stated above, not an unannounced edit. The round-4 test was not rewritten. The permanent/shared reserve tests pass, as do independent 42-row archive and new **42-source merge** controls: one complete operation or one marker, no partial supersession admission, retry equality, and exactly one surviving canonical merge text after HARD.

Limits: HARD selects current canonical rows under its normal memory budget; it does not concatenate every historical receipt or promise an oversized current row fits. The aggregate is appended after reserve exhaustion rather than charged against the remaining individual-marker reserve; this review does not certify an exact total-token cap including that aggregate. Rust agent fragment production is deferred to the next memory-lifecycle implementation slice (S4), so TS-style aggregate tests do not apply to its current producer.

### (c) Removed watermarks and genuine HARD controls

The strict statement-execution observer in `docs/reports/probes/memory-s3-r4.probe.ts` now passes for **opencode, opencode2, pi**, including memory/log aggregate SELECTs. Four original Rust full-transform table-removal tests now pass: both `SOFT` and `SOFT+`, with `memories` and `memory_mutation_log` hidden separately. The permanent `memory_only_change_opens_no_execute_band_soft` and related Rust memory-revision regressions pass. These are stronger than proving only the row renderer does not run.

Positive controls independently demonstrate that the read-free decision still reacts to genuine HARD inputs:

| HARD decision | TS OpenCode 1/2 and Pi evidence | Rust evidence |
| --- | --- | --- |
| Project memory epoch | Independent epoch bump after an unseen automated edit, tested on defer as well; HARD exposes current text and consumes the trigger | `r5_project_epoch_and_pressure_refold_still_fire`, plus existing eager-epoch and compaction trigger tests |
| Eager epoch write using dashboard SQL | A **separate SQLite writer connection** applies the dashboard's `project_state` insert/increment SQL after a warmed marker probe; next defer HARDs, new text appears, following SOFT is not HARD | Epoch input above tests the shared database effect; no Tauri command invocation |
| Pressure backstop | Independent small-m[0]/large-history-delta case crosses the absolute m1 cap on each of the three drivers; refold observed | Independent `pressure_refold` reason after appending another compartment |
| Idle TTL, model/system changes, legacy/config/budget changes | Shared regressions, taxonomy tests and the 72-test Pi injector suite | Relevant memory and genuine-HARD regressions; model HARD in the new hint probe |
| Correction-only pressure must **not** authorize HARD | Shared pending-lifecycle tests, overflow/stress controls | Existing `memory_corrections_make_no_pressure_and_a_hard_keeps_ready_notes_out_of_m1` |

The dashboard SQL copied into the independent probe is exactly the eager epoch operation in `packages/dashboard/src-tauri/src/db.rs:6008–6015`. This proves consumption of that signal, not dashboard UI approval/undo behavior. The independent probe tests the eager epoch operation only. A dashboard **log-only archive** does not become an eager-epoch operation: it waits for a HARD trigger from another source, as already distinguished in the round-4 report.

No genuine HARD trigger was shown lost by the exercised removal. That is a tested input matrix, not proof of every production race, privacy-revocation hook, or mural/provider interaction. The aggregate table in the design names the remaining HARD-only memory heads and their fold-cursor/commit-fence decisions; the independent read gates detect a genuine injected non-HARD memory SELECT (non-vacuity evidence below).

### Module-routed automated expiry

The independent facade probe calls the **new actual route**, `memory.expire`, with an expired row, an expiry extended after sweep selection, an absent (`NULL`) declared expiry, an already-archived row, and a foreign-project row. Only the genuinely expired owned active row is archived; the extended/undeclared/foreign rows stay active. Total rows afterward are **one history, zero mutation log, zero fragments**. Repeating the same command returns the identical terminal response and still one history row. This passes, in addition to the permanent expiry/router tests.

The unchanged r4 Rust probe still calls `ctx_memory`/`archive`, the **old agent command shape**, and still observes `(1 log, 0 history)`. It no longer exercises the module-routed dreamer expiry implementation, so its red result is not an expiry regression. Likewise the old Rust automatic-producer witness still fails because it forbids memory reads during new hint production, a read explicitly permitted by the contract stated above.

### (d) Served survivor and duplicate decisions

The independent cross-session controls pass for OpenCode 1/2 and Pi:

1. Session B folds before the survivor exists. Session A folds after it exists and shows its text.
2. A merges a new source into that unchanged survivor: only supersession is added, not redundant survivor prose.
3. B merges a different source into the same survivor: the full unshown survivor text is included.
4. After B has committed that full fragment, its next unchanged-survivor merge does not duplicate the text.
5. An automated change to the survivor means A's old manifest is no longer an exact text match. A's next merge includes the new text; B's untouched pair does not acquire it.

The duplicate-save control similarly proves A's displayed text suppresses a redundant fragment, but does not suppress B's explicit save. Two explicit saves before B's next SOFT each leave a pending fragment: **pending** is not **served**. After those full fragments are committed, another same-text save leaves the pair unchanged. The test explicitly expects two receipts for two different pre-commit operations; the same operation-key retry controls elsewhere remain one immutable operation.

`sessionShowsMemoryText` reads only this session/harness's served row text/representation and committed **full** fragment text (`memory/applied-projection.ts:381–437`). It does not use canonical “new/changed” as the suppression predicate. The independent cases cover another session's manifest, an older served revision, a committed own full fragment, and an uncommitted own fragment. Marker-only fragments do not qualify in the source. Rust still lacks production of these own agent fragments; that deferred behavior is not a newly claimed fix.

### (e) Regressions and fresh randomized byte stability

The new seeded sequences use **550 iterations per driver** (2,200 total across OpenCode 1, OpenCode 2, Pi, Rust), seed `0x91ce57b`, distinct from the r4 sequence. A TS/Pi iteration performs the mutation then a defer, a busting SOFT, repeat SOFT and repeat defer. The mix includes own saves, oversize saves, updates, merges, archives, automated verify-style updates, other-session saves/HARDs, no-ops, and true connection reopen. The per-driver action counts are `66,65,65,54,56,64,62,65,53`; all nine actions are reached more than twenty times.

Each iteration checks that defer is exactly the last pair, m[0] remains unchanged on SOFT, foreign/automated text stays out, existing receipts/individual markers remain verbatim, and unchanged own state gives exactly the last pair. Once overflow exists, equal N means equal aggregate bytes. Other-session HARDs do not reset this session's overflow or fragments. These tests all pass.

Rust's independent full-transform sequence mixes agent insert/update, **actual gated verification updates**, oversized updates, other-session HARDs, and store reopen. It asserts `SOFT+` and armed `SOFT` pair equality for each iteration. Its counts are `[83,104,92,88,88,95]`; all actions are reached more than fifty times. It intentionally expects no Rust fragments. This is engine/driver evidence, not deployed OpenCode/Pi/Rust-daemon provider-wire stress.

#### Round-1–3 witness accounting

The original reports were recovered from repository history: `memory-s3-cache-review.md` at `ec4de73353` (round 1), `memory-s3-cache-re-review.md` at `9992ed046e` (round 2), and `memory-s3-cache-re-review-r3.md` at `6848dbbe9c` (round 3). Their old test bodies target the deleted deferred-log/recompute APIs and cannot be run unchanged at this revision. They were **not** silently counted as passing. The following executable counterparts were run:

| Earlier property/family | Current execution and status |
| --- | --- |
| Deferred archive/update/restore, foreign successor/dependency/cycles, ordering of canonical SOFT admissions | Strict no-row/log/head gates, two-session isolation, admitted-membership regressions and independent seeded sequences pass. The old closure/admission algorithms are gone, not reimplemented and rerun. |
| Correction pressure versus genuine HARD; outer backstop distinction | Shared pending-lifecycle controls, Rust correction-pressure test and independent history-pressure refolds pass. No correction-only HARD in 550 iterations. |
| Oversized edit retains earlier correction; stale marker replay and disappearance at HARD | Permanent overflow tests, independent aggregate/reopen/HARD and r4 42-row archive controls pass. |
| NULL/grouped multi-source operation atomicity and record cap | Old log-grouping machinery is gone. Independent 42-source fragment merge and 42-row archive whole-or-marker controls pass. |
| Legacy cached corrections and additions survive upgrade | Literal v98-shaped and **actual old-renderer** upgrade controls pass on all three TS/Pi drivers, including multiline cached bytes. |
| Rollback cached bytes and manifest together | Existing OpenCode and Pi visible-manifest suites pass. No new multi-process rollback stress was added. |
| Current text remains searchable behind old prompt text | Current-revision visibility regressions and the legacy-upgrade controls pass. |
| Complete multiline upgrade/recovery visibility; actually served fallback revision | New `legacy multiline visibility and fresh recovery follow actually served revision` passes per driver: current complete multiline text is recognized, edited current text is not hidden behind old bytes, a newly served recovery pair is recognized, and a first-line-only truncation is not full visibility. This calls the actual visibility helper with recorded recovery bytes; it does **not** independently force the contention fallback that records them. Full contention-to-search wiring remains a gap. |

## Executed gates and reproducibility

All suites/compiler checks ran on **Linux with `runon: "linux,8c"`**, without a network-enabled remote lane. Tool versions: **Bun 1.4.2 (`744846f84`)**, **TypeScript 5.9.3**, **Cargo 1.99.0 (`5f94df478`)**, **rustc 1.99.0 (`b940084d7`)**, **Biome 2.5.1**, **Python 3.14.4**. Formatting edits were local; authoritative checks/tests were remote. No manifest/lockfile change or package install was needed.

Each command that can execute a host producer is wrapped by `python3 docs/reports/probes/memory-s3-r5-isolated.py …`. The table omits that repeated prefix for readability.

| Command/check | Result |
| --- | --- |
| `BUN_JSC_useOMGJIT=0 bun test ./docs/reports/probes/memory-s3-r5.probe.ts --timeout 60000` | **30 pass, 18 fail**, 48 tests, 85,362 assertions; final opt-in evidence, all reds described above |
| r4 `.probe.ts --timeout 30000`, with `MC_R4_V98_EXPORT="$PWD/.review-v98"` | **28 pass, 3 fail**, 31 tests, 23,485 assertions; only the three superseded literal individual-marker expectations red |
| Six automatic-search runner/named-reader/re-review/deadline files | **55 pass, 0 fail**, 212 assertions |
| Nine memory-projection/applied-projection/taxonomy/visible-manifest/expiry/verify/Pi-injector files | Initial **158 pass, 4 fail**, 162 tests, 1,033 assertions; four Pi fixture identity failures caused by remote Git ownership checks under the isolated HOME, not a memory assertion |
| Pi injector file after disposable worktree-only `safe.directory` config | **72 pass, 0 fail**, 335 assertions; all four initially failed budget/policy names now pass |
| Opt-in Rust patch, `cargo test -p mc-module --lib --offline r4_ -- --test-threads=8` | **5 pass, 2 fail**, 7 tests; obsolete agent-archive route and now-permitted automatic producer read red |
| Opt-in Rust patch, `cargo test -p mc-module --lib --offline r5_ -- --test-threads=8 --nocapture` | **4 pass, 0 fail**; expiry, hint lifecycle, epoch/pressure and 550-pass full-transform stress |
| Restored source, `cargo test -p mc-module -p mc-store --lib --offline memory -- --test-threads=8` | **mc-module 91 pass; mc-store 29 pass; 0 fail**, 120 tests total |
| `tsc --noEmit -p docs/reports/probes/memory-s3-r5.tsconfig.json` | Passed, TypeScript 5.9.3; imports cover the new probe's host/core types |
| `biome check docs/reports/probes/memory-s3-r5.probe.ts docs/reports/probes/memory-s3-r5.tsconfig.json` | Passed, 2 files, no fixes |
| Python isolation-runner AST parse | Passed, 1 file, Python 3.14.4 |
| `inspect` on the probe | PARTIAL: docs probe has no covering LSP TypeScript project; explicit tsc above is authoritative |
| Broad Rust experiment using the overly broad filter `r` | **Timed out at 611 s**, exit 124; it selected 1,928 tests, not just r4/r5. No final suite result or lsof summary, so not counted as passing |

The four initial Pi failures were `Pi keeps policy-identified m0 frozen as live budgets rise and folds a policy edit once`, `Pi adopts legacy numeric history silently and retains absolute memory-budget edits`, `Pi review: legacy replay survives restart and only a natural HARD records policy`, and `Pi shrinking budget refolds an oversized baseline once with empty m1`. The first threw `ProjectIdentityError: git refused to read the repository because it detected dubious ownership`; the next three hit the identity retry cooldown. All four passed after adding trust for this worktree to the disposable HOME config, without changing a product or test assertion.

The broad Rust experiment compiled in 8 seconds and reached tests; this was not a compile-slot wait. Its last visible long-running names were `producer_gate_runs_on_execute_force_and_hard_advisory_never_plain_defer` and `subagent_emergency_sample_latch_prevents_repeat_selection` (both eventually printed `ok`, but no complete suite summary was delivered). It was not retried with the same filter. Narrow review and restored-source memory selections completed. The interrupted disposable root was explicitly removed afterward. No complete Rust-module baseline or full plugin/Pi release sweep is certified here.

Initial probe scaffolding errors were corrected rather than treated as findings: a missing `appendCompartments` export was replaced with its actual module import; Pi synthetic system entries required an unknown-message text extractor instead of the narrower test helper's type; Biome import ordering was fixed; and the Rust hint baseline counter/row assumptions were corrected as described above. Final compiler/lint/probe results are the ones in the table.

### Reproduce the opt-in probes

```sh
python3 docs/reports/probes/memory-s3-r5-isolated.py \
  env BUN_JSC_useOMGJIT=0 bun test ./docs/reports/probes/memory-s3-r5.probe.ts --timeout 60000
packages/plugin/node_modules/.bin/tsc --noEmit -p docs/reports/probes/memory-s3-r5.tsconfig.json
```

`memory-s3-r5-rust.patch` is a **self-contained opt-in patch** containing the unchanged r4 witness bodies plus the new r5 witnesses. Apply it to the reviewed clean source; **do not also apply the r4 patch**:

```sh
git apply docs/reports/probes/memory-s3-r5-rust.patch
python3 docs/reports/probes/memory-s3-r5-isolated.py \
  cargo test -p mc-module --lib --offline r5_ -- --test-threads=8 --nocapture
python3 docs/reports/probes/memory-s3-r5-isolated.py \
  cargo test -p mc-module --lib --offline r4_ -- --test-threads=8
git apply -R docs/reports/probes/memory-s3-r5-rust.patch
```

Use the historical-export instructions under “Opt-in review tests” in [the round-4 report](memory-s3-cache-review-r4.md) to export and run the renderer from `5b8c9a2d313959bc427cc177e99587c9dbf48ab1`. That export was made from this worktree's repository history, not another checkout or an operator store, and was deleted afterward. Both temporarily patched Rust source files were restored before delivery.

### Non-vacuity controls

Two silent guards have independent applied controls. To avoid losing any working implementation during restoration, each control first stages the live files as its restore point, confirms an empty unstaged diff, mutates with `NON-VACUITY BREAK`, captures a nonempty diff, runs only the named test, restores from the index and touches the path, then captures an empty unstaged diff.

- Add one real `SELECT id FROM memories … LIMIT 1` to the non-HARD materialization decision. **Only** `opencode r4 strict SOFT gate includes memory and log watermark SELECTs` fails, reporting that exact executed SQL; 30 other tests filtered. Applied diff: `inject-compartments.ts`, **1 file / 1 insertion**; restored diff: **empty**.
- Append a marked SQL comment to the committed Rust schema fixture. **Only** `r4 generated context schema matches committed Rust fixture` fails, with the two appended lines in the mismatch; 30 other tests filtered. Applied diff: `context-db-schema.sql`, **1 file / 2 insertions**; restored diff: **empty**.

Neither mutation remains in product source or the fixture. A final restored-state run passed both named tests (**2 pass, 0 fail**, 29 filtered). These controls prove the execution observer detects a real non-HARD memory read and the generator comparison detects an independently changed fixture; they are not mutation proofs for every passing assertion.

## Live-store isolation and limits

The review brief's required isolation rule is retained verbatim:

> never open/read/write/migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`); every host run goes through a throwaway root (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/<task>/`), proven by `lsof`. Clean up throwaway roots.

The wrapper creates `$TMPDIR/magic-context/memory-s3-r5/run-…/`, sets **all six required variables**, and also isolates HOME and TMPDIR. It preserves only offline Cargo/toolchain-cache discovery. The Git ownership workaround is a temporary HOME config trusting **only this worktree**, not an operator config. It samples `lsof -nP -p <producer and descendants> -Fn`, rejects observed live-prefix/config paths and any observed database file outside that root, and removes the root in `finally`. No live data/config was opened, copied, inspected or migrated.

Representative Linux open-file evidence, copied here because transient roots/build directories are deleted:

| Run | lsof receipt |
| --- | --- |
| Final TS/Pi r5 suite, `run-04o67q7_` | **65 samples, 55 database paths, 0 violations, 0 observer errors**; representative paths below include all three driver identities |
| Final Rust r5 probes, `run-h43zb3ci` | **27 samples, 18 database paths, 0 violations, 0 errors**; both `context.db` and `store.db` under the isolated tmp root |
| Restored Rust memory regressions, `run-8yagkm04` | **105 samples, 393 database paths, 0 violations, 0 errors** |
| r4 TS probes with old-renderer export, `run-dt_9u60e` | **54 samples, 49 database paths, 0 violations, 0 errors** |
| Automatic-search regressions, `run-hgsxqs7t` | **139 samples, 36 database paths, 0 violations, 0 errors** |
| Pi injector corrected environment, `run-rcyulapo` | **17 samples, 3 database paths, 0 violations, 0 errors** |

```text
/motor-home/tmp/magic-context/memory-s3-r5/run-04o67q7_/tmp/mc-test-owned-mc-memory-projection-opencode-r5-aggregate-JDm1Ai/context.db
/motor-home/tmp/magic-context/memory-s3-r5/run-04o67q7_/tmp/mc-test-owned-mc-memory-projection-opencode2-r5-aggregate-6WSW5I/context.db
/motor-home/tmp/magic-context/memory-s3-r5/run-04o67q7_/tmp/mc-test-owned-mc-memory-projection-pi-r5-cross-session-doZKfX/context.db
/motor-home/tmp/magic-context/memory-s3-r5/run-h43zb3ci/tmp/.tmpUMS4m8/context.db
/motor-home/tmp/magic-context/memory-s3-r5/run-h43zb3ci/tmp/.tmpUMS4m8/store.db
```

This is **sampled open-file evidence**, not a syscall trace proving no transient file access between samples. The tested host surfaces are OpenCode's shared postprocessor (`opencode` and `opencode2` identities), Pi's registered context handler/injector, and Rust's complete transform/facade engine. No deployed OpenCode/Pi client or Rust daemon was launched, and no real provider-wire cache replay, rendered-mural concurrency/cue test, dashboard UI workflow, enabled historian-revision writer, or module-owned curate run was independently added. Those limits remain release gates; the two concrete automatic-search failures do not depend on them.

Cleanup completed: the historical source export and untracked local package `dist` outputs were removed. Remote Cargo build contents were cleared, with an empty mounted `target` root retained. Attempting to remove that mount itself initially returned `EBUSY`; a subsequent contents-only cleanup removed the remaining `.rustc_info.json` and reported **zero build entries and zero throwaway-root entries**. Evidence is retained in this report and the opt-in probe files, not inside those regenerable directories.
