import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompactionHandler } from "../../../features/magic-context/compaction";
import { runMigrations } from "../../../features/magic-context/migrations";
import { createScheduler } from "../../../features/magic-context/scheduler";
import { getOverflowState } from "../../../features/magic-context/storage";
import { initializeDatabase } from "../../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../../features/magic-context/storage-meta";
import { createTagger } from "../../../features/magic-context/tagger";
import {
    type BridgeHostFact,
    type BridgeTransport,
    createBridgeAdapter,
} from "../../../host-runner";
import { Database } from "../../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { createEventHandler } from "../event-handler";
import { setRawMessageProvider } from "../read-session-chunk";
import { createModuleSessionKernel } from "../module-session-kernel";
import type { TransformDeps } from "../transform";
import type { MessageLike } from "../transform-operations";
import { startOracle } from "./conformance/oracle";
import { InjectedBridgeTransport } from "./injected-transport";
import { createOpenCodeProviderTransform } from "./opencode-adapter";

const id = "relay-v1";
const model = { providerID: "bridge-fixture", modelID: "unknown" };
const modelKey = `${model.providerID}/${model.modelID}`;
const rows = [
    {
        info: { id: "user-1", sessionID: id, role: "user", model },
        parts: [{ id: "text-1", type: "text", text: "A synthetic user turn" }],
    },
] as MessageLike[];

