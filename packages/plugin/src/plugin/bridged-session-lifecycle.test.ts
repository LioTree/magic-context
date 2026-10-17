/// <reference types="bun-types" />

// Desktop-mode notification routing, as in the other hook-level tests: keeps
// the TUI toast path from intercepting status notices.
process.env.OPENCODE_CLIENT = "desktop";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import {
    __resetMessageIndexAsyncForTests,
    __setReconciliationSettledForTests,
} from "../features/magic-context/message-index-async";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { createTagger } from "../features/magic-context/tagger";
import { createMagicContextHook, type MagicContextDeps } from "../hooks/magic-context/hook";
import { closeReadOnlySessionDb } from "../hooks/magic-context/read-session-db";
import { __ignoredNotificationTest } from "../hooks/magic-context/send-session-notification";
import { BRIDGED_SESSIONS_KEY } from "../shared/bridged-sessions";
import { Database } from "../shared/sqlite";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import {
    dropBridgedSessionCreatedRows,
    standDownForBridgedSessions,
} from "./bridged-session-guard";
import { createMessagesTransformHandler } from "./messages-transform";

const slot = globalThis as unknown as Record<symbol, unknown>;

/** The live enrollment map, created on first use, the way the bridge publishes it. */
function bridgeMap(): Map<string, Record<string, unknown>> {
    const existing = slot[BRIDGED_SESSIONS_KEY];
    if (existing instanceof Map) return existing as Map<string, Record<string, unknown>>;
    const sessions = new Map<string, Record<string, unknown>>();
    slot[BRIDGED_SESSIONS_KEY] = sessions;
    return sessions;
}

function enroll(sessionId: string, value: Record<string, unknown> = {}): void {
    bridgeMap().set(sessionId, { product: "thalamus", version: "0.0.0-test", ...value });
}

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

function useTempDataHome(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CACHE_HOME = dir;
    return dir;
}

afterEach(() => {
    Reflect.deleteProperty(slot, BRIDGED_SESSIONS_KEY);
    __setReconciliationSettledForTests(undefined);
    __resetMessageIndexAsyncForTests();
    __ignoredNotificationTest.reset();
    closeReadOnlySessionDb();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* best-effort temp cleanup */
        }
    }
    tempDirs.length = 0;
});

type HostMessage = { id: string; role: string; text: string };

/** OpenCode's own message store, which deferred index reconciliation reads. */
function writeOpenCodeMessages(sessionId: string, messages: HostMessage[]): void {
    const dbPath = join(process.env.XDG_DATA_HOME as string, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS part (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
        `);
        messages.forEach((message, index) => {
            const timestamp = index + 1;
            db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            db.prepare(
                "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ type: "text", text: message.text }),
            );
        });
    } finally {
        db.close();
    }
}

/** Rows per context-database table whose `session_id` column equals `sessionId`. */
function rowsByTable(sessionId: string): Record<string, number> {
    const db = openDatabase();
    const counts: Record<string, number> = {};
    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
    for (const { name } of tables) {
        const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
            name: string;
        }>;
        if (!columns.some((column) => column.name === "session_id")) continue;
        const row = db
            .prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE session_id = ?`)
            .get(sessionId) as { n: number };
        if (row.n > 0) counts[name] = row.n;
    }
    return counts;
}

/** Wait until deferred index reconciliation for `sessionId` has finished. */
function reconciliationSettled(sessionIds: string[]): Promise<void> {
    const pending = new Set(sessionIds);
    return new Promise((resolve) => {
        __setReconciliationSettledForTests((sessionId) => {
            pending.delete(sessionId);
            if (pending.size === 0) resolve();
        });
    });
}

/**
 * The OpenCode 1 hook surface as the plugin entry builds it: the real Magic
 * Context hook object, its messages transform behind
 * createMessagesTransformHandler, the whole thing behind the stand-down guard,
 * and the session.deleted row drop the entry installs.
 */
