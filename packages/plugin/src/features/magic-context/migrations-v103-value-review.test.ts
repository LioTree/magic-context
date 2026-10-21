import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { getOrCreateSessionMeta } from "./storage-meta";
import {
    getAutoSearchHintDecisions,
    getHiddenSeamPlaceholderIds,
    getMergedReasoningStrippedIds,
    getNoteNudgeAnchors,
    getProcessedImageMarkers,
    getProcessedImageStrippedIds,
    getStaleReduceStrippedIds,
    getStrippedPlaceholderIds,
    getTrailingBlankDecisions,
} from "./storage-meta-persisted";
import { readReplayDocument } from "./storage-replay-document";
import {
    readSessionRenderCache,
    SESSION_RENDER_CACHE_COLUMNS,
    sessionRenderCacheSelect,
} from "./storage-session-cache";
import {
    isSessionMetaCollection,
    readSessionMetaCollection,
    resetSessionMetaCollectionSchema,
    SESSION_META_COLLECTION_DEFAULTS,
    sessionMetaCollectionSelect,
} from "./storage-session-collections";

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

            if (encoding === "UTF-8") {
                runMigrations(db);
            } else {
                const serialize = () => (db as unknown as { serialize(): Buffer }).serialize();
                const snapshot = serialize();
                const message = `Migration 103 requires UTF-8 database encoding; found ${encoding}`;
                expect(() => runMigrations(db)).toThrow(message);
                expect(serialize()).toEqual(snapshot);
                // The migration entry point must also be safe without the runner's rollback.
                expect(() => MIGRATIONS.find((step) => step.version === 103)!.up(db)).toThrow(
                    message,
                );
                expect(serialize()).toEqual(snapshot);
                expect(
                    db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
                ).toEqual({ version: 102 });
            }

            // Refused stores retain their original readable data as well as their schema and ledger.
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

            // BLOBs must still reach JSON.parse as Uint8Array, so previously ignored strip
            // decisions stay inactive rather than becoming parseable Buffer strings.
            expect(readFrozen()).toEqual(before);
        } finally {
            db.close();
        }
    });
}

const movedColumns = [
    ...Object.keys(SESSION_META_COLLECTION_DEFAULTS),
    ...SESSION_RENDER_CACHE_COLUMNS,
];
const jsonFor = (column: string) => {
    if (column === "trailing_blank_decisions")
        return '{"version":2,"trailingBlank":{},"piServedTagNumbers":[1,2]}';
    if (column === "note_nudge_anchors") return '[{"messageId":"m1","text":"nudge é🙂"}]';
    if (column === "auto_search_hint_decisions")
        return '[{"messageId":"m1","decision":"hint","text":"hint é🙂"}]';
    return '["assistant-from-legacy-column"]';
};

function publicReads(db: Database) {
    const id = "encoding-review";
    let replay: unknown;
    try {
        replay = readReplayDocument(db, id);
    } catch (error) {
        replay = { error: (error as Error).message };
    }
    return {
        replay,
        blanks: getTrailingBlankDecisions(db, id),
        reasoning: getMergedReasoningStrippedIds(db, id),
        reduce: getStaleReduceStrippedIds(db, id),
        images: getProcessedImageStrippedIds(db, id),
        imageMarkers: getProcessedImageMarkers(db, id),
        placeholders: getStrippedPlaceholderIds(db, id),
        hidden: getHiddenSeamPlaceholderIds(db, id),
        anchors: getNoteNudgeAnchors(db, id),
        hints: getAutoSearchHintDecisions(db, id),
        meta: getOrCreateSessionMeta(db, id),
    };
}

for (const kind of [
    "TEXT",
    "BLOB",
    "invalid UTF-8 TEXT",
    "invalid UTF-8 BLOB",
    "empty TEXT",
    "empty BLOB",
    "NULL",
]) {
    test(`migration 103 preserves all 13 moved-field readers for ${kind}`, () => {
        const db = populatedV102("UTF-8");
        try {
            const schema = db.prepare("PRAGMA table_info(session_meta)").all() as {
                name: string;
                notnull: number;
            }[];
            for (const column of movedColumns) {
                const update = db.prepare(
                    `UPDATE session_meta SET ${column}=? WHERE session_id='encoding-review'`,
                );
                if (kind === "NULL" && schema.find((entry) => entry.name === column)!.notnull) {
                    // These old NOT NULL columns cannot contain a legacy NULL to migrate.
                    expect(() => update.run(null)).toThrow("NOT NULL constraint failed");
                } else if (kind === "invalid UTF-8 TEXT") {
                    db.exec(`UPDATE session_meta SET ${column}=CAST(X'5B22FF225D' AS TEXT)
                        WHERE session_id='encoding-review'`);
                } else {
                    const value =
                        kind === "NULL"
                            ? null
                            : kind === "TEXT"
                              ? jsonFor(column)
                              : kind === "BLOB"
                                ? Buffer.from(jsonFor(column))
                                : kind === "invalid UTF-8 BLOB"
                                  ? Buffer.from([91, 34, 255, 34, 93])
                                  : kind === "empty TEXT"
                                    ? ""
                                    : Buffer.alloc(0);
                    update.run(value);
                }
            }
            // Use pre-migration SQLite values as expectations, keeping Uint8Array distinct from Buffer.
            const before = db
                .prepare(`SELECT ${movedColumns.join(",")} FROM session_meta WHERE session_id=?`)
                .get("encoding-review") as Record<string, unknown>;
            const consumersBefore = publicReads(db);
            runMigrations(db);
            for (const cold of [false, true]) {
                if (cold) resetSessionMetaCollectionSchema(db);
                for (const column of movedColumns) {
                    const collection = isSessionMetaCollection(column);
                    const actual = collection
                        ? readSessionMetaCollection(db, "encoding-review", column)
                        : readSessionRenderCache(
                              db,
                              "encoding-review",
                              column as (typeof SESSION_RENDER_CACHE_COLUMNS)[number],
                          );
                    const expected = before[column];
                    expect(actual).toEqual(expected);
                    expect(Object.getPrototypeOf(actual ?? {})).toBe(
                        Object.getPrototypeOf(expected ?? {}),
                    );
                    expect(String(actual)).toBe(String(expected));
                    const select = collection
                        ? sessionMetaCollectionSelect(column)
                        : sessionRenderCacheSelect(
                              column as (typeof SESSION_RENDER_CACHE_COLUMNS)[number],
                          );
                    expect(
                        db
                            .prepare(`SELECT ${select} FROM session_meta WHERE session_id=?`)
                            .get("encoding-review"),
                    ).toEqual({ [column]: expected });
                }
                expect(publicReads(db)).toEqual(consumersBefore);
            }
        } finally {
            db.close();
        }
    });
}
