/// <reference types="bun-types" />
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { openDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { recordToolDefinition } from "../../features/magic-context/tool-definition-tokens";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { bindV2SystemPromptResponse } from "../../v2/hooks/system-prompt-response";
import type { StoreRow } from "../../v2/store-reader";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import { requestPendingMaterialization } from "./pending-materialization";
import { setRawMessageProvider } from "./read-session-chunk";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform, type TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

const route = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const modelKey = `${route.providerID}/${route.modelID}`;
let sequence = 0;

async function fixture(mode: "ts" = "ts", generation: "v1" | "v2" = "v1") {
    const sessionId = `system-delivery-${++sequence}`;
    const home = createTestTempDirFromPath(join(tmpdir(), "system-delivery-"));
    const project = join(home, "project");
    mkdirSync(project);
    const db = openDatabase(join(home, "context.db"))!;
    runMigrations(db);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    recordDetectedContextLimit(db, sessionId, 200_000, modelKey);
    recordToolDefinition(route.providerID, route.modelID, undefined, "read", "Read", {
        type: "object",
    });
    const user = (id: string, text: string): MessageLike => ({
        info: { id, sessionID: sessionId, role: "user", model: route },
        parts: [{ type: "text", text }],
    });
    const source: MessageLike[] = [
        user("old-prompt", "earlier task"),
        {
            info: {
                id: "old-answer",
                sessionID: sessionId,
                role: "assistant",
                providerID: route.providerID,
                modelID: route.modelID,
                finish: "stop",
            },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "read-old",
                    state: {
                        status: "completed",
                        input: { path: "old.ts" },
                        output: "historical answer to drop",
                    },
                },
            ],
        },
        user("prompt", "current task"),
    ];
    for (let i = 0; i < 12; i++)
        source.splice(source.length - 1, 0, {
            info: {
                id: `old-tool-${i}`,
                sessionID: sessionId,
                role: "assistant",
                providerID: route.providerID,
                modelID: route.modelID,
                finish: "stop",
            },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: `read-old-${i}`,
                    state: {
                        status: "completed",
                        input: { path: `old-${i}.ts` },
                        output: i >= 9 ? "earlier result ".repeat(8000) : "earlier result",
                    },
                },
            ],
        });
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
        readMessagePartsById: (id) => {
            const m = source.find((m) => m.info.id === id)!;
            return { id, role: m.info.role, parts: m.parts, createdAt: source.indexOf(m) + 1 };
        },
    });
    const deps: TransformDeps = {
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        contextUsageMap: new Map(),
        protectedTokens: 4000,
        clearReasoningAge: 50,
        keepReasoningTokens: 0,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: project,
        projectPath: project,
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map([[sessionId, route]]),
        sessionDirectoryBySession: new Map([[sessionId, project]]),
        transformMode: "ts",
        historianRunner: "broca",
        historianRunnable: false,
        protectedTools: { read: 0 },
        client: {
            session: { get: async () => ({ data: { directory: project } }) },
        } as TransformDeps["client"],
    };
    registerSystemDateRefresh(deps.historyRefreshSessions);
    let messagesPrepared = false;
    const system = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        memoryEnabled: false,
        resolveModel: () => deps.liveModelBySession!.get(sessionId),
        historyRefreshSessions: deps.historyRefreshSessions,
        pendingMaterializationSessions: deps.pendingMaterializationSessions,
        systemPromptRefreshSessions: new Set(),
        lastHeuristicsTurnId: deps.lastHeuristicsTurnId,
        consumeMessagesPrepared: () => messagesPrepared,
    });
    const tsTransform = createTransform(deps);
    let reply = 0;
    const responseRows: StoreRow<"assistant">[] = [];
    const serve = async (text = "base", order = "system-first", date = "2026-10-13") => {
        const responseId = `reply-${++reply}`;
        messagesPrepared = false;
        const activeModel = deps.liveModelBySession!.get(sessionId)!;
        const key = `${activeModel.providerID}/${activeModel.modelID}`;
        if (generation === "v2")
            beginV2LkgRequest(sessionId, key, `reply-${reply - 1}`, responseRows.length);
        else noteLkgProviderResponse({ sessionId, responseId, modelKey: key, inputTokens: 0 });
        const input = structuredClone(source);
        const output = { messages: structuredClone(input) as unknown[] };
        bindSystemDateRequestIdentity(output, output);
        const outputSystem = { system: [`${text}\n<plugin-env>\n  Date: ${date}\n</plugin-env>`] };
        if (order === "system-first")
            await system.handler(
                { sessionID: sessionId, dateRefreshRequest: output, model: activeModel },
                outputSystem,
            );
        await tsTransform({}, output as never);
        messagesPrepared = true;
        if (order === "messages-first")
            await system.handler(
                { sessionID: sessionId, dateRefreshRequest: output, model: activeModel },
                outputSystem,
            );
        return {
            messages: output.messages,
            system: outputSystem.system,
            accept: (finish = "tool-calls") => {
                const createdAt = Date.now() + 1;
                if (generation === "v2") {
                    responseRows.push({
                        id: responseId,
                        session_id: sessionId,
                        type: "assistant",
                        seq: responseRows.length + 1,
                        data: {
                            model: { providerID: activeModel.providerID, id: activeModel.modelID },
                            time: { created: createdAt },
                            finish,
                        },
                    });
                    bindV2SystemPromptResponse(sessionId, {
                        assistantSince: (_session, after) =>
                            responseRows.filter((row) => row.seq > after),
                    });
                }
                noteLkgProviderResponse({
                    sessionId,
                    responseId,
                    modelKey: key,
                    inputTokens: 1000,
                    completedAt: Date.now(),
                    finish,
                    v2: generation === "v2",
                    createdAt,
                });
            },
        };
    };
    // A heavy signed step (1,600 reasoning tokens): the bounded hold keeps the
    // turn's prefix while usage stays below the cap (65% + 10).
    const hold = () =>
        source.push({
            info: {
                id: "thinking",
                sessionID: sessionId,
                role: "assistant",
                providerID: route.providerID,
                modelID: route.modelID,
                finish: "tool-calls",
                tokens: { input: 0, output: 1_600, reasoning: 1_600 },
            },
            parts: [
                {
                    type: "reasoning",
                    text: "signed plan",
                    metadata: { anthropic: { signature: "signed-plan" } },
                },
                {
                    type: "tool",
                    tool: "read",
                    callID: "read-current",
                    state: {
                        status: "completed",
                        input: { path: "current.ts" },
                        output: "current result ".repeat(8000),
                    },
                },
            ],
        });
    return {
        sessionId,
        db,
        deps,
        source,
        user,
        serve,
        hold,
        close: () => {
            unregister();
            clearLkgMeasuredRequest(sessionId);
            closeQuietly(db);
            rmSync(home, { recursive: true, force: true });
        },
    };
}

