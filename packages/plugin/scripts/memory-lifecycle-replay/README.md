# Memory lifecycle replay

This is an **offline, read-only instrument**, not a production lane enabler. It has
no provider transport, live-store connection, routing override, or memory writer.
`validatedProfiles` in the recorded audit is always empty. A historical request
or grade does not validate a current production prompt or carrier.

Run from the repository root:

```sh
bun packages/plugin/scripts/memory-lifecycle-replay/run.ts preflight
bun packages/plugin/scripts/memory-lifecycle-replay/run.ts audit-recorded
bun test packages/plugin/scripts/memory-lifecycle-replay --timeout 30000
npm run typecheck
```

`preflight` exits **2** on any missing start condition. `audit-recorded` is a
separate diagnostic: it evaluates captured legacy control shapes against the
current deterministic gates, even when preflight refuses. It does not start the
blocked replay, send a request, execute a recorded check with different inputs,
or mark a profile validated.

## Private inputs and immutable inventory

The owner-supplied read-only copy lives at `.cortexkit/private/s10-evidence/`.
Only its relative paths, SHA-256 hashes and non-content metadata are committed.
`corpus-manifest.json` inventories all 183 supplied files and the four available
frozen cases (2, 12, 27 and 35). The v2 merge-trial protocol used forty historical
historian requests, numbered **0–39**; these four are its problem-case controls. A report
about those forty cases is not the forty input/reply/candidate records themselves.
No fresh extraction can replace a missing frozen reply or reconstructed control.

The manifest contains `google/antigravity-gemini-3.8-flash`, the literal routing
ID required for the Gemini replay arm. The DeepSeek literal remains
`null`: a historical capture's `deepseek-flash` response ID is not the owner's
selection of a current full routing ID. Neither configuration nor environment
variables are consulted. The durable-private-copy attestation is also false;
hydration alone is not proof of durable retention.

To intentionally regenerate the inventory before a future model replay, run:

```sh
bun packages/plugin/scripts/memory-lifecycle-replay/run.ts hydrate
```

This rewrites the inventory, not the private files. Review changed hashes rather
than treating re-hashing changed input as a successful validation. Update the
omissions ledger's manifest hash only after reviewing the new frozen inventory.
A complete manifest must include sequential fact IDs in reply order, actual
reply-content hashes, frozen candidate hashes, exact printed block hashes, and a
source-block anchor for every fact. Missing anchors stay missing; the whole
`<new_messages>` interval is never assigned as a fallback. Only control 35:3's
recorded verbatim edit citation identifies a unique printed source block in the
available captures. Its block range is frozen in the manifest; the other 38
facts remain unanchored.

Preflight rereads actual captured replies, candidate facts and printed blocks;
it does not merely compare two copies of a manifest field. It validates hashes
against file bytes and refuses absolute/escaping/symlink-escaping paths. It also
checks the four problem cases, required control fact IDs, and the recorded kept
input bound. That bound includes all rendered blocks and each possible single
target's kept clauses, including operand labels. It covers these legacy
single-target decisions; production planning independently bounds any actual
multi-source merge and check count.

## Turn one and omissions

`productionTurnOne` uses the production prompt builder with anchored facts and
no project-memory block. `turnOneAnchorFailures` checks the generated reply
against that case's printed `[N]` / `[N-M]` blocks and reply-local compartments.
Malformed, absent, out-of-range, or discarded-tail anchors fail instead of being
silently downgraded to unknown. Only an explicit unknown prefix is acceptable.
The old captures were not generated with this prompt; they are not a turn-one
pass for it.

`omissions-ledger.json` is an intentionally **incomplete ledger**, not invented
grades. Supply a reviewed inventory of every full-memory-only family missed by
either new-prompt or stripped S arm, then independently grade **both arms for
every family**, using `episode`, `duplicate`, `already-covered`, or `loss`.
`omissionsFailures` requires that exact case/family inventory and the corpus
manifest hash, rejects duplicate rows or a reviewer identical to the extractor,
requires zero new-prompt losses for families the reviewer marks `safetyShaped`
(safety rules rather than ordinary episodic facts), and compares other losses to S
on the same case. Empty families or either absent arm's grade fail closed.
The historical full-memory (F), trial-stripped (T), and second stripped (S)
summary compares older selections. It has neither a production-new-prompt arm
nor independent acceptable/loss grades for every family in both required arms.

## Turn two, checks and independent acceptance

The historical `fact`/`claims`/`edits` format is not the production
`fact_id`/`removed`/`added` envelope. `adaptLegacyDecision` is diagnostic-only:
legacy merge/update of one target becomes a single-source edit, with a fixed
snapshot revision, exact production clause matching, and verbatim citations.
Unsupported shapes are refused, not silently repaired. Retire and promote are
always forbidden. The adapter makes no pending proposal or database operation.

`replayRecordedChecks` calls the production planner and isolated check runner.
A check record is usable only if its complete request hash, exact request,
output hash, operand identities and reported profile match. Missing, duplicate,
changed or unrelated records fail closed. A fixture's passing records cannot
establish validation for a real provider. The legacy narrow calls have different
systems and verdict formats, so none are reused as current check verdicts.

`replayBarFailures` binds independent v6 grades to the observed decision keys and
input/output bytes. It rejects wrong or ambiguous accepted changes, lost valid
claims, unsupported changes, blends, known-fact duplicates, invented dates,
retirement/promotion, missing controls, loss of `64 KiB` or `>512 KiB` on memory
#23094 (case 35, fact 3, abbreviated 35:3), and failure to repair the outdated
fourth clause (c4) in the target of case 2, fact 4. The accepted edit must change
that target clause; a separate `new` decision is not a repair.
The grade's reason is required, and grades cannot substitute another output.
Actual apply receipts and independently reviewed full records are prerequisites
for using this API to grade a future replay; this instrument emits none.

No profile can be validated from this offline diagnostic. A fresh production
prompt replay, full reported inference tuples, language-specific historian and
per-kind check hashes, provider-enforced-schema negative probes, complete
independent omissions/v6 grades, zero wrong accepted edits, no invented dates,
intact paging bounds, no blending of disagreeing claims for case 12, fact 10,
and the fourth-clause repair remain necessary before
any separate enablement change. Automated authorized writes belong to the
production applier with undo history and natural rebuild visibility, not to this
harness or a pending-proposal mechanism.
