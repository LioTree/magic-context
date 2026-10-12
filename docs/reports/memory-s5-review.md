# Independent review: memory slice S5, historian turn one

## Scope and conclusion

Reviewed `291c2b75..49012cfa` on `train/agent-move`: `7b436099c9` (publication record, anchored
candidates, activity ledger, Rust anchor parser and resolver), `a00d0f2777` (comments and the
reply-binding test), `49012cfaba` (the served-pair regression and the cross-commit probe). The two
"Preserve uncommitted changes" commits in the range (`f598331a7e`, `b1a13bbe80`) are empty. The
contract is the one in [the S3 design](../designs/memory-s3-projection.md),
[the Rust projection note](../../crates/mc-module/MEMORY-PROJECTION.md) and
[the lifecycle design](../designs/memory-lifecycle.md) §4: automated memory writes reach a prompt only
at the next natural HARD fold, never on a SOFT pass or a defer.

**No cache-safety violation was found.** Across 144 randomized cross-commit scenarios
(OpenCode 1, OpenCode 2 and Pi; memory owned by TypeScript or by the Rust module; dormant and
test-enabled lanes) no turn-one row changed a served request, and no promoted fact was served before a
fold. The commit order was unique and contiguous in every run and in a two-process stress test. No
anchor bound to a compartment that does not contain the lines it cites.

Three things are wrong or weaker than claimed:

1. On the test-enabled lane, a reply that ends in discard-last records duplicate candidates (P2).
2. The production dormant lane is not byte-identical to `291c2b75` when the historian prefixes a fact
   with an anchor (P3).
3. The worker's served-pair regression has a guard that can never fail (P3, test quality).

The remaining findings are P3 or informational.

This delivery adds tests, two seeded generators, one probe and this report. No product source,
migration, manifest, lockfile, `ARCHITECTURE.md` or `STRUCTURE.md` is changed.

## Findings by severity

### P2: the enabled lane duplicates candidates when discard-last drops the tail compartment

When a reply consumes the whole chunk, discard-last drops its last compartment so that the next run
can re-derive it (`compartment-runner-incremental.ts:876-889`). On an `enabled` lane, every fact is
still recorded (`candidateFacts = facts`, `:1129-1136`). A fact whose anchor names the dropped
compartment fails resolution, so it is stored as an unknown-anchor candidate. The next run re-derives
that compartment and the historian emits the same fact again, this time anchored and bound, so it is
stored twice. The Rust validator does the opposite and drops every side channel when `discarded_last`
is set, because keeping them "would make a later re-read double-store it"
(`historian_validate.rs:721-724`, `keep_side_channel`). The forced final keep also differs: Rust drops
all facts under `force_keep_last_compartment`, while the TypeScript enabled lane binds facts to the weak
final compartment.

- Witness, red today: `compartment-runner-turn-one-review.test.ts` › *review witness: a fact anchored
  to the discarded tail compartment is recorded once, not again when the tail is re-derived*. It
  expects 1 row and receives 2.
- Exposure: the enabled lane only. Every production lane is `dormant` (`resolveTurnOneLane`). The
  dormant lane skips promotion and candidates on discard-last (`skipUnanchoredPromotion`).
- Suggested direction: drop a fact whose anchor index names a compartment past the persisted ones,
  since that compartment will be re-derived. Decide explicitly how unanchored facts in a discard-last
  reply are handled, and align the forced-final-keep policy with Rust.

### P3: the dormant lane changes promoted text when a fact carries an anchor prefix

`parseCompartmentOutput` now strips `[at_compartment=…]` and `(origin_compartment=…)` prefixes from
every fact bullet on every lane (`compartment-parser.ts:454-458`). At `291c2b75`, the TypeScript dormant
lane promoted such a bullet verbatim, so the memory row, the next HARD m[0] and later historian prompts
(through `<project-memory>`) now differ. The Rust regex was widened in the same commit, which changes
the production Rust historian as well:

- `[at_compartment=unknown] X` was kept verbatim and is now stored as `X`.
- `[at_compartment=N messages=A-B] X` previously did not match, so the fact was kept verbatim. Now the
  prefix is parsed, and if N is past the persisted compartments, `keep_side_channel` drops the fact.

The worker's dormant test asserts the stripped text, so the stripping is deliberate. It is not
disclosed as an exception to "dormant = today's prompt plus promotion", and the worker's cross-commit
probe used only unprefixed facts, so it could not see the change.

