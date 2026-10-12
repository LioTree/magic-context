import { afterEach, describe, expect, test } from "bun:test";
import { lifecycleTextHash } from "../../features/magic-context/memory/lifecycle-text";
import type { TurnTwoStageRecord } from "../../features/magic-context/memory/turn-two";
import {
    __turnTwoChildrenTest,
    registerTurnTwoChild,
} from "../../features/magic-context/memory/turn-two-children";
import type { HiddenCompletionExecutor, HiddenRunHandle } from "./compartment-runner-types";
import { createOpenCodeTurnTwoRecovery } from "./historian-turn-two-carrier";

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
