/// <reference types="bun-types" />

import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { installTrimSourceIndexes } from "./migration-v101-trim-indexes";
import { markTagsCompactedByMessageIds, TRIM_SOURCE_CANDIDATES_SQL } from "./storage-tags";

function fixture(): Database {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE tags (
        id INTEGER PRIMARY KEY, session_id TEXT, message_id TEXT,
        tool_owner_message_id TEXT, status TEXT,
        tag_number INTEGER GENERATED ALWAYS AS (id) VIRTUAL,
        UNIQUE(session_id, tag_number));
        CREATE INDEX idx_tags_session_message_id ON tags(session_id, message_id);
        CREATE TABLE pending_ops (session_id TEXT, tag_id INTEGER);
        CREATE INDEX idx_pending_ops_session_tag ON pending_ops(session_id, tag_id);`);
    installTrimSourceIndexes(db);
    return db;
}

function legacy(db: Database, session: string, ids: string[]): number {
    const update = db.prepare(`UPDATE tags SET status = 'compacted'
        WHERE session_id = ? AND status IN ('active', 'dropped')
        AND (message_id = ? OR message_id LIKE ? ESCAPE '\\'
            OR message_id LIKE ? ESCAPE '\\' OR tool_owner_message_id = ?) RETURNING id`);
    return db
        .transaction(() => {
            let count = 0;
            for (const id of new Set(ids)) {
                const escaped = id.replace(/[\\%_]/g, "\\$&");
                count += update.all(session, id, `${escaped}:p%`, `${escaped}:file%`, id).length;
            }
            return count;
        })
        .immediate();
}

describe("trimmed-message tag retirement", () => {
    test("one new trimmed source seeks four indexed ranges independently of persisted history", () => {
        const db = fixture();
        try {
            const insert = db.prepare(
                "INSERT INTO tags(id,session_id,message_id,tool_owner_message_id,status) VALUES (?,'s',?,?,'dropped')",
            );
            db.transaction(() => {
                for (let id = 1; id <= 160_000; id++) insert.run(id, `old-${id}:p0`, null);
                insert.run(160_001, "new:p0", null);
                insert.run(160_002, "NEW:FILE1", null);
                insert.run(160_003, "call", "new");
            })();
            const prepare = db.prepare.bind(db);
            let discovered = 0;
            const intercept = spyOn(db, "prepare").mockImplementation((sql: string) => {
                if (sql === TRIM_SOURCE_CANDIDATES_SQL) {
                    const params = ["s", '["new"]'];
                    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
                        detail: string;
                    }[];
                    const tagSearches = plan.filter((row) => row.detail.includes("SEARCH t"));
                    expect(tagSearches).toHaveLength(4);
                    expect(
                        tagSearches.every((row) =>
                            /message_id=\?|message_id>\?|tool_owner_message_id=\?/.test(row.detail),
                        ),
                    ).toBe(true);
                    expect(prepare(sql).all(...params)).toHaveLength(3);
                    discovered++;
                }
                return prepare(sql);
            });
            try {
                expect(markTagsCompactedByMessageIds(db, "s", ["new"])).toBe(3);
                expect(discovered).toBe(1);
                expect(
                    prepare("SELECT count(*) AS n FROM tags WHERE status='dropped'").get(),
                ).toEqual({ n: 160_000 });
            } finally {
                intercept.mockRestore();
            }
        } finally {
            db.close();
        }
    });

    test("protected trim discovery seeks only eligible tag numbers and preserves retired state", () => {
        const db = fixture();
        try {
            const insert = db.prepare(
                "INSERT INTO tags(id, session_id, message_id, status) VALUES (?, 's', ?, 'dropped')",
            );
            db.transaction(() => {
                for (let id = 1; id <= 70_000; id++) insert.run(id, id % 2 ? "root:p0" : "keep");
            })();
            const prepare = db.prepare.bind(db);
            let discoveries = 0;
            const intercept = spyOn(db, "prepare").mockImplementation((sql: string) => {
                if (sql.includes("WITH ids AS MATERIALIZED")) {
                    discoveries++;
                    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
                        '["root"]',
                        "s",
                        "[69999,70000]",
                        0,
                        0,
                    ) as Array<{ detail: string }>;
                    expect(plan.map((r) => r.detail).join(" | ")).toContain(
                        "session_id=? AND tag_number=?",
                    );
                }
                return prepare(sql);
            });
            try {
                expect(
                    markTagsCompactedByMessageIds(db, "s", ["root"], new Set([69_999, 70_000])),
                ).toBe(1);
                expect(discoveries).toBe(1);
                expect(prepare("SELECT id FROM tags WHERE status='compacted'").all()).toEqual([
                    { id: 69_999 },
                ]);
                expect(
                    prepare("SELECT COUNT(*) AS n FROM tags WHERE status='dropped'").get(),
                ).toEqual({ n: 69_999 });
            } finally {
                intercept.mockRestore();
            }
        } finally {
            db.close();
        }
    });

    test("retires only matching tags among 100k tags with 4000 trimmed ids", () => {
        const db = fixture();
        try {
            const insert = db.prepare(
                "INSERT INTO tags(id, session_id, message_id, tool_owner_message_id, status) VALUES (?, 's', ?, ?, ?)",
            );
            db.transaction(() => {
                for (let i = 0; i < 100_000; i++) {
                    insert.run(
                        i + 1,
                        i < 8000 ? `m${i % 4000}:p0` : `keep${i}`,
                        i < 8000 ? `m${i % 4000}` : null,
                        i % 3 === 0 ? "compacted" : i % 3 === 1 ? "active" : "dropped",
                    );
                }
            })();
            const start = performance.now();
            expect(
                markTagsCompactedByMessageIds(
                    db,
                    "s",
                    Array.from({ length: 4000 }, (_, i) => `m${i}`),
                ),
            ).toBe(5333);
            const elapsed = performance.now() - start;
            // This full-state expectation is also checked against the legacy SQL
            // on the identical fixture before replacing the quadratic loop.
            const states = db.prepare("SELECT status FROM tags ORDER BY id").all() as {
                status: string;
            }[];
            expect(states.map((row) => row.status)).toEqual(
                Array.from({ length: 100_000 }, (_, i) =>
                    i < 8000 || i % 3 === 0 ? "compacted" : i % 3 === 1 ? "active" : "dropped",
                ),
            );
            console.log(`trim regression: 100000 tags, 4000 ids, ${elapsed.toFixed(1)}ms`);
            expect(markTagsCompactedByMessageIds(db, "s", ["m1", "m1"])).toBe(0);
        } finally {
            db.close();
        }
    }, 600_000);

    test("matches legacy LIKE, exact-id and owner semantics, including nested delimiters", () => {
        for (const ids of [
            ["root", "a%_\\b", "MiXeD", "Ä", "", "owner", "root"],
            ["root:p0", "root:p0"],
            ["nul\0id"],
        ]) {
            const db = fixture();
            try {
                const values = [
                    "root",
                    "root:p",
                    "root:part",
                    "root:FILEanything",
                    "root:p0:file1",
                    "root:mc-text-v1:x",
                    "rootish:p0",
                    "a%_\\b:p0",
                    "axxb:p0",
                    "mixed:p0",
                    "mixed",
                    "Ä:p0",
                    "ä:p0",
                    ":p0",
                    "call-id",
                    "keep",
                    "root:p\0tail",
                    "root\0:p0",
                    "nul",
                    "NUL\0else",
                    "nul:p0",
                    null,
                ];
                const insert = db.prepare(
                    "INSERT INTO tags(id, session_id, message_id, tool_owner_message_id, status) VALUES (?, ?, ?, ?, ?)",
                );
                let id = 0;
                for (const session of ["old", "new", "other"]) {
                    for (const value of values) {
                        for (const status of ["active", "dropped", "compacted", "other"]) {
                            insert.run(
                                ++id,
                                session,
                                value,
                                value === "call-id" || value === null ? "owner" : null,
                                status,
                            );
                        }
                    }
                }
                const read = (session: string) =>
                    db
                        .prepare(
                            "SELECT message_id,tool_owner_message_id,status FROM tags WHERE session_id = ? ORDER BY id",
                        )
                        .all(session);
                const untouched = read("other");
                expect(markTagsCompactedByMessageIds(db, "new", ids)).toBe(legacy(db, "old", ids));
                expect(read("new")).toEqual(read("old"));
                expect(read("other")).toEqual(untouched);
                expect(markTagsCompactedByMessageIds(db, "new", ids)).toBe(0);
            } finally {
                db.close();
            }
        }
    });

    test("colon-bearing overlapping sources match general discovery and legacy LIKE across all four seeks", () => {
        const rows: Array<[string | null, string | null, string]> = [
            ["base", null, "active"],
            ["base:p7", null, "dropped"],
            ["base:p7:p0", null, "active"],
            ["BASE:P7:FILE99", null, "dropped"],
            ["base:file2:p0", null, "active"],
            ["BASE:FILE2:FILE1", null, "dropped"],
            ["MiXeD:p9", null, "active"],
            ["mixed:P9:P0", null, "dropped"],
            ["MIXED:FILE4:FILE0", null, "active"],
            ["owner-only", "MiXeD:p9", "dropped"],
            ["owner-only-wrong-case", "mixed:p9", "active"],
            ["base:mc-text-v1:keep", null, "active"],
            ["baseish:p0", null, "active"],
            ["MiXeD:p90:p0", null, "active"],
            ["MiXeD:file40:p0", null, "active"],
            ["base:p7\0:hidden", null, "active"],
            ["MiXeD:p9\0:p0", null, "active"],
            ["MiXeD:p9:p\0tail", null, "active"],
            ["BASE", null, "active"],
            ["mixed:p9", null, "active"],
            ["base:file2", null, "dropped"],
            ["base:p7:filestale", null, "compacted"],
            ["base:p7:p0", null, "other"],
            ["tool-owner-source", "base:file2", "active"],
            [null, "base:p7", "active"],
            [null, null, "active"],
        ];
        for (const includeBase of [true, false]) {
            const ids = [
                ...(includeBase ? ["base"] : []),
                "base:p7",
                "base:file2",
                "MiXeD:p9",
                "MiXeD:file4",
            ];
            const expected = [
                ...(includeBase ? [1] : []),
                2,
                3,
                4,
                5,
                6,
                7,
                8,
                9,
                10,
                ...(includeBase ? [16] : []),
                18,
                21,
                24,
                25,
            ];
            const db = fixture();
            try {
                const insert = db.prepare(
                    "INSERT INTO tags(id,session_id,message_id,tool_owner_message_id,status) VALUES (?,?,?,?,?)",
                );
                for (const [sessionIndex, session] of ["indexed", "general", "like"].entries()) {
                    for (const [index, row] of rows.entries()) {
                        insert.run(sessionIndex * rows.length + index + 1, session, ...row);
                    }
                }
                // An eligibility set covering every fixture row selects the old general
                // discovery SQL, including its colon-widening OR, without restricting it.
                const eligible = new Set(rows.map((_, index) => rows.length + index + 1));
                expect(markTagsCompactedByMessageIds(db, "indexed", ids)).toBe(expected.length);
                expect(markTagsCompactedByMessageIds(db, "general", ids, eligible)).toBe(
                    expected.length,
                );
                expect(legacy(db, "like", ids)).toBe(expected.length);
                const read = (session: string) =>
                    db
                        .prepare(`SELECT message_id,tool_owner_message_id,status FROM tags
                        WHERE session_id=? ORDER BY id`)
                        .all(session);
                expect(read("indexed")).toEqual(read("general"));
                expect(read("indexed")).toEqual(read("like"));
                const changed = db
                    .prepare(`SELECT id FROM tags WHERE session_id='indexed'
                    AND status='compacted' AND id != 22 ORDER BY id`)
                    .all();
                expect(changed).toEqual(expected.map((id) => ({ id })));
                expect(markTagsCompactedByMessageIds(db, "indexed", ids)).toBe(0);
            } finally {
                db.close();
            }
        }
    });

    test("commits bounded batches and safely resumes after an interrupted batch", () => {
        const db = fixture();
        try {
            const insert = db.prepare(
                "INSERT INTO tags(id, session_id, message_id, tool_owner_message_id, status) VALUES (?, 's', 'root:p0', NULL, 'dropped')",
            );
            db.transaction(() => {
                for (let i = 1; i <= 1000; i++) insert.run(i);
            })();
            const exec = db.exec.bind(db);
            let begins = 0;
            const intercept = spyOn(db, "exec").mockImplementation((sql: string) => {
                if (sql === "BEGIN IMMEDIATE" && ++begins === 2)
                    throw new Error("interrupted batch");
                return exec(sql);
            });
            try {
                expect(() => markTagsCompactedByMessageIds(db, "s", ["root"])).toThrow(
                    "interrupted batch",
                );
            } finally {
                intercept.mockRestore();
            }
            const applied = (
                db.prepare("SELECT count(*) AS n FROM tags WHERE status = 'compacted'").get() as {
                    n: number;
                }
            ).n;
            expect(applied).toBeGreaterThan(0);
            expect(applied).toBeLessThanOrEqual(128);
            expect(markTagsCompactedByMessageIds(db, "s", ["root"])).toBe(1000 - applied);
            expect(markTagsCompactedByMessageIds(db, "s", ["root"])).toBe(0);
        } finally {
            db.close();
        }
    });

    test("does not retire tags retargeted between discovery and writer acquisition", () => {
        const db = fixture();
        try {
            db.exec(
                "INSERT INTO tags(id, session_id, message_id, tool_owner_message_id, status) VALUES (1, 's', 'root:p0', NULL, 'active')",
            );
            const exec = db.exec.bind(db);
            let retargeted = false;
            const intercept = spyOn(db, "exec").mockImplementation((sql: string) => {
                if (sql === "BEGIN IMMEDIATE" && !retargeted) {
                    retargeted = true;
                    exec("UPDATE tags SET message_id = 'keep:p0' WHERE id = 1");
                }
                return exec(sql);
            });
            try {
                expect(markTagsCompactedByMessageIds(db, "s", ["root"])).toBe(0);
            } finally {
                intercept.mockRestore();
            }
            expect(retargeted).toBe(true);
            expect(db.prepare("SELECT status FROM tags WHERE id = 1").get()).toEqual({
                status: "active",
            });
        } finally {
            db.close();
        }
    });
});
