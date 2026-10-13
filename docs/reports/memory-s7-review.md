# Memory S7: independent Rust historian review

**Reviewed:** `3549c4340ef37066f6690fb466824ac752ba0cbb` →
`6f7231135fa12c040a58e199a059718fb4850016`, including the subsequent route-release
fix. Scope: the 12-file S7 diff, its live Rust historian callers, the TypeScript
claim consumer, and the earlier OpenCode turn-two deadlock, continuation and
unknown-outcome findings/fixes recorded in
[`memory-s6-review.md`](memory-s6-review.md) as comparison material. Rust source
references without a crate prefix are under `crates/mc-module/src/`.
**Report only:**
no production code, architecture document, schema, or live store was changed.
All stores used by the witnesses are new temporary databases.

## Verdict

Here “dormant” means Rust's intended inactive turn-two memory-maintenance lane,
represented by `RUST_LIFECYCLE_ENABLED=false` and `lane="dormant"` claim metadata.
**Do not accept the claim that the dormant lane leaves today's historian behavior
and writes unchanged.** Normal compartments and ordinary failure/fallback state
remain compatible in the randomized sample, and the candidate transaction is
atomic and replay-idempotent. However:

1. **P1: an uncertain/queued Broca submission has no cumulative recovery deadline.**
   It can keep the historian in `AwaitingProducer` indefinitely, including across
   later transforms/restarts. The S6 unknown-outcome finding reproduces in the
   live Rust turn-one path.
2. **P1: facts can be persisted with `memory.enabled=false`.** The new
   `authority_elsewhere` queue bypasses the old publish-time memory gate. This
   does not write an authoritative memory, but it does store the extracted fact
   when the previous implementation dropped it.
3. **P2: “dormant” is not an execution/write gate.** Every ordinary real-domain
   firing now creates lifecycle records, and ordinary Broca sends use new send
   identities. Queued-send and crash-replay semantics change today. These changes
   may be intentional infrastructure, but they contradict the requested live
   no-change contract and need to be gated or explicitly accepted as live changes.

There is **no Rust turn-two orchestrator to exercise** in this diff. S7 supplies
turn-one persistence/recovery and reusable stage/check APIs, not a running Rust
implementation of clause patching, fact additions, or gated merge/replace.
Accordingly, no S6 role-lock deadlock, continued turn-two dialogue, or turn-two
lease/join isolation has been demonstrated or certified here.

## Reproduction and isolation

Witnesses are in `docs/reports/witnesses/memory-s7-review/`:

- `run.py`: opt-in preparation, pinned-revision differential, expected-red witness
  runner, and individual control runner;
- `driver.rs`: real historian state/publish driver, randomized outcomes and three
  failing live-safety witnesses;
- `wire.rs`: authenticated fake-Broca transport and resend controls;
- `host.rs`: real module claim dispatcher and retained-child crash-cut control;
- `fold.rs`: actual store outbox/replay and candidate-row controls;
- `host-claim.test.ts`, `tsconfig.json`: TypeScript host compatibility probe and
  explicit typecheck configuration.

The Rust files are **not registered in Cargo**. The runner injects them into test
modules in disposable source snapshots, to reuse existing fixtures/private APIs
without modifying production files. The runner exits before preparing/building
anything unless `MC_S7_REVIEW=1`. The Bun witness uses `test.skip` otherwise;
its unflagged run reported one skipped test. Linux is enforced for Rust execution.
Preparation uses only Git in this task worktree:

```sh
# Local, read-only Git snapshot preparation; no Rust build on the Mac.
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review/run.py prepare

# Linux runner, 8 vCPUs, offline Cargo dependencies.
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review/run.py differential
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review/run.py witnesses
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review/run.py control mc-module s7_review_control
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review/run.py control mc-store s7_review_control

MC_S7_REVIEW=1 bun test docs/reports/witnesses/memory-s7-review/host-claim.test.ts \
  packages/plugin/src/hooks/magic-context/historian-host-runner.test.ts
```

