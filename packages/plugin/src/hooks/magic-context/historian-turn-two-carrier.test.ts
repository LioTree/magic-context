import { afterEach, describe, expect, test } from "bun:test";
import { lifecycleTextHash } from "../../features/magic-context/memory/lifecycle-text";
import type { TurnTwoStageRecord } from "../../features/magic-context/memory/turn-two";
import {
    __turnTwoChildrenTest,
    registerTurnTwoChild,
} from "../../features/magic-context/memory/turn-two-children";
import { parseTurnTwoEnvelope } from "../../features/magic-context/memory/turn-two-envelope";
import type {
    HiddenCompletionExecutor,
    HiddenRunHandle,
    RetainedHistorianChild,
} from "./compartment-runner-types";
import {
    createOpenCodeTurnTwoCarrier,
    createOpenCodeTurnTwoRecovery,
} from "./historian-turn-two-carrier";

afterEach(() => __turnTwoChildrenTest.clear());

const TURN_ONE = "<compartments>turn one</compartments>";

function record(extra: Partial<TurnTwoStageRecord> = {}): TurnTwoStageRecord {
    return {
        stageKey: "stage",
        projectPath: "p",
        publicationId: "pub",
        runAttempt: 1,
        sessionId: "ses",
        harness: "opencode2",
        carrier: "hidden-completion",
        childSessionId: "child-1",
        startedAt: 0,
        baseline: lifecycleTextHash(TURN_ONE),
        historianSystemHash: "historian-hash",
        variant: "high",
        ...extra,
    };
}

function executor(collect: (handle: HiddenRunHandle) => string) {
    const seen: HiddenRunHandle[] = [];
    const closed: HiddenRunHandle[] = [];
    const value: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode2" },
        open: async () => ({ id: "x" }),
        attempt: async () => {},
        collect: async (handle) => {
            seen.push(handle);
            return {
                text: collect(handle),
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                lengthCapped: false,
                providerId: "test",
                modelId: "fallback-model",
            };
        },
        close: async (handle) => {
            if (handle) closed.push(handle);
        },
    };
    return { value, seen, closed };
}

