# Independent review: memory without pending proposals

## Scope and verdict

Reviewed `3549c4340e..c7f52c21d4472d296d8e189a25298f21e17ae121`, the 31-file direct-application change on `alfonso/task/bg_73cbfea4339ac582-memory-remove-proposal-routing-curate-and-verify`.

**Cache and authority checks passed for the exercised paths. No active proposal producer remains in the searched source tree. This is not an unconditional approval of every claim in the brief:**

1. **The merge token guarantee is weaker than stated.** A merge can omit a source identifier and number from its final canonical text if the cited evidence repeats those tokens. A new executable counterexample confirms that `retry_limit` and `17` disappear after a green merge. If the ruling means *all* merges must preserve source identifiers/numbers in their resulting memory, this needs a follow-up correction or an explicit policy decision. The behavior is inherited from the gate rather than introduced by the proposal-removal diff.
2. **The RPC response parser is not a validated receipt.** Current module refusals are correctly rejected, but unflagged refusal-shaped text beginning with a success prefix is classified as applied. A typed, operation-specific response is safer.
3. **Undo history exists; dashboard undo is not proven.** Prior text and row-state snapshots are recorded, including merge sources and archives. There is no checked-in dashboard memory-history undo consumer to exercise, and the snapshot formats are not uniform. Do not describe this verification as an end-to-end dashboard undo test.

This delivery changes only this report and environment-gated test witnesses/registrations. No production behavior, architecture documents, schema, package manifests, or live stores were changed. Tests used temporary stores. Verification ran on `linux,4c`; no Rust workspace build/test ran on the Mac. File formatting was local editing only. A formatting/lint job was later refused before execution because the still-running workspace test job held this worktree's owner slot; that command was not treated as a failed check and was not retried locally.

## 1. Cache safety first

### Differential construction

`packages/plugin/src/shared/memory-no-proposals-review.test.ts` registers the same independent witness against the real OpenCode and Pi projection drivers. For each of four fixed seeds (`941aac21`, `287cf89b`, `b41c137e`, `1799fdd3`), two initially identical temporary stores undergo 80 interleaved passes:

- the actual store applies automated edits immediately;
- the delayed store receives those exact automated operations only immediately before the next natural HARD;
- both receive the same agent updates, including edits by the rendering session and another session;
- every served `{m0,m1,materialized}` pair must be byte-identical across the stores;
- defer must replay the previous pair; SOFT must retain the previous m[0]; only provider-cache expiry authorizes a HARD;
- each automated operation must leave mutation-log and agent-fragment counts unchanged.

The randomized TypeScript/Pi sequences include curate update, merge and archive; verify archive through `applyVerifyManifest`; and historian edits through `applyHistorianRevision`, with the real deterministic gates/check ledger and explicit green check fixtures. Each host ran **320 passes**, with operation counts **147 curate updates, 161 historian edits, 4 curate archives, 4 merges, 4 verify archives**. The two stores share production mutation/rendering code, but not the timing of automated writes: a SOFT/defer leak changes only the actual store's output and fails the comparison. Agent edits use a dedicated row; overlapping same-row edits are additionally exercised by the existing Rust randomized composer differential below.

Rust's `noprop_randomized_automated_vs_delayed_served_bytes` uses the same delayed-write construction with real facade transactions and automatic verify/archive/update/merge operations. It compares the complete serialized CK message arrays, not just a memory-count proxy: **320 passes: 93 defer (`SOFT+`), 120 SOFT, 107 natural HARD**. A render-config change is its natural HARD trigger. Every automated operation leaves agent-fragment counts unchanged; merge and archive source history is checked.

The author's deterministic witnesses separately cover all six paths (curate update/merge/archive, verify update/archive, expiry archive) on OpenCode, Pi and Rust. They check the canonical edit and undo history, zero automated fragment/log/proposal rows, identical served bytes on defer and SOFT, and incorporation/removal on a natural HARD. The TypeScript/Pi loader gate also forbids `memories`/`memory_mutation_log` reads on SOFT/defer and proves that it catches a HARD read (`packages/plugin/src/shared/memory-projection-fixtures.test.ts:45-99,317-494`). Rust covers the analogous read fences in `crates/mc-module/src/transform.rs:35180-35236`.

