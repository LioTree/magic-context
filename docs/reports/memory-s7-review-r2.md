# Memory S7: second-round independent correctness review

**Reviewed tip:** `e4373102b50d39a3bcbe1bbf5a263dd0f2bda37e`.
**Legacy comparator:** `3549c4340ef37066f6690fb466824ac752ba0cbb`.
**Report only:** production code and the first review/witnesses are unchanged. No
architecture/structure document or live store was opened or modified. All executed
Rust, Bun and TypeScript checks ran on Linux with **4 vCPUs**, sequentially. The
runner admitted every job; no queue-full retry was necessary.

## Verdict

**Do not certify exact TypeScript write parity or the blanket “all 78 differences
are permitted ordinary bookkeeping” statement.** The recovery budget and disabled
memory gate fix their original regressions, and dormant Broca/host compatibility
checks pass. But the corrected oracle is only partly right:

1. **P2 — The corrected TypeScript oracle omits a real ordinary stage row.** An
   executed dormant OpenCode historian writes **one publication and one turn-one
   stage attempt per firing**, plus **one activity row per newly appended
   compartment**. This holds with memory off, under both authorities. Rust writes
   the publication/activity rows but no ordinary stage row. The manual SQL oracle
   therefore does not establish exact TS equivalence.
2. **P2 — Two of the 78 differential cases are not ordinary TS-compatible candidate
   bookkeeping.** `fold-13` and `fold-15` have promotion off yet persist one
   authority-elsewhere candidate each. TS's dormant publish writes no candidate
   when promotion is off. These are deliberately populated low-level outbox
   fixtures, not current gated historian firings; that qualification matters.
3. **P2 — Late typed terminal errors are not generally ownership-fenced at the
   component boundary.** A deterministic real-state-transition cut at the fence
   shows an old `RunFailed` abandoning a newer awaiting attempt. Today's live
   scheduler's single-flight guard limits reachability; this is **not** a demonstrated
   live double dispatch. Nevertheless the asserted general late-error guarantee
   and a scheduler-independent fence-boundary proof are not established.

The disabled-memory ordinary firing tests produce **zero memories and zero pending
facts** under either authority. The default timeout fence survives actual store
close/reopen; no fresh dispatch occurs before expiry, and exactly one occurs at
expiry in the serialized driver. Ordinary legacy send bodies are byte-identical
to the pinned base, not just JSON-equivalent. There is no newly activated Rust
turn-two orchestrator in this review.

## 1. Independently executed TypeScript footprint

The new `footprint.test.ts` invokes the **real `runCompartmentAgent`**, with an
OpenCode-compatible client returning a fixed historian answer. It seeds a fresh
OpenCode SQLite input database and a fresh context database under a temporary data
home. It does not call the publication helper directly or synthesize expected
publication rows in SQL. It enumerates **all 137 context tables**, including FTS
and SQLite sequence tables, before dispatch and after settlement, and compares
all OpenCode input tables for unchanged row bytes.

Sixteen executions cover one/two appended compartments × memory on/off × TS/module
authority × auto-promotion on/off. The unsolicited provider fact is present even
in the disabled cases. The production lane default is used; no enabled-lane
capability override is supplied. The two-compartment fixture has adequate
lookahead and an explicit unprocessed suffix, following the established review
fixture rather than defeating the discard-last safety check.

### Source establishes the same footprint

- `compartment-runner-incremental.ts:799-818` unconditionally calls
  `allocateTurnOneSend` before dispatch, including on the dormant lane.
- `memory/turn-one-publication.ts:73-112` allocates the publication and inserts
  `memory_stage_attempts`, `stage='turn_one'`, `state='dispatched'`. Its request JSON
  is only `{lane, chunkStart, chunkEnd}`: this ordinary TS stage row is **not** the
  full prompt/system storage that the original review objected to in Rust.
- `compartment-runner-incremental.ts:1135-1141,1171-1188` appends compartments and
  commits the publication in the publish transaction.
- `memory/turn-one-publication.ts:354-388` commits **one** publication, marks the
  allocated stage `published`, and inserts an activity row for **each** compartment.
- `compartment-runner-incremental.ts:1163-1170,1195-1209` gates dormant candidates
  and direct promotion; `memory/turn-one-publication.ts:399-457` shows the pending
  fact/block/link writes. Dormant candidates are unanchored; blocks/links are absent.

TS paths above are under `packages/plugin/src/`; the memory path is under
`features/magic-context/`, the runner under `hooks/magic-context/`.

