# Vector storage and bounded drain integration

## Public operations

`store.rs` operates on the existing TypeScript tables, without SQLite extensions or new tables. Blobs are four-byte little-endian float32 values (the native Float32Array representation on the supported Linux/macOS hosts). Cosine uses float64 products and accumulators, matching JavaScript `number`, not float32 accumulation.

- `save_if_current` requires a transaction. Memory publication uses the current `normalized_hash`; commit publication rechecks SHA-256 of the current message. Neither TypeScript vector table persists a content hash. Chunk publication checks the current canonical window through `ChunkCatalog`, its project/session/harness, and its text SHA-256.
- `load` filters by project and model, validates width/finiteness, and revalidates raw-window hashes. Memory/commit reads trust existing TypeScript rows. Retrieval remains responsible for status, visibility, score normalization and final ranking policy.
- `invalidate` deletes every model's vector for a memory/commit, or every window/model for a compartment. Call it in the source writer's transaction. `replace_chunks_if_current` replaces a complete compartment/model window set atomically; incremental backfill publishes at most 64 missing windows per call. Raw writers must invalidate the compartment when canonical text changes its window partition.
- `memory_coverage` has the same active-memory-only semantics as TypeScript's `/ctx-embed` coverage. `clear_model` supports project-scoped rebuilds without deleting another model's rows.

`drain.rs` uses the existing `embedding_registrations` model IDs, fingerprint, table epoch, dimensions and generation. The integration owner supplies an authoritative `Registration` snapshot; a query-only provider setting is not a new stored passage model. Memory/commit use `model_id`; raw chunks use the separate recipe-specific `chunk_model_id`.

One bounded job record per project is kept under `_magicContextVectorDrain` inside the existing `provenance_json` object; unrelated provenance keys are preserved. There is no new schema. A refresh replacing that JSON invalidates the old claim rather than resurrecting it. Claim/finish are immediate SQLite transactions. Finish checks the full registration snapshot, lease expiry and exact claimed JSON before any vector write. A random token distinguishes each new claim even if another writer resets provenance between claims.

The missing/stale row queries are the durable cursor. Provider errors, invalid output, rejected content hashes and process restarts leave missing work retryable. Restart recovery waits for the old lease (at most 60 seconds); completed rows do not get skipped by an offset. Rotation among memory, commit and chunk work is durable and advances even after provider failure. `progress` reports accepted/discarded batches and failures, while `ClaimOutcome` distinguishes busy, drained and superseded registration. `drain_once` makes at most one injected provider call and holds no transaction during that call. Its completion clock must report the actual end time, so an overlong provider call cannot publish through an expired lease.

The archive integration implements `ChunkCatalog`: enumerate at most the requested number of missing/stale canonical raw windows and validate current hash/span using the supplied SQLite connection. Raw canonicalization/window planning is not duplicated here. The test catalog is a fake archive projection; the separate Bun fixture calls real TypeScript `chunkCanonicalText`, persistence and search loaders to compare their output against Rust.

Apply the adjacent `integration.patch` to declare `pub mod store` and `pub mod drain` in `src/retrieval_vectors/mod.rs`. It is intentionally not applied here because module roots belong to the integration owner. The existing `UnavailableRetrievalVectors` remains unchanged until the integration owner connects the scoped `RetrievalVectorStore` adapter to these operations. The adapter must map its provenance source IDs to the typed `Source` keys; the manifest defines no canonical string encoding for those keys. It must also arrange registration activation and transactional source invalidation with the memory/git/archive writers.

## Memory mutation/invalidation evidence

The memory hash fence is at write time only; there is no Rust-only hash side table or first-read adoption step.

- New `ctx_memory` inserts queue an embedding; dedup only changes seen counts: `packages/plugin/src/tools/ctx-memory/tools.ts:519-545`.
- Primary-agent update and canonical merge call `updateMemoryContent`: `memory/lifecycle-applier.ts:596-605,629-639`. The helper deletes all embeddings in the text-changing transaction: `memory/storage-memory.ts:1061-1073,1110-1119`. The tool queues replacement embeddings afterward: `packages/plugin/src/tools/ctx-memory/tools.ts:650-658,759-767`. Its provider completion uses the normalized-hash guarded save: `packages/plugin/src/tools/ctx-memory/tools.ts:194-216`.
- Dreamer verification rewrite deletes the old embedding and invalidates cache: `dreamer/verify.ts:765-773,826-842`. It does not immediately queue a replacement; later missing-vector backfill can supply one (`memory/embedding-backfill.ts:11-28,39-69`). The rewrite leaves a vector missing rather than retaining an outdated one.
- Superseding merge sources and archiving change status only and retain vectors: `memory/storage-memory.ts:1197-1200,1221-1238`; callers perform visibility filtering. Physical deletion explicitly deletes vectors: `memory/storage-memory.ts:1240-1250` (also protected by cascading foreign keys).
- Relocation collisions copy the source vector to an equivalent surviving memory before deleting the source: `memory/relocate-memory.ts:87-97`.

Paths above are under `packages/plugin/src/features/magic-context/` unless explicitly prefixed otherwise. The searched production text mutation paths contained no stale-vector invalidation hole. The verification rewrite's missing immediate requeue is left unchanged because this implementation changes Rust storage, not TypeScript mutation scheduling.

## Differential verification

`generate.ts` uses throwaway databases and isolated HOME/XDG/logger directories. It imports real TypeScript migrations, memory/commit/raw-window stores, chunk planning and cosine. It tests Float32Array subviews, another model, tied ranks, zero norms and nontrivial float32 rounding. The Rust test compares persisted rows, decoded values and rankings in both directions: TypeScript-produced SQLite read by Rust, then Rust-produced SQLite read by TypeScript. Neither expected rankings nor expected bytes are computed by the Rust implementation.

Run `cargo test -p mc-store --test retrieval_vectors -- --nocapture` on Linux. The test includes the source files by path so it can run before the root patch is integrated. Typecheck the generator with the repository compiler: `packages/plugin/node_modules/.bin/tsc --noEmit -p crates/mc-store/testdata/retrieval_vectors/tsconfig.json`.

Mutation controls are `model_identity_fence_excludes_other_models_and_projects` (remove only the memory model predicate while keeping the SQL parameter active), and `stale_generation_cannot_publish` (neutralize only the registration generation predicate). The generation test changes only the generation column while retaining the lease's exact saved `provenance_json` value. A comparison of saved/current JSON therefore cannot reject the batch instead of the generation predicate.
