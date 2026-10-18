import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SubcClient } from "@cortexkit/subc-client";
import * as markerCandidates from "../../../features/magic-context/compaction-marker";
import { computeNormalizedHash } from "../../../features/magic-context/memory/normalize-hash";
import { resolveProjectIdentity } from "../../../features/magic-context/memory/project-identity";
import { runMigrations } from "../../../features/magic-context/migrations";
import { createScheduler } from "../../../features/magic-context/scheduler";
import * as storage from "../../../features/magic-context/storage-db";
import {
    getPersistedSchemaVersion,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "../../../features/magic-context/storage-db";
import * as runnerStorage from "../../../features/magic-context/storage-host-runner";
import { getOrCreateSessionMeta } from "../../../features/magic-context/storage-meta";
import {
    setPendingCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../../features/magic-context/tagger";
import {
    BridgeRefusalError,
    type BridgeTransportError,
    createBridgeAdapter,
    StoreVersionMismatchError,
} from "../../../host-runner";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import * as markerManager from "../compaction-marker-manager";
import { createModuleSessionKernel } from "../module-session-kernel";
import { SubcModuleTransport } from "../module-transport";
import { setRawMessageProvider } from "../read-session-chunk";
import type { TransformDeps } from "../transform";
import type { MessageLike } from "../transform-operations";
import { defaultCompactionMarkerStrategy } from "../transform-postprocess-phase";
import { createBridgeReceiptStore } from "./bridge-marker";
import { createOpenCodeProviderTransform } from "./opencode-adapter";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
test("bridge session deletion sends one scoped op per call and propagates relay failures", async () => {
    const options = fixture();
    const calls: { method: string; bytes: string }[] = [];
    let fail = true;
    const adapter = await createBridgeAdapter({
        ...options,
        transport: {
            async request(method, body) {
                calls.push({ method, bytes: Buffer.from(body).toString() });
                if (fail) throw { source: "relay", code: "relay_unavailable" };
                return Buffer.from('{"answer":"deleted"}');
            },
        },
    });
    cleanups.push(() => adapter.dispose());
    await expect(adapter.onSessionDeleted("deleted-session")).rejects.toEqual({
        source: "relay",
        code: "relay_unavailable",
    });
    fail = false;
    await adapter.onSessionDeleted("deleted-session");
    await adapter.onSessionDeleted("deleted-session");
    expect(calls).toEqual(
        Array.from({ length: 3 }, () => ({
            method: "compaction.delete",
            bytes: '{"method":"compaction.delete","params":{"session":"deleted-session","harness":"opencode"},"accept_reply_pages":true}',
        })),
    );
});
function message(id: string): MessageLike {
    return {
        info: {
            id,
            role: "user",
            sessionID: "session",
            model: { providerID: "openai", modelID: "gpt-5.6" },
        },
        parts: [{ id: `${id}-text`, type: "text", text: id }],
    } as MessageLike;
}
function firstText(row: MessageLike | undefined): string | undefined {
    const block = row?.parts[0] as { text?: unknown } | undefined;
    return typeof block?.text === "string" ? block.text : undefined;
}
function persistNativePair(db: Database, boundary: MessageLike, ordinal: number) {
    setPersistedCompactionMarkerState(db, "session", {
        boundaryMessageId: boundary.info.id!,
        summaryMessageId: "native-summary",
        compactionPartId: "native-part",
        summaryPartId: "native-text",
        boundaryOrdinal: ordinal,
        targetEndMessageId: boundary.info.id!,
    });
    return [
        {
            ...boundary,
            parts: [...boundary.parts, { id: "native-part", type: "compaction", auto: true }],
        },
        {
            info: {
                id: "native-summary",
                role: "assistant",
                parentID: boundary.info.id,
                summary: true,
                finish: "stop",
            },
            parts: [{ id: "native-text", type: "text", text: "native summary" }],
        },
    ] as MessageLike[];
}
function fixture(version = LATEST_SUPPORTED_VERSION) {
    const scratch = createTestTempDir("mc-bridge-constructor-");
    cleanups.push(scratch.cleanup);
    const dbPath = join(scratch.dir, "context.db");
    const db = new Database(dbPath);
    initializeDatabase(db);
    runMigrations(db);
    db.exec(`DELETE FROM schema_migrations WHERE version >= ${version} AND version < 10000`);
    db.prepare(
        "INSERT OR IGNORE INTO schema_migrations(version, description, applied_at) VALUES(?, 'fixture', ?)",
    ).run(version, Date.now());
    db.close();
    const configPath = join(scratch.dir, "selected.jsonc");
    writeFileSync(
        configPath,
        JSON.stringify({
            transform_mode: "ts",
            rust_pipeline: "full_request",
            historian: { runner: "broca", model: "openai/bridge-historian" },
        }),
    );
    return {
        dbPath,
        openCodeClient: { session: {} } as any,
        projectRoot: scratch.dir,
        connectionFile: join(scratch.dir, "connection.json"),
        storageDir: scratch.dir,
        configPath,
    };
}
function canonicalRows(rows: MessageLike[]) {
    const unregister = setRawMessageProvider("session", {
        readMessages: () => [],
        getStoredMessageCount: () => rows.length,
        getMessageCount: () => rows.length,
        hasMessageById: (id) => rows.some((m) => m.info.id === id),
        readMessageOrdinalPage: (after, limit) =>
            rows
                .map((m, i) => ({
                    id: m.info.id!,
                    timeCreated: i + 1,
                    contributesOrdinal: true,
                    hasValidInfo: true,
                }))
                .filter((row) => !after || row.timeCreated > after.timeCreated)
                .slice(0, limit),
    });
    cleanups.push(unregister);
}
function recordSnapshot(path: string) {
    const db = new Database(path);
    try {
        return [
            "host_runner_state",
            "host_runner_entries",
            "host_runner_ids",
            "host_runner_views",
        ].map((table) => db.prepare(`SELECT * FROM ${table} WHERE session_id='session'`).all());
    } finally {
        db.close();
    }
}
function fakeModule() {
    const calls: Record<string, any>[] = [];
    const payloads: Uint8Array[] = [];
    const binds: any[] = [];
    const close = mock(() => {});
    let version = 1;
    let reply: ((wire: Record<string, any>) => unknown) | undefined;
    const answer = (wire: Record<string, any>) => {
        calls.push(wire);
        const override = reply?.(wire);
        if (override !== undefined) return override;
        const p = wire.params ?? wire;
        switch (wire.method) {
            case "module.capabilities":
                return {};
            case "state_sync":
                return {};
            case "transform.declare":
                return {
                    subscriptions: [
                        {
                            hook: "pre_user",
                            ops: ["prepend"],
                            budget_ms: 2000,
                            on_unavailable: "pass",
                        },
                    ],
                };
            case "compaction.setup":
                return {
                    answer: "ready",
                    request_id: p.request_id,
                    initial: {
                        compaction_id: "initial",
                        version: 1,
                        range: { from: 0, to: 0 },
                        replacement: [],
                    },
                    call_when: { share: 0.9 },
                };
            case "transform.hook":
                return {
                    answer: "ops",
                    ops: p.blocks.map((_: unknown, block: number) => ({
                        op: "prepend",
                        block,
                        text: `§${p.subject_ordinal}§ `,
                    })),
                };
            case "compaction.step":
                return {
                    answer: "compaction_message",
                    request_id: p.request_id,
                    compaction: {
                        compaction_id: `view-${version}`,
                        version: ++version,
                        range: { from: 1, to: p.newest.ordinal + 1 },
                        replacement: p.messages.map((m: any) => m.message),
                    },
                };
            default:
                throw new Error(`Unexpected fake module method ${wire.method}`);
        }
    };
    const connect = spyOn(SubcClient, "connect").mockImplementation(
        async () =>
            ({
                routeOpen: async (target: unknown, identity: unknown, options: unknown) => {
                    binds.push({ target, identity, options });
                    return { channel: binds.length, epoch: 1 };
                },
                request: async (_route: unknown, body: Uint8Array) => {
                    payloads.push(body.slice());
                    return answer(JSON.parse(Buffer.from(body).toString()));
                },
                close,
            }) as any,
    );
    cleanups.push(() => {
        connect.mockRestore();
        close.mockRestore();
    });
    return {
        calls,
        payloads,
        answer,
        binds,
        close,
        connect,
        setReply(next: typeof reply) {
            reply = next;
        },
    };
}

describe("supported bridge constructor", () => {
    test("OpenCode durable applied pending view advances and post-cut fallback serves replacement plus raw tail", async () => {
        const options = fixture();
        const preparation = spyOn(
            markerCandidates,
            "prepareCompactionMarkerCandidates",
        ).mockImplementation(async () => {
            expect(db.inTransaction).toBe(false);
            return true;
        });
        cleanups.push(() => preparation.mockRestore());
        const wire = fakeModule();
        wire.setReply((request) => {
            if (request.method !== "compaction.step") return;
            return {
                answer: "compaction_message",
                request_id: request.params.request_id,
                compaction: {
                    compaction_id: "covering-pending",
                    version: 2,
                    range: { from: 1, to: 3 },
                    replacement: [message("summary")],
                },
                coverage: { end_mid: "first", ordinal: 2 },
            };
        });
        const rows = [message("prefix"), message("first"), message("second")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        const view = await adapter.run({ sessionId: "session", messages: rows, kind: "model" });
        const db = new Database(options.dbPath);
        cleanups.push(() => db.close());
        setPendingCompactionMarkerState(db, "session", {
            endMessageId: "first",
            ordinal: 2,
            publishedAt: 1,
        });
        let pair: MessageLike[] = [];
        const marker = spyOn(markerManager, "applyDeferredCompactionMarker").mockImplementation(
            (writerDb) => {
                const durable = createBridgeReceiptStore(db, "session", "opencode");
                expect(durable.current()).toEqual(view.receipt);
                expect(durable.cutState()).toBe("unknown");
                pair = persistNativePair(writerDb, rows[1], 2);
                return { kind: "applied", markerOrdinal: 2 };
            },
        );
        cleanups.push(() => marker.mockRestore());
        const inputs = {
            messages: rows,
            model: "openai/gpt-5.6",
            envelope: "complete",
            contextWindow: 100_000,
            systemPromptTokens: 100,
            toolDefinitionTokens: 0,
            material: { system: ["Final system"], tools: [] },
        };
        expect(view.receipt.delivery).toBe("pending");
        const before = JSON.stringify(view.messages);
        expect(
            await adapter.advanceNativeMarker("session", view.receipt, {
                ...inputs,
                material: undefined,
            }),
        ).toEqual({ kind: "deferred", reason: "native-marker-evidence-unavailable" });
        expect(marker).not.toHaveBeenCalled();
        expect(
            adapter.isFallbackAdmissible("session", { ...inputs, contextWindow: 600 }).admissible,
        ).toBe(true);
        const fact = {
            kind: "provider_response" as const,
            sessionId: "session",
            lineageId: view.receipt.lineage_id,
            requestId: view.receipt.request_id,
            model: { providerID: "openai", modelID: "gpt-5.6" },
            observedAt: Date.now(),
            completedAt: Date.now() - 1,
            finishReason: "stop",
            outcome: "success" as const,
            contextWindow: 100_000,
            material: inputs.material,
            usage: { input: 600, cacheRead: 80, cacheWrite: 20, output: 99_999 },
        };
        expect(await adapter.recordHostFact({ ...fact, requestId: "unrelated" })).toEqual({
            accepted: false,
        });
        expect((await adapter.recordHostFact(fact)).accepted).toBe(true);
        expect(
            (
                await adapter.advanceNativeMarker("session", view.receipt, {
                    ...inputs,
                    contextWindow: 600,
                })
            ).kind,
        ).toBe("deferred");
        expect(marker).not.toHaveBeenCalled();
        expect(JSON.stringify(view.messages)).toBe(before);
        expect((await adapter.advanceNativeMarker("session", view.receipt, inputs)).kind).toBe(
            "applied",
        );
        expect(marker).toHaveBeenCalledTimes(1);
        expect(preparation).toHaveBeenCalledTimes(2);
        expect(adapter.receipt("session")).toMatchObject({
            delivery: "pending",
            served_through_ordinal: 0,
        });
        await adapter.dispose();
        const restarted = await createBridgeAdapter(options);
        cleanups.push(() => restarted.dispose());
        const append = message("third");
        expect(
            restarted.isFallbackAdmissible("session", {
                ...inputs,
                messages: [...pair, rows[2], append],
            }),
        ).toEqual({ admissible: true, view: [...view.messages, append] });
        setPendingCompactionMarkerState(db, "session", {
            endMessageId: "first",
            ordinal: 2,
            publishedAt: 2,
        });
        marker.mockReturnValue({ kind: "already-current" });
        expect(
            (
                await restarted.advanceNativeMarker("session", view.receipt, {
                    ...inputs,
                    messages: [...pair, rows[2]],
                })
            ).kind,
        ).toBe("applied");
        expect(marker).toHaveBeenCalledTimes(2);
        expect(preparation).toHaveBeenCalledTimes(3);
        expect(
            restarted.isFallbackAdmissible("session", {
                ...inputs,
                messages: [pair[0], rows[2]],
            }),
        ).toMatchObject({
            admissible: false,
            reason: "covered_range_changed",
            detail: "native-cut-summary-missing",
        });
        await expect(
            restarted.run({
                sessionId: "session",
                messages: [pair[0], rows[2]],
                kind: "model",
            }),
        ).rejects.toMatchObject({ reason: "covered_range_changed" });
    });
    test("bridge session with unobserved built-in tools defers until a qualifying usage reading, then advances", async () => {
        const options = fixture();
        const preparation = spyOn(
            markerCandidates,
            "prepareCompactionMarkerCandidates",
        ).mockResolvedValue(true);
        cleanups.push(() => preparation.mockRestore());
        const wire = fakeModule();
        wire.setReply((request) => {
            if (request.method !== "compaction.step") return;
            return {
                answer: "compaction_message",
                request_id: request.params.request_id,
                compaction: {
                    compaction_id: "covering-pending",
                    version: 2,
                    range: { from: 1, to: 3 },
                    replacement: [message("summary")],
                },
                coverage: { end_mid: "first", ordinal: 2 },
            };
        });
        const rows = [message("prefix"), message("first"), message("second")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        const view = await adapter.run({ sessionId: "session", messages: rows, kind: "model" });
        const db = new Database(options.dbPath);
        cleanups.push(() => db.close());
        setPendingCompactionMarkerState(db, "session", {
            endMessageId: "first",
            ordinal: 2,
            publishedAt: 1,
        });
        const marker = spyOn(markerManager, "applyDeferredCompactionMarker").mockImplementation(
            (writerDb) => {
                persistNativePair(writerDb, rows[1], 2);
                return { kind: "applied", markerOrdinal: 2 };
            },
        );
        cleanups.push(() => marker.mockRestore());
        // OpenCode 1.18.35 built-ins: their JSON schemas are generated after the
        // plugin hook, so only their names are known to the host.
        const material = {
            system: ["Final system"],
            tools: [{ name: "ctx_search", description: "Search", inputSchema: { type: "object" } }],
            unobserved_tools: ["bash", "read", "task"],
        };
        const inputs = {
            messages: rows,
            model: "openai/gpt-5.6",
            contextWindow: 100_000,
            material,
        };
        const evidenceMissing = { kind: "deferred", reason: "native-marker-evidence-unavailable" };
        expect(await adapter.advanceNativeMarker("session", view.receipt, inputs)).toEqual(
            evidenceMissing,
        );
        let observedAt = Date.now();
        const respond = async (
            served: typeof material,
            outcome: "success" | "failed" = "success",
        ) =>
            (
                await adapter.recordHostFact({
                    kind: "provider_response",
                    sessionId: "session",
                    lineageId: view.receipt.lineage_id,
                    requestId: view.receipt.request_id,
                    model: { providerID: "openai", modelID: "gpt-5.6" },
                    observedAt: ++observedAt,
                    completedAt: observedAt - 1,
                    finishReason: "stop",
                    outcome,
                    contextWindow: 100_000,
                    material: served,
                    usage: { input: 900, cacheRead: 5000, cacheWrite: 100, output: 50 },
                })
            ).accepted;
        // A failed response's usage is not a reading, so the marker stays deferred.
        // Tool-name and system mismatches are covered in fallback-admissibility.test.ts.
        expect(await respond(material, "failed")).toBe(true);
        expect(await adapter.advanceNativeMarker("session", view.receipt, inputs)).toEqual(
            evidenceMissing,
        );
        expect(marker).not.toHaveBeenCalled();
        expect(await respond(material)).toBe(true);
        // The usage-derived envelope (6000 total input minus served text) must still fit.
        expect(
            (
                await adapter.advanceNativeMarker("session", view.receipt, {
                    ...inputs,
                    contextWindow: 6000,
                })
            ).kind,
        ).toBe("deferred");
        expect(marker).not.toHaveBeenCalled();
        expect((await adapter.advanceNativeMarker("session", view.receipt, inputs)).kind).toBe(
            "applied",
        );
        expect(marker).toHaveBeenCalledTimes(1);
    });
    test("applied bridge receipt round-trips and acknowledges only a clean carrying response", async () => {
        const preparation = spyOn(
            markerCandidates,
            "prepareCompactionMarkerCandidates",
        ).mockResolvedValue(true);
        cleanups.push(() => preparation.mockRestore());
        const options = fixture();
        const wire = fakeModule();
        wire.setReply((request) => {
            if (request.method !== "compaction.step") return;
            const p = request.params;
            return {
                answer: "compaction_message",
                request_id: p.request_id,
                compaction: {
                    compaction_id: "covering",
                    version: 2,
                    range: { from: 1, to: 2 },
                    replacement: [message("summary")],
                },
                coverage: { end_mid: "first", ordinal: 1 },
            };
        });
        const rows = [message("first"), message("second")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        const view = await adapter.run({ sessionId: "session", messages: rows, kind: "model" });
        expect(view.receipt).toMatchObject({
            delivery: "pending",
            served_through_ordinal: 0,
            last_applied: { compaction_id: "covering", version: 2, range: { from: 1, to: 2 } },
            coverage: { end_mid: "first", ordinal: 1 },
        });
        expect(
            adapter.completeRequest("session", view.receipt.request_id, {
                status: 200,
                cleanEnd: false,
            })?.served_through_ordinal,
        ).toBe(0);
        const clean = adapter.completeRequest("session", view.receipt.request_id, {
            status: 200,
            cleanEnd: true,
        });
        expect(clean).toMatchObject({ delivery: "clean", served_through_ordinal: 2 });
        await adapter.dispose();
        const restarted = await createBridgeAdapter(options);
        cleanups.push(() => restarted.dispose());
        expect(restarted.receipt("session")).toEqual(clean);
        expect(
            (
                await restarted.advanceNativeMarker("session", clean!, {
                    messages: rows,
                    model: "openai/gpt-5.6",
                })
            ).kind,
        ).toBe("deferred");
        const markerDb = new Database(options.dbPath);
        setPendingCompactionMarkerState(markerDb, "session", {
            endMessageId: "first",
            ordinal: 1,
            publishedAt: 1,
        });
        cleanups.push(() => markerDb.close());
        const marker = spyOn(markerManager, "applyDeferredCompactionMarker").mockImplementation(
            (writerDb) => {
                persistNativePair(writerDb, rows[0], 1);
                return { kind: "applied", markerOrdinal: 1 };
            },
        );
        cleanups.push(() => marker.mockRestore());
        expect(
            (
                await restarted.advanceNativeMarker("session", clean!, {
                    messages: rows,
                    model: "openai/gpt-5.6",
                    contextWindow: 100_000,
                    material: { system: ["Final system"], tools: [] },
                })
            ).kind,
        ).toBe("applied");
        expect(marker).toHaveBeenCalledTimes(1);
        expect(
            wire.calls
                .filter((c) => c.method === "compaction.step")
                .every((c) => c.params.served_through_ordinal === 0),
        ).toBe(true);
    });
    test("injected bridge uses only the relay and matches the direct bridge view and method sequence", async () => {
        const options = fixture();
        const wire = fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const direct = await createBridgeAdapter(options);
        const first = await direct.run({
            sessionId: "session",
            messages: rows.slice(),
            kind: "model",
        });
        rows.push(message("second"));
        const second = await direct.run({
            sessionId: "session",
            messages: rows.slice(),
            kind: "model",
        });
        await direct.dispose();
        const methods = wire.calls.map((call) => call.method);
        const relayed = fakeModule();
        relayed.connect.mockClear();
        const requests: { method: string; body: Uint8Array; deadlineMs: number }[] = [];
        const injected = await createBridgeAdapter({
            ...fixture(),
            transport: {
                async request(method, body, opts) {
                    expect(opts.deadlineMs).toBeGreaterThan(Date.now());
                    expect(opts.signal).toBeInstanceOf(AbortSignal);
                    requests.push({ method, body: body.slice(), deadlineMs: opts.deadlineMs });
                    return Buffer.from(
                        JSON.stringify(relayed.answer(JSON.parse(Buffer.from(body).toString()))),
                    );
                },
            },
        });
        cleanups.push(() => injected.dispose());
        for (const [messages, expected] of [
            [rows.slice(0, 1), first],
            [rows.slice(), second],
        ] as const) {
            const actual = await injected.run({
                sessionId: "session",
                messages: [...messages],
                kind: "model",
            });
            // Independent adapters allocate different conversation and request IDs.
            expect({ ...actual, receipt: undefined }).toEqual({ ...expected, receipt: undefined });
            expect({ ...actual.receipt, request_id: "", lineage_id: "" }).toEqual({
                ...expected.receipt,
                request_id: "",
                lineage_id: "",
            });
        }
        expect(requests.map((call) => call.method)).toEqual(methods);
        expect(new Set(methods)).toEqual(
            new Set([
                "state_sync",
                "transform.declare",
                "compaction.setup",
                "transform.hook",
                "compaction.step",
            ]),
        );
        expect(relayed.connect).not.toHaveBeenCalled();
        await injected.dispose();
        expect(relayed.close).not.toHaveBeenCalled();
    });

    for (const code of [
        "relay_unavailable",
        "session_scope_missing",
        "deadline",
        "aborted",
    ] as const) {
        test(`injected relay ${code} keeps bootstrap fail closed`, async () => {
            const wire = fakeModule();
            canonicalRows([]);
            const adapter = await createBridgeAdapter({
                ...fixture(),
                transport: {
                    async request(method, body) {
                        if (method === "transform.declare")
                            throw { source: "relay", code } satisfies BridgeTransportError;
                        return Buffer.from(
                            JSON.stringify(wire.answer(JSON.parse(Buffer.from(body).toString()))),
                        );
                    },
                },
            });
            cleanups.push(() => adapter.dispose());
            await expect(
                adapter.run({ sessionId: "session", messages: [], kind: "model" }),
            ).rejects.toMatchObject({ code: "EMERGENCY_FAIL_CLOSED" });
        });
        test(`injected relay ${code} keeps ordinary hooks fail closed without record writes`, async () => {
            const wire = fakeModule();
            const options = fixture();
            const rows = [message("first")];
            canonicalRows(rows);
            let refuse = false;
            const adapter = await createBridgeAdapter({
                ...options,
                transport: {
                    async request(method, body) {
                        if (refuse && method === "transform.hook")
                            throw { source: "relay", code } satisfies BridgeTransportError;
                        return Buffer.from(
                            JSON.stringify(wire.answer(JSON.parse(Buffer.from(body).toString()))),
                        );
                    },
                },
            });
            cleanups.push(() => adapter.dispose());
            await adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" });
            const before = recordSnapshot(options.dbPath);
            const observe = mock(() => {});
            adapter.onOutcome(observe);
            refuse = true;
            rows.push(message("second"));
            await expect(
                adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" }),
            ).rejects.toMatchObject({ code: "EMERGENCY_FAIL_CLOSED" });
            expect(recordSnapshot(options.dbPath)).toEqual(before);
            expect(observe).not.toHaveBeenCalled();
        });
    }

    test("state-sync barriers use the flat module envelope on bootstrap and no-tail ordinary passes", async () => {
        const options = fixture();
        const wire = fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        expect(
            (await adapter.run({ sessionId: "session", messages: rows, kind: "model" })).kind,
        ).toBe("bootstrap");
        const seed = wire.calls.find((call) => call.method === "state_sync");
        expect(seed?.params).toBeUndefined();
        expect(seed?.pass_complete).toBe(true);
        expect(seed?.historian_model_chain).toEqual(["openai/bridge-historian"]);
        const before = wire.calls.length;
        expect(
            (await adapter.run({ sessionId: "session", messages: rows, kind: "model" })).kind,
        ).toBe("ordinary");
        const barrier = wire.calls.slice(before).find((call) => call.method === "state_sync");
        expect(barrier).toMatchObject({
            session_id: "session",
            shadow_generation: 0,
            expected_shadow_seq: 1,
            pass_complete: true,
            historian_model_chain: ["openai/bridge-historian"],
        });
        expect(barrier?.params).toBeUndefined();
    });
    test("bridge commits view coverage without invoking the native raw-history marker writer", async () => {
        const options = fixture();
        const wire = fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        wire.setReply((call) => {
            if (call.method !== "compaction.step") return;
            const p = call.params;
            return {
                answer: "compaction_message",
                request_id: p.request_id,
                compaction: {
                    compaction_id: "covered",
                    version: 2,
                    range: { from: 1, to: 2 },
                    replacement: p.messages.map((entry: any) => entry.message),
                },
                coverage: { end_mid: "first", ordinal: 1 },
            };
        });
        const marker = spyOn(defaultCompactionMarkerStrategy, "applyDeferred").mockImplementation(
            () => {
                throw new Error("Native marker would commit a second database");
            },
        );
        cleanups.push(() => marker.mockRestore());
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        const result = await adapter.run({ sessionId: "session", messages: rows, kind: "model" });
        expect(firstText(result.messages[0])).toBe("first");
        expect(marker).not.toHaveBeenCalled();
        const db = new Database(options.dbPath);
        try {
            const view = db
                .prepare(
                    "SELECT coverage_json FROM host_runner_views WHERE session_id='session' ORDER BY version DESC LIMIT 1",
                )
                .get() as { coverage_json: string };
            expect(JSON.parse(view.coverage_json)).toEqual({ end_mid: "first", ordinal: 1 });
        } finally {
            db.close();
        }
    });
    test("ordinary pass budget rejects at five seconds with no late writes or observers and permits a clean retry", async () => {
        const options = fixture();
        const wire = fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        await adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" });
        const before = recordSnapshot(options.dbPath);
        const outcomes: unknown[] = [];
        adapter.onOutcome(async (...args) => {
            outcomes.push(args);
        });
        let release!: (answer: unknown) => void;
        let hooks = 0;
        wire.setReply((call) => {
            if (call.method !== "transform.hook") return;
            const p = call.params;
            return new Promise((resolve) => {
                if (++hooks < 3)
                    setTimeout(
                        () =>
                            resolve({
                                answer: "ops",
                                ops: [{ op: "prepend", block: 0, text: `§${p.subject_ordinal}§ ` }],
                            }),
                        1800,
                    );
                else release = resolve;
            });
        });
        rows.push(message("second"), message("third"), message("fourth"));
        const started = performance.now();
        await expect(
            adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" }),
        ).rejects.toMatchObject({
            code: "step_budget_exceeded",
            budget_ms: 5000,
            kind: "ordinary",
        });
        expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
        expect(performance.now() - started).toBeLessThan(6500);
        expect(recordSnapshot(options.dbPath)).toEqual(before);
        expect(outcomes).toEqual([]);
        release({});
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(recordSnapshot(options.dbPath)).toEqual(before);
        wire.setReply(undefined);
        const retried = await adapter.run({
            sessionId: "session",
            messages: rows.slice(),
            kind: "model",
        });
        expect(retried.kind).toBe("ordinary");
        expect(firstText(retried.messages[1])).toBe("§2§ second");
        expect(outcomes).toHaveLength(3);
    });
    test("rebuild budget survives five seconds and rejects at thirty without a served view", async () => {
        const options = fixture();
        const wire = fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        await adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" });
        const before = recordSnapshot(options.dbPath);
        rows[0] = {
            ...rows[0],
            info: { ...rows[0]!.info, model: { providerID: "openai", modelID: "other" } },
        } as MessageLike;
        let release!: (answer: unknown) => void;
        wire.setReply((call) =>
            call.method === "compaction.step"
                ? new Promise((resolve) => {
                      release = resolve;
                  })
                : undefined,
        );
        let settled = false;
        const started = performance.now();
        const pass = adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" });
        void pass.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 5200));
        expect(settled).toBe(false);
        await expect(pass).rejects.toMatchObject({
            code: "step_budget_exceeded",
            budget_ms: 30000,
            kind: "rebuild",
        });
        expect(performance.now() - started).toBeGreaterThanOrEqual(29900);
        expect(performance.now() - started).toBeLessThan(32000);
        expect(recordSnapshot(options.dbPath)).toEqual(before);
        release({ answer: "noop", request_id: "late" });
        wire.setReply(undefined);
        const retried = await adapter.run({
            sessionId: "session",
            messages: rows.slice(),
            kind: "model",
        });
        expect(retried.kind).toBe("rebuild");
    }, 40000);
    test("pre-commit cancel check prevents late writes when an atomic commit straddles the deadline", async () => {
        const options = fixture();
        fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        await adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" });
        const before = recordSnapshot(options.dbPath);
        const original = runnerStorage.commitHostRunnerPass;
        const delayed = spyOn(runnerStorage, "commitHostRunnerPass").mockImplementation(
            (...args) => {
                original(...args);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5100);
            },
        );
        cleanups.push(() => delayed.mockRestore());
        const outcomes: unknown[] = [];
        adapter.onOutcome(async (...args) => {
            outcomes.push(args);
        });
        rows.push(message("second"));
        await expect(
            adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" }),
        ).rejects.toMatchObject({ code: "step_budget_exceeded", kind: "ordinary" });
        expect(delayed).toHaveBeenCalledTimes(1);
        expect(recordSnapshot(options.dbPath)).toEqual(before);
        expect(outcomes).toEqual([]);
        delayed.mockRestore();
        await adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" });
        expect(outcomes).toHaveLength(1);
    }, 10000);
    test("committed observers do not delay run and failures do not poison the record", async () => {
        const options = fixture();
        fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        await adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" });
        let release!: () => void;
        adapter.onOutcome(async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            throw new Error("observer offline");
        });
        rows.push(message("second"));
        const result = await adapter.run({
            sessionId: "session",
            messages: rows.slice(),
            kind: "model",
        });
        expect(firstText(result.messages[1])).toBe("§2§ second");
        expect(release).toBeFunction();
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(
            (await adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" }))
                .messages,
        ).toEqual(result.messages);
    });
    for (const v2 of [false, true]) {
        test(`preserves host project identity and memory head before provider rendering (${v2 ? "v2" : "v1"})`, async () => {
            const options = fixture();
            const target = join(options.storageDir, "target");
            mkdirSync(target);
            const link = join(options.storageDir, "project-link");
            symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
            options.projectRoot = `${link}/`;
            if (v2) options.openCodeClient = { session: { hook: async () => {} } };
            const identity = resolveProjectIdentity(link);
            expect(identity).not.toBe(resolveProjectIdentity(realpathSync(link)));
            const db = new Database(options.dbPath);
            cleanups.push(() => {
                db.close();
            });
            const text = "The bridge preserves the original project memory pool.";
            const inserted = db
                .prepare(
                    "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'ARCHITECTURE', ?, ?, 0, 0, 0, 0)",
                )
                .run(identity, text, computeNormalizedHash(text));
            const wire = fakeModule();
            wire.setReply((call) => {
                if (call.method !== "compaction.step") return;
                const p = call.params;
                const owner = db
                    .prepare(
                        "SELECT project_path, harness FROM session_projects WHERE session_id=?",
                    )
                    .get("session") as { project_path: string; harness: string } | null;
                expect(owner).toEqual({
                    project_path: identity,
                    harness: v2 ? "opencode2" : "opencode",
                });
                const fact = db
                    .prepare(
                        "SELECT content FROM memories WHERE project_path=? AND status='active'",
                    )
                    .get(owner?.project_path ?? "") as { content: string } | null;
                const head = (body: string) => ({
                    info: { role: "user" },
                    parts: [{ type: "text", text: body }],
                });
                return {
                    answer: "compaction_message",
                    request_id: p.request_id,
                    compaction: {
                        compaction_id: "head",
                        version: 2,
                        range: { from: 1, to: 2 },
                        replacement: [
                            head(`<project-memory>\n${fact?.content ?? ""}\n</project-memory>`),
                            head("<memory-updates></memory-updates>"),
                            ...p.messages.map((entry: any) => entry.message),
                        ],
                    },
                };
            });
            const rows = [message("first")];
            canonicalRows(rows);
            const adapter = await createBridgeAdapter(options);
            cleanups.push(() => adapter.dispose());
            const { messages: view } = await adapter.run({
                sessionId: "session",
                messages: rows,
                kind: "model",
            });
            expect(view[0]?.info.role).toBe("user");
            expect(firstText(view[0])).toContain(text);
            expect(firstText(view[1])).toBe("<memory-updates></memory-updates>");
            expect(
                wire.calls.find((call) => call.method === "state_sync" && call.acked_watermarks)
                    ?.acked_watermarks.memory_id,
            ).toBe(Number(inserted.lastInsertRowid));
        });
    }
    test("opens current fence with normal storage policies and disposes owned handles once", async () => {
        const options = fixture();
        const wire = fakeModule();
        const opens = spyOn(storage, "openBridgeDatabase");
        const closes = spyOn(Database.prototype, "close");
        cleanups.push(() => {
            closes.mockRestore();
            opens.mockRestore();
        });
        const adapter = await createBridgeAdapter(options);
        const owned = opens.mock.results[0]?.value as Database;
        expect(owned.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        expect(owned.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        if (process.platform !== "win32") {
            expect(statSync(options.storageDir).mode & 0o777).toBe(0o700);
            expect(statSync(options.dbPath).mode & 0o777).toBe(0o600);
        }
        const check = new Database(options.dbPath);
        expect(check.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        check.close();
        canonicalRows([]);
        await adapter.run({ sessionId: "session", messages: [], kind: "model" });
        const first = adapter.dispose();
        expect(adapter.dispose()).toBe(first);
        await first;
        expect(wire.close).toHaveBeenCalledTimes(1);
        expect(closes).toHaveBeenCalledTimes(2);
        expect(() => owned.prepare("SELECT 1")).toThrow();
        await expect(
            adapter.run({ sessionId: "session", messages: [], kind: "model" }),
        ).rejects.toThrow("disposed");
    });
    test("refuses older schema without explicit migration permission", async () => {
        const options = fixture(LATEST_SUPPORTED_VERSION - 1);
        await expect(createBridgeAdapter(options)).rejects.toMatchObject({
            code: "store_version_mismatch",
            found: LATEST_SUPPORTED_VERSION - 1,
            expected: LATEST_SUPPORTED_VERSION,
        });
        const db = new Database(options.dbPath);
        expect(getPersistedSchemaVersion(db)).toBe(LATEST_SUPPORTED_VERSION - 1);
        db.close();
    });
    test("refuses newer schema even with migration permission", async () => {
        const options = fixture(LATEST_SUPPORTED_VERSION + 1);
        for (const allowMigration of [false, true]) {
            await expect(
                createBridgeAdapter({ ...options, allowMigration }),
            ).rejects.toBeInstanceOf(StoreVersionMismatchError);
        }
        const db = new Database(options.dbPath);
        expect(getPersistedSchemaVersion(db)).toBe(LATEST_SUPPORTED_VERSION + 1);
        db.close();
    });
    test("migrates only with explicit permission including a fresh throwaway store", async () => {
        const options = fixture(LATEST_SUPPORTED_VERSION - 1);
        const adapter = await createBridgeAdapter({ ...options, allowMigration: true });
        await adapter.dispose();
        const db = new Database(options.dbPath);
        expect(getPersistedSchemaVersion(db)).toBe(LATEST_SUPPORTED_VERSION);
        db.close();
        const fresh = createTestTempDir("mc-bridge-fresh-");
        cleanups.push(fresh.cleanup);
        await expect(
            createBridgeAdapter({ ...options, storageDir: fresh.dir }),
        ).rejects.toMatchObject({ found: 0 });
        const created = await createBridgeAdapter({
            ...options,
            storageDir: fresh.dir,
            allowMigration: true,
        });
        await created.dispose();
    });
    test("binds each session as an independent host with null consumer identity despite inherited credentials", async () => {
        const options = fixture();
        const wire = fakeModule();
        const priorModule = process.env.SUBC_MODULE_ID;
        const priorNonce = process.env.SUBC_LAUNCH_NONCE;
        process.env.SUBC_MODULE_ID = "unrelated-module";
        process.env.SUBC_LAUNCH_NONCE = "a".repeat(64);
        cleanups.push(() => {
            if (priorModule === undefined) delete process.env.SUBC_MODULE_ID;
            else process.env.SUBC_MODULE_ID = priorModule;
            if (priorNonce === undefined) delete process.env.SUBC_LAUNCH_NONCE;
            else process.env.SUBC_LAUNCH_NONCE = priorNonce;
        });
        canonicalRows([]);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        await adapter.run({ sessionId: "session", messages: [], kind: "model" });
        expect(wire.connect).toHaveBeenCalledWith(
            expect.objectContaining({ connectionFile: options.connectionFile }),
        );
        expect(wire.binds).toEqual([
            {
                target: { kind: "tool_provider", module_id: "magic-context" },
                identity: {
                    project_root: options.projectRoot,
                    harness: "opencode",
                    session: "session",
                },
                options: { consumerIdentity: null },
            },
        ]);
    });
    test("honors the explicit configPath without mutating env and ignores plugin lane switches", async () => {
        const options = fixture();
        const wire = fakeModule();
        const previous = process.env.MAGIC_CONTEXT_CONFIG_PATH;
        const otherPath = join(options.storageDir, "other.json");
        writeFileSync(otherPath, JSON.stringify({ historian: { model: "openai/wrong" } }));
        process.env.MAGIC_CONTEXT_CONFIG_PATH = otherPath;
        cleanups.push(() => {
            if (previous === undefined) delete process.env.MAGIC_CONTEXT_CONFIG_PATH;
            else process.env.MAGIC_CONTEXT_CONFIG_PATH = previous;
        });
        canonicalRows([]);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        await adapter.run({ sessionId: "session", messages: [], kind: "model" });
        expect(process.env.MAGIC_CONTEXT_CONFIG_PATH).toBe(otherPath);
        expect(wire.calls.some((c) => c.method === "transform.declare")).toBe(true);
        expect(JSON.stringify(wire.calls.filter((c) => c.method === "state_sync"))).toContain(
            "openai/bridge-historian",
        );
        expect(JSON.stringify(wire.calls)).not.toContain("openai/wrong");
        process.env.MAGIC_CONTEXT_CONFIG_PATH = "invalid-relative-path";
        const ignoresAmbient = await createBridgeAdapter(options);
        await ignoresAmbient.dispose();
        expect(process.env.MAGIC_CONTEXT_CONFIG_PATH).toBe("invalid-relative-path");
    });
    test("failed served-baseline persistence refuses and rolls back the staged view and observers", async () => {
        const options = fixture();
        fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        const first = await adapter.run({
            sessionId: "session",
            messages: rows.slice(),
            kind: "model",
        });
        const db = new Database(options.dbPath);
        cleanups.push(() => db.close());
        const store = createBridgeReceiptStore(db, "session", "opencode");
        expect([...store.served()!.messages.keys()]).toEqual(["first"]);
        const originalRecord = runnerStorage.loadHostRunnerRecord(db, {
            session_id: "session",
            harness: "opencode",
        })!;
        db.exec(`CREATE TRIGGER refuse_served_snapshot BEFORE UPDATE ON host_runner_state
            WHEN NEW.harness = 'bridge-receipt:opencode'
            BEGIN SELECT RAISE(ABORT, 'served snapshot unavailable'); END`);
        const observer = mock(() => {});
        adapter.onOutcome(observer);
        rows.push(message("second"));
        await expect(
            adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" }),
        ).rejects.toThrow("served snapshot unavailable");
        expect(store.current()).toEqual(first.receipt);
        expect([...store.served()!.messages.keys()]).toEqual(["first"]);
        const after = runnerStorage.loadHostRunnerRecord(db, {
            session_id: "session",
            harness: "opencode",
        })!;
        expect(after.entries).toEqual(originalRecord.entries);
        expect(after.ids).toEqual(originalRecord.ids);
        expect(after.state.next_ordinal).toBe(originalRecord.state.next_ordinal);
        expect(observer).not.toHaveBeenCalled();
        db.exec("DROP TRIGGER refuse_served_snapshot");
    });

    test("full fake ck-mc run publishes the same view as the in-tree provider path and observes committed outcomes", async () => {
        const options = fixture();
        fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        const outcomes: unknown[] = [];
        const unsubscribe = adapter.onOutcome(async (...args) => {
            outcomes.push(args);
        });
        const first = await adapter.run({
            sessionId: "session",
            messages: rows.slice(),
            kind: "model",
        });
        rows.push(message("second"));
        const served = await adapter.run({
            sessionId: "session",
            messages: rows.slice(),
            kind: "model",
        });
        expect(first.kind).toBe("bootstrap");
        expect(served.kind).toBe("ordinary");
        expect(firstText(first.messages[0])).toBe("first");
        expect(firstText(served.messages[1])).toBe("§2§ second");
        expect(outcomes).toEqual([
            [
                "second",
                { hook: "pre_user", subject_mid: "second", blocks: ["second"] },
                expect.objectContaining({
                    answer: expect.objectContaining({
                        ops: [{ op: "prepend", block: 0, text: "§2§ " }],
                    }),
                }),
            ],
        ]);
        unsubscribe();
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        cleanups.push(() => {
            db.close();
        });
        const transport = new SubcModuleTransport(
            options.connectionFile,
            undefined,
            undefined,
            "",
            "opencode",
        );
        cleanups.push(() => transport.close());
        const deps: TransformDeps = {
            db,
            client: options.openCodeClient,
            directory: options.projectRoot,
            projectPath: options.projectRoot,
            storeGeneration: "v1",
            transformMode: "rust",
            rustPipeline: "provider",
            rustModeModuleClient: transport,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 90 }),
            contextUsageMap: new Map(),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            historianRunner: "broca",
            historianModel: { model: "openai/bridge-historian" },
        };
        const legacy = createModuleSessionKernel({
            moduleClient: transport,
            hostClient: deps.client,
            projectRoot: options.projectRoot,
        });
        const native = createOpenCodeProviderTransform(deps, legacy);
        cleanups.push(async () => {
            await native.dispose();
            legacy.dispose();
        });
        const out = { messages: [] as unknown[] };
        await native.run("session", rows.slice(0, 1), out, getOrCreateSessionMeta(db, "session"));
        await native.run("session", rows.slice(), out, getOrCreateSessionMeta(db, "session"));
        expect(served.messages as unknown[]).toEqual(out.messages);
    });
    test("refuses bootstrap decline instead of running a legacy full request", async () => {
        const options = fixture();
        const wire = fakeModule();
        canonicalRows([]);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        await expect(
            adapter.run({
                sessionId: "session",
                messages: [message("not-persisted")],
                kind: "model",
            }),
        ).rejects.toMatchObject({
            code: "bridge_bootstrap_declined",
            reason: "bootstrap_declined",
        });
        expect(wire.calls.some((c) => c.method === "transform")).toBe(false);
    });
    for (const phase of [
        "declaration unavailable",
        "setup refused",
        "bootstrap incomplete",
    ] as const) {
        test(`refuses ${phase} handoff as bootstrap_declined`, async () => {
            const options = fixture();
            const wire = fakeModule();
            canonicalRows([]);
            wire.setReply((call) => {
                if (phase === "declaration unavailable" && call.method === "transform.declare")
                    throw new Error("offline");
                if (phase === "setup refused" && call.method === "compaction.setup")
                    return {
                        answer: "refuse",
                        request_id: call.params.request_id,
                        code: "unavailable",
                        reason: "not ready",
                    };
                if (phase === "bootstrap incomplete" && call.method === "compaction.step")
                    return { answer: "noop", request_id: call.params.request_id };
            });
            const adapter = await createBridgeAdapter(options);
            cleanups.push(() => adapter.dispose());
            await expect(
                adapter.run({ sessionId: "session", messages: [], kind: "model" }),
            ).rejects.toMatchObject({
                code: "bridge_bootstrap_declined",
                reason: "bootstrap_declined",
            });
            expect(wire.calls.some((c) => c.method === "transform")).toBe(false);
        });
    }
    for (const reason of [
        "provider_message_too_large",
        "provider_history_lost",
        "provider_record_lost",
        "provider_foreign_history",
        "provider_revert_ambiguous",
        "rollback",
    ] as const) {
        test(`refuses ${reason} handoff with a stable code`, async () => {
            const options = fixture();
            const wire = fakeModule();
            canonicalRows([]);
            const adapter = await createBridgeAdapter(options);
            await adapter.run({ sessionId: "session", messages: [], kind: "model" });
            await adapter.dispose();
            const db = new Database(options.dbPath);
            db.prepare(
                "UPDATE host_runner_state SET pipeline_exit_json=? WHERE session_id='session'",
            ).run(JSON.stringify({ reason, reseed_full_request: false }));
            db.close();
            if (reason === "rollback")
                wire.setReply((call) => {
                    if (call.method === "transform.declare")
                        throw new Error("offline during re-entry");
                });
            const restarted = await createBridgeAdapter(options);
            cleanups.push(() => restarted.dispose());
            await expect(
                restarted.run({ sessionId: "session", messages: [], kind: "model" }),
            ).rejects.toMatchObject({
                code: `bridge_${reason}`,
                reason,
            });
            expect(wire.calls.some((c) => c.method === "transform")).toBe(false);
        });
    }
    test("exact provider usage is not borrowed across prefix, model, system or tool changes", async () => {
        const options = fixture();
        fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        const view = await adapter.run({ sessionId: "session", messages: rows, kind: "model" });
        const identity = { model: "openai/gpt-5.6", envelope: "system-hash-1:tools-hash-1" };
        adapter.recordProviderUsage("session", {
            ...identity,
            messages: view.messages,
            inputTokens: 100,
        });
        const input = { ...identity, messages: rows, contextWindow: 1000 };
        expect(adapter.isFallbackAdmissible("session", input).admissible).toBe(true);
        for (const change of [
            { model: "openai/other" },
            { envelope: "system-hash-2:tools-hash-1" },
            { envelope: "system-hash-1:tools-hash-2" },
            {
                messages: [
                    { ...rows[0], parts: [{ type: "text", text: "different prefix" }] },
                ] as MessageLike[],
            },
        ]) {
            expect(
                adapter.isFallbackAdmissible("session", { ...input, ...change }).admissible,
            ).toBe(false);
        }
    });
    test("dispose drains active passes before closing the client and store", async () => {
        const options = fixture();
        const wire = fakeModule();
        const rows = [message("first")];
        canonicalRows(rows);
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        await adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" });
        let reached!: () => void;
        let release!: () => void;
        const observing = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        adapter.onOutcome(async () => {
            reached();
            await held;
        });
        rows.push(message("second"));
        const pass = adapter.run({ sessionId: "session", messages: rows.slice(), kind: "model" });
        await observing;
        const disposal = adapter.dispose();
        expect(wire.close).not.toHaveBeenCalled();
        release();
        await pass;
        await disposal;
        expect(wire.close).toHaveBeenCalledTimes(1);
    });
    test("v2 context is identified without global harness changes and refuses missing raw history", async () => {
        const options = fixture();
        const wire = fakeModule();
        options.openCodeClient = { session: { hook: async () => {} } };
        const adapter = await createBridgeAdapter(options);
        cleanups.push(() => adapter.dispose());
        await expect(
            adapter.run({ sessionId: "session", messages: [], kind: "model" }),
        ).rejects.toBeInstanceOf(BridgeRefusalError);
        await expect(
            adapter.run({ sessionId: "session", messages: [], kind: "model" }),
        ).rejects.toMatchObject({ code: "bridge_raw_history_provider_missing" });
        expect(wire.binds).toEqual([]);
        canonicalRows([]);
        await adapter.run({ sessionId: "session", messages: [], kind: "model" });
        expect(wire.binds[0]?.identity.harness).toBe("opencode2");
        const db = new Database(options.dbPath);
        expect(
            db.prepare("SELECT harness FROM session_meta WHERE session_id='session'").get(),
        ).toEqual({ harness: "opencode2" });
        db.close();
    });
});
