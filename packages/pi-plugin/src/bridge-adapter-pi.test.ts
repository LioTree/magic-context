import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { setPendingPiCompactionMarkerState } from "../../plugin/src/features/magic-context/storage-meta-persisted";
import { startOracle } from "../../plugin/src/hooks/magic-context/host-runner/conformance/oracle";
import { providerReplacementValid } from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import {
	applyCompaction,
	createRecord,
	issueRequest,
	scanWindow,
} from "../../plugin/src/hooks/magic-context/host-runner/record";
import { Database } from "../../plugin/src/shared/sqlite";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "../../plugin/src/shared/test-temp-dir";
import {
	nativePiEntry,
	type PiBridgeEntry,
	piProviderCodec,
	projectPiEntry,
} from "./bridge-codec-pi";
import {
	createPiBridgeAdapter,
	StoreVersionMismatchError,
} from "./host-runner";
import { createTestDb } from "./test-utils.test";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) cleanupTestTempDir(root);
});
function fixture() {
	const base = join(tmpdir(), "magic-context/pi-bridge");
	mkdirSync(base, { recursive: true });
	const root = createTestTempDirFromPath(join(base, "adapter-"));
	roots.push(root);
	createTestDb(join(root, "context.db")).close();
	const configPath = join(root, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			memory: { enabled: false },
			historian: { runner: "broca", disable: true },
		}),
	);
	return {
		projectRoot: root,
		connectionFile: join(root, "unused.json"),
		storageDir: root,
		configPath,
		reloadSession: () => ({
			readBranchEntries: () => [],
			appendCompaction: () => undefined,
		}),
	};
}
const entry = (id: string, role: string, text: string): PiBridgeEntry => ({
	type: "message",
	id,
	parentId: null,
	message: { role, content: [{ type: "text", text }], timestamp: 1 },
});
const host = {
	model: { provider: "fixture", id: "model" },
	contextWindow: 100_000,
	system: "System fixture.",
	tools: [],
};

test("Pi session deletion sends exactly one scoped provider op per call", async () => {
	const calls: string[] = [];
	const adapter = await createPiBridgeAdapter({
		...fixture(),
		transport: {
			async request(method, body) {
				expect(method).toBe("compaction.delete");
				calls.push(Buffer.from(body).toString());
				return Buffer.from('{"answer":"deleted"}');
			},
		},
	});
	try {
		await adapter.onSessionDeleted("pi-deleted");
		await adapter.onSessionDeleted("pi-deleted");
		expect(calls).toEqual(
			Array(2).fill(
				'{"method":"compaction.delete","params":{"session":"pi-deleted","harness":"pi"},"accept_reply_pages":true}',
			),
		);
	} finally {
		await adapter.dispose();
	}
});

test("Pi projection round trips text, signatures, tool arguments and vendor extras", () => {
	const e = entry("stable-id", "assistant", "café\r\n");
	e.message.content = [
		{ type: "thinking", thinking: "secret", thinkingSignature: "sig" },
		{ type: "toolCall", id: "call", name: "read", arguments: { z: 1, a: 2 } },
		{ type: "text", text: "answer", vendor: true },
	];
	expect(JSON.stringify(nativePiEntry(projectPiEntry(e)))).toBe(
		JSON.stringify(e),
	);
});

test("Pi bridge validates absolute options without opening a connection", async () => {
	for (const key of ["projectRoot", "connectionFile", "storageDir"] as const) {
		const options = fixture();
		await expect(
			createPiBridgeAdapter({ ...options, [key]: "relative" }),
		).rejects.toThrow(`${key} must be an absolute path`);
	}
});