- Evidence: in the randomized differential (below), all 24 `ts/dormant/prefixed` scenarios differ from
  `291c2b75`, accounting for all 165 differing serving passes. Their historian prompts differ after the
  first prefixed promotion. All 24 `ts/dormant/plain` scenarios are byte-identical, and so are the
  `module/dormant/prefixed` scenarios, where nothing is promoted.
- Cache safety is intact: a changed memory text still surfaces only at a HARD fold.
- Suggested direction: either record this as an intended deviation (stripping is arguably a fix,
  because a prefix is not memory text), or keep the dormant parser verbatim until the lane is enabled.

### P3: TypeScript and Rust classify adversarial anchors differently

The worker's goldens cover well-formed lines. A seeded adversarial corpus
(`crates/mc-module/gen/gen-turn-one-anchor-fuzz.ts` → `testdata/turn-one-anchor-fuzz.json`: 500 bullets
and 100 whole outputs) was replayed through both implementations:

| Class | TypeScript | Rust |
| --- | --- | --- |
| U+FEFF inside the prefix | `\s` matches; the anchor parses | `\s` does not match; the prefix stays in the text |
| U+0085 inside the prefix or at the end of the text | no match; prefix kept; NEL kept by `trim` | matches; NEL trimmed |
| `\r` in the text after the prefix | `.` stops at `\r`; no match; prefix kept | matches |
| U+2028 in a bullet | the bullet regex ends the item at U+2028, so the text is truncated (pre-existing) | full text kept |
| integer past 2^53 in the index or range | no index or no range (`Number.isSafeInteger`) | `u64` kept |
| index past the persisted compartments | fact kept (dormant: promoted; enabled: unknown candidate) | fact dropped (`keep_side_channel`) |

Results: 2 of 500 bullets resolve differently (U+FEFF inside `at_compartment`, and `\r` in the text).
In neither case does an anchor bind to the wrong compartment; the two sides disagree on whether to bind
at all. 61 of 500 bullets parse to different text, index or range, and some whole documents differ too.
On the 486 portable cases (420 bullets and 66 documents, 16 of them with CRLF line endings; none of the
characters above, no lone `\r`, no integer longer than 15 digits), parity is exact.

- Permanent test: `historian_validate::tests::turn_one_anchor_fuzz_matches_typescript_on_portable_input`.
- Witness, ignored: `review_witness_turn_one_anchor_fuzz_matches_typescript_on_all_input`.
- The TypeScript test *the committed corpus is what the TypeScript parser and resolver produce today*
  keeps the corpus honest.

### P3: superseded turn-one sends stay `dispatched` forever

Each historian run that does not publish leaves its `memory_stage_attempts` row in `dispatched`. When
a later attempt commits the publication, only that attempt becomes `published`; the earlier rows are
never closed. One row is added per failed run, and the rows are bounded only by session deletion. They
block nothing today: reuse requires `commit_order IS NULL`. However, the design expects that "unknown
accepted/queued outcomes are reattached or withdrawn before redispatch", and a later recovery step
would read these rows as in-flight.

- Witness, red today: `turn-one-publication-review.test.ts` › *review witness: a send superseded by a
  later published attempt does not stay dispatched*. After 5 failed attempts and 1 commit, 5 rows remain
  `dispatched`.

### P3: deleting a session orphans its uncommitted publication

