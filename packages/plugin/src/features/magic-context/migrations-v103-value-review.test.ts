import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    getMergedReasoningStrippedIds,
    getProcessedImageStrippedIds,
    getStaleReduceStrippedIds,
    getStrippedPlaceholderIds,
} from "./storage-meta-persisted";
import { readReplayDocument } from "./storage-replay-document";

function populatedV102(encoding: string): Database {
    const db = new Database(":memory:");
    db.exec(`PRAGMA encoding='${encoding}'`);
    initializeDatabase(db);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL
    )`);
    // Build the old schema through its actual migration steps before inserting replay data.
    for (const migration of MIGRATIONS.filter((step) => step.version <= 102)) {
        db.transaction(() => {
            migration.up(db);
            db.prepare(
                "INSERT INTO schema_migrations(version,description,applied_at) VALUES(?,?,?)",
            ).run(migration.version, migration.description, 1);
        }).immediate();
    }
    db.prepare("INSERT INTO session_meta(session_id,trailing_blank_decisions) VALUES(?,?)").run(
        "encoding-review",
        '{"version":2,"trailingBlank":{},"piServedTagNumbers":[1,2]}',
    );
    return db;
}

for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"]) {
    test(`migration 103 preserves ASCII replay text in ${encoding} stores`, () => {
        const db = populatedV102(encoding);
        try {
            expect(db.prepare("PRAGMA encoding").get()).toEqual({ encoding });
            expect(
                db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
            ).toEqual({
                version: 102,
            });
            const before = readReplayDocument(db, "encoding-review");
            expect(before).toEqual({
                version: 2,
                trailingBlank: {},
                piServedTagNumbers: [1, 2],
            });

            runMigrations(db);

            // ASCII UTF-16 bytes also pass a UTF-8 validity check; that does not identify their encoding.
            expect(readReplayDocument(db, "encoding-review")).toEqual(before);
            expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        } finally {
            db.close();
        }
    });
}

for (const storageClass of ["TEXT", "BLOB"]) {
    test(`migration 103 preserves frozen decision reads from ${storageClass} JSON`, () => {
        const db = populatedV102("UTF-8");
        try {
            const json = '["assistant-from-legacy-column"]';
            const value = storageClass === "TEXT" ? json : Buffer.from(json);
            db.prepare(`UPDATE session_meta SET merged_reasoning_stripped_ids=?,
                stale_reduce_stripped_ids=?,processed_image_stripped_ids=?,
                stripped_placeholder_ids=? WHERE session_id='encoding-review'`).run(
                value,
                value,
                value,
                value,
            );
            const readFrozen = () => ({
                reasoning: [...getMergedReasoningStrippedIds(db, "encoding-review")],
                reduce: [...getStaleReduceStrippedIds(db, "encoding-review")],
                images: [...getProcessedImageStrippedIds(db, "encoding-review")],
                placeholders: [...getStrippedPlaceholderIds(db, "encoding-review")],
            });
            const ids = storageClass === "TEXT" ? ["assistant-from-legacy-column"] : [];
            const before = readFrozen();
            expect(before).toEqual({ reasoning: ids, reduce: ids, images: ids, placeholders: ids });

            runMigrations(db);

            // BLOBs previously reached JSON.parse as Uint8Array and were rejected. Buffer's string
            // conversion makes the same bytes parseable and activates previously ignored strip decisions.
            expect(readFrozen()).toEqual(before);
        } finally {
            db.close();
        }
    });
}
