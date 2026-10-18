import { afterEach, describe, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { queueM0Mutation } from "@magic-context/core/features/magic-context/storage-m0-mutation-log";
import { DegradedPassRefusalError } from "@magic-context/core/hooks/magic-context/degraded-pass-refusal";
import {
	readServedPrefix,
	writeServedPrefix,
} from "@magic-context/core/hooks/magic-context/served-prefix";
import { servedMessageDigest } from "../../plugin/src/hooks/magic-context/__tests__/served-prefix-evidence";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
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
				servedMessageDigest(initial[record.head.length]),
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
	expect(record.first_kept?.digest).toBe(servedMessageDigest(older));
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
