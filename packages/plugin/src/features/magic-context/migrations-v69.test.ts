/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database, type Database as DatabaseType } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { schemaSnapshot } from "./schema-fingerprint";
import { initializeDatabase } from "./storage-db";

function makePreV65ReplayFixture(db: DatabaseType): void {
    // Start from the complete prior object set, then remove only the v65-v69
    // artifacts. This keeps the fixture compact while making every versioned
    // column and index flow through migrations rather than fresh declarations.
    //
    // Replay subsequent column additions too, so the fixture exercises the
    // migration chain rather than relying on columns supplied by the initializer.
    db.exec(`
        ALTER TABLE memories DROP COLUMN verify_commit;
        ALTER TABLE memories DROP COLUMN verify_files_json;
        ALTER TABLE memories DROP COLUMN verify_result;
        ALTER TABLE memories DROP COLUMN revision;
        ALTER TABLE memories DROP COLUMN mural_cue_rejection_count;
        ALTER TABLE memories DROP COLUMN mural_cue_at;
        ALTER TABLE memories DROP COLUMN mural_cue_hash;
        ALTER TABLE memories DROP COLUMN mural_cue;
        ALTER TABLE session_meta DROP COLUMN coordinate_rebase_notice;
        ALTER TABLE session_meta DROP COLUMN coordinate_generation;
        ALTER TABLE session_meta DROP COLUMN cached_m0_mural_hash;
        ALTER TABLE session_meta DROP COLUMN cached_m0_mural_data_url;
        ALTER TABLE session_meta DROP COLUMN upgrade_reminder_count;
        ALTER TABLE session_meta DROP COLUMN upgrade_reminder_last_sent_at;
        DROP INDEX idx_memory_mutation_log_visibility;
        DROP INDEX idx_memory_mutation_log_target;
        DELETE FROM schema_migrations WHERE version >= 65;
    `);
}

function mutationPlanDetails(db: DatabaseType): { visibility: string[]; target: string[] } {
    const visibility = db
        .prepare(
            `EXPLAIN QUERY PLAN
             SELECT DISTINCT target_memory_id
               FROM memory_mutation_log
              WHERE project_path IN (?, ?)
                AND id > ?
                AND category = ?`,
        )
        .all("project-a", "project-b", 0, "__mc_visibility__") as Array<{ detail: string }>;
    const target = db
        .prepare(
            `EXPLAIN QUERY PLAN
             SELECT id, project_path, mutation_type, target_memory_id,
                    superseded_by_id, category, new_content, queued_at
               FROM memory_mutation_log
              WHERE project_path IN (?, ?)
                AND id > ?
                AND target_memory_id IN (?, ?)
              ORDER BY id ASC`,
        )
        .all("project-a", "project-b", 0, 1, 2) as Array<{ detail: string }>;
    return {
        visibility: visibility.map((row) => row.detail),
        target: target.map((row) => row.detail),
    };
}

function expectMutationPlansUseV69Indexes(db: DatabaseType): void {
    const plans = mutationPlanDetails(db);
    expect(
        plans.visibility.some((detail) => detail.includes("idx_memory_mutation_log_visibility")),
    ).toBe(true);
    expect(plans.target.some((detail) => detail.includes("idx_memory_mutation_log_target"))).toBe(
        true,
    );
}

describe("migration v69: visibility mutation indexes", () => {
    test("fresh schema uses both measured indexes for the production query shapes", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expectMutationPlansUseV69Indexes(db);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades a v68 mutation log and changes both query plans", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    description TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO schema_migrations VALUES (68, 'v68 fixture', 1);
                CREATE TABLE memory_mutation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    mutation_type TEXT NOT NULL,
                    target_memory_id INTEGER NOT NULL,
                    superseded_by_id INTEGER,
                    category TEXT,
                    new_content TEXT,
                    queued_at INTEGER NOT NULL
                );
                CREATE INDEX idx_memory_mutation_log_project
                    ON memory_mutation_log(project_path, id);
            `);

            runMigrations(db);

            expectMutationPlansUseV69Indexes(db);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("fresh and replayed schema convergence", () => {
    test("canonical schema definitions are exactly equal regardless of column order", () => {
        const fresh = new Database(":memory:");
        const replay = new Database(":memory:");
        const initializerUpgrade = new Database(":memory:");
        try {
            for (const db of [fresh, replay, initializerUpgrade]) {
                initializeDatabase(db);
                runMigrations(db);
            }
            makePreV65ReplayFixture(replay);
            makePreV65ReplayFixture(initializerUpgrade);

            runMigrations(replay);
            initializeDatabase(initializerUpgrade);
            runMigrations(initializerUpgrade);

            const expected = schemaSnapshot(fresh);
            expect(schemaSnapshot(replay)).toEqual(expected);
            expect(schemaSnapshot(initializerUpgrade)).toEqual(expected);
        } finally {
            closeQuietly(fresh);
            closeQuietly(replay);
            closeQuietly(initializerUpgrade);
        }
    });
});