**Rust turn-two qualification:** the shared TypeScript historian declines module-owned projects as `authority_elsewhere` (`lifecycle-applier.ts:754-765`; the corresponding turn-two pre-send test passed). Native Rust turn-two application is not implemented by this change. Thus the Rust differential tests the automated-write visibility contract, not a nonexistent native historian turn-two RPC. It would be misleading to claim that a Rust turn-two merge was applied end-to-end here.

### Agent fragments compared with the base revision

The new baseline witnesses measure served m[1], not the tool's status sentence. An independent `git archive 3549c4340e` was unpacked under the Linux job's private temporary directory; only the witness and its test-driver registration were copied in. It reused the installed dependencies without changing any manifest/lockfile. No production source from the new revision was substituted into the baseline.

| Host | Sequence | SHA-256 of served m[1] sequence at **both** revisions |
| --- | --- | --- |
| OpenCode TypeScript | agent save, update, merge, archive through the shared applier and actual host renderer | `109feba9b464b0247ace2cdde6ab2f9b811e1a0de4088670b7088c656d2742d6` |
| Pi | same agent operations and Pi renderer | `109feba9b464b0247ace2cdde6ab2f9b811e1a0de4088670b7088c656d2742d6` |
| Rust | 24 facade agent updates, each followed by SOFT | `31d496e40cc01df9e0d9c19052511472d06b968d9ea41a180362659e988ccae9` |

The hashes are now pinned as literal expectations in the gated witnesses. Existing primary-agent tool tests also passed for OpenCode and Pi; the hash test intentionally isolates fragment construction/rendering from tool-result wording. Rust's hash sequence covers updates, not every facade operation. The existing Rust randomized composer witness supplies the broader overlapping-edit/budget/restart coverage; its verification result is recorded below.

## 2. Authority and `memory.curate`

- `module-tool-backends.ts:20-63` sends `memory.curate` with the target revision list; module dispatch reaches `handle_ctx_memory_facade(..., true)` (`crates/mc-module/src/lib.rs:12966-12971`). Only update/archive/merge are allowed. The handler validates that `expected_revisions` names the action's target IDs in the same order (`lib.rs:13470-13495`).
- A configured backend's rejection is propagated, not caught and retried as a TypeScript mutation. A missing backend in module-authority mode is also refused. The TypeScript fallback is permitted only when it owns the request project **and every target's stored project**, and the transaction rechecks target ownership (`tools/ctx-memory/tools.ts:258-276`; `memory/lifecycle-applier.ts:517-535`). The new mixed-project witness exercises failed-module, missing-module and mixed-TS-ownership requests and proves that the rows and history remain unchanged.
- Rust checks revisions inside the same facade write transaction, before update/archive/merge (`lib.rs:13684-13692,13739-13747,13809-13815`; `mc-store/src/lib.rs:6750-6763`). The new RPC-level witness supplies stale revisions to **each** action; all return `isError:true`, mention `stale_revision`, and produce no canonical mutation/history/fragment/proposal. It also refuses a merge with an unowned foreign project, without changing either source. Replaying a successful command is intentionally idempotent: its stored receipt is returned instead of reapplying CAS.
- Actual module/store failures become error-tagged tool results (`lib.rs:18696-18710,16839-16841`). The adapter checks `isError` before parsing success text, so a flagged refusal is not misread even if its text starts with `Archived memory`. Existing direct/wrapped receipt and refusal tests passed.

**Parser hardening:** the adapter only recognizes `^(Updated memory|Archived memor|Merged memories)` and extracts IDs by regex. The gated counterexample supplies `{isError:false, content:[{text:"Archived memory IDs []: refusal (stale_revision)."}]}`: it returns `{state:"applied",memoryId:7}`. This is not an observed response produced by the current Rust error formatter; it demonstrates that text alone cannot establish success. The parser also does not require the returned action to match the request, and an empty `superseded []` cannot distinguish a valid no-source result from a malformed merge receipt. A typed schema such as `{state,action,canonical_id,superseded_ids,reason}` with validated required fields would be safer; merge already supplies structured metadata on the Rust side (`lib.rs:13852-13860`). The valid no-op archive text `No active memories needed archiving.` also falls outside the success-prefix regex (`lib.rs:13755-13759`), another reason not to use prose as a receipt. Preserve refusal propagation and prohibit fallback when adopting such a schema.

## 3. Undo history

The tested automated edits retain the preceding text and status:

