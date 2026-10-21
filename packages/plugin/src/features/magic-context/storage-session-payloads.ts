import type { Database } from "../../shared/sqlite";
import { SESSION_META_COLLECTION_DEFAULTS } from "./session-meta-collection-schema";
import { SESSION_RENDER_CACHE_COLUMNS } from "./storage-session-cache";

/** The session_meta columns whose values migration 103 moves into their own rows. */
export const SESSION_META_PAYLOAD_COLUMNS: readonly string[] = [
    ...SESSION_RENDER_CACHE_COLUMNS,
    ...Object.keys(SESSION_META_COLLECTION_DEFAULTS),
];

/**
 * Whether session_meta still holds the values migration 103 moves out of it.
 *
 * Every database from before that migration does: the initializer gives an existing
 * session_meta all of these columns before the migrations run. A database created
 * by the current initializer starts in the separated layout instead (payload tables
 * present, none of these columns), and older migrations must not add the columns
 * back only for migration 103 to move and drop them again.
 */
export function sessionMetaHoldsPayloadColumns(db: Pick<Database, "prepare">): boolean {
    const payloadTables = db
        .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('session_render_cache', 'session_meta_chunks')",
        )
        .get() as { count: number };
    if (payloadTables.count < 2) return true;
    const columns = db.prepare("PRAGMA table_info(session_meta)").all() as { name: string }[];
    return columns.some((column) => SESSION_META_PAYLOAD_COLUMNS.includes(column.name));
}

/** Payloads formerly lived inside the metadata record and must disappear with that record. */
export function deleteSessionMetaWithPayloads(
    db: Database,
    sessionId: string,
    harness?: string,
): number {
    return db
        .transaction(() => {
            const removed =
                harness === undefined
                    ? db.prepare("DELETE FROM session_meta WHERE session_id=?").run(sessionId)
                    : db
                          .prepare("DELETE FROM session_meta WHERE session_id=? AND harness=?")
                          .run(sessionId, harness);
            if (removed.changes > 0) {
                db.prepare("DELETE FROM session_render_cache WHERE session_id=?").run(sessionId);
                db.prepare("DELETE FROM session_meta_chunks WHERE session_id=?").run(sessionId);
                db.prepare("DELETE FROM session_meta_collection_revisions WHERE session_id=?").run(
                    sessionId,
                );
            }
            return removed.changes;
        })
        .immediate();
}
