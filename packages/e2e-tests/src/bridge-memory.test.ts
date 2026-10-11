import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { computeNormalizedHash } from "../../plugin/src/features/magic-context/memory/normalize-hash";
import { openBridgeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { createBridgeAdapter, type BridgeView } from "../../plugin/src/host-runner";
import { setRawMessageProvider } from "../../plugin/src/hooks/magic-context/read-session-chunk";
import type { MessageLike } from "../../plugin/src/hooks/magic-context/transform-operations";
import { MockProvider } from "./mock-provider/server";
import { HermeticSubcStack } from "./rust-runner/hermetic-subc";

const enabled = process.env.MC_BRIDGE_MEMORY_E2E === "1";
const memory = "BRIDGE_MEMORY_PROOF: the durable architecture uses one context database.";

function user(id: string): MessageLike {
    return {
        info: { id, role: "user", model: { providerID: "openai", modelID: "gpt-5.6" } },
        parts: [{ id: `${id}-text`, type: "text", text: id }],
    } as MessageLike;
}

function rawHistory(session: string, rows: MessageLike[]) {
    return setRawMessageProvider(session, {
        readMessages: () => [],
        getStoredMessageCount: () => rows.length,
        getMessageCount: () => rows.length,
        hasMessageById: (id) => rows.some((row) => row.info.id === id),
        readMessageOrdinalPage: (after, limit) => rows.map((row, index) => ({
            id: row.info.id!, timeCreated: index + 1, contributesOrdinal: true, hasValidInfo: true,
        })).filter((row) => !after || row.timeCreated > after.timeCreated).slice(0, limit),
    });
}

async function sendProviderView(baseURL: string, view: MessageLike[]) {
    // Magic Context puts project memory and history in two leading user messages.
    // Send adapter.run's messages in order: raw SDK history lacks those entries,
    // and moving them to a system field changes the provider's conversation.
    const response = await fetch(`${baseURL}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fake", messages: view.map((message) => ({
            role: message.info.role,
            content: message.parts.flatMap((part) => {
                if (!part || typeof part !== "object") return [];
                const block = part as { type?: unknown; text?: unknown };
                return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
            }).join("\n"),
        })) }),
    });
    expect(response.ok).toBe(true);
}

function databaseInventory(root: string, taskRoot: string, role: string, pid: number): string[] {
    const inventory = execFileSync("lsof", ["-nP", "-p", String(pid), "-Fn"], { encoding: "utf8", timeout: 10000 });
    writeFileSync(join(root, `lsof-${role}.txt`), inventory);
    const paths = inventory.split("\n").filter((line) => /^n.*\.(db|sqlite)(-(wal|shm))?$/.test(line)).map((line) => line.slice(1));
    expect(paths.every((path) => realpathSync(path).startsWith(`${taskRoot}/`))).toBe(true);
    console.log(`${role} pid=${pid}: ${JSON.stringify(paths)}`);
    return paths.map((path) => realpathSync(path));
}

// MC_BRIDGE_MEMORY_E2E enables the real-module test with caller-supplied binary copies.
// The harness starts a private daemon rather than connecting to the user's running daemon.
for (const linked of [false, true]) {
(enabled && (linked || process.platform === "darwin") ? test : test.skip)(`real bridge sends seeded project memory in synthetic user head on first and ordinary passes (${linked ? "symlink" : "/var versus /private/var"})`, async () => {
    const suppliedRoot = process.env.MC_BRIDGE_MEMORY_ROOT!;
    const ckMcBin = process.env.MC_BRIDGE_MEMORY_BIN!;
    const ckSubcBin = process.env.MC_BRIDGE_MEMORY_SUBC_BIN!;
    if (!suppliedRoot || !ckMcBin || !ckSubcBin) throw new Error("Supply MC_BRIDGE_MEMORY_ROOT, BIN and SUBC_BIN under a throwaway root");
    const taskRoot = realpathSync(suppliedRoot);
    const root = join(suppliedRoot, linked ? "symlink" : "spelling");
    for (const binary of [ckMcBin, ckSubcBin]) expect(realpathSync(binary).startsWith(`${taskRoot}/`)).toBe(true);
    const dataDir = join(root, "data");
    const storageDir = join(dataDir, "cortexkit", "magic-context");
    const project = join(root, linked ? "project-link" : "project-target");
    mkdirSync(join(root, "project-target"), { recursive: true });
    if (linked) symlinkSync(join(root, "project-target"), project);
    if (!linked && process.platform === "darwin") {
        expect(project.startsWith("/var/")).toBe(true);
        expect(realpathSync(project)).toBe(`/private${project}`);
    }
    mkdirSync(storageDir, { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    const configPath = join(root, "config", "selected.jsonc");
    writeFileSync(configPath, JSON.stringify({
        historian: { disable: true }, dreamer: { disable: true }, embedding: { provider: "off" },
    }));
    const fixture = process.env.MC_BRIDGE_MEMORY_DB;
    if (fixture) copyFileSync(fixture, join(storageDir, "context.db"));
    const db = openBridgeDatabase(join(storageDir, "context.db"), true);
    const identity = resolveProjectIdentity(project);
    const canonicalIdentity = resolveProjectIdentity(realpathSync(project));
    expect(identity).not.toBe(canonicalIdentity);
    expect(resolveProjectIdentity(`${project}/`)).toBe(identity);
    db.prepare("INSERT INTO memories (project_path, category, content, normalized_hash, status, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'ARCHITECTURE', ?, ?, 'active', 0, 0, 0, 0)").run(identity, memory, computeNormalizedHash(memory));
    console.log(`Bun ${Bun.version}; ck-mc ${execFileSync(ckMcBin, ["--version"], { encoding: "utf8" }).trim()}`);
    console.log(JSON.stringify({ project, identity, canonicalRoot: realpathSync(project), canonicalIdentity, trailingSlashIdentity: resolveProjectIdentity(`${project}/`) }));
    const requests: any[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            requests.push(await request.json());
            return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
        },
    });
    let stack: HermeticSubcStack | undefined;
    let adapter: Awaited<ReturnType<typeof createBridgeAdapter>> | undefined;
    const rows = [user("first")];
    const session = `bridge-memory-${Date.now()}`;
    const unregister = rawHistory(session, rows);
    try {
        stack = await HermeticSubcStack.start({ dataDir, ckMcBin, ckSubcBin, startProducer: false, historianRunner: null,
            moduleEnv: { MAGIC_CONTEXT_CONFIG_PATH: configPath } });
        stack.writeModuleConfig({ historian: { disable: true }, dreamer: { disable: true }, embedding: { provider: "off" } });
        adapter = await createBridgeAdapter({ openCodeClient: { session: { hook: async () => {} } } as any,
            projectRoot: project, storageDir, configPath, connectionFile: stack.connectionFile });
        for (let pass = 0; pass < 2; pass++) {
            if (pass) rows.push(user("second"));
            const result = await adapter.run({ sessionId: session, messages: rows.slice(), kind: "model" });
            expect(result.kind).toBe(pass ? "ordinary" : "bootstrap");
            await sendProviderView(`http://127.0.0.1:${server.port}`, result.messages);
        }
        writeFileSync(join(root, "requests.json"), JSON.stringify(requests, null, 2));
        const pids = JSON.parse(readFileSync(join(dataDir, "cortexkit", "rust-e2e-pids.json"), "utf8")).pids as { role: string; pid: number }[];
        for (const { role, pid } of [{ role: "bridge", pid: process.pid }, ...pids]) {
            const inventory = execFileSync("lsof", ["-nP", "-p", String(pid), "-Fn"], { encoding: "utf8", timeout: 10000 });
            writeFileSync(join(root, `lsof-${role}.txt`), inventory);
            const paths = inventory.split("\n").filter((line) => /^n.*\.(db|sqlite)(-(wal|shm))?$/.test(line)).map((line) => line.slice(1));
            expect(paths.every((path) => resolve(path).startsWith(`${taskRoot}/`) || realpathSync(path).startsWith(`${taskRoot}/`))).toBe(true);
            if (role !== "daemon") expect(paths.some((path) => path.endsWith("context.db"))).toBe(true);
            console.log(`${role} pid=${pid}: ${JSON.stringify(paths)}`);
        }
        console.log(`captured ${requests.length} fake provider requests; compartments=${JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id=?").get(session))}`);
        for (const request of requests) {
            expect(request.system).toBeUndefined();
            expect(request.messages[0].role).toBe("user");
            expect(request.messages[1].role).toBe("user");
            expect(request.messages[0].content).toContain("<project-memory>");
            expect(request.messages[0].content).toContain(memory);
            expect(request.messages[1].content).toContain("<session-history-since>");
        }
        expect(db.prepare("SELECT project_path FROM session_projects WHERE session_id=? AND harness='opencode2'").get(session)).toEqual({ project_path: identity });
    } finally {
        unregister();
        await adapter?.dispose();
        await stack?.stop();
        server.stop(true);
        db.close();
    }
}, 60000);
}

