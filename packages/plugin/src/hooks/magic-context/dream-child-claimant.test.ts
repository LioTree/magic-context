import { describe, expect, it } from "bun:test";
import {
    admitDreamChildStep,
    DREAM_TASK_ROUTED_TOOLS,
    type DreamChildCapabilities,
    type DreamChildDescriptor,
    DreamChildClaimant,
    type DreamChildHost,
    type DreamChildRun,
    type DreamChildTranscriptMessage,
    type DreamChildUsage,
    dreamChildGate,
    dreamChildToolRefusal,
} from "./dream-child-claimant";
import {
    DreamClaimPeer,
    DreamPeerAdmissionError,
    type PeerDescriptor,
} from "./host-runner/fixtures/dream-claim-peer.fixture";

/** One scripted model step: the host admits it, then runs its tool calls, then records usage. */
interface ScriptStep {
    text?: string;
    tools?: Array<{ name: string; args?: unknown }>;
    usage?: DreamChildUsage;
    /** Wait here until the child is aborted (a model that never answers). */
    hang?: boolean;
}

const CAPABILITIES: DreamChildCapabilities = {
    tools: ["ctx_memory"],
    child_guard: true,
    steps: true,
    tokens: true,
    stop: true,
    retire: true,
    task_tools: true,
    filesystem_fence: false,
    default_model: false,
};

const ZERO: DreamChildUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

class FakeRun implements DreamChildRun {
    prompts = 0;
    promptedWhileStarted: boolean[] = [];
    /** Model calls the host actually made (a step admitted and run). */
    providerCalls = 0;
    /** Native tools the host actually executed. */
    nativeEffects: string[] = [];
    taskOutputs: string[] = [];
    refusals: string[] = [];
    aborted = false;
    abortedAt = 0;
    retired = false;
    readonly messages: DreamChildTranscriptMessage[] = [];

    constructor(
        readonly hostChildId: string,
        private readonly script: ScriptStep[],
        private readonly started: () => boolean,
    ) {}

    async prompt(signal: AbortSignal): Promise<void> {
        this.prompts += 1;
        this.promptedWhileStarted.push(this.started());
        for (const [index, step] of this.script.entries()) {
            if (signal.aborted) throw new Error("aborted");
            // The host hook that runs before every model call.
            await admitDreamChildStep(this.hostChildId);
            this.providerCalls += 1;
            const message: DreamChildTranscriptMessage = {
                id: `${this.hostChildId}-msg-${index}`,
                text: step.text ?? "",
                usage: null,
                finished: false,
            };
            this.messages.push(message);
            for (const tool of step.tools ?? []) {
                // The host's pre-execution tool hook.
                const refusal = dreamChildToolRefusal(this.hostChildId, tool.name);
                if (refusal) {
                    this.refusals.push(refusal);
                    continue;
                }
                if (DREAM_TASK_ROUTED_TOOLS.has(tool.name)) {
                    try {
                        const gate = dreamChildGate(this.hostChildId);
                        if (!gate) throw new Error("no gate");
                        this.taskOutputs.push(await gate.runTaskTool(tool.name, tool.args ?? {}));
                    } catch (error) {
                        this.refusals.push(String(error));
                    }
                } else {
                    this.nativeEffects.push(tool.name);
                }
            }
            if (step.hang) {
                await new Promise<void>((resolve) => {
                    if (signal.aborted) resolve();
                    signal.addEventListener("abort", () => resolve(), { once: true });
                });
                throw new Error("aborted");
            }
            message.usage = step.usage ?? ZERO;
            message.finished = true;
            message.finish = step.tools?.length ? "tool-calls" : "stop";
        }
    }

    async transcript(): Promise<DreamChildTranscriptMessage[]> {
        return this.messages.map((message) => ({ ...message }));
    }

    async abort(): Promise<boolean> {
        this.aborted = true;
        this.abortedAt ||= Date.now();
        return true;
    }

    async retire(): Promise<boolean> {
        this.retired = true;
        return true;
    }
}

class FakeHost implements DreamChildHost {
    readonly runs: FakeRun[] = [];
    createDelayMs = 0;
    onCreateStarted?: () => void;
    constructor(
        private readonly script: ScriptStep[],
        private readonly peer: DreamClaimPeer,
        readonly capabilities: DreamChildCapabilities = CAPABILITIES,
        private readonly agents: readonly string[] = ["dreamer"],
    ) {}

    refusal(descriptor: DreamChildDescriptor): string | undefined {
        return this.agents.includes(descriptor.agent)
            ? undefined
            : `agent_unsupported:${descriptor.agent}`;
    }

