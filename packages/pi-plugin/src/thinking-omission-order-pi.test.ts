import { expect, it } from "bun:test";
import {
	addMergedReasoningStrippedIds,
	getMergedReasoningStrippedIds,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { pairedThinkingEdit } from "@magic-context/core/hooks/magic-context/paired-thinking-edit";
import base from "./__fixtures__/legacy-thinking-strip.base.json";
import {
	applyPiProactiveThinkingStrip,
	applyPiThinkingBindingRecovery,
	piThinkingOmissionOrderId,
	resolvePiBindingStripOrder,
} from "./provider-error-recovery-pi";
import { createTestDb } from "./test-utils.test";

it("legacy omission IDs, order and bytes match the captured base fixture", () => {
	const db = createTestDb();
	try {
		addMergedReasoningStrippedIds(db, "legacy", base.ledger);
		const messages = structuredClone(base.input);
		expect(
			resolvePiBindingStripOrder({
				db,
				sessionId: "legacy",
				messages,
				entryIds: base.ids,
				bustPermittedAtStart: false,
			}),
		).toBe(base.order);
		applyPiThinkingBindingRecovery({
			db,
			sessionId: "legacy",
			messages,
			entryIds: base.ids,
			provider: "anthropic",
			model: "claude-opus-5-5",
			replayOrder: "start",
			freezeRecovery: false,
		});
		expect(JSON.stringify(messages)).toBe(JSON.stringify(base.output));
		expect([...getMergedReasoningStrippedIds(db, "legacy")]).toEqual(
			base.ledger,
		);
	} finally {
		db.close();
	}
});

it("a new entry's end order never changes legacy start-order bytes", () => {
	const db = createTestDb();
	try {
		addMergedReasoningStrippedIds(db, "mixed", [
			...base.ledger,
			"binding_mismatch:new",
			piThinkingOmissionOrderId("new", "end"),
		]);
		const messages: unknown[] = [
			...structuredClone(base.input).slice(0, 1),
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "new thought",
						thinkingSignature: "new-signature",
					},
					{ type: "text", text: "new answer" },
				],
			},
			base.input[1],
		];
		const ids = ["old", "new", "next"];
		const args = {
			db,
			sessionId: "mixed",
			messages,
			entryIds: ids,
			provider: "anthropic",
			model: "claude-opus-5-5",
			freezeRecovery: false,
		};
		applyPiThinkingBindingRecovery({ ...args, replayOrder: "start" });
		expect(messages[0]).toEqual(base.output[0]);
		expect((messages[1] as { content: unknown[] }).content).toHaveLength(2);
		applyPiThinkingBindingRecovery({ ...args, replayOrder: "end" });
		expect((messages[1] as { content: unknown[] }).content).toEqual([
			{ type: "text", text: "new answer" },
		]);
		expect(
			getMergedReasoningStrippedIds(db, "mixed").has(
				"binding_mismatch_order:end",
			),
		).toBe(false);
	} finally {
		db.close();
	}
});

it("new companion entries always commit their own order with the edit", () => {
	const db = createTestDb();
	try {
		db.exec("CREATE TABLE landed_edit (value TEXT)");
		const messages = structuredClone(base.input);
		pairedThinkingEdit({
			db,
			messages,
			edit: () => {
				db.exec("INSERT INTO landed_edit VALUES ('changed system')");
				return true;
			},
			needsCompanion: () => true,
			persistCompanion: () => {
				applyPiProactiveThinkingStrip({
					db,
					sessionId: "new",
					messages,
					entryIds: base.ids,
					provider: "anthropic",
					model: "claude-opus-5-5",
					cacheBustingPass: true,
					persistOnly: true,
					requirePersistence: true,
				});
			},
		});
		const ledger = getMergedReasoningStrippedIds(db, "new");
		expect(ledger.has("binding_mismatch:old")).toBe(true);
		expect(ledger.has(piThinkingOmissionOrderId("old", "end"))).toBe(true);
		expect(ledger.has("binding_mismatch_order:end")).toBe(false);
	} finally {
		db.close();
	}
});

it("an explicit entry start order wins over a legacy global end marker", () => {
	const db = createTestDb();
	try {
		addMergedReasoningStrippedIds(db, "override", [
			...base.ledger,
			"binding_mismatch_order:end",
			"binding_mismatch:new",
			piThinkingOmissionOrderId("new", "start"),
		]);
		const messages: unknown[] = [
			...structuredClone(base.input).slice(0, 1),
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "new thought",
						thinkingSignature: "new-signature",
					},
					{ type: "text", text: "new answer" },
				],
			},
			base.input[1],
		];
		const args = {
			db,
			sessionId: "override",
			messages,
			entryIds: ["old", "new", "next"],
			provider: "anthropic",
			model: "claude-opus-5-5",
			freezeRecovery: false,
		};
		applyPiThinkingBindingRecovery({ ...args, replayOrder: "start" });
		expect((messages[0] as { content: unknown[] }).content).toHaveLength(2);
		expect((messages[1] as { content: unknown[] }).content).toEqual([
			{ type: "text", text: "new answer" },
		]);
		applyPiThinkingBindingRecovery({ ...args, replayOrder: "end" });
		expect(messages[0]).toEqual(base.output[0]);
	} finally {
		db.close();
	}
});
