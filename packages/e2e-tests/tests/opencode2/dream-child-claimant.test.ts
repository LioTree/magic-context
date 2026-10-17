/// <reference types="bun-types" />

/**
 * Real OpenCode 2 host probe for the dream-child claimant.
 *
 * The real Magic Context plugin (the built `packages/plugin`) runs inside the
 * pinned OpenCode 2 CLI. `dream-claimant-probe-plugin.ts`, loaded after it,
 * runs the production claimant on the carrier the real instance publishes, so
 * every step, tool and `ctx_memory` call of the child goes through the real
 * instance's hooks. The child's model is the local mock provider, scripted per
 * scenario to attempt one forbidden action next to a permitted control.
 *
 * Opt in with MC_E2E_DREAM_CLAIMANT_OC2=1. Process inspection (lsof over the
 * host's open files) runs where the host runs; run it on the Linux build server.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import type { DreamProbeResult, DreamProbeScenario } from "../../src/dream-claimant-probe";
import type { MockResponse } from "../../src/mock-provider/server";
import { assertOpenPaths, readPluginLog, spawnOpencode2 } from "../../src/opencode2-runner/spawn";

const ENABLED = process.env.MC_E2E_DREAM_CLAIMANT_OC2 === "1";
const MODEL = { model: "openai/mock-model", qualifier: null };
const USAGE = { input_tokens: 10, output_tokens: 5 };

let host: Awaited<ReturnType<typeof spawnOpencode2>>;
let client: ReturnType<typeof OpenCode.make>;
let parent: string;
let bundle: string;
let previousTmp: string | undefined;
let seq = 0;
const scripts = new Map<string, (call: number) => MockResponse>();
const calls = new Map<string, number>();

function functionCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const id = Math.random().toString(36).slice(2, 10);
    return { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) };
}

function toolTurn(...items: Array<Record<string, unknown>>): MockResponse {
    return { openaiOutput: items, usage: USAGE as never };
}

function marker(name: string): string {
    return `DREAM-PROBE-${name}-${Math.random().toString(36).slice(2, 8)}`;
}

function providerCalls(id: string): number {
    return host.mock.requests().filter((request) => JSON.stringify(request.body).includes(id)).length;
}

function lsofDatabases(): string[] {
    const open = execFileSync("lsof", ["-p", String(host.pid), "-Fn"], { encoding: "utf8" });
    return open
        .split("\n")
        .filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line))
        .map((line) => line.slice(1));
}

function assertIsolation(): void {
    const dbPaths = lsofDatabases();
    console.log(`[isolation] OpenCode 2 host pid ${host.pid} db files: ${[...new Set(dbPaths)].join(", ")}`);
    expect(dbPaths.length).toBeGreaterThan(0);
    expect(dbPaths.every((path) => path.startsWith(host.root))).toBe(true);
    assertOpenPaths(dbPaths, host.root);
}

async function waitFile(path: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
        await Bun.sleep(30);
    }
}

async function probe(
    name: string,
    script: (call: number) => MockResponse,
    scenario: Partial<DreamProbeScenario> = {},
): Promise<{ id: string; result: DreamProbeResult }> {
    const id = marker(name);
    scripts.set(id, script);
    seq += 1;
    const resultPath = join(host.cwd, `dream-probe-result-${seq}.json`);
    writeFileSync(
        join(host.cwd, `dream-probe-command-${seq}.json`),
        JSON.stringify({
            session: parent,
            model: MODEL,
            system: `You are a dream child probe. ${id}`,
            prompt: `Run the probe. ${id}`,
            timeoutMs: 60_000,
            ...scenario,
        } satisfies DreamProbeScenario),
    );
    await waitFile(resultPath);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as DreamProbeResult & { error?: string };
    if (result.error) throw new Error(result.error);
    console.log(
        `[dream-probe-oc2 ${name}] provider_calls=${providerCalls(id)} steps=${result.entry.steps} effects=${result.effects.length} cleaned=${result.entry.cleaned} completion=${JSON.stringify(result.entry.completion)} methods=${result.requests.map((r) => String(r.method).replace("dream.child.", "")).join(",")}`,
    );
    for (const line of result.logs) console.log(`[dream-probe-oc2 ${name}] log: ${line}`);
    if (process.env.MC_E2E_DREAM_CLAIMANT_DEBUG === "1") {
        const last = host.mock
            .requests()
            .filter((request) => JSON.stringify(request.body).includes(id))
            .at(-1);
        const outputs = JSON.stringify(last?.body ?? {}).match(/function_call_output[^}]*/g) ?? [];
        for (const line of outputs) console.log(`[dream-probe-oc2 ${name}] tool: ${line.slice(0, 300)}`);
        const tools = (last?.body as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [];
        console.log(`[dream-probe-oc2 ${name}] offered tools: ${tools.map((t) => t.name).join(",")}`);
    }
    return { id, result };
}