`prepare` creates disposable `.s7-review-input/{base,head}.tar` files. Execution
writes raw captures there on the runner; the durable evidence below is copied into
this report, not left in `target/` or dependent on remote scratch retention. The
head snapshot overlays the current worktree's Rust files so mutations actually
reach the code under test. Expected-red mode exits successfully **only if the
exact four named failures below occur**, with no other failed tests. A differential
exit zero means measurement completed, **not** that equivalence passed.

## 1. Live safety: randomized baseline/head differential

We compiled both pinned revisions, using the same witnesses and deterministic
inputs (xorshift seeds `0x7337_d1ff_2026_1012`, `0x7057_7337_1012`,
`0xf01d_7337_1012`). Generation, logical time and fixture tokens were fixed or
normalized; the host claim's random coordinator token and wall-clock deadline
were normalized identically on both sides. Compartment contents, producer/session
identities, prompts, cancellations, return outcomes, failure states, and candidate
writes were **not** normalized away.

| Cases | What ran | Observed difference |
|---|---|---|
| 96 | Real historian driver/store; randomized valid publish, runner refusal, timeout→redrain→fallback, capped output, invalid output/repair fallback, transient-start fallback; memory/auto-promote/authority flags varied | Only lifecycle/candidate counts differed. Compartments, return values, durable historian state, sessions, prompts, cancellation and close traces matched. |
| 24 | Real host claim/report dispatcher, normal/capped output or typed error, stale-token refusal | Existing claim fields and legacy report responses matched; lifecycle metadata and stage-row creation were additive. |
| 24 | Recorded pending folds, first replay plus simulated lost-outbox-ack replay; fact count, ownership and promotion varied | Publications, pending facts and activity ledger differed; compartment, memory, event, primer and user-observation row bytes matched. |
| 2 | Actual producer over authenticated fake Broca; active and queued send replies | Active send changed `send_id`. Queued send changed from retracted error to retained submission plus resends. Route session stayed identical. |
| 1 | Crash cut after durable firing/stage request, before acknowledgement | Baseline abandoned/refire-eligible; S7 recovered to an awaiting durable submission. |

Captured differential-run summary (the fields that differed between revisions):

```text
S7_DIFFERENTIAL cases=147 changed=147
S7_GROUP driver- changed=96 fields=[counts]
S7_GROUP host-   changed=24 fields=[lifecycle_present,stage_rows]
S7_GROUP fold-   changed=24 fields=[ledger,pending_facts,publications]
S7_GROUP wire-   changed=2  fields=[kind,outcome,retracts,sends]
S7_GROUP crash-  changed=1  fields=[action,counts,state]
```

Examples from the pinned baseline/head differential illustrate the live changes:

- `driver-0`, ordinary successful fold with no facts: counts in order
  `[publications, stages, ledger, pending_facts, memories, proposals]` changed
  `[0,0,0,0,0,0]` → `[1,1,1,0,0,0]`. The result, row version 6, compartment
  content, `Idle` state and child `mc-historian:proj:823b8c195ce216a2:1` matched.
- Active wire send: `send_id="mc-historian:review:1"` → `"review-stage-key"`;
  model, system, prompt, generation and route session were identical.
- Queued wire send: baseline returned
  `SendQueued { submission_id: "queued-review", retracted: true }`, with one
  send and one retract. S7 returned an opaque durable submission, no retract,
  and three identical sends during the 150 ms collection window.
- Crash-before-ack: baseline returned `AbandonedAndRefireEligible`, state `Idle`,
  backoff 999. S7 returned `ReattachProducer`, state `AwaitingProducer`, preserved
  `fired_at_ms=123`, no failure backoff, and lifecycle counts `[1,1,0,0,0,0]`.
- Disabled-memory candidate differences occurred in `driver-8`, `35`, `45`,
  `56`, `57`, `68`, `70`, `72`, `78`; these are real provider-emitted validated
  facts, not fabricated queue rows.

### Can a dormant run create a check session or rebind a route?

