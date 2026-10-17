/// <reference types="bun-types" />

/**
 * Real OpenCode 1 host probe for the dream-child claimant.
 *
 * The real Magic Context plugin runs inside a real `opencode serve` (whatever
 * `opencode` is first on PATH; the run prints its version), loaded through
 * `src/dream-claimant-host-plugin.ts`, which adds the production claimant and
 * OpenCode 1 carrier driven by a scripted `dream-claim-v1` peer. The child's
 * model is the local mock provider, scripted per scenario to attempt one
 * forbidden action whose effect would be observable if it were admitted, next
 * to a permitted control on the same child.
 *
 * Opt in with MC_E2E_DREAM_CLAIMANT_OC1=1. Every store lives under a throwaway
 * root (put TMPDIR under `$TMPDIR/magic-context/i5-c2/` to keep it there); the
 * host's open `.db` files are listed with lsof and must all be inside it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DreamProbeResult, DreamProbeScenario } from "../src/dream-claimant-probe";
import { CANONICAL_DREAM_TASKS } from "../../plugin/src/features/magic-context/dreamer/task-registry";
import { TestHarness } from "../src/harness";
import type { MockResponse } from "../src/mock-provider/server";
import { assertIsolatedStores } from "./dreamer-timeout-support";

const ENABLED = process.env.MC_E2E_DREAM_CLAIMANT_OC1 === "1";
const MODEL = { model: "mock-anthropic/mock-sonnet", qualifier: null };
const USAGE = {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
};

let h: TestHarness;
let parent: string;
let port: number;
let root: string;
const scripts = new Map<string, (call: number, body: Record<string, unknown>) => MockResponse>();
const calls = new Map<string, number>();

function toolUse(name: string, input: Record<string, unknown>): Record<string, unknown> {
    return {
        type: "tool_use",
        id: `toolu_${name}_${Math.random().toString(36).slice(2, 10)}`,
        name,
        input,
    };
}

function toolTurn(...uses: Array<Record<string, unknown>>): MockResponse {
    return { content: uses, stop_reason: "tool_use", usage: USAGE };
}

function marker(name: string): string {
    return `DREAM-PROBE-${name}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Provider requests the dream child of scenario `id` made. */
function providerCalls(id: string): number {
    return h.mock.requests().filter((request) => JSON.stringify(request.body).includes(id)).length;
}

async function probe(
    name: string,
    script: (call: number, body: Record<string, unknown>) => MockResponse,
    scenario: Partial<DreamProbeScenario> = {},
): Promise<{ id: string; result: DreamProbeResult }> {
    const id = marker(name);
    scripts.set(id, script);
    const response = await fetch(`http://127.0.0.1:${port}/run`, {
        method: "POST",
        body: JSON.stringify({
            session: parent,
            model: MODEL,
            system: `You are a dream child probe. ${id}`,
            prompt: `Run the probe. ${id}`,
            timeoutMs: 60_000,
            ...scenario,
        } satisfies DreamProbeScenario),
    });
    const result = (await response.json()) as DreamProbeResult & { error?: string };
    if (result.error) throw new Error(result.error);
    console.log(
        `[dream-probe ${name}] provider_calls=${providerCalls(id)} steps=${result.entry.steps} effects=${result.effects.length} cleaned=${result.entry.cleaned} completion=${JSON.stringify(result.entry.completion)} methods=${result.requests.map((r) => String(r.method).replace("dream.child.", "")).join(",")}`,
    );
    for (const line of result.logs) console.log(`[dream-probe ${name}] log: ${line}`);
    return { id, result };
}

async function sessionGone(id: string | null): Promise<boolean> {
    if (!id) return false;
    const response = await fetch(`${h.serverUrl}/session/${id}`);
    return response.status === 404;
}

function events(result: DreamProbeResult, kind: string): Array<Record<string, unknown>> {
    return result.requests
        .filter((r) => r.method === "dream.child.event")
        .map((r) => r.event as Record<string, unknown>)
        .filter((event) => event.kind === kind);
}

