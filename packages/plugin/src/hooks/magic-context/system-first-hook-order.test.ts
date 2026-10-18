/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { openDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import { createMagicContextHook, type MagicContextDeps } from "./hook";
import { clearInjectionCache } from "./inject-compartments";
import { createLiveSessionState } from "./live-session-state";
import { clearLkgMeasuredRequest } from "./lkg-measured-request";
import { requestPendingMaterialization } from "./pending-materialization";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./transform-operations";

const route = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const realNow = Date.now;
let now = Date.UTC(2026, 9, 14, 23, 59);
let sequence = 0;
const cleanups: (() => void)[] = [];
const trace = readFileSync(join(import.meta.dir, "fixtures/thalamus-hook-order.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { at?: string; s?: string });
const mainStages = trace.filter(
    (row) => row.s === "S0" && (row.at === "system" || row.at === "messages"),
);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(() => {
    Date.now = realNow;
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(order: "private" | "stock" = "private") {
    Date.now = () => now;
    now = Date.UTC(2026, 9, 14, 23, 59);
    const sessionId = `system-first-${++sequence}`;
    const home = createTestTempDirFromPath(join(tmpdir(), "system-first-"));
    const project = join(home, "project");
    mkdirSync(project);
    const db = openDatabase(join(home, "context.db"))!;
    runMigrations(db);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: now });
    const source: MessageLike[] = [
        {
            info: { id: "msg_0001", sessionID: sessionId, role: "user", model: route },
            parts: [{ type: "text", text: "earlier task" }],
        },
        {
            info: {
                id: "msg_0002",
                sessionID: sessionId,
                role: "assistant",
                ...route,
                finish: "stop",
            },
            parts: [{ type: "text", text: "earlier answer" }],
        },
        {
            info: { id: "msg_0003", sessionID: sessionId, role: "user", model: route },
            parts: [{ type: "text", text: "current task" }],
        },
    ];
    // The two real hooks resolve the same user-turn identity through different
    // surfaces: system reads the host DB; messages reads the supplied array.
    const originalDataHome = process.env.XDG_DATA_HOME;
    closeReadOnlySessionDb();
    process.env.XDG_DATA_HOME = home;
    mkdirSync(join(home, "opencode"));
    const hostDb = new Database(join(home, "opencode", "opencode.db"));
    hostDb.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
    source.forEach((message, index) => {
        hostDb
            .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
            .run(message.info.id!, sessionId, index + 1, index + 1, JSON.stringify(message.info));
        message.parts.forEach((part, partIndex) => {
            hostDb
                .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
                .run(
                    `${index}-${partIndex}`,
                    message.info.id!,
                    sessionId,
                    index + 1,
                    index + 1,
                    JSON.stringify(part),
                );
        });
    });
    hostDb.close();
    resolveCtxReduceAvailabilityFromMessages(sessionId, source);
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () =>
            source.map((m, i) => ({
                id: m.info.id!,
                ordinal: i + 1,
                timeCreated: i + 1,
                createdAt: i + 1,
                role: m.info.role,
                parts: m.parts,
                contributesOrdinal: true,
                hasValidInfo: true,
            })),
        getStoredMessageCount: () => source.length,
    });
    let execute = false;
    const liveSessionState = createLiveSessionState();
    const hooks = createMagicContextHook({
        liveSessionState,
        openDatabaseForHook: () => db,
        directory: project,
        client: {
            session: {
                get: async () => ({ data: { directory: project } }),
                list: async () => ({ data: [] }),
                messages: async () => ({ data: [] }),
            },
            tui: { showToast: async () => undefined },
        } as unknown as MagicContextDeps["client"],
        tagger: createTagger(),
        scheduler: { shouldExecute: () => (execute ? "execute" : "defer") },
        compactionHandler: { onCompacted: () => {} } as never,
        config: {
            cache_ttl: "never",
            protected_tokens: 0,
            memory: { enabled: false, injection_budget_tokens: 1000 },
            embedding: { provider: "off" },
        },
    });
    if (!hooks) throw new Error("hook construction failed");
    cleanups.push(() => {
        closeReadOnlySessionDb();
        if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalDataHome;
        unregister();
        clearInjectionCache(sessionId);
        clearCtxReduceAvailability(sessionId);
        clearLkgMeasuredRequest(sessionId);
        db.close();
        cleanupTestTempDir(home);
    });
    let pass = 0;
    async function serve(instruction = "base instructions", date = "2026-10-14", complete = true) {
        now += 1000;
        const output = { messages: structuredClone(source) };
        const system = { system: [`${instruction}\n<plugin-env>\n Date: ${date}\n</plugin-env>`] };
        // The private trace is dispatch evidence, not a completion oracle. Tests
        // choose separately whether a completed-assistant event follows the send.
        const tracePass = Math.min(pass, 6);
        const stages = mainStages.slice(tracePass * 2, tracePass * 2 + 2).map((row) => row.at);
        expect(stages).toEqual(["system", "messages"]);
        if (order === "stock") stages.reverse();
        for (const stage of stages) {
            if (stage === "system")
                await hooks!["experimental.chat.system.transform"](
                    { sessionID: sessionId, model: route },
                    system,
                );
            else await hooks!["experimental.chat.messages.transform"]({}, output as never);
        }
        execute = false;
        const texts = output.messages
            .slice(0, 2)
            .map((m) => m.parts.map((p) => p.text ?? "").join("\n"));
        const result = {
            system: system.system.join("\n"),
            m0: texts[0]!,
            m1: texts[1]!,
            messages: output.messages,
        };
        if (process.env.MC_HOOK_ORDER_CAPTURE)
            appendFileSync(
                process.env.MC_HOOK_ORDER_CAPTURE,
                `${JSON.stringify({ order, sessionId, pass, complete, ...result, hashes: [result.system, result.m0, result.m1].map(digest) })}\n`,
            );
        pass++;
        if (complete)
            await hooks!.event({
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            id: `reply_${pass}`,
                            role: "assistant",
                            sessionID: sessionId,
                            ...route,
                            time: { created: now, completed: now },
                            finish: "stop",
                            tokens: {
                                input: 1000,
                                output: 1,
                                reasoning: 0,
                                cache: { read: 0, write: 0 },
                            },
                        },
                    },
                },
            });
        return result;
    }
    function appendDelta() {
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 0,
                endMessage: 0,
                startMessageId: "msg_0001",
                endMessageId: "msg_0001",
                title: "Retained fact",
                content: "DELTA_TO_FOLD",
                p1: "DELTA_TO_FOLD",
            },
        ]);
        execute = true;
    }
    function flush() {
        liveSessionState.historyRefreshSessions.add(sessionId);
        liveSessionState.systemPromptRefreshSessions.add(sessionId);
        requestPendingMaterialization(
            liveSessionState.pendingMaterializationSessions,
            sessionId,
            "user_flush",
        );
    }
    return { serve, appendDelta, flush, db, sessionId };
}