test("Pi bridge serves real McHandler bootstrap and freezes a single operation across retry and restart", async () => {
	const options = fixture(),
		oracle = startOracle({ contextRoot: options.storageDir });
	const methods: string[] = [];
	await oracle.call({ control: "bind", harness: "pi", session: "pi-bridge" });
	const transport = {
		async request(method: string, body: Uint8Array) {
			methods.push(method);
			const result = await oracle.call(
				JSON.parse(Buffer.from(body).toString()),
			);
			const decoded = JSON.parse(result);
			if (decoded.oracle_error) throw decoded.oracle_error;
			return Buffer.from(result);
		},
	};
	let adapter = await createPiBridgeAdapter({ ...options, transport });
	try {
		const first = entry("u1", "user", "bootstrap"),
			next = entry("u2", "user", "second input");
		const initial = await adapter.run({
			sessionId: "pi-bridge",
			messages: [first],
			kind: "model",
			host,
		});
		expect(initial.kind).toBe("bootstrap");
		expect(initial.receipt.delivery).toBe("pending");
		const view = await adapter.run({
			sessionId: "pi-bridge",
			messages: [first, next],
			kind: "model",
			host,
		});
		expect(JSON.stringify(view.messages)).toContain("§");
		const hooks = methods.filter((m) => m === "transform.hook").length;
		expect(hooks).toBeGreaterThan(0);
		const clean = adapter.completeRequest(
			"pi-bridge",
			view.receipt.request_id,
			{ status: 200, cleanEnd: true },
		);
		expect(clean?.delivery).toBe("clean");
		expect(clean?.served_through_ordinal).toBe(2);
		const wire = JSON.stringify(view.messages);
		await adapter.dispose();
		adapter = await createPiBridgeAdapter({ ...options, transport });
		expect(adapter.receipt("pi-bridge")).toEqual(clean);
		const replay = await adapter.run({
			sessionId: "pi-bridge",
			messages: [first, next],
			kind: "model",
			host,
		});
		expect(JSON.stringify(replay.messages)).toBe(wire);
		expect(methods.filter((m) => m === "transform.hook").length).toBe(hooks);
	} finally {
		await adapter.dispose();
		await oracle.close();
	}
}, 180_000);

const fixtureReload = () => ({
	readBranchEntries: (): unknown[] => [],
	appendCompaction: (
		_summary: string,
		_first: string,
		_tokens: number,
	): string | undefined => undefined,
});
async function realBridge(sessionId: string, reloadSession = fixtureReload) {
	const options = fixture(),
		oracle = startOracle({ contextRoot: options.storageDir });
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	let timeout = false;
	await oracle.call({ control: "bind", harness: "pi", session: sessionId });
	const adapter = await createPiBridgeAdapter({
		...options,
		reloadSession,
		transport: {
			async request(method, body, opts) {
				const wire = JSON.parse(Buffer.from(body).toString());
				calls.push(wire);
				const answer = await oracle.call(wire);
				const decoded = JSON.parse(answer);
				if (decoded.oracle_error) throw decoded.oracle_error;
				if (timeout && method === "transform.hook") {
					return await new Promise<Uint8Array>((_resolve, reject) => {
						const aborted = () => reject({ source: "relay", code: "aborted" });
						if (opts.signal?.aborted) aborted();
						else
							opts.signal?.addEventListener("abort", aborted, { once: true });
					});
				}
				return Buffer.from(answer);
			},
		},
	});
	return {
		adapter,
		options,
		calls,
		oracle,
		timeout: () => {
			timeout = true;
		},
		resume: () => {
			timeout = false;
		},
		close: async () => {
			await adapter.dispose();
			await oracle.close();
		},
	};
}

test("Pi timed-out hook freezes raw bytes across later status and retry", async () => {
	const f = await realBridge("pi-timeout");
	const first = entry("u1", "user", "bootstrap"),
		second = entry("u2", "user", "raw timeout payload");
	try {
		await f.adapter.run({
			sessionId: "pi-timeout",
			messages: [first],
			host,
			kind: "model",
		});
		f.timeout();
		const frozen = await f.adapter.run({
			sessionId: "pi-timeout",
			messages: [first, second],
			host,
			kind: "model",
		});
		expect(frozen.messages.find((m) => m.id === "u2")).toEqual(second);
		expect(frozen.receipt.unserved_subjects).toMatchObject([
			{ subject_mid: "u2", hook: "pre_user" },
		]);
		const hooks = f.calls.filter((c) => c.method === "transform.hook").length;
		f.resume();
		const retried = await f.adapter.run({
			sessionId: "pi-timeout",
			messages: [first, second],
			host,
			kind: "model",
		});
		expect(retried.messages.find((m) => m.id === "u2")).toEqual(second);
		expect(f.calls.filter((c) => c.method === "transform.hook")).toHaveLength(
			hooks,
		);
	} finally {
		await f.close();
	}
}, 180_000);

