import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHiddenAgentRegistrations } from "../../agents/hidden-agent-registrations";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { Database } from "../../shared/sqlite";
import { createCtxMemoryTools } from "../../tools/ctx-memory";
import { hiddenAgentAllowedTools } from "../../v2/hooks/hidden-child";
import type {
    HiddenCompletionExecutor,
    HiddenRunHandle,
    HiddenRunIdentity,
} from "./compartment-runner-types";
import {
    __dreamChildClaimantTest,
    type DreamChildDescriptor,
    type DreamChildGate,
    publishDreamChildHost,
    publishedDreamChildHost,
} from "./dream-child-claimant";
import {
    createHiddenDreamChildHost,
    hiddenDreamChildRefusal,
    OPENCODE1_DREAM_AGENT_TOOLS,
    OPENCODE2_DREAM_AGENT_TOOLS,
    openCode1DreamChildCapabilities,
    openCode1Transcript,
    openCode2DreamChildCapabilities,
    openCode2Transcript,
} from "./dream-child-hidden-host";

const directory = realpathSync(createTestTempDirFromPath(join(tmpdir(), "dream-child-host-")));

function descriptor(overrides: Partial<DreamChildDescriptor> = {}): DreamChildDescriptor {
    return {
        task: "curate",
        invocation: "invocation-1",
        parentSessionId: "parent",
        childId: "logical-child-secret",
        directory,
        agent: "dreamer",
        allowedTools: ["ctx_memory"],
        maxSteps: 3,
        model: { model: "provider/model/with/slash", qualifier: "high" },
        system: "system text",
        prompt: "prompt text",
        deadlineMs: Date.now() + 60_000,
        tokenBudget: 100,
        ...overrides,
    };
}

const oc1 = {
    capabilities: { ...openCode1DreamChildCapabilities(), retire: true },
    agentTools: OPENCODE1_DREAM_AGENT_TOOLS,
    directory,
};
const oc2 = {
    capabilities: openCode2DreamChildCapabilities(false),
    agentTools: OPENCODE2_DREAM_AGENT_TOOLS,
    directory,
};

describe("what each host declares and refuses", () => {
    it("declares no filesystem fence on either host, and a default model only on OpenCode 2", () => {
        expect(openCode1DreamChildCapabilities().filesystem_fence).toBe(false);
        expect(openCode2DreamChildCapabilities(false).filesystem_fence).toBe(false);
        expect(openCode1DreamChildCapabilities().default_model).toBe(false);
        expect(openCode2DreamChildCapabilities(false).default_model).toBe(true);
        expect(openCode1DreamChildCapabilities().tools).toEqual(["ctx_memory"]);
        expect(openCode2DreamChildCapabilities(false).tools).toEqual(["ctx_memory"]);
        // A child kept for inspection is not retired, so retirement is not promised.
        expect(openCode2DreamChildCapabilities(true).retire).toBe(false);
    });

    it("lists exactly the tools each host's own hidden agent registration allows", () => {
        const registered = buildHiddenAgentRegistrations({
            dreamerPrompt: "p",
            historianPrompt: "p",
            historianEditorPrompt: "p",
            historianDisallowed: [],
        });
        for (const [agent, tools] of Object.entries(OPENCODE1_DREAM_AGENT_TOOLS)) {
            expect(registered.find((registration) => registration.id === agent)?.allowedTools).toEqual(
                [...tools],
            );
        }
        for (const [agent, tools] of Object.entries(OPENCODE2_DREAM_AGENT_TOOLS)) {
            expect(hiddenAgentAllowedTools(agent)).toEqual([...tools]);
        }
    });

    it("accepts the curate descriptor on both hosts", () => {
        expect(hiddenDreamChildRefusal(descriptor(), oc1)).toBeUndefined();
        expect(hiddenDreamChildRefusal(descriptor(), oc2)).toBeUndefined();
    });

    it("refuses a descriptor needing a native read tool, because neither host fences paths", () => {
        const mapper = descriptor({ agent: "dreamer-memory-mapper", allowedTools: ["read"] });
        expect(hiddenDreamChildRefusal(mapper, oc1)).toBe("agent_unsupported:dreamer-memory-mapper");
        const fenced = {
            ...oc1,
            capabilities: { ...oc1.capabilities, tools: ["ctx_memory", "read"] },
            agentTools: { ...oc1.agentTools, reader: ["read"] },
        };
        expect(
            hiddenDreamChildRefusal(descriptor({ agent: "reader", allowedTools: ["read"] }), fenced),
        ).toBe("filesystem_fence_unavailable:read");
    });

    it("refuses a tool the agent's own registration does not carry rather than substituting an agent", () => {
        expect(
            hiddenDreamChildRefusal(
                descriptor({ agent: "dreamer-classifier", allowedTools: ["ctx_memory"] }),
                oc1,
            ),
        ).toBe("tool_not_carried:dreamer-classifier:ctx_memory");
        expect(hiddenDreamChildRefusal(descriptor({ agent: "dreamer-reviewer", allowedTools: [] }), oc2)).toBe(
            "agent_unsupported:dreamer-reviewer",
        );
    });

    it("refuses a missing model where the host cannot honour the creating session's default", () => {
        expect(hiddenDreamChildRefusal(descriptor({ model: null }), oc1)).toBe(
            "default_model_unavailable",
        );
        expect(hiddenDreamChildRefusal(descriptor({ model: null }), oc2)).toBeUndefined();
    });

    it("refuses a missing mandatory capability, a zero step cap, and another directory", () => {
        expect(
            hiddenDreamChildRefusal(descriptor(), {
                ...oc1,
                capabilities: { ...oc1.capabilities, retire: false },
            }),
        ).toBe("capability_missing:retire");
        expect(hiddenDreamChildRefusal(descriptor({ maxSteps: 0 }), oc1)).toBe("invalid_step_cap");
        expect(hiddenDreamChildRefusal(descriptor({ directory: "/elsewhere" }), oc1)).toBe(
            "directory_not_served_here",
        );
    });
});