`memory_stage_attempts` is session-scoped and deleted with the session. `memory_publications` is
project-owned and is not. An uncommitted publication therefore loses the stage row that the reuse query
requires (`allocateTurnOneSend`'s `EXISTS`), so it is never reused or committed. There is at most one
per (session, harness), so the growth is bounded.

- Witness, red today: `turn-one-publication-review.test.ts` › *review witness: a session's deletion
  leaves no uncommitted publication behind*. It expects 0 and receives 1.

### P3: a guard in the worker's served-pair regression can never fail

In `memory-projection-fixtures.test.ts` (*turn-one publication rows never change a served pair…*), the
check `expect(text).not.toContain("must not render")` reads `served[0]`. That is the **plain** store,
which never receives turn-one rows, so the check cannot fail. Only two things defend the property: the
byte equality `expect(served[1]).toEqual(served[0])`, and the post-publish `genuine-hard` step that
makes a leaked row visible.

- With a memory-row leak mutant (M1), the test is red on both hosts.
- With M1 plus the equality removed (M2), it is green on both hosts.
- With M1 plus the `genuine-hard` step replaced by a defer (M3), it is green on both hosts.

This matches the worker's report that its control 2 was undefended until a fixture changed: SOFT and
defer passes read no memory rows by design, so only a fold can expose a leak. **The `must not render`
guard is redundant, and vacuous as written.** It would become meaningful only if applied to `served[1]`,
and even then it would duplicate the equality check. The `reads` watch is live (M4 turns it red on both
hosts) but wraps only `db.prepare`.

### P3: two properties were undefended by S5's own tests

- **TypeScript fact-anchor remap.** Removing the remap for facts in `parseCompartmentOutput` (M6)
  turned none of the S5 TypeScript tests red. The only S5 coverage is the Rust parse golden, which the
  TypeScript generator would re-encode. It is now defended by *binds anchors of out-of-order
  compartments by range…* and by the corpus test.
- **Harness isolation of publication reuse.** Removing `AND s.harness=?` from the reuse query (M7)
  turned no S5 test red, nor the two-process smoke test in 3 runs. If one process committed a
  publication allocated by the other, the other's commit would throw and roll back a whole publish. It
  is now defended by *an uncommitted publication is reused only by the same session and harness*.

### Informational

- **New write before dispatch.** Every production historian run now writes `allocateTurnOneSend` in a
  `BEGIN IMMEDIATE` transaction before dispatch. A store that stays busy past the timeout now fails the
  run before the model is called, where `291c2b75` would have dispatched. This is not tested.
- **What `replyStartMessage` holds.** It is the persisted compartment's range after validation (gap
  healing, terminal snap), not the reply's raw range, so the `bound` guard compares a row with the
  in-memory compartment it was appended from. It only catches row misalignment. Anchors are resolved
  against the healed ranges, so a fact citing lines that gap healing gave to compartment N binds to N.
  That is consistent with the cited index, but the field comment overstates the guard.
- **No Rust publication record.** The Rust historian publication (module transform) records no
  publication or activity rows. S5's publication record is TypeScript-only.
- **Session moves.** The move inventory ships `memory_stage_attempts` with a moved session but keeps
  `memory_publications` and the ledger project-side. The destination's reuse query requires the
  publication row, so it allocates a new publication. This is benign.
- **HARD coverage in the probe.** The cache-expiry HARD in the probe did not always materialize (both
  trees agreed). Promotions were actually served in 4 of 8 seeds (16 tokens per host, all after a
  fold).

## 1. Byte identity: randomized cross-commit differential

`packages/plugin/src/hooks/magic-context/turn-one-random-differential.probe.ts` is new and shares no
code with the worker's probe. For each seed it builds a 39-step script that mixes:

- test-forced HARD folds and cache-expiry HARD folds;
- busting SOFT passes, defer passes and `/ctx-flush` (`executeFlush` followed by a busting pass);
- new user turns;
- historian publishes through the production runners: OpenCode 1 host session, OpenCode 2 hidden
  completion executor (harness `opencode2`), and the Pi subagent;
- historian runs with an unusable reply;
- real restarts. The script is split at each `restart` into separate child processes that share the
  on-disk stores.

The historian reply is generated from the prompt it receives. It has one to three compartments cut at
printed-line ends, either consumes the whole chunk (so discard-last applies) or stops early with
`<unprocessed_from>`, and carries zero to three facts with unique tokens. In `prefixed` mode the facts
carry well-formed, `unknown`, out-of-range, index-only, reversed, zero and `origin_compartment`
anchors.

Each serving pass compares the **whole served message array** (m[0], m[1] and the trimmed history),
plus whether the pass materialized. Each publish compares the SHA-256 of the historian prompt. Lanes:

- `dormant`: both trees run with the same dependencies.
- `enabled`: the current tree runs with `memoryLifecycleLane: "enabled"`, compared against
  `291c2b75` with `autoPromote: false`.

Invariants checked on the current tree:

- a promoted token is served only from a materializing pass after its promotion;
- no fact reaches a memory row on the enabled lane or under module authority;
- a non-well-formed anchor never binds;
- a bound anchor's stored compartment contains the cited lines;
- the commit order is unique.

Results for seeds 1–8 × 3 hosts × 2 authorities × 3 lane/fact modes (144 scenarios, 1170 historian
dispatches, 3744 serving passes, 11 restarts per scenario type):

