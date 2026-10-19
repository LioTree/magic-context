import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { deriveTagLoadFloor } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { importLegacyCkTagsOnce, legacyCkTagImportMarkerKey } from "./legacy-ck-tag-import";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

const SESSION = "ses_legacy_ck";
const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };

/** The subset of ck-mc's store.db schema the import reads. */
const STORE_SCHEMA = `
CREATE TABLE mc_tags (
    session_id TEXT NOT NULL, tag_number INTEGER NOT NULL, block_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'tool_call', 'tool_result')),
    token_count INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL DEFAULT 0,
    source_bytes BLOB NOT NULL DEFAULT X'',
    PRIMARY KEY (session_id, tag_number), UNIQUE(session_id, block_id));
CREATE TABLE mc_tag_cache_generations (
    session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0,
    tag_count INTEGER NOT NULL DEFAULT 0, max_tag_number INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pending_agent_drops (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, target_id TEXT NOT NULL,
    queued_at INTEGER NOT NULL DEFAULT 0, command_id TEXT, UNIQUE(session_id, target_id));
CREATE TABLE mc_block_identities (
    session_id TEXT NOT NULL, mid TEXT NOT NULL, identities TEXT NOT NULL,
    PRIMARY KEY (session_id, mid));
CREATE TABLE mc_cache_frozen_chunks (
    session_id TEXT NOT NULL, chunk INTEGER NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (session_id, chunk));
CREATE TABLE mc_cache_state (
    session_id TEXT PRIMARY KEY, row_version INTEGER NOT NULL, core_state TEXT NOT NULL,
    meta TEXT NOT NULL, last_activity_at INTEGER NOT NULL DEFAULT 0,
    section_index TEXT NOT NULL DEFAULT '{}');
`;

const CK_ACTIVE_AT = 2_000_000_000_000;

function user(id: string, text: string): MessageLike {
    return { info: { id, role: "user", sessionID: SESSION }, parts: [{ type: "text", text }] };
}

function assistant(id: string, parts: unknown[]): MessageLike {
    return { info: { id, role: "assistant", sessionID: SESSION, ...MODEL }, parts };
}

function tool(callID: string, output: string): Record<string, unknown> {
    return {
        type: "tool",
        tool: "bash",
        callID,
        state: { status: "completed", input: { command: callID }, output },
    };
}

/**
 * The conversation ck-mc served. Block indexes in ck-mc ids count blocks, not
 * parts: step-start is one opaque block and a completed tool is a call block
 * followed by a result block.
 */
function conversation(): MessageLike[] {
    return [
        user("msg_01", "first question"),
        assistant("msg_02", [
            { type: "step-start" },
            { type: "text", text: "first answer" },
            tool("call_a", "output a"),
        ]),
        assistant("msg_03", [{ type: "step-start" }, tool("call_b", "output b")]),
        assistant("msg_04", [{ type: "step-start" }, tool("call_c", "output c")]),
        // A user message sent after ck-mc's last pass, so ck-mc never tagged it.
        user("msg_05", "follow-up after the switch"),
    ];
}

/** ck-mc numbering for the conversation above. 12 is the high-water mark: tags 11 and 12 were issued and later removed. */
const CK_TAGS: Array<[number, string, string]> = [
    [5, "msg_01#0", "message"],
    [6, "msg_02#1", "message"],
    [7, "msg_02#3", "tool_result"],
    [9, "msg_03#2", "tool_result"],
    [10, "msg_04#2", "tool_result"],
];
const CK_HIGH_WATER = 12;

