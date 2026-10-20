import type { Database } from "../../shared/sqlite";

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
            }
            return removed.changes;
        })
        .immediate();
}