test("Pi host response facts reject stale scopes and ignore zero-total usage", async () => {
	const f = await realBridge("pi-facts");
	try {
		const view = await f.adapter.run({
			sessionId: "pi-facts",
			messages: [entry("u1", "user", "hello")],
			host,
			kind: "model",
		});
		const now = Date.now();
		const fact = {
			kind: "provider_response" as const,
			sessionId: "pi-facts",
			lineageId: view.receipt.lineage_id,
			requestId: view.receipt.request_id,
			model: { providerID: "fixture", modelID: "model" },
			observedAt: now,
			completedAt: now,
			finishReason: "stop",
			outcome: "success" as const,
			contextWindow: 100_000,
			usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 99 },
		};
		expect(
			await f.adapter.recordHostFact({ ...fact, lineageId: "other" }),
		).toEqual({ accepted: false });
		const db = new Database(join(f.options.storageDir, "context.db"));
		try {
			const before = getOrCreateSessionMeta(
				db,
				"pi-facts",
				"pi",
			).lastResponseTime;
			expect(await f.adapter.recordHostFact(fact)).toEqual({ accepted: true });
			expect(
				getOrCreateSessionMeta(db, "pi-facts", "pi").lastResponseTime,
			).toBe(before);
			expect(
				await f.adapter.recordHostFact({
					...fact,
					usage: { input: 11, cacheRead: 12, cacheWrite: 13, output: 14 },
				}),
			).toEqual({ accepted: true });
			expect(
				getOrCreateSessionMeta(db, "pi-facts", "pi").lastResponseTime,
			).toBe(now);
			expect(f.adapter.receipt("pi-facts")?.delivery).toBe("pending");
		} finally {
			db.close();
		}
	} finally {
		await f.close();
	}
}, 180_000);

test("Pi /tree switch descends the lineage and a fork keeps its own receipt", async () => {
	const f = await realBridge("pi-tree");
	try {
		const first = entry("root", "user", "root"),
			left = entry("left", "assistant", "old branch"),
			right = entry("right", "assistant", "selected branch");
		await f.adapter.run({
			sessionId: "pi-tree",
			messages: [first],
			host,
			kind: "model",
		});
		const old = await f.adapter.run({
			sessionId: "pi-tree",
			messages: [first, left],
			host,
			kind: "model",
		});
		const selected = await f.adapter.run({
			sessionId: "pi-tree",
			messages: [first, right],
			host,
			kind: "model",
		});
		expect(selected.receipt.lineage_id).not.toBe(old.receipt.lineage_id);
		expect(JSON.stringify(selected.messages)).not.toContain("old branch");
		expect(JSON.stringify(selected.messages)).toContain("selected branch");
		await f.oracle.call({ control: "bind", harness: "pi", session: "pi-fork" });
		const fork = await f.adapter.run({
			sessionId: "pi-fork",
			messages: [first, right],
			host,
			kind: "model",
		});
		expect(fork.kind).toBe("bootstrap");
		expect(fork.receipt.lineage_id).not.toBe(selected.receipt.lineage_id);
		expect(f.adapter.receipt("pi-tree")).toEqual(selected.receipt);
		expect(
			f.adapter.completeRequest("pi-fork", selected.receipt.request_id, {
				status: 200,
				cleanEnd: true,
			}),
		).toBeUndefined();
	} finally {
		await f.close();
	}
}, 180_000);

