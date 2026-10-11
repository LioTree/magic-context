-- cortexkit-store otherwise creates its local writer epoch on the first fenced
-- write. Materialize the same schema now so the inventory is deterministic.
CREATE TABLE IF NOT EXISTS cortexkit_fence (id INTEGER PRIMARY KEY CHECK (id = 0), epoch INTEGER NOT NULL);
CREATE TABLE mc_move_fences (
    session_id TEXT PRIMARY KEY, cut_id TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL CHECK(phase IN ('draining','frozen','staged','discarding'))
);
CREATE TABLE mc_move_cuts (
    cut_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, binding TEXT NOT NULL,
    manifest_digest TEXT NOT NULL, state TEXT NOT NULL
        CHECK(state IN ('exporting','sealed','aborted','staged','installed','discarding','discarded','activated')),
    result TEXT, file_path TEXT, discard_table INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mc_move_installs (
    cut_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
    manifest_digest TEXT NOT NULL, table_index INTEGER NOT NULL DEFAULT 0,
    file_offset INTEGER NOT NULL DEFAULT 0, rows_remaining INTEGER NOT NULL DEFAULT -1,
    last_source_key BLOB, complete INTEGER NOT NULL DEFAULT 0,
    prior_generation INTEGER NOT NULL DEFAULT 0, shipped_generation INTEGER NOT NULL DEFAULT 0,
    tag_count INTEGER NOT NULL DEFAULT 0, max_tag_number INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mc_move_key_map (
    cut_id TEXT NOT NULL, table_name TEXT NOT NULL, source_key BLOB NOT NULL,
    destination_key BLOB NOT NULL, PRIMARY KEY(cut_id, table_name, source_key)
);
-- Survives discard: a live module may still remember an earlier generation.
CREATE TABLE mc_move_tag_epochs (session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