**A new check session is not reached by the production historian.** The only
caller of `start_check_with_generation` is its producer test. Normal child IDs
remain derived by the unchanged `historian_producer_session_id`; none of the
randomized ordinary runs created a `mc-check-*` session.

**Route-rebind behavior has nevertheless changed in the newly live stage API.**
`start_stage_with_generation` closes existing routes when `session_id` changes
(`historian_producer.rs:873-877`), and submission recovery does likewise
(`:934-937`). The old `start_with_generation` only bound the label. Normal
firing/fallback already closes its routes, so the sampled ordinary run trace did
not acquire an extra route; this does not make the new API a no-op. Removing the
new close reproduced the author's exact isolated-check failure (control A1).
Rebinding closes **routes**, not the retained provider child.

### TypeScript acceptance

The real `HistorianHostRunner` accepted old and additive claim shapes. For normal,
failing and length-capped completions, all claim requests, executor opens,
attempts, closes and completion reports matched (18 tests, 59 assertions including
the existing host suite). In particular it **ignores** `lifecycle`, including
`retain_child` and a supplied `child_session_id`; it opens a fresh child and closes
it in `finally` (`historian-host-runner.ts:443-478,663-676,739-745`). Rust accepts
legacy completion reports without lifecycle while dormant
(`mc-module/src/lib.rs:8533-8566`). Thus additive metadata is compatible with the
current host, but does **not** prove provider-child retention/continuation by it.

## 2. Findings and failing witnesses

### P1 — Unknown/queued outcomes can strand live turn one forever

Source: `historian_producer.rs:927-946,1139-1158,1198-1210`;
`historian.rs:2402-2411,2488-2494,3125-3130`.

A durable submission reports `Active` without probing the provider. Collection
resends the same request every 100 ms while Broca reports pending. A per-call
`await_timeout` bounds that one collection, but a timed-out/uncertain staged
handle returns without abandoning the durable historian. There is no cumulative
attempt count, expiry or retry-at update. Reattachment repeats the same behavior.
The production caller logs the error rather than clearing it
(`mc-module/src/lib.rs:6239-6296`), so the next transform can try again indefinitely.
This is not the baseline host claim queue: that queue has a deadline and sweep.

Witness: `historian::tests::s7_review_witness_unknown_outcome_has_a_deadline`.
After the initial timed-out submission and **eight later reattachments**, with
logical time advancing by one day per reattachment:

```text
assertion failed: eight later reattachments, eight days later, still have no recovery deadline
left: AwaitingProducer
right: Idle
fired_at_ms=Some(123); failure_backoff_at_ms=None; producer_attempt=0
```

The scripted producer isolates the real driver's state transition; the real-wire
pending probe independently establishes that the corresponding resend path runs.
Same-key replay is good deduplication, but not a bound on network traffic, provider
recovery work, or how long the historian's single-flight marker stays occupied.
The 100 ms sleeps bound rate, not total resend count. Add a durable cumulative
recovery budget/terminal unknown state; do not turn uncertain sends into new
attempts while the original may still run.

### P1 — Disabled memory still persists extracted facts

Source: `historian.rs:899-910,956-979,3330` and
`mc-store/src/context_writes.rs:313-320,354-358`.

Previously the publish builder supplied an empty fact list unless both memory
support and auto-promotion were enabled. S7 always supplies every validated fact.
The store still gates **promotion**, but its new authority-elsewhere candidate
loop does not gate **candidate storage**. Validation does not strip a provider's
unsolicited fact simply because memory support is off.

Witness: `historian::tests::s7_review_witness_disabled_memory_does_not_queue_facts`.
A real normal fold with an anchored provider fact, TypeScript memory authority,
`memory_enabled=false` and `auto_promote=false` completed and left one pending
fact:

```text
assertion failed: memory.enabled=false still persisted a provider-emitted fact
left: 1
right: 0
```

No `memories` row was created; this is a configuration/storage regression, not an
unauthorized authoritative-memory write. Authority-elsewhere staging should
respect the memory collection gate while distinguishing collection from
promotion, or be explicitly enabled separately.