test("Pi tool-result reference proof permits reduction without a delivery watermark", async () => {
	const f = await realBridge("pi-tools");
	try {
		const first = entry("u1", "user", "inspect source"),
			call = entry("a1", "assistant", "reading"),
			result = entry("r1", "toolResult", "file contents");
		call.message.content = [
			{ type: "toolCall", id: "call", name: "read", arguments: { z: 1, a: 2 } },
		];
		Object.assign(result.message, {
			toolCallId: "call",
			toolName: "read",
			isError: false,
		});
		await f.adapter.run({
			sessionId: "pi-tools",
			messages: [first],
			host,
			kind: "model",
		});
		const messages = [
			first,
			call,
			result,
			entry("u2", "user", "next independent turn"),
		];
		const view = await f.adapter.run({
			sessionId: "pi-tools",
			messages,
			host,
			kind: "model",
		});
		expect(JSON.stringify(view.messages.find((m) => m.id === "r1"))).toContain(
			"§",
		);
		const inputs = {
			messages,
			model: "fixture/model",
			envelope: "system+tools",
			contextWindow: 100_000,
			systemPromptTokens: 10,
			toolDefinitionTokens: 0,
		};
		expect(f.adapter.isFallbackAdmissible("pi-tools", inputs).admissible).toBe(
			true,
		);
		expect(
			f.adapter.isFallbackAdmissible("pi-tools", {
				...inputs,
				messages: [
					...messages,
					{
						message: {
							role: "user",
							content: "unidentified live tail must not disappear",
						},
					},
				],
			}).admissible,
		).toBe(false);
		f.adapter.recordProviderUsage("pi-tools", {
			messages: view.messages,
			inputTokens: 500,
			model: inputs.model,
			envelope: inputs.envelope,
		});
		expect(f.adapter.isFallbackAdmissible("pi-tools", inputs).admissible).toBe(
			true,
		);
		expect(
			f.adapter.isFallbackAdmissible("pi-tools", {
				...inputs,
				contextWindow: 1,
			}).admissible,
		).toBe(false);
		// Direct usage reports derive the envelope reading only for a successful
		// response whose material is given, as provider_response facts do.
		const material = {
			system: [host.system],
			tools: [],
			unobserved_tools: ["read"],
		};
		const withMaterial = { ...inputs, material };
		const report = (outcome?: "success" | "failed") =>
			f.adapter.recordProviderUsage("pi-tools", {
				messages: view.messages,
				inputTokens: 500,
				model: inputs.model,
				envelope: inputs.envelope,
				material,
				...(outcome ? { outcome } : {}),
			});
		for (const outcome of [undefined, "failed"] as const) {
			report(outcome);
			expect(
				f.adapter.isFallbackAdmissible("pi-tools", withMaterial),
			).toMatchObject({
				admissible: false,
				detail: expect.stringContaining("native-marker-evidence-unavailable"),
			});
		}
		report("success");
		expect(
			f.adapter.isFallbackAdmissible("pi-tools", withMaterial).admissible,
		).toBe(true);
		const tag = JSON.stringify(view.messages.find((m) => m.id === "r1")).match(
			/§(\d+)§/,
		);
		expect(tag).not.toBeNull();
		const reduction = JSON.parse(
			await f.oracle.call({
				name: "ctx_reduce",
				arguments: { drop: tag?.[1] },
			}),
		);
		expect(JSON.stringify(reduction)).toContain("1 tag stamped.");
		const unchanged = await f.adapter.run({
			sessionId: "pi-tools",
			messages,
			host,
			kind: "model",
		});
		expect(JSON.stringify(unchanged.messages)).toBe(
			JSON.stringify(view.messages),
		);
		const rebuilt = await f.adapter.run({
			sessionId: "pi-tools",
			messages,
			host: { ...host, system: "New natural prompt identity" },
			kind: "model",
		});
		expect(JSON.stringify(rebuilt.messages)).not.toContain("file contents");
		expect(rebuilt.receipt.served_through_ordinal).toBe(0);
	} finally {
		await f.close();
	}
}, 180_000);