### Every changed table in these executions

`N` is the number of newly appended compartments (1 or 2). These are **net durable
before/after inventories**, not counts of every intermediate SQL statement. Lease
acquisition/release is balanced and the transactional outbox is acknowledged.

| Table | Ordinary TS dormant firing | Rust dormant direct firing (N=1) |
|---|---|---|
| `compartments` | +N rows | +1 row |
| `compartment_history_versions` | one updated row | one updated row |
| `memory_publications` | +1 per firing | +1 per firing |
| `memory_stage_attempts` | **+1 per firing**, published turn one | **0** |
| `memory_activity_ledger` | +N | +1 |
| `historian_runs` | +1 telemetry row | no context row in this driver |
| `session_meta` | +1 metadata row from the initially uninitialized session | no context row in this driver |
| `subagent_invocations` | +1 invocation | no context row in this driver |
| `sqlite_sequence` | one replaced entry + four new entries ordinarily | one replaced entry + two new entries ordinarily |

With memory and auto-promotion on, add:

| Authority at the writer | Additional TS changes | Additional Rust changes |
|---|---|---|
| Local authority | `memories` +1; `memories_fts`, `_docsize`, `_idx` +1 each, `_data` changes 2→3 rows; `memory_decision_receipts` +1; `memory_journal` +1; six new sequence entries rather than four | `memories` +1; same FTS table effects; **`memory_embedding_watermarks` +1**; three new sequence entries rather than two |
| Authority elsewhere | `memory_pending_facts` +1, unknown anchor, retryable, zero attempts, reason `authority_elsewhere`; five new sequence entries rather than four | same candidate shape; three new sequence entries rather than two |

The Rust probe inventories **all 136 context tables and all 51 separate module-store
tables**. Every Rust run additionally changes exactly `mc_cache_state`,
`mc_cache_state_digest`, `mc_chunk_transcripts`, `mc_compartment_dates`, and
`mc_pass_trace` in `store.db`. These belong to the native historian state,
transcript/date and trace machinery, not new ordinary lifecycle stages. All other
inventoried tables are unchanged. `memory_fact_blocks`, `memory_fact_block_links`,
and proposals stay empty in both dormant paths. No event, primer or observation
is emitted by the footprint fixture; the pinned fold differential separately
covers those side channels without changing their bytes.

**Additional pre-existing parity caveat / Rust-only dormant durable row:** a local
Rust admission writes an embedding watermark, while this ordinary TS execution
writes a receipt and journal instead. Do not silently call their entire table
sets identical. The watermark machinery is present before the comparator tip
(`git log -S memory_embedding_watermarks 3549c434...` reaches `652f4fa00c`,
`17dd56b784`, `84d899bed6`); it is not a newly introduced S7 lifecycle stage
regression. TS receipt/journal insertion is explicit in
`memory/lifecycle-applier.ts:79-108`. This review does not repair that older
cross-runtime difference or equate the different telemetry storage systems.

### Is the corrected oracle right?

**Right about publication/activity being ordinary TS writes; wrong about “no
stage rows”, and wrong if read as one publication per compartment.** Two appended
compartments yielded one publication, one stage, and two activities. One disabled
memory compartment yielded lifecycle counts `[1,1,1,0,0,0]` in TS versus Rust's
`[1,0,1,0,0,0]` in the original six-counter order.

The author's `fold.rs:114-132` manually adds only a publication and activity row
to its identity-less legacy fold. Both sides consequently have zero stage rows;
that comparison can pass without exercising TS allocation at all. Its pass is
useful for the stated Rust SQL rows, **not** an independent TS all-row oracle.
The source's ordinary minimal stage should be distinguished from enabled-lane
Rust stages containing prompt/system and changed send identities; blindly enabling
the Rust lifecycle flag would not solve the mismatch safely.

## 2. All 78 differential differences accounted for

The rerun reproduces **147 cases, 78 changed**. `differential.json` enumerates every
changed case exactly once, plus all fold generator subgroups and the raw-wire
capture. The classifier measures the actual output and separately reconstructs
the deterministic fold input flags; it does not label all changes acceptable by
construction.

