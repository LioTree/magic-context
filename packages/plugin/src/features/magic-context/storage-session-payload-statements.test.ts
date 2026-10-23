import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { readSessionRenderCache, writeSessionRenderCache } from "./storage-session-cache";
import { collectionCacheCounters } from "./storage-session-collection-state";
import {
    readSessionMetaCollection,
    updateSessionMetaCollection,
    writeSessionMetaCollection,
} from "./storage-session-collections";

function create(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.prepare("INSERT INTO session_meta(session_id) VALUES ('per-pass')").run();
    return db;
}

/** Count the statements compiled and the transactions opened while `run` executes. */
function observe(db: Database, run: () => void): { compiled: string[]; transactions: string[] } {
    const compiled: string[] = [];
    const transactions: string[] = [];
    const prepare = db.prepare;
    const exec = db.exec;
    db.prepare = ((sql: string) => {
        compiled.push(sql);
        return prepare.call(db, sql);
    }) as typeof db.prepare;
    db.exec = ((sql: string) => {
        if (/^\s*(BEGIN|SAVEPOINT)\b/i.test(sql)) transactions.push(sql);
        return exec.call(db, sql);
    }) as typeof db.exec;
    try {
        run();
    } finally {
        db.prepare = prepare;
        db.exec = exec;
    }
    return { compiled, transactions };
}

test("repeated collection reads hit the revision cache and compile no statement", () => {
    const db = create();
    try {
        writeSessionMetaCollection(db, "per-pass", "memory_block_ids", "[1,2,3]");
        expect(readSessionMetaCollection(db, "per-pass", "memory_block_ids")).toBe("[1,2,3]");
        const before = collectionCacheCounters();
        const seen = observe(db, () => {
            for (let pass = 0; pass < 20; pass++)
                expect(readSessionMetaCollection(db, "per-pass", "memory_block_ids")).toBe(
                    "[1,2,3]",
                );
        });
        const after = collectionCacheCounters();
        expect(after.hits - before.hits).toBe(20);
        expect(after.misses - before.misses).toBe(0);
        // The revision check runs on every read; it reuses the connection's compiled statement.
        expect(seen.compiled).toEqual([]);
        expect(seen.transactions).toEqual([]);
    } finally {
        db.close();
    }
});

test("rewriting an unchanged collection value takes no writer transaction", () => {
    const db = create();
    try {
        writeSessionMetaCollection(db, "per-pass", "memory_block_ids", "[4,5]");
        const unchanged = observe(db, () => {
            for (let pass = 0; pass < 5; pass++) {
                writeSessionMetaCollection(db, "per-pass", "memory_block_ids", "[4,5]");
                expect(
                    updateSessionMetaCollection(db, "per-pass", "memory_block_ids", "[4,5]"),
                ).toEqual({ changes: 1 });
            }
        });
        expect(unchanged.transactions).toEqual([]);
        // A real change still publishes through a writer transaction.
        const changed = observe(db, () =>
            writeSessionMetaCollection(db, "per-pass", "memory_block_ids", "[4,5,6]"),
        );
        expect(changed.transactions).toHaveLength(1);
        expect(readSessionMetaCollection(db, "per-pass", "memory_block_ids")).toBe("[4,5,6]");
    } finally {
        db.close();
    }
});

test("render-cache reads and writes reuse their compiled statements", () => {
    const db = create();
    try {
        writeSessionRenderCache(db, "per-pass", "cached_m1_bytes", Buffer.from("m1"));
        expect(readSessionRenderCache(db, "per-pass", "cached_m1_bytes")).toEqual(
            new Uint8Array(Buffer.from("m1")),
        );
        writeSessionRenderCache(db, "per-pass", "cached_m1_bytes", null);
        const seen = observe(db, () => {
            for (let pass = 0; pass < 5; pass++) {
                writeSessionRenderCache(
                    db,
                    "per-pass",
                    "cached_m1_bytes",
                    Buffer.from(`m1-${pass}`),
                );
                expect(
                    Buffer.from(
                        readSessionRenderCache(db, "per-pass", "cached_m1_bytes") as Uint8Array,
                    ).toString(),
                ).toBe(`m1-${pass}`);
                writeSessionRenderCache(db, "per-pass", "cached_m1_bytes", null);
            }
        });
        expect(seen.compiled).toEqual([]);
    } finally {
        db.close();
    }
});
