import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compareServedBodies, firstDifference, integrity, inventory, version } from "./upgrade-audit";
import type { MockProvider, CapturedRequest } from "../../packages/e2e-tests/src/mock-provider/server";

// Set TMPDIR before loading the OpenCode/Pi E2E drivers so any module-level
// temporary paths, as well as their per-host homes and stores, stay in this rehearsal.
const [release, root, report] = process.argv.slice(2).map((p) => resolve(p));
if (process.platform !== "linux" || !root.startsWith(join(process.env.TMPDIR!, "magic-context", "rehearsal-early") + "/"))
	throw new Error("Live rehearsal requires a throwaway Linux rehearsal-early root");
mkdirSync(root, { recursive: true });
process.env.TMPDIR = root;
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.MC_E2E_KEEP = "1";
process.env.NODE_ENV = "";
delete process.env.MC_E2E_MODE;
const repo = resolve(import.meta.dir, "../..");
const hostPackages = dirname(dirname(dirname(process.env.MC_E2E_OPENCODE2_CLI!)));
const response = { content: [{ type: "thinking", thinking: "Preserve the migration boundary and exact reasoning.", signature: "rehearsal-signed-thinking" }, { type: "text", text: "Migration plan recorded 東京." }], usage: { input_tokens: 500, output_tokens: 80 } };
const config = { rust: false, memory: { enabled: true, embeddings: { enabled: false } }, auto_update: false };
type Host = {
	root: string; db: string; workdir: string; mock: MockProvider;
	session(): Promise<string>;
	prompt(session: string, text: string): Promise<void>;
	stop(): Promise<void>;
};
const results: Record<string, unknown>[] = [];

async function boot(kind: string, tree: string, previous?: Host): Promise<Host> {
	if (kind === "opencode") {
		process.env.MC_E2E_PLUGIN_ENTRY = join(tree, "packages/plugin/dist/index.js");
		const { TestHarness } = await import("../../packages/e2e-tests/src/harness");
		// TestHarness.restart reuses the config/data/cache/work directories and mock, then reconnects its SDK client.
		const h = previous ? (previous as Host & { harness: Awaited<ReturnType<typeof TestHarness.create>> }).harness : await TestHarness.create({ prepareContextDatabase: false, magicContextConfig: config, mockDefault: response });
		if (previous) await h.restart();
		return { root: dirname(h.dataDir), db: h.contextDbPath(), workdir: h.workdir, mock: h.mock, harness: h,
			session: () => h.createSession(), prompt: async (id: string, text: string) => { await h.sendPrompt(id, text); }, stop: () => h.opencode.kill({ root: "keep" }) } as Host;
	}
	if (kind === "opencode2") {
		const { spawnOpencode2, waitForPluginActive } = await import("../../packages/e2e-tests/src/opencode2-runner/spawn");
		const { OpenCode } = await import(Bun.resolveSync("@opencode/client", hostPackages));
		const prev = previous as Host & { running: Awaited<ReturnType<typeof spawnOpencode2>> } | undefined;
		const running = await spawnOpencode2({ providerID: "anthropic", magicContextPlugin: join(tree, "packages/plugin"), prepareContextDatabase: false, magicContextConfig: config, mockResponse: response,
			...(prev ? { existingIsolation: { root: prev.running.root, env: prev.running.env, cwd: prev.running.cwd }, existingMock: { mock: prev.mock, baseURL: prev.running.mockBaseURL } } : {}) });
		const client = OpenCode.make({ baseUrl: running.url, headers: { authorization: `Basic ${btoa(`opencode:${running.password}`)}` } });
		if (previous) {
			// OpenCode 2 activates plugins lazily. An auxiliary session opens the workspace before auditing the original session's store.
			await client.session.create({ location: { directory: running.cwd }, model: { providerID: "anthropic", id: "mock-model" } });
			await waitForPluginActive(client, running.cwd);
		}
		return { root: running.root, db: join(running.env.MAGIC_CONTEXT_STORAGE_DIR ?? join(running.env.XDG_DATA_HOME!, "cortexkit/magic-context"), "context.db"), workdir: running.cwd, mock: running.mock, running,
			session: async () => { const s = await client.session.create({ location: { directory: running.cwd }, model: { providerID: "anthropic", id: "mock-model" } }); await waitForPluginActive(client, running.cwd); return s.id; },
			prompt: async (id: string, text: string) => { await client.session.prompt({ sessionID: id, text }); await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(90_000) }); }, stop: () => running.stopHost() } as Host;
	}
	process.env.MC_E2E_PI_PLUGIN_ROOT = join(tree, "packages/pi-plugin");
	const { MockProvider } = await import("../../packages/e2e-tests/src/mock-provider/server");
	const { PiRpcClient, requireSuccessfulResponse } = await import("../../packages/e2e-tests/src/pi-runner/rpc-client");
	const prev = previous as Host & { rpc: InstanceType<typeof PiRpcClient>; baseURL: string; sessionFile?: string } | undefined;
	const mock = prev?.mock ?? new MockProvider();
	const baseURL = prev?.baseURL ?? (await mock.start()).baseURL;
	mock.setDefault(response);
	if (prev) {
		const pluginDir = prev.rpc.env.pluginDir;
		rmSync(pluginDir, { recursive: true, force: true });
		symlinkSync(join(tree, "packages/pi-plugin"), pluginDir, "dir");
	}
	const rpc = new PiRpcClient({ mockProviderURL: baseURL, env: prev?.rpc.env, magicContextConfig: config });
	await rpc.start();
	if (prev?.sessionFile) requireSuccessfulResponse(await rpc.sendCommand("switch_session", { sessionPath: prev.sessionFile }));
	const host = { root: rpc.env.baseDir, db: join(rpc.env.dataDir, "cortexkit/magic-context/context.db"), workdir: rpc.env.workdir, mock, rpc, baseURL, sessionFile: prev?.sessionFile,
		session: async () => { const state = requireSuccessfulResponse(await rpc.sendCommand<{ sessionId: string; sessionFile: string }>("get_state")); host.sessionFile = state.sessionFile; return state.sessionId; },
		prompt: async (_id: string, text: string) => { const end = rpc.waitForEvent((e) => e.type === "agent_end", { timeoutMs: 90_000 }); requireSuccessfulResponse(await rpc.sendCommand("prompt", { message: text })); await end; const state = requireSuccessfulResponse(await rpc.sendCommand<{ sessionFile: string }>("get_state")); host.sessionFile = state.sessionFile; },
		stop: () => rpc.shutdown(2000, true) };
	return host;
}

