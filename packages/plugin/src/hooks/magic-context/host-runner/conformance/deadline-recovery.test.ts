/**
 * OpenCode 1 bridge recovery after a refused pass. The real Rust module runs in
 * process behind `startOracle()` and is driven through the public bridge adapter.
 * The prompts follow the failing run of THALAMUS (the bridge host that relays
 * requests between OpenCode and Magic Context):
 *
 *   BOOTSTRAP, ORDINARY and FROZEN are served with tags. The DEADLINE prompt's hook
 *   answer is lost at the relay deadline even though the module committed it, so
 *   the pass is refused. OpenCode then stores an errored, empty assistant row for
 *   that turn, and RECOVER_DEADLINE is the next prompt.
 *
 * Like that host, the test records the system_prompt fact before each run() and
 * never confirms delivery, so every receipt stays pending
 * (served_through_ordinal 0). The session is enrolled as bridged, so the
 * OpenCode 1 plugin's own hooks stand down and only the bridge view reaches the
 * provider.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import { runMigrations } from "../../../../features/magic-context/migrations";
import { initializeDatabase } from "../../../../features/magic-context/storage-db";
import { standDownForBridgedSessions } from "../../../../plugin/bridged-session-guard";
import { BRIDGED_SESSIONS_KEY } from "../../../../shared/bridged-sessions";
import { Database } from "../../../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../../shared/test-temp-dir";
import { setRawMessageProvider } from "../../read-session-chunk";
import type { MessageLike } from "../../transform-operations";
import { createBridgeAdapter } from "../bridge-adapter";
import { BridgeRefusalError, type BridgeTransport } from "../bridge-types";
import { ProviderClient } from "../provider-client";
import { startOracle } from "./oracle";

const SESSION = "relay-v1";
const model = { providerID: "probe", modelID: "probe" };
/** The host's own system prompt: what goes out when Magic Context adds nothing. */
const HOST_SYSTEM = "You are opencode, an interactive CLI tool. ".repeat(200).trim();
const GUIDANCE_HEADING = "## Magic Context";

let oracle: ReturnType<typeof startOracle>;
let budget: { mockRestore(): void };
const savedConfig = process.env.MAGIC_CONTEXT_CONFIG_PATH;
const base = join(tmpdir(), "magic-context", "bridge-deadline-recovery");

beforeAll(async () => {
    mkdirSync(base, { recursive: true });
    process.env.MAGIC_CONTEXT_CONFIG_PATH = join(base, "empty-user.jsonc");
    writeFileSync(process.env.MAGIC_CONTEXT_CONFIG_PATH, "{}");
    // Shared runners can stall a debug-built module for longer than the 1.5 s hook
    // budget it declares. A lost answer would burn a tag and change the served
    // bytes this test compares, so give both sides a 10 s hook budget.
    budget = spyOn(
        ProviderClient.prototype as unknown as { budget(ms: number): number },
        "budget",
    ).mockImplementation((ms) => Math.min(ms, 10_000));
    oracle = startOracle();
    // The first call waits for cargo to build the module. Keep that out of the
    // bridge's 30 s bootstrap deadline.
    await oracle.call({ control: "scheduler" });
}, 900_000);

afterAll(async () => {
    budget.mockRestore();
    await oracle.close();
    if (savedConfig === undefined) delete process.env.MAGIC_CONTEXT_CONFIG_PATH;
    else process.env.MAGIC_CONTEXT_CONFIG_PATH = savedConfig;
});

function user(n: number, text: string): MessageLike {
    return {
        info: {
            id: `u${n}`,
            sessionID: SESSION,
            role: "user",
            model,
            time: { created: 1_800_000_000_000 + n * 1000 },
        },
        parts: [{ id: `u${n}-text`, type: "text", text }],
    } as MessageLike;
}

