# Independent review: S8 Pi historian turn two

## Scope and disposition

Reviewed `3549c4340e..c670ac157b346b7ce6d387f928f5aec0c16265f6`
(the eight-file Pi parity change, memory slice S8), against the OpenCode analogue
(memory slice S6), its findings in [`memory-s6-review.md`](memory-s6-review.md), and
its subsequent shared state-machine fixes.
This is **report-only**: the only additions are this report and
`packages/pi-plugin/src/memory-s8-review.test.ts`. No production code, store, or
architecture/structure document is changed.

**Do not enable the reconciliation lane yet.** The dormant live lane passed the
baseline differential and the existing Pi suite. The enabled lane has an
apply-after-release race (P1), an obsolete proposal path contrary to the updated
release ruling (P1), and a foreign-carrier recovery bound bypass (P2).
Production currently remains dormant; these are not claims that production Pi
is already sending automatic revision requests.

The governing retirement ruling changed during this review: this release has
**no pending-proposal path**. Turn two may patch clauses/add facts through the
gates with undo history, never retire a memory, and must drop/log a proposed
retirement. The older requirement to route retirement/promotion into an approval
inbox has been superseded by this no-pending-proposal release contract.

## 1. Live safety: baseline differential

`memory-s8-review.test.ts` has an opt-in differential that loads **both original
runner implementations directly from Git at `3549c4340e`**, not a reconstructed
reference implementation. It compares them to the current implementations using
independent, identically scripted subprocess fixtures and fresh isolated stores.
For each paired run, the historian dependency and the runner's `openDatabase()`
accounting singleton are the **same handle**, under a unique test-data directory;
child invocation/token accounting is therefore included in the SQL comparison.
The empty-store message-FTS rowid backfill is awaited before either historian;
otherwise its asynchronous bootstrap completion can differ between the first
cold run and a later warm run, independently of historian behavior.
The temporary original-source modules are colocated only to resolve relative
imports, are deleted by the test's finalizer, and are never committed.

Result on Linux, Bun 1.4.2: **43 paired historian runs passed**, deterministic
xorshift seed `0x58c670ac`, 22 Pi and 21 OMP runs. Harness detection is explicitly
set to each host as well as selecting that host's child invocation. The seed
varies two-pass editing, memory enablement, and auto-promotion. Cases cover:

- normal publication and existing project-memory input;
- invalid first/repair replies, failure accounting, and configured/session
  fallback chains;
- provider failure and hard timeout;
- an abort after a terminal stop, preserving the already drained result;
- editor acceptance/refusal and draft fallback;
- a terminal child that does not exit naturally (ordinary drain/cleanup).

The comparison checks the emitted argv, system prompt, stdin, child kill flag,
publication callback count, and **every SQLite table** (including publication,
facts, receipts, journal, history, compartments, child invocation/token accounting,
failure/backoff state, pending compaction marker, drain quota, and telemetry).
It preserves payloads, row counts,
references, attempts, states and reasons. Only clock/elapsed fields, generated
UUID identities, compartment-history generation, and the temporary system-prompt
filename are canonicalized. JSON payloads are normalized recursively; null
clock fields remain null. This is a semantic/write-equivalence test, not a claim
that two independently allocated UUIDs or timestamps have identical bytes.

The fixtures do not call a provider, execute a real Pi/OMP binary, or reproduce
arbitrary OS signal scheduling. Shared helpers remain the train's current code
in both runs: this isolates the two changed live runners, rather than comparing
two entire repository installations. The entire pre-review Pi suite also passed
(1,866 tests, nine skips), and the final Pi suite passed unchanged behavior after
the review additions (1,866 tests, 18 skips including the opt-in review hooks and
seven review tests).

### Why the dormant paths stay dormant

- The production resolver returns `override ?? "dormant"`
  (`turn-one-publication.ts:19-30`); production callers supply no enabling
  override. No response-schema field was added to the provider request.
- `runPiHistorian` selects the publication wrapper only when the lane is enabled
  **and** the runner can retain RPC (`pi-historian-runner.ts:772-783,1119-1151`).
  Otherwise it passes the original runner unchanged. OMP cannot retain this
  carrier (`subagent-runner.ts:1038-1042`). No-RPC and missing-guard tests retain
  ordinary promotion receipts and the project-memory block.