function fixture() {
    const root = join(tmpdir(), "magic-context", "bridge-host-facts");
    mkdirSync(root, { recursive: true });
    const dir = createTestTempDirFromPath(join(root, "usage-"));
    const db = new Database(join(dir, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    const configPath = join(dir, "config.jsonc");
    writeFileSync(
        configPath,
        JSON.stringify({
            historian: { disable: true },
            memory: { enabled: false },
            execute_threshold_percentage: 65,
            cache_ttl: "never",
        }),
    );
    return {
        dir,
        db,
        options: {
            openCodeClient: { session: {} } as any,
            projectRoot: dir,
            storageDir: dir,
            connectionFile: join(dir, "connection.json"),
            configPath,
        },
    };
}

test("bridge usage reaches scheduler bands and frame parity", async () => {
    const oracle = startOracle();
    const unregister = setRawMessageProvider(id, {
        readMessages: () => [],
        getStoredMessageCount: () => 1,
        getMessageCount: () => 1,
        hasMessageById: (mid) => mid === "user-1",
        readMessageOrdinalPage: (after) =>
            after
                ? []
                : [
                      {
                          id: "user-1",
                          timeCreated: 1,
                          contributesOrdinal: true,
                          hasValidInfo: true,
                      },
                  ],
    });
    try {
        for (const [percentage, band] of [
            [50, "Defer"],
            [70, "Execute"],
            [86, "Force85"],
            [96, "Emergency95"],
        ] as const) {
            const now = Date.now();
            const total = percentage * 2000;
            const meters = {
                input: total - 12_000,
                cacheRead: 10_000,
                cacheWrite: 2_000,
                output: 4_000,
            };
            const frames: any[] = [];
            const outcomes: any[] = [];
            for (const lane of ["bridge", "opencode"] as const) {
                await oracle.call({ control: "reset" });
                const f = fixture();
                let lastFrame: any;
                let lastAnswer: any;
                const wire: BridgeTransport = {
                    request: async (method, body) => {
                        if (method === "module.capabilities" || method === "state_sync")
                            return new TextEncoder().encode("{}");
                        const request = JSON.parse(new TextDecoder().decode(body));
                        if (method === "compaction.step") lastFrame = request.params;
                        const answer = JSON.parse(await oracle.call(request));
                        if (method === "compaction.step") lastAnswer = answer;
                        // Ask for status even below the execute threshold, so the
                        // test can inspect a real compaction frame at 50% usage.
                        if (method === "compaction.setup" && answer.answer === "ready")
                            answer.call_when.share = 0;
                        return new TextEncoder().encode(JSON.stringify(answer));
                    },
                };
                let dispose: (() => Promise<void>) | undefined;
                try {
                    if (lane === "bridge") {
                        const bridge = await createBridgeAdapter({ ...f.options, transport: wire });
                        dispose = () => bridge.dispose();
                        const initial = await bridge.run({
                            sessionId: id,
                            messages: rows.slice(),
                            kind: "model",
                        });
                        await oracle.call({ control: "scheduler" });
                        expect(
                            await bridge.recordHostFact({
                                kind: "provider_response",
                                sessionId: id,
                                lineageId: initial.receipt.lineage_id,
                                requestId: initial.receipt.request_id,
                                model,
                                observedAt: now,
                                completedAt: now,
                                finishReason: "stop",
                                outcome: "success",
                                usage: meters,
                                contextWindow: 200_000,
                            }),
                        ).toEqual({ accepted: true });
                        if (percentage === 70) {
                            expect(
                                await bridge.recordHostFact({
                                    kind: "provider_response",
                                    sessionId: id,
                                    lineageId: initial.receipt.lineage_id,
                                    requestId: initial.receipt.request_id,
                                    model,
                                    observedAt: now + 1,
                                    completedAt: now + 1,
                                    finishReason: "stop",
                                    outcome: "success",
                                    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 7 },
                                    contextWindow: 200_000,
                                }),
                            ).toEqual({ accepted: true });
                        }
                        expect(bridge.receipt(id)?.delivery).toBe("pending");
                        const run = bridge.run({
                            sessionId: id,
                            messages: rows.slice(),
                            kind: "model",
                        });
                        if (percentage === 96) {
                            // With no summarizable history, emergency pressure
                            // must refuse instead of silently sending the oversized view.
                            await expect(run).rejects.toMatchObject({
                                code: "EMERGENCY_FAIL_CLOSED",
                            });
                        } else await run;
                    } else {
                        const transport = new InjectedBridgeTransport(wire);
                        const deps: TransformDeps = {
                            db: f.db,
                            directory: f.dir,
                            projectPath: f.dir,
                            storeGeneration: "v1",
                            transformMode: "rust",
                            rustPipeline: "provider",
                            rustModeModuleClient: transport,
                            tagger: createTagger(),
                            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
                            contextUsageMap: new Map(),
                            historyRefreshSessions: new Set(),
                            pendingMaterializationSessions: new Set(),
                            lastHeuristicsTurnId: new Map(),
                            historianRunnable: false,
                        };
                        const legacy = createModuleSessionKernel({
                            moduleClient: transport,
                            projectRoot: f.dir,
                        });
                        const native = createOpenCodeProviderTransform(deps, legacy);
                        dispose = async () => {
                            await native.dispose();
                            legacy.dispose();
                            transport.close();
                        };
                        const meta = () => getOrCreateSessionMeta(f.db, id);
                        await native.run(id, rows.slice(), { messages: [] }, meta());
                        await oracle.call({ control: "scheduler" });
                        const event = createEventHandler({
                            db: f.db,
                            tagger: deps.tagger,
                            contextUsageMap: deps.contextUsageMap,
                            compactionHandler: createCompactionHandler(),
                            config: { cache_ttl: "never", execute_threshold_percentage: 65 },
                        });
                        await event({
                            event: {
                                type: "message.updated",
                                properties: {
                                    info: {
                                        role: "assistant",
                                        sessionID: id,
                                        providerID: model.providerID,
                                        modelID: model.modelID,
                                        time: { completed: now },
                                        finish: "stop",
                                        tokens: {
                                            input: meters.input,
                                            output: meters.output,
                                            cache: {
                                                read: meters.cacheRead,
                                                write: meters.cacheWrite,
                                            },
                                        },
                                    },
                                },
                            },
                        });
                        expect(deps.contextUsageMap.get(id)?.usage.percentage).toBe(percentage);
                        expect(
                            deps.scheduler.shouldExecute(
                                meta(),
                                deps.contextUsageMap.get(id)!.usage,
                                now,
                                id,
                                modelKey,
                                200_000,
                            ),
                        ).toBe(percentage === 50 ? "defer" : "execute");
                        const run = native.run(id, rows.slice(), { messages: [] }, meta());
                        if (percentage === 96)
                            await expect(run).rejects.toMatchObject({
                                code: "EMERGENCY_FAIL_CLOSED",
                            });
                        else await run;
                    }
                    frames.push({
                        previous_usage: lastFrame.previous_usage,
                        estimate: lastFrame.estimate,
                        context_window: lastFrame.context_window,
                    });
                    const outcome = JSON.parse(await oracle.call({ control: "scheduler" }));
                    if (percentage === 50) {
                        // At 50% the provider defers without running the engine,
                        // so no scheduler outcome is captured and the answer is noop.
                        expect(outcome).toBeNull();
                        expect(lastAnswer.answer).toBe("noop");
                    } else {
                        expect(outcome).toMatchObject({
                            pass: band,
                            pressure_execute: true,
                            idle_ttl_fired: false,
                        });
                    }
                    outcomes.push(
                        outcome && {
                            ...outcome,
                            drain_latch: { active: outcome.drain_latch.active_since_ms !== null },
                        },
                    );
                    expect(frames.at(-1)).toEqual({
                        previous_usage: {
                            input: total - 12_000,
                            cache_read: 10_000,
                            cache_write: 2_000,
                            output: 4_000,
                            completed_at: now,
                            finish_reason: "stop",
                        },
                        estimate: { request_tokens: total },
                        context_window: 200_000,
                    });
                } finally {
                    await dispose?.();
                    f.db.close();
                    cleanupTestTempDir(f.dir);
                }
            }
            expect(frames[0]).toEqual(frames[1]);
            expect(outcomes[0]).toEqual(outcomes[1]);
        }
    } finally {
        unregister();
        await oracle.close();
    }
}, 1_800_000);

test("host facts preserve failure, scope, sticky dates and native todo state", async () => {
    const f = fixture();
    const calls: any[] = [];
    let version = 1;
    const wire: BridgeTransport = {
        request: async (method, body) => {
            const request = JSON.parse(new TextDecoder().decode(body));
            const p = request.params ?? request;
            calls.push(request);
            let answer: unknown = {};
            if (method === "transform.declare") answer = { subscriptions: [] };
            if (method === "compaction.setup")
                answer = {
                    answer: "ready",
                    request_id: p.request_id,
                    initial: {
                        compaction_id: "initial",
                        version: 1,
                        range: { from: 0, to: 0 },
                        replacement: [],
                    },
                    call_when: { share: 0 },
                };
            if (method === "compaction.step")
                answer = {
                    answer: "compaction_message",
                    request_id: p.request_id,
                    compaction: {
                        compaction_id: `view-${version}`,
                        version: ++version,
                        range: { from: 1, to: p.newest.ordinal + 1 },
                        replacement: p.messages.map((m: any) => m.message),
                    },
                };
            return new TextEncoder().encode(JSON.stringify(answer));
        },
    };
    const unregister = setRawMessageProvider(id, {
        readMessages: () => [],
        getStoredMessageCount: () => 1,
        getMessageCount: () => 1,
        hasMessageById: () => true,
        readMessageOrdinalPage: (after) =>
            after
                ? []
                : [{ id: "user-1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true }],
    });
    const bridge = await createBridgeAdapter({ ...f.options, transport: wire });
    try {
        const initial = await bridge.run({ sessionId: id, messages: rows.slice(), kind: "model" });
        const now = Date.now();
        const scope = {
            sessionId: id,
            lineageId: initial.receipt.lineage_id,
            model,
            observedAt: now,
        };
        const response: BridgeHostFact = {
            ...scope,
            kind: "provider_response",
            requestId: initial.receipt.request_id,
            completedAt: now,
            finishReason: "error",
            outcome: "failed",
            contextWindow: 200_000,
            usage: { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 4 },
            error: { message: "maximum context length is 200000 tokens, requested 210000 tokens" },
        };
        expect(await bridge.recordHostFact({ ...response, lineageId: "old" })).toEqual({
            accepted: false,
        });
        expect(await bridge.recordHostFact({ ...response, requestId: "old" })).toEqual({
            accepted: false,
        });
        await expect(
            bridge.recordHostFact({ ...response, observedAt: now + 120_000 }),
        ).rejects.toThrow("Invalid bridge host-fact");
        expect(
            await bridge.recordHostFact({
                ...response,
                error: undefined,
                finishReason: "unrecognized_failure",
            }),
        ).toEqual({ accepted: true });
        expect(getOrCreateSessionMeta(f.db, id).lastResponseTime).toBe(0);
        expect(getOrCreateSessionMeta(f.db, id).observedSafeInputTokens).toBe(0);
        expect(await bridge.recordHostFact(response)).toEqual({ accepted: true });
        expect(
            await bridge.recordHostFact({ ...response, model: { ...model, modelID: "other" } }),
        ).toEqual({ accepted: false });
        expect(bridge.receipt(id)).toEqual(initial.receipt);
        const meta = getOrCreateSessionMeta(f.db, id);
        expect(meta.lastResponseTime).toBe(0);
        expect(meta.observedSafeInputTokens).toBe(0);
        expect(getOverflowState(f.db, id).needsEmergencyRecovery).toBe(true);
        await bridge.run({ sessionId: id, messages: rows.slice(), kind: "model" });
        const frame = calls.filter((c) => c.method === "compaction.step").at(-1).params;
        expect(frame.previous_usage).toMatchObject({
            input: 100_000,
            output: 4,
            finish_reason: "error",
        });
        expect(frame.estimate.request_tokens).toBe(100_000);
        expect(
            await bridge.recordHostFact({ ...response, observedAt: now - 1, completedAt: now - 1 }),
        ).toEqual({ accepted: false });
        const prompt = await bridge.recordHostFact({
            ...scope,
            kind: "system_prompt",
            system: ["Today's date: 2026-10-16\n"],
        });
        const midnight = await bridge.recordHostFact({
            ...scope,
            observedAt: now + 1,
            kind: "system_prompt",
            system: ["Today's date: 2026-10-17\n"],
        });
        expect(prompt.system?.join("\n")).toContain("Today's date: 2026-10-16");
        expect(midnight.system).toEqual(prompt.system);
        const todo: BridgeHostFact = {
            ...scope,
            observedAt: now + 2,
            kind: "todowrite",
            tool: "todowrite",
            ownerMessageId: "assistant-1",
            callable: true,
            todos: [{ id: "one", content: "Synthetic task", status: "pending", priority: "high" }],
        };
        expect(await bridge.recordHostFact({ ...todo, callable: false })).toEqual({
            accepted: false,
        });
        expect(getOrCreateSessionMeta(f.db, id).lastTodoState).toBe("");
        expect(await bridge.recordHostFact(todo)).toEqual({ accepted: true });
        expect(JSON.parse(getOrCreateSessionMeta(f.db, id).lastTodoState)).toEqual([
            { content: "Synthetic task", status: "pending", priority: "high" },
        ]);
        expect(calls.find((c) => c.method === "todo_state.set")).toMatchObject({
            owner_message_id: "assistant-1",
        });
        const current = bridge.receipt(id)!;
        const noMeters: BridgeHostFact = {
            ...response,
            requestId: current.request_id,
            observedAt: now + 3,
            completedAt: now + 3,
            finishReason: "stop",
            outcome: "success",
            error: undefined,
            usage: undefined,
        };
        expect(await bridge.recordHostFact(noMeters)).toEqual({ accepted: true });
        expect(getOrCreateSessionMeta(f.db, id).lastResponseTime).toBe(now + 3);
        expect(getOrCreateSessionMeta(f.db, id).lastInputTokens).toBe(100_000);
        expect(
            await bridge.recordHostFact({
                ...noMeters,
                observedAt: now + 4,
                completedAt: now + 4,
                usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 7 },
            }),
        ).toEqual({ accepted: true });
        expect(getOrCreateSessionMeta(f.db, id).lastInputTokens).toBe(100_000);
        await bridge.run({ sessionId: id, messages: rows.slice(), kind: "model" });
        const retained = calls.filter((c) => c.method === "compaction.step").at(-1).params;
        expect(retained.previous_usage).toMatchObject({ input: 100_000 });
        expect(retained.estimate.request_tokens).toBe(100_000);
        const freshId = bridge.receipt(id)!.request_id;
        await expect(
            bridge.recordHostFact({ ...noMeters, requestId: freshId, contextWindow: 0 }),
        ).rejects.toThrow("Invalid bridge provider");
        expect(bridge.receipt(id)?.delivery).toBe("pending");
    } finally {
        await bridge.dispose();
        unregister();
        f.db.close();
        cleanupTestTempDir(f.dir);
    }
});

test("zero-total bridge usage does not seed pressure, while cache-only usage is real", async () => {
    const f = fixture();
    const calls: any[] = [];
    let version = 1;
    const wire: BridgeTransport = {
        request: async (method, body) => {
            const request = JSON.parse(new TextDecoder().decode(body));
            const p = request.params ?? request;
            calls.push(request);
            let answer: unknown = {};
            if (method === "transform.declare") answer = { subscriptions: [] };
            if (method === "compaction.setup")
                answer = {
                    answer: "ready",
                    request_id: p.request_id,
                    initial: {
                        compaction_id: "initial",
                        version: 1,
                        range: { from: 0, to: 0 },
                        replacement: [],
                    },
                    call_when: { share: 0 },
                };
            if (method === "compaction.step")
                answer = {
                    answer: "compaction_message",
                    request_id: p.request_id,
                    compaction: {
                        compaction_id: `view-${version}`,
                        version: ++version,
                        range: { from: 1, to: p.newest.ordinal + 1 },
                        replacement: p.messages.map((m: any) => m.message),
                    },
                };
            return new TextEncoder().encode(JSON.stringify(answer));
        },
    };
    const unregister = setRawMessageProvider(id, {
        readMessages: () => [],
        getStoredMessageCount: () => 1,
        getMessageCount: () => 1,
        hasMessageById: () => true,
        readMessageOrdinalPage: (after) =>
            after
                ? []
                : [{ id: "user-1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true }],
    });
    const bridge = await createBridgeAdapter({ ...f.options, transport: wire });
    try {
        const initial = await bridge.run({ sessionId: id, messages: rows.slice(), kind: "model" });
        const now = Date.now();
        const zeroFact: BridgeHostFact = {
            kind: "provider_response",
            sessionId: id,
            lineageId: initial.receipt.lineage_id,
            requestId: initial.receipt.request_id,
            model,
            observedAt: now,
            completedAt: now,
            finishReason: "stop",
            outcome: "success",
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 7 },
            contextWindow: 200_000,
        };
        expect(await bridge.recordHostFact(zeroFact)).toEqual({ accepted: true });
        await bridge.run({ sessionId: id, messages: rows.slice(), kind: "model" });
        let frame = calls.filter((c) => c.method === "compaction.step").at(-1).params;
        expect(frame.previous_usage).toBeUndefined();
        expect(frame.estimate.request_tokens).toBe(0);

        const current = bridge.receipt(id)!;
        expect(
            await bridge.recordHostFact({
                ...zeroFact,
                lineageId: current.lineage_id,
                requestId: current.request_id,
                observedAt: now + 1,
                completedAt: now + 1,
                usage: { input: 0, cacheRead: 5_000, cacheWrite: 2_000, output: 11 },
            }),
        ).toEqual({ accepted: true });
        await bridge.run({ sessionId: id, messages: rows.slice(), kind: "model" });
        frame = calls.filter((c) => c.method === "compaction.step").at(-1).params;
        expect(frame.previous_usage).toMatchObject({
            input: 0,
            cache_read: 5_000,
            cache_write: 2_000,
            output: 11,
        });
        expect(frame.estimate.request_tokens).toBe(7_000);
    } finally {
        await bridge.dispose();
        unregister();
        f.db.close();
        cleanupTestTempDir(f.dir);
    }
});
