import type { Database } from "../../shared/sqlite";
import { SESSION_RENDER_CACHE_COLUMNS, SESSION_RENDER_CACHE_DDL } from "./storage-session-cache";
import {
    resetSessionMetaCollectionSchema,
    SESSION_META_CHUNKS_DDL,
    SESSION_META_COLLECTION_DEFAULTS,
    type SessionMetaCollection,
    writeSessionMetaCollectionBytes,
} from "./storage-session-collections";

/** Move payload bytes verbatim; replay identities and materialization markers stay unchanged. */
export function splitSessionMetaPayloads(db: Database): void {
    db.exec(SESSION_RENDER_CACHE_DDL);
    db.exec(SESSION_META_CHUNKS_DDL);
    const columns = new Set(
        (db.prepare("PRAGMA table_info(session_meta)").all() as { name: string }[]).map(
            (column) => column.name,
        ),
    );
    for (const column of SESSION_RENDER_CACHE_COLUMNS) {
        if (!columns.has(column)) continue;
        db.exec(`INSERT INTO session_render_cache (session_id, cache_key, value)
            SELECT session_id, '${column}', ${column} FROM session_meta
            WHERE ${column === "memory_block_cache" ? `(${column} IS NULL OR ${column} != '')` : `${column} IS NOT NULL`}
            ON CONFLICT(session_id, cache_key) DO UPDATE SET value = excluded.value
            WHERE value IS NOT excluded.value`);
        db.exec(`ALTER TABLE session_meta DROP COLUMN ${column}`);
    }
    for (const [column, fallback] of Object.entries(SESSION_META_COLLECTION_DEFAULTS)) {
        if (!columns.has(column)) continue;
        const rows = db
            .prepare(
                `SELECT session_id, typeof(${column}) AS storage_type, CAST(${column} AS BLOB) AS bytes FROM session_meta WHERE ${column} IS NULL OR ${column} != ?`,
            )
            .all(fallback) as {
            session_id: string;
            storage_type: string;
            bytes: Buffer | Uint8Array | null;
        }[];
        for (const row of rows) {
            writeSessionMetaCollectionBytes(
                db,
                row.session_id,
                column as SessionMetaCollection,
                row.bytes,
                row.storage_type,
            );
            if (row.storage_type === "integer" || row.storage_type === "real") {
                db.prepare(
                    `UPDATE session_meta_chunks SET body=(SELECT ${column} FROM session_meta WHERE session_id=?) WHERE session_id=? AND column_name=? AND chunk='-1'`,
                ).run(row.session_id, row.session_id, column);
            }
        }
        db.exec(`ALTER TABLE session_meta DROP COLUMN ${column}`);
    }
    resetSessionMetaCollectionSchema(db);
}