class FakeExecutor implements HiddenCompletionExecutor {
    readonly capabilities = { tools: true, harness: "opencode" as const };
    opened: HiddenRunIdentity[] = [];
    attempts: unknown[] = [];
    closed = 0;
    interruptFails = false;
    state: "active" | "terminal" | "unavailable" | "unknown" = "terminal";
    async open(run: HiddenRunIdentity): Promise<HiddenRunHandle> {
        this.opened.push(run);
        return { id: "host-child", childSessionId: "host-child" };
    }
    async attempt(_handle: HiddenRunHandle, request: unknown): Promise<void> {
        this.attempts.push(request);
    }
    async collect(): Promise<never> {
        throw new Error("unused");
    }
    async interrupt(): Promise<void> {
        if (this.interruptFails) throw new Error("not running");
    }
    async recoveryState() {
        return this.state;
    }
    async close(): Promise<void> {
        this.closed += 1;
    }
}

describe("hidden child carrier", () => {
    const build = (executor: FakeExecutor, removed: () => boolean, registered = true) =>
        createHiddenDreamChildHost({
            executor,
            ...oc1,
            transcript: async () => [],
            confirmRemoved: async () => removed(),
            agentRegistered: async () => registered,
        });

    it("opens a dream-task child with the exact selected model and sends the claim's prompt once", async () => {
        const executor = new FakeExecutor();
        const run = await build(executor, () => true).create(descriptor(), new AbortController().signal);
        expect(executor.opened[0]).toMatchObject({
            parentSessionId: "parent",
            agent: "dreamer",
            kind: "dreamer-task",
            system: "system text",
            model: { model: "provider/model/with/slash", qualifier: "high" },
            directory,
        });
        expect(executor.opened[0]?.title.startsWith("magic-context-dream-child-")).toBe(true);
        // The module's logical child id is a credential binding; it never names the session.
        expect(executor.opened[0]?.title).not.toContain("logical-child-secret");
        await run.prompt(new AbortController().signal);
        await expect(run.prompt(new AbortController().signal)).rejects.toThrow("sent once");
        expect(executor.attempts).toHaveLength(1);
        expect((executor.attempts[0] as { body: unknown }).body).toEqual({
            agent: "dreamer",
            system: "system text",
            model: { providerID: "provider", modelID: "model/with/slash" },
            variant: "high",
            parts: [{ type: "text", text: "prompt text" }],
        });
    });

    it("reports quiescence from the host's record when there was nothing left to interrupt", async () => {
        const executor = new FakeExecutor();
        executor.interruptFails = true;
        const run = await build(executor, () => true).create(descriptor(), new AbortController().signal);
        expect(await run.abort()).toBe(true);
        executor.state = "active";
        expect(await run.abort()).toBe(false);
    });

    it("reports retirement only when the host confirms the child is gone", async () => {
        const executor = new FakeExecutor();
        let gone = false;
        const run = await build(executor, () => gone).create(descriptor(), new AbortController().signal);
        expect(await run.retire()).toBe(false);
        gone = true;
        expect(await run.retire()).toBe(true);
    });

    it("refuses an agent the host does not currently register", async () => {
        const host = build(new FakeExecutor(), () => true, false);
        expect(await host.refusal(descriptor())).toBe("agent_not_registered:dreamer");
    });

    it("is published per directory for the claimant that serves it", () => {
        const host = build(new FakeExecutor(), () => true);
        const withdraw = publishDreamChildHost(directory, () => host);
        expect(publishedDreamChildHost(directory)).toBe(host);
        withdraw();
        expect(publishedDreamChildHost(directory)).toBeUndefined();
    });
});

