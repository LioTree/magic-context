import type { Database } from "../../shared/sqlite";
import { layoutSessionMetaBytes, SESSION_META_CHUNK_BYTES } from "./session-meta-chunk-layout";

export const SESSION_META_CHUNKS_DDL = `CREATE TABLE IF NOT EXISTS session_meta_chunks (
    session_id TEXT NOT NULL,
    column_name TEXT NOT NULL,
    chunk TEXT NOT NULL,
    body BLOB,
    PRIMARY KEY (session_id, column_name, chunk)
) WITHOUT ROWID`;

export const SESSION_META_COLLECTION_DEFAULTS = {
    trailing_blank_decisions: "",
    merged_reasoning_stripped_ids: "",
    note_nudge_anchors: "[]",
    auto_search_hint_decisions: "[]",
    stale_reduce_stripped_ids: "",
    stripped_placeholder_ids: "",
    processed_image_stripped_ids: "",
    memory_block_ids: "",
} as const;
export type SessionMetaCollection = keyof typeof SESSION_META_COLLECTION_DEFAULTS;
export { SESSION_META_CHUNK_BYTES };

export function isSessionMetaCollection(column: string): column is SessionMetaCollection {
    return Object.hasOwn(SESSION_META_COLLECTION_DEFAULTS, column);
}

const metadataColumns = new WeakMap<Database, Set<string>>();
export function isSessionMetaCollectionInline(
    db: Database,
    column: SessionMetaCollection,
): boolean {
    let columns = metadataColumns.get(db);
    if (!columns) {
        columns = new Set(
            (db.prepare("PRAGMA table_info(session_meta)").all() as { name: string }[]).map(
                (row) => row.name,
            ),
        );
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_meta_chunks'").get())
            columns.add("__chunked__");
        metadataColumns.set(db, columns);
    }
    return columns.has(column) || !columns.has("__chunked__");
}
export function resetSessionMetaCollectionSchema(db: Database): void {
    metadataColumns.delete(db);
}

/** Aggregate raw bytes before decoding, so a UTF-8 character may safely cross a chunk boundary. */
export function sessionMetaCollectionValueSql(
    column: SessionMetaCollection,
    db?: Database,
): string {
    if (db && isSessionMetaCollectionInline(db, column)) return column;
    return `(CASE WHEN EXISTS (SELECT 1 FROM session_meta_chunks WHERE session_id=session_meta.session_id AND column_name='${column}' AND chunk='-1')
        THEN (SELECT CASE WHEN body IS NULL THEN NULL
            WHEN body = 'blob' THEN CAST(COALESCE((SELECT group_concat(body, '') FROM
                (SELECT body FROM session_meta_chunks WHERE session_id=session_meta.session_id AND column_name='${column}' AND chunk!='-1' ORDER BY chunk)), '') AS BLOB)
            WHEN typeof(body) IN ('integer','real') THEN body
            ELSE COALESCE(
            (SELECT CAST(group_concat(body, '') AS TEXT) FROM
                (SELECT body FROM session_meta_chunks WHERE session_id=session_meta.session_id AND column_name='${column}' AND chunk!='-1' ORDER BY chunk)), '') END
            FROM session_meta_chunks WHERE session_id=session_meta.session_id AND column_name='${column}' AND chunk='-1')
        ELSE '${SESSION_META_COLLECTION_DEFAULTS[column]}' END)`;
}
export function sessionMetaCollectionSelect(
    column: SessionMetaCollection,
    alias: string = column,
    db?: Database,
): string {
    return `${sessionMetaCollectionValueSql(column, db)} AS ${alias}`;
}

export function readSessionMetaCollection(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
): unknown {
    const row = db
        .prepare(
            `SELECT ${sessionMetaCollectionSelect(column, column, db)} FROM session_meta WHERE session_id=?`,
        )
        .get(sessionId) as Record<string, unknown> | undefined;
    return row?.[column] ?? (row ? null : SESSION_META_COLLECTION_DEFAULTS[column]);
}

