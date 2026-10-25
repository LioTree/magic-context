import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { Database } from "../../src/shared/sqlite";
import { attestHost } from "../two-pass-live-replay/host-drivers";
import { assertObservedPluginStore, processActivationTransport, type ActivationHost, type ActivationTransport } from "./activation-driver";
import { mockMeteringProxy } from "./provider-meter";

export type HostLane = "opencode-1" | "opencode-2" | "omp";
export interface HostAdapterOptions {
    sourceRoot: string;
    mockProviderURL: string;
    modelId: string;
    magicContext: Record<string, unknown>;
    outputCeiling: number;
    timeoutMs?: number;
    startupTimeoutMs?: number;
    expectTurnTwo?: boolean;
}

/** Install pinned hosts under the isolated root; never use a host already installed on the machine. */
export function hostAdapter(lane: HostLane, options: HostAdapterOptions): ActivationTransport {
    const installer = join(import.meta.dir, "install-host.ts");
    let proxy: Awaited<ReturnType<typeof mockMeteringProxy>> | undefined;
    let hostEnv: Record<string, string>;
    let work: string;
    let version = "";
    const binary = (root: string) => join(root, "host-dist/node_modules/.bin", lane === "omp" ? "omp" : "opencode");
    const entrypoint = (root: string) => join(root, lane === "omp" ? "packages/pi-plugin/dist/index.js" : lane === "opencode-2" ? "packages/plugin/dist/v2/server.js" : "packages/plugin/dist/index.js");
    return processActivationTransport({
        stage: (root) => ({ argv: [process.execPath, installer, "stage", options.sourceRoot, root, lane], cwd: root }),
        build: (root) => ({ argv: [process.execPath, installer, "build", options.sourceRoot, root, lane], cwd: root }),
        entrypoint,
        async launch(input) {
            if (process.platform === "darwin") throw new Error("mac_native_host_not_authorized");
            const root = resolve(input.env.OPENCODE_DB, "../..");
            work = join(root, "work");
            for (const path of [work, ...["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "MAGIC_CONTEXT_STORAGE_DIR"].map((key) => input.env[key]), join(root, "host"), join(root, "tmp")])
                mkdirSync(path, { recursive: true });
            Object.assign(input.env, {
                HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CACHE_HOME: join(root, "cache"),
                OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
                OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_CONFIG_DIR: input.env.XDG_CONFIG_HOME,
                MAGIC_CONTEXT_LOG_PATH: join(root, "magic-context.log"), MAGIC_CONTEXT_LOG_SYNC: "1",
                PI_CODING_AGENT_DIR: join(root, "omp-agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
            });
            hostEnv = input.env;
            const result = spawnSync(binary(input.installRoot), ["--version"], { cwd: work, env: { PATH: process.env.PATH, ...hostEnv }, encoding: "utf8" });
            version = result.stdout.trim();
            if (result.status !== 0 || (lane === "opencode-1" ? !/^1\.18\.(3[1-9]|[4-9]\d|\d{3,})$/.test(version) : lane === "opencode-2" ? version !== "2.0.22" : !/18\.12\.\d+/.test(version)))
                throw new Error("host_version_not_pinned");
            proxy = await mockMeteringProxy({ upstream: options.mockProviderURL, meter: input.meter,
                outputCeiling: options.outputCeiling,
                // All attempts are independently reserved; a retry is another HTTP request.
                classify: (_path, body) => /turn.?two|memory_decisions/i.test(body) ? "turn_two" : /memoryCheck|memory.check/i.test(body) ? "check" : "turn_one",
            });
            writeConfigs(lane, input.installRoot, work, hostEnv, proxy.url, options);
            return { argv: lane === "omp" ? [binary(input.installRoot), "--mode", "rpc", "--extension", entrypoint(input.installRoot)]
                : [binary(input.installRoot), "serve", "--hostname", "127.0.0.1", "--port", "0", ...(lane === "opencode-2" ? ["--standalone"] : ["--print-logs"])], cwd: work };
        },
        async connect(input) {
            const root = resolve(input.env.OPENCODE_DB, "../..");
            for (const stream of [input.stdout, input.stderr]) stream.on("data", (chunk) => appendFileSync(join(root, "mock-host.log"), chunk));
            const storePath = join(hostEnv.MAGIC_CONTEXT_STORAGE_DIR, "context.db");
            const events: unknown[] = [];
            let observedCarrier: ActivationHost["carrier"] = "unobservable";
            let observedStore: string | null = null;
            let sessionId = "";
            let prompt: (text: string) => Promise<unknown>;
            if (lane === "omp") {
                const lines = createInterface({ input: input.stdout });
                const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
                const settled: Array<() => void> = [];
                lines.on("line", (line) => {
                    try {
                        const value = JSON.parse(line);
                        events.push(value);
                        if (value.type === "agent_settled" || value.type === "agent_end") settled.splice(0).forEach((done) => done());
                        if (value.id && pending.has(value.id)) {
                            const call = pending.get(value.id)!; pending.delete(value.id);
                            if (value.success === false) call.reject(new Error("omp_rpc_failed")); else call.resolve(value);
                        }
                    } catch { /* Non-JSON stdout is not a session response. */ }
                });
                input.stderr.resume();
                let sequence = 0;
                const rpc = (type: string, fields: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
                    const id = `activation-${++sequence}`;
                    pending.set(id, { resolve, reject });
                    input.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
                    setTimeout(() => { if (pending.delete(id)) reject(new Error("omp_rpc_timeout")); }, options.timeoutMs ?? 120_000).unref();
                });
                const state = await rpc("get_state");
                sessionId = state.data?.sessionId ?? state.data?.session_id ?? "";
                prompt = async (message) => {
                    const end = new Promise<void>((resolve) => settled.push(resolve));
                    await rpc("prompt", { message });
                    await deadline(end, options.timeoutMs ?? 120_000);
                    const secondEnd = new Promise<void>((resolve) => settled.push(resolve));
                    await rpc("prompt", { message: "Confirm the corrected project setting." });
                    await deadline(secondEnd, options.timeoutMs ?? 120_000);
                    await rpc("prompt", { message: "/ctx-wrapup 1" });
                    return rpc("get_messages");
                };
            } else {
                let handoff = "";
                const endpoint = new Promise<{ url: string; password?: string }>((resolve) => {
                    const consume = (chunk: Buffer) => {
                        handoff += chunk.toString();
                        const url = handoff.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
                        const password = handoff.match(/password[\s:=]+([^\s"',]+)/i)?.[1];
                        if (url && (lane === "opencode-1" || password)) resolve({ url, password });
                    };
                    input.stdout.on("data", consume); input.stderr.on("data", consume);
                });
                const host = await deadline(endpoint, 60_000);
                const api = async (path: string, body?: unknown, timeout = options.timeoutMs ?? 120_000) => {
                    const url = new URL(`${host.url}${lane === "opencode-2" ? "/api" : ""}${path}`);
                    url.searchParams.set("directory", work);
                    const reply = await fetch(url, { method: body === undefined ? "GET" : "POST",
                        headers: { "content-type": "application/json", ...(host.password ? { authorization: `Basic ${Buffer.from(`opencode:${host.password}`).toString("base64")}` } : {}) },
                        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
                    if (!reply.ok) throw new Error("host_session_rpc_failed");
                    return reply.status === 204 ? null : reply.json();
                };
                await api("/session", undefined, options.startupTimeoutMs ?? 300_000);
                const session = await api("/session", {}) as { id?: string };
                sessionId = session.id ?? "";
                if (!sessionId) throw new Error("session_id_unobservable");
                prompt = async (text) => {
                    const route = `/session/${sessionId}/${lane === "opencode-2" ? "prompt" : "message"}`;
                    const result = await api(route, {
                        model: { providerID: "mock", modelID: options.modelId }, parts: [{ type: "text", text }],
                    });
                    if (lane === "opencode-2") await api(`/experimental/session/${sessionId}/wait`, {});
                    await api(route, { model: { providerID: "mock", modelID: options.modelId }, parts: [{ type: "text", text: "Confirm the corrected project setting." }] });
                    if (lane === "opencode-2") await api(`/experimental/session/${sessionId}/wait`, {});
                    await api(`/session/${sessionId}/command`, lane === "opencode-2" ? { name: "ctx-wrapup", text: "1" } : { command: "ctx-wrapup", arguments: "1", agent: "build", model: `mock/${options.modelId}`, parts: [] });
                    return result;
                };
            }
            return {
                lane, get carrier() { return observedCarrier; }, get storePath() { return observedStore; },
                async runSession(text) {
                    const before = existsSync(storePath) ? stageRows(storePath).map((row) => row.stage_key) : [];
                    const requestStart = proxy!.receipts.length;
                    const foreground = await prompt(text);
                    let stages: any[] = [];
                    await waitFor(() => {
                        stages = stageRows(storePath).filter((row) => !before.includes(row.stage_key));
                        const first = stages.filter((row) => row.stage === "turn_one");
                        const second = stages.filter((row) => row.stage === "turn_two");
                        return first.some((row) => row.state === "published") &&
                            (options.expectTurnTwo === false || second.some((row) => row.state === "resolved")) &&
                            stages.every((row) => !["dispatched", "reserved", "sending", "replied"].includes(row.state));
                    }, options.timeoutMs ?? 120_000);
                    const carriers = [...new Set(stages.filter((row) => row.stage === "turn_one" || row.stage === "turn_two").map((row) => row.carrier))];
                    if (carriers.length !== 1 || !["hidden-completion", "opencode-session", "pi-historian-rpc"].includes(carriers[0]) ||
                        (lane === "opencode-2" && carriers[0] !== "hidden-completion") || (lane === "omp" && carriers[0] !== "pi-historian-rpc"))
                        throw new Error("carrier_unobservable_or_mismatched");
                    observedCarrier = carriers[0];
                    const firstChild = stages.find((row) => row.stage === "turn_one")?.child_session_id;
                    if (options.expectTurnTwo !== false && (!firstChild || stages.some((row) => row.stage === "turn_two" && row.child_session_id !== firstChild)))
                        throw new Error("historian_child_not_retained");
                    const after = await attestHost(root, hostEnv, input.pid);
                    observedStore = assertObservedPluginStore(after, storePath);
                    const requests = proxy!.receipts.slice(requestStart);
                    if (!requests.length || proxy!.failures.length) throw new Error("mock_did_not_capture_all_dispatches");
                    return { version, sessionId, foreground, carrier: observedCarrier, historian: { stages, completedStages: true,
                        schedulerIdle: { status: "unobservable", reason: "The plugin does not export its deferred-task queue. Published/resolved rows prove only the observed lifecycle stages completed." } },
                        requests, events, isolation: after,
                        cacheRebuild: { status: "unobservable", reason: "The host event protocols do not expose a dedicated Magic Context cache-rebuild receipt; no absence claim is made." },
                    };
                },
            };
        },
        async stopped() { if (proxy) { await proxy.close(); proxy = undefined; } },
    });
}

export const openCode1Adapter = (options: HostAdapterOptions) => hostAdapter("opencode-1", options);
export const openCode2Adapter = (options: HostAdapterOptions) => hostAdapter("opencode-2", options);
export const ohMyPiAdapter = (options: HostAdapterOptions) => hostAdapter("omp", options);

function stageRows(path: string): any[] {
    const db = new Database(path, { readonly: true });
    try { return db.prepare("SELECT * FROM memory_stage_attempts ORDER BY started_at,stage_key").all(); }
    finally { db.close(); }
}
async function waitFor(predicate: () => boolean, timeout: number) {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= end) throw new Error("historian_or_host_settlement_timeout");
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
async function deadline<T>(promise: Promise<T>, timeout: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("host_rpc_timeout")), timeout); })]); }
    finally { clearTimeout(timer!); }
}

function writeConfigs(lane: HostLane, install: string, work: string, env: Record<string, string>, endpoint: string, options: HostAdapterOptions) {
    const model = `mock/${options.modelId}`;
    const plugin = lane === "opencode-2" ? join(install, "packages/plugin") : pathToFileURL(join(install, "packages/plugin/dist/index.js")).href;
    const limits = { context: 200_000, output: options.outputCeiling };
    const config = lane === "opencode-2" ? { plugins: [plugin], model,
        providers: { mock: { package: "@ai-sdk/openai-compatible", settings: { baseURL: `${endpoint}/v1`, apiKey: "mock-only-key" }, models: { [options.modelId]: { name: options.modelId, limit: limits } } } },
        compaction: { auto: false },
    } : { plugin: [plugin], model, small_model: model, enabled_providers: ["mock"], autoupdate: false,
        provider: { mock: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${endpoint}/v1`, apiKey: "mock-only-key" }, models: { [options.modelId]: { name: options.modelId, limit: limits } } } },
        compaction: { auto: false, prune: false }, agent: { title: { disable: true }, summary: { disable: true } },
    };
    if (lane === "omp") {
        mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
        writeFileSync(join(env.PI_CODING_AGENT_DIR, "config.yml"), JSON.stringify({ defaultProvider: "mock", defaultModel: options.modelId,
            enabledModels: [model], retry: { enabled: false }, compaction: { enabled: false }, enableInstallTelemetry: false, tools: { xdev: false, intentTracing: false } }));
        writeFileSync(join(env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { mock: { api: "anthropic-messages", baseUrl: endpoint, apiKey: "mock-only-key",
            models: [{ id: options.modelId, name: options.modelId, input: ["text"], contextWindow: 200_000, maxTokens: options.outputCeiling, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    } else if (lane === "opencode-2") writeFileSync(join(work, "opencode.json"), JSON.stringify(config));
    else {
        if (existsSync(join(work, "opencode.json"))) unlinkSync(join(work, "opencode.json"));
        writeFileSync(join(env.XDG_CONFIG_HOME, "opencode.json"), JSON.stringify(config));
    }
    const settings = { enabled: true, memory: { enabled: true, auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
        embedding: { provider: "off" }, dreamer: { disable: true }, historian: { [lane === "opencode-1" ? "opencode" : lane === "opencode-2" ? "opencode2" : "omp"]: { model } }, ...options.magicContext };
    mkdirSync(join(env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME, "cortexkit/magic-context.jsonc"), JSON.stringify(settings));
}
