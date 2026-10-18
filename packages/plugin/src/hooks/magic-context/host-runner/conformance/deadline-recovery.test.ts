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
 * Like that host, the test records each request's system_prompt fact after its
 * run(), as OpenCode 1 orders them, and never confirms delivery, so every receipt stays pending
 * (served_through_ordinal 0). The session is enrolled as bridged, so the
 * OpenCode 1 plugin's own hooks stand down and only the bridge view reaches the
 * provider.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import { runMigrations } from "../../../../features/magic-context/migrations";
import { initializeDatabase } from "../../../../features/magic-context/storage-db";
import { standDownForBridgedSessions } from "../../../../plugin/bridged-session-guard";
import { BRIDGED_SESSIONS_KEY } from "../../../../shared/bridged-sessions";
import { Database } from "../../../../shared/sqlite";
import { stableStringify } from "../../../../shared/stable-json";
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

function assistant(n: number, refused: boolean | "aborted" = false): MessageLike {
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
                          data: {
                              message: `Bridge relay transport refused: ${refused === "aborted" ? "aborted" : "deadline"}`,
                          },
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
async function relay(session = SESSION) {
    await oracle.call({ control: "reset" });
    await oracle.call({ control: "bind", harness: "opencode", session });
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
    const unregister = setRawMessageProvider(session, {
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
    let abort = false;
    const calls: { method: string; params: any; answer: any }[] = [];
    const transport: BridgeTransport = {
        async request(method, body) {
            const request = JSON.parse(Buffer.from(body).toString());
            const answer = await oracle.call(request);
            const decoded = JSON.parse(answer);
            calls.push({ method, params: request.params, answer: decoded });
            if (decoded.oracle_error) throw decoded.oracle_error;
            if (method === "transform.declare") {
                for (const sub of decoded.subscriptions) sub.budget_ms = 10_000;
                return Buffer.from(JSON.stringify(decoded));
            }
            // The module committed this answer; the relay loses it at the deadline.
            if (deadline && method === "transform.hook")
                throw { source: "relay", code: "deadline" };
            if (abort && method === "state_sync") throw { source: "relay", code: "aborted" };
            return Buffer.from(answer);
        },
    };
    const adapterOptions = {
        projectRoot: root,
        connectionFile: join(root, "unused.json"),
        storageDir: root,
        configPath,
        openCodeClient: { session: {} } as any,
        transport,
    };
    let adapter = await createBridgeAdapter(adapterOptions);
    // THALAMUS enrolls the session, so the OpenCode 1 plugin's hooks stand down.
    // Their inner callbacks would edit history and the prompt; neither may run.
    const bridged = new Map([[session, { product: "thalamus", version: "test" }]]);
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

    /**
     * One OpenCode 1 turn in the host's real order: the messages transform calls run(),
     * then request preparation runs the system transform, which records the
     * system_prompt fact for that same request. With `send: false` the host refuses the
     * request after preparing it (THALAMUS_MODEL_SEND_REFUSED): nothing reaches the
     * provider and no response is reported.
     */
    async function prompt(options: { send?: boolean; system?: string } = {}) {
        const view = await adapter.run({
            sessionId: session,
            messages: rows.slice(),
            kind: "model",
        });
        const output = { messages: view.messages };
        await plugin["experimental.chat.messages.transform"]!({}, output as never);
        const systemOutput = { system: [options.system ?? HOST_SYSTEM] };
        await plugin["experimental.chat.system.transform"]!(
            { sessionID: session, model } as never,
            systemOutput,
        );
        const fact = await adapter.recordHostFact({
            kind: "system_prompt",
            sessionId: session,
            lineageId: view.receipt.lineage_id,
            model,
            observedAt: Date.now(),
            system: systemOutput.system,
        });
        if (options.send !== false) {
            const now = Date.now();
            await adapter.recordHostFact({
                kind: "provider_response",
                sessionId: session,
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
        }
        return { view, messages: output.messages, fact };
    }

    /**
     * BOOTSTRAP, ORDINARY and FROZEN served; DEADLINE refused inside run(), so OpenCode
     * never prepares that request and records no system_prompt fact for it.
     */
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
        rows,
        calls,
        setDeadline(value: boolean) {
            deadline = value;
        },
        setAbort(value: boolean) {
            abort = value;
        },
        async restart() {
            await adapter.dispose();
            adapter = await createBridgeAdapter(adapterOptions);
        },
        complete: (requestId: string) =>
            adapter.completeRequest(session, requestId, { status: 200, cleanEnd: true }),
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

const guided = (fact: { accepted: boolean; system?: string[] }) => {
    expect(fact.accepted).toBe(true);
    expect(fact.system?.[0]).toContain(HOST_SYSTEM);
    expect(fact.system?.[0]).toContain(GUIDANCE_HEADING);
    return fact.system!;
};

/** Run one turn and return its refusal; fails the test if the turn was served. */
async function refusedTurn(lane: Awaited<ReturnType<typeof relay>>) {
    const refusal = await lane.prompt().then(
        () => undefined,
        (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(BridgeRefusalError);
    expect(refusal).toMatchObject({
        code: "bridge_served_bytes_changed",
        reason: "served_bytes_changed",
        retryable: true,
    });
}

test("OC1 bridge: recovery after a deadline never sends stripped history and keeps every tag and the guidance once served", async () => {
    const lane = await relay();
    try {
        const frozen = await lane.throughDeadline();
        const served = tags(frozen.messages);
        expect(served).toEqual(["§1§", "§2§", "§3§", "§4§"]);
        const frozenSystem = guided(frozen.fact);
        // RECOVER carries the errored assistant row of the refused turn, and ck-mc
        // applies a rebuild that renders unconfirmed tags raw. The bridge refuses
        // it instead of returning stripped history.
        await refusedTurn(lane);
        // Nothing was committed. Once the host confirms the last delivered request,
        // the same step is served with every served tag in place.
        lane.complete(frozen.view.receipt.request_id);
        const recovered = await lane.prompt();
        // The module serializes object keys in sorted order, so compare content
        // with keys sorted; text and parts must be identical.
        const byId = new Map(recovered.messages.map((m) => [m.info.id, stableStringify(m)]));
        for (const message of frozen.messages.filter((m) => m.info.id))
            expect(byId.get(message.info.id)).toBe(stableStringify(message));
        expect(tags(recovered.messages).slice(0, served.length)).toEqual(served);
        // RECOVER's own system_prompt fact, recorded after its run() as OpenCode 1
        // does, returns the managed prompt with the guidance.
        expect(guided(recovered.fact)).toEqual(frozenSystem);
        expect(lane.pluginCalls()).toBe(0);
    } finally {
        await lane.dispose();
    }
}, 120_000);

test("OC1 bridge: the turn after a host refused to send never drops that turn's tags", async () => {
    const lane = await relay();
    try {
        lane.rows.push(user(1, "MC_RELAY_BOOTSTRAP"));
        await lane.prompt();
        lane.rows.push(assistant(2), user(3, "MC_RELAY_ORDINARY"));
        await lane.prompt();
        lane.rows.push(assistant(4), user(5, "MC_RELAY_REFUSED_SEND"));
        // run() applies and freezes this turn's answers; the host then refuses to
        // send the request (THALAMUS_MODEL_SEND_REFUSED) and OpenCode stores an
        // errored assistant row for the turn.
        const refused = await lane.prompt({ send: false });
        expect(tags(refused.messages)).toEqual(["§1§", "§2§", "§3§", "§4§"]);
        lane.rows.push(assistant(6, true), user(7, "MC_RELAY_AFTER_REFUSED_SEND"));
        // The next turn's rebuild would render those unconfirmed answers raw; the
        // bridge refuses it rather than send history without them.
        await refusedTurn(lane);
    } finally {
        await lane.dispose();
    }
}, 120_000);

test("OC1 bridge: a rebuild that would strip served tags under pending delivery refuses, then serves once delivery is confirmed", async () => {
    const lane = await relay();
    try {
        lane.rows.push(user(1, "MC_RELAY_BOOTSTRAP"));
        await lane.prompt();
        lane.rows.push(assistant(2), user(3, "MC_RELAY_ORDINARY"));
        await lane.prompt();
        lane.rows.push(assistant(4), user(5, "MC_RELAY_FROZEN"));
        // The host prompt changes in this request's preparation, so the next run
        // declares a rebuild. Delivery is never confirmed, so ck-mc rebuilds from
        // confirmed answers only and would render every message raw.
        const frozen = await lane.prompt({ system: `${HOST_SYSTEM}\nToday changed.` });
        expect(tags(frozen.messages)).toEqual(["§1§", "§2§", "§3§", "§4§"]);
        lane.rows.push(assistant(6, true), user(7, "MC_RELAY_REBUILD"));
        await refusedTurn(lane);
        // The refusal committed nothing. Once the host confirms that the last
        // request was delivered, the same step renders the confirmed tags.
        expect(
            lane.complete(frozen.view.receipt.request_id)?.served_through_ordinal,
        ).toBeGreaterThan(0);
        const served = await lane.prompt();
        expect(served.view.kind).toBe("rebuild");
        // The module serializes object keys in sorted order, so compare content
        // with keys sorted; text and parts must be identical.
        const byId = new Map(served.messages.map((m) => [m.info.id, stableStringify(m)]));
        for (const message of frozen.messages.filter((m) => m.info.id))
            expect(byId.get(message.info.id)).toBe(stableStringify(message));
    } finally {
        await lane.dispose();
    }
}, 120_000);

// Refused preparations leave assistant rows in OpenCode, but no provider reply.
// Keep all three rows: omitting them hides the module-ahead ordinal conflict.
for (const divergence of [false, true])
    test(`OC1 bridge: THALAMUS deadline and abort recovery never serves raw frozen history${divergence ? " after ingest divergence" : ""}`, async () => {
        const lane = await relay();
        try {
            const frozen = await lane.throughDeadline();
            expect(tags(frozen.messages)).toEqual(["§1§", "§2§", "§3§", "§4§"]);
            await refusedTurn(lane);
            lane.rows.push(assistant(10, true), user(11, "MC_RELAY_ABORT"));
            lane.setAbort(true);
            await expect(lane.prompt()).rejects.toThrow();
            expect(lane.calls.at(-1)?.method).toBe("state_sync");
            lane.setAbort(false);
            if (divergence) {
                // The recorded relay omits ingest params. Deliberately change the
                // refused recovery prompt to exercise its observed ordinal-conflict
                // descent; this is a control, not a claim about the host's real field.
                lane.rows.find((m) => m.info.id === "u9")!.parts[0].text += " (edited)";
            }
            lane.rows.push(assistant(12, "aborted"), user(13, "MC_RELAY_RECOVER_ABORT"));
            const recovered = await lane.prompt().then(
                (result) => ({ result, error: undefined }),
                (error: unknown) => ({ result: undefined, error }),
            );
            if (recovered.result) {
                const byId = new Map(
                    recovered.result.messages.map((m) => [m.info.id, stableStringify(m)]),
                );
                for (const message of frozen.messages.filter((m) => m.info.id))
                    expect(byId.get(message.info.id)).toBe(stableStringify(message));
            } else {
                expect(recovered.error).toMatchObject({
                    code: "bridge_served_bytes_changed",
                    retryable: true,
                });
            }
            const steps = lane.calls.filter((call) => call.method === "compaction.step");
            if (divergence) {
                expect(
                    lane.calls.some((call) => call.answer.oracle_error?.code === "invalid_params"),
                ).toBe(true);
                expect(steps.at(-1)?.params.lineage_id).not.toBe(frozen.view.receipt.lineage_id);
            }
            expect(steps.at(-1)?.params.prefix_rebuilding).toEqual({ reason: "manifest_change" });
        } finally {
            await lane.dispose();
        }
    }, 120_000);

test("OC1 bridge: adapter restart retains the served baseline across a manifest rebuild", async () => {
    const lane = await relay();
    try {
        lane.rows.push(user(1, "MC_RELAY_BOOTSTRAP"));
        await lane.prompt();
        lane.rows.push(assistant(2), user(3, "MC_RELAY_ORDINARY"));
        await lane.prompt();
        lane.rows.push(assistant(4), user(5, "MC_RELAY_FROZEN"));
        const frozen = await lane.prompt();
        expect(tags(frozen.messages)).toEqual(["§1§", "§2§", "§3§", "§4§"]);
        await lane.restart();
        lane.rows.push(assistant(6, true), user(7, "MC_RELAY_AFTER_RESTART"));
        await refusedTurn(lane);
        expect(lane.calls.at(-1)?.answer.compaction?.version).toBeGreaterThan(
            frozen.view.receipt.last_applied!.version,
        );
    } finally {
        await lane.dispose();
    }
}, 120_000);

const recorded = JSON.parse(
    readFileSync(new URL("./oc1-recovery-run3.json", import.meta.url), "utf8"),
) as {
    inputs: MessageLike[][];
    requests: {
        line: number;
        request: { method: string; params?: Record<string, any> };
        mode: string;
    }[];
};

test("OC1 bridge: recorded run3 inputs refuse retryably without a UI-summary lineage fork", async () => {
    const session = recorded.inputs[0][0].info.sessionID!;
    const lane = await relay(session);
    try {
        const load = (turn: number) =>
            lane.rows.splice(0, lane.rows.length, ...structuredClone(recorded.inputs[turn]));
        load(0);
        await lane.prompt();
        load(1);
        await lane.prompt();
        load(2);
        const frozen = await lane.prompt();
        expect(tags(frozen.messages)).toEqual(["§1§", "§2§", "§3§", "§4§"]);
        load(3);
        lane.setDeadline(true);
        await expect(lane.prompt()).rejects.toThrow("Bridge relay transport refused: deadline");
        lane.setDeadline(false);
        load(4);
        await refusedTurn(lane);
        load(5);
        lane.setAbort(true);
        await expect(lane.prompt()).rejects.toThrow();
        lane.setAbort(false);
        load(6);
        await refusedTurn(lane);
        expect(
            lane.calls.filter((call) => call.answer.oracle_error?.code === "invalid_params"),
        ).toEqual([]);
        const steps = lane.calls.filter((call) => call.method === "compaction.step");
        expect(steps.at(-1)?.params.prefix_rebuilding).toEqual({ reason: "manifest_change" });
        expect(steps.at(-1)?.params.lineage_id).toBe(frozen.view.receipt.lineage_id);
        expect(steps.at(-1)?.answer.compaction?.version).toBeGreaterThan(
            frozen.view.receipt.last_applied!.version,
        );
    } finally {
        await lane.dispose();
    }
}, 120_000);

test("OC1 module: recorded run3 RPCs expose UI-summary ingest conflicts, not ordinal drift", async () => {
    await oracle.call({ control: "reset" });
    await oracle.call({
        control: "bind",
        harness: "opencode",
        session: recorded.inputs[0][0].info.sessionID,
    });
    const failures: { line: number; error: any }[] = [];
    for (const { line, request } of recorded.requests) {
        const answer = JSON.parse(await oracle.call(request));
        if (answer.oracle_error) failures.push({ line, error: answer.oracle_error });
    }
    // The ABORT relay loses the error from line 47; direct RPC replay can see it.
    expect(
        failures
            .filter(({ error }) => error.code === "authority_seq_mismatch")
            .map(({ line }) => line),
    ).toEqual([33, 47, 50, 72]);
    expect(failures.filter(({ error }) => error.code === "invalid_params")).toEqual([
        {
            line: 60,
            error: {
                source: "module",
                code: "invalid_params",
                detail: { field: "message" },
                message: "provider subject changed its admitted bytes",
            },
        },
        {
            line: 70,
            error: {
                source: "module",
                code: "invalid_params",
                detail: { field: "messages" },
                message: "invalid provider messages",
            },
        },
    ]);
}, 120_000);

test("OC1 module: normalizing only UI summaries removes recorded conflicts with the same re-syncs", async () => {
    await oracle.call({ control: "reset" });
    await oracle.call({
        control: "bind",
        harness: "opencode",
        session: recorded.inputs[0][0].info.sessionID,
    });
    const failures: { line: number; code: string }[] = [];
    for (const { line, request } of recorded.requests.filter(({ line }) => line <= 70)) {
        const normalized = structuredClone(request);
        const params = normalized.params;
        const messages = [
            params?.message,
            ...(params?.messages ?? []).map((entry: any) => entry.message),
        ].filter(Boolean);
        for (const message of messages) {
            if (message.info?.role === "user") delete message.info.summary;
        }
        const answer = JSON.parse(await oracle.call(normalized));
        if (answer.oracle_error) failures.push({ line, code: answer.oracle_error.code });
    }
    expect(failures).toEqual(
        [33, 47, 50].map((line) => ({ line, code: "authority_seq_mismatch" })),
    );
}, 120_000);
