import { expect, it, spyOn } from "bun:test";
import {
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { getMergedReasoningStrippedIds } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { pairedThinkingEdit } from "@magic-context/core/hooks/magic-context/paired-thinking-edit";
import * as writeTiming from "@magic-context/core/shared/write-transaction-timing";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import { preparePiThinkingStripWrite } from "./provider-error-recovery-pi";
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
	contextWindow: 200_000,
	reasoning: true,
};

async function fixture(sessionId: string) {
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(
		fake.pi as never,
		{
			db,
			protectedTokens: 0,
			signedThinkingHold: "on",
			heuristics: { keepReasoningTokens: 1_000_000 },
		} as never,
	);
	const signed = (text: string, timestamp: number) =>
		assistantMessage(text, timestamp, {
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "thinking",
					thinking: `Reason about ${text}`,
					thinkingSignature: `sig-${timestamp}`,
				},
				{ type: "text", text },
			],
		});
	const messages = [
		userMessage("old request", 1),
		signed("old answer", 2),
		userMessage("next request", 3),
	];
	const handler = fake.handlers.get("context") as (
		event: unknown,
		ctx: never,
	) => Promise<{ messages: unknown[] } | undefined>;
	const pass = async () => {
		const source = structuredClone(messages);
		const ids = messages.map((_, i) => `entry-${i}`);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ids, source),
			model,
		};
		return (
			(await handler({ messages: source }, ctx as never))?.messages ?? source
		);
	};
	await pass();
	messages.push(signed("new answer", 4), userMessage("release the turn", 5));
	const old = getTagsBySession(db, sessionId).find((tag) =>
		tag.messageId.startsWith("entry-0:"),
	);
	if (!old) throw new Error("Fixture did not allocate the old request's tag");
	queuePendingOp(db, sessionId, old.tagNumber, "drop");
	signalPiPendingMaterialization(sessionId);
	return {
		db,
		pass,
		close: () => {
			clearContextHandlerSession(sessionId);
			db.close();
		},
	};
}

it("turn-start pairing excludes session-wide tagging work from the write hold", async () => {
	const f = await fixture("narrow-hold");
	const holds: number[] = [];
	const timing = spyOn(
		writeTiming,
		"logSlowWriteTransaction",
	).mockImplementation((site, from) => {
		if (site === "paired_thinking_edit") holds.push(performance.now() - from);
	});
	let delayed = false;
	const restore = __test.setAfterFallbackAdoptionForTests(() => {
		// Make session-wide preparation observably slower than the lock budget.
		// It must still run, but never while a companion writer is held.
		const until = performance.now() + 75;
		while (performance.now() < until) {
			/* synchronous preparation */
		}
		delayed = true;
	});
	try {
		await f.pass();
		expect(delayed).toBe(true);
		expect(holds.length).toBeGreaterThan(0);
		expect(Math.max(...holds)).toBeLessThan(50);
	} finally {
		restore();
		timing.mockRestore();
		f.close();
	}
});

it("a repeated turn-start pass reuses tag numbers and durable strip decisions", async () => {
	const sessionId = "narrow-rerun";
	const f = await fixture(sessionId);
	try {
		const first = await f.pass();
		const tags = getTagsBySession(f.db, sessionId);
		const omissions = [...getMergedReasoningStrippedIds(f.db, sessionId)];
		expect(omissions).toContain("binding_mismatch:entry-3");
		signalPiPendingMaterialization(sessionId);
		const repeated = await f.pass();
		expect(repeated).toEqual(first);
		expect(getTagsBySession(f.db, sessionId)).toEqual(tags);
		expect([...getMergedReasoningStrippedIds(f.db, sessionId)]).toEqual(
			omissions,
		);
	} finally {
		f.close();
	}
});

it("a stale companion plan rolls back its edit without overwriting a peer's ledger", () => {
	const db = createTestDb();
	const sessionId = "narrow-peer";
	try {
		db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run(
			sessionId,
		);
		const persist = preparePiThinkingStripWrite(db, sessionId, {
			entryIds: ["ours"],
		});
		const peer = JSON.stringify(["binding_mismatch:peer"]);
		db.prepare(
			"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?",
		).run(peer, sessionId);
		expect(() =>
			pairedThinkingEdit({
				db,
				messages: [],
				edit: () =>
					db
						.prepare("UPDATE session_meta SET counter = 7 WHERE session_id = ?")
						.run(sessionId),
				needsCompanion: () => true,
				persistCompanion: persist,
			}),
		).toThrow("Thinking omission plan changed");
		const row = db
			.prepare(
				"SELECT counter, merged_reasoning_stripped_ids FROM session_meta WHERE session_id = ?",
			)
			.get(sessionId);
		expect(row).toEqual({ counter: 0, merged_reasoning_stripped_ids: peer });
	} finally {
		db.close();
	}
});