const head = (messages: unknown[]) => JSON.stringify(messages.slice(0, 2));

for (const mode of ["ts"] as const) {
    const test = it;
    for (const finish of ["aborted", "error", "unaccepted"]) {
        test(`${mode}: ${finish} system delivery is not acknowledged`, async () => {
            const f = await fixture(mode);
            try {
                (await f.serve()).accept("stop");
                f.hold();
                (await f.serve()).accept();
                const before = getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash;
                const held = await f.serve("changed instruction");
                if (finish !== "unaccepted") held.accept(finish);
                expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).toBe(before);
                f.source.push(f.user("wake", "continue"));
                const wake = await f.serve("changed instruction");
                expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).not.toBe(
                    before,
                );
            } finally {
                f.close();
            }
        }, 120_000);
    }
    for (const order of ["system-first", "messages-first"]) {
        test(`${mode}: plugin_env_date_only_change_stays_frozen_through_signed_head_hold (${order})`, async () => {
            const f = await fixture(mode);
            try {
                (await f.serve()).accept("stop");
                f.hold();
                const before = await f.serve("base", order);
                before.accept();
                const oldHash = getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash;
                const after = await f.serve("base", order, "2026-10-14");
                expect(after.system).toEqual(before.system);
                expect(getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash).toBe(oldHash);
                expect(head(after.messages)).toBe(head(before.messages));
            } finally {
                f.close();
            }
        }, 120_000);
    }
    test(`${mode}: a real unheld system-first edit folds on its first request`, async () => {
        const f = await fixture(mode);
        try {
            const before = await f.serve();
            before.accept("stop");
            expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).toBe(
                getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash,
            );
        } finally {
            f.close();
        }
    }, 120_000);
}

it("TypeScript: already_delivered_system_change_does_not_hard_after_signed_head_hold", async () => {
    const f = await fixture("ts");
    try {
        (await f.serve()).accept("stop");
        f.hold();
        const before = await f.serve();
        before.accept();
        const target = getTagsBySession(f.db, f.sessionId).find(
            (tag) => tag.type === "tool" && tag.messageId === "read-old",
        )!;
        expect(target).toBeDefined();
        queuePendingOp(f.db, f.sessionId, target.tagNumber, "drop");
        const held = await f.serve("changed instruction");
        expect(head(held.messages)).toBe(head(before.messages));
        expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
        held.accept();
        const next = await f.serve("changed instruction");
        next.accept();
        expect(head(next.messages)).toBe(head(before.messages));
        f.source.push(f.user("wake", "continue"));
        const wake = await f.serve("changed instruction");
        expect(head(wake.messages)).toBe(head(before.messages));
        expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
        expect(f.deps.deferredMaterializationSessions!.has(f.sessionId)).toBe(true);
        requestPendingMaterialization(
            f.deps.pendingMaterializationSessions,
            f.sessionId,
            "user_flush",
        );
        await f.serve("changed instruction");
        expect(getPendingOps(f.db, f.sessionId)).toHaveLength(0);
        const flushed = await f.serve("changed instruction");
        const after = await f.serve("changed instruction");
        expect(after.messages).toEqual(flushed.messages);
    } finally {
        f.close();
    }
}, 120_000);