function opencodeEntry(directory: string) {
    const hook = createMagicContextHook({
        client: {
            session: {
                list: mock(async () => ({ data: [] })),
                messages: mock(async () => ({ data: [] })),
                promptAsync: mock(async () => undefined),
            },
            tui: { showToast: mock(async () => undefined) },
        } as unknown as MagicContextDeps["client"],
        directory,
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
        compactionHandler: { onCompacted: mock(() => {}) } as never,
        config: {
            protected_tokens: 0,
            cache_ttl: "5m",
        } as MagicContextDeps["config"],
    });
    if (!hook) throw new Error("hook construction failed");
    const transform = createMessagesTransformHandler({ magicContext: hook as never });
    const hooks = standDownForBridgedSessions(
        {
            event: hook.event as Hooks["event"],
            "chat.message": hook["chat.message"] as Hooks["chat.message"],
            "experimental.chat.system.transform": hook[
                "experimental.chat.system.transform"
            ] as Hooks["experimental.chat.system.transform"],
            "experimental.chat.messages.transform": transform as never,
            "tool.execute.before": hook["tool.execute.before"] as Hooks["tool.execute.before"],
            "tool.execute.after": hook["tool.execute.after"] as Hooks["tool.execute.after"],
        },
        { onBridgedSessionDeleted: (id) => dropBridgedSessionCreatedRows(openDatabase(), id) },
    );
    const event = (type: string, properties: Record<string, unknown>) =>
        hooks.event?.({ event: { type, properties } as never });
    return { hooks, event };
}

function created(sessionId: string, directory: string, parentID = "") {
    return {
        info: {
            id: sessionId,
            parentID,
            directory,
            title: "ordinary session",
            providerID: "anthropic",
            modelID: "claude-sonnet",
        },
    };
}

function turnMessages(sessionId: string) {
    return [
        {
            info: { id: `${sessionId}-u1`, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "Plan this change" }],
        },
        {
            info: { id: `${sessionId}-a1`, role: "assistant", sessionID: sessionId },
            parts: [
                { type: "text", text: "Implemented" },
                { type: "tool", callID: `${sessionId}-call`, state: { output: "tool output" } },
            ],
        },
    ];
}

/** One user turn through every per-session hook the entry exposes. */
async function runTurn(entry: ReturnType<typeof opencodeEntry>, sessionId: string) {
    const { hooks, event } = entry;
    await hooks["chat.message"]?.(
        {
            sessionID: sessionId,
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
        { message: { id: `${sessionId}-u1` } as never, parts: [] },
    );
    const messages = turnMessages(sessionId);
    await (
        hooks["experimental.chat.messages.transform"] as unknown as (
            input: Record<string, never>,
            output: { messages: unknown[] },
        ) => Promise<unknown>
    )({}, { messages });
    const system = { system: ["You are a helpful assistant."] };
    await hooks["experimental.chat.system.transform"]?.(
        { sessionID: sessionId, model: {} as never },
        system,
    );
    const toolOutput = { title: "todowrite", output: "[]", metadata: {} };
    await hooks["tool.execute.after"]?.(
        { tool: "todowrite", sessionID: sessionId, callID: "call-1", args: { todos: [] } },
        toolOutput,
    );
    await event("message.updated", {
        info: {
            id: `${sessionId}-a1`,
            role: "assistant",
            sessionID: sessionId,
            providerID: "anthropic",
            modelID: "claude-sonnet",
            time: { created: 1, completed: 2 },
            tokens: { input: 1000, output: 10, cache: { read: 0, write: 0 } },
        },
    });
    await event("session.idle", { sessionID: sessionId });
    return { messages, system, toolOutput };
}

const CREATED_ROWS = { session_meta: 1, session_projects: 1 };

describe("a session enrolled after its session.created", () => {
    test("keeps only session.created's two rows, writes nothing for its turns and indexes nothing", async () => {
        const home = useTempDataHome("bridged-late-enroll-");
        const project = join(home, "project");
        mkdirSync(project, { recursive: true });
        const history = (sessionId: string) => [
            { id: `${sessionId}-u-old`, role: "user", text: "earlier question" },
            { id: `${sessionId}-a-old`, role: "assistant", text: "earlier answer" },
        ];
        writeOpenCodeMessages("ses-late", history("ses-late"));
        writeOpenCodeMessages("ses-control", history("ses-control"));
        const entry = opencodeEntry(project);
        const settled = reconciliationSettled(["ses-late", "ses-control"]);

        // Both sessions are created while unenrolled. Exactly what OpenCode 1's
        // session.created writes today for a session: one session_meta row and
        // one session_projects row.
        await entry.event("session.created", created("ses-late", project));
        await entry.event("session.created", created("ses-control", project));
        expect(rowsByTable("ses-late")).toEqual(CREATED_ROWS);
        expect(rowsByTable("ses-control")).toEqual(CREATED_ROWS);

        // The bridge enrolls the existing session before its first turn; the
        // reconciliation session.created scheduled has not run yet.
        enroll("ses-late");
        await settled;

        const before = JSON.stringify(turnMessages("ses-late"));
        for (let turn = 0; turn < 2; turn += 1) {
            const { messages, system, toolOutput } = await runTurn(entry, "ses-late");
            expect(JSON.stringify(messages)).toBe(before);
            expect(system.system).toEqual(["You are a helpful assistant."]);
            expect(toolOutput.output).toBe("[]");
        }
        expect(rowsByTable("ses-late")).toEqual(CREATED_ROWS);

        // Control: the same entry, history and timing index and tag the
        // session Magic Context still serves.
        const control = await runTurn(entry, "ses-control");
        expect(JSON.stringify(control.messages)).toContain("§1§ ");
        const controlRows = rowsByTable("ses-control");
        expect(controlRows.message_history_fts ?? 0).toBeGreaterThan(0);
        expect(controlRows.tags ?? 0).toBeGreaterThan(0);
    });

    test("its session.deleted removes exactly session.created's two rows and nothing else", async () => {
        const home = useTempDataHome("bridged-late-delete-");
        const project = join(home, "project");
        mkdirSync(project, { recursive: true });
        const entry = opencodeEntry(project);

        await entry.event("session.created", created("ses-late", project));
        await entry.event("session.created", created("ses-control", project));
        enroll("ses-late");

        // Rows another writer owns for the same session in bridge mode: a tag
        // and the session's project row under a different harness.
        const db = openDatabase();
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, reasoning_token_count) VALUES ('ses-late', 'm-other', 'message', 10, 1, 0)",
        ).run();
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES ('ses-late', 'pi', 'dir:/elsewhere', 1)",
        ).run();
        expect(rowsByTable("ses-late")).toEqual({ session_meta: 1, session_projects: 2, tags: 1 });
        const controlBefore = rowsByTable("ses-control");

        await entry.event("session.deleted", { info: { id: "ses-late" } });

        expect(rowsByTable("ses-late")).toEqual({ session_projects: 1, tags: 1 });
        expect(
            db.prepare("SELECT harness FROM session_projects WHERE session_id = 'ses-late'").all(),
        ).toEqual([{ harness: "pi" }]);
        expect(rowsByTable("ses-control")).toEqual(controlBefore);
    });
});