describe("standalone real hooks under private system-first dispatch", () => {
    it("folds pending m[1] into the same normal request as a changed system", async () => {
        const f = fixture();
        await f.serve();
        f.appendDelta();
        const warm = await f.serve();
        expect(warm.m1).toContain("DELTA_TO_FOLD");
        const changed = await f.serve("edited instructions");
        const next = await f.serve("edited instructions");
        expect(changed.system).not.toBe(warm.system);
        expect(changed.m0).toContain("DELTA_TO_FOLD");
        expect(changed.m1).not.toContain("DELTA_TO_FOLD");
        expect([next.system, next.m0, next.m1]).toEqual([changed.system, changed.m0, changed.m1]);
    });

    it("folds pending m[1] on system change after an unfinished request without completion", async () => {
        const f = fixture();
        await f.serve();
        f.appendDelta();
        await f.serve();
        await f.serve();
        await f.serve("base instructions", "2026-10-14", false);
        await f.serve("base instructions", "2026-10-14", false);
        const aborted = await f.serve("base instructions", "2026-10-14", false);
        expect(aborted.m1).toContain("DELTA_TO_FOLD");
        const changed = await f.serve("edited instructions");
        const next = await f.serve("edited instructions");
        expect(changed.system).not.toBe(aborted.system);
        expect(changed.m0).toContain("DELTA_TO_FOLD");
        expect(changed.m1).not.toContain("DELTA_TO_FOLD");
        expect([next.system, next.m0, next.m1]).toEqual([changed.system, changed.m0, changed.m1]);
    });

    it("freezes the midnight date until a real prefix rewrite and advances it once", async () => {
        const f = fixture();
        const before = await f.serve();
        now = Date.UTC(2026, 9, 15, 0, 1);
        const midnight = await f.serve("base instructions", "2026-10-15", false);
        expect(midnight.system).toBe(before.system);
        f.flush();
        const changed = await f.serve("base instructions", "2026-10-15");
        const next = await f.serve("base instructions", "2026-10-15");
        expect(changed.system).toContain("Date: 2026-10-15");
        expect([next.system, next.m0, next.m1]).toEqual([changed.system, changed.m0, changed.m1]);
    });

    it("keeps stock messages-first bytes frozen through a system edit and the following request", async () => {
        const f = fixture("stock");
        await f.serve();
        f.appendDelta();
        const warm = await f.serve("base instructions", "2026-10-14", false);
        expect(warm.m1).toContain("DELTA_TO_FOLD");
        const changed = await f.serve("edited instructions");
        const next = await f.serve("edited instructions");
        expect(changed.system).not.toBe(warm.system);
        expect([changed.m0, changed.m1]).toEqual([warm.m0, warm.m1]);
        expect([next.system, next.m0, next.m1]).toEqual([changed.system, changed.m0, changed.m1]);
    });

    it("title generation with neither transform cannot consume main-request state", async () => {
        const f = fixture();
        await f.serve();
        f.appendDelta();
        const aborted = await f.serve("base instructions", "2026-10-14", false);
        const metaBefore = getOrCreateSessionMeta(f.db, f.sessionId);
        // Model the system-first host's separate title generator: it sends a
        // single-shot prompt without invoking either plugin transform.
        const titleRequest = {
            system: "Generate a concise title",
            messages: [{ role: "user", content: "current task" }],
        };
        expect(JSON.stringify(titleRequest)).not.toContain("Magic Context");
        expect(getOrCreateSessionMeta(f.db, f.sessionId)).toEqual(metaBefore);
        const after = await f.serve();
        expect([after.system, after.m0, after.m1]).toEqual([
            aborted.system,
            aborted.m0,
            aborted.m1,
        ]);
    });
});