- The new result/drain branch requires `retainedRpc`; ordinary calls retain their
  fixed spawn deadline, terminal drain, and post-stop abort latch. The refreshed
  deadline assignment is inside the retained handle's `send`
  (`subagent-runner.ts:1779-1831,2165-2240,2245-2298`).
- `retained`/`continuation` stay null on dormant runs, so neither detached work nor
  retained-child close is reached (`pi-historian-runner.ts:1915-1941,2001-2003`).
  Ordinary subprocess cleanup was exercised by the differential and suite.

**Important qualification to “writes exactly as baseline”:** recovery now runs
unconditionally before a historian, even a dormant/headless one
(`pi-historian-runner.ts:515-517`), and at `session_start` (`index.ts:1879`). A store
containing S8 RPC reservations can therefore gain lost-stage receipts/attempt
updates when the lane is dormant. That is the claimed additive recovery behavior,
not baseline-equivalent writing. Stores reachable through the baseline's ordinary
historian lane contain no `pi-historian-rpc` stages; the differential covers that
live compatibility case. Headless refusal is also a new explicit guard, tested
separately rather than attributed to historical equivalence.

## 2. Findings and failing witnesses

All witnesses assert the required behavior, not the bug's current result. They
are skipped unless `MC_S8_REVIEW=1`; enabling the file intentionally returns
nonzero at the reviewed revision.

### P1 — a released RPC stage can still apply its checked revision

**Witness:** `witness: a dead RPC stage cannot apply an edit after startup and next-run recovery release it`.

Sequence reproduced through the Pi carrier/scheduler:

1. Publish an anchored fact and propose a valid edit of `Old rule. Keep rule.`.
2. Record the second-turn reply, then pause the isolated narrow checks.
3. Mark the retained parent child dead. Startup's recovery function releases the
   reservation, writes `carrier_lost`, charges exactly one attempt, and marks the
   stage lost. A concurrent/next headless historian recovery charges nothing more.
4. Let the already running checks return all valid verdicts.
5. The old edit still commits: the memory becomes `New rule. Keep rule.` instead
   of remaining byte-identical. The stage's old work can overwrite its lost state
   with resolved, and its decision can overwrite the fact's retryable outcome.

Recovery tests liveness but not whether the detached task is still active
(`pi-historian-turn-two.ts:53-65,83-108`). The shared resolver captured the fact
before awaiting its checks (`turn-two.ts:586-599,778-868`). The applier rechecks
memory-source revisions at commit, **not the fact's stage reservation/state**
(`lifecycle-applier.ts:813-842`). Closing the historian child does not cancel the
separate check children or revoke the already captured decision.

The two recovery entry points do **not** double-charge the fact in this witness:
transactions are synchronous and the second query sees no open lost stage; the
receipt key is stable. The missing safety property is **fencing application after
release**, not merely making release idempotent. A stage/fact ownership recheck
in the resolving transaction, combined with cancellation of detached work, is
needed; memory CAS alone is insufficient.

Observed red output: expected `Old rule. Keep rule.`, received
`New rule. Keep rule.`. Before checks resumed, the assertions confirmed the fact
had already been released to `state='retryable'`, with
`fact_attempts=1`, and a second recovery return of zero.

### P1 — retire/promote_rule still creates an inaccessible proposal

**Intentionally failing witnesses (each requires zero proposal rows):**

- `witness: Pi turn two drops and logs retire without creating a proposal`
- `witness: Pi turn two drops and logs promote_rule without creating a proposal`

Each uses the actual Pi reconciliation scheduler and carrier with a model reply
naming an active target. The target remains active (correct), but each send
creates one `memory_tool_proposals` row, where the new ruling requires none.
The retirement drop/log assertion is never reached because the proposal-count
assertion fails first.

Pi delegates the reply to shared `runTurnTwo`
(`pi-historian-turn-two.ts:247-252`). `resolveFact` handles both actions by
`resolveFactDecision(... state: "decided_pending", reason: pending_proposal,
proposal: ...)` (`turn-two.ts:663-686`); `resolveFactDecision` invokes
`proposeMemoryMutation` (`lifecycle-applier.ts:323-329`), which inserts the proposal
(`:346-373`). The rendered envelope still advertises both actions
(`turn-two-envelope.ts:323-324`). The shared state machine still creates
approval-inbox proposals; this is not limited to a Pi-specific SQL path.
The passing shared test named `retirement and standing-rule promotion become
inbox proposals and retire nothing` explicitly preserves that now-obsolete
contract. Report-only review does not rewrite it to conceal the discrepancy.

