import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { computeNormalizedHash } from "../../plugin/src/features/magic-context/memory/normalize-hash";
import { openBridgeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { createBridgeAdapter } from "../../plugin/src/host-runner";
import { setRawMessageProvider } from "../../plugin/src/hooks/magic-context/read-session-chunk";
import type { MessageLike } from "../../plugin/src/hooks/magic-context/transform-operations";
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
            const view = result.messages;
            // Preserve the adapter's message order and roles, including its two leading
            // synthetic user messages, when sending the fake provider's request.
            const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
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