function hostAudit(db: string) {
	const conn = new Database(db, { readonly: true });
	try {
		return { version: version(db), counts: inventory(db), lkg: conn.query("SELECT session_id,captured_at FROM lkg_slots ORDER BY session_id").all(), recovery: conn.query("SELECT session_id,thinking_binding_recovery_target FROM session_meta ORDER BY session_id").all() };
	} finally { conn.close(); }
}
function command(args: string[]): void {
	const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
	if (result.status !== 0) throw new Error(`${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
	console.log(result.stdout.trim());
}
function wire(host: Host, offset: number, marker: string): CapturedRequest {
	const matches = host.mock.requests().slice(offset).filter((r) => r.body.messages?.some((m) => m.role === "user" && JSON.stringify(m.content).includes(marker)));
	if (matches.length !== 1) throw new Error(`Expected exactly one provider pass for ${marker}; got ${matches.length}`);
	return matches[0];
}
for (const kind of ["opencode", "opencode2", "pi"]) {
	let host: Host | undefined;
	const result: Record<string, unknown> = { host: kind, rust: false, status: "FAIL" };
	results.push(result);
	try {
		host = await boot(kind, release);
		result.phase = "released seed";
		const session = await host.session();
		await host.prompt(session, "Review this migration plan: retain memories, notes and signed reasoning 東京.");
		await host.prompt(session, "Record the compatibility decisions and preserve the earlier analysis.");
		await host.stop();
		if (!host.root.startsWith(root + "/")) throw new Error(`Host escaped temporary root: ${host.root}`);
		const sourceArgs: string[] = [];
		if (kind === "pi") {
			// Pi repairs history against native JSONL entry IDs; invented archive IDs would be pruned on the next turn.
			const sessionFile = (host as Host & { sessionFile?: string }).sessionFile;
			if (!sessionFile || !sessionFile.startsWith(host.root + "/")) throw new Error("Pi did not expose an isolated native session file");
			const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as { type: string; id: string; timestamp?: string; message?: { role: string; content: unknown; timestamp?: number } }[];
			const sources = entries.filter((e) => e.type === "message" && ["user", "assistant"].includes(e.message?.role ?? "")).slice(0,2).map((e,i) => {
				const content = JSON.stringify(e.message!.content);
				return { id: e.id, ordinal: i+1, role: e.message!.role, createdAt: e.message!.timestamp ?? Date.parse(e.timestamp!), sourceVersion: "1", contentHash: new Bun.CryptoHasher("sha256").update(content).digest("hex"), content };
			});
			const sourceFile = join(root, "pi-native-sources.json");
			writeFileSync(sourceFile, JSON.stringify(sources));
			sourceArgs.push(sourceFile);
		}
		command([process.execPath, join(repo, "scripts/lib/upgrade-host.ts"), "augment", release, dirname(host.db), session, ...sourceArgs]);
		result.before = hostAudit(host.db);
		if (version(host.db) !== 95) throw new Error("Released host did not create context schema 95");
		const backup = join(root, `backup-${kind}`);
		cpSync(host.root, backup, { recursive: true, dereference: false });
		const baselineDb = join(backup, host.db.slice(host.root.length + 1));
		result.phase = "released control restart";
		host = await boot(kind, release, host);
		const marker = "UPGRADE_REHEARSAL_FIRST_PASS: continue with the exact same migration constraints.";
		let offset = host.mock.requests().length;
		await host.prompt(session, marker);
		const before = wire(host, offset, marker);
		await host.stop();
		rmSync(host.root, { recursive: true, force: true });
		cpSync(backup, host.root, { recursive: true, dereference: false });
		result.phase = "candidate restart";
		host = await boot(kind, repo, host);
		result.afterOpen = hostAudit(host.db);
		result.startupDifference = firstDifference(baselineDb, host.db);
		result.domainDifference = firstDifference(baselineDb, host.db, ["memories", "notes", "tags", "compartments", "workspaces", "workspace_members", "lkg_slots", "lkg_slot_chunks"]);
		if (result.domainDifference) throw new Error(`Live domain preservation: ${result.domainDifference}`);
		result.integrity = integrity(host.db);
		if (version(host.db) !== 100) throw new Error("Candidate host did not reach context schema 100");
		result.phase = "candidate first provider pass";
		offset = host.mock.requests().length;
		await host.prompt(session, marker);
		const after = wire(host, offset, marker);
		result.served = compareServedBodies(before.body, after.body);
		result.signedThinking = { before: JSON.stringify(before.body.messages).includes("rehearsal-signed-thinking"), after: JSON.stringify(after.body.messages).includes("rehearsal-signed-thinking") };
		result.rawBodyBytes = { before: Buffer.byteLength(before.rawBody ?? ""), after: Buffer.byteLength(after.rawBody ?? "") };
		result.providerRequests = { before: 1, after: 1 };
		result.afterPass = hostAudit(host.db);
		if ((result.afterPass as ReturnType<typeof hostAudit>).counts.compartments < (result.before as ReturnType<typeof hostAudit>).counts.compartments)
			throw new Error("The first live pass discarded the archival compartment fixture");
		const unchanged = Object.values(result.served as ReturnType<typeof compareServedBodies>).every((p) => p.equal);
		result.status = unchanged && (result.signedThinking as { before: boolean; after: boolean }).before && (result.signedThinking as { after: boolean }).after ? "PASS" : "FAIL";
	} catch (error) {
		result.error = String(error);
	} finally {
		if (host) { await host.stop().catch((e) => { result.stopError = String(e); }); await host.mock.stop(); }
		mkdirSync(dirname(report), { recursive: true });
		writeFileSync(report, JSON.stringify(results, null, 2));
		console.log(JSON.stringify({ host: result.host, status: result.status, phase: result.phase, error: result.error, served: result.served, signedThinking: result.signedThinking, providerRequests: result.providerRequests, rawBodyBytes: result.rawBodyBytes, beforeVersion: (result.before as ReturnType<typeof hostAudit> | undefined)?.version, afterVersion: (result.afterOpen as ReturnType<typeof hostAudit> | undefined)?.version, counts: result.afterPass ? Object.fromEntries(["memories","notes","tags","compartments","workspaces","workspace_members","lkg_slots","lkg_slot_chunks"].map((k) => [k, [(result.before as ReturnType<typeof hostAudit>).counts[k], (result.afterPass as ReturnType<typeof hostAudit>).counts[k]]])) : undefined, startupDifference: result.startupDifference, domainDifference: result.domainDifference }));
	}
}
process.exitCode = results.some((r) => r.status !== "PASS") ? 1 : 0;
