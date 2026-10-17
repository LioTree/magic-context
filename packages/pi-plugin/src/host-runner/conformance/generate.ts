import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { setPendingPiCompactionMarkerState } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import type { BridgeRequestCompletion } from "@magic-context/core/hooks/magic-context/host-runner/bridge-receipt";
import type { Exchange } from "@magic-context/core/hooks/magic-context/host-runner/conformance/format";
import { startOracle } from "@magic-context/core/hooks/magic-context/host-runner/conformance/oracle";
import { Database } from "@magic-context/core/shared/sqlite";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import type { PiBridgeEntry } from "../../bridge-codec-pi";
import { createPiBridgeAdapter } from "../../host-runner";
import { createTestDb } from "../../test-utils.test";

/** Same field names and meaning as relay-v1's exchange: exact request and MC answer bytes. */
export type { Exchange };

/** Fit inputs as given to the adapter, with each host entry reduced to its ID. */
type PiFitAction = {
	messages: (string | undefined)[];
	model: string;
	envelope: string;
	contextWindow: number;
	systemPromptTokens: number;
	toolDefinitionTokens: number;
};

/** One host-visible operation on the Pi adapter, or a control call to the MC oracle. */
export type PiAction =
	| { kind: "bind"; harness: "pi"; session: string }
	| {
			kind: "run";
			session: string;
			system: string;
			entries: PiBridgeEntry[];
			/** MC still answers every hook; the relay withholds each answer past its deadline. */
			fault?: { method: "transform.hook"; mode: "timeout" };
	  }
	| ({
			kind: "delivery";
			session: string;
			request_id: string;
	  } & BridgeRequestCompletion)
	| PublishAction
	| {
			kind: "native_marker";
			session: string;
			request_id: string;
			fit: PiFitAction;
	  }
	| { kind: "fallback_check"; session: string; fit: PiFitAction }
	| { kind: "branch"; entries: (string | undefined)[] };

/** relay-v1's step shape; Pi outcomes stay in each case's single `expected` block. */
export type PiVectorStep = { action: PiAction; exchanges: Exchange[] };
export type PiVectorCase = {
	id: string;
	steps: PiVectorStep[];
	expected: unknown;
};
export type PiVectorFile = {
	schema: "mc-relay-pi/v1";
	generator: { version: 1; source_base: string; oracle: string };
	cases: PiVectorCase[];
};

/** Historian output written to the shared context.db: one compartment plus its pending native cut. */
export type PublishAction = {
	kind: "publish";
	session: string;
	compartment: Parameters<typeof appendCompartments>[2][number];
	pending_marker: Parameters<typeof setPendingPiCompactionMarkerState>[2];
};

/** MC reads compartments from the same context.db, so generation and replay seed it identically. */
function seedPublishedHistory(db: Database, action: PublishAction) {
	appendCompartments(db, action.session, [action.compartment]);
	setPendingPiCompactionMarkerState(db, action.session, action.pending_marker);
}

/**
 * Send only the recorded request bytes, in file order, to a fresh MC oracle; every answer must
 * equal its recorded bytes exactly. Cases share one session, so a replay always runs them all.
 * Besides exchanges, only `bind` (an oracle control) and `publish` (a context.db seed) change
 * what MC answers; deliveries, native markers and fit checks stay inside the adapter.
 */
export async function replayPiExchanges(
	vectors: PiVectorFile,
	call: (request: unknown) => Promise<string>,
	publish: (action: PublishAction) => void,
): Promise<number> {
	assert.equal(vectors.schema, "mc-relay-pi/v1");
	let replayed = 0;
	for (const vector of vectors.cases)
		for (const [index, step] of vector.steps.entries()) {
			if (step.action.kind === "bind")
				await call({
					control: "bind",
					harness: step.action.harness,
					session: step.action.session,
				});
			if (step.action.kind === "publish") publish(step.action);
			for (const [n, exchange] of step.exchanges.entries()) {
				const where = `${vector.id} step ${index} exchange ${n} (${exchange.method})`;
				const request = JSON.parse(exchange.request_bytes);
				assert.equal(request.method, exchange.method, `${where}: method`);
				assert.equal(
					await call(request),
					exchange.answer_bytes,
					`${where}: MC answer bytes differ`,
				);
				replayed++;
			}
		}
	return replayed;
}

/**
 * Replay against the real McHandler in a throwaway root under
 * `$TMPDIR/magic-context/relay-pi-exchanges/`. The oracle only accepts a Pi store under its own
 * temp directory's `magic-context/pi-bridge`, so the child's TMPDIR is pointed at that root.
 */