    async create(descriptor: DreamChildDescriptor): Promise<DreamChildRun> {
        this.onCreateStarted?.();
        if (this.createDelayMs > 0) await new Promise((r) => setTimeout(r, this.createDelayMs));
        const run = new FakeRun(`host-child-${this.runs.length + 1}`, this.script, () => {
            const entry = [...this.peer.entries.values()].find(
                (e) => e.child === descriptor.childId,
            );
            return entry?.start === true;
        });
        this.runs.push(run);
        return run;
    }
}

function descriptor(overrides: Partial<PeerDescriptor> = {}): PeerDescriptor {
    return {
        session: "parent",
        project: "/project",
        directory: "/project",
        agent: "dreamer",
        allowedTools: ["ctx_memory"],
        maxSteps: 5,
        model: { model: "provider/model/with/slash", qualifier: "high" },
        system: "system",
        prompt: "prompt",
        deadlineMs: Date.now() + 10_000,
        tokenBudget: 1_000,
        ...overrides,
    };
}

function setup(args: {
    script: ScriptStep[];
    descriptor?: Partial<PeerDescriptor>;
    capabilities?: DreamChildCapabilities;
}) {
    const peer = new DreamClaimPeer();
    const host = new FakeHost(args.script, peer, args.capabilities);
    const logs: string[] = [];
    const claimant = new DreamChildClaimant({
        call: async ({ method, sessionId, body }) => {
            try {
                return peer.route(sessionId, method, body);
            } catch (error) {
                if (error instanceof DreamPeerAdmissionError) throw error;
                throw error;
            }
        },
        host,
        claimantEpoch: "epoch-test",
        fastPollMs: 5,
        log: (message) => logs.push(message),
    });
    const entryId = peer.enqueue(descriptor(args.descriptor));
    const run = async () => {
        await claimant.pump("parent");
        await claimant.settled();
    };
    return { peer, host, claimant, entryId, logs, run };
}


/**
 * A module that admits every step and applies every tool call: the claimant's
 * own guards are then the only thing between the child and the next step or
 * effect, which is what these tests pin.
 */
function permissive(peer: DreamClaimPeer, options: { leaseLostOnSecondTool?: boolean } = {}): void {
    const original = peer.route.bind(peer);
    let tools = 0;
    peer.route = (session, method, body) => {
        const event = body.event as { kind?: string } | undefined;
        if (method === "dream.child.event" && event?.kind === "step") {
            const entry = peer.entry(String(body.entry_id));
            entry.nextSeq += 1;
            entry.steps += 1;
            return { ok: true };
        }
        if (method === "dream.child.event" && (event as { kind?: string })?.kind === "usage") {
            return original(session, method, body);
        }
        if (method === "dream.child.tool") {
            tools += 1;
            if (options.leaseLostOnSecondTool && tools === 2) return { ok: false, refusal: "LeaseLost" };
            peer.effects.push({ child: "", tool: String(body.tool), args: body.arguments });
            return { ok: true, output: { effect: "applied" }, receipt: null };
        }
        return original(session, method, body);
    };
}

function methods(peer: DreamClaimPeer): string[] {
    return peer.requests.map((request) => String(request.method));
}

function events(peer: DreamClaimPeer): Array<Record<string, unknown>> {
    return peer.requests
        .filter((request) => request.method === "dream.child.event")
        .map((request) => request.event as Record<string, unknown>);
}