| Exact class | Cases | Row changes relative to Rust base | Ruling |
|---|---:|---|---|
| Driver publication/activity only | 47 | +1 publication, +1 activity; no stage/fact/memory/proposal delta | Ordinary TS also writes these; partial footprint compatibility, not total TS parity |
| Driver publication/activity + candidate | 7 | same plus one pending fact | All seven have memory on, auto-promotion on, authority elsewhere: TS's ordinary candidate gate permits them |
| Fold publication/activity only | 19 | publication and ledger row sets differ; all other observed rows match | Ordinary TS also has this bookkeeping; includes no-fact and locally owned raw folds |
| Fold publication/activity + candidates, promotion on | 3: `fold-8`, `fold-9`, `fold-14` | 2, 3, 1 authority-elsewhere candidates respectively | Matches the ordinary TS collection condition |
| Fold publication/activity + candidate, **promotion off** | **2: `fold-13`, `fold-15`** | one authority-elsewhere candidate each | **Not ordinary dormant TS behavior** |
| **Total** | **78** | | 76 compatible bookkeeping classes, 2 requiring the qualification below |

The seven candidate-producing driver cases are `2,14,15,22,60,62,91`. Independent
reconstruction of their generator bits confirms memory + promotion on and TS
ownership in all seven. Host (24 cases), ordinary wire (2) and crash-before-ack
(1) have **zero differences**. The remaining 42 driver cases have no difference.
The store samples preserve compartment, memory, event, primer and observation
row bytes across outbox replay; no stage delta is hidden in those classifications.

### P2: dormant low-level replay is not policy-gated

`mc-store/src/context_writes.rs:313-320` queues every `fold.facts` entry when the
module is not authority, without checking `fold.promote_facts` or a separate
collection permission. In `fold-13/15`, `promote_facts=false`, `ts_owned=true`, and
one fact is deliberately present in the recorded `FoldWrite`. The new Rust writer
persists it; the independently executed dormant TS auto-promote-off runs do not.

**Do not convert this into a false claim that the fixed current historian still
collects disabled-memory facts.** `historian.rs:3478-3480` now empties facts before
constructing the ordinary fold when memory/promotion is off. These two raw folds
bypass that gate, so the differential cannot certify their bookkeeping as normal
production behavior. A persisted pre-fix outbox containing such facts is also not
sanitized by the new collection gate on replay. The outbox format has no
`memory_enabled` collection flag from which to reconstruct that old intent.
This is a replay/API policy gap and a qualification on the author's 78-case claim,
not a demonstrated new disabled-memory firing regression.

## 3. Recovery fence, restart, and the boundary window

`historian_recovery.rs:111-150` initializes and persists the original expiry and
fence, reserves a probe before transport contact, and refuses a fourth/expired
probe. `:84-108` creates an Idle terminal-unknown tombstone, removing request
prompt/system but preserving identity and budget. `:28-39` blocks redispatch until
both the fence and any ordinary failure backoff expire; `historian.rs:541-545`
consults it before a new firing. These writes use metadata row-version CAS and
ownership checks (`historian_recovery.rs:54-82`).

The independent default-timeout test actually **drops and reopens McStore three
times**, unlike the author's reload-only test. With dispatch at 123 ms it observes:

```
original timeout = 600000 ms
probe counts across reopen = 1, 2, 3
original recovery deadline = 600123
redispatch fence = 1800123
new starts at 600123 and 1800122 = 0
new starts at 1800123 = 1, firing sequence = 2
```

The probe budget survives changes to subsequent request timeout settings because
its initial expiry remains in the durable handle. `probe_wait_budget` caps the
remaining wait. For staged handles, the real producer wraps resend plus subscribe
in `tokio::time::timeout` (`historian_producer.rs:1217-1234`). “Three probes” means
three driver collection attempts, **not three wire sends**: each collection can
replay the same request while Broca reports queued, every 100 ms (`:951-971`).
The stable identity makes these observations/replays of one accepted send, not
fresh historian attempts.

The author's `unknown_budget_is_durable_and_expiring_fence_discards_late_reply`
passes: old successful publication and an old exhausted `probe_failed` observation
are refused after the new firing, without changing its metadata/compartments;
tombstone/release log counts are one each. The independent default test covers
the 30-minute floor that the author's one-hour test does not. Idle tombstones
are rejected by reattach (`historian_recovery.rs:189-196`); ordinary transform
preparation treats Idle as firing eligibility rather than routing it back to
reattach (`lib.rs:6420-6451,6749-6799`). There is no demonstrated permanent Busy
wedge in this serialized boundary window. A tombstone discovered late can still
wait the normal failure backoff; the fence is a minimum, not a promise to fire
without a trigger exactly at the wall-clock deadline.

### P2: the broad late-error claim fails at the component API

