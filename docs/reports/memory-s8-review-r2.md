# Independent review: memory S8 fixes, round two

## Scope and conclusion

Reviewed the Pi historian ownership fixes in `c670ac157b..f4561f9233`, including the
reservation fence in `memory/turn-two.ts` and `memory/lifecycle-applier.ts`, and
Pi's cancellation and UUID lease recovery. This delivery contains only this
report and `packages/pi-plugin/src/memory-s8-review-r2.test.ts`. No production
code, schema, manifest, lockfile, `ARCHITECTURE.md` or `STRUCTURE.md` is changed.

**The original release race is fixed.** Both original S8 regression witnesses pass:
a dead/released RPC stage cannot apply a checked edit, and live foreign PIDs no
longer keep an unknown legacy stage busy forever. Normal enabled reconciliation,
a delayed successful check, and two facts in one stage each apply exactly once.
The transaction fence does not reject those legitimate commits. Pi also aborts
released checks and closes a late child returned by a runner ignoring cancellation.

**The lease is bounded recovery, not proof the first process has stopped.** A
healthy 66-second send with six real renewals survives six foreign recoveries and
applies once. However, a 64-second busy event loop and a modelled owner/observer
clock disagreement both let another process release its still-running owner and
apply the fact before that owner's send finishes. Its late reply is fenced, so
these witnesses do **not** show duplicate canonical application.

**There is also a P2 renewal/recovery race:** even when Pi's write-lock reread
correctly preserves a newly renewed lease, the shared recovery fallback can expire
that same stage at the unknown-visit bound. The new suite contains three explicitly
red, opt-in witnesses for these remaining lease limitations; ordinary test runs
skip them. Do not interpret an all-green filtered run as full lease approval.

The original 43-pair dormant differential remains table-identical under its
existing canonicalization. All rerun S6/OpenCode witnesses, recovery, applier,
gate and projection tests pass. No OpenCode lease behavior was introduced.
The excluded `retire` and `promote_rule` S8 witnesses were not run or adjudicated;
the separate no-proposals change owns them.

## Witnesses and observations

All verification used the remote Linux runner with **four vCPUs (`linux,4c`)**, Bun **1.4.2 (744846f84)** and
**`BUN_JSC_useOMGJIT=0`**. No queue-full response occurred, so no five-minute queue
retry was needed. No local-heavy fallback was used. Stores are in-memory or
registered temporary SQLite fixtures. The subprocess owner inherits explicit
`NODE_ENV=test`, `MAGIC_CONTEXT_TEST_DATA_DIR` and `XDG_DATA_HOME` pointing into
its fixture root. No live stores or Pi session directories were accessed.

### 1. Original review and the resolving fence

| Exact witness/control | Result |
| --- | --- |
| `witness: a dead RPC stage cannot apply an edit after startup and next-run recovery release it` | Pass; released fact remains retryable with one attempt; original content and zero history survive the late check. |
| `witness: an old foreign RPC unknown outcome is bounded even while both PIDs live` | Pass; bare live PIDs do not pin the fact in flight. |
| `legitimate normal enabled applies each checked edit exactly once` | Pass; four checks, one revision/history/receipt, one send; recovery and rerun do not apply again. |
| `legitimate slow check applies each checked edit exactly once` | Pass; each of four checks waits 250 ms, no release, one application after about one second. |
| `legitimate two facts sharing a stage applies each checked edit exactly once` | Pass; eight checks, one send/stage, two distinct target revisions, exactly two histories/receipts, no repeat application. |
| `resolving transaction refuses a checked edit after stage ownership is released` | Pass on restored production code; the shared checked-edit transaction detects revoked stage ownership. |
| `resolving transaction refuses a checked edit after fact ownership is released` | Pass; releasing the fact alone also revokes the commit. |
| `released Pi checks abort promptly and close a late child that ignored the signal` | Pass; cancellation and late-child cleanup both hold. |