- TypeScript curate snapshots the SQL rows before any source CAS, mutates them atomically, and writes one history row per source. Archives include successor changes in post-state snapshots; merges preserve histories for both sources (`lifecycle-applier.ts:557-677`).
- Verify updates/archives and expiry archives call `recordAutomatedMemoryEdit`, which records prior text and the prior `Memory` object and advances revision in the caller's transaction (`lifecycle-applier.ts:324-358`; `dreamer/verify.ts:739-767`).
- Historian gated revisions write source history before changing the canonical rows (`lifecycle-applier.ts:878-968`). Existing green-edit, CAS-loss, and refused-merge tests cover successful history and the absence of history on refused decisions.
- Rust records source snapshots through `record_agent_history` even for automated facade transactions (`mc-store/src/memory_projection.rs:41-78`). Update/archive/merge source paths call it; verify and expiry have automated-history helpers. All six deterministic module visibility/history witnesses passed.

**Not verified as dashboard undo:** searches for `memory_history`, `before_json`, and memory undo in the dashboard found no consumer. The native Edit menu's `undo()` is unrelated (`packages/dashboard/src-tauri/src/main.rs:139-146`). TypeScript curate uses snake-case SQL snapshots; TypeScript verify/expiry uses camel-case `Memory` snapshots; Rust serializes snake-case `StoredMemoryFull` and stores revision separately. Restoring a source row must also reconcile successor links and any newly created merge canonical row. Rust curate archive attaches its successor **after** archive history is written, with no separate link-table history (`mc-store/src/lib.rs:6765-6788`; `mc-module/src/lib.rs:13745-13753`). These are integration requirements/gaps for an undo consumer, not proof that it currently restores a complete merge transaction.

## 4. Turn two and token preservation

The prompt advertises only `new, covered, conflict, edit, merge, replaces, abstain` (`turn-two-envelope.ts:320-325`). The parser still recognizes obsolete `retire` and `promote_rule` replies with their required target, so they can be dropped deterministically rather than treated as retryable envelope failures (`turn-two-envelope.ts:14-27,135-148`). Resolution logs them and finishes their facts as `decided_pending` with `retire_dropped` / `promote_rule_dropped`, with zero proposal rows and unchanged memory/history (`turn-two.ts:665-676`). Missing required targets remain malformed decisions. Existing OpenCode and Pi witnesses passed; the decided state prevents another provider retry of those obsolete replies.

The author's test `a merge that loses a source identifier or number is refused before any check or write` passed: final text and evidence both omit `retry_limit` / `17`, producing `dropped_token` before checks or writes.

**Counterexample to the stronger guarantee:** the new gated test `noprop merge may drop source tokens when the evidence repeats them` uses the same source but cites `retry_limit was 17; now use bounded retries.` and proposes `Keep rule. Use bounded retries.`. With the existing green check carrier, the fact is **applied**, the source is merged, and neither token remains in the canonical text. The deterministic condition is `!finalTokens.includes(token) && !evidenceTokens.includes(token)` (`lifecycle-gates.ts:206-220`). Evidence mentioning a removed identifier/value is therefore sufficient to bypass `dropped_token`. This can be a deliberate supported replacement policy, but it is not an unconditional knowledge-preserving merge invariant. The report-only witness records the actual behavior; it does not silently rewrite the old test or weaken production code.

## 5. Proposal-table inventory

A whole-source-tree search for `memory_tool_proposals`, `memory_proposals`, and `proposal_key`, including dashboard/CLI source, found no active, path-specific producer or runtime inbox reader. Remaining references are:

- the shipped v99 table definition and Rust context-db schema fixture;
- migration schema/inventory tests;
- regression/e2e tests that query it and expect an empty result (including `curate-proposal-result.test.ts` and the OpenCode 2 curate test);
- `mc-store/src/move_inventory.rs:2585-2607,3892-3910`, which classifies it as a context **NotSession** table with no row selector;
- historical reports and review probes describing prior proposal behavior.

No dashboard or CLI proposal inbox implementation was found. Generic backup/restore/database-copy machinery can preserve historical rows; this is distinct from producing a pending proposal as a result of a new automated edit. The schema was deliberately retained rather than migrating/deleting old data. An upgraded store can consequently contain historical proposal rows, but no reviewed producer processes them into this release's mutation flow.

The remaining test readers already tolerate and assert empty tables. Any external consumer must tolerate an empty table and must not wait for a proposal to approve. There is no checked-in runtime reader that needs a new empty-table fallback. The source census excludes dependency trees and ignored build outputs; old prose such as `docs/reports/catchup-curate-proposals.md` is historical, not executable advertising.

