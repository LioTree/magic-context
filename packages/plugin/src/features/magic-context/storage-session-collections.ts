import { isUtf8 } from "node:buffer";
import { type Database, isSqliteTransactionOpen } from "../../shared/sqlite";
import { layoutSessionMetaBytes, SESSION_META_CHUNK_BYTES } from "./session-meta-chunk-layout";
import {
    SESSION_META_COLLECTION_DEFAULTS,
    type SessionMetaCollection,
} from "./session-meta-collection-schema";
import {
    type CollectionPiece,
    type CollectionState,
    clearCollectionStates,
    collectionStateMatches,
    decodeCollectionText,
    isWellFormedCollectionText,
    readCollectionState,
    readCollectionToken,
    rememberCollectionState,
    sameCollectionToken,
    sessionPayloadStatement,
} from "./storage-session-collection-state";

export type { SessionMetaCollection } from "./session-meta-collection-schema";
export {
    SESSION_META_CHUNKS_DDL,
    SESSION_META_COLLECTION_DEFAULTS,
    SESSION_META_COLLECTION_REVISIONS_DDL,
} from "./session-meta-collection-schema";
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
    clearCollectionStates(db);
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
    if (isSessionMetaCollectionInline(db, column)) {
        const row = db
            .prepare(`SELECT ${column} FROM session_meta WHERE session_id=?`)
            .get(sessionId) as Record<string, unknown> | undefined;
        return row?.[column] ?? (row ? null : SESSION_META_COLLECTION_DEFAULTS[column]);
    }
    const value = readCollectionState(db, sessionId, column).value;
    // Keep SQLite's Uint8Array result: JSON-array BLOBs coerce to comma-separated numbers.
    // Buffer would decode them as JSON text, causing reasoning/image-removal readers to
    // apply stored decisions that their JSON parsers previously rejected.
    return value instanceof Uint8Array ? new Uint8Array(value) : value;
}

/** Preserve the caller's exact serialization and prepare its delta before acquiring a writer. */
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
    for (let attempt = 0; attempt < 5; attempt++) {
        const plan = prepareSessionMetaCollectionWrite(db, sessionId, column, value);
        if (!plan.previous.token.present || isUnchanged(plan)) return;
        if (db.transaction(() => applySessionMetaCollectionWrite(db, plan)).immediate()) return;
    }
    throw new Error("session metadata collection revision changed repeatedly");
}

export function writeSessionMetaCollectionBytes(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
    bytes: Buffer | Uint8Array | null,
    storageType: string = "text",
): void {
    for (let attempt = 0; attempt < 5; attempt++) {
        const plan = prepareBytes(
            db,
            sessionId,
            column,
            bytes === null ? null : Buffer.from(bytes),
            storageType,
        );
        if (!plan.previous.token.present || isUnchanged(plan)) return;
        if (db.transaction(() => applySessionMetaCollectionWrite(db, plan)).immediate()) return;
    }
    throw new Error("session metadata collection revision changed repeatedly");
}

/** Validate the observed revision instead of reconstructing the full raw value inside the writer. */
export function updateSessionMetaCollection(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
    value: string | null,
    expected?: { value: unknown },
): { changes: number } {
    if (isSessionMetaCollectionInline(db, column)) {
        return db
            .prepare(
                `UPDATE session_meta SET ${column}=? WHERE session_id=?${expected ? ` AND ${column} IS ?` : ""}`,
            )
            .run(value, sessionId, ...(expected ? [expected.value] : []));
    }
    const plan = prepareSessionMetaCollectionWrite(db, sessionId, column, value);
    if (
        !plan.previous.token.present ||
        (expected && !collectionStateMatches(db, plan.previous, expected.value))
    )
        return { changes: 0 };
    if (isUnchanged(plan)) return { changes: 1 };
    return {
        changes: db.transaction(() => applySessionMetaCollectionWrite(db, plan)).immediate()
            ? 1
            : 0,
    };
}

/**
 * The stored chunks already hold exactly the value being written. The plan was built
 * from a revision-checked snapshot, so the write takes effect at that read: taking the
 * writer lock only to confirm that nothing changes would cost a transaction (or a
 * savepoint inside the caller's) on every pass that rewrites an unchanged value.
 */
function isUnchanged(plan: PreparedSessionMetaCollectionWrite): boolean {
    return plan.changed.length === 0 && plan.removed.length === 0;
}

export interface PreparedSessionMetaCollectionWrite {
    sessionId: string;
    column: SessionMetaCollection;
    previous: CollectionState;
    next: CollectionState;
    changed: Array<[string, CollectionPiece]>;
    removed: string[];
}

