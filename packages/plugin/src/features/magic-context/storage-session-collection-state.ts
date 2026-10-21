import { isUtf8 } from "node:buffer";
import { type Database, getSqliteRollbackGeneration } from "../../shared/sqlite";
import {
    SESSION_META_COLLECTION_DEFAULTS,
    type SessionMetaCollection,
} from "./session-meta-collection-schema";

export type CollectionToken = { present: boolean; id: string | null; revision: string | null };
export type CollectionPiece = { type: string; bytes: Buffer | null; marker?: unknown };
export type CollectionState = {
    token: CollectionToken;
    pieces: Map<string, CollectionPiece>;
    value: unknown;
    rawBytes: Buffer;
    textExact: boolean;
    rollbackGeneration: number;
    retainedBytes: number;
};
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_ENTRIES = 32;
const caches = new WeakMap<Database, Map<string, CollectionState>>();
const keyFor = (sessionId: string, column: SessionMetaCollection) =>
    JSON.stringify([sessionId, column]);

export function sameCollectionToken(a: CollectionToken, b: CollectionToken): boolean {
    return a.present === b.present && a.id === b.id && a.revision === b.revision;
}

/** One indexed revision lookup also checks that the owning metadata row still exists. */
export function readCollectionToken(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
): CollectionToken {
    const row = db
        .prepare(`SELECT CAST(revisions.id AS TEXT) AS id, CAST(revisions.revision AS TEXT) AS revision
        FROM session_meta AS owner LEFT JOIN session_meta_collection_revisions AS revisions
        ON revisions.session_id=owner.session_id AND revisions.column_name=? WHERE owner.session_id=?`)
        .get(column, sessionId) as
        | { id: string | null; revision: string | null }
        | null
        | undefined;
    return { present: row != null, id: row?.id ?? null, revision: row?.revision ?? null };
}

export function clearCollectionStates(db: Database): void {
    caches.delete(db);
}

export function rememberCollectionState(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
    state: CollectionState,
): void {
    const rollbackGeneration = getSqliteRollbackGeneration(db);
    if (rollbackGeneration === undefined) return;
    let cache = caches.get(db);
    if (!cache) {
        cache = new Map();
        caches.set(db, cache);
    }
    const key = keyFor(sessionId, column);
    cache.delete(key);
    if (state.retainedBytes > CACHE_BYTES) return;
    state.rollbackGeneration = rollbackGeneration;
    cache.set(key, state);
    let bytes = [...cache.values()].reduce((n, value) => n + value.retainedBytes, 0);
    while (cache.size > CACHE_ENTRIES || bytes > CACHE_BYTES) {
        const first = cache.entries().next().value;
        if (!first) break;
        bytes -= first[1].retainedBytes;
        cache.delete(first[0]);
    }
}

export function collectionStateFromPieces(
    db: Database,
    token: CollectionToken,
    pieces: Map<string, CollectionPiece>,
    column: SessionMetaCollection,
): CollectionState {
    const marker = pieces.get("-1");
    const bodies = [...pieces].flatMap(([key, piece]) =>
        key !== "-1" && piece.bytes !== null ? [piece.bytes] : [],
    );
    const raw = Buffer.concat(bodies);
    let rawBytes = Buffer.from(SESSION_META_COLLECTION_DEFAULTS[column]);
    let textExact = true;
    let value: unknown = SESSION_META_COLLECTION_DEFAULTS[column];
    if (marker) {
        rawBytes = raw;
        if (marker.type === "null") {
            value = null;
            textExact = false;
        } else if (marker.type === "integer" || marker.type === "real") {
            value = marker.marker;
            textExact = false;
        } else if (marker.type === "text" && marker.marker === "blob") {
            value = raw;
            textExact = false;
        } else {
            textExact = isUtf8(raw);
            value = decodeCollectionText(db, raw, textExact);
        }
    }
    return {
        token,
        pieces,
        value,
        rawBytes,
        textExact,
        rollbackGeneration: 0,
        retainedBytes: raw.byteLength * 4 + pieces.size * 256,
    };
}

/** Raw values and their actual stored layout share one snapshot; cache hits still recheck the revision. */
export function readCollectionState(
    db: Database,
    sessionId: string,
    column: SessionMetaCollection,
): CollectionState {
    const token = readCollectionToken(db, sessionId, column);
    const key = keyFor(sessionId, column),
        cache = caches.get(db),
        cached = cache?.get(key);
    if (
        cache &&
        cached &&
        cached.rollbackGeneration === getSqliteRollbackGeneration(db) &&
        sameCollectionToken(cached.token, token)
    ) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }
    return db
        .transaction(() => {
            const coherent = readCollectionToken(db, sessionId, column);
            const pieces = new Map<string, CollectionPiece>();
            if (coherent.present) {
                const rows = db
                    .prepare(`SELECT chunk, typeof(body) AS storage_type, CAST(body AS BLOB) AS bytes,
                CASE WHEN chunk='-1' THEN body END AS marker
                FROM session_meta_chunks WHERE session_id=? AND column_name=? ORDER BY chunk`)
                    .all(sessionId, column) as {
                    chunk: string;
                    storage_type: string;
                    bytes: Uint8Array | null;
                    marker: unknown;
                }[];
                for (const row of rows)
                    pieces.set(row.chunk, {
                        type: row.storage_type,
                        bytes: row.bytes === null ? null : Buffer.from(row.bytes),
                        marker: row.marker,
                    });
            }
            // Existing chunks without a revision cannot be validated safely against another writer's changes.
            if (pieces.size > 0 && coherent.id === null)
                throw new Error("Session collection chunks have no durable revision");
            const state = collectionStateFromPieces(db, coherent, pieces, column);
            rememberCollectionState(db, sessionId, column, state);
            return state;
        })
        .deferred();
}

/** Preserve SQLite IS storage-class distinctions without reconstructing a value under the writer lock. */
export function collectionStateMatches(
    db: Database,
    state: CollectionState,
    expected: unknown,
): boolean {
    const actual = state.value;
    if (actual === null || expected === null || expected === undefined)
        return actual === null && expected == null;
    if (actual instanceof Uint8Array)
        return expected instanceof Uint8Array && Buffer.from(actual).equals(Buffer.from(expected));
    if (typeof actual === "string") {
        if (typeof expected !== "string") return false;
        if (state.textExact) {
            if (actual === expected) return true;
            if (isWellFormedCollectionText(expected)) return false;
        }
        // Invalid stored UTF-8 and lone-surrogate bindings must retain SQLite's byte-exact IS semantics.
        return (
            (
                db
                    .prepare("SELECT CAST(? AS TEXT) IS ? AS matched")
                    .get(state.rawBytes, expected) as { matched: number }
            ).matched === 1
        );
    }
    const marker = state.pieces.get("-1");
    if (marker?.type === "integer")
        return (
            (
                db
                    .prepare("SELECT CAST(? AS INTEGER) IS ? AS matched")
                    .get(marker.bytes?.toString("utf8"), expected) as { matched: number }
            ).matched === 1
        );
    return (
        (db.prepare("SELECT ? IS ? AS matched").get(actual, expected) as { matched: number })
            .matched === 1
    );
}

/** The supported runtimes expose this boolean check without allocating a normalized copy of a large string. */
export function isWellFormedCollectionText(value: string): boolean {
    return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

export function decodeCollectionText(db: Database, bytes: Buffer, valid = isUtf8(bytes)): string {
    if (valid) return bytes.toString("utf8");
    return (db.prepare("SELECT CAST(? AS TEXT) AS value").get(bytes) as { value: string }).value;
}
