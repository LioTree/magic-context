import type { Database } from "../../shared/sqlite";

/** Find tags for messages removed from the served tail without scanning older session tags. */
export function installTrimSourceIndexes(db: Database): void {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_session_message_nocase
        ON tags(session_id, message_id COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_tags_session_tool_owner
        ON tags(session_id, tool_owner_message_id);`);

    if (
        !db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'")
            .get()
    )
        return;
    const rows = db.prepare("SELECT idx FROM sqlite_stat1 WHERE tbl = 'tags'").all() as {
        idx: string | null;
    }[];
    if (rows.length === 0) return;
    const analyzed = new Set(rows.map((row) => row.idx));
    if (
        !analyzed.has("idx_tags_session_message_nocase") ||
        !analyzed.has("idx_tags_session_tool_owner")
    ) {
        // Mixed analyzed and unanalyzed indexes can make each ordered tag page
        // sort the whole session. Refresh all tag estimates together, including
        // stores whose indexes were installed by the native migrator already.
        db.exec("ANALYZE tags");
    }
}
