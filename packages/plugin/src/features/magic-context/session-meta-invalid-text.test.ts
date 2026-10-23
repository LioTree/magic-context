import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { prepareReplayDocumentUpdate } from "./storage-replay-document";
import {
    readSessionMetaCollection,
    sessionMetaCollectionValueSql,
    updateSessionMetaCollection,
    writeSessionMetaCollection,
} from "./storage-session-collections";

const column = "trailing_blank_decisions";
function fixture(bytes: Buffer) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.prepare("INSERT INTO session_meta(session_id) VALUES ('invalid-text')").run();
    db.prepare("INSERT INTO session_meta_chunks VALUES ('invalid-text',?,'-1',?)").run(
        column,
        Buffer.alloc(0),
    );
    db.prepare("INSERT INTO session_meta_chunks VALUES ('invalid-text',?,'raw',?)").run(
        column,
        bytes,
    );
    return db;
}
const rawHex = (db: Database) =>
    (
        db
            .prepare(
                `SELECT hex(CAST(${sessionMetaCollectionValueSql(column, db)} AS BLOB)) AS bytes FROM session_meta WHERE session_id='invalid-text'`,
            )
            .get() as { bytes: string }
    ).bytes;

test("invalid UTF-8 TEXT keeps SQLite raw IS rejection instead of matching decoded replacement characters", () => {
    const db = fixture(Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]));
    try {
        const value = readSessionMetaCollection(db, "invalid-text", column);
        const old = db
            .prepare(
                `SELECT ${sessionMetaCollectionValueSql(column, db)} AS value FROM session_meta WHERE session_id='invalid-text'`,
            )
            .get() as { value: unknown };
        expect(value).toBe(old.value);
        expect(
            db
                .prepare(
                    `SELECT ${sessionMetaCollectionValueSql(column, db)} IS ? AS matched FROM session_meta WHERE session_id='invalid-text'`,
                )
                .get(value),
        ).toEqual({ matched: 0 });
        expect(
            updateSessionMetaCollection(db, "invalid-text", column, '["replacement"]', { value })
                .changes,
        ).toBe(0);
        expect(rawHex(db)).toBe("5B22FF225D");
    } finally {
        db.close();
    }
});

test("an absolute text setter replaces invalid stored bytes even when their decoded string is equal", () => {
    const db = fixture(Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]));
    try {
        const replacement = '["\uFFFD"]';
        expect(readSessionMetaCollection(db, "invalid-text", column)).toBe(replacement);
        writeSessionMetaCollection(db, "invalid-text", column, replacement);
        expect(rawHex(db)).toBe("5B22EFBFBD225D");
    } finally {
        db.close();
    }
});

test("a no-op prepared replay edit preserves invalid unknown text bytes and validates only its revision", () => {
    const bytes = Buffer.concat([
        Buffer.from('{"version":2,"trailingBlank":{},"piServedTagNumbers":[1],"opaque":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
    ]);
    const db = fixture(bytes);
    try {
        const publish = prepareReplayDocumentUpdate(db, "invalid-text", () => false);
        expect(publish).not.toBeNull();
        expect(db.transaction(() => publish!()).immediate()).toBe(true);
        expect(rawHex(db)).toBe(bytes.toString("hex").toUpperCase());
    } finally {
        db.close();
    }
});

test("cached text reads use the encoded SQLite value for lone-surrogate input", () => {
    const db = fixture(Buffer.from('"old"'));
    try {
        writeSessionMetaCollection(db, "invalid-text", column, "\uD800");
        const stored = db
            .prepare(
                `SELECT ${sessionMetaCollectionValueSql(column, db)} AS value FROM session_meta WHERE session_id='invalid-text'`,
            )
            .get() as { value: unknown };
        expect(rawHex(db)).toBe("EFBFBD");
        expect(readSessionMetaCollection(db, "invalid-text", column)).toBe(stored.value);
    } finally {
        db.close();
    }
});

test("lone-surrogate expected bindings retain the native SQLite IS result", () => {
    const db = fixture(Buffer.from("\uFFFD"));
    try {
        const expected = "\uD800";
        const reference = (
            db
                .prepare(
                    `SELECT ${sessionMetaCollectionValueSql(column, db)} IS ? AS matched FROM session_meta WHERE session_id='invalid-text'`,
                )
                .get(expected) as { matched: number }
        ).matched;
        expect(
            updateSessionMetaCollection(db, "invalid-text", column, "replacement", {
                value: expected,
            }).changes,
        ).toBe(reference);
    } finally {
        db.close();
    }
});

test("explicit defaults and NULL setters remove ignored stored pieces", () => {
    const db = fixture(Buffer.alloc(0));
    try {
        expect(readSessionMetaCollection(db, "invalid-text", column)).toBe("");
        writeSessionMetaCollection(db, "invalid-text", column, "");
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM session_meta_chunks WHERE session_id='invalid-text'",
                )
                .get(),
        ).toEqual({ n: 0 });
        db.prepare("INSERT INTO session_meta_chunks VALUES ('invalid-text',?,'-1',NULL)").run(
            column,
        );
        db.prepare("INSERT INTO session_meta_chunks VALUES ('invalid-text',?,'ignored',?)").run(
            column,
            Buffer.from("ignored"),
        );
        expect(readSessionMetaCollection(db, "invalid-text", column)).toBeNull();
        writeSessionMetaCollection(db, "invalid-text", column, null);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM session_meta_chunks WHERE session_id='invalid-text'",
                )
                .get(),
        ).toEqual({ n: 1 });
    } finally {
        db.close();
    }
});