The new legitimate-run tests drive `runTurnTwo` with a test carrier labelled as Pi,
using enforced JSON replies and fixed validated profiles, not a paid provider. They assert the actual
canonical rows, history, fact state, receipts, exact check count, one stage and
one send. The long-send subprocess additionally exercises the real Pi scheduler,
carrier, heartbeat and check rendering. Its RPC transport and check answers are
fixtures; it is not a real external Pi/model session.

`assertMemoryFactReservation` checks the exact stage, fact state/reservation,
project and attempt snapshot (`lifecycle-applier.ts:78-96`). Its final check is
inside the immediate resolving transaction after asynchronous narrow checks
(`:855-885`), independently of the memory revision CAS. `recordStageReply` accepts
only reserved/sending stages (`turn-two.ts:527-536`); a released stage cannot be
reopened by a late send. Existing receipts still win before these checks, which
preserves idempotent replay rather than rejecting already committed work.

### 2. Lease health, false suspicion and overlapping work

The new tests use a real Bun owner subprocess and a separate SQLite connection.
The reviewer process is the second actor. The fixture's child ID has a UUID and
two live PID fields (owner and reviewer); transport work itself is held in the
owner's stub. The tested production code, timers, lease persistence and recovery
are unchanged.

- **Normal long send:** `a healthy 66-second scheduled Pi send keeps its foreign
  lease and applies once` passes. Six 11-second intervals each observe an increased
  persisted expiry and call foreign `recoverLostPiRpcStages`, which releases zero
  facts. At completion there is one send, revision 2, one history, one applied
  receipt. This is a real elapsed-time run, not an accelerated clock.
- **Timer starvation:** `witness: timer starvation must not release a healthy
  still-running Pi owner` fails only at `expect(released).toBe(0)` (received 1).
  The owner synchronously spins on `performance.now()` for 64 seconds. At 61
  seconds the reviewer recovers its expired lease while the owner is still alive
  and its send is held. The reviewer retries the fact and commits before the owner
  resumes. No clock or timer API is faked in this witness.
- **Clock disagreement:** `witness: clock skew must not release a healthy
  still-running Pi owner` has the same red assertion. Only the owner's `Date.now`
  is offset by -120 seconds; its monotonic clock and timers are unchanged. Its
  initial 60-second lease is already expired according to the reviewer, so release
  and second-process application happen immediately. Processes on a single kernel
  ordinarily share wall time; this is a deliberate model of disagreeing clocks,
  not evidence that Linux gives these two processes different system clocks. A
  wall-clock forward jump before renewal likewise leaves a vulnerable window.

Captured output from production code at `f4561f9233`, without mutation controls:

```text
S8 r2 long send: six renewals over 66 seconds, six foreign recoveries, one applied revision
S8 r2 clock skew: released=1; original={"state":"lost"}; second=resolved; history before owner finished=1; late owner fenced
S8 r2 timer starvation: released=1; original={"state":"lost"}; second=resolved; history before owner finished=1; late owner fenced
```

**Answer to the overlap question: yes, lease expiry permits a second process to
apply while the first may still be running.** The first remains alive until the
fixture is explicitly finished. After it finishes the canonical result is still
revision 2 and history count 1. The new stage/reservation fence provides write
safety; expiry does not provide execution mutual exclusion or cancel work in a
foreign process. Repeated false suspicion can consume fact attempts and eventually
make a valid candidate pending without a successful application.

Pi writes `expiresAt = Date.now() + 60_000` (`pi-historian-turn-two.ts:100-122`),
renews via a 10-second interval (`:391-404`) and compares foreign expiry against its
own `Date.now()` (`:181-191`, `:330-348`). Local live children are exempt from the
startup expiry check; foreign owners cannot rely on that exemption. A renewal gap
shorter than the lease window is covered by the ordinary long-send result; a gap
longer than the window is not. These are P2 enabled-lane liveness/overlap risks,
not evidence of corrupted memory or a dormant-production change. Activation
should explicitly accept this failure-detector contract or strengthen it; UUIDs
and PID liveness alone do not resolve pauses or incompatible time readings.