function prepareBytes(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
    bytes: Buffer | null,
    storageType: string,
    value?: string | null,
): PreparedSessionMetaCollectionWrite {
    const previous = readCollectionState(db, sessionId, column);
    if (
        storageType === "text" &&
        value !== undefined &&
        previous.value === value &&
        (value === null
            ? previous.pieces.size === 1 && previous.pieces.get("-1")?.type === "null"
            : previous.textExact) &&
        (value !== SESSION_META_COLLECTION_DEFAULTS[column] || previous.pieces.size === 0)
    ) {
        return { sessionId, column, previous, next: { ...previous }, changed: [], removed: [] };
    }
    const pieces = new Map<string, CollectionPiece>();
    const isDefault =
        storageType === "text" &&
        bytes !== null &&
        bytes.equals(Buffer.from(SESSION_META_COLLECTION_DEFAULTS[column]));
    if (!isDefault) {
        const marker =
            bytes === null ? null : storageType === "text" ? Buffer.alloc(0) : storageType;
        pieces.set("-1", {
            type: marker === null ? "null" : typeof marker === "string" ? "text" : "blob",
            bytes:
                marker === null ? null : typeof marker === "string" ? Buffer.from(marker) : marker,
            marker,
        });
        if (bytes !== null)
            for (const [key, body] of layoutSessionMetaBytes(bytes)) {
                const old = previous.pieces.get(key);
                if (old?.type === "blob" && old.bytes?.equals(body)) pieces.set(key, old);
                else {
                    // Copy changed fragments so later reuse does not keep earlier full serialized envelopes alive.
                    pieces.set(key, { type: "blob", bytes: Buffer.from(body) });
                }
            }
    }
    const sourceExact = typeof value === "string" && isWellFormedCollectionText(value);
    const textExact = storageType !== "blob" && bytes !== null && (sourceExact || isUtf8(bytes));
    const next: CollectionState = {
        token: previous.token,
        pieces,
        value:
            bytes === null
                ? null
                : storageType === "blob"
                  ? bytes
                  : sourceExact
                    ? value
                    : decodeCollectionText(db, bytes, textExact),
        rawBytes: bytes ?? Buffer.alloc(0),
        textExact,
        rollbackGeneration: previous.rollbackGeneration,
        retainedBytes: (bytes?.byteLength ?? 0) * 4 + pieces.size * 256,
    };
    const changed: Array<[string, CollectionPiece]> = [];
    for (const [key, piece] of pieces) {
        const old = previous.pieces.get(key);
        if (
            old &&
            old.type === piece.type &&
            (piece.bytes === null ? old.bytes === null : old.bytes?.equals(piece.bytes))
        )
            continue;
        changed.push([key, piece]);
    }
    return {
        sessionId,
        column,
        previous,
        next,
        changed,
        removed: [...previous.pieces.keys()].filter((key) => !pieces.has(key)),
    };
}

export function prepareSessionMetaCollectionWrite(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
    value: string | null,
): PreparedSessionMetaCollectionWrite {
    return prepareBytes(
        db,
        sessionId,
        column,
        value === null ? null : Buffer.from(value, "utf8"),
        "text",
        value,
    );
}

/** Caller owns the writer transaction; false means it must discard this plan and reread the winner. */
export function applySessionMetaCollectionWrite(
    db: Database,
    plan: PreparedSessionMetaCollectionWrite,
): boolean {
    if (!isSqliteTransactionOpen(db))
        throw new Error("collection publication requires a writer transaction");
    const current = readCollectionToken(db, plan.sessionId, plan.column);
    // SQLite triggers increment the revision for every chunk INSERT/UPDATE/DELETE, including raw SQL.
    // An unchanged revision-row ID and revision prove that these chunks (including storage-class markers)
    // have not changed since this delta was prepared, replacing the full-value IS comparison under the lock.
    if (!current.present || !sameCollectionToken(current, plan.previous.token)) return false;
    if (plan.changed.length) {
        const upsert = sessionPayloadStatement(
            db,
            `INSERT INTO session_meta_chunks(session_id,column_name,chunk,body) VALUES(?,?,?,?)
        ON CONFLICT(session_id,column_name,chunk) DO UPDATE SET body=excluded.body WHERE body IS NOT excluded.body`,
        );
        for (const [key, piece] of plan.changed)
            upsert.run(plan.sessionId, plan.column, key, key === "-1" ? piece.marker : piece.bytes);
    }
    if (plan.removed.length) {
        const remove = sessionPayloadStatement(
            db,
            "DELETE FROM session_meta_chunks WHERE session_id=? AND column_name=? AND chunk=?",
        );
        for (const key of plan.removed) remove.run(plan.sessionId, plan.column, key);
    }
    plan.next.token =
        plan.changed.length || plan.removed.length
            ? readCollectionToken(db, plan.sessionId, plan.column)
            : current;
    rememberCollectionState(db, plan.sessionId, plan.column, plan.next);
    return true;
}
