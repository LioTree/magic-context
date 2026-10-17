import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { MIGRATIONS, runMigrations } from "./migrations";
import { enforceSchemaFence, initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { TRIM_SOURCE_CANDIDATES_SQL } from "./storage-tags";

const indexes = (db: Database) =>
    db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE name IN (
        'idx_tags_session_message_nocase', 'idx_tags_session_tool_owner'
    ) ORDER BY name`)
        .all();

describe("migration 101", () => {
    test("tolerates a sparse legacy database without tags", () => {
        const db = new Database(":memory:");
        try {
            MIGRATIONS.find((entry) => entry.version === 101)!.up(db);
            expect(indexes(db)).toEqual([]);
        } finally {
            db.close();
        }
    });

    test("populated v100 upgrades preserve tags and pending operations and match fresh indexes", () => {
        const db = new Database(":memory:");
        const fresh = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.exec(`DROP INDEX idx_tags_session_message_nocase;
                DROP INDEX idx_tags_session_tool_owner;
                DELETE FROM schema_migrations WHERE version >= 101;
                INSERT INTO tags(session_id, tag_number, message_id, type, status, tool_owner_message_id)
                    VALUES ('s',1,'new:p0','message','active',NULL),
                           ('s',2,'call','tool','dropped','new');
                INSERT INTO pending_ops(session_id,tag_id,operation) VALUES ('s',2,'drop');`);
            expect(indexes(db)).toEqual([]);
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: 100,
            });
            const tags = db.prepare("SELECT * FROM tags ORDER BY id").all();
            const ops = db.prepare("SELECT * FROM pending_ops").all();
            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(102);
            expect(MIGRATIONS.at(-1)?.version).toBe(102);
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: 102,
            });
            expect(db.prepare("SELECT * FROM tags ORDER BY id").all()).toEqual(tags);
            expect(db.prepare("SELECT * FROM pending_ops").all()).toEqual(ops);
            initializeDatabase(fresh);
            expect(indexes(db)).toEqual(indexes(fresh));
            expect(indexes(db)).toHaveLength(2);
            MIGRATIONS.find((entry) => entry.version === 101)!.up(db);
            runMigrations(db);
            expect(indexes(db)).toEqual(indexes(fresh));
            const plan = db
                .prepare(`EXPLAIN QUERY PLAN ${TRIM_SOURCE_CANDIDATES_SQL}`)
                .all("s", '["new"]') as { detail: string }[];
            expect(plan.filter((row) => row.detail.includes("SEARCH t"))).toHaveLength(4);
            expect(enforceSchemaFence(db, ":previous:", 100)).toBe(false);
            expect(enforceSchemaFence(db, ":current:", 102)).toBe(true);
            expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        } finally {
            db.close();
            fresh.close();
        }
    });
});