| Scenarios | Serving passes identical | Prompts identical | Violations |
| --- | --- | --- | --- |
| `*/ts/dormant/plain` (24) | all | all | 0; per host, 38 tokens promoted and 16 served, all after a fold |
| `*/module/dormant/*` (48) | all | all | 0; no memory row written |
| `*/*/enabled/prefixed` (48) | all | differ by design (no memory block, anchor instruction) | 0; per host and authority, 22 well-formed anchors bound to the containing compartment and 3 left unknown (all pointing at a discard-last tail); no malformed anchor bound |
| `*/ts/dormant/prefixed` (24) | 165 passes differ | differ after the first prefixed promotion | P3 above |

Every child process listed its open `.db` files (`/proc/self/fd`, Linux). All were under its throwaway
root `$TMPDIR/magic-context/s5-review/…`. No host binary (OpenCode or Pi) was launched; the production
runner and render code ran in bun child processes with `HOME`, `XDG_*`, `OPENCODE_DB`,
`MAGIC_CONTEXT_STORAGE_DIR` and `MAGIC_CONTEXT_TEST_DATA_DIR` pointed into that root. The live stores
were never opened.

## 2. Publication atomicity

- **Crash or retry between allocate, dispatch and commit.** The publication stays uncommitted and the
  session's next run reuses it with the next `run_attempt` (the worker's tests). A failure later in the
  compartment transaction rolls back the commit, the candidates and the ledger together. A retry then
  writes each fact once, still as `authority_elsewhere` under module authority, and writes no memory
  row. New test: *candidates commit and roll back with the publication…*.
- **Exactly once.** `UPDATE … WHERE commit_order IS NULL`, the `UNIQUE(commit_order)` constraint and the
  throw on `changes !== 1` hold. Two processes (`opencode` and `pi` harness) allocated and committed
  40 rounds each on one file database, with every third round "crashing" before commit. The commit
  orders were contiguous `1..54`, each committed publication had exactly one `published` send, and no
  publication spanned harnesses. In real use the two hosts cannot both publish compartments for one
  session id, because `compartments` is `UNIQUE(session_id, sequence)` across harnesses.
- **A run that publishes nothing** (invalid reply, no forward progress, lost lease, dangling boundary)
  leaves the publication uncommitted and reusable. Nothing blocks later runs. Superseded sends and
  orphans after deletion are the P3 findings above.

## 3. Anchor resolution

Resolution requires a published compartment index, containment in that compartment's range, and a
range that starts and ends on printed-line boundaries. Because stored compartments are disjoint, a bound
anchor's compartment is the only one that contains the cited lines. This held in every differential run
and in the new end-to-end test:

- compartments emitted out of order are remapped;
- a range outside the named compartment is unknown;
- a range across two compartments is unknown;
- a never-emitted index is unknown;
- only the cited lines are linked.

Discard-last leaves the dropped compartment's anchors unknown (no wrong binding, but see P2). A
truncated producer window keeps only blocks whose complete line precedes the cut, including when the
truncation marker's leading `\n[` matches the start of the next line. A source rewritten from its first
character keeps no block. TypeScript/Rust parity is exact on portable input; the adversarial classes
are the P3 above.

## 4. Candidates under module authority

They are written in the compartment transaction (`commitTurnOnePublication` inside the runner's
`BEGIN IMMEDIATE`). `tsOwnsMemory` is read inside that transaction. `INSERT OR IGNORE` on
`(publication_id, fact_index)` prevents duplicates when a publication commits after a rolled-back
attempt. No memory row is written: verified in the worker's tests, in the new rollback test, and in
every `module/*` differential scenario. Base `291c2b75` recorded `retryable/authority_elsewhere`
receipts through `applyMemoryAdmission` instead; that changes no served bytes.

## 5. Schema

S5 adds no migration. `git diff 291c2b75..49012cfa` touches no migration, `storage-db.ts`,
`mc-store` or schema file, and `LATEST_SUPPORTED_VERSION` is still 100. The tables S5 writes
(`memory_publications`, `memory_stage_attempts`, `memory_pending_facts`, `memory_fact_blocks`,
`memory_fact_block_links`, `memory_activity_ledger`) were created by v99
(`migration-v99-memory-lifecycle.ts`). `memory_stage_attempts` is the only session-owned one, and it is
in `SESSION_SCOPED_TABLES` with `harnessScoped: true`. The others are project-owned by design, asserted
by `migrations-v99.test.ts`. Note that S5 is the first production writer of the publication, stage and
ledger tables: every dormant run now adds rows to all three.