### 3. P2: a fresh renewal can still be discarded by shared recovery

Exact witness: `witness: a lease renewed before the recovery write lock stays busy
at the visit bound`.

The deterministic interleaving is:

1. A real foreign owner is held in a send. Its stage has two prior unknown visits
   and an expired lease snapshot, representing recovery reaching the visit bound.
2. The Pi resolver reads that snapshot.
3. Immediately before its release transaction acquires the SQLite write lock, a
   separate SQLite connection renews the actual persisted expiry to 60 seconds in
   the future. The fixture hooks transaction entry only to place this interleaving;
   it does not fake SQL query results or change production recovery predicates.
4. `releasePiStage` rereads the fresh lease under the lock and correctly does not
   release it. But `recoverLivePiRpcStage` nevertheless returns an `unknown` carrier
   (`pi-historian-turn-two.ts:339-356`) instead of reporting the fresh owner busy.
5. Shared `recoverTurnTwoStages` counts visit three and calls `giveUp` without
   revalidating the lease (`turn-two.ts:974-978`, `:1005-1008`). Its
   `consumeStageAttempts` transaction expires the stage (`:358-379`).

Captured output and failure:

```text
S8 r2 renewal race: original=expired; fresh lease retained=true; visits=3
witness: a lease renewed before the recovery write lock stays busy at the visit bound
Expected: "sending"
Received: "expired"
```

The fresh expiry assertion passes. This distinguishes the finding from simply
failing to renew. The write-lock reread fixes only the Pi-specific release path;
the later shared give-up path bypasses its conclusion. Recommended follow-up:
propagate a concurrently refreshed lease as `busy`, and ensure any terminal
recovery decision revalidates ownership under its resolving write lock. That is
not implemented in this report-only delivery.

### 4. Legacy stages without metadata

`legacy foreign stages without lease metadata reach the shared visit bound`
passes. It removes only `piRpcLease` from a real foreign stage's request, then
runs four new Pi recovery visits before the first 10-second heartbeat could add
modern metadata again. Startup recovery alone does not classify the live bare
PIDs as dead. Shared recovery expires the old stage at visit three, charges
exactly one attempt, and the fresh run resolves the backlog as abstained. The
old held send subsequently completes without any history write. The original
old-foreign witness separately covers an aged legacy stage's recovery.

Thus the bounded fallback handles both young unknown visits and old unreachable
stages. It does not prove a legacy owner stopped: the new legacy fixture's owner
is still alive at expiry. The shared fence, not a foreign-child kill, prevents its
late application. No migration is needed to recover absent lease metadata.

## S6/OpenCode and dormant production

Reran the OpenCode historian turn-two state machine (memory slice S6), its review
witnesses/probes, lifecycle applier, OpenCode
carrier and its two OpenCode 2 witnesses: **56 pass, 0 fail, 316 assertions, five
files**. Additional deterministic lifecycle gates and the S6 Pi projection probe:
**33 pass, 0 fail, 116 assertions**; the nine then-existing R2 tests were also
confirmed skipped with `MC_S8_REVIEW` unset. The important S6 results include:

- an unacknowledged send reattaches by the original key without another send;
- a crash at the resolving commit applies once;
- recorded replies and narrow checks recover after SIGKILL;
- a failing/malformed/unclear check still refuses, timeout retries, and CAS loss
  preserves the revised target;
- an authority-elsewhere resolving receipt does not pin its fact;
- OpenCode 2 checks start while turn one is retained and keep its prior lineage;
- history writes remain invisible on SOFT/defer and appear at the next HARD fold.

The shared diff adds ownership/state validation and guards terminal-stage writes;
it adds no Pi lease handling to OpenCode. For unreleased, correctly reserved
stages, those checks preserve the existing checked/admission/pending paths. The
S6 tests above demonstrate the same existing outcomes, including idempotent crash
recovery, apart from rejecting released/stale owners. This is targeted regression
evidence, not a provider-wide or cross-commit OpenCode differential. S6's existing
proposal tests also passed, but their behavior is outside the excluded S8
no-proposals issue and is not endorsed by this review.