## 6. Four applied mutation controls

The author's commit message identifies TypeScript and Rust verify-archive proposal-reroute controls, but does not preserve their original mutation patches/output. I reconstructed and reran those two mechanisms against the author's actual archive witnesses, then added two independent controls. Each mutation was applied to the production path, not to an assertion or an expected value.

For every control: stage the live files; prove `git diff --stat` empty; mutate; capture the nonempty stat; execute the check; restore with `git checkout -- <path> && touch <path>`; prove `git diff --stat` empty again. All four mutated runs failed exactly the named intended test, with the listed sibling controls remaining green. No mutation remains in the delivery.

| Control | Production mutation | Exact red test (and observed failure) | Green siblings | Nonempty stat during mutation; empty after restore |
| --- | --- | --- | --- | --- |
| Author TS reroute | Replace verify's direct archive/history block with a real `memory_tool_proposals` insert; retain the accepted/archive count | `OpenCode verify-archive applies directly with undo history and waits for natural HARD`: expected history length 1, received 0 | `OpenCode verify-update applies directly with undo history and waits for natural HARD` | `packages/plugin/src/features/magic-context/dreamer/verify.ts`: 1 file, +4/-6; then empty |
| Author Rust reroute | Replace verification archive/update-history with a real proposal insert, leaving the row active | `transform::tests::memory_cache_review::module_verify_archive_applies_with_history_and_waits_for_hard`: left `active`, right `archived` | `transform::tests::memory_cache_review::module_verify_update_applies_with_history_and_waits_for_hard` | `crates/mc-store/src/lib.rs`: 1 file, +3/-17; then empty |
| Independent CAS bypass | Disable the stale-revision comparison in `check_memory_revisions` | `tests::noprop_curate_stale_cas_refuses_each_action_and_changes_nothing`: update returned `isError:false` / `Updated memory [ID: 1]`, expected refusal | `transform::tests::memory_cache_review::noprop_randomized_automated_vs_delayed_served_bytes`; `transform::tests::memory_cache_review::noprop_agent_m1_fingerprint_matches_baseline` | `crates/mc-store/src/lib.rs`: 1 file, +2/-1; then empty |
| Independent fragment leak | Remove the `!automated` guard from agent-fragment publication, without changing the tests | `OpenCode noprop randomized automated-versus-delayed differential`: agent-fragment count changed from 0 to 1 | `OpenCode noprop baseline agent fragment fingerprint`; `noprop authority rejects module failure and mixed TS ownership without fallback`; `noprop response parser refuses flagged prefix-shaped failures but is not a typed receipt` | `packages/plugin/src/features/magic-context/memory/lifecycle-applier.ts`: 1 file, +2/-1; then empty |

Commands used for the red runs (all `linux,4c`):

```sh
BUN_JSC_useOMGJIT=0 bun test --timeout 30000 \
  --test-name-pattern 'OpenCode verify-(archive|update) applies' \
  packages/plugin/src/hooks/magic-context/memory-projection.test.ts
cargo test -p mc-module --lib module_verify_ -- --nocapture
MC_NOPROP_REVIEW=1 cargo test -p mc-module --lib noprop -- --nocapture
MC_NOPROP_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test --timeout 30000 \
  --test-name-pattern noprop \
  packages/plugin/src/hooks/magic-context/memory-projection.test.ts \
  packages/plugin/src/hooks/magic-context/memory-no-proposals-authority-review.test.ts
```

## Verification and reproduction

Versions: **Bun 1.4.2 (`744846f84`), TypeScript 5.9.3, Biome 2.5.1, rustc 1.99.0 (`b940084d7`, 2026-09-28), cargo 1.99.0 (`5f94df478`, 2026-08-27), rustfmt 1.10.0-stable**. Typechecks are intentionally silent on success apart from the package scripts; the exact tool version was printed.