### P2 — Dormancy label and compatibility coverage do not fence live writes

`RUST_LIFECYCLE_ENABLED=false` (`historian_stage.rs:11`) is referenced only by a
test assertion. Production does not consult it. Both drivers persist stages;
claims persist/read stage metadata; publish always supplies a lifecycle ID;
entering Idle writes stage terminal state
(`historian.rs:800-812,2257-2265,2729-2748`;
`mc-module/src/lib.rs:8373-8401`).

Witness: `historian::tests::s7_review_witness_dormant_publish_has_no_new_rows`, with
no facts and the flag false, failed `[1,1,1,0,0,0] != [0,0,0,0,0,0]`. The six
positions count publications, stages, ledger rows, pending facts, memories and
proposals, respectively.
This creates real publication/stage/ledger rows even on a successful compartment-
only run. Refusal and timeout attempts also persist stages. Stage requests retain
full prompt/system text in `request_json`, unlike a merely additive wire field.
Queued/lost-ack/crash recovery changes described above are also unconditional.

The existing S7 test `publication_without_candidates_is_byte_identical_to_legacy_fold`
uses `lifecycle_publication_id=None` (`context_writes.rs:849-854`), and its fixture
actually contains a fact (`:705-709`). It proves legacy/identity-less compatibility,
not the production S7 shape. The additional witness
`context_writes::tests::s7_review_witness_no_candidate_fold_is_byte_identical`
clears **all** candidates and compares `Some(identity)` against `None`.
Its compartment-row-byte assertion **passed**; its all-written-row comparison
failed only on `memory_publications` and `memory_activity_ledger`.
Do not misread this as a compartment-content corruption finding: the compartment
bytes are compatible, the total write set is not.

## 3. Candidate atomicity, replay and authority

**The minimal transactional bridge is sound for the tested cases.** Candidate
publication is inside `apply_fold_tx`, before the same context transaction commits
(`context_writes.rs:347-357`). The persisted outbox includes the optional lifecycle
ID (`mc-store/src/lib.rs` publish builder and `FoldWrite`), so pending-fold replay
executes the same candidate write, then deletes only the recorded outbox text
(`context_writes.rs:556-596`). `INSERT OR IGNORE` plus the publication/fact-index
identity prevents repeat candidates; an existing committed publication keeps its
order/time (`:302-320`).

- The author's child-kill precommit test passed after restoration: no publication,
  fact, ledger or memory leaked before commit; replay landed each once; simulated
  lost acknowledgement landed no duplicates.
- The review's seven-fact replay test changed the replay wall time to 999 and
  verified exact publication/candidate/ledger rows stayed unchanged, not just
  counts. It also verified zero `memories` rows before and after replay.
- Across the 24 baseline/head outbox samples, legacy compartment and side-channel
  row bytes were identical. Empty-candidate S7 publication also preserved the
  compartment bytes in the stronger witness above.
- Ownership is checked by `module_owns_memory`; the connection guard separately
  protects memory inserts, updates and deletes
  (`memory_lifecycle/authority.rs:88-120`). When the module is not authority, this
  new path inserts retryable, unanchored pending facts with zero attempts and
  `reason='authority_elsewhere'`, not memories. The original dormant-mirror test
  and our replay control corroborate that distinction.

Atomicity is not the same as permission to collect disabled-memory facts (P1),
and exactly-once row insertion is not a bound on an uncertain provider outcome.

## 4. S6 applicability, provider child and ruling audit