Required release behavior: remove this turn-two proposal route, drop/log
retirement, and reject/drop unsupported promotion rather than creating pending
proposals. Gated edits/new facts and undo history remain distinct supported paths.

### P2 — foreign PID liveness bypasses all unknown/unreachable bounds

**Witness:** `witness: an old foreign RPC unknown outcome is bounded even while both PIDs live`.

A reserved send has unknown outcome and a foreign `pi-rpc:<parent>:<child>:...`
identity with two existing PIDs. Backdate its stage beyond the shared 24-hour
unreachable bound; run four later enabled Pi reconciliation/recovery visits.
The fact remains `in_flight`. The busy branch also bypasses incrementing the
stage request's `recoveryVisits` counter.

`recoverLostPiRpcStages` trusts those two PIDs (`pi-historian-turn-two.ts:53-65`).
The shared recovery resolver returns `"busy"` whenever either process-local map
lacks the child/carrier (`:200-205`), **without** proving the owner has active work.
Shared recovery immediately skips busy records (`turn-two.ts:940-942`), before
either its visit counter or 24-hour expiry (`:949-967`). The UUID part of the RPC
identity is not consulted by the PID test; process reuse can also preserve a
stale stage incorrectly.

A genuinely active foreign send should not be stolen. That is different from
keeping every stage indefinitely because two processes exist. An owner heartbeat
or bounded active-stage lease is needed for a stale foreign send. This witness
models an orphaned/stalled foreign owner, not an assertion that a healthy Pi
prompt runs for 24 hours. Local known transport failures are released promptly;
local inactive unknown recovery has the shared three-visit bound.

## 3. S6 parity checklist

| S6 concern | Pi answer at the reviewed revision |
| --- | --- |
| Retained child / narrow-check role-lock deadlock | Not reproduced. Pi has no OpenCode hidden-executor role lock on this path. `runRetainedHistorian` calls `runOnce` for a separate subprocess; each check invokes it independently and closes its own child in `finally` (`subagent-runner.ts:1054-1117`; `pi-historian-turn-two.ts:158-195`). The existing test `publishes anchored facts then applies a gated edit and history through RPC with four isolated checks` completed an edit through four isolated checks with the first child alive and all five children cleaned up. |
| Turn two actually continues turn one | Holds for the installed Pi RPC implementation. `child.send` writes another `prompt` command to the same stdin, with the new stage key and no reset/new-session command (`subagent-runner.ts:1779-1813`). The author test observed one child and two distinct prompt IDs. In installed `@earendil-works/pi-coding-agent` **0.83.0**, `dist/modes/rpc/rpc-mode.js:22-25,291-318` dispatches both commands through the same `session.prompt`; `dist/core/agent-session.js:652-655,744-750,792-916` uses the session's existing agent message state. This is source evidence for that SDK version, not a real-provider conversation test or a guarantee for other versions. Explicit session-changing RPC commands can rebind a session; this carrier sends none. OMP retention is refused. |
| Unknown outcome bounded | Local inactive unknown recovery uses three counted visits; gone carriers consume one attempt and clear reservations. Known Pi send failures use the transport-failure path. **Foreign-carrier exception: P2 above.** Busy/actively processing records are intentionally not charged; mere foreign PID existence incorrectly behaves as permanent busy. |
| Items-only unknown send recovered | Shared recovery enumerates stages, not reserved facts (`turn-two.ts:870-894`), and the items-only S6 witness passed. Pi's lost recovery likewise queries all open RPC turn-two stages and marks a gone items-only stage lost even when its return count is zero (`pi-historian-turn-two.ts:72-110`). The return value counts released facts, not stages. Foreign busy records have the same bound bypass whether they contain facts or only items. |
| Item resends / prompt size bounded | Holds in shared code used by Pi. Pending items are selected only below `MAX_STAGE2_ATTEMPTS=3` (`turn-two-scoring.ts:96-119`; `lifecycle-constants.ts:6`). Reservation fits facts then items within **160,000 UTF-16 units**, releases unfitted facts, and emits deferred coverage (`turn-two.ts:69-86,449-515`; `turn-two-envelope.ts:288-294,313-329`). The unscored-item and oversized-batch tests passed. This bounds the new turn-two message, not total retained conversation tokens or a model-specific context fit; a provider context refusal is still a known transport failure. |
| Receipt pinned by `authority_elsewhere` | The S6 fix is shared: decision keys include the stage key (`turn-two.ts:324-354`). Authority refusal before a send leaves backlog rather than making a send. The authority-transition/resend witness passed. The Pi carrier adds no conflicting receipt key. |
| Outside compartment lease / 95% join | Holds. Publication schedules, but does not await, turn two (`pi-historian-runner.ts:2001-2003`). A timer yields before reconciliation (`pi-historian-turn-two.ts:244-267`). The context caller awaits the main historian and releases the lease in its `finally` (`context-handler.ts:4973-4980,5080-5083`). Its 95% guarded join waits only that main promise (`:3523-3570`), using the remaining 21-second optional-work clock (`pi-context-budget.ts:16-25,81-104`), not the scheduler's separate promise set. The new held-response control observed publication return and caller lease release before completing turn two. It models the caller's cleanup; the exact 95% branch is established by source and the existing context-handler suite, not by a new end-to-end provider test. |