- `bun run --cwd packages/plugin typecheck` and `bun run --cwd packages/pi-plugin typecheck`: **passed**, including the new witnesses.
- Final targeted Bun review suite: **274 passed, 0 failed, 7,392 assertions, 12 files**, with `MC_NOPROP_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test --timeout 30000`. Files: OpenCode/Pi projection tests; the new authority witness; module-tool-backends; turn-two and Pi dropped-action tests; lifecycle-applier and lifecycle-agent-mutations; verify and curate-proposal-result; OpenCode/Pi ctx-memory tool tests.
- Baseline fragment comparisons: **2 Bun tests passed** on archived `3549c4340e`; **1 Rust fingerprint test passed at each revision**. Identical hashes are recorded above and asserted by the final witnesses.
- Initial independent gated subset: **6 Bun tests passed**, then **2 Rust tests passed** (randomized cache differential and stale CAS) before the Rust fingerprint was added. The final full/targeted Rust checks below supersede those early runs.
- `cargo test -p mc-store --lib -- --nocapture`: **333 passed, 0 failed, 5 ignored**. The printed inventory-dependency and simulated-crash panic messages were expected negative tests, not suite failures.
- Broad `MC_NOPROP_REVIEW=1 cargo test --workspace -- --nocapture`: core **22 passed**; module **1,935 passed, 1 failed, 27 ignored** (about 28 minutes). The sole failure was my new mixed-ownership fixture, not a production regression: the migrated temporary store owned every project until an ownership marker was added. The fixture was corrected to mark only the intended project before the foreign-source refusal. The failed/impacted tests were rerun narrowly rather than repeating the expensive workspace suite. Later workspace targets were not reached in that run.
- Final restored `MC_NOPROP_REVIEW=1 cargo test -p mc-module --lib noprop -- --nocapture`: **3 passed** (corrected stale CAS/mixed authority, randomized served bytes, baseline fingerprint).
- `cargo test -p mc-module --lib memory_cache_review::module_ -- --nocapture`: **6 passed**, including the restored author's verify-archive control. `cargo test -p mc-module --lib module_curate_facade -- --nocapture`: **1 passed**.
- Explicit `cargo test -p mc-module --lib review_randomized_served_sequences_match_ts_composer -- --ignored --nocapture`: **1 passed**, **640 served steps**, action counts `[93,104,85,88,100,79,91]` for defer/SOFT/flush/restart/CAS-loss/HARD/model-switch; **289 exact TS/Pi SOFT comparisons**. This exercises same-row agent/automated overlap and budget variation beyond the new delayed-store differential.
- `cargo test -p mc-module --test real_daemon -- --nocapture`: the **four known missing-sibling failures**, **1 passed, 2 ignored**. All four panic at `real_daemon.rs:1110` resolving the missing sibling subconscious source checkout, before testing the reviewed behavior: `daemon_artifacts_are_built_and_copied_once`, `hostless_store_init_first_transform_through_real_daemon`, `mc_pipe_only_supervision_through_real_daemon`, `mc_transform_spine_through_real_daemon`. A validated `MC_TEST_LOCKED_SUBC_SOURCE` or the expected pinned sibling checkout is needed to run them; neither was fabricated for this review.
- Final pinned Biome checks: **4 OpenCode witness files + 1 Pi file passed**, no fixes applied. `cargo fmt --all --check` and standalone `rustfmt --edition 2021 --check crates/mc-module/src/transform_memory_cache_review_tests.rs`: **passed**. The standalone check matters because that test source is included rather than discovered as an ordinary module file. An earlier import-order lint failure was fixed; the queue-refused formatting/lint attempt did not execute and was rerun successfully on Linux after the workspace owner slot was released.
- Fresh scoped inspection reported **0 TypeScript diagnostics**; broader structural categories were unavailable while the checkout call graph rebuilt. Package typechecks above are the authoritative gates.
- Build/e2e: the prepared worktree's `bun run build` passed before review. No packaging/production source was changed, so it was not rebuilt; no live-host OpenCode 2/daemon e2e assertion is claimed.

The independent witnesses are disabled unless `MC_NOPROP_REVIEW=1`. In Rust, disabled tests return immediately; in Bun they are not registered. To run only the new witnesses:

```sh
MC_NOPROP_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test --timeout 30000 \
  --test-name-pattern noprop \
  packages/plugin/src/hooks/magic-context/memory-projection.test.ts \
  packages/pi-plugin/src/memory-projection-pi.test.ts \
  packages/plugin/src/hooks/magic-context/memory-no-proposals-authority-review.test.ts \
  packages/plugin/src/features/magic-context/memory/turn-two.test.ts
MC_NOPROP_REVIEW=1 cargo test -p mc-module --lib noprop -- --nocapture
```

Run these on Linux. The baseline comparison used `git archive` and private temporary stores; it does not require or access any live memory database. The report preserves the evidence rather than relying on logs inside a regenerable `target/` directory.