describe("host transcripts", () => {
    it("reads OpenCode 1 assistant messages with their own usage", () => {
        expect(
            openCode1Transcript([
                { info: { id: "u1", role: "user" }, parts: [] },
                {
                    info: {
                        id: "a1",
                        role: "assistant",
                        finish: "tool-calls",
                        tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } },
                    },
                    parts: [{ type: "text", text: "hi" }, { type: "tool" }],
                },
                { info: { id: "a2", role: "assistant", time: { created: 1 } }, parts: [] },
            ]),
        ).toEqual([
            {
                id: "a1",
                text: "hi",
                usage: { input: 10, output: 5, cache_read: 2, cache_write: 1 },
                finished: true,
                finish: "tool-calls",
            },
            { id: "a2", text: "", usage: null, finished: false },
        ]);
    });

    it("reads OpenCode 2 assistant rows with their own usage", () => {
        expect(
            openCode2Transcript([
                {
                    id: "r1",
                    data: {
                        finish: "stop",
                        content: [{ type: "text", text: "done" }],
                        tokens: { input: 7, output: 3, cache: { read: 1, write: 0 } },
                    },
                },
            ]),
        ).toEqual([
            {
                id: "r1",
                text: "done",
                usage: { input: 7, output: 3, cache_read: 1, cache_write: 0 },
                finished: true,
                finish: "stop",
            },
        ]);
    });
});

describe("ctx_memory in a claimed dream child", () => {
    it("goes to the child's task route with the model's arguments as data, never to the local writer", async () => {
        const calls: Array<{ tool: string; args: unknown }> = [];
        const gate: DreamChildGate = {
            hostChildId: "dream-host-child",
            admitStep: async () => {},
            toolRefusal: () => undefined,
            runTaskTool: async (tool, args) => {
                calls.push({ tool, args });
                return "routed";
            },
        };
        const registry = __dreamChildClaimantTest.gateRegistry();
        registry.set(gate.hostChildId, gate);
        const db = new Database(":memory:");
        try {
            let resolved = 0;
            const tools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => {
                    resolved += 1;
                    return undefined;
                },
            });
            const context = (sessionID: string) =>
                ({
                    sessionID,
                    messageID: "m",
                    agent: "dreamer",
                    directory,
                    worktree: directory,
                    abort: new AbortController().signal,
                    metadata: () => {},
                    ask: async () => {},
                }) as never;
            const args = { action: "archive", ids: [1], token: "forged", child_id: "forged" };
            expect(await tools.ctx_memory.execute(args as never, context("dream-host-child"))).toBe(
                "routed",
            );
            expect(calls).toEqual([{ tool: "ctx_memory", args }]);
            expect(resolved).toBe(0);
            // Any other session takes the ordinary path.
            const ordinary = await tools.ctx_memory.execute(
                { action: "get", ids: [1] } as never,
                context("ordinary-session"),
            );
            expect(String(ordinary)).toContain("Could not resolve project identity");
            expect(calls).toHaveLength(1);
        } finally {
            registry.delete(gate.hostChildId);
            db.close();
        }
    });
});