/** Preserve the caller's exact serialization; unchanged prefix chunks never enter SQLite's write path. */
export function writeSessionMetaCollection(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
    value: string | null,
): void {
    if (isSessionMetaCollectionInline(db, column)) {
        db.prepare(`UPDATE session_meta SET ${column}=? WHERE session_id=?`).run(value, sessionId);
        return;
    }
    writeSessionMetaCollectionBytes(
        db,
        sessionId,
        column,
        value === null ? null : Buffer.from(value, "utf8"),
    );
}

export function writeSessionMetaCollectionBytes(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
    bytes: Buffer | Uint8Array | null,
    storageType: string = "text",
): void {
    if (storageType === "text" && bytes !== null && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(Buffer.from(SESSION_META_COLLECTION_DEFAULTS[column]))) {
        db.prepare("DELETE FROM session_meta_chunks WHERE session_id=? AND column_name=? AND EXISTS (SELECT 1 FROM session_meta WHERE session_id=?)").run(sessionId,column,sessionId);
        return;
    }
    const chunks = bytes === null ? new Map<string, Uint8Array>() : layoutSessionMetaBytes(bytes);
    db.transaction(() => {
        if (!db.prepare("SELECT 1 FROM session_meta WHERE session_id=?").get(sessionId)) return;
        const rows = db
            .prepare(
                "SELECT chunk,body FROM session_meta_chunks WHERE session_id=? AND column_name=? ORDER BY chunk",
            )
            .all(sessionId, column) as {
            chunk: string;
            body: Buffer | Uint8Array | string | null;
        }[];
        const previous = new Map(rows.map((row) => [row.chunk, row.body]));
        const upsert =
            db.prepare(`INSERT INTO session_meta_chunks(session_id,column_name,chunk,body) VALUES(?,?,?,?)
            ON CONFLICT(session_id,column_name,chunk) DO UPDATE SET body=excluded.body WHERE body IS NOT excluded.body`);
        // The marker preserves storage class as well as NULL versus an absent/default value.
        const marker =
            bytes === null ? null : storageType === "text" ? Buffer.alloc(0) : storageType;
        const oldMarker = previous.get("-1");
        const sameMarker =
            marker instanceof Uint8Array
                ? oldMarker instanceof Uint8Array && oldMarker.byteLength === 0
                : oldMarker === marker;
        if (!previous.has("-1") || !sameMarker) upsert.run(sessionId, column, "-1", marker);
        for (const [key, body] of chunks) {
            const old = previous.get(key);
            if (
                old instanceof Uint8Array &&
                Buffer.from(old.buffer, old.byteOffset, old.byteLength).equals(body)
            )
                continue;
            upsert.run(sessionId, column, key, body);
        }
        const removed = rows.filter((row) => row.chunk !== "-1" && !chunks.has(row.chunk));
        if (removed.length && chunks.size === 0) {
            db.prepare(
                "DELETE FROM session_meta_chunks WHERE session_id=? AND column_name=? AND chunk!='-1'",
            ).run(sessionId, column);
        } else if (removed.length) {
            const remove = db.prepare(
                "DELETE FROM session_meta_chunks WHERE session_id=? AND column_name=? AND chunk=?",
            );
            for (const row of removed) remove.run(sessionId, column, row.chunk);
        }
    }).immediate();
}

/** Preserve SQLite IS comparison for raw NULL/BLOB values while validating and writing under one lock. */
export function updateSessionMetaCollection(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
    value: string | null,
    expected?: { value: unknown },
): { changes: number } {
    return db
        .transaction(() => {
            const matches = expected
                ? db
                      .prepare(
                          `SELECT 1 FROM session_meta WHERE session_id=? AND ${sessionMetaCollectionValueSql(column, db)} IS ?`,
                      )
                      .get(sessionId, expected.value)
                : db.prepare("SELECT 1 FROM session_meta WHERE session_id=?").get(sessionId);
            if (!matches) return { changes: 0 };
            writeSessionMetaCollection(db, sessionId, column, value);
            return { changes: 1 };
        })
        .immediate();
}
