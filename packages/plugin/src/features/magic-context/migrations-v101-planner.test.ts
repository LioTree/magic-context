import { expect, it, spyOn } from "bun:test";
import { Database } from "../../shared/sqlite";
import { installTrimSourceIndexes } from "./migration-v101-trim-indexes";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { TAG_SELECT_COLUMNS } from "./storage-tags";

function fixture() {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        tag_number INTEGER, message_id TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT DEFAULT 'active', drop_mode TEXT DEFAULT 'full', tool_name TEXT,
        input_byte_size INTEGER, byte_size INTEGER DEFAULT 100, reasoning_byte_size INTEGER,
        caveman_depth INTEGER DEFAULT 0, tool_owner_message_id TEXT, token_count INTEGER,
        UNIQUE(session_id, tag_number));
        CREATE INDEX idx_tags_session_message_id ON tags(session_id, message_id);`);
    return db;
}

function seedAnalyzedStore(db: Database) {
    const insert = db.prepare(`INSERT INTO tags
        (session_id, tag_number, message_id, type, tool_owner_message_id)
        VALUES (?, ?, ?, 'message', ?)`);
    db.transaction(() => {
        for (let n = 1; n <= 50_000; n++) insert.run("large", n, `entry-${n}`, `owner-${n % 1000}`);
        for (let n = 1; n <= 30; n++) insert.run(`small-${n}`, 1, `other-${n}`, null);
    })();
    db.exec("ANALYZE tags; PRAGMA analysis_limit = 400");
}

function assertOrderedPages(db: Database) {
    const base = `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ?`;
    const pages = [
        { sql: `${base} ORDER BY tag_number ASC, id ASC LIMIT 256`, args: ["large"], first: 1 },
        {
            sql: `${base} AND ((? IS NULL AND tag_number IS NOT NULL) OR tag_number > ? OR (tag_number IS ? AND id > ?)) ORDER BY tag_number ASC, id ASC LIMIT 256`,
            args: ["large", 1000, 1000, 1000, 1000],
            first: 1001,
        },
    ];
    for (const page of pages) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${page.sql}`).all(...page.args) as {
            detail: string;
        }[];
        expect(plan.some((row) => /TEMP B-TREE/.test(row.detail))).toBe(false);
        expect(
            plan.some((row) => /SEARCH tags USING INDEX sqlite_autoindex_tags_/.test(row.detail)),
        ).toBe(true);
        const rows = db.prepare(page.sql).all(...page.args) as { tag_number: number }[];
        expect(rows.map((row) => row.tag_number)).toEqual(
            Array.from({ length: 256 }, (_, offset) => page.first + offset),
        );
    }
}

it("trim index installation preserves ordered tag pages in previously analyzed stores", () => {
    for (const installedByNativeMigration of [false, true]) {
        const db = fixture();
        try {
            seedAnalyzedStore(db);
            if (installedByNativeMigration) {
                // Native or older migrations may have installed the indexes without statistics.
                db.exec(`CREATE INDEX idx_tags_session_message_nocase ON tags(session_id, message_id COLLATE NOCASE);
                    CREATE INDEX idx_tags_session_tool_owner ON tags(session_id, tool_owner_message_id);`);
            }
            installTrimSourceIndexes(db);
            assertOrderedPages(db);
            const stats = db.prepare("SELECT idx FROM sqlite_stat1 WHERE tbl = 'tags'").all() as {
                idx: string;
            }[];
            expect(stats.map((row) => row.idx)).toContain("idx_tags_session_message_nocase");
            expect(stats.map((row) => row.idx)).toContain("idx_tags_session_tool_owner");
            const execute = spyOn(db, "exec");
            try {
                installTrimSourceIndexes(db);
                expect(execute.mock.calls.filter(([sql]) => /ANALYZE/.test(sql))).toHaveLength(0);
            } finally {
                execute.mockRestore();
            }
        } finally {
            db.close();
        }
    }
});

it("trim index installation leaves never-analyzed stores on lazy statistics collection", () => {
    const db = fixture();
    try {
        db.prepare(
            "INSERT INTO tags(session_id, tag_number, message_id, type) VALUES ('fresh', 1, 'entry', 'message')",
        ).run();
        installTrimSourceIndexes(db);
        const statistics = db
            .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'sqlite_stat1'")
            .get() as { count: number };
        expect(statistics.count).toBe(0);
        const indexes = db.prepare("PRAGMA index_list(tags)").all() as { name: string }[];
        expect(indexes.map((row) => row.name)).toContain("idx_tags_session_message_nocase");
        expect(indexes.map((row) => row.name)).toContain("idx_tags_session_tool_owner");
    } finally {
        db.close();
    }
});

it("fresh migration replay preserves empty tag statistics without another analysis", () => {
    const db = new Database(":memory:");
    const execute = spyOn(db, "exec");
    try {
        initializeDatabase(db);
        runMigrations(db);
        const analyses = () => execute.mock.calls.filter(([sql]) => /ANALYZE\s+tags/i.test(sql));
        expect(analyses()).toHaveLength(1);
        const stats = () =>
            db.prepare("SELECT idx, stat FROM sqlite_stat1 WHERE tbl='tags' ORDER BY idx").all();
        const before = stats();
        expect(before.length).toBeGreaterThan(0);
        installTrimSourceIndexes(db);
        expect(analyses()).toHaveLength(1);
        expect(stats()).toEqual(before);
    } finally {
        execute.mockRestore();
        db.close();
    }
});
