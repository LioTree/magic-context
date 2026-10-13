# Resident provider: reader and write-site coverage

Status: inventory/proposed routing for review. **No baseline overlay, journal,
revision migration or serving consumer is installed.** Today's physical policy
rows remain authoritative. The new read-only capture is test-support-only and the
resident builder is test-only.

## Reader rule and closed policy census

The contract is exact served/acknowledgement/receipt bytes, tag identity
and state, and **every effective per-part measurement, policy decision and baseline
scalar through the store API** at every cut. Physical private measurement cells
may change representation. A production reader of unresolved physical cells would
violate this contract; export/import and diagnostics are not exemptions.

Searches of this worktree, including tests, with every result returned or paged:

- `mc_provider_policy_parts_v1|policy_baseline_updates` in `*.{rs,ts,sql}`:
  76 matches / 17 files before the new resident driver oracle was added. All rows
  were returned. The new resident driver's physical-row oracle is explicitly listed below.
- `\.all_parts\(|\.parts_for_mids\(|\.parts_with_tag|\.parts_with_arcs\(|\.previous_header\(`
  in `*.{rs,ts}`: 21 matches / 10 files, all returned.
- Dashboard scope: `store.db|mc_cache|mc_store|mc-store|hook_counters|policy_json|measurement|baseline`:
  26 matches / 5 files, all returned; its concrete store query was read.
- CLI scope, same pattern: 58 matches / 10 files, all returned; the concrete
  doctor store queries and generic move implementation were inspected.

These are closed literal/API searches, not proof that an arbitrary future dynamic
SQL string cannot read a table. The central export and raw-SQL routes below must
also be fenced when the overlay is introduced. Repeat the searches when the overlay is introduced.

| Reader / read-before-write | Current source | Required resolver treatment before overlay consumption |
| --- | --- | --- |
| PolicyIndex `effective`, `select`, `all_parts`, tag/range/arc/mid/header selectors | `mc-store/src/provider_log/policy_index.rs:38,115-218,301-410` | One shared resolver returns the complete effective part, including frozen measurement; predicates/index lookups must not silently use stale physical measurement values. |
| PolicyIndex `changes` | same file `232-299` | Resolve current values and **historical before-images at their own epoch/frontier**. Applying the current epoch to an old before-image gives wrong deltas. |
| Admission's existing part, burn/promotion/queue updates, baseline restatement | `mc-store/src/provider_log.rs:205-249,314,438-461,889,1290,1324,1469` | Read effective part before modifying it; write a point/flag update against the resolved epoch. Never overwrite an overlay by copying stale physical JSON. |
| Channel-1 inputs, bounded summary/replay and preparation | `mc-module/src/providers/{step_transform.rs:869,911-919,policy_summary.rs:300-421,737-1230,policy_summary_preparation.rs:41-259}` | Receive resolved facts through PolicyIndex. Keep original baseline/newest admission timing. |
| Cache codec / full engine baseline | `mc-store/src/cache_codec`, `mc-module/src/tail_hygiene.rs` | These read the engine's own baseline/sections, not merely provider totals. Inventory and preserve that distinct representation; full-array Rust (mode 2) remains algorithmically unchanged. A full-array engine write invalidates provider overlay/checkpoint generations in its transaction. |
| `move_inventory` / `move_snapshot` / `move_store` | `move_inventory.rs:2891-2912`; `move_snapshot.rs:195-251`; `move_store.rs:157,918-1048` | **Confirmed raw reader:** generic shipped-column SELECT exports `policy_json`. Add an effective-policy row selector backed by the resolver, or ship authoritative epochs/overrides and resolve before exposure. Import and destination comparison must use the same logical contract, not discard authoritative overlay rows as cache. |
| Dashboard store access | `packages/dashboard/src-tauri/src/db.rs:3743-3815` | Its module-store query joins only `mc_cache_state` to identify managed sessions. It does not read provider measurements. Preserve this limited projection; a future policy panel must call the resolver. |
| Doctor single-store | `packages/cli/src/commands/doctor-single-store.ts:138-227` | Reads schema/migration/privilege markers, not measurements. Repair/backup copying a database is addressed by store-generation invalidation below. |
| E2E preparation differential | `provider-preparation-differential.ts:91-120` | Currently deliberately reads physical rows. Keep the old independent materialized oracle; compare the candidate's **resolved** full parts after an overlay change and separately enumerate raw representation differences. Do not weaken the assertion to totals. |
| Offline resident capture / raw-row oracle | `provider_resident_read.rs`; generated `provider-pipeline-differential.ts` `resident` operation | Capture currently uses the existing PolicyIndex; the independent oracle reads raw physical rows with ancestry/consumption resolution. After an overlay, keep the old-store oracle separate and expose candidate effective values through the resolver. |
| Migration, revision and summary triggers; migration/parity tests | store migrations 66/68/70; `provider_log/*tests.rs`, provider summary/parity tests | Historical migrations are not rewritten. New triggers must use epoch-aware before-image semantics; raw test writers remain adversarial tests, not production-reader exceptions. |