function buildStore(path: string): void {
    const store = new Database(path);
    try {
        store.exec(STORE_SCHEMA);
        const insert = store.prepare(
            "INSERT INTO mc_tags (session_id, tag_number, block_id, kind, created_at_ms) VALUES (?, ?, ?, ?, ?)",
        );
        for (const [number, block, kind] of CK_TAGS) {
            insert.run(SESSION, number, block, kind, CK_ACTIVE_AT);
        }
        store
            .prepare(
                "INSERT INTO mc_tag_cache_generations (session_id, generation, tag_count, max_tag_number) VALUES (?, 7, 5, ?)",
            )
            .run(SESSION, CK_HIGH_WATER);
        const identities = store.prepare(
            "INSERT INTO mc_block_identities (session_id, mid, identities) VALUES (?, ?, ?)",
        );
        const kinds = (...list: string[]) =>
            JSON.stringify(list.map((kind_tag) => ({ kind_tag, byte_fingerprint: "" })));
        identities.run(SESSION, "msg_01", kinds("text"));
        identities.run(SESSION, "msg_02", kinds("opaque", "text", "tool_call", "tool_result"));
        identities.run(SESSION, "msg_03", kinds("opaque", "tool_call", "tool_result"));
        identities.run(SESSION, "msg_04", kinds("opaque", "tool_call", "tool_result"));
        // ck-mc dropped call_c (reduction keyed on its call block) and still
        // has a queued drop on call_b's call block.
        store
            .prepare(
                "INSERT INTO mc_cache_frozen_chunks (session_id, chunk, body) VALUES (?, 0, ?)",
            )
            .run(
                SESSION,
                JSON.stringify([
                    { key: "red:msg_04#1", kind: "drop", frozen_payload: "[dropped]" },
                    { key: "strip:reasoning_clear:msg_02", kind: "strip_reasoning_clear" },
                ]),
            );
        store
            .prepare(
                "INSERT INTO pending_agent_drops (session_id, target_id, queued_at) VALUES (?, ?, ?)",
            )
            .run(SESSION, "msg_03#1", CK_ACTIVE_AT - 5);
        store
            .prepare(
                "INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at) VALUES (?, 1, '{}', '{}', ?)",
            )
            .run(SESSION, CK_ACTIVE_AT);
    } finally {
        closeQuietly(store);
    }
}

/**
 * context.db as the TypeScript transform left it before the switch: its own
 * numbering reused 5 and 6 for older messages that are no longer on the wire
 * (6 is still active), the first answer carries TypeScript number 3 with saved
 * source text, the follow-up message carries TypeScript number 2, and the
 * counter stops at 6, so an unaware allocator would hand out 7 next — ck-mc's
 * number for call_a.
 */
function seedTypeScriptEra(db: Database): void {
    getOrCreateSessionMeta(db, SESSION);
    const insert = db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness) VALUES (?, ?, 'message', ?, 10, ?, 'opencode')",
    );
    insert.run(SESSION, "msg_old_1:p0", "compacted", 5);
    insert.run(SESSION, "msg_old_2:p0", "active", 6);
    insert.run(SESSION, "msg_02:p1", "active", 3);
    insert.run(SESSION, "msg_05:p0", "active", 2);
    const source = db.prepare(
        "INSERT INTO source_contents (tag_id, session_id, content, created_at) VALUES (?, ?, ?, ?)",
    );
    source.run(3, SESSION, "first answer", CK_ACTIVE_AT - 1_000_000);
    source.run(6, SESSION, "old message two", CK_ACTIVE_AT - 1_000_000);
    source.run(2, SESSION, "follow-up after the switch", CK_ACTIVE_AT - 1_000_000);
    db.prepare(
        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, 6, 'drop', 1)",
    ).run(SESSION);
    db.prepare(
        "UPDATE session_meta SET counter = 6, tool_reclaim_watermark = 4 WHERE session_id = ?",
    ).run(SESSION);
}