async function sessionGone(id: string | null): Promise<boolean> {
    if (!id) return false;
    try {
        await client.session.get({ sessionID: id } as never);
        return false;
    } catch {
        return true;
    }
}

function events(result: DreamProbeResult, kind: string): Array<Record<string, unknown>> {
    return result.requests
        .filter((r) => r.method === "dream.child.event")
        .map((r) => r.event as Record<string, unknown>)
        .filter((event) => event.kind === kind);
}

describe.skipIf(!ENABLED)("OpenCode 2 dream child claimant at the host boundary", () => {
    beforeAll(async () => {
        const root = join(tmpdir(), "magic-context", "i5-c2");
        mkdirSync(root, { recursive: true });
        previousTmp = process.env.TMPDIR;
        process.env.TMPDIR = realpathSync(root);
        bundle = mkdtempSync(join(realpathSync(root), "dream-probe-"));
        const build = await Bun.build({
            entrypoints: [join(import.meta.dir, "dream-claimant-probe-plugin.ts")],
            outdir: bundle,
            naming: "index.js",
            target: "node",
            format: "esm",
            define: { "process.env.NODE_ENV": '"production"' },
            external: ["bun:sqlite", "node:sqlite"],
        });
        if (!build.success) throw new Error(build.logs.join("\n"));
        host = await spawnOpencode2({
            probePlugin: bundle,
            magicContextConfig: {},
            // Foreground permissions as broad as a user can make them.
            extraConfig: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
        });
        client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        host.mock.addMatcher((body) => {
            const payload = JSON.stringify(body);
            for (const [id, script] of scripts) {
                if (!payload.includes(id)) continue;
                const call = (calls.get(id) ?? 0) + 1;
                calls.set(id, call);
                return script(call);
            }
            return null;
        });
        const created = await client.session.create({
            title: "dream probe parent",
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" },
        } as never);
        parent = (created as { id: string }).id;
        // Magic Context opens its store on the first session turn, and only then
        // builds the hidden-child executor the probe's dream children run on.
        await client.session.prompt({ sessionID: parent, text: "bootstrap the dream probe" } as never);
        await client.session.wait({ sessionID: parent } as never, { signal: AbortSignal.timeout(60_000) } as never);
        await waitFile(join(host.cwd, "dream-probe-ready"));
        assertIsolation();
    }, 240_000);

    afterAll(async () => {
        if (host) {
            if (process.env.MC_E2E_DREAM_CLAIMANT_DEBUG === "1") {
                const lines = readPluginLog(host.env).split("\n");
                for (const line of lines.filter((l) => /hidden child|dream|refus|ctx_memory|remove/i.test(l)).slice(-60))
                    console.log(`[plugin-log] ${line.slice(0, 400)}`);
            }
            try {
                assertIsolation();
            } finally {
                await host.stop();
            }
        }
        if (bundle) rmSync(bundle, { recursive: true, force: true });
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
    });

    test("permitted control: a task tool reaches the task route and the child completes and is retired", async () => {
        const { result } = await probe("permitted", (call) =>
            call === 1 ? toolTurn(functionCall("ctx_memory", { action: "get", ids: [1] })) : { text: "probe complete", usage: USAGE as never },
        );
        expect(result.effects.map((effect) => effect.tool)).toEqual(["ctx_memory"]);
        expect(result.entry.completion?.text).toBe("probe complete");
        expect(result.entry.steps).toBe(2);
        expect(result.entry.cleaned).toBe(true);
        expect(events(result, "receipt")).toHaveLength(1);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("forbidden tools: shell, file writes and subagents never execute, the permitted call beside them does", async () => {
        const sentinel = join(realpathSync(host.cwd), "dream-probe-bash-sentinel");
        const written = join(realpathSync(host.cwd), "dream-probe-write-sentinel");
        const escapeMarker = marker("subagent-escape");
        const { id, result } = await probe("forbidden", (call) =>
            call === 1
                ? toolTurn(
                      functionCall("bash", { command: `touch ${sentinel}`, description: "touch" }),
                      functionCall("write", { filePath: written, content: "escaped" }),
                      functionCall("task", { description: "escape", prompt: `Run outside. ${escapeMarker}`, subagent_type: "general" }),
                      functionCall("ctx_memory", { action: "get", ids: [1] }),
                  )
                : { text: "forbidden probe done", usage: USAGE as never },
        );
        expect(existsSync(sentinel)).toBe(false);
        expect(existsSync(written)).toBe(false);
        const subagentCalls = host.mock.requests().filter((request) => {
            const body = JSON.stringify(request.body);
            return body.includes(escapeMarker) && !body.includes(id);
        });
        expect(subagentCalls).toHaveLength(0);
        expect(result.effects.map((effect) => effect.tool)).toEqual(["ctx_memory"]);
        expect(result.entry.cleaned).toBe(true);
    }, 120_000);

    test("step overflow: step N+1 never reaches the provider after cap N", async () => {
        const { id, result } = await probe("steps", () => toolTurn(functionCall("ctx_memory", { action: "get", ids: [1] })), {
            maxSteps: 2,
        });
        expect(providerCalls(id)).toBe(2);
        expect(result.entry.steps).toBe(2);
        expect(events(result, "step")).toHaveLength(2);
        expect(result.entry.cleaned).toBe(true);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("token overflow: once reported usage exhausts the budget, no further step or tool runs", async () => {
        const { id, result } = await probe(
            "tokens",
            () => ({ ...toolTurn(functionCall("ctx_memory", { action: "get", ids: [1] })), usage: { input_tokens: 150, output_tokens: 4_000 } as never }),
            { tokenBudget: 100 },
        );
        expect(providerCalls(id)).toBe(1);
        const usage = events(result, "usage");
        expect(usage.length).toBeGreaterThanOrEqual(1);
        expect((usage[0]?.usage as { input: number }).input).toBeGreaterThanOrEqual(150);
        expect(result.effects.length).toBeLessThanOrEqual(1);
        expect(result.entry.cleaned).toBe(true);
    }, 120_000);

    test("lease loss: after the task lease is revoked no step or effect follows", async () => {
        const { id, result } = await probe("lease", () => toolTurn(functionCall("ctx_memory", { action: "get", ids: [1] })), {
            revokeLeaseAfterEffects: 1,
            maxSteps: 10,
        });
        expect(result.effects).toHaveLength(1);
        expect(providerCalls(id)).toBe(1);
        expect(result.entry.completion).toBeNull();
        expect(result.entry.cleaned).toBe(true);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("deadline expiry: a child whose model never answers is aborted at its absolute deadline", async () => {
        const started = Date.now();
        const { result } = await probe("deadline", () => ({ text: "too late", usage: USAGE as never, delayMs: 45_000 }), {
            timeoutMs: 6_000,
        });
        expect(Date.now() - started).toBeLessThan(40_000);
        expect(result.entry.completion).toBeNull();
        expect(result.entry.cleaned).toBe(true);
        expect(result.effects).toHaveLength(0);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("cancel during open: the late child is reported, never prompted, and retired", async () => {
        const { id, result } = await probe("cancel", () => ({ text: "never", usage: USAGE as never }), { cancelOpen: true });
        expect(providerCalls(id)).toBe(0);
        expect(result.requests.some((r) => r.method === "dream.child.opened")).toBe(true);
        expect(result.entry.start).toBe(false);
        expect(result.entry.cleaned).toBe(true);
        expect(await sessionGone(result.entry.hostChild)).toBe(true);
    }, 120_000);

    test("no filesystem fence on this host: a descriptor needing native reads is refused before any child exists", async () => {
        const { id, result } = await probe("path", () => ({ text: "never", usage: USAGE as never }), {
            agent: "dreamer-memory-mapper",
            allowedTools: ["read", "grep", "glob"],
        });
        expect(result.requests.map((r) => r.method)).toEqual(["dream.child.pending", "dream.child.claim"]);
        expect(result.entry.cleaned).toBe(true);
        expect(providerCalls(id)).toBe(0);
    }, 120_000);

    test("missing model: this host resolves the creating session's own model rather than refusing", async () => {
        const { id, result } = await probe("default-model", () => ({ text: "default model done", usage: USAGE as never }), {
            model: null,
        });
        expect(providerCalls(id)).toBe(1);
        expect(result.entry.completion?.text).toBe("default model done");
        expect(result.entry.cleaned).toBe(true);
    }, 120_000);
});