test("Pi adapter defers a native cut when the fresh pass has no covering applied view", async () => {
	const first = entry("u1", "user", "covered first"),
		tail = entry("u2", "user", "retained tail"),
		last = entry("u3", "user", "latest turn");
	const journal: unknown[] = [first, tail, last];
	let appends = 0;
	const f = await realBridge("pi-native", () => ({
		readBranchEntries: () => journal,
		appendCompaction: (summary, firstKeptEntryId, tokensBefore) => {
			journal.push({
				type: "compaction",
				id: "native-cut",
				firstKeptEntryId,
				summary,
				tokensBefore,
			});
			appends++;
			if (appends === 1)
				throw new Error("Lost host append result after commit");
			return "native-cut";
		},
	}));
	const db = new Database(join(f.options.storageDir, "context.db"));
	try {
		await f.adapter.run({
			sessionId: "pi-native",
			messages: [first],
			host,
			kind: "model",
		});
		const before = await f.adapter.run({
			sessionId: "pi-native",
			messages: [first, tail, last],
			host,
			kind: "model",
		});
		f.adapter.completeRequest("pi-native", before.receipt.request_id, {
			status: 200,
			cleanEnd: true,
		});
		appendCompartments(db, "pi-native", [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 1,
				startMessageId: "u1",
				endMessageId: "u1",
				title: "Covered history",
				content: "Summary of the first message.",
			},
		]);
		setPendingPiCompactionMarkerState(db, "pi-native", {
			firstKeptEntryId: "u2",
			endMessageId: "u1",
			ordinal: 1,
			tokensBefore: 10,
			summary: "Covered history",
			publishedAt: 1,
		});
		const view = await f.adapter.run({
			sessionId: "pi-native",
			messages: [first, tail, last],
			host: { ...host, system: "Changed system" },
			kind: "model",
		});
		expect(view.receipt.coverage).toBeUndefined();
		const receipt = f.adapter.completeRequest(
			"pi-native",
			view.receipt.request_id,
			{ status: 200, cleanEnd: true },
		);
		expect(receipt).toBeDefined();
		const inputs = {
			messages: [first, tail, last],
			model: "fixture/model",
			envelope: "system+tools",
			contextWindow: 100_000,
			systemPromptTokens: 10,
			toolDefinitionTokens: 0,
		};
		expect(
			f.adapter.advanceNativeMarker("pi-native", receipt!, inputs).kind,
		).toBe("deferred");
		expect(appends).toBe(0);
		expect(f.adapter.isFallbackAdmissible("pi-native", inputs).admissible).toBe(
			true,
		);
	} finally {
		db.close();
		await f.close();
	}
}, 180_000);