function openContext(dir: string): Database {
    const db = new Database(join(dir, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

async function firstPass(db: Database): Promise<MessageLike[]> {
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        liveModelBySession: new Map([[SESSION, MODEL]]),
        contextUsageMap: new Map(),
        clearReasoningAge: 1000,
        protectedTokens: 4000,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
    });
    const messages = conversation();
    await transform({}, { messages });
    return messages;
}

/** The `§N§` number at the start of a rendered text or tool output, or null. */
function renderedNumber(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const match = /^§(\d+)§ /.exec(value);
    return match ? Number(match[1]) : null;
}

function partText(messages: MessageLike[], id: string, index: number): unknown {
    const part = messages.find((message) => message.info.id === id)?.parts[index] as
        | { text?: unknown; state?: { output?: unknown } }
        | undefined;
    return part?.text ?? part?.state?.output;
}

function tagRow(db: Database, number: number) {
    return db
        .prepare(
            "SELECT message_id AS messageId, type, status, drop_mode AS dropMode, tool_owner_message_id AS owner FROM tags WHERE session_id = ? AND tag_number = ?",
        )
        .get(SESSION, number) as
        | {
              messageId: string;
              type: string;
              status: string;
              dropMode: string;
              owner: string | null;
          }
        | undefined;
}

describe("legacy ck-mc tag import", () => {
    let dir: string;
    beforeEach(() => {
        dir = createTestTempDirFromPath(join(tmpdir(), "mc-legacy-ck-"));
    });
    afterEach(() => {
        cleanupTestTempDir(dir);
    });

    test("first TypeScript pass renders ck-mc's numbers and continues above its high-water mark", async () => {
        buildStore(join(dir, "store.db"));
        const db = openContext(dir);
        try {
            seedTypeScriptEra(db);
            const messages = await firstPass(db);

            // Every visible part ck-mc tagged renders the number the model saw.
            expect(renderedNumber(partText(messages, "msg_01", 0))).toBe(5);
            expect(renderedNumber(partText(messages, "msg_02", 1))).toBe(6);
            expect(renderedNumber(partText(messages, "msg_02", 2))).toBe(7);
            expect(renderedNumber(partText(messages, "msg_03", 1))).toBe(9);
            // The renumbered answer kept its saved source text.
            expect(partText(messages, "msg_02", 1)).toBe("§6§ first answer");

            // The part ck-mc never tagged gets a number above every number
            // either transform used (ck-mc 12, TypeScript's relocated rows).
            const fresh = renderedNumber(partText(messages, "msg_05", 0));
            expect(fresh).not.toBeNull();
            expect(fresh as number).toBeGreaterThan(CK_HIGH_WATER);

            // Numbers 5 and 6 now name ck-mc's parts. The older TypeScript rows
            // belonged to messages no longer on the wire, so they are gone with
            // their saved text; the visible follow-up kept its own row, moved
            // above the high-water mark with its saved text.
            expect(tagRow(db, 5)?.messageId).toBe("msg_01:p0");
            expect(tagRow(db, 6)?.messageId).toBe("msg_02:p1");
            expect(tagRow(db, 7)).toMatchObject({ messageId: "call_a", owner: "msg_02" });
            const history = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND message_id LIKE 'msg_old_%'",
                )
                .get(SESSION) as { n: number };
            expect(history.n).toBe(0);
            const historySource = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM source_contents WHERE session_id = ? AND content = 'old message two'",
                )
                .get(SESSION) as { n: number };
            expect(historySource.n).toBe(0);
            const relocated = db
                .prepare(
                    "SELECT tag_number AS n FROM tags WHERE session_id = ? AND message_id = 'msg_05:p0'",
                )
                .get(SESSION) as { n: number };
            expect(relocated.n).toBeGreaterThan(CK_HIGH_WATER);
            expect(fresh).toBe(relocated.n);
            const relocatedSource = db
                .prepare("SELECT content FROM source_contents WHERE session_id = ? AND tag_id = ?")
                .get(SESSION, relocated.n) as { content: string };
            expect(relocatedSource.content).toBe("follow-up after the switch");

            // ck-mc's applied drop survives on call_c's tag.
            expect(tagRow(db, 10)).toMatchObject({
                messageId: "call_c",
                owner: "msg_04",
                status: "dropped",
                dropMode: "full",
            });
            expect(renderedNumber(partText(messages, "msg_04", 1))).not.toBe(10);

            // ck-mc's queued drop on call_b's call block lands on call_b's tag;
            // the TypeScript-era queue entry on the old number 6 is gone.
            const queued = db
                .prepare("SELECT tag_id AS tagId FROM pending_ops WHERE session_id = ? ORDER BY id")
                .all(SESSION) as Array<{ tagId: number }>;
            expect(queued.map((row) => row.tagId)).toEqual([9]);
            expect(tagRow(db, 9)).toMatchObject({
                messageId: "call_b",
                owner: "msg_03",
                status: "active",
            });

            // The reclaim watermark was 4 in TypeScript's old numbering. It never
            // covered the first question (no old row; now number 5), so after the
            // renumbering it must still stop below 5.
            const meta = getOrCreateSessionMeta(db, SESSION);
            expect(meta.toolReclaimWatermark).toBeLessThan(5);

            const marker = db
                .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                .get(legacyCkTagImportMarkerKey(SESSION)) as { value: string };
            expect(JSON.parse(marker.value).status).toBe("imported");
        } finally {
            closeQuietly(db);
        }
    });

    test("the import runs once per session", async () => {
        buildStore(join(dir, "store.db"));
        const db = openContext(dir);
        try {
            seedTypeScriptEra(db);
            await firstPass(db);
            const before = db
                .prepare(
                    "SELECT message_id, tag_number, status FROM tags WHERE session_id = ? ORDER BY tag_number",
                )
                .all(SESSION);
            // A second process sees the marker and leaves context.db alone.
            const otherProcess = openContext(dir);
            try {
                const second = importLegacyCkTagsOnce({
                    db: otherProcess,
                    sessionId: SESSION,
                    messages: conversation(),
                });
                expect(second.status).toBe("already-imported");
            } finally {
                closeQuietly(otherProcess);
            }
            const after = db
                .prepare(
                    "SELECT message_id, tag_number, status FROM tags WHERE session_id = ? ORDER BY tag_number",
                )
                .all(SESSION);
            expect(after).toEqual(before);
        } finally {
            closeQuietly(db);
        }
    });

    test("with no context.db rows, new numbers still continue above ck-mc's high-water mark", async () => {
        buildStore(join(dir, "store.db"));
        const db = openContext(dir);
        try {
            const messages = await firstPass(db);
            expect(renderedNumber(partText(messages, "msg_03", 1))).toBe(9);
            // ck-mc issued 11 and 12 before their rows were removed; the model
            // may have seen them, so the first new number is 13 or above.
            const fresh = renderedNumber(partText(messages, "msg_05", 0));
            expect(fresh).not.toBeNull();
            expect(fresh as number).toBeGreaterThan(CK_HIGH_WATER);
        } finally {
            closeQuietly(db);
        }
    });

    test("TypeScript history behind the compaction marker is deleted, so the tagger loads only what a session without history loads", async () => {
        /** Rows a cold tagger loads for the conversation at the floor the transform derives. */
        const loadedAfterFirstPass = async (root: string, withHistory: boolean) => {
            mkdirSync(root, { recursive: true });
            buildStore(join(root, "store.db"));
            const db = openContext(root);
            try {
                if (withHistory) {
                    seedTypeScriptEra(db);
                    // Older TypeScript-era rows numbered above ck-mc's high-water
                    // mark, as on the long-running seats; none is on the wire.
                    const insert = db.prepare(
                        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, ?, ?, 10, ?, 'opencode', ?)",
                    );
                    const source = db.prepare(
                        "INSERT INTO source_contents (tag_id, session_id, content, created_at) VALUES (?, ?, ?, ?)",
                    );
                    for (let n = 13; n < 1_013; n += 1) {
                        if (n % 2 === 0)
                            insert.run(
                                SESSION,
                                `toolu_${n}`,
                                "tool",
                                "dropped",
                                n,
                                `msg_hist_${n}`,
                            );
                        else
                            insert.run(
                                SESSION,
                                `msg_hist_${n}:p0`,
                                "message",
                                "compacted",
                                n,
                                null,
                            );
                        source.run(n, SESSION, `history ${n}`, CK_ACTIVE_AT - 1_000_000);
                    }
                    db.prepare("UPDATE session_meta SET counter = 1012 WHERE session_id = ?").run(
                        SESSION,
                    );
                }
                await firstPass(db);
                const floor = deriveTagLoadFloor(
                    db,
                    SESSION,
                    conversation()
                        .map((message) => message.info.id)
                        [Symbol.iterator](),
                );
                const tagger = createTagger();
                tagger.initFromDb(SESSION, db, floor);
                const sources = db
                    .prepare("SELECT COUNT(*) AS n FROM source_contents WHERE session_id = ?")
                    .get(SESSION) as { n: number };
                return {
                    loaded: tagger.getHeapStats?.().assignmentEntries,
                    sources: sources.n,
                };
            } finally {
                closeQuietly(db);
            }
        };
        const withHistory = await loadedAfterFirstPass(join(dir, "history"), true);
        const baseline = await loadedAfterFirstPass(join(dir, "baseline"), false);
        expect(baseline.loaded).toBeGreaterThan(0);
        expect(withHistory.loaded).toBe(baseline.loaded);
        // Saved text for the visible parts only: the history rows' text is gone too.
        expect(withHistory.sources).toBe(baseline.sources);
    });

    test("a session the TypeScript transform tagged after ck-mc keeps its numbering", () => {
        buildStore(join(dir, "store.db"));
        const db = openContext(dir);
        try {
            seedTypeScriptEra(db);
            db.prepare(
                "INSERT INTO source_contents (tag_id, session_id, content, created_at) VALUES (?, ?, ?, ?)",
            ).run(4, SESSION, "tagged later", CK_ACTIVE_AT + 1);
            const result = importLegacyCkTagsOnce({
                db,
                sessionId: SESSION,
                messages: conversation(),
            });
            expect(result.status).toBe("typescript-newer");
            expect(tagRow(db, 6)?.messageId).toBe("msg_old_2:p0");
        } finally {
            closeQuietly(db);
        }
    });

    test("an unreadable store.db leaves numbering to the tagger above context.db's maximum", () => {
        const db = openContext(dir);
        try {
            seedTypeScriptEra(db);
            // A directory where store.db should be cannot be opened as a database.
            const storePath = join(dir, "store.db");
            mkdirSync(storePath);
            const result = importLegacyCkTagsOnce({
                db,
                sessionId: SESSION,
                messages: conversation(),
            });
            expect(result.status).toBe("store-unreadable");
            expect(tagRow(db, 6)?.messageId).toBe("msg_old_2:p0");
        } finally {
            closeQuietly(db);
        }
    });
});