describe("dream child claimant", () => {
    it("runs one selected attempt: create, report, wait for start, prompt once, report, clean up", async () => {
        const { peer, host, entryId, run } = setup({
            script: [
                { text: "looking", tools: [{ name: "ctx_memory", args: { action: "list" } }], usage: { input: 10, output: 5, cache_read: 2, cache_write: 1 } },
                { text: "done", usage: { input: 20, output: 7, cache_read: 0, cache_write: 0 } },
            ],
        });
        await run();
        const child = host.runs[0];
        expect(child?.prompts).toBe(1);
        expect(child?.promptedWhileStarted).toEqual([true]);
        expect(child?.providerCalls).toBe(2);
        expect(child?.retired).toBe(true);
        expect(peer.entry(entryId).cleaned).toBe(true);
        expect(peer.entry(entryId).completion).toEqual({ text: "done", length_capped: false });
        expect(methods(peer).slice(0, 4)).toEqual([
            "dream.child.pending",
            "dream.child.claim",
            "dream.child.heartbeat",
            "dream.child.opened",
        ]);
        expect(methods(peer).at(-1)).toBe("dream.child.cleanup");
        expect(peer.requests.at(-1)).toMatchObject({ quiescent: true, retired: true });
        expect(events(peer).map((event) => event.kind)).toEqual([
            "step",
            "receipt",
            "usage",
            "step",
            "usage",
            "message",
            "message",
            "complete",
        ]);
        const usage = events(peer).filter((event) => event.kind === "usage");
        expect(usage.map((event) => event.completed)).toEqual([false, true]);
        expect(dreamChildGate(child?.hostChildId)).toBeUndefined();
    });

    it("forwards task tool arguments as data on the attempt's own credentials", async () => {
        const forged = { action: "list", token: "forged", child_id: "forged", entry_id: "forged" };
        const { peer, host, entryId, run } = setup({
            script: [{ tools: [{ name: "ctx_memory", args: forged }] }, { text: "done" }],
        });
        await run();
        const call = peer.requests.find((request) => request.method === "dream.child.tool");
        const entry = peer.entry(entryId);
        expect(call).toMatchObject({
            entry_id: entryId,
            token: entry.claim?.token,
            child_id: entry.child,
            claimant_epoch: "epoch-test",
            tool: "ctx_memory",
            arguments: forged,
        });
        expect(peer.effects).toEqual([{ child: "host-child-1", tool: "ctx_memory", args: forged }]);
        expect(host.runs[0]?.taskOutputs).toEqual(['{"effect":"applied"}']);
    });

    it("refuses a tool outside the descriptor allowlist at the host's tool hook", async () => {
        const { peer, host, run } = setup({
            script: [
                {
                    tools: [
                        { name: "bash", args: { command: "touch sentinel" } },
                        { name: "ctx_memory", args: { action: "list" } },
                    ],
                },
                { text: "done" },
            ],
        });
        await run();
        const child = host.runs[0];
        expect(child?.nativeEffects).toEqual([]);
        expect(child?.refusals.some((refusal) => refusal.includes("bash refused"))).toBe(true);
        // The permitted control on the same child reached the task route.
        expect(peer.effects.map((effect) => effect.tool)).toEqual(["ctx_memory"]);
        expect(peer.requests.some((request) => request.tool === "bash")).toBe(false);
    });

    it("refuses a native tool the descriptor allows when the host declares no filesystem fence", async () => {
        const { peer, host, run } = setup({
            script: [{ tools: [{ name: "read", args: { filePath: "../outside" } }] }, { text: "done" }],
            descriptor: { allowedTools: ["ctx_memory", "read"] },
            capabilities: { ...CAPABILITIES, tools: ["ctx_memory", "read"] },
        });
        // A module that wrongly admitted the claim without the fence capability:
        // the host's own tool hook must still refuse the native read.
        const original = peer.route.bind(peer);
        peer.route = (session, method, body) =>
            original(
                session,
                method,
                method === "dream.child.claim"
                    ? {
                          ...body,
                          capabilities: {
                              ...(body.capabilities as Record<string, unknown>),
                              filesystem_fence: true,
                          },
                      }
                    : body,
            );
        await run();
        expect(host.runs[0]?.nativeEffects).toEqual([]);
        expect(host.runs[0]?.refusals.some((refusal) => refusal.includes("read refused"))).toBe(true);
    });

    it("stops before step N+1 when the step cap N is reached", async () => {
        const { peer, host, entryId, run } = setup({
            script: [{ text: "1" }, { text: "2" }, { text: "3" }, { text: "4" }],
            descriptor: { maxSteps: 2 },
        });
        await run();
        const child = host.runs[0];
        expect(child?.providerCalls).toBe(2);
        expect(peer.entry(entryId).steps).toBe(2);
        expect(peer.entry(entryId).cleaned).toBe(true);
        expect(child?.retired).toBe(true);
    });

    it("refuses the next step and tool once reported usage exhausts the token budget", async () => {
        const { peer, host, entryId, run } = setup({
            script: [
                { text: "expensive", usage: { input: 90, output: 1000, cache_read: 10, cache_write: 1 } },
                { tools: [{ name: "ctx_memory", args: { action: "list" } }] },
                { text: "never" },
            ],
            descriptor: { tokenBudget: 100 },
        });
        await run();
        const child = host.runs[0];
        expect(child?.providerCalls).toBe(1);
        expect(peer.effects).toEqual([]);
        const usage = events(peer).find((event) => event.kind === "usage");
        expect(usage).toMatchObject({ usage: { input: 90, output: 1000, cache_read: 10, cache_write: 1 } });
        expect(peer.entry(entryId).cleaned).toBe(true);
    });

    it("refuses tools after the module answers finalize", async () => {
        const { peer, host, run } = setup({
            script: [
                { text: "most", usage: { input: 85, output: 1, cache_read: 0, cache_write: 0 } },
                { tools: [{ name: "ctx_memory", args: { action: "list" } }] },
            ],
            descriptor: { tokenBudget: 100 },
        });
        await run();
        // The module refuses any step once finalize fired, so the tool step never runs.
        expect(peer.effects).toEqual([]);
        expect(host.runs[0]?.providerCalls).toBe(1);
    });

    it("stops and cleans up when the task lease is lost mid-run", async () => {
        const { peer, host, entryId, run } = setup({
            script: [
                { tools: [{ name: "ctx_memory", args: { action: "list" } }] },
                { tools: [{ name: "ctx_memory", args: { action: "list" } }] },
                { text: "never" },
            ],
        });
        let calls = 0;
        const original = peer.route.bind(peer);
        peer.route = (session, method, body) => {
            if (method === "dream.child.tool" && ++calls === 2) peer.revokeLease(entryId);
            return original(session, method, body);
        };
        await run();
        const child = host.runs[0];
        expect(peer.effects).toHaveLength(1);
        expect(child?.providerCalls).toBe(2);
        expect(child?.aborted).toBe(true);
        expect(child?.retired).toBe(true);
        expect(peer.entry(entryId).cleaned).toBe(true);
    });

    it("stops a child at its absolute deadline and still acknowledges cleanup", async () => {
        const { peer, host, entryId, run } = setup({
            script: [{ hang: true }],
            descriptor: { deadlineMs: Date.now() + 2_400 },
        });
        await run();
        const child = host.runs[0];
        expect(child?.aborted).toBe(true);
        expect(child?.retired).toBe(true);
        expect(peer.entry(entryId).cleaned).toBe(true);
        expect(peer.entry(entryId).completion).toBeNull();
    });

    it("aborts the child when a heartbeat reports stop", async () => {
        const { peer, host, entryId, run } = setup({
            script: [{ hang: true }],
        });
        const original = peer.route.bind(peer);
        peer.route = (session, method, body) => {
            if (method === "dream.child.heartbeat" && peer.entry(entryId).start)
                peer.close(entryId);
            return original(session, method, body);
        };
        // A short heartbeat interval so the stop arrives quickly.
        peer.heartbeatIntervalMs = 20;
        await run();
        expect(host.runs[0]?.aborted).toBe(true);
        expect(peer.entry(entryId).cleaned).toBe(true);
    }, 15_000);

    it("never prompts a child created after the open was cancelled, and retires it", async () => {
        const { peer, host, entryId, run } = setup({ script: [{ text: "never" }] });
        host.createDelayMs = 30;
        host.onCreateStarted = () => peer.cancelOpen(entryId);
        await run();
        const child = host.runs[0];
        expect(child?.prompts).toBe(0);
        expect(child?.retired).toBe(true);
        const opened = peer.requests.find((request) => request.method === "dream.child.opened");
        expect(opened).toBeDefined();
        expect(methods(peer).at(-1)).toBe("dream.child.cleanup");
        expect(peer.entry(entryId).cleaned).toBe(true);
    });

    it("waits for start before sending the prompt", async () => {
        const { peer, host, entryId, run } = setup({ script: [{ text: "done" }] });
        peer.autoStart = false;
        const original = peer.route.bind(peer);
        let heartbeats = 0;
        peer.route = (session, method, body) => {
            if (method === "dream.child.heartbeat" && peer.entry(entryId).hostChild && ++heartbeats === 4)
                peer.entry(entryId).start = true;
            return original(session, method, body);
        };
        await run();
        expect(host.runs[0]?.promptedWhileStarted).toEqual([true]);
        expect(heartbeats).toBeGreaterThanOrEqual(4);
    });

    it("refuses a model step the module has not started", async () => {
        const { peer, host, entryId, run } = setup({ script: [{ text: "done" }] });
        peer.autoStart = false;
        let probed: string | undefined;
        const original = peer.route.bind(peer);
        peer.route = (session, method, body) => {
            const response = original(session, method, body);
            if (method === "dream.child.opened") {
                void admitDreamChildStep(String(body.host_child_id)).catch((error: unknown) => {
                    probed = String(error);
                });
            }
            return response;
        };
        await run();
        expect(probed).toContain("step_before_start");
        expect(host.runs[0]?.prompts).toBe(0);
        expect(events(peer)).toEqual([]);
        expect(peer.entry(entryId).cleaned).toBe(true);
    });

    it("gives an entry back unavailable, without creating a child, when its agent is not carried", async () => {
        const { peer, host, entryId, run } = setup({
            script: [{ text: "never" }],
            descriptor: { agent: "dreamer-docs" },
        });
        await run();
        expect(host.runs).toHaveLength(0);
        expect(methods(peer)).toEqual([
            "dream.child.pending",
            "dream.child.claim",
            "dream.child.unavailable",
        ]);
        expect(peer.requests.at(-1)).toMatchObject({ quiescent: true, retired: true });
        expect(peer.entry(entryId).cleaned).toBe(true);
    });

    it("is refused a claim, and creates nothing, when its declared capabilities cannot cover the descriptor", async () => {
        const { peer, host, run } = setup({
            script: [{ text: "never" }],
            descriptor: { allowedTools: ["read", "grep", "glob"] },
        });
        await run();
        expect(host.runs).toHaveLength(0);
        expect(methods(peer)).toEqual(["dream.child.pending", "dream.child.claim"]);
    });


    it("refuses a task tool its descriptor does not allow, even one the host carries", async () => {
        const { peer, host, run } = setup({
            script: [{ tools: [{ name: "ctx_memory", args: { action: "archive", ids: [1] } }] }, { text: "done" }],
            descriptor: { allowedTools: [] },
        });
        await run();
        expect(peer.effects).toEqual([]);
        expect(peer.requests.some((request) => request.method === "dream.child.tool")).toBe(false);
        expect(host.runs[0]?.refusals.some((refusal) => refusal.includes("ctx_memory refused"))).toBe(true);
    });

    it("keeps its own step cap against a module that would admit another step", async () => {
        const { peer, host, run } = setup({
            script: [{ text: "1" }, { text: "2" }, { text: "3" }],
            descriptor: { maxSteps: 2 },
        });
        permissive(peer);
        await run();
        expect(host.runs[0]?.providerCalls).toBe(2);
    });

    it("keeps its own budget stop against a module that would admit another step", async () => {
        const { peer, host, run } = setup({
            script: [
                { text: "expensive", usage: { input: 150, output: 0, cache_read: 0, cache_write: 0 } },
                { text: "never" },
            ],
            descriptor: { tokenBudget: 100 },
        });
        permissive(peer);
        await run();
        expect(host.runs[0]?.providerCalls).toBe(1);
    });

    it("keeps tools blocked after finalize against a module that would run them", async () => {
        const { peer, host, run } = setup({
            script: [
                { text: "most", usage: { input: 85, output: 0, cache_read: 0, cache_write: 0 } },
                { tools: [{ name: "ctx_memory", args: { action: "archive", ids: [1] } }] },
                { text: "final answer" },
            ],
            descriptor: { tokenBudget: 100 },
        });
        permissive(peer);
        await run();
        expect(host.runs[0]?.providerCalls).toBe(3);
        expect(peer.effects).toEqual([]);
    });

    it("stops on a terminal tool refusal against a module that would admit more steps", async () => {
        const { peer, host, run } = setup({
            script: [
                { tools: [{ name: "ctx_memory", args: { action: "archive", ids: [1] } }] },
                { tools: [{ name: "ctx_memory", args: { action: "archive", ids: [2] } }] },
                { tools: [{ name: "ctx_memory", args: { action: "archive", ids: [3] } }] },
            ],
        });
        permissive(peer, { leaseLostOnSecondTool: true });
        await run();
        expect(peer.effects).toHaveLength(1);
        expect(host.runs[0]?.providerCalls).toBe(2);
        expect(host.runs[0]?.aborted).toBe(true);
    });

    it("stops at its deadline when the module can no longer be reached", async () => {
        const { peer, host, entryId, claimant } = setup({
            script: [{ hang: true }],
            descriptor: { deadlineMs: Date.now() + 2_500 },
        });
        const original = peer.route.bind(peer);
        peer.route = (session, method, body) => {
            // Once the first step is admitted, the module goes silent: every later
            // heartbeat fails, and the model never answers.
            if (peer.entry(entryId).steps >= 1) throw new Error("connection lost");
            return original(session, method, body);
        };
        const started = Date.now();
        await claimant.pump("parent");
        await claimant.settled();
        expect(host.runs[0]?.aborted).toBe(true);
        expect(host.runs[0]?.retired).toBe(true);
        // Aborted by its own deadline, not by anything the silent module said.
        expect((host.runs[0]?.abortedAt ?? 0) - started).toBeLessThan(4_000);
        expect(peer.entry(entryId).completion).toBeNull();
    }, 20_000);

    it("leaves every other session's steps and tools alone", async () => {
        await admitDreamChildStep("an-ordinary-session");
        expect(dreamChildToolRefusal("an-ordinary-session", "bash")).toBeUndefined();
        expect(dreamChildGate("an-ordinary-session")).toBeUndefined();
    });
});