| S6 property | Rust S7 result |
|---|---|
| Retained historian waiting behind a role lock while opening a check | No active Rust turn two/check caller, so no observed analogous deadlock. The helper releases routes before changing sessions; no real-daemon/provider role-lock proof. |
| Turn two continues turn one in the same provider child | Stage API can bind the same session and use a different send key, and its queued test uses the string `turn_two`. No production turn-two dispatch or transcript continuation exists. Current TS host ignores retention metadata and closes its child. |
| Unknown outcomes bounded | **Fails on live turn one**, witness above. |
| Resends bounded | One collection is time-bounded and keys are stable (mutated control R1); aggregate retries/resends are unbounded. |
| Prompt size bounded | Existing turn-one admission/repair/fallback tests passed. Checks merely forward supplied operands/input; there is no Rust turn-two prompt builder to bound, so future turn-two/check prompt bounds remain unproved. |
| Turn two outside compartment lease and 95% join | No turn-two task exists. Existing inline historian join is still the spawned turn-one task (`mc-module/src/lib.rs:7344-7388`). Cannot certify future lease/join isolation from stage metadata. |
| Stage-aware claim/reclaim retains child | Module stage row pins the child. A crash cut after child recording but before report storage permits a replacement claimant to report using the **same** child. A different child is refused with a low-level SQLite error; the passing control verifies both branches. This is intentional continuity protection, not a new-child acceptance defect. |

**No new S7 proposal or automatic retirement path was found.** Turn-one promotion
uses additive admission; the Rust admission operations are `New`, `Conflict`, and
`AgentSave` (`memory_lifecycle/applier.rs:90-108`), not a turn-two decision parser.
No Rust parser/drop-and-log path for proposed `retire` / `promote_rule` exists in
S7. Their omission is **not** proof that a future turn-two implementation will
reject/log them correctly. Before activation, tests must submit `retire` and
`promote_rule` actions and verify that each is dropped and logged without a
proposal or retirement write.

**The broader Rust tree does have pre-existing proposal/retirement paths**, which
must not be hidden by a global “no proposal path” statement:

- `set_memory_verification_tx`, `"archive"` branch, inserts an archive proposal
  into `memory_tool_proposals` with `writer='verify'`, leaving the memory live
  (`mc-store/src/lib.rs:17429-17454`). This is present outside the S7 changed hunks,
  not reachable through a new historian-turn-two caller.
- Existing explicit memory-tool archive calls set `status='archived'`
  (`mc-module/src/memory_tool.rs:254-297`; `mc-store/src/lib.rs:6843-6866`).
  Existing tool merge archives/supersedes its source rows
  (`mc-store/src/lib.rs:7068-7085`). These are not S7 historian retire decisions.

## 5. Four mutation controls

The two author controls are identifiable in the S7 commit messages: the
second-transaction crash control in `81856c35ed`, and the route-release control in
`6f7231135f`. Both were rerun, plus two independently added controls. Each mutation
was applied to the **actual task worktree source**, after staging that source and
confirming an empty unstaged diff. Each was labeled `NON-VACUITY BREAK` and counted
as meaningful only when its exact expected test failed while the selected sibling
tests stayed green. After testing,
`git checkout -- <path> && touch <path>` restored the staged source, and the
unstaged diff was empty. No mutant is delivered.

| Control | Mutation and exact red test | Other observed results | Applied/restored diff |
|---|---|---|---|
| A1, author | Remove route close on session change in `start_stage_with_generation`. **`historian_producer::tests::checks_bind_distinct_fresh_sessions_and_never_historian_lineage`** alone failed: routes were `[retained-historian]`, not historian + two check sessions. | Other 27 producer tests passed, including queued recovery and lost-ack tests. | `historian_producer.rs`: 1 insertion / 3 deletions; restored empty. |
| A2, author | Move `publish_dormant_candidates_tx` after the compartment context transaction. **`context_writes::tests::dormant_candidate_killed_before_commit_replays_exactly_once`** failed: child saw `[0,0,0,0]`, expected `[1,1,1,0]` before commit. | `a_fold_resumed_after_either_crash_window_lands_its_side_channels_exactly_once` passed; only these two tests selected. | `context_writes.rs`: 5 insertions / 1 deletion; restored empty. |
| R1, reviewer | Change the replayed `session.send` key in `reattach_submission`. **`historian_producer::tests::s7_review_control_recovery_resends_identical_request`** alone failed: `recovery changed a durable request identity or payload`. | `s7_review_control_ordinary_stage_send_preserves_payload` passed. | `historian_producer.rs`: 4 insertions / 1 deletion; restored empty. |
| R2, reviewer | Remove `AND commit_order IS NULL` from publication update. **`context_writes::tests::s7_review_control_replay_preserves_publication_order_and_candidates`** alone failed: publication `(order,time)` changed `(1,10)` → `(2,999)`. | Author's `dormant_mirror_keeps_all_facts_retryable_without_attempts_or_memory_writes` still passed, demonstrating the count-only blind spot. | `context_writes.rs`: 1 insertion / 1 deletion; restored empty. |