## 6. Tests and mutation controls

Each mutation was applied to a clean tracked file, confirmed with a non-empty `git diff --stat`, run on
Linux, and restored with `git checkout -- <path>`, after which `git diff --stat` was empty.

| Mutation | Tests that went red |
| --- | --- |
| M1: the publication commit inserts a memory row per candidate | OpenCode and Pi *turn-one publication rows never change a served pair…*; *records every fact as an authority_elsewhere candidate…*; *omits the memory block and binds…*; *commits candidates with the compartments as authority_elsewhere…*; *under module memory authority candidates are authority_elsewhere…* |
| M2: M1, plus the fixture's `served[1] == served[0]` removed | none on either host (the `must not render` guard is vacuous) |
| M3: M1, plus the fixture's `genuine-hard` step replaced by a defer | none on either host (undefended without a post-publish fold) |
| M4: `injectM0M1` and `injectM0M1Pi` read `memory_pending_facts` | OpenCode and Pi *turn-one publication rows never change a served pair…* (the `reads` watch) |
| M5: TypeScript range-containment check disabled | new *binds anchors of out-of-order compartments by range…*; new corpus test; goldens *range crossing a compartment boundary* and *range in another compartment* |
| M6: TypeScript fact-anchor remap removed | only the new out-of-order test and the new corpus test (no S5 test) |
| M7: harness filter removed from the reuse query | no S5 test, and not the two-process smoke test (3 runs); the new *an uncommitted publication is reused only by the same session and harness* |
| M8: Rust containment check disabled | `turn_one_anchor_goldens_match_the_typescript_publisher`, `turn_one_anchor_fuzz_matches_typescript_on_portable_input` |

### New tests

Passing, in the default suite:

- `compartment-runner-turn-one-review.test.ts`: *binds anchors of out-of-order compartments by range
  and never to a compartment that does not contain the cited lines*.
- `turn-one-publication-review.test.ts`:
  - *candidates commit and roll back with the publication; a later commit writes each fact once*;
  - *an uncommitted publication is reused only by the same session and harness*;
  - *OpenCode and Pi processes publishing on one session id keep commit order unique…*;
  - *only blocks whose complete line precedes the cut reach the historian*;
  - *the committed corpus is what the TypeScript parser and resolver produce today*.
- Rust: `turn_one_anchor_fuzz_matches_typescript_on_portable_input`.

### Failing tests (review witnesses)

The TypeScript witnesses run with `MC_REVIEW_WITNESSES=1`; the Rust witness runs with `--ignored`.

| Test | Red today because |
| --- | --- |
| `compartment-runner-turn-one-review.test.ts` › *review witness: a fact anchored to the discarded tail compartment is recorded once…* | 2 candidate rows (P2) |
| `turn-one-publication-review.test.ts` › *review witness: a send superseded by a later published attempt does not stay dispatched* | 5 `dispatched` rows (P3) |
| `turn-one-publication-review.test.ts` › *review witness: a session's deletion leaves no uncommitted publication behind* | 1 orphan (P3) |
| `historian_validate::tests::review_witness_turn_one_anchor_fuzz_matches_typescript_on_all_input` | bullet, resolution and document mismatches (P3 parity) |

## 7. Gates

Run on Linux (`ck-motor`, bun 1.4.2, cargo/clippy 1.99) after the final edits:

- plugin suite: 8,325 pass, 22 skip, 11 fail;
- Pi suite: 1,854 pass, 9 skip, 0 fail;
- `tsc` (5.9.3) for both packages: clean;
- biome for both packages: no errors;
- `cargo test -p mc-module`: library 1,921 pass, 0 fail, 28 ignored (one of the ignored is the new
  witness); every other test binary passes except `tests/real_daemon.rs`;
- `cargo clippy -p mc-module --all-targets -- -D warnings`: clean;
- `cargo fmt --check -p mc-module`: clean.

Two sets of failures are environmental and unrelated to S5:

- **Plugin, 11 failures.** They are in `auto-search-bundle-review.test.ts`,
  `transformers-node-wasm.test.ts` and `windows-hidden-spawns.test.ts`, which need `dist/` builds,
  packed packages and `onnxruntime-web` artifacts. The same three files fail 11 of 11 in a `291c2b75`
  tree on the same runner.
- **`tests/real_daemon.rs`, 4 failures.** These need a sibling `subconscious` checkout
  (`real_daemon.rs:1110`). S5 does not touch that file.
