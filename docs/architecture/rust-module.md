# The Rust module (ck-mc)

The Rust workspace in `crates/` re-implements the cache-stability transform and the historian as `ck-mc`, a module of the subconscious daemon (subc). ck-mc serves sessions through its step-transform provider. Its callers are Claude Code through the Thalamus gateway, Broca workers, and OpenCode or Pi sessions that the CortexKit harness bridges to ck-mc. The in-tree OpenCode and Pi plugins run the TypeScript transform; they do not send their passes to ck-mc.

## Where the code is

- `crates/mc-module/src/lib.rs`: request routing, tool facades, session operations, state sync and health.
- `crates/mc-module/src/main.rs`: module entry point under subc.
- `crates/mc-module/src/providers/`: the step-transform provider. `compaction.rs` runs the compaction steps, `step_transform.rs` answers host declarations and hooks, `historian.rs` is the provider historian worker, `resident*.rs` is the resident engine, and `codec_*.rs` translate each harness's messages.
- `crates/mc-module/src/transform.rs`, `injection.rs`, `m0_compose.rs`, `m1_compose.rs`, `boundary.rs`: the transform engine and `m[0]`/`m[1]` rendering, mirroring the TypeScript runtime.
- `crates/mc-module/src/historian.rs`, `historian_producer.rs`, `historian_chunk.rs`, `historian_validate.rs`: the module historian.
- `crates/mc-module/src/codec/`, `healing.rs`: harness codecs and serializer profiles.
- `crates/mc-store/src/lib.rs`: the module's SQLite store (`store.db`), its migrations and row-version compare-and-set. `crates/mc-store/src/single_store_schema.rs`: the single-store layout and its refusal.
- `crates/mc-core/`: the pass classifier (`classify`, which plans a pass) and the decay math. `crates/mc-tokenizer/`: the byte-BPE token estimator.
- `packages/plugin/src/host-runner.ts`, `packages/plugin/src/hooks/magic-context/host-runner/`: the OpenCode bridge adapter that the harness loads (see [host-runner.md](../integrations/host-runner.md)). `packages/pi-plugin/src/bridge-adapter-pi.ts`: the Pi bridge adapter.
- `packages/plugin/src/hooks/magic-context/module-transport.ts`, `module-wire.ts`, `module-state-sync.ts`: transport, ordinal mapping and state sync for the bridge adapters.

## Who calls the module

Rust transform mode is retired. In that mode the in-tree plugin sent each pass's full message array to ck-mc. The plugins now ignore `transform_mode` and `rust_pipeline` and log one warning.

ck-mc answers the step contract: `compaction.setup`, `compaction.step`, `compaction.view.read`, `transform.declare` and `transform.hook`. `lib.rs` sends these methods to `providers/`. The callers are:

- **Claude Code**, through the Thalamus gateway.
- **Broca workers.**
- **OpenCode and Pi sessions that the CortexKit harness bridges to ck-mc.** For OpenCode, the harness loads `@cortexkit/opencode-magic-context/host-runner`; for Pi, it uses the Pi bridge adapter. The bridge keeps its durable record in `context.db`. [host-runner.md](../integrations/host-runner.md) describes that adapter.

## The bridge's host side

The bridge adapters use three TypeScript pieces to talk to ck-mc:

1. **State sync** (`module-state-sync.ts`). The host keeps a set of watermarks per session: compartment sequence, newest memory id, `m[0]` mutation id, memory-mutation id, todo-state hash, project memory epoch, user-profile version, workspace fingerprint and reasoning-cleared-through tag. When they match what the module last acknowledged, nothing is sent. Otherwise the changed rows go to the module, paged to stay under the subc frame limit (64 MiB body, 16 MiB envelope headroom, 64 KiB continuation chunks for large values). A pending `m[0]` mutation is reported separately because it forces a fold.
2. **Ordinal mapping** (`module-wire.ts`, `resolveOrdinalsForModule`). The module addresses messages by absolute ordinal in the host store. A per-session memo maps message ids to ordinals, with page checkpoints. A warm memo that covers every wire id is trusted without a store read. New ids are resolved by reading ordinal pages of 500 rows after the last anchor. If the store count no longer adds up (a message was removed), the walk resumes from progressively older checkpoints instead of re-reading the session. A lifecycle event such as a message removal sets a verify flag, so the next pass checks the store even when the memo looks complete. A conflict the rewind cannot repair clears the memo and fails the pass loudly.
3. **Transport** (`module-transport.ts`, using `SubcClient` and `RouteHandle` from `@cortexkit/subc-client`). Requests for one session are serialised on a per-session lane. Connection backoff escalates from 1 s to 30 s; a call waits through at most 12 s of remaining backoff before it fails.

## Module store