Reran the original dormant randomized differential unchanged: **43 paired runs**
(86 historian invocations), seed **`0x58c670ac`**, **22 Pi + 21 OMP**, against the
pre-S8 historian/runner at `3549c4340e`. Prompts/arguments/stdin, outcome/publication
and child cleanup match, as do **all non-`sqlite_*` SQL tables**, including runner
accounting on the same isolated singleton store. Only independently generated
UUID/generation identities and wall-clock/elapsed fields are canonicalized, exactly
as in the first review (`memory-s8-review.test.ts:198-248`, `:421-508`). Payloads,
references and XML are not masked. No new normalization was added to hide lease
or memory writes. Production's dormant lane skips turn-two reconciliation and
therefore never creates these enabled Pi leases.

## Four non-vacuity controls

**Provenance gap:** `f4561f9233`'s commit message says the author ran four isolated
controls but does not identify their mutations or test names. The first review's
four controls concern the earlier S8 implementation, not these fixes. The reviewer
asked the parent; the parent approved choosing the **fence** and **fresh-lease**
controls below against the fix contracts, explicitly recording this gap, plus two
independent controls. They are not asserted to be literal reruns of two
unpublished author mutation recipes.

For every control the relevant production file was staged at its live, unmutated
state; `git diff --stat` was empty before mutation. The mutation contained
`NON-VACUITY BREAK`. After the named Linux run it was restored with
`git checkout -- <path> && touch <path>` and `git diff --stat` was empty again.
No production mutation is committed. Each run selected two tests: exactly the
named detector reddened, and the companion stayed green; all others were filtered.

| Control / mutated source | Exact red detector | Green companion | Applied diff-stat → restored diff-stat | Captured failure |
| --- | --- | --- | --- | --- |
| Fix contract: omit the final reservation/stage assertion after the checks, `memory/lifecycle-applier.ts` | `resolving transaction refuses a checked edit after stage ownership is released` | `released Pi checks abort promptly and close a late child that ignored the signal` | `1 file changed, 1 insertion(+), 1 deletion(-)` → empty | Expected `MemoryStageOwnershipLostError`; received `null`. 1 pass, 1 fail, 4 filtered. |
| Fix contract: classify every valid foreign lease as expired in startup recovery, `pi-historian-turn-two.ts` | `fresh UUID heartbeat protects an old foreign stage until its lease expires` | `a different stage UUID cannot preserve a stale reservation using the same live PIDs` | `1 file changed, 2 insertions(+), 1 deletion(-)` → empty | Expected released 0; received 1. 1 pass, 1 fail, 4 filtered. |
| Independent: ignore fact-attempt equality while preserving the SQL bind arity, `memory/lifecycle-applier.ts` | `own control: changing the fact attempt during checks revokes the commit` | `own control: a late send cannot overwrite a terminal stage` | `1 file changed, 2 insertions(+), 1 deletion(-)` → empty | Expected `MemoryStageOwnershipLostError`; received `null`. 1 pass, 1 fail, 7 filtered at that run. |
| Independent: remove the reserved/sending condition from `recordStageReply`, `memory/turn-two.ts` | `own control: a late send cannot overwrite a terminal stage` | `own control: changing the fact attempt during checks revokes the commit` | `1 file changed, 2 insertions(+), 1 deletion(-)` → empty | Expected lost/null reply; received resolved/non-null reply. 1 pass, 1 fail, 7 filtered at that run. |

After restoration all six author ownership/lease tests and the six then-selected
new positive/control/legacy tests passed together: **12 pass, 0 fail, 78
assertions**. The 66-second send, clock-skew and timer-starvation tests were
filtered in that run. This includes the actual 10-second
check heartbeat, not merely manually populated lease metadata.