The new negative witness calls the real reattach driver with a scripted await
hook. After the old observation starts waiting, the hook expires/tombstones its
send using `reserve_probe`, then calls `fire` and `producer_started` exactly at
`1800123`, persisting attempt 2 as `AwaitingProducer(fresh-run)`. The old await then
returns a **typed `RunFailed`**, not an unknown transport error. Result:

```
historian::tests::s7_r2_late_typed_error_must_not_abandon_fresh_attempt
assertion failed: late error from attempt 1 abandoned attempt 2
left: Idle
right: AwaitingProducer
firing_seq=2, producer_run_id=None, failure refers to old-key/old-provider-run
```

`historian.rs:3280-3321` calls `abandon_current_state_with_detail` for this error.
That helper reloads and abandons **whatever state is current** (`:3502-3514`),
without matching the observation's firing/run. Successful publication has a
matching-state predicate, but this error branch does not. A future caller that
permits this interleaving can orphan the new producer and make another firing
eligible; the durable recovery record alone does not prevent it.

**Reachability limit:** the hook advances logical time and uses the component
APIs directly. Today's production `try_claim_live_historian_session`
(`lib.rs:5905-5930`) serializes per-session fire/reattach tasks, and the store has
an exclusive McStore lease. The real staged collection is time-bounded. This
review has **not** reproduced two live transforms bypassing those guards. Thus
no live double dispatch is asserted, and the original indefinite-wait finding
is not being reissued. The unconditional “late replies and errors discarded”
component claim still needs a matching-run abandon path or a narrower documented
scheduler invariant; the negative test prevents a blanket certification.

## 4. Disabled memory and dormant live transport

Both new inventories and the original disabled-memory regression cover both
ownership directions and auto-promotion settings, including unsolicited facts.
All off cases publish compartments and ordinary publication/activity, but have
**zero `memories`, zero `memory_pending_facts`, and zero fact blocks/links**.
Collection gates and admission gates are distinct; this fix genuinely gates
collection rather than only suppressing promotion. The low-level outbox exception
above is explicitly outside that current firing proof.

Dormant `start_stage_with_generation` delegates to the legacy send API, and
checks are refused. The producer suite passes dormant identity, active/queued,
lost-ack resend identity, distinct-attempt identity and model-variant wire tests.
The head and base fake-Broca servers captured the actual authenticated
`session.send` **body bytes before JSON parsing** for active and queued replies:

```
{"method":"session.send","params":{"prompt":"p","send_id":"mc-historian:review:1","model":{"provider":"prov","model":"model"},"tools":[],"generation":{"max_output_tokens":100},"system":"s"}}
SHA-256: 2fb8e41303dfd272dddc9814880857a7d5d045df51767086ccb8ccabe80b5ae3
```

All four observations are byte-identical. This compares application send bodies,
not random transport authentication nonces/route frame headers. Queue withdrawal,
route/session identity and normalized host/crash outcomes also match the base.
The Broca queue/steer serializer goldens and the **actual** host-wire golden
`the_historian_claim_lane_answers_the_wire_a2_codes_against` pass. The separate
`tests::gate_a2` filter is not mislabeled as that golden. No ordinary transport
regression is observed in the tested cases; **storage is still not byte-identical
to the legacy base**, as the 78-case accounting explicitly shows.

## 5. Five non-vacuity controls

The author's follow-up names three control classes (disable exhaustion, bypass
collection, activate dormant lifecycle), not exact patch text. I reran those three
mechanisms with explicit minimal mutations, plus two independent controls.
`captures.md` records the exact target/sibling names, assertion output and diff
pairs. Every control was applied to the **actual staged working source**, not a
pristine snapshot; the head snapshot overlays that source. `NON-VACUITY BREAK`
marked each mutation. Before mutation, unstaged diff was empty; during it, diff
was non-empty; `git checkout -- <path> && touch <path>` restored an empty unstaged
diff. None of those source changes is delivered.

