import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersistedLkgSlot, saveLkgSlotToDb } from "../../hooks/magic-context/lkg-persist";
import {
    checkLkgDurability,
    recordServedCapture,
} from "../../hooks/magic-context/lkg-served-marker";
import type { LkgSlot } from "../../hooks/magic-context/lkg-slot";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { readCollectionToken } from "./storage-session-collection-state";
import {
    applySessionMetaCollectionWrite,
    prepareSessionMetaCollectionWrite,
    readSessionMetaCollection,
    writeSessionMetaCollection,
} from "./storage-session-collections";

function create(path = ":memory:") {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.prepare("INSERT INTO session_meta(session_id) VALUES ('revisions')").run();
    return db;
}
const column = "trailing_blank_decisions";
const rawEdit = (db: Database, from: string, to: string) =>
    db
        .prepare(`UPDATE session_meta_chunks SET body=CAST(REPLACE(CAST(body AS TEXT),?,?) AS BLOB)
    WHERE session_id='revisions' AND column_name='trailing_blank_decisions' AND CAST(body AS TEXT) LIKE ?`)
        .run(from, to, `%${from}%`);

test("raw SQL chunk INSERT UPDATE and DELETE advance the durable collection revision", () => {
    const db = create();
    try {
        db.prepare("INSERT INTO session_meta_chunks VALUES ('revisions',?,'-1',?)").run(
            column,
            Buffer.alloc(0),
        );
        const inserted = readCollectionToken(db, "revisions", column);
        expect(inserted.revision).toBe("1");
        db.prepare("INSERT INTO session_meta_chunks VALUES ('revisions',?,'raw',?)").run(
            column,
            Buffer.from('["before"]'),
        );
        expect(readCollectionToken(db, "revisions", column).revision).toBe("2");
        rawEdit(db, "before", "after");
        expect(readCollectionToken(db, "revisions", column).revision).toBe("3");
        db.prepare(
            "DELETE FROM session_meta_chunks WHERE session_id='revisions' AND chunk='raw'",
        ).run();
        expect(readCollectionToken(db, "revisions", column).revision).toBe("4");
        expect(readCollectionToken(db, "revisions", column).id).toBe(inserted.id);
    } finally {
        db.close();
    }
});