## Reproduction and gate record

Run from the repository root with the locked dependencies installed. All commands
below were sent to `linux,4c`; no package or lockfile changed and no install was
needed. Prefix test commands with the environment setting shown.

```sh
# Released-stage and foreign-PID witnesses, 43-pair dormant comparison, and
# retained-child deadline / detached-publication controls.
MC_S8_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test \
  packages/pi-plugin/src/memory-s8-review.test.ts \
  --test-name-pattern 'dormant randomized|own control:|witness: an old foreign|witness: a dead RPC' \
  --timeout 30000
# 5 pass, 0 fail, 150 assertions; retire/promote_rule proposal witnesses filtered.

# New opt-in suite against f4561f9233: about 133 s; three lease defects stay red.
MC_S8_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test \
  packages/pi-plugin/src/memory-s8-review-r2.test.ts --timeout 30000
# 7 pass, 3 fail, 85 assertions. Only the three lease witnesses fail.

# OpenCode historian reconcile/recovery, checked-edit applier and carrier tests.
MC_S6_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test \
  packages/plugin/src/features/magic-context/memory/turn-two.test.ts \
  packages/plugin/src/features/magic-context/memory/turn-two-review.test.ts \
  packages/plugin/src/features/magic-context/memory/lifecycle-applier.test.ts \
  packages/plugin/src/hooks/magic-context/historian-turn-two-carrier.test.ts \
  packages/plugin/src/hooks/magic-context/historian-turn-two-carrier-review.test.ts \
  --timeout 30000
# 56 pass, 0 fail, 316 assertions.

MC_S6_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test \
  packages/plugin/src/features/magic-context/memory/lifecycle-gates.test.ts \
  packages/pi-plugin/src/turn-two-projection-pi-review.test.ts \
  packages/pi-plugin/src/memory-s8-review-r2.test.ts --timeout 30000
# 33 pass, 0 fail, 116 assertions; new review tests skip without MC_S8_REVIEW.

bun run --cwd packages/pi-plugin typecheck
bun run --cwd packages/plugin typecheck
bun run --cwd packages/pi-plugin lint
```

TypeScript **5.9.3**: both package typechecks passed (Pi builds the retina types
then checks its project; plugin also checks its scripts project). Their configs
exclude `.test.ts`, so a supplemental **`tsc --noEmit -p <temporary-config>`** also
checked the new witness source with Pi's strict compiler options, exclusions
cleared and `node`/`bun` ambient types. The temporary config is outside the worktree:

```sh
config=$(mktemp "$TMPDIR/s8-r2-tsconfig.XXXXXX.json")
printf '{"extends":"%s/packages/pi-plugin/tsconfig.json","compilerOptions":{"typeRoots":["%s/packages/pi-plugin/node_modules/@types"],"types":["node","bun"]},"include":["%s/packages/pi-plugin/src/memory-s8-review-r2.test.ts"],"exclude":[]}' \
  "$PWD" "$PWD" "$PWD" > "$config"
packages/pi-plugin/node_modules/.bin/tsc --noEmit -p "$config"
```

Biome **2.5.1**: Pi lint passed, **287 files checked**, with **23 existing warnings**
in unrelated files. An initial root-config formatting pass used the wrong indentation
for the nested Pi package; this was corrected with Pi's package-local Biome config
and lint rerun successfully. Initial witness-development failures (wrong receipt
table name and missing explicit test ambient/return types) were fixed before the
reported evidence runs. No pre-existing build failure prevented verification.
The diagnostic inspection found zero diagnostics but reported incomplete call-graph
analysis; the package and explicit test typechecks are the authoritative gates.

No full workspace test/build was rerun for this report-and-tests-only change;
no production or packaging code changed. The focused S8/S6 gates above were run
instead of touching unrelated native/provider fixture coverage. A final default
run of the new review file confirms **0 pass, 10 skip, 0 fail**: no slow subprocess
or deliberately red witness runs without `MC_S8_REVIEW=1`.