The module keeps its own store, `store.db`, in the same data directory as `context.db` (`~/.local/share/cortexkit/magic-context/`). `crates/mc-store` owns its schema through its own migration chain, independent of the `context.db` versions, and every durable transition is a compare-and-set on a row version. Notable tables are `mc_pass_trace` (a durable audit of receive, complete and reject events per pass) and `mc_reduce_command_ledger` (command-id idempotency for `ctx_reduce` drops). `context.db` and `store.db` form one consistency unit: restore both from the same backup or neither.

Project data (memories, notes, compartments, user memories, primer candidates and workspaces) lives in `context.db`. The module attaches to `context.db` and writes those rows there. `store.db` keeps the module's private session and cache state. An older `store.db` that still holds those rows needs the one-time single-store migration. Until it runs, the module refuses every request except `echo` with `single_store_migration_required`, which the plugin and the CLI show as `MC-C14`. `magic-context doctor single-store migrate` runs the migration offline.

### Rollback

A ck-mc rollback is the previous binary **together with** `context.db` and `store.db` restored from the same backup. `scripts/backup-live-stores.sh` snapshots both in one run for this purpose.

Rolling back only the binary across a store migration is refused. `McStore::open` compares the highest version recorded in `store.db` with the newest migration the binary carries. When the store is ahead, the open fails with `McStoreError::StoreAheadOfBinary { db_version, binary_max }` before it reads or writes a row. Older builds logged this case and continued. That half-worked: migration 53 moved note ownership into triggers that read a row an older binary never fills, so note inserts and deletes failed later without naming the cause.

The refusal is terminal until the module restarts on a store it knows:

- `ck health magic-context` reports `failing`, with `storage_state: open_refused_store_ahead`, both versions (`store_db_version`, `binary_max_store_version`) and the remediation.
- Every request lane except `echo` answers with a `store_ahead_of_binary` error frame. Its detail is `{reason_code, db_version, binary_max}`.
- Facade tools answer with the user-facing sentence: "Magic Context refused to start: its store (store.db) is at schema vN but this ck-mc build only knows up to vM. Update ck-mc, or roll back by restoring ck-mc together with context.db and store.db from the same backup. (MC-C13)".
- The plugin's module transport (`module-transport.ts`) maps the code to `StoreAheadOfBinaryError`, so a bridged pass refuses the turn with the same sentence.

A store that is older than the binary still migrates forward on open, and a store at the binary's own version opens as before.

## Tool facades

The module exposes MCP-style facades for all five tools (`ctx_memory`, `ctx_search`, `ctx_expand`, `ctx_reduce`, `ctx_note`), which is how Claude Code reaches them.

## Serializer profiles and epochs

Each request names a serializer profile (`healing.rs`): `opencode-aisdk`, `pi`, `claude-code-anthropic`, and the owned runner profiles. Harness codecs in `codec/` translate harness JSON to canonical wire messages and back. Every shipping profile rebuilds the provider request from the transformed array, so all of them allow tail reclaim as well as prefix folding.

Byte-affecting format changes are coordinated through epochs in `lib.rs` (`MEMORY_RENDER_FORMAT_EPOCH`, `COMPARTMENT_RENDER_FORMAT_EPOCH`, per-profile epochs, `TAGGER_FEATURE_EPOCH`). They are folded into the request's render configuration; any change forces one HARD fold so each session crosses a format change once. Consumers read the epochs at attach through `session.status` and refuse to serve on a mismatch.

## The module historian

The module runs its own historian (`historian.rs`), with the same trigger, protected-tail boundary and validation rules as the TypeScript one (see [historian.md](historian.md)). The caller sends its resolved historian model chain with each request (`historian_model_chain`). The producer (`historian_producer.rs`) asks for at most 32,000 output tokens and waits up to 600 s per run. Each skipped fire is recorded durably with a typed cause (`HistorianNoFireCause`: already in progress, below the proactive floor, drain budget spent, no models, and so on) so status can say why nothing happened.

A transform in emergency may wait for historian work it started, but those waits share one 20 s budget (`TRANSFORM_HISTORIAN_FOLLOWUP_BUDGET`) so they cannot stack past the caller's deadline. `session.wrapup` runs rounds of up to 600 s each within an overall budget of 3,800 s (`MAX_WRAPUP_REQUEST_BUDGET`) and returns a machine-readable disposition (`completed`, `nothing_to_compact`, `already_in_progress`, `failed`). It works from a cached snapshot of the session's last full transform. Only the full-array `transform` route of the retired mode records that snapshot, so a session served through the step contract gets the retryable reason `transform_not_observed` instead. Other session operations are `session.status`, `session.recomp`, `session.flush` and `session.delete`, which removes the session's rows from the store.

On store open during a daemon restart, the module retries the store lease for up to 60 s; an individual request waits at most 500 ms for an in-flight open before refusing.