function assistant(n: number, refused = false): MessageLike {
    return {
        info: {
            id: `a${n}`,
            sessionID: SESSION,
            role: "assistant",
            providerID: model.providerID,
            modelID: model.modelID,
            time: {
                created: 1_800_000_000_000 + n * 1000,
                completed: 1_800_000_000_500 + n * 1000,
            },
            ...(refused
                ? {
                      error: {
                          name: "UnknownError",
                          data: { message: "Bridge relay transport refused: deadline" },
                      },
                  }
                : {}),
        },
        // OpenCode stores the turn whose transform failed as an assistant row with
        // an error and no parts.
        parts: refused ? [] : [{ id: `a${n}-text`, type: "text", text: "PROBE_DONE" }],
    } as MessageLike;
}

const tags = (messages: readonly MessageLike[]) =>
    [...JSON.stringify(messages).matchAll(/§\d+§/g)].map((m) => m[0]);

/** A throwaway context.db, the real module, and the real bridge for one session. */
async function relay() {
    await oracle.call({ control: "reset" });
    const root = createTestTempDirFromPath(join(base, "run-"));
    const configPath = join(root, "config.jsonc");
    writeFileSync(
        configPath,
        JSON.stringify({ historian: { disable: true }, memory: { enabled: false } }),
    );
    const db = new Database(join(root, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    const rows: MessageLike[] = [];
    const raw = () =>
        rows.map((m, i) => ({
            id: m.info.id!,
            role: m.info.role!,
            parts: m.parts,
            createdAt: 1_800_000_000_000 + (i + 1) * 1000,
            ordinal: i + 1,
        }));
    const unregister = setRawMessageProvider(SESSION, {
        readMessages: raw,
        readMessageById: (id) => raw().find((r) => r.id === id) ?? null,
        readMessagePartsById: (id) => raw().find((r) => r.id === id) ?? null,
        readMessageOrdinalById: (id) => raw().find((r) => r.id === id)?.ordinal ?? null,
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
                .filter((r) => !after || r.timeCreated > after.timeCreated)
                .slice(0, limit),
    });
    let deadline = false;
    const transport: BridgeTransport = {
        async request(method, body) {
            const answer = await oracle.call(JSON.parse(Buffer.from(body).toString()));
            const decoded = JSON.parse(answer);
            if (decoded.oracle_error) throw decoded.oracle_error;
            if (method === "transform.declare") {
                for (const sub of decoded.subscriptions) sub.budget_ms = 10_000;
                return Buffer.from(JSON.stringify(decoded));
            }
            // The module committed this answer; the relay loses it at the deadline.
            if (deadline && method === "transform.hook")
                throw { source: "relay", code: "deadline" };
            return Buffer.from(answer);
        },
    };
    const adapter = await createBridgeAdapter({
        projectRoot: root,
        connectionFile: join(root, "unused.json"),
        storageDir: root,
        configPath,
        openCodeClient: { session: {} } as any,
        transport,
    });
    // THALAMUS enrolls the session, so the OpenCode 1 plugin's hooks stand down.
    // Their inner callbacks would edit history and the prompt; neither may run.
    const bridged = new Map([[SESSION, { product: "thalamus", version: "test" }]]);
    const registry = globalThis as unknown as Record<symbol, unknown>;
    const previousRegistry = registry[BRIDGED_SESSIONS_KEY];
    registry[BRIDGED_SESSIONS_KEY] = bridged;
    let pluginCalls = 0;
    const plugin = standDownForBridgedSessions({
        "experimental.chat.messages.transform": async () => {
            pluginCalls++;
        },
        "experimental.chat.system.transform": async () => {
            pluginCalls++;
        },
    } as Hooks);

    /** One OpenCode prompt: system fact, bridge view, then the plugin's stood-down hooks. */
    async function prompt(options: { fact?: boolean } = {}) {
        let system = [HOST_SYSTEM];
        const prior = adapter.receipt(SESSION);
        if (prior && options.fact !== false) {
            const result = await adapter.recordHostFact({
                kind: "system_prompt",
                sessionId: SESSION,
                lineageId: prior.lineage_id,
                model,
                observedAt: Date.now(),
                system,
            });
            expect(result.accepted).toBe(true);
            system = result.system!;
        }
        const view = await adapter.run({
            sessionId: SESSION,
            messages: rows.slice(),
            kind: "model",
        });
        const output = { messages: view.messages };
        await plugin["experimental.chat.messages.transform"]!({}, output as never);
        const systemOutput = { system: [...system] };
        await plugin["experimental.chat.system.transform"]!(
            { sessionID: SESSION, model } as never,
            systemOutput,
        );
        const now = Date.now();
        await adapter.recordHostFact({
            kind: "provider_response",
            sessionId: SESSION,
            lineageId: view.receipt.lineage_id,
            requestId: view.receipt.request_id,
            model,
            observedAt: now,
            completedAt: now,
            finishReason: "stop",
            outcome: "success",
            usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
            contextWindow: 31744,
        });
        return { view, messages: output.messages, system: systemOutput.system };
    }

    /** BOOTSTRAP, ORDINARY and FROZEN served; DEADLINE refused at the relay deadline. */
    async function throughDeadline() {
        rows.push(user(1, "MC_RELAY_BOOTSTRAP"));
        await prompt();
        rows.push(assistant(2), user(3, "MC_RELAY_ORDINARY"));
        await prompt();
        rows.push(assistant(4), user(5, "MC_RELAY_FROZEN"));
        const frozen = await prompt();
        rows.push(assistant(6), user(7, "MC_RELAY_DEADLINE"));
        deadline = true;
        await expect(prompt()).rejects.toThrow("Bridge relay transport refused: deadline");
        deadline = false;
        rows.push(assistant(8, true), user(9, "MC_RELAY_RECOVER_DEADLINE"));
        return frozen;
    }

    return {
        prompt,
        throughDeadline,
        pluginCalls: () => pluginCalls,
        async dispose() {
            await adapter.dispose();
            unregister();
            db.close();
            if (previousRegistry === undefined) delete registry[BRIDGED_SESSIONS_KEY];
            else registry[BRIDGED_SESSIONS_KEY] = previousRegistry;
            cleanupTestTempDir(root);
        },
    };
}

test("OC1 bridge: a deadline then recovery keeps every served tag and the guidance on the stand-down path", async () => {
    const lane = await relay();
    try {
        const frozen = await lane.throughDeadline();
        const served = tags(frozen.messages);
        expect(served).toEqual(["§1§", "§2§", "§3§", "§4§"]);
        expect(frozen.system[0]).toContain(GUIDANCE_HEADING);
        const recovered = await lane.prompt();
        // Every message already served comes back byte for byte, tags included.
        const byId = new Map(recovered.messages.map((m) => [m.info.id, JSON.stringify(m)]));
        for (const message of frozen.messages.filter((m) => m.info.id))
            expect(byId.get(message.info.id)).toBe(JSON.stringify(message));
        expect(tags(recovered.messages).slice(0, served.length)).toEqual(served);
        expect(recovered.system).toEqual(frozen.system);
        expect(lane.pluginCalls()).toBe(0);
    } finally {
        await lane.dispose();
    }
}, 120_000);

test("OC1 bridge: a recovery run with no system_prompt fact is refused, then served once the fact is recorded", async () => {
    const lane = await relay();
    try {
        const frozen = await lane.throughDeadline();
        expect(frozen.system[0]!.length).toBeGreaterThan(HOST_SYSTEM.length);
        // No fact is recorded between the refused DEADLINE pass and RECOVER. Served,
        // this run would send the host's raw system prompt without the guidance
        // that every earlier request carried.
        const refusal = await lane.prompt({ fact: false }).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(refusal).toBeInstanceOf(BridgeRefusalError);
        expect(refusal).toMatchObject({
            code: "bridge_system_prompt_unmanaged",
            reason: "system_prompt_unmanaged",
            retryable: true,
        });
        expect(String((refusal as Error).message)).toContain("Record the system_prompt fact");
        // The refusal does not stick: the same step with a fresh fact is served.
        const recovered = await lane.prompt();
        expect(recovered.system).toEqual(frozen.system);
        expect(recovered.system[0]).toContain(GUIDANCE_HEADING);
        expect(tags(recovered.messages).slice(0, 4)).toEqual(["§1§", "§2§", "§3§", "§4§"]);
    } finally {
        await lane.dispose();
    }
}, 120_000);
