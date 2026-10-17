import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startOracle } from "../../plugin/src/hooks/magic-context/host-runner/conformance/oracle";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "../../plugin/src/shared/test-temp-dir";
import { createPiBridgeAdapter } from "./host-runner";
import { createTestDb } from "./test-utils.test";

test.skipIf(!process.env.MC_PI_BRIDGE_HOST_PACKAGE)(
	"Pi 1.2.0 serves a bridged turn through an in-process relay to real ck-mc",
	async () => {
		const manifest = process.env.MC_PI_BRIDGE_HOST_PACKAGE!;
		expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe("1.2.0");
		const parent = join(tmpdir(), "magic-context/pi-bridge");
		mkdirSync(parent, { recursive: true });
		const root = createTestTempDirFromPath(join(parent, "host-"));
		const savedEnv = { ...process.env };
		createTestDb(join(root, "context.db")).close();
		const oracle = startOracle({ contextRoot: root });
		let adapter: Awaited<ReturnType<typeof createPiBridgeAdapter>> | undefined;
		let session: any;
		try {
			const agentDir = join(root, "agent"),
				project = join(root, "project");
			for (const path of [
				agentDir,
				project,
				join(root, "data"),
				join(root, "config"),
				join(root, "cache"),
			])
				mkdirSync(path, { recursive: true });
			Object.assign(process.env, {
				HOME: root,
				XDG_DATA_HOME: join(root, "data"),
				XDG_CONFIG_HOME: join(root, "config"),
				XDG_CACHE_HOME: join(root, "cache"),
				MAGIC_CONTEXT_TEST_DATA_DIR: join(root, "data"),
				MAGIC_CONTEXT_STORAGE_DIR: join(root, "mc"),
				OPENCODE_DB: join(root, "no-opencode.db"),
				PI_CODING_AGENT_DIR: agentDir,
			});
			const host = await import(join(dirname(manifest), "dist/index.js"));
			const ai = await import(
				join(dirname(dirname(manifest)), "pi-ai/dist/index.js")
			);
			const configPath = join(root, "mc.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					historian: { runner: "broca", disable: true },
					memory: { enabled: false },
				}),
			);
			const manager = host.SessionManager.create(
				project,
				join(root, "sessions"),
			);
			const id = manager.getSessionId();
			await oracle.call({ control: "bind", harness: "pi", session: id });
			let relayCalls = 0,
				providerMessages: unknown[] = [],
				carrying = "";
			adapter = await createPiBridgeAdapter({
				projectRoot: project,
				connectionFile: join(root, "unused.json"),
				storageDir: root,
				configPath,
				reloadSession: () => ({
					readBranchEntries: () => manager.getBranch(),
					appendCompaction: manager.appendCompaction.bind(manager),
				}),
				transport: {
					async request(_method, body) {
						relayCalls++;
						const answer = await oracle.call(
							JSON.parse(Buffer.from(body).toString()),
						);
						const decoded = JSON.parse(answer);
						if (decoded.oracle_error) throw decoded.oracle_error;
						return Buffer.from(answer);
					},
				},
			});
			const bridge = adapter;
			const loader = new host.DefaultResourceLoader({
				cwd: project,
				agentDir,
				extensionFactories: [
					(pi: any) => {
						pi.registerProvider("bridge-smoke", {
							api: "openai-completions",
							apiKey: "synthetic-not-a-secret",
							baseUrl: "http://127.0.0.1:1",
							models: [
								{
									id: "fixture",
									name: "Bridge fixture",
									reasoning: false,
									input: ["text"],
									contextWindow: 100_000,
									maxTokens: 1024,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								},
							],
							streamSimple(model: any, context: any) {
								providerMessages = context.messages;
								const stream = ai.createAssistantMessageEventStream();
								queueMicrotask(() => {
									const message = {
										role: "assistant",
										content: [{ type: "text", text: "Bridged response." }],
										api: model.api,
										provider: model.provider,
										model: model.id,
										usage: {
											input: 100,
											output: 5,
											cacheRead: 0,
											cacheWrite: 0,
											totalTokens: 105,
											cost: {
												input: 0,
												output: 0,
												cacheRead: 0,
												cacheWrite: 0,
												total: 0,
											},
										},
										stopReason: "stop",
										timestamp: Date.now(),
									};
									stream.push({ type: "done", reason: "stop", message });
									stream.end();
								});
								return stream;
							},
						});
						pi.on("context", async (event: any, ctx: any) => {
							const branch = manager.getBranch();
							const messages = event.messages.map((message: any) => {
								const entry = branch.find(
									(entry: any) =>
										entry.type === "message" &&
										JSON.stringify(entry.message) === JSON.stringify(message),
								);
								if (!entry)
									throw new Error(
										"Context message has no real journal identity",
									);
								return entry;
							});
							const view = await bridge.run({
								sessionId: id,
								messages,
								kind: "model",
								host: {
									model: {
										provider: ctx.model.provider,
										id: ctx.model.id,
										api: ctx.model.api,
									},
									contextWindow: 98_976,
									system: ctx.getSystemPrompt(),
									tools: pi.getAllTools(),
								},
							});
							carrying = view.receipt.request_id;
							return { messages: view.messages.map((entry) => entry.message) };
						});
						pi.on("message_end", (event: any) => {
							if (event.message.role === "assistant")
								bridge.completeRequest(id, carrying, {
									status: 200,
									cleanEnd: true,
								});
						});
					},
				],
			});
			await loader.reload();
			const settings = host.SettingsManager.create(project, agentDir);
			settings.applyOverrides({
				defaultProvider: "bridge-smoke",
				defaultModel: "fixture",
				compaction: { enabled: false },
				retry: { enabled: false },
			});
			({ session } = await host.createAgentSession({
				cwd: project,
				agentDir,
				resourceLoader: loader,
				settingsManager: settings,
				sessionManager: manager,
			}));
			await session.bindExtensions({});
			await session.modelRuntime.setRuntimeApiKey(
				"bridge-smoke",
				"synthetic-not-a-secret",
			);
			const selected = session.modelRuntime.getModel("bridge-smoke", "fixture");
			expect(selected).toBeDefined();
			await session.setModel(selected);
			await session.prompt("Please preserve this bridged user message.");
			await session.prompt(
				"A second bridged turn verifies assistant hook operations.",
			);
			expect(relayCalls).toBeGreaterThan(0);
			expect(JSON.stringify(providerMessages)).toContain("§");
			expect(JSON.stringify(providerMessages)).toContain(
				"bridged user message",
			);
			expect(bridge.receipt(id)?.delivery).toBe("clean");
		} finally {
			await session?.dispose();
			await adapter?.dispose();
			await oracle.close();
			for (const key of Object.keys(process.env))
				if (!(key in savedEnv)) delete process.env[key];
			Object.assign(process.env, savedEnv);
			cleanupTestTempDir(root);
		}
	},
	180_000,
);