test("a sibling raw writer invalidates a reused value through its indexed revision lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-test-owned-collection-revisions-"));
    const writer = create(join(root, "context.db")),
        reader = new Database(join(root, "context.db"));
    try {
        writeSessionMetaCollection(writer, "revisions", column, '["before"]');
        let reassemblies = 0;
        const prepare = reader.prepare.bind(reader);
        reader.prepare = ((sql: string) => {
            const statement = prepare(sql);
            if (sql.includes("FROM session_meta_chunks")) {
                const all = statement.all.bind(statement);
                Object.defineProperty(statement, "all", {
                    configurable: true,
                    value: (...args: unknown[]) => {
                        reassemblies++;
                        return all(...args);
                    },
                });
            }
            return statement;
        }) as typeof reader.prepare;
        expect(readSessionMetaCollection(reader, "revisions", column)).toBe('["before"]');
        expect(readSessionMetaCollection(reader, "revisions", column)).toBe('["before"]');
        expect(reassemblies).toBe(1);
        rawEdit(writer, "before", "after");
        expect(readSessionMetaCollection(reader, "revisions", column)).toBe('["after"]');
        expect(reassemblies).toBe(2);
    } finally {
        reader.close();
        writer.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("a prepared delta loses to a sibling revision without overwriting the winner", () => {
    const db = create();
    try {
        writeSessionMetaCollection(db, "revisions", column, '["before"]');
        const plan = prepareSessionMetaCollectionWrite(db, "revisions", column, '["stale"]');
        rawEdit(db, "before", "winner");
        expect(db.transaction(() => applySessionMetaCollectionWrite(db, plan)).immediate()).toBe(
            false,
        );
        expect(readSessionMetaCollection(db, "revisions", column)).toBe('["winner"]');
        const retry = prepareSessionMetaCollectionWrite(
            db,
            "revisions",
            column,
            '["winner","new"]',
        );
        expect(db.transaction(() => applySessionMetaCollectionWrite(db, retry)).immediate()).toBe(
            true,
        );
        expect(readSessionMetaCollection(db, "revisions", column)).toBe('["winner","new"]');
    } finally {
        db.close();
    }
});

test("a rolled-back revision cannot validate cached uncommitted bytes after revision reuse", () => {
    const db = create();
    try {
        writeSessionMetaCollection(db, "revisions", column, '["before"]');
        db.exec("BEGIN IMMEDIATE");
        writeSessionMetaCollection(db, "revisions", column, '["mutant"]');
        expect(readSessionMetaCollection(db, "revisions", column)).toBe('["mutant"]');
        const discarded = readCollectionToken(db, "revisions", column);
        db.exec("ROLLBACK");
        rawEdit(db, "before", "winner");
        expect(readCollectionToken(db, "revisions", column)).toEqual(discarded);
        expect(readSessionMetaCollection(db, "revisions", column)).toBe('["winner"]');
    } finally {
        db.close();
    }
});

test("revision incarnation survives collection row deletion and session recreation", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-test-owned-collection-recreation-"));
    const writer = create(join(root, "context.db")),
        reader = new Database(join(root, "context.db"));
    try {
        writeSessionMetaCollection(writer, "revisions", column, '["before"]');
        expect(readSessionMetaCollection(reader, "revisions", column)).toBe('["before"]');
        const old = readCollectionToken(reader, "revisions", column);
        writer.exec(
            "DELETE FROM session_meta_chunks; DELETE FROM session_meta_collection_revisions; DELETE FROM session_meta; INSERT INTO session_meta(session_id) VALUES ('revisions')",
        );
        writeSessionMetaCollection(writer, "revisions", column, '["winner"]');
        expect(readCollectionToken(reader, "revisions", column).id).not.toBe(old.id);
        expect(readSessionMetaCollection(reader, "revisions", column)).toBe('["winner"]');
    } finally {
        reader.close();
        writer.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("transparent connection proxies share rollback invalidation", () => {
    const actual = create(),
        db = new Proxy(actual, { get: (target, key) => Reflect.get(target, key, target) });
    try {
        writeSessionMetaCollection(db, "revisions", column, '["before"]');
        db.exec("BEGIN IMMEDIATE");
        writeSessionMetaCollection(db, "revisions", column, '["mutant"]');
        expect(readSessionMetaCollection(db, "revisions", column)).toBe('["mutant"]');
        db.exec("ROLLBACK");
        rawEdit(db, "before", "winner");
        expect(readSessionMetaCollection(db, "revisions", column)).toBe('["winner"]');
    } finally {
        db.close();
    }
});

test("automatic SQLite rollback invalidates cached uncommitted collection bytes", () => {
    const db = create();
    try {
        writeSessionMetaCollection(db, "revisions", column, '["before"]');
        db.exec("BEGIN IMMEDIATE");
        writeSessionMetaCollection(db, "revisions", column, '["mutant"]');
        expect(readSessionMetaCollection(db, "revisions", column)).toBe('["mutant"]');
        const discarded = readCollectionToken(db, "revisions", column);
        expect(() =>
            db
                .prepare("INSERT OR ROLLBACK INTO session_meta(session_id) VALUES ('revisions')")
                .run(),
        ).toThrow();
        rawEdit(db, "before", "winner");
        expect(readCollectionToken(db, "revisions", column)).toEqual(discarded);
        expect(readSessionMetaCollection(db, "revisions", column)).toBe('["winner"]');
    } finally {
        db.close();
    }
});

test("paired LKG publication retries a prepared revision outside the writer with the same served certificate", () => {
    const db = create();
    try {
        writeSessionMetaCollection(
            db,
            "revisions",
            column,
            JSON.stringify({
                version: 2,
                trailingBlank: {},
                counter: "before",
                pad: "x".repeat(1_000_000),
            }),
        );
        const servedCaptureId = recordServedCapture(db, "revisions", true);
        const slot: LkgSlot = {
            jsonPrefix: '[{"text":"served"}]',
            inputIdSeq: ["u"],
            inputContentDigests: ["digest"],
            inputMoveDigests: ["a".repeat(64)],
            lastInputMessageId: "u",
            modelKey: "m",
            providerKey: "p",
            capturedAt: Date.now(),
            rowVersion: 900,
            captureSequence: 3,
            servedCaptureId,
            fullCoverage: true,
        };
        let writerHeld = false,
            preparations = 0;
        const exec = db.exec.bind(db),
            prepare = db.prepare.bind(db);
        db.exec = (sql: string) => {
            const result = exec(sql);
            if (/^BEGIN IMMEDIATE/.test(sql)) writerHeld = true;
            if (/^(COMMIT|ROLLBACK)$/.test(sql)) writerHeld = false;
            return result;
        };
        db.prepare = ((sql: string) => {
            if (writerHeld && /^\s*SELECT/.test(sql) && /\bFROM session_meta_chunks\b/.test(sql))
                throw new Error("old chunk bodies read under writer");
            return prepare(sql);
        }) as typeof db.prepare;
        expect(
            saveLkgSlotToDb(db, "revisions", slot, {
                prepareMetadata: () => {
                    expect(writerHeld).toBe(false);
                    preparations++;
                    const value = JSON.parse(
                        readSessionMetaCollection(db, "revisions", column) as string,
                    );
                    value.added = true;
                    const plan = prepareSessionMetaCollectionWrite(
                        db,
                        "revisions",
                        column,
                        JSON.stringify(value),
                    );
                    if (preparations === 1) rawEdit(db, "before", "winner");
                    return () => applySessionMetaCollectionWrite(db, plan);
                },
            }),
        ).toBe(true);
        expect(preparations).toBe(2);
        expect(loadPersistedLkgSlot(db, "revisions")?.servedCaptureId).toBe(servedCaptureId);
        expect(checkLkgDurability(db, "revisions")).toEqual({ durable: true, servedCaptureId });
        const committed = JSON.parse(readSessionMetaCollection(db, "revisions", column) as string);
        expect(committed.counter).toBe("winner");
        expect(committed.added).toBe(true);
    } finally {
        db.close();
    }
});