The unmodified Pi suite also covered keeping the original validated child's
conversation when an editor rejects its proposed rewrite, then closing both
children; it also covered no-RPC/guard receipts, headless refusal, lost-stage
attempt caps, live-foreign
preservation, and the **actual** `session_start` handler's one-time recovery.
That last test establishes startup wiring; the new race witness directly invokes
the same recovery routine to control the interleaving with detached checks.

## 4. Mutation controls

Reran **two mutation controls recorded by the implementation author in commit
`c670ac157b`** (drain and headless); the third, startup recovery, was tested unmutated
in the Pi suite. Added **two independent controls** (fresh prompt deadline and
detached publication/lease). Each mutation was applied locally to the real
production source, tested on Linux, then restored from the staged live state and
its mtime touched. The index was populated before mutation; unstaged diff-stat
was empty before each mutation and after each restore. No mutation is committed.

| Control / mutated path | Exact selected test | Applied diff-stat, then restored diff-stat | Red result |
| --- | --- | --- | --- |
| Author: remove headless early return; `packages/pi-plugin/src/pi-historian-runner.ts` | `headless sends no historian turn and applies nothing` | `1 file changed, 1 insertion(+), 1 deletion(-)` → empty | Expected children length 0, received 1; **only this test failed** (eight filtered). |
| Author: allow terminal drain on retained RPC; `packages/pi-plugin/src/subagent-runner.ts` | `suppresses the turn-one drain timer and continues on the same RPC child with a distinct stage key` | `1 file changed, 2 insertions(+), 1 deletion(-)` → empty | Expected `killed=false`, received true; **only this test failed** (eight filtered). |
| Independent: remove refreshed deadline on `send`; `packages/pi-plugin/src/subagent-runner.ts` | `own control: an idle retained child gives its next prompt a fresh deadline` | `1 file changed, 1 insertion(+), 4 deletions(-)` → empty | After 100 ms idle on a 50 ms prompt deadline, expected second result `ok=true`, received false; **only this test failed** (six filtered). |
| Independent: await reconciliation in the historian's finalizer; `packages/pi-plugin/src/pi-historian-runner.ts` | `own control: publication resolves before held reconciliation and releases caller lease` | `1 file changed, 5 insertions(+), 1 deletion(-)` → empty | Expected publication `returned=true`, received false; **only this test failed** (six filtered). The held response was released in test cleanup, so this was red, not hung. |

Each control selected exactly one test; no other test executed or reddened in
its mutation run. The sibling control/witness names were filtered rather than
claimed green. After restoration both independent controls passed in the full
opt-in file, and both author controls passed in the final Pi suite.

## 5. Reproduction and gates

Run from the repository root, with locked dependencies installed:

