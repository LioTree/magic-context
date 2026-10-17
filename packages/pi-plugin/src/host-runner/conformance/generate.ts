import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { setPendingPiCompactionMarkerState } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { startOracle } from "@magic-context/core/hooks/magic-context/host-runner/conformance/oracle";
import { Database } from "@magic-context/core/shared/sqlite";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import type { PiBridgeEntry } from "../../bridge-codec-pi";
import { createPiBridgeAdapter } from "../../host-runner";
import { createTestDb } from "../../test-utils.test";

export const PI_VECTOR_PATH = new URL(
	"../../../../plugin/src/hooks/magic-context/host-runner/conformance/vectors/relay-pi-v1.json",
	import.meta.url,
);

/** Exercise the public Pi adapter; expected digests come from actual module replies, not a second renderer. */
export async function generatePiVectors() {
	const parent = join(tmpdir(), "magic-context/pi-bridge");
	mkdirSync(parent, { recursive: true });
	const root = createTestTempDirFromPath(join(parent, "vectors-"));
	const savedEnv = { ...process.env };
	Object.assign(process.env, {
		XDG_DATA_HOME: join(root, "data"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_CACHE_HOME: join(root, "cache"),
		MAGIC_CONTEXT_STORAGE_DIR: join(root, "mc"),
		MAGIC_CONTEXT_TEST_DATA_DIR: join(root, "data"),
		OPENCODE_DB: join(root, "no-opencode.db"),
	});
	createTestDb(join(root, "context.db")).close();
	const oracle = startOracle({ contextRoot: root });
	const configPath = join(root, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			memory: { enabled: false },
			historian: { runner: "broca", disable: true },
		}),
	);
	const entry = (id: string, text: string): PiBridgeEntry => ({
		type: "message",
		id,
		parentId: null,
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	});
	const u1 = entry("pi-entry-001", "Covered user."),
		u2 = entry("pi-entry-002", "Retained user."),
		u3 = entry("pi-entry-003", "Timeout raw bytes.");
	const journal: unknown[] = [u1, u2, u3];
	let timeout = false,
		appends = 0;
	const methods: string[] = [];
	await oracle.call({ control: "bind", harness: "pi", session: "relay-pi-v1" });
	const adapter = await createPiBridgeAdapter({
		projectRoot: root,
		connectionFile: join(root, "unused.json"),
		storageDir: root,
		configPath,
		reloadSession: () => ({
			readBranchEntries: () => journal,
			appendCompaction: (summary, firstKeptEntryId, tokensBefore) => {
				journal.push({
					type: "compaction",
					id: "pi-native-cut",
					summary,
					firstKeptEntryId,
					tokensBefore,
				});
				appends++;
				throw new Error("Committed append result lost");
			},
		}),
		transport: {
			async request(method, body, opts) {
				methods.push(method);
				const answer = await oracle.call(
					JSON.parse(Buffer.from(body).toString()),
				);
				const decoded = JSON.parse(answer);
				if (decoded.oracle_error) throw decoded.oracle_error;
				if (timeout && method === "transform.hook")
					return await new Promise<Uint8Array>((_resolve, reject) => {
						const aborted = () => reject({ source: "relay", code: "aborted" });
						if (opts.signal?.aborted) aborted();
						else
							opts.signal?.addEventListener("abort", aborted, { once: true });
					});
				return Buffer.from(answer);
			},
		},
	});
	const host = {
		model: { provider: "fixture", id: "model" },
		contextWindow: 100_000,
		system: "Pi conformance system.",
		tools: [],
	};
	const aliases = new Map<string, string>();
	const normalize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(normalize);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, v]) => {
					if (
						["request_id", "lineage_id", "compaction_id"].includes(key) &&
						typeof v === "string"
					) {
						if (!aliases.has(v)) aliases.set(v, `identity-${aliases.size + 1}`);
						return [key, aliases.get(v)];
					}
					return [key, normalize(v)];
				}),
			);
		return value;
	};
	const cases: { id: string; expected: unknown }[] = [];
	const snapshot = (id: string, value: unknown) => {
		cases.push({ id, expected: normalize(value) });
	};
	const digest = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const run = async (
		messages: PiBridgeEntry[],
		system = host.system,
		sessionId = "relay-pi-v1",
	) => {
		try {
			return await adapter.run({
				sessionId,
				messages,
				host: { ...host, system },
				kind: "model",
			});
		} catch (error) {
			const cause = (error as Error).cause as { message?: string } | undefined;
			throw new Error(
				`Pi vector pass ${sessionId} (${messages.map((m) => m.id).join(",")}): ${cause?.message ?? String(error)}`,
				{ cause: error },
			);
		}
	};
	const db = new Database(join(root, "context.db"));
	try {
		await run([u1]);
		const first = await run([u1, u2]);
		const hooks = methods.filter((m) => m === "transform.hook").length;
		const retry = await run([u1, u2]);
		assert.equal(digest(first.messages), digest(retry.messages));
		assert.equal(methods.filter((m) => m === "transform.hook").length, hooks);
		snapshot("single-op-retry", {
			wire_sha256: digest(retry.messages),
			receipt: retry.receipt,
			hook_calls: hooks,
		});
		timeout = true;
		const frozen = await run([u1, u2, u3]);
		timeout = false;
		assert.deepEqual(
			frozen.messages.find((m) => m.id === u3.id),
			u3,
		);
		snapshot("hook-timeout-fallback-freeze", {
			wire_sha256: digest(frozen.messages),
			receipt: frozen.receipt,
		});
		const headers = adapter.completeRequest(
			"relay-pi-v1",
			frozen.receipt.request_id,
			{ status: 200, cleanEnd: false },
		);
		const complete = adapter.completeRequest(
			"relay-pi-v1",
			frozen.receipt.request_id,
			{ status: 200, cleanEnd: true },
		);
		assert.equal(headers?.served_through_ordinal, 0);
		assert.equal(complete?.served_through_ordinal, 3);
		snapshot("receipt-publish-and-complete", {
			pending: frozen.receipt,
			headers,
			complete,
		});
		appendCompartments(db, "relay-pi-v1", [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 1,
				startMessageId: u1.id!,
				endMessageId: u1.id!,
				title: "Covered history",
				content: "Covered first user.",
			},
		]);
		setPendingPiCompactionMarkerState(db, "relay-pi-v1", {
			firstKeptEntryId: u2.id!,
			endMessageId: u1.id!,
			ordinal: 1,
			tokensBefore: 20,
			summary: "Covered history",
			publishedAt: 1,
		});
		const compacted = await run([u1, u2, u3], "A natural system change.");
		const receipt = adapter.completeRequest(
			"relay-pi-v1",
			compacted.receipt.request_id,
			{ status: 200, cleanEnd: true },
		);
		assert(receipt);
		const fit = {
			messages: [u1, u2, u3],
			model: "fixture/model",
			envelope: "system+tools",
			contextWindow: 100_000,
			systemPromptTokens: 20,
			toolDefinitionTokens: 0,
		};
		const uncertain = adapter.advanceNativeMarker("relay-pi-v1", receipt, fit);
		const recovered = adapter.advanceNativeMarker("relay-pi-v1", receipt, fit);
		assert.equal(uncertain.kind, "unknown");
		assert.equal(recovered.kind, "applied");
		assert.equal(appends, 1);
		snapshot("native-cut-applied-and-recovered", {
			receipt,
			uncertain,
			recovered,
			appends,
			wire_sha256: digest(compacted.messages),
		});
		const right = entry("pi-tree-right", "Selected /tree branch.");
		journal.splice(0, journal.length, u1, right);
		const tree = await run([u1, right], "A natural system change.");
		assert.notEqual(tree.receipt.lineage_id, receipt.lineage_id);
		snapshot("tree-branch-switch", {
			receipt: tree.receipt,
			wire_sha256: digest(tree.messages),
		});
		await oracle.call({
			control: "bind",
			harness: "pi",
			session: "relay-pi-fork",
		});
		const fork = await run([u1, right], host.system, "relay-pi-fork");
		assert.notEqual(fork.receipt.lineage_id, tree.receipt.lineage_id);
		snapshot("forked-session", {
			receipt: fork.receipt,
			wire_sha256: digest(fork.messages),
			kind: fork.kind,
		});
		return {
			schema: "mc-relay-pi/v1",
			generator: {
				version: 1,
				source_base: "919bc9862839c3c1820b4e673e3ba210782a1d7c",
				oracle: "providers::relay_conformance::oracle",
			},
			cases,
		};
	} finally {
		db.close();
		await adapter.dispose();
		await oracle.close();
		for (const key of Object.keys(process.env))
			if (!(key in savedEnv)) delete process.env[key];
		Object.assign(process.env, savedEnv);
		cleanupTestTempDir(root);
	}
}

if (import.meta.main) {
	const bytes = `${JSON.stringify(await generatePiVectors(), null, 4)}\n`;
	if (process.argv.includes("--write")) {
		mkdirSync(new URL(".", PI_VECTOR_PATH), { recursive: true });
		writeFileSync(PI_VECTOR_PATH, bytes);
	} else if (process.argv.includes("--print")) console.log(bytes);
	else
		assert.equal(
			readFileSync(PI_VECTOR_PATH, "utf8"),
			bytes,
			"relay-pi-v1.json drift; regenerate with --write",
		);
}
