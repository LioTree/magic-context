import type { Database } from "../../shared/sqlite";

/** Find tags for messages removed from the served tail without scanning older session tags. */
export function installTrimSourceIndexes(db: Database): void {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_session_message_nocase
        ON tags(session_id, message_id COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_tags_session_tool_owner
        ON tags(session_id, tool_owner_message_id);`);
}
