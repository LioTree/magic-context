import { afterEach, describe, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { queueM0Mutation } from "@magic-context/core/features/magic-context/storage-m0-mutation-log";
import { DegradedPassRefusalError } from "@magic-context/core/hooks/magic-context/degraded-pass-refusal";
import {
	firstKeptDigest,
	readServedPrefix,
	writeServedPrefix,
} from "@magic-context/core/hooks/magic-context/served-prefix";
import {
	servedMessageDigest,
	wholeMessageDigest,
} from "../../plugin/src/hooks/magic-context/__tests__/served-prefix-evidence";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { providerVisiblePiPart } from "./provider-visible-parts-pi";
import { PiPrefixPass } from "./served-prefix-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const model = {
	provider: "anthropic",
	id: "claude-opus-5-5",
	api: "anthropic-messages",
	contextWindow: 100_000,
};
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const thought = (sig: string) => ({
	type: "thinking",
	thinking: `Thought ${sig}`,
	thinkingSignature: sig,
});

// The first-kept digest lives in core and cannot import this package's
// provider-visible view, so this test keeps the two field lists from drifting:
// every leaf the Pi view sends must also change the digest.
it("Pi first-kept digest covers every field of the Pi provider-visible view", () => {
	const message = {
		role: "toolResult",
		provider: "anthropic",
		api: "anthropic-messages",
		model: "opus",
		stopReason: "toolUse",
		toolCallId: "call",
		toolName: "bash",
		isError: false,
		content: [
			{ type: "text", text: "Answer", textSignature: "text-sig" },
			{
				type: "thinking",
				thinking: "Thought",
				thinkingSignature: "sig",
				redacted: false,
			},
			{ type: "image", data: "AA==", mimeType: "image/png" },
			{
				type: "toolCall",
				id: "call",
				name: "bash",
				arguments: { command: "pwd" },
				thoughtSignature: "thought-sig",
				namespace: "ns",
			},
		],
	};
	const provenance = {
		host: "pi",
		id_space: "pi",
		generation: "pi",
		projection: "messages",
		model,
	} as const;
	const leaves = (value: unknown, path: string[] = []): string[][] =>
		value !== null && typeof value === "object"
			? Object.entries(value).flatMap(([key, child]) =>
					leaves(child, [...path, key]),
				)
			: [path];
	const paths = leaves(providerVisiblePiPart(message, model.api));
	expect(paths.length).toBeGreaterThan(20);
	for (const path of paths) {
		const copy = structuredClone(message) as Record<string, any>;
		let parent = copy;
		for (const key of path.slice(0, -1)) parent = parent[key];
		const key = path.at(-1)!;
		parent[key] =
			typeof parent[key] === "boolean" ? !parent[key] : `${parent[key]}-x`;
		expect([path.join("."), firstKeptDigest(copy, provenance)]).not.toEqual([
			path.join("."),
			firstKeptDigest(message, provenance),
		]);
	}
});

function heldFixture() {
	const db = createTestDb();
	const id = "pi-prefix-scope";
	cleanups.push(() => {
		clearContextHandlerSession(id);
		db.close();
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		signedThinkingHold: "on",
		injection: {
			injectionBudgetTokens: 4000,
			memoryEnabled: false,
			injectDocs: false,
		},
	});
	const handler = fake.handlers.get("context")!;
	const raw = [userMessage("Task")];
	const ids = ["turn"];
	const pass = async () => {
		const messages = structuredClone(raw);
		const ctx = { ...fakeContext(id, process.cwd(), ids, messages), model };
		const result = (await handler({ messages } as never, ctx as never)) as {
			messages: unknown[];
		};
		expect(result).toBeDefined();
		return result.messages;
	};
	const thinking = () => {
		raw.push(
			assistantMessage("Current", 2, {
				...model,
				model: model.id,
				content: [thought("active"), { type: "text", text: "Current" }],
			}),
		);
		ids.push("active");
	};
	return { db, id, raw, ids, pass, thinking };
}

it("Pi host-only timestamps serve the fresh held request", async () => {
	const f = heldFixture();
	await f.pass();
	f.thinking();
	const held = await f.pass();
	const record = readServedPrefix(f.db, f.id);
	expect(record?.first_kept?.id).toBe("turn");
	Object.assign(f.raw[0], {
		timestamp: 12345,
		details: { summary: "UI only" },
	});
	f.raw.push(assistantMessage("Fresh request, not last good", 3));
	f.ids.push("fresh");
	const fresh = await f.pass();
	expect(fresh).not.toEqual(held);
	expect(JSON.stringify(fresh)).toContain("Fresh request, not last good");
	expect(readServedPrefix(f.db, f.id)).toEqual(record);
});

