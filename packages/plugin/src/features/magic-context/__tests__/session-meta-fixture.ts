import type { Database } from "../../../shared/sqlite";
import {
    isSessionRenderCacheColumn,
    readSessionRenderCache,
    SESSION_RENDER_CACHE_COLUMNS,
    writeSessionRenderCache,
} from "../storage-session-cache";
import {
    isSessionMetaCollection,
    isSessionMetaCollectionInline,
    readSessionMetaCollection,
    SESSION_META_COLLECTION_DEFAULTS,
    writeSessionMetaCollection,
} from "../storage-session-collections";

type Value = string | number | Buffer | Uint8Array | null;

function separated(db: Database, key: string): boolean {
    if (isSessionMetaCollection(key)) return !isSessionMetaCollectionInline(db, key);
    return (
        isSessionRenderCacheColumn(key) &&
        !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_render_cache'").get()
    );
}

/** Seed a logical metadata fixture while keeping render payloads in their physical rows. */
export function seedSessionMeta(db: Database, row: Record<string, Value>, replace = false): void {
    db.transaction(() => {
        if (replace) {
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_render_cache'").get())
                db.prepare("DELETE FROM session_render_cache WHERE session_id=?").run(
                    row.session_id,
                );
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_meta_chunks'").get())
                db.prepare("DELETE FROM session_meta_chunks WHERE session_id=?").run(
                    row.session_id,
                );
        }
        const metadata = Object.entries(row).filter(([key]) => !separated(db, key));
        db.prepare(
            `INSERT ${replace ? "OR REPLACE " : ""}INTO session_meta (${metadata.map(([key]) => key).join(",")}) VALUES (${metadata.map(() => "?").join(",")})`,
        ).run(...metadata.map(([, value]) => value));
        for (const [key, value] of Object.entries(row)) {
            if (separated(db, key) && isSessionMetaCollection(key))
                writeSessionMetaCollection(db, String(row.session_id), key, value as string | null);
            if (separated(db, key) && isSessionRenderCacheColumn(key))
                writeSessionRenderCache(
                    db,
                    String(row.session_id),
                    key,
                    value as Buffer | string | null,
                );
        }
    }).immediate();
}

export function patchSessionMeta(
    db: Database,
    sessionId: string,
    updates: Record<string, Value>,
): void {
    db.transaction(() => {
        const metadata = Object.entries(updates).filter(([key]) => !separated(db, key));
        if (metadata.length)
            db.prepare(
                `UPDATE session_meta SET ${metadata.map(([key]) => `${key}=?`).join(",")} WHERE session_id=?`,
            ).run(...metadata.map(([, value]) => value), sessionId);
        for (const [key, value] of Object.entries(updates)) {
            if (separated(db, key) && isSessionMetaCollection(key))
                writeSessionMetaCollection(db, sessionId, key, value as string | null);
            if (separated(db, key) && isSessionRenderCacheColumn(key))
                writeSessionRenderCache(db, sessionId, key, value as Buffer | string | null);
        }
    }).immediate();
}

/** Inspect the logical legacy row shape without confusing absent payload columns with absent bytes. */
export function sessionMetaFixtureRows(
    db: Database,
    sessionId?: string,
): Record<string, unknown>[] {
    const rows = db
        .prepare(
            `SELECT * FROM session_meta${sessionId === undefined ? "" : " WHERE session_id=?"}`,
        )
        .all(...(sessionId === undefined ? [] : [sessionId])) as Record<string, unknown>[];
    const cache = !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='session_render_cache'")
        .get();
    for (const row of rows) {
        const id = String(row.session_id);
        for (const column of SESSION_RENDER_CACHE_COLUMNS) {
            if (cache && (row[column] === undefined || row[column] === null || row[column] === ""))
                row[column] = readSessionRenderCache(db, id, column);
        }
        for (const column of Object.keys(
            SESSION_META_COLLECTION_DEFAULTS,
        ) as (keyof typeof SESSION_META_COLLECTION_DEFAULTS)[]) {
            if (row[column] === undefined && separated(db, column))
                row[column] = readSessionMetaCollection(db, id, column);
        }
    }
    return rows.map((row) =>
        Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
    );
}

export function editCachedUpgradeFixture(
    db: Database,
    sessionId: string,
    change: (value: string | null) => string | null,
): void {
    const value = readSessionRenderCache(db, sessionId, "cached_m0_upgrade_state");
    if (value !== null && typeof value !== "string")
        throw new Error("Upgrade fixture must contain text or NULL");
    writeSessionRenderCache(db, sessionId, "cached_m0_upgrade_state", change(value));
}

export function sessionMetaFixtureRow(
    db: Database,
    sessionId?: string,
): Record<string, unknown> | null {
    return sessionMetaFixtureRows(db, sessionId)[0] ?? null;
}
