import type { Database as BunDatabase } from "bun:sqlite";
import type { Database } from "../../packages/plugin/src/shared/sqlite";
import { readCollectionState } from "../../packages/plugin/src/features/magic-context/storage-session-collection-state";
import { isSessionMetaCollection, readSessionMetaCollection, sessionMetaCollectionValueSql } from "../../packages/plugin/src/features/magic-context/storage-session-collections";
import { isSessionRenderCacheColumn, readSessionRenderCache, sessionRenderCacheValueSql } from "../../packages/plugin/src/features/magic-context/storage-session-cache";

export type PayloadProof = { column: string; rows: number; bytes: number; sha256: string };
export const MOVED_COLUMNS = [
    "cached_m0_bytes", "cached_m1_bytes", "cached_m0_mural_data_url", "memory_block_cache", "cached_m0_upgrade_state",
    "merged_reasoning_stripped_ids", "stale_reduce_stripped_ids", "processed_image_stripped_ids", "memory_block_ids",
    "stripped_placeholder_ids", "note_nudge_anchors", "auto_search_hint_decisions",
    "trailing_blank_decisions",
] as const;

export function movedPayloadDifference(db: BunDatabase, columns: string[], proofs: PayloadProof[]): string | null {
    const production = db as unknown as Database;
    for (const [table, key] of [["session_render_cache", "cache_key"], ["session_meta_chunks", "column_name"], ["session_meta_collection_revisions", "column_name"]]) {
        const allowed = MOVED_COLUMNS.filter((column) => table === "session_render_cache" ? isSessionRenderCacheColumn(column) : isSessionMetaCollection(column));
        const invalid = db.query(`SELECT 1 FROM ${table} AS payload LEFT JOIN session_meta AS owner ON owner.session_id=payload.session_id WHERE owner.session_id IS NULL OR payload.${key} NOT IN (${allowed.map(() => "?").join(",")}) LIMIT 1`).get(...allowed);
        if (invalid) return `${table}: orphan or unreviewed payload key`;
    }
    for (const column of columns) {
        if (!(MOVED_COLUMNS as readonly string[]).includes(column) || (!isSessionMetaCollection(column) && !isSessionRenderCacheColumn(column)))
            return `session_meta: removed column ${column}`;
        const digest = new Bun.CryptoHasher("sha256");
        let rows = 0, bytes = 0;
        for (const row of db.query(`SELECT session_id, typeof("${column}") AS type, CAST("${column}" AS BLOB) AS bytes, "${column}" AS value FROM baseline.session_meta ORDER BY session_id`).iterate() as Iterable<{ session_id: string; type: string; bytes: Uint8Array | null; value: unknown }>) {
            let actual: unknown, raw: Uint8Array | null, storageType: string;
            if (isSessionMetaCollection(column)) {
                const state = readCollectionState(production, row.session_id, column);
                actual = readSessionMetaCollection(production, row.session_id, column);
                raw = actual === null ? null : state.rawBytes;
                const marker = state.pieces.get("-1");
                if ((!marker && state.pieces.size !== 0) || (actual === null && state.pieces.size !== 1) || [...state.pieces].some(([key, piece]) => key !== "-1" && piece.type !== "blob"))
                    return `session_meta.${column}: invalid chunk structure for ${row.session_id}`;
                storageType = actual === null ? "null" : actual instanceof Uint8Array ? "blob" : typeof actual === "string" ? "text" : marker?.type ?? typeof actual;
                const expression = sessionMetaCollectionValueSql(column, production);
                const projected = db.query(`SELECT typeof(${expression}) AS type, CAST(${expression} AS BLOB) AS bytes FROM session_meta WHERE session_id=?`).get(row.session_id) as { type: string; bytes: Uint8Array | null };
                if (projected.type !== row.type || (projected.bytes === null ? row.bytes !== null : row.bytes === null || !Buffer.from(projected.bytes).equals(Buffer.from(row.bytes))))
                    return `session_meta.${column}: SQL projection differs for ${row.session_id}`;
            } else if (isSessionRenderCacheColumn(column)) {
                actual = readSessionRenderCache(production, row.session_id, column);
                const expression = sessionRenderCacheValueSql(column, production);
                const stored = db.query(`SELECT typeof(${expression}) AS type, CAST(${expression} AS BLOB) AS bytes FROM session_meta WHERE session_id=?`).get(row.session_id) as { type: string; bytes: Uint8Array | null } | null;
                if (!stored) return `session_meta.${column}: missing owner`;
                raw = stored.bytes;
                storageType = stored.type;
            } else throw new Error(`Unsupported moved column ${column}`);
            // Check stored bytes as well as decoded values, so decoding cannot hide a byte change.
            const sameBytes = raw === null ? row.bytes === null : row.bytes !== null && Buffer.from(raw).equals(Buffer.from(row.bytes));
            const sameRead = actual instanceof Uint8Array && row.value instanceof Uint8Array
                ? Buffer.from(actual).equals(Buffer.from(row.value)) : Object.is(actual, row.value);
            if (!sameBytes || !sameRead || storageType !== row.type)
                return `session_meta.${column}: moved payload differs for ${row.session_id} (original ${row.type}, reconstructed ${storageType})`;
            rows++;
            bytes += row.bytes?.byteLength ?? 0;
            digest.update(JSON.stringify([row.session_id, row.type, row.bytes?.byteLength ?? null]));
            if (row.bytes) digest.update(row.bytes);
        }
        proofs.push({ column, rows, bytes, sha256: digest.digest("hex") });
    }
    return null;
}