it("Pi provider-visible text before kept thinking still refuses", async () => {
	const f = heldFixture();
	await f.pass();
	f.thinking();
	await f.pass();
	const record = readServedPrefix(f.db, f.id);
	expect(record?.first_kept?.id).toBe("turn");
	(f.raw[0] as { content: unknown }).content = "changed provider bytes";
	f.raw.push(assistantMessage("Fresh request, not last good", 3));
	f.ids.push("fresh");
	let failure: unknown;
	try {
		await f.pass();
	} catch (error) {
		failure = error;
	}
	// With no last-good request to fall back to, Pi reports the refusal as a
	// storage-busy error whose cause chain carries the served-prefix refusal.
	const chain = (error: unknown): unknown[] =>
		error instanceof Error ? [error, ...chain(error.cause)] : [];
	expect(
		chain(failure).some(
			(error) =>
				error instanceof DegradedPassRefusalError &&
				error.site === "served-prefix" &&
				error.message.includes("first kept digest mismatch"),
		),
	).toBe(true);
	expect(readServedPrefix(f.db, f.id)).toEqual(record);
});

it("Pi legacy whole-envelope digests wait for a permitted rebuild without a refusal loop", async () => {
	const f = heldFixture();
	const initial = await f.pass();
	const legacy = readServedPrefix(f.db, f.id)!;
	legacy.first_kept!.digest = wholeMessageDigest(initial[legacy.head.length]);
	f.db
		.prepare("UPDATE session_meta SET served_prefix = ? WHERE session_id = ?")
		.run(JSON.stringify(legacy), f.id);
	Object.assign(f.raw[0], { timestamp: 42 });
	f.thinking();
	for (let pass = 0; pass < 2; pass++) {
		expect(JSON.stringify(await f.pass())).toContain("Current");
		expect(readServedPrefix(f.db, f.id)).toEqual(legacy);
	}
	f.raw.push(userMessage("Next task", 3));
	f.ids.push("next");
	await f.pass();
	const rebuilt = readServedPrefix(f.db, f.id)!;
	expect(rebuilt.first_kept!.digest).toStartWith("provider-input-v1:");
	expect(rebuilt.turn).toBe("next");
});

for (const subagent of [false, true])
	describe(`Pi compaction-off ${subagent ? "subagent" : "primary"}`, () => {
		it("holds the head through a HARD and degrades invalid records without raw fallthrough", async () => {
			const db = createTestDb();
			const id = `pi-prefix-off-${subagent}`;
			cleanups.push(() => {
				clearContextHandlerSession(id);
				db.close();
			});
			getOrCreateSessionMeta(db, id);
			updateSessionMeta(db, id, {
				isSubagent: subagent,
				cacheTtl: "59m",
				lastResponseTime: Date.now(),
			});
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				compactionOff: true,
				signedThinkingHold: "on",
				injection: {
					injectionBudgetTokens: 4000,
					memoryEnabled: false,
					injectDocs: false,
				},
			});
			const handler = fake.handlers.get("context");
			if (!handler) throw new Error("Context handler was not registered");
			const raw = [userMessage("Original task")];
			const ids = ["turn"];
			const pass = async () => {
				const messages = structuredClone(raw);
				const ctx = { ...fakeContext(id, process.cwd(), ids, messages), model };
				const output = (await handler({ messages } as never, ctx as never)) as
					| { messages: unknown[] }
					| undefined;
				expect(output).toBeDefined();
				if (!output)
					throw new Error("Compaction-off fell through to raw input");
				return output.messages;
			};
			const initial = await pass();
			const record = readServedPrefix(db, id);
			if (!record)
				throw new Error("First serve did not persist a prefix record");
			expect(record.first_kept?.digest).toBe(
				servedMessageDigest(initial[record.head.length], record.provenance),
			);
			const head = initial.slice(0, record.head.length);
			raw.push(
				assistantMessage("Use the tool", 2, {
					...model,
					model: model.id,
					provider: model.provider,
					api: model.api,
					content: [thought("active"), { type: "text", text: "Use the tool" }],
				}),
			);
			ids.push("active");
			queueM0Mutation(db, {
				sessionId: id,
				mutationType: "compartment_delete",
			});
			expect((await pass()).slice(0, head.length)).toEqual(head);
			for (const text of [
				null,
				"bad json",
				JSON.stringify({ ...record, first_kept: null }),
				JSON.stringify({ ...record, turn: "older-turn" }),
			]) {
				db.prepare(
					"UPDATE session_meta SET served_prefix = ? WHERE session_id = ?",
				).run(text, id);
				expect((await pass()).slice(0, head.length)).toEqual(head);
			}
			raw.push(userMessage("Next task", 3));
			ids.push("next");
			db.exec(
				"CREATE TRIGGER fail_prefix BEFORE UPDATE OF served_prefix ON session_meta BEGIN SELECT RAISE(ABORT, 'record unavailable'); END",
			);
			const next = await pass();
			expect(next.length).toBeGreaterThan(raw.length);
			const nextHead = next.slice(0, head.length);
			raw.push(
				assistantMessage("Current answer", 4, {
					...model,
					model: model.id,
					content: [thought("next"), { type: "text", text: "Current answer" }],
				}),
			);
			ids.push("next-a");
			expect((await pass()).slice(0, head.length)).toEqual(nextHead);
		});
	});

