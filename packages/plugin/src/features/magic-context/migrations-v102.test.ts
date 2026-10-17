import { describe, expect, test } from "bun:test";
import { saveLkgSlotToDb } from "../../hooks/magic-context/lkg-persist";
import {
    checkLkgDurability,
    readServedMarker,
    recordServedCapture,
} from "../../hooks/magic-context/lkg-served-marker";
import { Database } from "../../shared/sqlite";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import { enforceSchemaFence, initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

const markerColumns = (db: Database) =>
    db
        .prepare(
            "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('lkg_served_markers') ORDER BY cid",
        )
        .all();

const slot = (jsonPrefix: string, servedCaptureId?: number) => ({
    jsonPrefix,
    inputIdSeq: ["u"],
    inputContentDigests: ["digest"],
    inputMoveDigests: ["a".repeat(64)],
    lastInputMessageId: "u",
    modelKey: "m",
    providerKey: "p",
    capturedAt: 1,
    rowVersion: 900,
    captureSequence: 3,
    servedCaptureId,
    fullCoverage: true,
});

describe("migration 102", () => {
    test("tolerates a sparse legacy database without served markers", () => {
        const db = new Database(":memory:");
        try {
            MIGRATIONS.find((entry) => entry.version === 102)!.up(db);
            expect(markerColumns(db)).toEqual([]);
        } finally {
            db.close();
        }
    });

    test("a populated v101 store keeps its markers and slots, unbound until the next served save", () => {
        const db = new Database(":memory:");
        const fresh = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            // Rebuild the exact v101 shape: no digest column, one certified pair
            // written by the previous release, ids matching.
            db.exec(`ALTER TABLE lkg_served_markers DROP COLUMN served_digest;
                DELETE FROM schema_migrations WHERE version >= 102;
                INSERT INTO lkg_served_markers(session_id, served_capture_id, full_coverage, slot_state)
                    VALUES ('legacy', 4, 1, 'captured'), ('dropped', 2, 0, 'lkg_refresh_declined');`);
            expect(markerColumns(db).map((column) => (column as { name: string }).name)).toEqual([
                "session_id",
                "served_capture_id",
                "full_coverage",
                "slot_state",
            ]);
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: 101,
            });
            const before = db.prepare("SELECT * FROM lkg_served_markers ORDER BY session_id").all();
            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(MIGRATIONS.filter((entry) => entry.version === 102)).toHaveLength(1);
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: LATEST_MIGRATION_VERSION,
            });
            expect(
                db.prepare("SELECT * FROM lkg_served_markers ORDER BY session_id").all(),
            ).toEqual(
                (before as Array<Record<string, unknown>>).map((row) => ({
                    ...row,
                    served_digest: null,
                })),
            );
            initializeDatabase(fresh);
            runMigrations(fresh);
            expect(markerColumns(db)).toEqual(markerColumns(fresh));
            expect(markerColumns(db).at(-1)).toEqual({
                name: "served_digest",
                type: "TEXT",
                notnull: 0,
                dflt_value: null,
            });
            // Re-running the step is idempotent.
            MIGRATIONS.find((entry) => entry.version === 102)!.up(db);
            expect(markerColumns(db)).toEqual(markerColumns(fresh));

            // A pre-upgrade pair with matching ids is not certified by id alone.
            db.prepare(
                `INSERT INTO lkg_slots (session_id, json_prefix_chars, json_prefix_chunks,
                    json_prefix_hash, input_id_seq, input_content_digests, last_input_message_id,
                    captured_at, served_capture_id)
                 VALUES ('legacy', 0, 0, 'h', '["u"]', '["digest"]', 'u', 1, 4)`,
            ).run();
            expect(checkLkgDurability(db, "legacy")).toEqual({
                durable: true,
                servedCaptureId: null,
                certified: false,
            });
            // The next real serve and save bind the marker and certify again.
            const next = slot(
                '[{"text":"served after upgrade"}]',
                recordServedCapture(db, "legacy", true),
            );
            expect(next.servedCaptureId).toBe(5);
            expect(saveLkgSlotToDb(db, "legacy", next)).toBe(true);
            expect(checkLkgDurability(db, "legacy")).toEqual({ durable: true, servedCaptureId: 5 });
            expect(readServedMarker(db, "legacy")?.servedDigest).toMatch(/^[0-9a-f]{64}$/);
            expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        } finally {
            db.close();
            fresh.close();
        }
    });

    test("the previous binary refuses the migrated context database", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(enforceSchemaFence(db, ":previous-binary:", 101)).toBe(false);
            expect(enforceSchemaFence(db, ":current-binary:", LATEST_SUPPORTED_VERSION)).toBe(true);
        } finally {
            db.close();
        }
    });
});
