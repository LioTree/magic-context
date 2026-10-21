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

export const SESSION_META_CHUNKS_DDL = `CREATE TABLE IF NOT EXISTS session_meta_chunks (
    session_id TEXT NOT NULL,
    column_name TEXT NOT NULL,
    chunk TEXT NOT NULL,
    body BLOB,
    PRIMARY KEY (session_id, column_name, chunk)
) WITHOUT ROWID`;

const bump = (
    row: "NEW" | "OLD",
    predicate = "1",
) => `INSERT INTO session_meta_collection_revisions(session_id,column_name,revision)
    SELECT ${row}.session_id,${row}.column_name,1 WHERE ${predicate}
    ON CONFLICT(session_id,column_name) DO UPDATE SET revision=revision+1;`;

// The incarnation ID is never reused after a committed deletion/recreation.
export const SESSION_META_COLLECTION_REVISIONS_DDL = `
CREATE TABLE IF NOT EXISTS session_meta_collection_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    column_name TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision > 0),
    UNIQUE(session_id,column_name)
);
CREATE TRIGGER IF NOT EXISTS session_meta_chunks_revision_ai AFTER INSERT ON session_meta_chunks BEGIN
    ${bump("NEW")}
END;
CREATE TRIGGER IF NOT EXISTS session_meta_chunks_revision_au AFTER UPDATE ON session_meta_chunks BEGIN
    ${bump("OLD", "OLD.session_id IS NOT NEW.session_id OR OLD.column_name IS NOT NEW.column_name")}
    ${bump("NEW")}
END;
CREATE TRIGGER IF NOT EXISTS session_meta_chunks_revision_ad AFTER DELETE ON session_meta_chunks BEGIN
    ${bump("OLD")}
END;`;