All four controls reddened their named target and no other selected test. On
restored source, both reviewer mutation targets and the ordinary-send/retained-
child controls passed (three module controls, one store control); the original
producer, stage and crash targets also passed in the focused suites.

## 6. Verification and limits

All Rust/Bun test and typecheck commands below ran on **Linux, 8 vCPUs**, sequential
heavy builds. Versions: Cargo `1.99.0 (5f94df478 2026-08-27)`, rustc
`1.99.0 (b940084d7 2026-09-28)`, Bun `1.4.2`, TypeScript `5.9.3`, Python `3.14.4`.

| Command/check | Result |
|---|---|
| Pinned `run.py differential` | Both revisions compiled; 4 module snapshot tests + 1 store snapshot test per revision passed; **147 observed cases, 147 differed** as categorized above. |
| Final `run.py witnesses` | Exactly three named module failures and one named store failure reproduced; expected-red runner accepted the exact failure sets, not arbitrary Cargo failure. |
| `cargo test -p mc-module --lib historian -- --nocapture` | 271 passed, 2 ignored; includes stage, producer, timeout, publication/fallback and existing historian gates. |
| `cargo test -p mc-module --lib tests::gate_a2 -- --nocapture` | 7 passed; includes host wire golden, killed host, restarted report adoption, token refusal and retained child. |
| `cargo test -p mc-store --lib context_writes -- --nocapture` | 5 passed; includes the precommit crash/candidate replay and legacy row-byte control. |
| `run.py control mc-module s7_review_control` / `mc-store` on restored source | 3 passed / 1 passed. |
| `bun run --cwd packages/plugin typecheck` | Passed, repository's three `tsc` invocations, exit 0. |
| `bun packages/plugin/node_modules/typescript/bin/tsc --noEmit -p docs/reports/witnesses/memory-s7-review/tsconfig.json` | Passed; checks the new witness as well as its imported host code (normal plugin config excludes tests). |
| Flagged Bun host compatibility + existing host-runner tests | 18 passed, 59 assertions, 0 failures. |
| `rustfmt --edition 2021 --check` on the four Rust witness files | Passed, rustfmt `1.10.0-stable (b940084d7e 2026-09-28)`. |
| Repository-pinned Biome `check` on the TS witness and its config | Passed, Biome `2.5.1`, 2 files checked, no fixes. |
| Unflagged Python runner / unflagged Bun witness | Runner declined execution; Bun reported 0 pass / 1 skip / 0 fail. |

During harness development a wrong generation-argument type, underscripted
validation fallbacks, missing witness type roots, and incomplete token totals
were corrected; their affected checks were rerun. These were review-fixture
errors, not S7 findings. An exploratory “replacement may use a new child”
assertion was also rejected: it contradicted intended child retention. The final
passing crash-cut control instead verifies the retained-child contract and notes
the low-level error on substitution.

**Limits:** This is a deterministic randomized sample, not exhaustive proof of
all provider/daemon schedules. The real-wire samples use a protocol-correct fake
Broca, not a live provider. Lost-ack recovery is covered by the original producer
suite, not by a randomized provider disconnection oracle. We did not run the full
Rust workspace or the four `real_daemon` tests that require the absent sibling
subconscious checkout; scoped historian/host/store gates were run instead. No
Mac Rust build, live database, network dependency fetch, packaging change or
manifest/lockfile edit was involved. No new turn-two schema enforcement, narrow
role-lock concurrency, or 95%-join isolation can be certified while the Rust
turn-two/check orchestration is absent. The scoped IDE health inspection was
partial: these Rust files intentionally are not linked to crates, and the IDE's
TypeScript/Biome project discovery did not cover the report directory. Python
inspection reported no errors/warnings; compiled snapshot tests and the explicit
witness `tsconfig` typecheck are the authoritative diagnostics instead.

