import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { schemaSnapshot } from "./schema-fingerprint";
import { initializeDatabase } from "./storage-db";
import { restorePreV103SessionMetaLayout } from "./session-meta-pre-v103-test-support";
import { SESSION_META_PAYLOAD_COLUMNS, sessionMetaHoldsPayloadColumns } from "./storage-session-payloads";

function fresh(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

// A populated store at version 102: the payload columns live in session_meta and
// the payload tables do not exist yet.
function populatedV102(): Database {
    const db = fresh();
    restorePreV103SessionMetaLayout(db);
    db.exec(`DROP TABLE session_render_cache;
        DROP TABLE session_meta_chunks;
        DROP TABLE session_meta_collection_revisions;
        DELETE FROM schema_migrations WHERE version >= 103;`);
    db.prepare(
        `INSERT INTO session_meta (session_id, cached_m0_bytes, memory_block_cache, trailing_blank_decisions, memory_block_ids)
         VALUES ('old', ?, 'memories', '{"version":2,"trailingBlank":{}}', '[1,2]')`,
    ).run(Buffer.from("m0"));
    return db;
}

const master = (db: Database) =>
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();

describe("migration 103 fresh session_meta layout", () => {
    test("a fresh database never creates the columns migration 103 moves out of session_meta", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            const afterInitializer = new Set(
                (db.prepare("PRAGMA table_info(session_meta)").all() as { name: string }[]).map(
                    (column) => column.name,
                ),
            );
            expect(SESSION_META_PAYLOAD_COLUMNS.filter((column) => afterInitializer.has(column))).toEqual(
                [],
            );
            expect(sessionMetaHoldsPayloadColumns(db)).toBe(false);
            // The migrations before 103 run on a fresh database too; none may add a column back.
            runMigrations(db);
            const sql = (
                db.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_meta'").get() as {
                    sql: string;
                }
            ).sql;
            for (const column of SESSION_META_PAYLOAD_COLUMNS) {
                expect(sql).not.toMatch(new RegExp(`\\b${column}\\b`));
            }
        } finally {
            db.close();
        }
    });

    test("a fresh database and a populated v102 database migrated to 103 end with identical schemas", () => {
        const created = fresh();
        const migrated = populatedV102();
        try {
            expect(sessionMetaHoldsPayloadColumns(migrated)).toBe(true);
            runMigrations(migrated);
            expect(sessionMetaHoldsPayloadColumns(migrated)).toBe(false);
            expect(master(migrated)).toEqual(master(created));
            expect(schemaSnapshot(migrated)).toEqual(schemaSnapshot(created));
            // The populated row's values moved rather than disappearing with their columns.
            expect(
                migrated
                    .prepare(
                        "SELECT cache_key FROM session_render_cache WHERE session_id = 'old' ORDER BY cache_key",
                    )
                    .all(),
            ).toEqual([{ cache_key: "cached_m0_bytes" }, { cache_key: "memory_block_cache" }]);
        } finally {
            created.close();
            migrated.close();
        }
    });
});