test("Pi bridge session with unobserved tools waits for a matching provider usage reading, then advances the native marker", async () => {
	const first = entry("u1", "user", "covered first"),
		tail = entry("u2", "user", "retained tail"),
		last = entry("u3", "user", "latest turn");
	const journal: unknown[] = [first, tail, last];
	let appends = 0;
	const f = await realBridge("pi-unobserved", () => ({
		readBranchEntries: () => journal,
		appendCompaction: (summary, firstKeptEntryId, tokensBefore) => {
			journal.push({
				type: "compaction",
				id: "native-cut",
				firstKeptEntryId,
				summary,
				tokensBefore,
			});
			appends++;
			return "native-cut";
		},
	}));
	const db = new Database(join(f.options.storageDir, "context.db"));
	const session = "pi-unobserved";
	const run = (messages: PiBridgeEntry[], system = host.system) =>
		f.adapter.run({
			sessionId: session,
			messages,
			host: { ...host, system },
			kind: "model",
		});
	const clean = (requestId: string) =>
		f.adapter.completeRequest(session, requestId, {
			status: 200,
			cleanEnd: true,
		});
	try {
		// The same pass sequence as the relay-pi-v1 vectors, whose compacted view
		// carries the coverage a native cut needs.
		await run([first]);
		await run([first, tail]);
		await run([first, tail]);
		f.timeout();
		const frozen = await run([first, tail, last]);
		f.resume();
		clean(frozen.receipt.request_id);
		appendCompartments(db, session, [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 1,
				startMessageId: "u1",
				endMessageId: "u1",
				title: "Covered history",
				content: "Summary of the first message.",
			},
		]);
		setPendingPiCompactionMarkerState(db, session, {
			firstKeptEntryId: "u2",
			endMessageId: "u1",
			ordinal: 1,
			tokensBefore: 10,
			summary: "Covered history",
			publishedAt: 1,
		});
		const compacted = await run(
			[first, tail, last],
			"A natural system change.",
		);
		const receipt = clean(compacted.receipt.request_id);
		expect(receipt?.coverage).toEqual({ end_mid: "u1", ordinal: 1 });
		// Pi's built-in tools: the host sees their names but not their final schemas.
		const material = {
			system: ["A natural system change."],
			tools: [
				{
					name: "ctx_search",
					description: "Search",
					inputSchema: { type: "object" },
				},
			],
			unobserved_tools: ["bash", "read"],
		};
		const inputs = {
			messages: [first, tail, last],
			model: "fixture/model",
			envelope: "system+tools",
			contextWindow: 100_000,
			material,
		};
		const evidenceMissing = {
			admissible: false,
			reason: "fit_unproven",
			detail: expect.stringContaining("native-marker-evidence-unavailable"),
		};
		const waits = () => {
			expect(f.adapter.isFallbackAdmissible(session, inputs)).toMatchObject(
				evidenceMissing,
			);
			expect(
				f.adapter.advanceNativeMarker(session, receipt!, inputs),
			).toMatchObject({ kind: "deferred", reason: "fit-unproven" });
			expect(appends).toBe(0);
		};
		// No usage reading at all: nothing bounds the unobserved tool schemas, so
		// the native marker waits.
		waits();
		let observedAt = Date.now();
		const respond = async (
			served: typeof material,
			usage = { input: 900, cacheRead: 5000, cacheWrite: 100, output: 50 },
			outcome: "success" | "failed" = "success",
		) =>
			await f.adapter.recordHostFact({
				kind: "provider_response",
				sessionId: session,
				lineageId: receipt!.lineage_id,
				requestId: receipt!.request_id,
				model: { providerID: "fixture", modelID: "model" },
				observedAt: ++observedAt,
				completedAt: observedAt - 1,
				finishReason: "stop",
				outcome,
				contextWindow: 100_000,
				material: served,
				usage,
			});
		// A total input of 0 is ignored rather than recorded as a reading.
		expect(
			await respond(material, {
				input: 0,
				cacheRead: 0,
				cacheWrite: 0,
				output: 9,
			}),
		).toEqual({ accepted: true });
		waits();
		// Readings taken with another system prompt or another tool set do not qualify.
		for (const served of [
			{ ...material, system: ["Earlier system"] },
			{ ...material, unobserved_tools: ["bash"] },
			{
				...material,
				tools: [
					{ ...material.tools[0]!, inputSchema: { type: "object", v: 2 } },
				],
			},
		]) {
			expect(await respond(served)).toEqual({ accepted: true });
			waits();
		}
		// A failed response may report only partial input usage, so it does not
		// derive an envelope reading.
		expect(await respond(material, undefined, "failed")).toEqual({
			accepted: true,
		});
		waits();
		expect(await respond(material)).toEqual({ accepted: true });
		expect(f.adapter.isFallbackAdmissible(session, inputs).admissible).toBe(
			true,
		);
		// The usage-derived envelope (6000 total input minus served text) must still fit.
		expect(
			f.adapter.advanceNativeMarker(session, receipt!, {
				...inputs,
				contextWindow: 6000,
			}).kind,
		).toBe("deferred");
		expect(appends).toBe(0);
		expect(f.adapter.advanceNativeMarker(session, receipt!, inputs).kind).toBe(
			"applied",
		);
		expect(appends).toBe(1);
	} finally {
		db.close();
		await f.close();
	}
}, 180_000);