for (const [input, patch] of [
    ["model", { cachedM0ModelKey: "anthropic/claude-opus-5-4" }],
    ["renderer", { cachedM0UpgradeState: "previous-renderer" }],
] as const) {
    it(`TypeScript: delivered system identity cannot waive a simultaneous ${input} change`, async () => {
        const f = await fixture("ts");
        try {
            (await f.serve()).accept("stop");
            f.hold();
            (await f.serve()).accept();
            updateSessionMeta(f.db, f.sessionId, patch);
            const held = await f.serve("changed instruction");
            held.accept();
            expect(
                getOrCreateSessionMeta(f.db, f.sessionId)[
                    input === "model" ? "cachedM0ModelKey" : "cachedM0UpgradeState"
                ],
            ).toBe(Object.values(patch)[0]);
            f.source.push(f.user("wake", "continue"));
            await f.serve("changed instruction");
            expect(
                getOrCreateSessionMeta(f.db, f.sessionId)[
                    input === "model" ? "cachedM0ModelKey" : "cachedM0UpgradeState"
                ],
            ).not.toBe(Object.values(patch)[0]);
        } finally {
            f.close();
        }
    }, 120_000);
}

for (const mode of ["ts"] as const) {
    const test = it;
    test(`${mode}: OpenCode2 already_delivered_system_change_does_not_hard_after_signed_head_hold`, async () => {
        const f = await fixture(mode, "v2");
        try {
            (await f.serve()).accept("stop");
            f.hold();
            const before = await f.serve();
            before.accept();
            {
                const target = getTagsBySession(f.db, f.sessionId).find(
                    (tag) => tag.type === "tool" && tag.messageId === "read-old",
                );
                if (!target) throw new Error("missing drop target");
                queuePendingOp(f.db, f.sessionId, target.tagNumber, "drop");
            }
            const held = await f.serve("changed instruction");
            held.accept();
            const next = await f.serve("changed instruction");
            next.accept();
            expect(head(next.messages)).toBe(head(before.messages));
            f.source.push(f.user("wake", "continue"));
            const wake = await f.serve("changed instruction");
            expect(head(wake.messages)).toBe(head(before.messages));
            expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
            await f.serve("independent content rebuild");
            expect(getPendingOps(f.db, f.sessionId)).toHaveLength(0);
        } finally {
            f.close();
        }
    }, 120_000);

    test(`${mode}: unheld provider-byte differential`, async () => {
        const f = await fixture(mode);
        try {
            const bodies: unknown[] = [];
            for (const text of [
                "base",
                "base",
                "independent unheld edit",
                "independent unheld edit",
            ]) {
                const served = await f.serve(text);
                served.accept("stop");
                bodies.push({
                    system: served.system,
                    messages: (served.messages as MessageLike[]).map((m) => ({
                        role: m.info.role,
                        parts: m.parts.map((part) => {
                            const p = part as Record<string, unknown>;
                            return {
                                type: p.type,
                                text: p.text,
                                tool: p.tool,
                                callID: p.callID,
                                state: p.state,
                                metadata: p.metadata,
                            };
                        }),
                    })),
                });
            }
            console.log(
                `UNHELD_PROVIDER_SHA ${mode} ${createHash("sha256").update(JSON.stringify(bodies)).digest("hex")}`,
            );
            expect(bodies).toHaveLength(4);
        } finally {
            f.close();
        }
    }, 120_000);
}

for (const mode of ["ts"] as const) {
    const test = it;
    test(`${mode}: aborted messages-first delivery is not acknowledged`, async () => {
        const f = await fixture(mode);
        try {
            (await f.serve()).accept("stop");
            f.hold();
            (await f.serve()).accept();
            const before = getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash;
            const held = await f.serve("changed instruction", "messages-first");
            held.accept("aborted");
            expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).toBe(before);
            f.source.push(f.user("wake", "continue"));
            const wake = await f.serve("changed instruction");
            expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).not.toBe(before);
        } finally {
            f.close();
        }
    }, 120_000);
}
