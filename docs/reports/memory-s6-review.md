# Independent review: memory slice S6, historian turn two (OpenCode 1 and 2)

## Scope and conclusion

This review covers `git diff 39ff6cf1..dafaede1`: four commits on top of `train/agent-move` `39ff6cf1`
(17 files, +3,848). They add `memory/turn-two.ts`, `turn-two-envelope.ts`, `turn-two-retrieval.ts`,
`turn-two-scoring.ts`, `hooks/magic-context/historian-turn-two-carrier.ts` and
`historian-turn-two-step.ts`, and change the applier, the check ledger, the gates, dreamer classify
and the compartment runner. The S6 spec is subordinate to the rulings in
[the S3 projection design](../designs/memory-s3-projection.md),
[the Rust projection note](../../crates/mc-module/MEMORY-PROJECTION.md) and the operator rulings in
the brief.

**Prefix safety holds.** All production lanes are dormant (`resolveTurnOneLane`, which returns
`"dormant"` unless a test overrides it). Over 72 randomized cross-commit scenarios, `39ff6cf1` and
`dafaede1` served byte-identical requests in all 1,872 serving passes, on OpenCode 1, OpenCode 2 and Pi.
With the lane enabled in a test, an edit applied by turn two wrote history and no mutation-log row.
It stayed out of the served pair on every SOFT and defer pass, and appeared at the next genuine HARD
fold, on OpenCode and on Pi. The deterministic gates all run before any write, including the
truncation-aware quote gate (#17639 probe). No archive or curate operation became a direct write.

**The enabled lane is not ready to activate.** Three P1 defects block it. On OpenCode 2, the first
narrow check deadlocks behind the retained turn-one child, and turn two never sees turn one. On every
host, a stage whose child never answers stays `in_flight` with its child open forever. There are also
four P2 defects and several P3 findings. Every P1 and P2 finding except two has a failing witness. The
exceptions are P2-4, a mutation result, and P2-7, which comes from reading the code.

This delivery adds only tests (skipped by default) and this report. No product code, migration,
lockfile, `ARCHITECTURE.md` or `STRUCTURE.md` is changed.

### How to run the witnesses

All new tests are skipped unless `MC_S6_REVIEW=1`; `review witness:` tests fail at `dafaede1`, while
`review probe:` tests pass and serve as evidence.

```sh
cd packages/plugin
MC_S6_REVIEW=1 bun test src/features/magic-context/memory/turn-two-review.test.ts -t "review witness"
MC_S6_REVIEW=1 bun test src/hooks/magic-context/historian-turn-two-carrier-review.test.ts
MC_S6_REVIEW=1 bun test src/features/magic-context/memory/turn-two-review.test.ts -t "review probe"
cd ../pi-plugin && MC_S6_REVIEW=1 bun test src/turn-two-projection-pi-review.test.ts
```

Result on Linux (bun 1.4.2): the 7 witnesses fail; the 5 plugin probes and the Pi probe pass. With
the variable unset, all 12 plugin tests and the Pi test are skipped.

## Findings by severity

### P1-1: OpenCode 2 — the first narrow check deadlocks behind the retained turn-one child

The OpenCode 2 executor serializes hidden children per role. `open()` takes the role lock
(`v2/hidden-completion.ts:400-413`, `:508-511`), and only `close()` releases it (`:805-808`). Every
non-dreamer run maps to the role `"historian"` (`:97-100`). The runner keeps turn one's child open
through turn two (`compartment-runner-incremental.ts:866`, `:1525-1541`, closed in `finally`
`:1567-1573`). `sendCheck` opens a fresh child of kind `"historian"` on the same executor
(`historian-turn-two-carrier.ts:166`). That `open()` waits for the lock the retained child holds,
and the retained child is closed only after `runTurnTwo` returns, so the wait never ends. Any edit,
merge or replacement with a validated profile reaches a check and hangs the historian run. Because the
role is process-wide, every later historian or editor run in that process then waits behind it.

The lock also leaks without any check:

- When turn two returns `childInFlight` (an unknown outcome), the runner drops its reference
  (`:1540`) and never closes the child.
- Recovery cannot close it either. It builds a new handle object (`historian-turn-two-carrier.ts:237`),
  but the executor keys its runs by handle identity (`WeakMap`, `v2/hidden-completion.ts:380`). On
  that new handle, `collect()` throws ("no settled output", `:779-782`), recovery treats the throw as
  `gone`, and `close()` returns early (`:786-787`). So on OpenCode 2 a reply is never reattached, and
  the role lock stays held for the life of the process.
- Witness: `historian-turn-two-carrier-review.test.ts` › *review witness: on OpenCode 2 a narrow check
  can start while turn one's child is retained*. It drives the real executor, hook and carrier, and
  its check is still `"blocked"` after 1.5 s. Closing the retained child releases the queued `open()`,
  which shows that the lock is the cause.
- Exposure: enabled lane on OpenCode 2 only (dormant in production). OpenCode 1 has no role lock.

### P1-2: OpenCode 2 — turn two does not continue turn one's conversation

On each attempt's first step, the hidden-child context hook replaces the child's history with the new
prompt alone (`v2/hooks/hidden-child.ts:545-548`; its own comment, `:386-388`: "the first step
replaces it wholesale"). Turn two on OpenCode 2 is therefore a fresh single-turn call on the same
session id. The model does not see turn one's prompt or reply, and there is no cache reuse. The spec
(lifecycle design §4, "Turn two: same-session reconcile") requires appending to the same lineage with
the first prompt and reply as preceding roles. The carrier's header claims a continuation on "OpenCode
1 and OpenCode 2 hosts" (`historian-turn-two-carrier.ts:1-6`).

- Witness: *review witness: on OpenCode 2 the turn-two request carries turn one's prompt and reply*.
  The provider-bound messages are
  `[{"role":"user","content":[{"type":"text","text":"Turn two: reconcile …"}]}]`.
- Mitigation in place: the turn-two prompt is self-contained (facts, blocks, neighbours), so decisions
  still have their evidence. The departure from the spec is undisclosed, and there is no cache
  benefit.

### P1-3: a stage the child never answers stays `in_flight` forever, with its child open

The rulings require "unknown stays `in_flight`", but also no fact stuck in flight forever. Nothing
bounds an unknown outcome:

- OpenCode 1 recovery returns `unknown` whenever the child's latest text is empty or still hashes to
  turn one's reply (`historian-turn-two-carrier.ts:251-252`). That holds forever if the prompt was
  lost before the host recorded it, or if the provider produced no text. The carrier's own `send`
  throws `TurnTwoOutcomeUnknownError` for the same state (`:141-142`).
- `recoverTurnTwoStages` neither ages a stage nor charges an attempt on `unknown` (`turn-two.ts:803`).
  `startedAt` is used only for the "young" check.
- The retained child is closed only on `gone` or after resolution (`turn-two.ts:806`, `:826`).
- Parent-session deletion releases the facts (+1, `lifecycle-applier.ts:984-991`) and deletes the
  stage row (`memory_stage_attempts` is session-scoped). Nothing closes the open child, so it is
  leaked on OpenCode 1, and on OpenCode 2 its role lock is held (P1-1).
- Witness: `turn-two-review.test.ts` › *review witness: a turn-two send the child never answered does
  not stay in_flight forever*. It uses the production OpenCode carrier and recovery, with recovery a
  day later run five times. The fact is still `in_flight` with 0 attempts, and `close` was never
  called.
- The rewritten runner test (`compartment-runner-turn-one.test.ts:371-396`) expects exactly this
  stuck state; see §7.

### P2-1: an `authority_elsewhere` receipt can pin a fact `in_flight` permanently

Two resolving paths record a `retryable` receipt without charging an attempt:
`applyMemoryAdmission` (`lifecycle-applier.ts:147-152`) and `applyHistorianRevision` (`:756-767`).
The decision key is (project, fact, `fact_attempts` at send, position in the reply, targets)
(`turn-two.ts:284-297`). If authority moves to the module during inference and later returns, the
fact is resent with the same `fact_attempts`. The same answer at the same position then reuses the
key, and `readReceipt` returns the old receipt without touching the fact (`:130-131`, `:737-738`). The
fact stays `in_flight`, the stage never resolves, every later run re-resolves it to the same receipt,
and the caller keeps the child open each time.

- Witness: *review witness: an authority_elsewhere receipt from a resolving transaction cannot pin the
  fact in_flight on its resend* (an `authority_repair_pending` row is inserted during the send, then
  removed).
- Direction: charge an attempt (or include a per-send nonce in the key) for any `retryable` receipt,
  as `resolveRevisionFailure` already does.

### P2-2: an items-only send with an unknown outcome leaks the child and is never recovered

`reserveTurnTwo` sends when there are classification items and no facts (`turn-two.ts:393`). On
`TurnTwoOutcomeUnknownError`, `runTurnTwo` returns `childInFlight: true` whether or not any fact was
reserved (`:896-897`), so the runner drops the child without closing it. Recovery visits only stages
that hold an `in_flight` fact (`:759`), so it never visits this stage, never reattaches it and never
closes the child. On OpenCode 2 the role lock leaks as in P1-1.

- Witness: *review witness: an items-only send with an unknown outcome is recovered and its child
  closed* (0 reattaches, 0 closes over three later runs).

### P2-3: agent-memory items have no attempt bound; items-only sends repeat without limit

An item stays `pending` until a valid score is recorded (`turn-two-scoring.ts:128-150`). An item the
model never scores, or always scores out of range, is sent again on every historian run. With no
facts pending, each of those runs is a paid turn-two call that carries only items. The prompt has no
size bound either (`turn-two-envelope.ts:305-346`): it includes all current facts, eight backlog facts
with up to 12 full neighbours each, and every due item. A provider "prompt too long" refusal is a
`stage2_transport` failure that charges an attempt to every fact in the send (`turn-two.ts:898-907`).
The spec instead asks for a smaller batch with an explicit coverage warning (§4).

- Witness: *review witness: an agent-memory item the historian never scores is not re-sent without
  bound*. It makes 6 sends in 6 runs, each with no fact, against an expected maximum of
  `MAX_STAGE2_ATTEMPTS` (3).

### P2-4: the commit-time CAS recheck is not defended by any test

`applyHistorianRevision` checks the source revisions again inside the resolving transaction
(`lifecycle-applier.ts:814-827`). Only this recheck stops a target that was revised while the narrow
checks were in flight from being overwritten, losing the other writer's text. Neutralizing it leaves
the worker's whole memory suite green (see §8). The new probe *review probe: a target revised while
the narrow checks are in flight is not overwritten* now defends it: it passes at `dafaede1` and fails
under the mutant (`Expected "Agent text. Keep rule." / Received "New rule. Keep rule."`).
Recommendation: make it a permanent test.

### P2-5: turn two runs inside the compartment run, which holds the session lease and the 95% join

Turn two and every narrow check run inside `runCompartmentAgent`, after publication
(`compartment-runner-incremental.ts:1525-1541`). The run's promise, its `activeRuns` entry and the
renewed compartment lease (`compartment-runner.ts:142-145`, `:181`) are therefore held for one send
plus up to `NARROW_CHECK_CALL_CEILING` (8) checks per fact, each bounded only by the historian
timeout. Consequences:

- No other historian run for the session can start meanwhile (`startBackgroundCompartmentAgent`
  returns early).
- At 95% context, the transform blocks the user's request on `activeRun.promise`
  (`transform-compartment-phase.ts:441-536`). It now waits for turn two even though the compartments
  are already published. If the join budget runs out, the pass proceeds without re-preparing the
  injection (`:329-336`).
- `compartmentInProgress` is cleared and `completedSuccessfully` set before turn two (`:1341-1342`).
  A trigger that fires during turn two sets the flag again, but `startCompartmentAgent` returns early
  because the run is still active, and nothing clears the flag afterwards.

The worker's runner test shows turn two runs before `runHistorian` returns (event order
`prompt:1, prompt:2, delete`). There is no dedicated witness for this finding (it comes from reading
the code). Direction: run turn two after the compartment run settles, outside the lease and the join,
or exclude it from the join.

### P3 findings

- **P3-1: a partial semantic lane drops lexical hits.** With any embeddings for the current model id,
  only the top `LEXICAL_SLOT_COUNT` (2) lexical hits are kept, and the remaining slots take semantic
  hits only (`turn-two-retrieval.ts:73-81`). Lexical matches whose memories have no embedding yet are
  dropped while shortlist slots stay empty, and the prompt does not say so. Witness: *review witness:
  with a partial semantic lane, free shortlist slots still take lexical hits* (3 of 12 slots filled;
  5 lexical matches exist). A related case: if every embedding for the model id has the wrong vector
  length, `semantic` is `[]`, not `null`, so the "lexical-only" notice is withheld (`:58-67`).
- **P3-2: with two-pass historian, the retained child is the draft's.** `withChild(finalResult,
  firstRun)` keeps the draft run's child while the published reply is the editor's
  (`compartment-runner-historian.ts:360-370`). Turn two then continues a conversation whose last reply
  is not the one that was published.
- **P3-3: classify skip and scoring are unreachable in production, and can starve.** No production
  caller passes `classificationAnchor` (it appears only in tests), so no classification item is ever
  enqueued, even on an enabled lane. Once items are enqueued, dreamer classify skips a memory with any
  item, open or scored (`dreamer/classify.ts:258-266`). An item that never becomes due (the session
  ends before S+4 is published, or the lane is turned off) then keeps the memory out of both
  classifiers permanently. The design defers such memories to a later backfill (§4).
- **P3-4: recovery isolation.** A deterministic throw while resolving a recorded reply propagates out
  of `recoverTurnTwoStages`, which runs before any new send (`turn-two.ts:853-860`). Every later
  `runTurnTwo` for the project then throws at the same point, and new facts accumulate unsent. The
  worker's crash test shows the propagation, with a transient trigger.
- **P3-5: a recovered reply can never apply an edit.** OpenCode recovery records `profile: null`
  (`historian-turn-two-carrier.ts:258`), which becomes the placeholder profile, so every edit in a
  recovered reply is deferred as `unvalidated_profile` (+1). This is safe but costs an attempt and a
  resend.
- **P3-6: ruling reading on archive.** Historian `retire` and `promote_rule` become `decided_pending`
  facts, not inbox proposals in `memory_tool_proposals`. That is not a direct write, but the inbox
  will not see them as archive proposals. Merge and replacement archive their non-surviving sources
  directly, with history and successor links, as part of a gated edit. That matches the agent merge
  semantics and the design's §4 table. The operator should confirm it is within "Archive … stay
  proposals".
- **P3-7: doc drift.** `docs/designs/memory-s3-projection.md:129` still says that
  `MEMORY_PROJECTION_READY = false` disables the historian revision commit.

## 1. Prefix safety

**Default-off path, cross-commit.** I re-ran the S5 reviewer's independent differential probe
(`turn-one-random-differential.probe.ts`) with base root `git archive 39ff6cf1` and current root this
worktree (`dafaede1` plus test-only files). Seeds 1–4 × {OpenCode 1, OpenCode 2, Pi} × {TS, module
authority} × {dormant/plain, dormant/prefixed, enabled/prefixed} = 72 scenarios with real restarts.
The probe compares, pass by pass, the whole served message array (m[0], m[1] and the trimmed history),
the materialization flag, and the SHA-256 of each historian prompt.

| Result | Value |
| --- | --- |
| Scenarios failing | 0 of 72 |
| Serving passes identical | 1,872 / 1,872 |
| Historian publishes | 648 (dormant prompts all identical) |
| Violations | 0 (no candidate token served; promoted tokens shown only after a fold: 33) |
| Open DB files | all under the job's throwaway root `$TMPDIR/magic-context/s6-review/…` (`/proc/self/fd`) |

In the enabled scenarios, the current tree created extra `turn_two` stage rows (up to 14 stage rows
per scenario, against 5 at base) and still served bytes identical to base, which ran with
`autoPromote: false`.

Reading the diff confirms why the dormant path is unchanged:

- `retainChild` is `anchoredFacts`, and `anchoredFacts` is true only on an enabled lane
  (`compartment-runner-incremental.ts:572`, `:866`). Otherwise the child closes in
  `runHistorianPrompt`'s `finally` as before, and `retainedChild` stays undefined, so no turn two runs.
- The `releaseMemoryReservations` change touches only `in_flight` facts, and there are none on the
  dormant lane.
- The classify filter is empty without classification items, and nothing enqueues them (P3-3).

**Enabled lane in a test.** *review probe: an applied turn-two edit is invisible on SOFT and defer
passes and appears at the next genuine HARD (OpenCode)*, plus the Pi twin in
`packages/pi-plugin/src/turn-two-projection-pi-review.test.ts`. Both use the S3 fixture loader gate,
under which any read of `memories` or `memory_mutation_log` throws. Both run the same steps:

1. A HARD fold shows `Old rule. Keep rule.`.
2. `runTurnTwo` applies the edit, and the memory row changes.
3. `memory_mutation_log` is unchanged (no m[1] delta source).
4. Two busting SOFT and two defer passes serve byte-identical m[0] and m[1], do not materialize, and
   read no memory rows.
5. A cache-expiry HARD shows `New rule. Keep rule.` and not the old text.

The OpenCode drivers (`injectM0M1`, `materializeM0`) are the ones both OpenCode generations use.

## 2. Keeping the historian child open

- **Error, crash and timeout:** every exit between validation and the end of the run goes through the
  runner's `finally`, which closes the retained child (`:1567-1573`). Invalid replies close their
  children in `runValidatedHistorianPass` (`:372`, `:421`) and in the fallback chain (`:953`). A
  process crash orphans the child, as any crash mid-run already does.
- **Leaks:**
  - an unknown outcome that never resolves (P1-3);
  - an items-only unknown stage (P2-2);
  - parent-session deletion while in flight (P1-3);
  - every in-flight stage on OpenCode 2, through the role lock and the `WeakMap` handle (P1-1);
  - a key-reuse stuck fact keeps the child open on every run (P2-1).
- **Concurrency:** on OpenCode 2 the retained child holds the process-wide historian role (P1-1).
  On both hosts, turn two extends the compartment lease, `activeRuns` and the 95% join (P2-5).

## 3. The two spec departures

**(a) `MEMORY_PROJECTION_READY` removed; an applied historian edit writes history and no mutation-log
row.** This matches S3 contract item 4 and the ruling that automated writes apply directly with
history. `commitMemoryRevision` writes:

- `memory_history` (previous text, evidence spans, source ids, decision key);
- a revision bump and successor links;
- the receipt and a journal row.

It writes no `memory_mutation_log` row and no agent fragment, and does not bump an epoch (the
worker's "green edit" test checks `project_state` too). The post-commit embedding refresh is guarded
by the content hash. The probes in §1 confirm SOFT and defer invisibility and HARD visibility on
OpenCode and Pi. Scoring's importance copy also writes no log row, as the ruling requires for
automated changes.

**(b) A changed or archived source is a retryable CAS loss before the plan**
(`lifecycle-applier.ts:770-787`). This replaces the old `decided_pending source_revision` refusal. It
matches design §4: a target changed during inference is re-retrieved and reconciled, not overwritten.

- The retry charges an attempt (`resolveRevisionFailure`) and is capped at `MAX_STAGE2_ATTEMPTS` = 3.
- A resend retrieves neighbours again, so their revisions are current, and the new `fact_attempts`
  value gives the decision a new key. A stale decision cannot be applied twice.
- A source that was deleted, or belongs to another project, is not treated as a CAS loss. It falls
  through to the plan's `shape` refusal, which is terminal.
- A target revised after this check and before commit is caught by the in-transaction recheck
  (P2-4).

CAS therefore cannot loop. The one unbounded retry in this area is the `authority_elsewhere` path
(P2-1), not the CAS change.

## 4. The gates

`applyHistorianRevision` runs these steps in order: receipt, authority, pre-plan CAS, the full
deterministic plan, the narrow checks through the ledger, and finally the commit transaction. The
commit transaction checks the revisions again, so every gate runs before any write.

The gates and where they are enforced:

| Gate | Where | How |
| --- | --- | --- |
| Clause-level patch | `lifecycle-gates.ts:156-191` | Kept clauses must survive byte for byte; the final text must equal kept plus added; appends without a change are refused. |
| Cited ordinals | `lifecycle-text.ts:188-212` | `matchFactEvidence` resolves a cited ordinal only within that fact's own stored blocks. |
| Preserved identifiers | `lifecycle-gates.ts:214-220` | Refused with `dropped_token`. |
| No invented numbers or dates | `lifecycle-gates.ts:238-243` | Refused with `new_token`. |
| Narrow contradiction | `lifecycle-gates.ts:260-290` | Disproof, support, kept-clause and compatibility checks. |
| Profile | `lifecycle-gates.ts:379-412` | Each check uses only its own fixed system prompt. |

*review probe: #17639 c4 repair passes the deterministic gates; the quote gate is truncation-aware*
covers the following cases:

- On the full passage, a verbatim excerpt plans four checks (disproof, support, kept-clause,
  compatibility).
- With the block cut inside "host" by `HISTORIAN_TRUNCATION_MARKER`, the excerpt "the default runs it
  in the ho" (up to the cut mark) is accepted.
- An excerpt across the cut is refused (`evidence_or_window`), and so is one that quotes the marker.
- An added clause with an invented date is refused (`new_token`).
- Removing c3 (a path, an identifier and a constant) on evidence that names none of them is refused
  (`dropped_token`).
- The v6 failure mode, keeping c4 and appending the new fact, is refused (`append_only`).

No archive or curate path became a direct write: `retire` stays `decided_pending`, and curate code is
untouched. See P3-6 on merge and replacement.

## 5. Recovery and crashes

These hold:

- **One transaction before dispatch.** The stage row, its classification watermark and the fact
  reservations are written in a single `immediate` transaction (`turn-two.ts:344-424`).
- **A recorded reply is resolved without a second send.** The worker's test and the SIGKILL probe
  below show this.
- **`gone` charges one attempt** (`consumeStageAttempts`).
- **`unknown` keeps the facts reserved**, but without a bound (P1-3).
- **Reattach by key.** A stage is found by its stage key and `run_attempt`. A check row without a
  reply is reattached (`reattach: true`); the OpenCode recovery rejects that, which is treated as a
  transport failure (+1).

SIGKILL probes use real child processes on a file database under `$TMPDIR/magic-context/s6-review/`,
each killed with `SIGKILL`:

- *review probe: SIGKILL during the turn-two send; recovery reattaches the reply by stage key and
  applies once*. After the kill, the fact is `in_flight` with 0 attempts, and the stage is `sending`
  with no reply and its watermark set. Recovery reattaches once, no new prompt is sent, the fact is
  `applied` with 0 attempts, there is one history row, and the child is closed once.
- *review probe: SIGKILL during a narrow check; recovery charges one attempt, the resend applies once*.
  After the kill, the check row is `in_flight`. Recovery records a `check_transport` receipt (+1), and
  the same run sends the fact again as backlog. The fact is `applied` with 1 attempt, there is one
  history row and no log row, and a later run sends nothing.

Neither probe shows a duplicate apply or a lost fact, and the `fact_attempts` bound holds in both. The
exceptions to "never stuck" are P1-3, P2-1 and P2-2.

## 6. Retrieval, scoring and classify

- **Slot mix.** Two reserved lexical slots come first, then semantic up to 12, deduplicated. The
  "lexical-only" label appears when there is no query embedding or no stored embedding for the current
  model id (the worker's test covers model-b). The gaps are listed in P3-1.
- **Project isolation.** FTS and the embedding cache are keyed by project. A final filter drops any
  neighbour from another project, and `liveTarget` refuses cross-project targets. No leak was found.
- **Scoring.** Items are selected at or below the watermark persisted with the stage. Only items in the
  send are scored (`sentSequences`), and the update compares-and-swaps on `state='pending'`. The
  excerpt window is S−2 to S+4 inclusive and becomes due once compartments cover S+4. Clipping happens
  only at the session start, and unreadable ordinals are recorded. No off-by-one was found.
  `readTurnTwoExcerpt` reads `[from, to+1)` and blocks never start before `from`.
- **Classify** skips a memory with any item, which protects historian scores from being overwritten.
  See P3-3 for the starvation case.

## 7. The two rewritten tests

1. `lifecycle-applier.test.ts`: *production revisions remain pending until projection exists…* was
   renamed *historian revisions run every check through the ledger before one canonical write, with no
   mutation-log row*. The old claim (no write while the flag is off) is removed by departure (a), which
   the ruling sanctions. The production-safety claim now rests on the dormant lane (the worker's
   *sends no turn two on a dormant lane* and the differential in §1). **Justified.** The new test is
   weak on ordering: it fills the ledger by calling `checkMemoryRevision` directly, so
   `applyHistorianRevision` answers from the ledger. Ordering is defended elsewhere: the
   failing-verdict tests keep the row byte-identical.
2. `compartment-runner-turn-one.test.ts`: the expected fact state changed from `retryable` to
   `in_flight`, and `turnOneSends` now filters `stage='turn_one'`. The filter is justified, since
   turn-two rows now exist. The state change is mechanically correct, because turn two now follows on
   the enabled lane. **It hides a regression**, though: the stub host answers only turn one, and with
   the production recovery this state never leaves `in_flight` (P1-3). The test should assert that
   the reservation is eventually released, or the stub should answer turn two.

## 8. Mutation controls

Each control was staged with `git add` (confirmed by an empty `git diff --stat`), mutated, run on
Linux, then restored with `git checkout -- <path> && touch <path>`, giving an empty `git diff --stat`
again. The suite for each run was `bun test src/features/magic-context/memory
src/hooks/magic-context/compartment-runner-turn-one.test.ts`, plus `dreamer/classify.test.ts` for
control 2. That is about 385 tests. The baseline failure *Node WASM Transformers fixture* (it cannot
find `onnxruntime-web/webgpu` on the runner) fails with or without a mutant.

| Control | Expected red | Result |
| --- | --- | --- |
| Worker 2: drop the `sentSequences` filter in `recordItemScores` | *turn two agent-memory scoring › scores at or below the stage watermark only…* | reddened, only that test |
| Worker 4: drop the `child_session_id` clause in `releaseMemoryReservations` | *turn two crash recovery › deleting the child's session releases…* | reddened, only that test |
| Mine: disable the pre-plan stale-source check (departure b) | *turn two gated edits › a CAS loss consumes one attempt and writes no row, history or link* | reddened, only that test (a first run also hit a 7.6 s timing flake in an unrelated dormant-lane runner test; the rerun was clean) |
| Mine: disable the commit-time CAS recheck | none in the worker's suite | **undefended** (P2-4); the new probe *a target revised while the narrow checks are in flight is not overwritten* reddens under it and nothing else does |

## Verification

All commands ran on Linux (`runon`, ck-motor) with bun 1.4.2, tsc 5.9.3 and biome 2.5.1:

- `bun run --cwd packages/plugin typecheck` and `--cwd packages/pi-plugin typecheck`: exit 0.
- `bun run --cwd packages/plugin lint` and `--cwd packages/pi-plugin lint`: exit 0 (warnings only,
  none of them in the new files).
- `bun run --cwd packages/plugin test`: 8,376 pass, 31 skip, 12 fail. Two of the failures were caused
  by the new tests and are fixed: the test-temp-dir policy test and the Windows `spawn` hiding test.
  The other 10 fail identically on a clean `git archive dafaede1` tree on the same runner: nine
  review-bundle tests need `dist/`, and the WASM fixture needs `onnxruntime-web`.
- `bun run --cwd packages/pi-plugin test`: 1,855 pass, 10 skip, 0 fail.

**Live-store isolation.** No host binary was launched. Unit tests use in-memory or temporary
databases, and `OPENCODE_DB` was never exported. The differential probe's child processes listed
their open `.db` files through `/proc/self/fd`, and every one was under the job's throwaway
`$TMPDIR/magic-context/s6-review/` root. No live store was opened, read, written or migrated.