describe("OpenCode turn-two recovery", () => {
    test("OpenCode transports a blocked tool result beside valid text as an envelope failure, including recovery", async () => {
        const host = executor(() => '{"result":{"step":"turn_two","decisions":[]}}');
        const collect = host.value.collect;
        host.value.collect = async (handle, limit) => ({
            ...(await collect(handle, limit)),
            messages: [
                {
                    info: { role: "assistant" },
                    parts: [{ type: "tool", state: { status: "error", output: "blocked read" } }],
                },
            ],
        });
        const child: RetainedHistorianChild = {
            executor: host.value,
            handle: { id: "child-1" },
            agent: "historian",
            system: "contract",
            model: "test/model",
            directory: "/d",
            turnOneText: TURN_ONE,
            close: async () => {},
        };
        const carrier = createOpenCodeTurnTwoCarrier({
            child,
            parentSessionId: "ses",
            harness: "opencode2",
            carrier: "hidden-completion",
            turnOneText: TURN_ONE,
            timeoutMs: 1000,
        });
        const reply = await carrier.send("turn two", "stage");
        expect(parseTurnTwoEnvelope(reply.text, reply.lengthCapped, reply.toolActivity)).toEqual({
            ok: false,
            reason: "tool_activity",
        });
        const recovered = createOpenCodeTurnTwoRecovery({
            executor: host.value,
            carrier: "hidden-completion",
            harness: "opencode2",
            directory: "/d",
            timeoutMs: 1000,
            now: () => 10_000,
        })(record());
        if (!recovered || recovered === "busy") throw new Error("expected recovery");
        expect(await recovered.reattach()).toMatchObject({
            kind: "reply",
            reply: { toolActivity: true },
        });
    });
    for (const harness of ["opencode", "opencode2"]) {
        test(`${harness} serialized carrier requests stay best-effort and recovery sends nothing`, async () => {
            const requests: unknown[] = [];
            const host = executor(() => '  {"result":{"step":"turn_two","decisions":[]}}\n');
            host.value.attempt = async (_handle, request) => {
                requests.push(JSON.parse(JSON.stringify(request)));
            };
            const handle = { id: "child-1", childSessionId: "child-1" };
            const child: RetainedHistorianChild = {
                executor: host.value,
                handle,
                agent: "historian",
                system: "combined prompt contract",
                model: "test/model",
                directory: "/d",
                turnOneText: TURN_ONE,
                close: async () => {},
            };
            await host.value.attempt(handle, {
                path: { id: handle.id },
                body: {
                    agent: "historian",
                    parts: [{ type: "text", text: "turn one", synthetic: true }],
                },
            });
            const carrier = createOpenCodeTurnTwoCarrier({
                child,
                parentSessionId: "ses",
                harness,
                carrier: "hidden-completion",
                turnOneText: TURN_ONE,
                timeoutMs: 1000,
            });
            const reply = await carrier.send("turn two", "stage");
            const bytes = JSON.stringify(requests);
            for (const key of [
                "response_schema",
                "responseSchema",
                "response_format",
                "tool_choice",
                "toolChoice",
                "StructuredOutput",
                "capture",
            ])
                expect(bytes).not.toContain(key);
            const toolBytes = requests.map((request) =>
                JSON.stringify((request as { body: { tools?: unknown } }).body.tools ?? null),
            );
            expect(toolBytes).toEqual(["null", "null"]);
            const recovery = createOpenCodeTurnTwoRecovery({
                executor: host.value,
                carrier: "hidden-completion",
                harness,
                directory: "/d",
                timeoutMs: 1000,
                now: () => 10_000,
            })(record({ harness }));
            if (!recovery || recovery === "busy") throw new Error("expected recovery");
            expect(await recovery.reattach()).toMatchObject({
                kind: "reply",
                reply: { text: reply.text },
            });
            expect(JSON.stringify(requests)).toBe(bytes);
            expect(reply.text).toBe('  {"result":{"step":"turn_two","decisions":[]}}\n');
        });
    }
    test("a recovered reply carries the reported model with the stage's historian hash and variant", async () => {
        const host = executor(() => '{"decisions":[]}');
        const resolve = createOpenCodeTurnTwoRecovery({
            executor: host.value,
            carrier: "hidden-completion",
            harness: "opencode2",
            directory: "/d",
            timeoutMs: 1000,
            now: () => 10_000,
        });
        const carrier = resolve(record());
        if (!carrier || carrier === "busy") throw new Error("expected a carrier");
        expect(await carrier.reattach()).toEqual({
            kind: "reply",
            reply: {
                text: '{"decisions":[]}',
                lengthCapped: false,
                toolActivity: false,
                profile: {
                    provider: "test",
                    modelId: "fallback-model",
                    variant: "high",
                    temperature: null,
                    systemHash: "historian-hash",
                },
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
        });
    });

    test("a child retained here is reached through the executor's own handle, and is busy while its turn two runs", async () => {
        const host = executor(() => TURN_ONE);
        const issued: HiddenRunHandle = { id: "child-1", childSessionId: "child-1" };
        let closed = 0;
        const retained = {
            childSessionId: "child-1",
            parentSessionId: "ses",
            harness: "opencode2",
            handle: issued,
            active: true,
            close: async () => {
                closed++;
            },
        };
        registerTurnTwoChild(retained);
        const resolve = createOpenCodeTurnTwoRecovery({
            executor: host.value,
            carrier: "hidden-completion",
            harness: "opencode2",
            directory: "/d",
            timeoutMs: 1000,
            now: () => 10_000,
        });
        expect(resolve(record())).toBe("busy");
        retained.active = false;
        const carrier = resolve(record());
        if (!carrier || carrier === "busy") throw new Error("expected a carrier");
        expect(await carrier.reattach()).toEqual({ kind: "unknown" });
        expect(host.seen[0]).toBe(issued);
        await carrier.close?.();
        expect(closed).toBe(1);
        expect(host.closed).toEqual([]);
    });

    test("a young stage of another process is busy; an old one whose child is gone is reported gone", async () => {
        const host = executor(() => {
            throw new Error("Hidden completion has no settled output");
        });
        const resolve = createOpenCodeTurnTwoRecovery({
            executor: host.value,
            carrier: "hidden-completion",
            harness: "opencode2",
            directory: "/d",
            timeoutMs: 1000,
            now: () => 500,
        });
        expect(resolve(record())).toBe("busy");
        const later = createOpenCodeTurnTwoRecovery({
            executor: host.value,
            carrier: "hidden-completion",
            harness: "opencode2",
            directory: "/d",
            timeoutMs: 1000,
            now: () => 10_000,
        });
        const carrier = later(record());
        if (!carrier || carrier === "busy") throw new Error("expected a carrier");
        expect(await carrier.reattach()).toEqual({ kind: "gone" });
        expect(later(record({ harness: "opencode" }))).toBeNull();
    });
});
