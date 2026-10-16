import { describe, expect, it } from "bun:test";
import {
	clearPersistedTodoSyntheticAnchor,
	getPersistedTodoSyntheticAnchor,
	setPersistedTodoSyntheticAnchor,
} from "@magic-context/core/features/magic-context/storage-meta";
import {
	createEditAdmission,
	isAdmissionUser,
	thinkingAnchor,
} from "@magic-context/core/hooks/magic-context/edit-admission";
import { computeSyntheticCallId } from "@magic-context/core/hooks/magic-context/todo-view";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { injectSyntheticTodowriteForPi } from "./pi-todo-inject";
import { createTestDb } from "./test-utils.test";

const oldState = JSON.stringify([
	{ content: "Inspect parser", status: "pending", priority: "high" },
]);
const newState = JSON.stringify([
	{ content: "Repair parser", status: "pending", priority: "high" },
]);
const doneState = JSON.stringify([
	{ content: "Done", status: "completed", priority: "high" },
]);
type Messages = Parameters<typeof injectSyntheticTodowriteForPi>[0]["messages"];

describe("Pi todo compound admission", () => {
	for (const state of [newState, doneState, ""]) {
		it(`holds ${state === newState ? "replacement" : state === "" ? "empty clear" : "terminal clear"} and releases without leaking state`, () => {
			const db = createTestDb();
			const sessionId = "pi-todo-admission";
			try {
				setPersistedTodoSyntheticAnchor(
					db,
					sessionId,
					computeSyntheticCallId(oldState),
					"response-old",
					oldState,
				);
				const messages = (): Messages => [
					{
						role: "assistant",
						responseId: "response-old",
						content: [{ type: "text", text: "History" }],
					},
					{ role: "user", content: [{ type: "text", text: "Continue" }] },
					{
						role: "assistant",
						responseId: "response-boundary",
						content: [
							{
								type: "thinking",
								thinking: "Thinking",
								thinkingSignature: "signed",
							},
						],
					},
					{
						role: "assistant",
						responseId: "response-tail",
						content: [{ type: "text", text: "Tail" }],
					},
				];
				const run = (input: Messages, bust = true, unresolved = false) => {
					const ids = new Map(
						input.map((message, index) => [message, `entry-${index}`]),
					);
					const stableId = (message: Messages[number]) =>
						unresolved ? undefined : ids.get(message);
					return injectSyntheticTodowriteForPi({
						db,
						sessionId,
						isSubagent: false,
						isCacheBusting: bust,
						lastTodoState: state,
						messages: input,
						stableId,
						editAdmission: createEditAdmission({
							messages: input,
							stableId: (message) => ids.get(message),
							partsOf: (message) =>
								Array.isArray(message.content) ? message.content : [],
							isRealUser: isAdmissionUser,
							prefixBound: true,
							isRetainedThinking: (_message, part) =>
								thinkingAnchor(part) !== undefined,
							anchorOf: thinkingAnchor,
						}),
					});
				};
				const before = getPersistedTodoSyntheticAnchor(db, sessionId);
				const held = run(messages());
				expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toEqual(before);
				expect(JSON.stringify(held)).toContain("Inspect parser");
				expect(run(messages(), false)).toEqual(held);
				const missing = messages().slice(1);
				run(missing);
				expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toEqual(before);
				run(messages(), true, true);
				expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toEqual(before);
				const released = messages();
				released.push({
					role: "user",
					content: [{ type: "text", text: "Next" }],
				});
				run(released);
				if (state === newState) {
					expect(
						getPersistedTodoSyntheticAnchor(db, sessionId)?.messageId,
					).toBe("response-tail");
					expect(JSON.stringify(released)).toContain("Repair parser");
				} else {
					expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toBeNull();
				}
			} finally {
				closeQuietly(db);
			}
		});
	}

	it("holds removal of an unrecorded synthetic pair before thinking", () => {
		const db = createTestDb();
		try {
			const messages: Messages = [
				{
					role: "assistant",
					responseId: "response-old",
					content: [{ type: "text", text: "History" }],
				},
			];
			injectSyntheticTodowriteForPi({
				db,
				sessionId: "unrecorded",
				isSubagent: false,
				isCacheBusting: true,
				lastTodoState: oldState,
				messages,
			});
			clearPersistedTodoSyntheticAnchor(db, "unrecorded");
			messages.push({
				role: "assistant",
				responseId: "boundary",
				content: [
					{ type: "thinking", thinking: "Kept", thinkingSignature: "signed" },
				],
			});
			const before = structuredClone(messages);
			const ids = new Map(
				messages.map((message, index) => [message, `entry-${index}`]),
			);
			const admission = createEditAdmission({
				messages,
				stableId: (m) => ids.get(m),
				partsOf: (m) => (Array.isArray(m.content) ? m.content : []),
				isRealUser: isAdmissionUser,
				prefixBound: true,
				isRetainedThinking: (_m, p) => thinkingAnchor(p) !== undefined,
				anchorOf: thinkingAnchor,
			});
			injectSyntheticTodowriteForPi({
				db,
				sessionId: "unrecorded",
				isSubagent: false,
				isCacheBusting: true,
				lastTodoState: doneState,
				messages,
				editAdmission: admission,
				stableId: (m) => ids.get(m),
			});
			expect(messages).toEqual(before);
			expect(getPersistedTodoSyntheticAnchor(db, "unrecorded")).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("admits a new append after the boundary using entry ids, not response ids", () => {
		const db = createTestDb();
		try {
			const messages: Messages = [
				{
					role: "assistant",
					responseId: "response",
					content: [
						{ type: "thinking", thinking: "Kept", thinkingSignature: "signed" },
					],
				},
			];
			const admission = createEditAdmission({
				messages,
				stableId: () => "entry",
				partsOf: (m) => (Array.isArray(m.content) ? m.content : []),
				isRealUser: isAdmissionUser,
				prefixBound: true,
				isRetainedThinking: () => true,
				anchorOf: thinkingAnchor,
			});
			injectSyntheticTodowriteForPi({
				db,
				sessionId: "append",
				isSubagent: false,
				isCacheBusting: true,
				lastTodoState: newState,
				messages,
				editAdmission: admission,
				stableId: () => "entry",
			});
			expect(getPersistedTodoSyntheticAnchor(db, "append")?.messageId).toBe(
				"response",
			);
			expect(JSON.stringify(messages)).toContain("Repair parser");
		} finally {
			closeQuietly(db);
		}
	});
});