for (const firstTurn of [false, true]) {
(enabled ? test : test.skip)(firstTurn
    ? "OpenCode 1 v1 SDK bridge sends seeded project memory on the first user turn without assistant history and after one reply"
    : "OpenCode 1 v1 SDK bridge sends seeded project memory on bootstrap and ordinary passes from canonical opencode.db", async () => {
    const suppliedRoot = process.env.MC_BRIDGE_MEMORY_ROOT;
    const ckMcBin = process.env.MC_BRIDGE_MEMORY_BIN;
    const ckSubcBin = process.env.MC_BRIDGE_MEMORY_SUBC_BIN;
    if (!suppliedRoot || !ckMcBin || !ckSubcBin) throw new Error("Supply MC_BRIDGE_MEMORY_ROOT, BIN and SUBC_BIN under a throwaway root");
    const taskRoot = realpathSync(suppliedRoot);
    expect(taskRoot).toContain("/magic-context/");
    for (const binary of [ckMcBin, ckSubcBin]) expect(realpathSync(binary).startsWith(`${taskRoot}/`)).toBe(true);
    const opencodeBin = process.env.MC_BRIDGE_MEMORY_OPENCODE_BIN ?? Bun.which("opencode") ?? join(process.env.HOME!, ".opencode", "bin", "opencode");
    const root = join(suppliedRoot, firstTurn ? "v1-first-turn" : "v1");
    const dirs = Object.fromEntries(["home", "config", "data", "cache", "state", "runtime", "project"].map((name) => [name, join(root, name)]));
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    const project = dirs.project;
    const storageDir = join(dirs.data, "cortexkit", "magic-context");
    const opencodeDb = join(dirs.data, "opencode", "opencode.db");
    const configPath = join(dirs.config, "selected.jsonc");
    const config = {
        historian: { disable: true }, dreamer: { disable: true, inject_docs: false }, embedding: { provider: "off" },
        memory: { enabled: true, injection_budget_tokens: 4000, user_profile_budget_tokens: 1000 },
        compaction: { enabled: true },
    };
    writeFileSync(configPath, JSON.stringify(config));
    mkdirSync(storageDir, { recursive: true });
    const fixture = process.env.MC_BRIDGE_MEMORY_DB;
    if (fixture) copyFileSync(fixture, join(storageDir, "context.db"));
    const env = {
        HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
        XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, XDG_RUNTIME_DIR: dirs.runtime,
        OPENCODE_DB: opencodeDb, OPENCODE_CONFIG_DIR: dirs.config,
        MAGIC_CONTEXT_STORAGE_DIR: storageDir, MAGIC_CONTEXT_CONFIG_PATH: configPath,
        OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const mock = new MockProvider();
    let host: ChildProcess | undefined;
    let stack: HermeticSubcStack | undefined;
    let adapter: Awaited<ReturnType<typeof createBridgeAdapter>> | undefined;
    let db: ReturnType<typeof openBridgeDatabase> | undefined;
    let hostLog = "";
    try {
        // Seed before either host starts: ordinary passes replay the bootstrap's frozen head.
        db = openBridgeDatabase(join(storageDir, "context.db"), true);
        const identity = resolveProjectIdentity(project);
        db.prepare("INSERT INTO memories (project_path, category, content, normalized_hash, status, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'ARCHITECTURE', ?, ?, 'active', 0, 0, 0, 0)").run(identity, memory, computeNormalizedHash(memory));
        expect(execFileSync(opencodeBin, ["--version"], { encoding: "utf8", env: process.env }).trim()).toBe("1.18.35");
        const { baseURL } = await mock.start();
        mock.setDefault({ text: "real stored reply", usage: { input_tokens: 1000, output_tokens: 20 } });
        const model = { providerID: "mock-anthropic", modelID: "mock-sonnet" };
        writeFileSync(join(dirs.config, "opencode.json"), JSON.stringify({
            plugin: [], autoupdate: false, share: "disabled",
            compaction: { auto: false, prune: false },
            agent: { title: { disable: true }, summary: { disable: true } },
            enabled_providers: [model.providerID], model: `${model.providerID}/${model.modelID}`, small_model: `${model.providerID}/${model.modelID}`,
            provider: { [model.providerID]: {
                npm: "@ai-sdk/anthropic", env: [], options: { baseURL, apiKey: "test-key-not-real" },
                models: { [model.modelID]: { id: model.modelID, name: "Mock Sonnet", limit: { context: 200000, output: 8192 } } },
            } },
        }));
        host = spawn(opencodeBin, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
            cwd: project, env: process.env, stdio: ["ignore", "pipe", "pipe"],
        });
        host.stdout?.on("data", (chunk) => { hostLog += chunk; });
        host.stderr?.on("data", (chunk) => { hostLog += chunk; });
        host.on("error", (error) => { hostLog += String(error); });
        let url: string | undefined;
        for (let attempt = 0; attempt < 200; attempt++) {
            url = hostLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
            if (url) break;
            if (host.exitCode !== null) throw new Error(`OpenCode exited before readiness: ${hostLog}`);
            await Bun.sleep(50);
        }
        if (!url) throw new Error(`OpenCode did not advertise its server: ${hostLog}`);
        const client = createOpencodeClient({ baseUrl: url });
        const created = await client.session.create({ query: { directory: project }, body: { title: "v1 bridge memory proof" } });
        expect(created.error).toBeUndefined();
        const session = created.data!.id;
        const constructAdapter = async () => {
            stack = await HermeticSubcStack.start({ dataDir: dirs.data, ckMcBin, ckSubcBin, startProducer: false, historianRunner: null });
            stack.writeModuleConfig(config);
            return createBridgeAdapter({ openCodeClient: client, projectRoot: project, storageDir, configPath, connectionFile: stack.connectionFile });
        };
        if (firstTurn) adapter = await constructAdapter();
        for (const text of firstTurn ? ["first real turn"] : ["first real turn", "second real turn"]) {
            const reply = await client.session.prompt({ path: { id: session }, query: { directory: project }, body: { model, noReply: firstTurn, parts: [{ type: "text", text }] } });
            expect(reply.error).toBeUndefined();
            expect(reply.data?.info.error).toBeUndefined();
        }
        const messages = await client.session.messages({ path: { id: session }, query: { directory: project } });
        expect(messages.error).toBeUndefined();
        const rows = messages.data!;
        expect(rows.map((row) => row.info.role)).toEqual(firstTurn ? ["user"] : ["user", "assistant", "user", "assistant"]);
        expect(mock.requests()).toHaveLength(firstTurn ? 0 : 2);
        const canonical = new Database(opencodeDb, { readonly: true });
        try {
            expect(canonical.prepare("SELECT id FROM message WHERE session_id=?").all(session).map((row) => (row as { id: string }).id).sort()).toEqual(rows.map((row) => row.info.id).sort());
        } finally { canonical.close(); }
        adapter ??= await constructAdapter();
        mock.reset();
        mock.setDefault({ text: "bridge view received", usage: { input_tokens: 1000, output_tokens: 20 } });
        // The v1 SDK's user info.summary holds title/body/diffs; MessageLike's
        // info.summary is a boolean marking assistant compaction summaries.
        // Cast only the type: rewriting the SDK rows would no longer test real host input.
        let rawWindow = rows as unknown as MessageLike[];
        const requests: ReturnType<MockProvider["requests"]> = [];
        const views: BridgeView[] = [];
        for (let pass = 0; pass < 2; pass++) {
            const result = await adapter.run({ sessionId: session, messages: rawWindow, kind: "model" });
            views.push(result);
            expect(result.kind).toBe(pass ? "ordinary" : "bootstrap");
            await sendProviderView(baseURL, result.messages);
            requests.push(mock.requests().at(-1)!);
            if (firstTurn && !pass) {
                // Reuse the persisted user ID so the real host completes that turn, not a second prompt.
                const reply = await client.session.prompt({ path: { id: session }, query: { directory: project }, body: {
                    model, messageID: rows[0].info.id, parts: [{ type: "text", text: "first real turn" }],
                } });
                expect(reply.error).toBeUndefined();
                expect(reply.data?.info.error).toBeUndefined();
                const completed = await client.session.messages({ path: { id: session }, query: { directory: project } });
                expect(completed.error).toBeUndefined();
                expect(completed.data!.map((row) => row.info.role)).toEqual(["user", "assistant"]);
                rawWindow = completed.data! as unknown as MessageLike[];
            }
        }
        writeFileSync(join(root, "requests.json"), JSON.stringify(requests, null, 2));
        writeFileSync(join(root, "bridge-views.json"), JSON.stringify(views, null, 2));
        expect(requests).toHaveLength(2);
        expect(views[0].messages).toHaveLength(firstTurn ? 3 : 6);
        expect(views[1].messages).toHaveLength(firstTurn ? 4 : 6);
        expect(views[1].messages.slice(0, 2)).toEqual(views[0].messages.slice(0, 2));
        for (const view of views) {
            for (const head of view.messages.slice(0, 2)) {
                expect(head.info).toEqual({ role: "user", sessionID: session });
                expect(head.parts).toEqual([{ type: "text", text: expect.any(String), synthetic: true }]);
            }
        }
        const contextDb = realpathSync(join(storageDir, "context.db"));
        const pids = JSON.parse(readFileSync(join(dirs.data, "cortexkit", "rust-e2e-pids.json"), "utf8")).pids as { role: string; pid: number }[];
        const inventories = new Map([{ role: "bridge", pid: process.pid }, { role: "opencode", pid: host.pid! }, ...pids].map(({ role, pid }) => [role, databaseInventory(root, taskRoot, role, pid)]));
        expect(inventories.get("bridge")).toContain(contextDb);
        expect(inventories.get("module")).toContain(contextDb);
        expect(inventories.get("opencode")).toContain(realpathSync(opencodeDb));
        console.log(`v1 ${firstTurn ? "first-turn" : "history"} bootstrap returned ${views[0].messages.length} messages; head: ${JSON.stringify(views[0].messages.slice(0, 2))}`);
        for (const { body } of requests) {
            expect(body.system).toBeUndefined();
            expect(body.messages?.[0].role).toBe("user");
            expect(body.messages?.[1].role).toBe("user");
            expect(body.messages?.[0].content).toContain("<project-memory>");
            expect(body.messages?.[0].content).toContain(memory);
            expect(body.messages?.[1].content).toContain("<session-history-since>");
            expect(JSON.stringify(body.messages)).toContain("first real turn");
            if (!firstTurn) expect(JSON.stringify(body.messages)).toContain("second real turn");
        }
        expect(db.prepare("SELECT project_path FROM session_projects WHERE session_id=? AND harness='opencode'").get(session)).toEqual({ project_path: identity });
        expect(db.prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id=?").get(session)).toEqual({ n: 0 });
        console.log(`Bun ${Bun.version}; OpenCode 1.18.35; v1 session=${session} harness=opencode project=${project} identity=${identity}; captured ${requests.length} bridge provider requests`);
    } finally {
        writeFileSync(join(root, "opencode.log"), hostLog);
        await adapter?.dispose();
        await stack?.stop();
        if (host && host.exitCode === null) {
            const exited = new Promise<void>((done) => host!.once("exit", () => done()));
            host.kill("SIGTERM");
            await exited;
        }
        await mock.stop();
        db?.close();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}, 60000);
}