it("Pi first-kept reasoning mutation refuses by digest instead of rewriting the record", () => {
	const db = createTestDb();
	const id = "pi-prefix-reasoning";
	cleanups.push(() => {
		db.close();
	});
	getOrCreateSessionMeta(db, id);
	const older = assistantMessage("old", 1, {
		content: [thought("older"), { type: "text", text: "old" }],
	});
	const user = userMessage("Current task", 2);
	const current = assistantMessage("current", 3, {
		content: [thought("current"), { type: "text", text: "current" }],
	});
	const head = [
		userMessage("<session-history></session-history>", -1),
		userMessage("<updates/>", 0),
	];
	const provenance = {
		host: "pi" as const,
		id_space: "pi-entry",
		generation: "pi",
		projection: "messages" as const,
	};
	const record = writeServedPrefix({
		db,
		sessionId: id,
		head,
		summary: null,
		firstKept: older,
		firstKeptId: "older",
		turn: "turn",
		provenance,
	});
	const ids = new Map<unknown, string>([
		[older, "older"],
		[user, "turn"],
		[current, "current"],
	]);
	const stable = (message: unknown) => ids.get(message);
	const raw = [older, user, current];
	const pass = new PiPrefixPass(db, id, raw, stable, true, false);
	const injection = pass.replay(raw, stable);
	if (!injection)
		throw new Error("Reasoning fixture record should validate before mutation");
	pass.finish(raw, injection.syntheticLeadingCount, stable);
	expect(record.first_kept?.digest).toBe(
		servedMessageDigest(older, record.provenance),
	);
	(older as { content: unknown[] }).content.shift();
	let failure: unknown;
	try {
		pass.finish(raw, injection.syntheticLeadingCount, stable);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(DegradedPassRefusalError);
	expect(String((failure as Error).cause)).toContain(
		"first kept digest mismatch",
	);
	expect(readServedPrefix(db, id)).toEqual(record);
});

it("Pi compaction-off rechecks a late digest failure and uses its cached-head fallback", () => {
	const db = createTestDb();
	const id = "pi-prefix-late-off";
	cleanups.push(() => db.close());
	getOrCreateSessionMeta(db, id);
	const first = userMessage("Task", 1);
	const current = assistantMessage("Current", 2, {
		content: [thought("active"), { type: "text", text: "Current" }],
	});
	const oldHead = [
		userMessage("recorded history", -1),
		userMessage("recorded knowledge", 0),
	];
	const record = writeServedPrefix({
		db,
		sessionId: id,
		head: oldHead,
		summary: null,
		firstKept: first,
		firstKeptId: "turn",
		turn: "turn",
		provenance: {
			host: "pi",
			id_space: "pi-entry",
			generation: "pi",
			projection: "messages",
		},
	});
	const stable = (message: unknown) =>
		message === first ? "turn" : message === current ? "current" : undefined;
	const messages = [first, current];
	const pass = new PiPrefixPass(db, id, messages, stable, true, true);
	const injection = pass.replay(messages, stable);
	if (!injection)
		throw new Error("Record should validate before the late change");
	first.content = "Changed after replay";
	pass.compactionOffFallback = (rows, count) =>
		rows.splice(
			0,
			count,
			userMessage("cached history", -1),
			userMessage("cached knowledge", 0),
		);
	pass.finish(messages, injection.syntheticLeadingCount, stable);
	expect(messages[0]).toEqual(userMessage("cached history", -1));
	expect(messages).toContain(first);
	expect(readServedPrefix(db, id)).toEqual(record);
});