```sh
# Intentionally red at c670ac157b: 3 pass, 4 fail, 153 assertions, 7 tests.
MC_S8_REVIEW=1 bun test packages/pi-plugin/src/memory-s8-review.test.ts --timeout 30000

# Normal suite leaves every review witness/control and its setup hooks skipped.
bun run --cwd packages/pi-plugin test

# Shared state-machine/S6 recovery, resend, fit, CAS and authority tests.
bun test packages/plugin/src/features/magic-context/memory/turn-two.test.ts \
  packages/plugin/src/features/magic-context/memory/turn-two-review.test.ts --timeout 30000

bun run typecheck
bun run lint
```

All required suite/typecheck/lint gates were run on Linux with `runon: "linux,8c"`.
Focused review probes also ran on Linux; the final single-file opt-in run used
2 vCPUs. Two attempted 8-vCPU focused jobs were refused by permit exhaustion,
not by missing remote-runner support; no local-heavy fallback was used.
One first attempt to run the headless mutation
control was refused due to remote permit exhaustion (`queue_wait_exceeded`), not
"no remote runner". The headless-guard mutation was restored; after completing
report/fixture work, the headless control ran remotely and reddened as documented above.

Final review, compatibility and repository gate results:

- **Bun 1.4.2 (744846f84)**: final Pi package suite **1,866 pass / 18 skip / 0 fail**,
  95,942 assertions, 1,884 tests across 189 files, 261.15 s. The package script's
  frozen-lockfile install checked 1,010 installs across 1,251 packages with **no
  changes**. No manifests or lockfiles changed.
- Shared turn-two suites: **44 pass / 0 fail**, 262 assertions, two files, 1.78 s.
  Their passing approval-inbox test reflects the superseded contract; the current
  release instead requires retirement to be dropped/logged with no pending proposal.
- Opt-in review: **3 pass / 4 expected witness failures**, 153 assertions, 28.91 s.
  Differential and both independent controls passed; the four red names are
  listed in Findings. No unrelated failure occurred in that final run.
  While extending the differential to include the accounting singleton, a
  preliminary comparison exposed an unrelated asynchronous empty-store FTS
  bootstrap flag; the fixture now awaits that backfill before either side.
  One subsequent repeat exceeded the original 30-second file-test budget;
  the 86-run SQL comparison now has a 60-second overall allowance. Neither
  the historian's 20 ms fixture deadline nor the independent 50 ms prompt
  deadline was relaxed.
- **TypeScript 5.9.3**: `bun run typecheck` passed all four workspace package
  scripts. Because the Pi script excludes `*.test.ts`, an additional temporary
  tsconfig extending the Pi config, with `types: ["node", "bun"]`, explicit Pi
  `@types` root, `exclude: []`, and only `memory-s8-review.test.ts` in `include`,
  also passed `tsc --noEmit`; Pi's own typecheck and lint were rerun after the
  accounting-coverage addition. TypeScript, not Bun's transpilation, validates
  the witness types. The scratch config lives in the remote job's temporary
  directory and is not an artifact or committed project change.
- Default-skip check: nine entries (seven tests and two hooks), zero pass,
  nine skip, zero fail.
- **Biome 2.5.1**: `bun run lint` passed; checked 1,408 core, 285 Pi, 137 CLI and
  six retina files. Existing warning/info diagnostics remain (59/9 core, 23/0
  Pi, 1/1 CLI); no error. Pi-local formatting/import organization of the added
  test was applied with the installed formatter.
- Scoped diagnostic inspection reported zero diagnostics; non-diagnostic graph
  analyses were unavailable, so this is not claimed as a full health inspection.
  TypeScript and the runtime tests above are the authoritative checks.
- Read-only comment reviews of the new test found no unclear comments. No test
  failure was rewritten into success and no existing test was altered.

Test isolation uses the repository's preloads (temporary `XDG_DATA_HOME`) and
in-memory SQLite handles for the individual witnesses and unique temporary data
directories for the differential's shared historian/accounting handle. The
review fixture's spawn calls emit controlled
subprocess protocol events without launching a child executable; no provider,
real session directory, or live store, including `~/.pi/agent/sessions/*`, was
accessed. The report contains the evidence needed to reproduce the results;
there is no reliance on logs in disposable build/cache directories.