describe("hidden historian children the bridge creates", () => {
    const historianChild = { role: "historian-child" };

    test("a child enrolled before its session.created leaves no rows and gets no work", async () => {
        const home = useTempDataHome("bridged-child-early-");
        const project = join(home, "project");
        mkdirSync(project, { recursive: true });
        const entry = opencodeEntry(project);
        enroll("ses-parent");
        enroll("ses-child", historianChild);

        await entry.event("session.created", created("ses-child", project, "ses-parent"));
        const before = JSON.stringify(turnMessages("ses-child"));
        const { messages, system } = await runTurn(entry, "ses-child");

        expect(JSON.stringify(messages)).toBe(before);
        expect(system.system).toEqual(["You are a helpful assistant."]);
        expect(rowsByTable("ses-child")).toEqual({});
    });

    test("a child created first and enrolled before its first prompt keeps only the two rows", async () => {
        const home = useTempDataHome("bridged-child-late-");
        const project = join(home, "project");
        mkdirSync(project, { recursive: true });
        const entry = opencodeEntry(project);
        enroll("ses-parent");

        await entry.event("session.created", created("ses-child", project, "ses-parent"));
        expect(rowsByTable("ses-child")).toEqual(CREATED_ROWS);
        enroll("ses-child", historianChild);

        const before = JSON.stringify(turnMessages("ses-child"));
        const { messages } = await runTurn(entry, "ses-child");
        expect(JSON.stringify(messages)).toBe(before);
        expect(rowsByTable("ses-child")).toEqual(CREATED_ROWS);

        await entry.event("session.deleted", { info: { id: "ses-child", parentID: "ses-parent" } });
        expect(rowsByTable("ses-child")).toEqual({});
    });

    test("a child's chat.params is left alone: no hidden-agent temperature, no output cap", async () => {
        enroll("ses-child", historianChild);
        const inner = mock(async (_input: unknown, output: { temperature: number }) => {
            output.temperature = 0.1;
        });
        const hooks = standDownForBridgedSessions({ "chat.params": inner as never });
        const output = {
            temperature: 0.7,
            topP: 1,
            topK: 0,
            maxOutputTokens: undefined,
            options: {},
        };
        await hooks["chat.params"]?.(
            {
                sessionID: "ses-child",
                agent: "historian",
                model: {} as never,
                provider: {} as never,
                message: {} as never,
            },
            output,
        );
        expect(inner).not.toHaveBeenCalled();
        expect(output.temperature).toBe(0.7);
    });
});
