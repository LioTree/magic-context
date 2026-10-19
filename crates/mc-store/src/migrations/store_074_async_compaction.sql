CREATE TABLE mc_async_compaction (
    session_ref TEXT PRIMARY KEY,
    conversation_key TEXT NOT NULL UNIQUE,
    session TEXT NOT NULL,
    state_json TEXT NOT NULL,
    version_high_water INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mc_async_compaction_views (
    session_ref TEXT NOT NULL,
    session TEXT NOT NULL,
    version INTEGER NOT NULL,
    view_json TEXT NOT NULL,
    announced INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_ref, version),
    FOREIGN KEY (session_ref) REFERENCES mc_async_compaction(session_ref)
);
