import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SubcClient } from "@cortexkit/subc-client";
import { runMigrations } from "../../../features/magic-context/migrations";
import { createScheduler } from "../../../features/magic-context/scheduler";
import * as storage from "../../../features/magic-context/storage-db";
import {
    getPersistedSchemaVersion,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "../../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../../features/magic-context/storage-meta";
import { createTagger } from "../../../features/magic-context/tagger";
import {
    BridgeRefusalError,
    createBridgeAdapter,
    StoreVersionMismatchError,
} from "../../../host-runner";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { SubcModuleTransport } from "../module-transport";
import { setRawMessageProvider } from "../read-session-chunk";
import { createRustModeTransform } from "../rust-mode-transform";
import type { TransformDeps } from "../transform";
import type { MessageLike } from "../transform-operations";
import { createOpenCodeProviderTransform } from "./opencode-adapter";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
function fakeModule() {
    const calls: Record<string, any>[] = [];
    const binds: any[] = [];
    const close = spyOn({ close() {} }, "close");
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
                request: async (_route: unknown, body: Uint8Array) =>
                    answer(JSON.parse(Buffer.from(body).toString())),
                close,
            }) as any,
    );
    cleanups.push(() => {
        connect.mockRestore();
        close.mockRestore();
    });
    return {
        calls,
        binds,
        close,
        connect,
        setReply(next: typeof reply) {
            reply = next;
        },
    };
}

describe("supported bridge constructor", () => {
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
        expect(first[0]?.parts[0]?.text).toBe("first");
        expect(served[1]?.parts[0]?.text).toBe("§2§ second");
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
        cleanups.push(() => db.close());
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
        const legacy = createRustModeTransform(deps, {
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
        expect(served).toEqual(out.messages);
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
        adapter.recordProviderUsage("session", { ...identity, messages: view, inputTokens: 100 });
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
