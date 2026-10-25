import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../src/shared/sqlite";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { insertMemory } from "../../src/features/magic-context/memory/storage-memory";
import { buildTurnOneAuthorizationRequest } from "../../src/features/magic-context/memory/turn-two";
import { historianSystemPrompt } from "../../src/hooks/magic-context/compartment-prompt";
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../src/features/magic-context/memory/turn-one-publication";
import { CampaignLedger, type Profile } from "../two-pass-live-replay/artifact-schema";
import { attestHost, disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { callMeter, readPluginStore } from "./activation-driver";
import { hostAdapter, type HostLane } from "./host-adapters";
import { historianMockReply, mockProvider } from "./mock-provider";
import { sumProviderSteps } from "./provider-meter";

if (import.meta.main) {
    const [operation, laneArg, root, install, carrierArg] = process.argv.slice(2);
    if (!["opencode-1", "opencode-2", "omp"].includes(laneArg)) throw new Error("proof_lane");
    const lane = laneArg as HostLane;
    const carrier = carrierArg === "opencode-session" ? "opencode-session" : lane === "omp" ? "pi-historian-rpc" : "hidden-completion";
    const env = disposableEnvironment(root);
    const entry = buildTurnOneAuthorizationRequest({ lane, carrier, provider: "mock", modelId: "mock-model", variant: null, temperature: null, thinkingLevel: null },
        { system: historianSystemPrompt(true), formatInstruction: HISTORIAN_FORMAT_INSTRUCTION, toolSurface: [], checkToolSurface: [] }).requestedIdentity;
    if (operation === "prepare") {
        writeFileSync(join(install, "packages/plugin/src/features/magic-context/memory/turn-two-allowlist.json"), JSON.stringify({ version: 1, entries: [entry] }));
        mkdirSync(env.MAGIC_CONTEXT_STORAGE_DIR, { recursive: true });
        mkdirSync(join(root, "work"), { recursive: true });
        const db = new Database(join(env.MAGIC_CONTEXT_STORAGE_DIR, "context.db"));
        try {
            initializeDatabase(db);
            if (!db.prepare("SELECT id FROM memories WHERE project_path=? AND content=?").get(join(root, "work"), "Chunk size: 32 KiB."))
                insertMemory(db, { projectPath: join(root, "work"), category: "CONFIG_VALUES", content: "Chunk size: 32 KiB.", importance: 0.8, sourceType: "historian" });
        } finally { db.close(); }
        console.log(JSON.stringify({ preparedCandidate: entry, storePath: join(env.MAGIC_CONTEXT_STORAGE_DIR, "context.db") }));
    } else if (operation === "run") {
        const mock = mockProvider(historianMockReply, (requests) => writeFileSync(join(root, "mock-capture.json"), JSON.stringify(requests, null, 2)));
        const ledger = new CampaignLedger();
        const profile: Profile = { id: `mock-${lane}`, family: "mock", entry, modelRoute: "mock/mock-model", priceClass: "paid",
            tariff: { inputUSDPerMillion: 1, outputUSDPerMillion: 1, source: "Synthetic mock accounting, not provider pricing or actual spending" }, configurationSource: "mock fixture", variantSource: "mock fixture" };
        const adapter = hostAdapter(lane, { sourceRoot: install, mockProviderURL: mock.url, modelId: "mock-model", outputCeiling: 8192,
            timeoutMs: 60_000, magicContext: { protected_tags: 1, historian: { [lane === "opencode-1" ? "opencode" : lane === "opencode-2" ? "opencode2" : "omp"]: { model: "mock/mock-model" }, turn_two: "allowlist", two_pass: false },
                memory: { enabled: true, auto_promote: true, auto_search: { enabled: false }, git_commit_indexing: { enabled: false } }, embedding: { provider: "off" } } });
        const pluginEntrypoint = join(install, lane === "omp" ? "packages/pi-plugin/dist/index.js" : lane === "opencode-2" ? "packages/plugin/dist/v2/server.js" : "packages/plugin/dist/index.js");
        let host: Awaited<ReturnType<typeof adapter.start>> | undefined;
        try {
            host = await adapter.start({ installRoot: install, pluginEntrypoint, env, meter: callMeter(ledger, profile) });
            const before = await attestHost(root, env, host.pid);
            if (before.proof.tool !== "lsof -Fpn") throw new Error("proof_requires_lsof_not_proc_fallback");
            writeFileSync(join(root, "lsof-before.json"), JSON.stringify(before, null, 2));
            const session = await host.runSession("Use 64 KiB chunks, not 32 KiB. Record the corrected project chunk size.");
            const after = await attestHost(root, env, host.pid);
            if (after.proof.tool !== "lsof -Fpn") throw new Error("proof_requires_lsof_not_proc_fallback");
            if (!mock.requests.length || mock.requests.length !== ledger.rows.length || ledger.rows.some((row) => !row.settled))
                throw new Error("unmetered_or_uncaptured_dispatch");
            if (host.storePath === null) throw new Error("plugin_store_unobservable");
            const result = { lane, pid: host.pid, carrier: host.carrier, storePath: host.storePath, before, after, session,
                store: readPluginStore(root, host.storePath),
                capturedRequests: mock.requests, ledger: ledger.rows,
                usage: sumProviderSteps(mock.requests.map((request) => ({ inputTokens: request.inputTokens, outputTokens: request.outputTokens }))),
                actualUSDSpent: 0, network: "none", credentials: "mock-only" };
            writeFileSync(join(root, "mock-proof.json"), JSON.stringify(result, null, 2));
            console.log(JSON.stringify({ lane, pid: host.pid, carrier: host.carrier, storePath: host.storePath,
                requests: mock.requests.length, ledgerRows: ledger.rows.length, usage: result.usage,
                before: before.proof, after: after.proof, artifact: join(root, "mock-proof.json") }));
        } finally {
            if (host) {
                try { writeFileSync(join(root, "lsof-after.json"), JSON.stringify(await attestHost(root, env, host.pid), null, 2)); }
                finally { await host.stop(); }
            }
            writeFileSync(join(root, "mock-ledger.json"), JSON.stringify(ledger.rows, null, 2));
            mock.close();
        }
    } else throw new Error("proof_operation");
}
