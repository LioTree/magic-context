import type { Database } from "../../shared/sqlite";

/**
 * Give a database just created by `initializeDatabase` the session_meta columns every
 * database from before migration 103 has, as the migrations before 103 find it.
 *
 * The current initializer starts a new database in the separated layout, so a test
 * that replays the migrations before 103 on populated rows must first put the payload
 * columns back, with the definitions those columns had. The payload tables stay: the
 * initializer also creates them when it opens an older database, before the migrations
 * run. The columns land at the end of the table rather than in their old positions;
 * schema identity compares columns by name, so the position does not matter.
 */
export function restorePreV103SessionMetaLayout(db: Database): void {
    db.exec(`ALTER TABLE session_meta ADD COLUMN note_nudge_anchors TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE session_meta ADD COLUMN auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE session_meta ADD COLUMN memory_block_cache TEXT DEFAULT '';
        ALTER TABLE session_meta ADD COLUMN memory_block_ids TEXT DEFAULT '';
        ALTER TABLE session_meta ADD COLUMN cached_m0_bytes BLOB;
        ALTER TABLE session_meta ADD COLUMN cached_m1_bytes BLOB;
        ALTER TABLE session_meta ADD COLUMN cached_m0_upgrade_state TEXT;
        ALTER TABLE session_meta ADD COLUMN stripped_placeholder_ids TEXT DEFAULT '';
        ALTER TABLE session_meta ADD COLUMN stale_reduce_stripped_ids TEXT DEFAULT '';
        ALTER TABLE session_meta ADD COLUMN processed_image_stripped_ids TEXT DEFAULT '';
        ALTER TABLE session_meta ADD COLUMN merged_reasoning_stripped_ids TEXT DEFAULT '';
        ALTER TABLE session_meta ADD COLUMN trailing_blank_decisions TEXT DEFAULT '';
        ALTER TABLE session_meta ADD COLUMN cached_m0_mural_data_url TEXT;`);
}