## Follow-up corrections to the reviewed S7 implementation

The release ruling distinguishes the inactive lifecycle lane from ordinary
historian publication. TypeScript's current compartment runner unconditionally
allocates one minimal turn-one stage per firing and calls
`commitTurnOnePublication`: one publication row commits and one activity row is
inserted per newly appended compartment. Dormant Rust deliberately does not
allocate that stage. This is an accepted divergence: TypeScript writes one stage,
Rust writes none, and nothing in dormant Rust reads a stage record. The Rust
witness therefore expects `[1, 0, 1, 0, 0, 0]` for its ordinary no-fact fixture;
it is not a complete TypeScript row oracle. The byte witness independently
specifies only the common publication/activity metadata and compares the other
Rust production row bytes without masking differences. The actual TypeScript
footprint is exercised by the round-two real-runner matrix, which expects one
minimal stage with `{lane, chunkStart, chunkEnd}` and no prompt/system text.
Witness modes now require green regressions instead of accepting expected-red
counterexamples.

Production stage writes, stage-aware host metadata, changed Broca send identities,
and the new queued/lost-ack/crash-replay send path are gated by the inactive lane.
They are retained as enabled-lane infrastructure, not claimed as fixes to ordinary
legacy dispatch. Enabled-lane component controls use an explicit test-only lane
override. Dormant publication still writes the TypeScript-compatible publication
and activity rows, and the existing authority-elsewhere candidate transaction.
Fact collection now has a separate gate: disabled memory never collects facts;
the dormant path also follows TypeScript's auto-promotion opt-out.

Already-persisted uncertain sends have a durable three-probe budget and the
original configured timeout as their recovery deadline. Exhaustion records an
Idle terminal-unknown tombstone, failure and normal backoff, with no redispatch
until `dispatch_time + max(2 * original_timeout, 1,800,000 ms)`. The original
identity remains fenced during that interval. One subsequent firing can mint a
new attempt after expiry; a late original reply cannot replace its state or rows.
Tombstone creation and release each produce one transition log. Budget/count and
fence survive restart in the existing durable producer handle; terminal records
remove the original prompt and system text. No schema migration is needed.

### Follow-up verification

All four regression witnesses pass on Linux with four vCPUs; the runner requires
all named tests to be green. The module's three companion controls and the
store's candidate/outbox replay control also pass. Each requested fix has a
mutation that makes only its named witness fail while the other two module
witnesses remain green: disabling budget exhaustion, bypassing fact collection,
and forcing lifecycle activation on the dormant lane. Each mutation was made
from the staged live implementation and restored with an empty unstaged diff.

The updated pinned differential completed 147 cases. There are 78 differences,
restricted to `counts`, `ledger`, `pending_facts`, and `publications`: 54 normal
driver cases have the permitted TypeScript-compatible publication/activity
footprint, and 24 fold cases have publication/activity and authority-mirror
candidate bookkeeping. Host, ordinary wire, and crash-recovery groups have zero
differences. There are no disabled-memory candidate cases. This is a measurement,
not a blanket claim of byte identity; the separate production-shape byte witness
also passes with the explicit TypeScript metadata oracle.

The affected historian, producer, stage, and host suites pass (113, 29, 2, and 7
tests), as does the restored ordinary claim-wire golden. The store suite passes
336 tests with five fixture-dependent ignores. Strict clippy for both packages
passes. Repository build, typecheck and lint pass; the full plugin suite retains
the unrelated temporary-bundle `onnxruntime-web/webgpu` resolution failure. The
TypeScript host compatibility probe and host-runner tests pass all 18 cases, and
the explicit witness TypeScript configuration typechecks.
