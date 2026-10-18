import { afterEach, expect, it, spyOn } from "bun:test";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import { getMergedReasoningStrippedIds } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import * as editAdmission from "@magic-context/core/hooks/magic-context/edit-admission";
import * as writeTiming from "@magic-context/core/shared/write-transaction-timing";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { assertPiOldestThinkingRun } from "./provider-error-recovery-pi";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const MODEL = {
	provider: "anthropic",
	id: "claude-opus-5-5",
	api: "anthropic-messages",
	contextWindow: 200_000,
	reasoning: true,
};
const sessions: string[] = [];
afterEach(() => {
	for (const id of sessions.splice(0)) clearContextHandlerSession(id);
});

/** A session that already has history, on its first Magic Context render. */
function fixture(sessionId: string) {
	sessions.push(sessionId);
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(
		fake.pi as never,
		{
			db,
			protectedTokens: 2000,
			signedThinkingHold: "on",
			injection: {
				injectionBudgetTokens: 4000,
				memoryEnabled: false,
				injectDocs: false,
			},
			heuristics: { keepReasoningTokens: 1_000_000 },
		} as never,
	);
	const handler = fake.handlers.get("context") as (
		event: { messages: unknown[] },
		ctx: never,
	) => Promise<{ messages: unknown[] } | undefined>;
	const messages: unknown[] = [];
	const ids: string[] = [];
	let step = 0;
	const assistant = (content: unknown[]) => {
		step++;
		messages.push({
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: `Reasoning for step ${step}.`,
					thinkingSignature: `signature-${step}`,
				},
				...content,
			],
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1000 + messages.length,
		});
		ids.push(`assistant-${step}`);
	};
	const user = (text: string) => {
		messages.push(userMessage(text, 1000 + messages.length));
		ids.push(`user-${messages.length}`);
	};
	for (let turn = 0; turn < 3; turn++) {
		user(`Task ${turn}`);
		const call = `call-${turn}`;
		assistant([
			{
				type: "toolCall",
				id: call,
				name: "Read",
				arguments: { path: `${turn}.ts` },
			},
		]);
		messages.push(
			toolResultMessage(
				call,
				`contents ${turn}\n`.repeat(40),
				1000 + messages.length,
			),
		);
		ids.push(`result-${turn}`);
		assistant([{ type: "text", text: `Done with task ${turn}.` }]);
	}
	user("Current task");
	const pass = async () => {
		const source = structuredClone(messages);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ids, source as never),
			model: MODEL,
			getContextUsage: () => ({
				tokens: 20_000,
				percent: 10,
				contextWindow: 200_000,
			}),
		};
		return ((await handler({ messages: source }, ctx as never))?.messages ??
			source) as Array<{ role: string; content: unknown }>;
	};
	const thinking = (served: Array<{ role: string; content: unknown }>) =>
		served.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.filter((part: { type?: string }) =>
						["thinking", "redactedThinking", "redacted_thinking"].includes(
							String(part.type),
						),
					)
				: [],
		);
	const omissions = () =>
		[...getMergedReasoningStrippedIds(db, sessionId)].filter((id) =>
			id.startsWith("binding_mismatch:"),
		);
	return { db, pass, thinking, omissions, assistant, user };
}

async function sites(run: () => Promise<unknown>): Promise<string[]> {
	const seen: string[] = [];
	const timing = spyOn(writeTiming, "logSlowWriteTransaction");
	timing.mockImplementation((site: string) => {
		seen.push(site);
	});
	try {
		await run();
	} finally {
		timing.mockRestore();
	}
	return seen;
}

it("a session's first render commits its thinking strip alone, before an unpaired pipeline", async () => {
	const f = fixture("first-render-strip");
	let served: Awaited<ReturnType<typeof f.pass>> = [];
	const seen = await sites(async () => {
		served = await f.pass();
	});
	expect(f.thinking(served)).toEqual([]);
	expect(f.omissions()).toHaveLength(6);
	expect(seen).toContain("pi_first_render_strip");
	expect(seen).not.toContain("paired_thinking_edit");
	expect(getTagsBySession(f.db, "first-render-strip").length).toBeGreaterThan(
		0,
	);
	// A later turn start is not a first render: it keeps the paired rule.
	f.assistant([{ type: "text", text: "Done with the current task." }]);
	f.user("Another task");
	const later = await sites(() => f.pass());
	expect(later).not.toContain("pi_first_render_strip");
	expect(later).toContain("paired_thinking_edit");
});

// The early strip commits before the pipeline's edits. When the pipeline fails
// after it, the next pass must still omit that thinking and serve a valid
// request, without refusing again.
it("a first render that fails after its strip committed still omits that thinking next pass", async () => {
	const f = fixture("first-render-failure");
	const fail = spyOn(
		editAdmission,
		"createEditAdmission",
	).mockImplementationOnce(() => {
		throw new Error("injected failure after the first-render strip");
	});
	let failed = false;
	try {
		await f.pass();
	} catch {
		failed = true;
	} finally {
		fail.mockRestore();
	}
	expect(failed).toBe(true);
	// The failure came after tagging: the strip and some edits are durable.
	expect(f.omissions()).toHaveLength(6);
	expect(getTagsBySession(f.db, "first-render-failure").length).toBeGreaterThan(
		0,
	);
	const next = await f.pass();
	expect(f.thinking(next)).toEqual([]);
	expect(f.thinking(await f.pass())).toEqual([]);
});

it("an omission set with a kept block before an omitted one is refused", () => {
	const block = { type: "thinking", thinking: "t", thinkingSignature: "s" };
	const messages = ["a", "b", "c"].map(() => ({
		role: "assistant",
		content: [block],
	}));
	const ids = ["a", "b", "c"];
	expect(() =>
		assertPiOldestThinkingRun(messages, ids, new Set(["a", "b"])),
	).not.toThrow();
	expect(() =>
		assertPiOldestThinkingRun(messages, ids, new Set(["a", "b", "c"])),
	).not.toThrow();
	expect(() =>
		assertPiOldestThinkingRun(messages, ids, new Set(["a", "c"])),
	).toThrow();
	expect(() =>
		assertPiOldestThinkingRun(messages, ids, new Set(["b"])),
	).toThrow();
});