| Control | Break | Exact expected-red test | Result |
|---|---|---|---|
| A1, author class | Skip tombstone's `write_owned` persistence | `historian::tests::s7_review_witness_unknown_outcome_has_a_deadline` | Only this witness red; dormant/disabled siblings green |
| A2, author class | Force ordinary `collect_facts: true` | `historian::tests::s7_review_witness_disabled_memory_does_not_queue_facts` | Only this witness red; deadline/dormant siblings green |
| A3, author class | Return true from `lifecycle_enabled`, leaving public constant false | `historian::tests::s7_review_witness_dormant_publish_has_no_new_rows` | Only this witness red on actual `[1,1,1,0,0,0]`, not on the constant assertion |
| R1, independent, **opposite direction** | Skip ordinary publication/activity writes in `publish_dormant_candidates_tx` | `historian::tests::s7_review_witness_dormant_publish_has_no_new_rows` | Only this witness red on `[0,0,0,0,0,0]`; deadline/disabled siblings green |
| R2, independent | Remove the 30-minute minimum fence, leaving twice-timeout intact | `historian::tests::s7_r2_default_fence_survives_reopen_and_releases_once` | Only this target red on 1200123 vs 1800123; author's one-hour late-reply test stayed green |

R1 establishes that the corrected guard really demands ordinary bookkeeping,
whereas A3 establishes that it rejects additional Rust stage writes. Neither
proves the guard's **TypeScript stage expectation is correct**: the independent
TS execution disproves that. R2 reaches the same recovery file as A1 and exposes
the long-timeout test's blind spot. All five expected targets reddened with no
other selected failure; no compile error or unrelated panic counts as a control.

## 6. Reproduction, verification and limits

Witnesses are under `docs/reports/witnesses/memory-s7-review-r2/`:

- `footprint.test.ts`: real TS ordinary publish, all-table inventory, both
  authorities, all memory/promotion combinations, one/two appended compartments;
- `driver.rs`: injected Rust all-table/memory matrix, real reopen/default fence,
  and deliberately failing late-terminal-error contract witness;
- `run.py`: reuses the prior isolated snapshot runner, injects only temporary
  test code, captures raw Broca request bodies and classifies every difference;
- `differential.json`: copied measured case accounting and raw-body hash;
- `captures.md`: durable captured output excerpts, inventories, gate counts,
  mutation evidence and fixture-development corrections;
- `tsconfig.json`: explicit typecheck of the new witness/imports.

All commands require opt-in; unflagged Rust preparation/execution declines and
TS test cases are skipped. `prepare` is local Git-only; Rust modes refuse non-Linux.
The prior runner's `HEAD` archive is overlaid with current worktree crates, so the
reviewed implementation is **e4373102**, not the old archive tip.

```sh
# Run in this checkout; prepare uses Git archives, not local Rust.
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review-r2/run.py prepare

# Run the following on Linux with 4 vCPUs (runon: "linux,4c"), offline.
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review-r2/run.py differential
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review-r2/run.py r2
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review-r2/run.py witnesses
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review-r2/run.py control mc-module historian_producer
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review-r2/run.py control mc-module tests::gate_a2
MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review-r2/run.py control mc-module the_historian_claim_lane_answers_the_wire_a2_codes_against
MC_S7_REVIEW=1 bun test docs/reports/witnesses/memory-s7-review-r2/footprint.test.ts
bun run --cwd packages/plugin typecheck
bun packages/plugin/node_modules/typescript/bin/tsc --noEmit -p docs/reports/witnesses/memory-s7-review-r2/tsconfig.json
```

`r2` exits zero **only** for the exact known late-typed-error failure, its specific
assertion text, and two passing companion witnesses. It is not a green conformance
suite. `differential` exit zero means measurement plus raw-send identity completed;
the report supplies the interpretation, including the two unacceptable-as-ordinary
classes. The original `witnesses` command requires all four original regressions
(the manual oracle included) to pass.

| Final authoritative gate | Result |
|---|---|
| Pinned differential | 4 module + 1 store tests per revision passed; 147 cases / 78 changes |
| Independent Rust `r2` | Exact expected-red terminal-error witness, two other tests passed; 8 row-footprint configurations and actual three-reopen default fence |
| Original corrected `witnesses` | 3 module + 1 store named tests passed |
| Producer filter | 33 passed; includes identity and queue/steer byte goldens, injected controls/snapshots, content-language test |
| Host `gate_a2` filter | 9 passed (7 existing, 2 injected) |
| Actual host-wire golden | 1 passed |
| TS footprint final rerun | 16 passed, 192 assertions |
| TS host compatibility / existing host-runner | 18 passed in combined execution; unchanged by subsequent footprint-only fixture amendment |
| Plugin typecheck | Three repository tsc invocations passed; TypeScript 5.9.3 |
| Explicit witness typecheck | Passed after final TS fixture edit; TypeScript 5.9.3 |
| Independent driver flag reconstruction | 7 candidate-case flag checks passed; Python 3.14.4 |