export async function replayPiExchangesAgainstMc(
	vectors: PiVectorFile,
): Promise<number> {
	const parent = join(tmpdir(), "magic-context/relay-pi-exchanges");
	mkdirSync(parent, { recursive: true });
	const root = createTestTempDirFromPath(join(parent, "replay-"));
	const store = join(root, "magic-context/pi-bridge/store");
	mkdirSync(store, { recursive: true });
	createTestDb(join(store, "context.db")).close();
	const savedTmp = process.env.TMPDIR;
	process.env.TMPDIR = root;
	const oracle = startOracle({ contextRoot: store });
	if (savedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = savedTmp;
	const db = new Database(join(store, "context.db"));
	try {
		return await replayPiExchanges(vectors, oracle.call, (action) =>
			seedPublishedHistory(db, action),
		);
	} finally {
		db.close();
		await oracle.close();
		cleanupTestTempDir(root);
	}
}

export const PI_VECTOR_PATH = new URL(
	"../../../../plugin/src/hooks/magic-context/host-runner/conformance/vectors/relay-pi-v1.json",
	import.meta.url,
);

const STABLE_PREFIX = {
	request_id: "pi-request",
	lineage_id: "pi-lineage",
	seed_id: "pi-seed",
} as const;
type StableKey = keyof typeof STABLE_PREFIX;

/**
 * The adapter mints random UUIDs and reads the wall clock, so its raw request bytes differ on
 * every run. The harness transport swaps them for numbered stand-ins before MC sees a request
 * and swaps the IDs back in each answer, the way relay-v1's fake relay injects request IDs and a
 * logical clock. MC therefore receives, hashes and answers only the recorded bytes, which is
 * what lets a replay against a fresh MC reproduce every answer byte for byte.
 */
function stableWireIdentities() {
	const stable = new Map<string, string>();
	const counts = new Map<StableKey, number>();
	const clock = new Map<number, number>();
	const id = (key: StableKey, raw: string) => {
		let value = stable.get(raw);
		if (!value) {
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			value = `${STABLE_PREFIX[key]}-${String(count).padStart(4, "0")}`;
			stable.set(raw, value);
		}
		return value;
	};
	const collect = (
		value: unknown,
		ids: [StableKey, string][],
		nows: number[],
	) => {
		if (Array.isArray(value))
			for (const item of value) collect(item, ids, nows);
		else if (value && typeof value === "object")
			for (const [key, item] of Object.entries(value)) {
				if (key in STABLE_PREFIX && typeof item === "string")
					ids.push([key as StableKey, item]);
				else if (key === "now" && typeof item === "number") nows.push(item);
				else collect(item, ids, nows);
			}
	};
	return {
		id,
		/** Rewrite only the identity and clock tokens, leaving every other request byte as sent. */
		toModule(bytes: string) {
			const ids: [StableKey, string][] = [];
			const nows: number[] = [];
			collect(JSON.parse(bytes), ids, nows);
			let out = bytes;
			for (const [key, raw] of ids)
				out = out.replaceAll(JSON.stringify(raw), JSON.stringify(id(key, raw)));
			for (const raw of nows) {
				if (!clock.has(raw)) clock.set(raw, 1_000 + clock.size);
				out = out.replaceAll(`"now":${raw},`, `"now":${clock.get(raw)},`);
				out = out.replaceAll(`"now":${raw}}`, `"now":${clock.get(raw)}}`);
			}
			const leaked = [...ids.map(([, raw]) => raw), ...nows.map(String)].find(
				(raw) => out.includes(raw),
			);
			assert.equal(leaked, undefined, "a run-specific value reached MC");
			return out;
		},
		/** Give the adapter back its own IDs; MC-minted values such as compaction IDs pass unchanged. */
		toAdapter(bytes: string) {
			let out = bytes;
			for (const [raw, value] of stable)
				out = out.replaceAll(JSON.stringify(value), JSON.stringify(raw));
			return out;
		},
	};
}

/** Exercise the public Pi adapter; expected digests come from actual module replies, not a second renderer. */
export async function generatePiVectors(): Promise<PiVectorFile> {
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
	const wire = stableWireIdentities();
	let trace: Exchange[] = [];
	let steps: PiVectorStep[] = [];
	/** Record one host-visible operation and every provider exchange it caused, in call order. */
	const step = async <T>(
		action: PiAction,
		act: () => T | Promise<T>,
	): Promise<T> => {
		trace = [];
		const result = await act();
		steps.push({ action, exchanges: trace });
		trace = [];
		return result;
	};
	const bind = (session: string) =>
		step({ kind: "bind", harness: "pi", session }, () =>
			oracle.call({ control: "bind", harness: "pi", session }),
		);
	await bind("relay-pi-v1");
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
				const requestBytes = wire.toModule(Buffer.from(body).toString("utf8"));
				const moduleAnswer = await oracle.call(JSON.parse(requestBytes));
				trace.push({
					method: method as Exchange["method"],
					request_bytes: requestBytes,
					answer_bytes: moduleAnswer,
					// MC has already answered; a timeout only withholds the answer from the adapter.
					delivery:
						timeout && method === "transform.hook" ? "timeout" : "answer",
				});
				const answer = wire.toAdapter(moduleAnswer);
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
	const cases: PiVectorCase[] = [];
	/** A case owns every step recorded since the previous case: the cases form one ordered session. */
	const snapshot = (id: string, value: unknown) => {
		cases.push({ id, steps, expected: normalize(value) });
		steps = [];
	};
	const digest = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const run = (
		messages: PiBridgeEntry[],
		system = host.system,
		sessionId = "relay-pi-v1",
	) =>
		step(
			{
				kind: "run",
				session: sessionId,
				system,
				entries: messages,
				...(timeout
					? { fault: { method: "transform.hook", mode: "timeout" } as const }
					: {}),
			},
			async () => {
				try {
					return await adapter.run({
						sessionId,
						messages,
						host: { ...host, system },
						kind: "model",
					});
				} catch (error) {
					const cause = (error as Error).cause as
						| { message?: string }
						| undefined;
					throw new Error(
						`Pi vector pass ${sessionId} (${messages.map((m) => m.id).join(",")}): ${cause?.message ?? String(error)}`,
						{ cause: error },
					);
				}
			},
		);
	const deliver = (requestId: string, completion: BridgeRequestCompletion) =>
		step(
			{
				kind: "delivery",
				session: "relay-pi-v1",
				request_id: wire.id("request_id", requestId),
				...completion,
			},
			() => adapter.completeRequest("relay-pi-v1", requestId, completion),
		);
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
		const headers = await deliver(frozen.receipt.request_id, {
			status: 200,
			cleanEnd: false,
		});
		const complete = await deliver(frozen.receipt.request_id, {
			status: 200,
			cleanEnd: true,
		});
		assert.equal(headers?.served_through_ordinal, 0);
		assert.equal(complete?.served_through_ordinal, 3);
		snapshot("receipt-publish-and-complete", {
			pending: frozen.receipt,
			headers,
			complete,
		});
		const compartment = {
			sequence: 0,
			startMessage: 1,
			endMessage: 1,
			startMessageId: u1.id!,
			endMessageId: u1.id!,
			title: "Covered history",
			content: "Covered first user.",
		};
		const pendingMarker = {
			firstKeptEntryId: u2.id!,
			endMessageId: u1.id!,
			ordinal: 1,
			tokensBefore: 20,
			summary: "Covered history",
			publishedAt: 1,
		};
		// Historian output lands in the shared context.db that both the adapter and MC read.
		const publish: PublishAction = {
			kind: "publish",
			session: "relay-pi-v1",
			compartment,
			pending_marker: pendingMarker,
		};
		await step(publish, () => seedPublishedHistory(db, publish));
		const compacted = await run([u1, u2, u3], "A natural system change.");
		const receipt = await deliver(compacted.receipt.request_id, {
			status: 200,
			cleanEnd: true,
		});
		assert(receipt);
		const fit = {
			messages: [u1, u2, u3],
			model: "fixture/model",
			envelope: "system+tools",
			contextWindow: 100_000,
			systemPromptTokens: 20,
			toolDefinitionTokens: 0,
		};
		const fitAction = (inputs: typeof fit) => ({
			...inputs,
			messages: inputs.messages.map((message) => message.id),
		});
		const advance = () =>
			step(
				{
					kind: "native_marker",
					session: "relay-pi-v1",
					request_id: wire.id("request_id", receipt.request_id),
					fit: fitAction(fit),
				},
				() => adapter.advanceNativeMarker("relay-pi-v1", receipt, fit),
			);
		const uncertain = await advance();
		const recovered = await advance();
		assert.equal(uncertain.kind, "unknown");
		assert.equal(recovered.kind, "applied");
		assert.equal(appends, 1);
		const marker = {
			...entry("pi-native-cut", "Native placeholder, not provider history."),
			type: "compaction",
		};
		const resumed = await run([marker, u2, u3], "A natural system change.");
		assert.equal(digest(resumed.messages), digest(compacted.messages));
		const resumedFit = { ...fit, messages: [marker, u2, u3] };
		const admission = await step(
			{
				kind: "fallback_check",
				session: "relay-pi-v1",
				fit: fitAction(resumedFit),
			},
			() => adapter.isFallbackAdmissible("relay-pi-v1", resumedFit),
		);
		assert.equal(admission.admissible, true);
		// Recorded after the resumed pass so the case carries the recovery's exchanges too.
		snapshot("native-cut-applied-and-recovered", {
			receipt,
			uncertain,
			recovered,
			appends,
			wire_sha256: digest(compacted.messages),
		});
		const right = entry("pi-tree-right", "Selected /tree branch.");
		await step({ kind: "branch", entries: [u1.id, right.id] }, () =>
			journal.splice(0, journal.length, u1, right),
		);
		const tree = await run([u1, right], "A natural system change.");
		assert.notEqual(tree.receipt.lineage_id, receipt.lineage_id);
		snapshot("tree-branch-switch", {
			receipt: tree.receipt,
			wire_sha256: digest(tree.messages),
		});
		await bind("relay-pi-fork");
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