A direct SQLite query cannot be made safe just by changing one Rust caller. For
future compatibility, choose either (a) keep the public SQL table name as an
**effective view** over renamed private base rows with resolver-compatible SQL,
or (b) make physical rows private and route every supported reader/export through
one API. A view using an unregistered SQLite UDF would break external readers;
that is not an acceptable shortcut. The proposal chooses the API route and a
store reader-floor bump, with the export selector as a required implementation
item. No such routing change has been made yet.

## Writer coverage by authority table and publication family

Policy coverage starts from the existing audited table inventory in
`provider-policy-revision-write-sites.md`. Migration 70 has transaction-level
namespace revision triggers, including direct SQL, for lineages, messages,
answers, policy parts/summaries/changes, pending drops, legacy tags, conversations,
consumed tags, mc_tags and mc_cache_state. It does **not** provide a complete
render-domain journal or cover view eligibility by itself.

The following table groups publication families by their physical write boundary. The future journal/revision mechanism must be table-level, not a
call-site-only promise, so generic/direct SQL and new callers cannot evade it.
A row with “new domain clock” means **proposed**, not an existing guarantee.

| Authority / family | Concrete writers and source | Current signal | Proposed accounted event / invalidation |
| --- | --- | --- | --- |
| Provider policy, admission, pass/status pages, promotion/burn, drops, counters/calibration | `provider_log.rs` `save_engine_policy_tx`, `admit_policy_parts_tx`, `commit_provider_hook_with_preparation`, `admit_provider_pass`, `commit_provider_status_page`, `queue/consume_provider_drops`, `save_provider_conversation`; legacy `provider_records.rs` facade | Migration 70 namespace policy revision + bounded before-image log (first image only, no complete transaction journal) | Namespace store journal for changed records and baseline/lineage epochs. Authoritative overlay writes also advance policy revision; derived checkpoint writes do not. |
| Full-array engine commits / state import | `mc-store/src/lib.rs` `commit_transform`, `commit_state_import` (`10755` onward), `save_engine_policy_tx:161-200` | Engine row CAS/version + migration 70 cache-state/policy revision; namespace-wide summary invalidation | Engine-generation/reset event, invalidate/recover all namespace-sharing actors, clear obsolete overlay applicability in the same transaction. Leave the full-array Rust (mode 2) transform algorithm unchanged; only its store invalidation boundary participates. |
| Lineage descent / revert / reset | `lib.rs` `descend_lineage:12117`, `reset_session_for_recomp:12838`, `truncate_compartments_for_revert:12928`; provider lineage/status APIs | Store row version/revert epoch, policy revision; pending context work and compartment history revision | Explicit ancestry/cut/reset event with old/new namespace and cut, plus domain clear/truncate event; invalidate inner-cut views and no longer eligible treatment pages. |
| Produced/applied/not-applied view rows and receipts | `providers/compaction.rs:328-377,1188-1240,1313-1328`; `provider_log.rs` `save_provider_view`, `set_provider_view_state` | Immutable replacement equality and validated acknowledgement; view table is not itself in migration 70's revision trigger set | View eligibility journal / cheap indexed row fence, including deletion/replacement. A hot locator cannot resurrect a missing row. |
| Historian flight, lease, report and publication | `mc-store/src/historian_claim.rs:371-1114`; `lib.rs` `publish_historian_chunk:13755`, abandon/publish-failure/drain APIs; `mc-module/src/providers/historian.rs`; plugin `storage-historian-runs.ts:87` | Engine/meta row version, durable claim/run state, pending context publication and history revision after application | Store run/barrier events; context publish events only when the domain half commits. Pending or failed publication keeps checkpoint not-ready; no invented historian barrier. |
| Compartment append/replace/delete/fold and date projection | `context_writes.rs` `upsert_compartments_tx`, `apply_fold_tx`, `apply_pending_tx` (`152-241,288-449`); `host_store.rs:1202-1291`; `lib.rs` replace/append/truncate APIs; plugin `storage-clone.ts:505`; `single_store_schema.rs:560` date writer | `compartment_history_versions` generation/version/rewrite_version; m0 mutation head for module rewrites | Reuse history generation/version and add indexed changed-compartment events, including all renderer-read fields and dates; distinguish pending vs applied revisions. |
| Scores and undo | `score_projection.rs:1-15,170-257` reads; plugin `migration-v98-compartment-rescore.ts:117-160`, `hooks/magic-context/score-projection.ts:49-65`, `storage-session-tables.ts:56-63` cleanup and test-support score writers (no production score publisher was found by the closed literal writer search) | Append-only score revision + selection watermark, source-identity check | Domain score-selection cursor; record source identity and selected importance. Pending rescores remain pending until an otherwise authorized gate. |
| Compartment events, facts, notes, primers and user observations | `host_store.rs:1223-1642`; `context_writes.rs:218-449`; plugin `storage-notes.ts:269-592`, `smart-notes/storage.ts:94-367`, `storage-primers.ts:302-568`, `storage-meta-shared.ts:420` | Some session facts/note-status/profile versions and mutation heads, but no single complete render clock for event/fact-only writes | New domain clock/event family for render-relevant rows. Non-render bookkeeping is classified, not allowed to invalidate rendering gratuitously. Candidate promotion affects memory/profile clocks when applied. |
| Memory admission/update/archive/merge/supersession/expiry/classification/cues/verification/mapping | `memory_lifecycle/applier.rs` `apply_memory_admission_tx`; `lib.rs:6743-7179,10433-10568,13264-13363`; `memory_projection.rs:39-85`; `host_store.rs:1357-1403`; plugin `memory/storage-memory.ts:337-507,1080-1193`, verification and embedding stores | Per-memory revision where supported, max id, memory mutation cursor, fragment watermark and project-memory epoch; these do not alone prove all in-place writers covered | New render-memory clock/events for exact eligibility/content/order/visibility fields; telemetry/embedding writes classified separately. Keep frozen expiry cutoff until authorized materialization. |
| Dashboard memory/profile direct SQL | dashboard `db.rs:6012-6511,8530-8592` | Explicit project-memory/profile epoch and mutation-log helper calls alongside edits | Same table-level context clocks as module/host writers; do not rely on dashboard call-site discipline. |
| Workspace membership/visibility/project identity merge | plugin `workspaces.ts` reader, `storage-identity-merge.ts:256-302,674`, `migrations.ts:1627`; `lib.rs` workspace readers/test writers; dashboard `src-tauri/src/workspaces.rs:308-334,552-839` create/rename/delete/member/category mutations; generic import/move | Membership fingerprint, project-memory epoch and visible per-row revisions; deletion/recreation can reuse numerical heads | Context generation nonce + workspace/project render clock/events. Retain old/new ownership/member identities; invalidate every affected namespace, not only the writer's conversation. |
| User profile | `host_store.rs:1605-1642`; dashboard `db.rs:8530-8592`; plugin `storage-project-state.ts:54-137`, `user-memory/storage-user-memory.ts` | Global `project_state['__global__'].project_user_profile_version` | Reuse profile version with generation nonce and events covering content/status/order; profile-only edits must not be missed by memory max-id. |
| Docs, configuration, model/provider/system/upgrade and tokenizer/renderer identity | `project_docs.rs`, m0 composer canonical docs read; request/render identity in `transform.rs:711-845,8970-9039`; config/pass synchronization | Render identity/settings, live request permission; filesystem docs are not in a SQLite policy clock | Record exact canonical doc manifest/content hashes at a fold, plus configuration/build/renderer/tokenizer identities. Watch overflow/missed events force recovery; a fold must validate actual doc content, not trust mtime alone. Large changed docs are separately bounded/measured. |
| Clone/import/export, doctor repair, migration, store replacement | `move_snapshot.rs`, `move_store.rs`, `provider_records.rs` replace/remove facades, `storage-clone.ts`, identity merge, CLI doctor repair/migrate and paired backups | Existing schema/lease/CAS and inventory validation, not a permanent resident-store identity | New store/context generation nonces; discard derived checkpoints, rebind shipped authoritative overlays and effective rows. Never reuse in-memory actor state after reopen/reset/replacement under a coincident numerical revision. |
| Direct SQL and test-support writers | Migration triggers; new read-only tests; preparation/revision/summary/parity adversaries | Policy table triggers cover policy SQL; compartment history triggers cover compartment SQL; domain coverage is incomplete today | Trigger-backed journals/clocks for each covered table, including UPDATE and DELETE and owner moves. Row-changing SQL outside that set must refuse readiness, not silently pass. Test mutators must exercise each trigger family. |

This is a publication-family/table inventory, not a claim that every SQL statement
in every maintenance script has been semantically audited. Closed literal policy
searches above are complete; the domain census includes the central store/host,
plugin storage, dashboard and generic move/reset families. Dynamic SQL, operator
scripts and filesystem changes are covered by the **required table/generation or
content fence**, not by assuming their absence. Before a migration/consumer is
approved, generate the authoritative table/column-to-clock registry from actual
schemas, audit the remaining maintenance scripts against it and test direct SQL
for every family. Uncovered tables/columns are a readiness failure.
