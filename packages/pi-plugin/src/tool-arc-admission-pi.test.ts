import { expect, it } from "bun:test";
import {
	createEditAdmission,
	isAdmissionUser,
	thinkingAnchor,
} from "@magic-context/core/hooks/magic-context/edit-admission";
import type {
	MessageLike,
	TagTarget,
} from "@magic-context/core/hooks/magic-context/tag-messages";
import { protectToolBatchMutations } from "@magic-context/core/hooks/magic-context/tool-arc-admission";
import { piToolBatchCoordinates } from "./tool-arc-admission-pi";

it("Pi compound admission holds a straddling parallel batch at its call, not its result", () => {
	const thinking = {
		type: "thinking",
		thinkingSignature: "boundary",
		thinking: "reasoning",
	};
	const assistant = {
		role: "assistant",
		id: "entry-assistant",
		content: [
			{ type: "toolCall", id: "a", name: "read", arguments: {} },
			thinking,
			{ type: "toolCall", id: "b", name: "read", arguments: {} },
		],
	};
	const messages = [
		assistant,
		...["a", "b"].map((id) => ({
			role: "toolResult",
			id: `entry-${id}`,
			toolCallId: id,
			content: [{ type: "text", text: "output" }],
		})),
	];
	const stableId = (m: unknown) => (m as { id: string }).id;
	const admission = createEditAdmission({
		messages,
		stableId,
		partsOf: (m) => m.content,
		isRealUser: isAdmissionUser,
		prefixBound: true,
		isRetainedThinking: (_m, p) => p === thinking,
		anchorOf: thinkingAnchor,
	});
	const target: TagTarget = {
		mutationParts: [
			{
				message: { info: { id: assistant.id }, parts: [] } as MessageLike,
				part: {},
			},
		],
		canDrop: () => true,
		drop: () => "removed",
		setContent: () => true,
	};
	const batches = piToolBatchCoordinates(messages, stableId);
	const guarded = protectToolBatchMutations(
		new Map([[1, target]]),
		admission,
		batches,
	).get(1);
	if (!guarded) throw new Error("missing tool target");
	expect(guarded.canDrop?.()).toBe(false);
	expect(guarded.drop?.()).toBe("incomplete");
	expect(batches.get(assistant.id)).toContainEqual({
		kind: "message",
		id: "entry-a",
		block: 0,
	});
	expect(batches.get(assistant.id)).toContainEqual({
		kind: "message",
		id: "entry-b",
		block: 0,
	});
	expect(batches.has("synth-user-entry-a")).toBe(false);
});
