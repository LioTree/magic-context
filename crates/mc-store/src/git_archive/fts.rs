//! SQLite source and FTS schema used by the TypeScript git-commit producer.

use rusqlite::Connection;

/// Install the git archive tables and write-through FTS triggers on an owned connection.
/// Existing context databases already have these objects; installation is idempotent.
pub fn initialize_schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS git_commits (
            sha TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            short_sha TEXT NOT NULL,
            message TEXT NOT NULL,
            author TEXT,
            committed_at INTEGER NOT NULL,
            indexed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_git_commits_project_time
            ON git_commits(project_path, committed_at DESC);
        CREATE TABLE IF NOT EXISTS git_commit_embeddings (
            sha TEXT PRIMARY KEY,
            embedding BLOB NOT NULL,
            model_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS git_commits_fts USING fts5(
            sha UNINDEXED,
            project_path UNINDEXED,
            message,
            tokenize = 'porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS git_commits_fts_insert
        AFTER INSERT ON git_commits BEGIN
            DELETE FROM git_commits_fts WHERE sha = NEW.sha;
            INSERT INTO git_commits_fts(sha, project_path, message)
            VALUES (NEW.sha, NEW.project_path, NEW.message);
        END;
        CREATE TRIGGER IF NOT EXISTS git_commits_fts_delete
        AFTER DELETE ON git_commits BEGIN
            DELETE FROM git_commits_fts WHERE sha = OLD.sha;
        END;
        CREATE TRIGGER IF NOT EXISTS git_commits_fts_update
        AFTER UPDATE OF message, project_path ON git_commits BEGIN
            DELETE FROM git_commits_fts WHERE sha = OLD.sha;
            INSERT INTO git_commits_fts(sha, project_path, message)
            VALUES (NEW.sha, NEW.project_path, NEW.message);
        END;",
    )
}