Versions: Cargo `1.99.0 (5f94df478 2026-08-27)`, rustc
`1.99.0 (b940084d7 2026-09-28)`, Bun `1.4.2`, TypeScript `5.9.3`, Python `3.14.4`.
The witnesses use fake provider/Broca replies with real publish/store and transport
code, not live providers. No full workspace build, live daemon, user store,
packaging change or install was necessary for this report-only review. The
executed inventories do not claim exhaustive provider scheduling, all optional
side-channel combinations, or future turn-two behavior. Exact cross-runtime
semantic row bytes beyond the displayed ordinary footprint are not certified:
identities/clocks differ, TS allocates a minimal stage Rust lacks, and the native
metadata/telemetry storage systems differ. The source and counterexample evidence
are sufficient to reject the broader parity/late-error assertions without
inventing a live production hang or double dispatch.

Final evidence-integrity checks passed: eight assertions for the 78-case class
counts, unique coverage, complete 24-fold coverage and captured raw-body SHA-256,
plus Python AST syntax. Scoped Python diagnostics report zero errors/warnings
following explicit import-loader narrowing. The broader IDE inspection remains
partial for the intentionally unlinked Rust witness and report-directory TS/JSON
project discovery; compiled snapshot tests and the explicit repository TypeScript
compiler are the authoritative checks. Comment review covered the source-comment
blocks and reproduction instructions; unclear runner/generator/interleaving
references were clarified. Binary snapshots and comment-free JSON were not part
of that comment review. Full-workspace lint/build and optional provider-dependent
tests are intentionally not substituted for these focused report-only gates.

## Accepted round-two follow-up

The round-two report and witnesses were cherry-picked from
`cb42e8be93593da6083e5163b223f9af518b8f15`. The witness that delivers a typed
error from attempt 1 after replacement attempt 2 has started is now a
required-green regression. A reply, status observation, or typed error
from the Broca driver is checked against the phase, firing sequence, claim
attempt, provider child and producer handle that requested it. State transitions
repeat that identity check inside the metadata CAS path. Stale observations are
discarded and logged rather than releasing or altering replacement work. This
fences the demonstrated component-API interleaving without claiming it was
reachable through the current production scheduler.

The release accepts this difference in the pre-dispatch attempt ledger:
**dormant Rust writes no turn-one stage; dormant TypeScript writes one minimal
stage per firing**. Keeping Rust's existing behavior is intentional because no
dormant Rust code reads a stage record. The TypeScript record contains the lane
and chunk bounds, not a full prompt or system message. Rust remains on its
legacy dormant send/wire path. Both write ordinary publication/activity metadata.
Explicit enabled-lane component fixtures now prove that both runtimes write a
turn-one stage; they do not enable production inference or claim broader
cross-runtime row-byte parity.

`fold-13` and `fold-15` are promotion-off raw-outbox fixtures that deliberately
carry facts while bypassing the historian's memory-enabled and auto-promotion
collection filters. Their retained candidate rows are not live historian
regressions: the live caller empties facts before making such a fold. These
low-level replay fixtures and persisted facts are therefore documented without
changing replay, collection or promotion behavior.

### Round-two correction verification

The four required Rust round-two witnesses pass on Linux with four vCPUs,
including the late typed-error interleaving, reopen/release fence, dormant
all-table inventory, and new enabled-stage fixture. The late-error witness also
captures exactly one stale-observation log and leaves attempt 2 awaiting
`fresh-run`, with no failure annotation. Disabling the shared identity comparison
made only that witness fail; the other three remained green. The mutation used
the staged live source, changed one file by 3 insertions and 2 deletions, and was
restored to an empty unstaged diff.

The real TypeScript runner passes its 16 dormant footprint cases plus one
explicit enabled-stage case; the witness TypeScript configuration typechecks.
The stage payload assertions confirm the minimal TypeScript lane/chunk-bound
record. Rust's enabled component fixture commits one stage, while its dormant
fixture retains the accepted zero-stage behavior.

The affected Rust run passed 112 of 113 historian tests before exposing an
outward-error compatibility difference in the existing replacement-preservation
CAS test. The code was adjusted to keep the original CAS-conflict return while
logging/discarding the stale observation; that exact unchanged test then passed.
The stage suite (2 tests), host suite (7 tests), and strict package clippy pass.
Repository build, typecheck and lint pass. The full plugin suite still reports
8407 passed, 19 skipped and the unrelated temporary WASM-bundle
`onnxruntime-web/webgpu` resolution failure.
