import { expect, test } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { Database } from "../../shared/sqlite";
import { publishDreamChildHost } from "./dream-child-claimant";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

/**
 * Where the dream-child claimant meets a transform pass.
 *
 * The claimant is off unless the host sets `dreamChildClaimantEnabled`; nothing
 * sets it yet. Off, a pass must send no dream-child operation and hand back the
 * same messages it always did; on, each pass looks for pending dream children
 * on the session's own route.
 */

const project = process.cwd();
const providerID = "host-runner-wiring-provider";
const modelID = "host-runner-wiring-model";

function createFixture(sessionId: string, dreamChildClaimantEnabled?: boolean) {
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    const row = { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => [row],
        readMessageOrdinalPage: (after, limit) => (after ? [] : [row].slice(0, limit)),
        getStoredMessageCount: () => 1,
        readMessagePartsById: () => ({
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
            createdAt: 1,
        }),
    });
    const messages: MessageLike[] = [
        {
            info: { id: "m1", role: "user", sessionID: sessionId, model: { providerID, modelID } },
            parts: [{ type: "text", text: "hello" }],
        },
    ];
    const methods: string[] = [];
    const bodies: Array<{ method: string; body: unknown }> = [];
    let rowVersion = 0;
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {
            methods.push(method);
            bodies.push({ method, body });
            if (method === "historian.pending") return { ok: true, runs: [] };
            if (method === "dream.child.pending") return { ok: true, entries: [] };
            if (method !== "transform") return { ok: true };
            return {
                decision: "HARD",
                row_version: ++rowVersion,
                rendered_memory_ids: [],
                native_messages: structuredClone(messages),
            };
        },
    };
    const deps: TransformDeps = {
        tagger: {} as TransformDeps["tagger"],
        scheduler: {} as TransformDeps["scheduler"],
        contextUsageMap: new Map(),
        db,
        protectedTokens: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: project,
        projectPath: project,
        memoryConfig: { enabled: false, injectionBudgetTokens: 1, autoPromote: false },
        liveModelBySession: new Map([[sessionId, { providerID, modelID }]]),
        sessionDirectoryBySession: new Map([[sessionId, project]]),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        // With the historian on Broca this transform polls no historian runs, so any
        // new module traffic is the dream-child claimant's.
        historianRunner: "broca",
        ...(dreamChildClaimantEnabled !== undefined ? { dreamChildClaimantEnabled } : {}),
    };
    const transform = createRustModeTransform(deps, {
        moduleClient,
        scheduleLkgCapture: (capture) => capture(),
    });
    return {
        methods,
        bodies,
        async run(): Promise<unknown[]> {
            const input = structuredClone(messages);
            const output = { messages: structuredClone(input) as unknown[] };
            await transform.run(sessionId, input, output, getOrCreateSessionMeta(db, sessionId));
            // The poll is started by the pass and deliberately not awaited by it.
            await new Promise((resolve) => setTimeout(resolve, 0));
            return output.messages;
        },
        async dispose() {
            await transform.stopHostRunner();
            unregister();
            closeReadOnlySessionDb();
            resetLkgSlotsForTest();
            db.close();
        },
    };
}

test("off by default: passes send no dream-child operation and serve the same messages", async () => {
    const off = createFixture("dream-wiring-default");
    const explicit = createFixture("dream-wiring-default", false);
    try {
        for (let pass = 0; pass < 3; pass++) {
            expect(JSON.stringify(await off.run())).toBe(JSON.stringify(await explicit.run()));
        }
        expect(off.methods.filter((method) => method.startsWith("dream.child."))).toEqual([]);
        expect(explicit.methods.filter((method) => method.startsWith("dream.child."))).toEqual([]);
        expect(off.methods).toEqual(explicit.methods);
    } finally {
        await off.dispose();
        await explicit.dispose();
    }
});

test("switched on, each pass looks for dream children on its own session's route", async () => {
    // Stands in for the dream child carrier an OpenCode 2 instance publishes for
    // its directory; no child is created in this test.
    const withdraw = publishDreamChildHost(project, () => ({
        capabilities: {
            tools: ["ctx_memory"],
            child_guard: true,
            steps: true,
            tokens: true,
            stop: true,
            retire: true,
            task_tools: true,
            filesystem_fence: false,
            default_model: false,
        },
        refusal: () => "unused",
        create: async () => {
            throw new Error("no entry was pending");
        },
    }));
    const fixture = createFixture("dream-wiring-on", true);
    try {
        await fixture.run();
        await fixture.run();
        const lane = fixture.bodies.filter(({ method }) => method.startsWith("dream.child."));
        expect(lane.map(({ method }) => method)).toEqual([
            "dream.child.pending",
            "dream.child.pending",
        ]);
        for (const { method, body } of lane) expect(body).toEqual({ method, v: 1 });
    } finally {
        await fixture.dispose();
        withdraw();
    }
});