describe.skipIf(!ENABLED)("OpenCode 1 dream child claimant at the host boundary", () => {
    beforeAll(async () => {
        root = join(tmpdir(), `dream-claimant-oc1-${process.pid}`);
        mkdirSync(root, { recursive: true });
        const controlFile = join(root, "control.json");
        process.env.MC_E2E_PLUGIN_ENTRY = resolve(import.meta.dir, "../src/dream-claimant-host-plugin.ts");
        process.env.MC_E2E_DREAM_CONTROL_FILE = controlFile;
        const version = spawnSync("opencode", ["--version"], { encoding: "utf8" });
        console.log(`[dream-probe] opencode --version: ${version.stdout.trim()}`);
        h = await TestHarness.create({
            // The dreamer's hidden agents are registered only while the dreamer is
            // on; with every task unscheduled the TypeScript dreamer runs nothing.
            magicContextConfig: {
                embedding: { provider: "off" },
                dreamer: {
                    disable: false,
                    tasks: Object.fromEntries(CANONICAL_DREAM_TASKS.map((task) => [task, { schedule: "" }])),
                },
            },
            // Foreground permissions as broad as a user can make them: the dream
            // child's limits must hold regardless.
            openCodeConfigExtra: { permission: { bash: "allow", edit: "allow", read: "allow" } },
        });
        h.mock.addMatcher((body) => {
            const payload = JSON.stringify(body);
            for (const [id, script] of scripts) {
                if (!payload.includes(id)) continue;
                const call = (calls.get(id) ?? 0) + 1;
                calls.set(id, call);
                return script(call, body);
            }
            return null;
        });
        parent = await h.createSession();
        await h.sendPrompt(parent, "bootstrap the dream claimant probe");
        await h.waitFor(() => existsSync(controlFile), { timeoutMs: 30_000 });
        port = (JSON.parse(readFileSync(controlFile, "utf8")) as { port: number }).port;
        assertIsolatedStores(h);
    });

    afterAll(async () => {
        if (h) {
            if (process.env.MC_E2E_DREAM_CLAIMANT_DEBUG === "1") {
                const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
                const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
                for (const line of lines.filter((l) => /agent|config hook|dream/i.test(l)).slice(0, 40))
                    console.log(`[plugin-log] ${line.slice(0, 300)}`);
            }
            assertIsolatedStores(h);
            await h.dispose?.();
        }
    });

    test("permitted control: a task tool reaches the task route and the child completes and is retired", async () => {
        const { result } = await probe("permitted", (call) =>
            call === 1
                ? toolTurn(toolUse("ctx_memory", { action: "get", ids: [1] }))
                : { text: "probe complete", usage: USAGE },
        );
        expect(result.effects.map((effect) => effect.tool)).toEqual(["ctx_memory"]);
        expect(result.entry.completion?.text).toBe("probe complete");
        expect(result.entry.steps).toBe(2);
        expect(result.entry.cleaned).toBe(true);
        expect(events(result, "receipt")).toHaveLength(1);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("forbidden tools: shell, file writes and subagents never execute, the permitted call beside them does", async () => {
        const sentinel = join(realpathSync(h.workdir), "dream-probe-bash-sentinel");
        const written = join(realpathSync(h.workdir), "dream-probe-write-sentinel");
        const escape = marker("subagent-escape");
        const { id, result } = await probe("forbidden", (call) =>
            call === 1
                ? toolTurn(
                      toolUse("bash", { command: `touch ${sentinel}`, description: "touch" }),
                      toolUse("write", { filePath: written, content: "escaped" }),
                      // The host offers `task` to every agent; run, it would start a
                      // subagent outside the dream child's limits.
                      toolUse("task", {
                          description: "escape",
                          prompt: `Run outside the dream child. ${escape}`,
                          subagent_type: "general",
                      }),
                      toolUse("ctx_memory", { action: "get", ids: [1] }),
                  )
                : { text: "forbidden probe done", usage: USAGE },
        );
        // What the host told the model about each refused call.
        const followUp = h.mock
            .requests()
            .filter((request) => JSON.stringify(request.body).includes(id))
            .at(-1);
        const results = JSON.stringify(followUp?.body ?? {}).match(/tool_result[^}]*/g) ?? [];
        for (const line of results) console.log(`[dream-probe forbidden] ${line.slice(0, 300)}`);
        expect(existsSync(sentinel)).toBe(false);
        expect(existsSync(written)).toBe(false);
        // No subagent ever reached the provider: the only requests naming the
        // escape are the dream child's own, which carry its tool call.
        const subagentCalls = h.mock.requests().filter((request) => {
            const body = JSON.stringify(request.body);
            return body.includes(escape) && !body.includes(id);
        });
        expect(subagentCalls).toHaveLength(0);
        expect(results.some((line) => line.includes("task refused"))).toBe(true);
        expect(result.effects.map((effect) => effect.tool)).toEqual(["ctx_memory"]);
        expect(result.requests.some((r) => r.method === "dream.child.tool" && r.tool !== "ctx_memory")).toBe(false);
        expect(result.entry.cleaned).toBe(true);
    }, 120_000);

    test("step overflow: step N+1 never reaches the provider after cap N", async () => {
        const { id, result } = await probe(
            "steps",
            () => toolTurn(toolUse("ctx_memory", { action: "get", ids: [1] })),
            { maxSteps: 2 },
        );
        expect(providerCalls(id)).toBe(2);
        expect(result.entry.steps).toBe(2);
        expect(events(result, "step")).toHaveLength(2);
        expect(result.entry.cleaned).toBe(true);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("token overflow: once reported usage exhausts the budget, no further step or tool runs", async () => {
        const { id, result } = await probe(
            "tokens",
            () => ({
                ...toolTurn(toolUse("ctx_memory", { action: "get", ids: [1] })),
                usage: { ...USAGE, input_tokens: 150, output_tokens: 4_000 },
            }),
            { tokenBudget: 100 },
        );
        expect(providerCalls(id)).toBe(1);
        const usage = events(result, "usage");
        expect(usage.length).toBeGreaterThanOrEqual(1);
        expect((usage[0]?.usage as { input: number }).input).toBeGreaterThanOrEqual(150);
        // The one call already in flight on the overflowing step may apply; none after it.
        expect(result.effects.length).toBeLessThanOrEqual(1);
        expect(result.entry.cleaned).toBe(true);
    }, 120_000);

    test("lease loss: after the task lease is revoked no step or effect follows", async () => {
        const { id, result } = await probe(
            "lease",
            () => toolTurn(toolUse("ctx_memory", { action: "get", ids: [1] })),
            { revokeLeaseAfterEffects: 1, maxSteps: 10 },
        );
        expect(result.effects).toHaveLength(1);
        expect(providerCalls(id)).toBe(1);
        expect(result.entry.completion).toBeNull();
        expect(result.entry.cleaned).toBe(true);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("deadline expiry: a child whose model never answers is aborted at its absolute deadline", async () => {
        const started = Date.now();
        const { result } = await probe(
            "deadline",
            () => ({ text: "too late", usage: USAGE, streamHoldMs: 45_000 }),
            { timeoutMs: 6_000 },
        );
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(result.entry.completion).toBeNull();
        expect(result.entry.cleaned).toBe(true);
        expect(result.effects).toHaveLength(0);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("cancel during open: the late child is reported, never prompted, and retired", async () => {
        const { id, result } = await probe("cancel", () => ({ text: "never", usage: USAGE }), {
            cancelOpen: true,
        });
        expect(providerCalls(id)).toBe(0);
        expect(result.requests.some((r) => r.method === "dream.child.opened")).toBe(true);
        expect(result.entry.start).toBe(false);
        expect(result.entry.cleaned).toBe(true);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("no filesystem fence on this host: a descriptor needing native reads is refused before any child exists", async () => {
        const { id, result } = await probe("path", () => ({ text: "never", usage: USAGE }), {
            agent: "dreamer-memory-mapper",
            allowedTools: ["read", "grep", "glob"],
        });
        expect(result.requests.map((r) => r.method)).toEqual([
            "dream.child.pending",
            "dream.child.claim",
        ]);
        expect(result.entry.cleaned).toBe(true);
        expect(providerCalls(id)).toBe(0);
    }, 120_000);
});