test("Pi host-runner import opens no storage and does not construct the extension", async () => {
	const root = join(fixture().storageDir, "import-only");
	mkdirSync(root);
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const api = await import(process.argv[1]); if (typeof api.createPiBridgeAdapter !== "function" || "default" in api) throw new Error("Wrong bridge surface"); console.log("bridge import loaded");`,
			new URL("./host-runner.ts", import.meta.url).href,
		],
		{
			windowsHide: true,
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				XDG_DATA_HOME: root,
				XDG_CONFIG_HOME: root,
				XDG_CACHE_HOME: root,
				MAGIC_CONTEXT_TEST_DATA_DIR: root,
				MAGIC_CONTEXT_STORAGE_DIR: root,
				OPENCODE_DB: join(root, "no-opencode.db"),
			},
		},
	);
	const [stdout, stderr, status] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
	expect(stdout).toContain("bridge import loaded");
	expect(readdirSync(root)).toEqual([]);
});

test("Pi bridge refuses an unmigrated database by default before contacting the relay", async () => {
	const options = fixture();
	const db = new Database(join(options.storageDir, "context.db"));
	db.exec("DELETE FROM schema_migrations WHERE version < 10000");
	db.close();
	let requests = 0;
	await expect(
		createPiBridgeAdapter({
			...options,
			transport: {
				async request() {
					requests++;
					throw new Error("Unexpected relay request");
				},
			},
		}),
	).rejects.toBeInstanceOf(StoreVersionMismatchError);
	expect(requests).toBe(0);
});

test("Pi replacement admission accepts separate tool results without widening OpenCode admission", () => {
	const result = entry("r1", "toolResult", "retained result");
	Object.assign(result.message, { toolCallId: "call", toolName: "read" });
	const message = projectPiEntry(result);
	const codec = piProviderCodec(
		() => "",
		() => [],
	);
	expect(providerReplacementValid(message, "pi", codec.incoming)).toBe(true);
	expect(providerReplacementValid(message, "opencode", codec.incoming)).toBe(
		false,
	);
	expect(providerReplacementValid(message, "opencode2", codec.incoming)).toBe(
		false,
	);
	const call = projectPiEntry({
		...entry("a1", "assistant", ""),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
		},
	});
	const record = createRecord({
		lineage_id: "lineage",
		plan: {},
		initial: {
			compaction_id: "view",
			version: 0,
			range: { from: 0, to: 0 },
			replacement: [call, message],
		},
	});
	record.next_ordinal = 3;
	issueRequest(record, "request", 100);
	const accepted = applyCompaction(
		record,
		{
			request_id: "request",
			arrived_ms: 1,
			compaction: {
				compaction_id: "view",
				version: 1,
				range: { from: 1, to: 3 },
				replacement: [call, message],
			},
		},
		(rows) =>
			rows.every((row) => providerReplacementValid(row, "pi", codec.incoming)),
	);
	expect(accepted.applied).toBe(true);
	expect(record.view.replacement[1]?.info.role).toBe("tool");
	expect(
		providerReplacementValid(message, "pi", () => ({
			id: "r1",
			read: () => message,
			classify: () => "non_terminal",
		})),
	).toBe(false);
});

test("Pi native compaction summaries are markers, not newly ingested user text", () => {
	const marker = {
		...entry("native-cut", "user", "native placeholder must not be sent"),
		type: "compaction",
	};
	const user = entry("u1", "user", "retained user");
	const codec = piProviderCodec(
		() => "",
		() => [],
	);
	const record = createRecord({
		lineage_id: "lineage",
		plan: {},
		initial: {
			compaction_id: "initial",
			version: 0,
			range: { from: 0, to: 0 },
			replacement: [],
		},
	});
	const scan = scanWindow(
		record,
		[marker, user].map((m) => codec.incoming(projectPiEntry(m))),
	);
	expect(scan.elided).toEqual(["native-cut"]);
	expect(scan.appends.map((m) => m.id)).toEqual(["u1"]);
	expect(scan.passthrough).toEqual([]);
});
