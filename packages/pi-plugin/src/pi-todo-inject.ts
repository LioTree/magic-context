/**
 * Pi synthetic-todowrite injection.
 *
 * # Why this is separate from OpenCode's path
 *
 * OpenCode synthesizes a single `tool` part on the latest assistant message
 * (`buildSyntheticTodoPart` in `packages/plugin/src/hooks/magic-context/todo-view.ts`);
 * OpenCode's wire serializer (`MessageV2.toModelMessagesEffect`) splits that
 * combined part into provider-shape `tool_use` (assistant) and `tool_result`
 * (next user) at wire-emit time.
 *
 * Pi RPC has no equivalent split — Pi delivers a `Message[]` (UserMessage |
 * AssistantMessage | ToolResultMessage) where assistant `toolCall` blocks
 * and `toolResult` messages already live in separate top-level messages. To
 * produce the same on-wire shape we must:
 *
 *   1. Push a Pi `ToolCall` block onto the latest assistant's `content`.
 *   2. Insert a Pi `ToolResultMessage` immediately after it.
 *
 * # Cache safety
 *
 * - Pi message identity uses `AssistantMessage.responseId` when present,
 *   else `String(timestamp)`. Persisted `messageId` is used on later defer
 *   passes to re-anchor at the same assistant message, idempotent on
 *   callID match.
 * - This injection runs AFTER tagging + drops + nudges in `runPipeline`,
 *   so the synthetic blocks are never tagged, never dropped, and never
 *   reach `ctx_reduce`.
 * - The synthetic callID is deterministic (`mc_synthetic_todo_<sha256[:16]>`),
 *   so identical persisted state produces byte-identical wire shape.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	clearPersistedTodoSyntheticAnchor,
	getPersistedTodoSyntheticAnchor,
	setPersistedTodoSyntheticAnchor,
} from "@magic-context/core/features/magic-context/storage-meta";
import type {
	EditAdmission,
	EditCoord,
} from "@magic-context/core/hooks/magic-context/edit-admission";
import {
	pairedThinkingEdit,
	todoCompanionRequired,
} from "@magic-context/core/hooks/magic-context/paired-thinking-edit";
import {
	buildSyntheticTodoPart,
	type SyntheticTodoPart,
} from "@magic-context/core/hooks/magic-context/todo-view";
import { sessionLog } from "@magic-context/core/shared/logger";

// Pi message shape (mirrors @earendil-works/pi-ai types — kept local because
// the pi-plugin builds against a stable subset of those types via TypeScript
// path mapping into packages/plugin/src for the rest of magic-context).
//
// Only the fields we read/write are typed; other fields pass through opaquely.
type PiToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	// Carry the synthetic marker so other Pi paths (e.g. tagger) can detect
	// these blocks if needed. Mirrors `SyntheticTodoPart.syntheticTodoMarker`.
	syntheticTodoMarker: true;
};

type PiAssistantMessage = {
	role: "assistant";
	content: Array<Record<string, unknown>>;
	responseId?: string;
	timestamp?: number;
	stopReason?: string;
};

type PiToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: "text"; text: string }>;
	timestamp?: number;
	syntheticTodoMarker?: true;
};

type PiMessage =
	| PiAssistantMessage
	| PiToolResultMessage
	| Record<string, unknown>;

function getMessageId(message: PiAssistantMessage): string {
	if (typeof message.responseId === "string" && message.responseId.length > 0) {
		return message.responseId;
	}
	if (typeof message.timestamp === "number") {
		return `pi-ts-${message.timestamp}`;
	}
	// Last-resort fallback: index-based ID would change every pass, which
	// would defeat replay byte-stability. Caller is expected to filter
	// these out, but return a stable empty marker just in case.
	return "";
}

/**
 * Pi's provider serializers (`transform-messages.ts`) skip errored/aborted
 * assistant messages entirely when building the wire request, but pass
 * top-level toolResult messages through unconditionally. Anchoring the
 * synthetic pair to such an assistant therefore ships an orphaned
 * function_call_output with no matching function_call, which OpenAI-family
 * providers reject with a 400 on every subsequent turn.
 */
function isReplayableAnchor(message: PiAssistantMessage): boolean {
	return message.stopReason !== "aborted" && message.stopReason !== "error";
}

function hasToolCallWithId(
	message: PiAssistantMessage,
	callId: string,
): boolean {
	if (!Array.isArray(message.content)) return false;
	for (const block of message.content) {
		if (!block || typeof block !== "object") continue;
		const t = (block as { type?: unknown }).type;
		const id = (block as { id?: unknown }).id;
		if (t === "toolCall" && id === callId) return true;
	}
	return false;
}

function findToolResultAfter(
	messages: PiMessage[],
	assistantIndex: number,
	callId: string,
): number {
	for (let i = assistantIndex + 1; i < messages.length; i += 1) {
		const m = messages[i];
		if (!m || typeof m !== "object") continue;
		const role = (m as { role?: unknown }).role;
		const tcId = (m as { toolCallId?: unknown }).toolCallId;
		if (role === "toolResult" && tcId === callId) return i;
		// Stop at the next assistant — Pi pairs tool calls/results within
		// the same assistant turn.
		if (role === "assistant") return -1;
	}
	return -1;
}

/**
 * Pi-shape adapter for the OpenCode `SyntheticTodoPart`. Builds the
 * provider-style `toolCall` block + `toolResult` message that Pi will
 * forward to the LLM.
 */
function piBlocksFromSynthetic(part: SyntheticTodoPart): {
	call: PiToolCallBlock;
	result: PiToolResultMessage;
} {
	return {
		call: {
			type: "toolCall",
			id: part.callID,
			name: part.tool,
			arguments: { todos: part.state.input.todos },
			syntheticTodoMarker: true,
		},
		result: {
			role: "toolResult",
			toolCallId: part.callID,
			toolName: part.tool,
			content: [{ type: "text", text: part.state.output }],
			timestamp: 0,
			syntheticTodoMarker: true,
		},
	};
}

/**
 * Inject the synthetic toolCall/toolResult pair onto the assistant message
 * matching `messageId`. Idempotent on callID — if the pair is already
 * present, returns `true` without mutating. Returns `false` when the target
 * assistant or its paired position isn't available in the visible window.
 */
function injectByAssistantId(
	messages: PiMessage[],
	messageId: string,
	part: SyntheticTodoPart,
): boolean {
	for (let i = 0; i < messages.length; i += 1) {
		const m = messages[i];
		if (!m || typeof m !== "object") continue;
		if ((m as { role?: unknown }).role !== "assistant") continue;
		const assistant = m as PiAssistantMessage;
		if (getMessageId(assistant) !== messageId) continue;
		if (!isReplayableAnchor(assistant)) return false;
		if (hasToolCallWithId(assistant, part.callID)) {
			// Already injected — verify the result is also still next to it.
			if (findToolResultAfter(messages, i, part.callID) >= 0) return true;
			// toolCall present but result missing (shouldn't happen). Re-insert.
		}
		const { call, result } = piBlocksFromSynthetic(part);
		if (!Array.isArray(assistant.content)) assistant.content = [];
		if (!hasToolCallWithId(assistant, part.callID)) {
			assistant.content.push(call as unknown as Record<string, unknown>);
		}
		// Insert result right after assistant if not already present.
		if (findToolResultAfter(messages, i, part.callID) < 0) {
			messages.splice(i + 1, 0, result);
		}
		return true;
	}
	return false;
}

/**
 * Append the synthetic pair to the latest assistant message in the array.
 * Returns the assistant's message id on success, null when there's no
 * assistant to anchor to (e.g. first turn before assistant has spoken).
 */
function injectIntoLatestAssistant(
	messages: PiMessage[],
	part: SyntheticTodoPart,
): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (!m || typeof m !== "object") continue;
		if ((m as { role?: unknown }).role !== "assistant") continue;
		const assistant = m as PiAssistantMessage;
		if (!isReplayableAnchor(assistant)) continue;
		const id = getMessageId(assistant);
		if (id.length === 0) continue;
		if (hasToolCallWithId(assistant, part.callID)) {
			if (findToolResultAfter(messages, i, part.callID) >= 0) return id;
		}
		const { call, result } = piBlocksFromSynthetic(part);
		if (!Array.isArray(assistant.content)) assistant.content = [];
		if (!hasToolCallWithId(assistant, part.callID)) {
			assistant.content.push(call as unknown as Record<string, unknown>);
		}
		if (findToolResultAfter(messages, i, part.callID) < 0) {
			messages.splice(i + 1, 0, result);
		}
		return id;
	}
	return null;
}

/**
 * Pi synthetic-todowrite injection entry point. Mirrors the B7 block in
 * OpenCode's `transform-postprocess-phase.ts` but uses Pi's wire-shape
 * helpers.
 *
 * Returns the (possibly-mutated) messages array. The array itself is
 * mutated in place; the return is for call-site clarity.
 */
export function injectSyntheticTodowriteForPi(args: {
	db: ContextDatabase;
	sessionId: string;
	isSubagent: boolean;
	isCacheBusting: boolean;
	lastTodoState: string;
	messages: PiMessage[];
	editAdmission?: EditAdmission;
	stableId?: (message: PiMessage, index: number) => string | undefined;
	persistCompanion?: (messages: PiMessage[]) => void;
}): PiMessage[] {
	if (args.isSubagent) return args.messages;

	const persistedAnchor = getPersistedTodoSyntheticAnchor(
		args.db,
		args.sessionId,
	);
	const source = args.messages.map((message) => ({
		id:
			message.role === "assistant"
				? getMessageId(message as PiAssistantMessage)
				: undefined,
		thinking:
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some(
				(part) =>
					part &&
					typeof part === "object" &&
					["thinking", "redactedThinking", "redacted_thinking"].includes(
						String((part as { type?: string }).type),
					),
			),
	}));
	const apply = (): PiMessage[] => {
		const replay = (): PiMessage[] => {
			if (persistedAnchor && persistedAnchor.stateJson.length > 0) {
				const part = buildSyntheticTodoPart(persistedAnchor.stateJson);
				if (part !== null && part.callID === persistedAnchor.callId) {
					injectByAssistantId(args.messages, persistedAnchor.messageId, part);
				}
			}
			return args.messages;
		};
		const entryId = (anchor: string): string | undefined => {
			const index = args.messages.findIndex(
				(message) =>
					message.role === "assistant" &&
					getMessageId(message as PiAssistantMessage) === anchor,
			);
			return index < 0
				? undefined
				: args.stableId?.(args.messages[index], index);
		};
		const admit = (newAnchor?: string | null): boolean => {
			const coords: EditCoord[] = [];
			if (persistedAnchor)
				coords.push({
					kind: "message",
					id: entryId(persistedAnchor.messageId),
					block: "whole",
				});
			let hasSyntheticCall = false;
			for (let index = 0; index < args.messages.length; index++) {
				const message = args.messages[index];
				if (
					message.role === "assistant" &&
					Array.isArray(message.content) &&
					message.content.some((part) => part.syntheticTodoMarker === true)
				) {
					hasSyntheticCall = true;
					coords.push({
						kind: "message",
						id: args.stableId?.(message, index),
						block: "whole",
					});
				}
			}
			if (
				!persistedAnchor &&
				!hasSyntheticCall &&
				args.messages.some(
					(message) =>
						"syntheticTodoMarker" in message &&
						message.syntheticTodoMarker === true,
				)
			) {
				coords.push({ kind: "prefix" });
			}
			if (newAnchor)
				coords.push({ kind: "append", afterId: entryId(newAnchor) });
			if (
				coords.every(
					(coord) => !args.editAdmission || args.editAdmission.admit(coord),
				)
			)
				return true;
			if (args.editAdmission?.frame.kind === "boundary") {
				sessionLog(
					args.sessionId,
					`edit admission: held lane=synthetic todo coords=${JSON.stringify(coords)} boundary=${args.editAdmission.frame.messageId ?? "<unresolved>"} held_edits=1`,
				);
			}
			return false;
		};
		const removePair = (): void => {
			for (let index = args.messages.length - 1; index >= 0; index--) {
				const message = args.messages[index];
				if (
					"syntheticTodoMarker" in message &&
					message.syntheticTodoMarker === true
				)
					args.messages.splice(index, 1);
				else if (
					message.role === "assistant" &&
					Array.isArray(message.content)
				) {
					message.content = message.content.filter(
						(part) => part.syntheticTodoMarker !== true,
					);
				}
			}
		};
		if (args.isCacheBusting) {
			const part = buildSyntheticTodoPart(args.lastTodoState);
			if (part === null) {
				if (!admit()) return replay();
				removePair();
				if (persistedAnchor) {
					clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
				}
				return args.messages;
			}
			// Preview placement on copies before changing messages or the persisted todo anchor:
			// a rejected move must replay the previously served todo pair byte-for-byte.
			const preview = args.messages.map((message) => ({
				...message,
				...(Array.isArray(message.content)
					? { content: [...message.content] }
					: {}),
			})) as PiMessage[];
			if (
				persistedAnchor &&
				persistedAnchor.callId === part.callID &&
				injectByAssistantId(preview, persistedAnchor.messageId, part)
			) {
				// Snapshot unchanged AND persisted anchor still present —
				// idempotent re-inject; backfill stateJson if it was empty
				// (legacy row from a build that persisted callID without state).
				// Mirrors the same self-heal in the OpenCode todo-injection path.
				if (persistedAnchor.stateJson.length === 0) {
					if (!admit(persistedAnchor.messageId)) return replay();
					setPersistedTodoSyntheticAnchor(
						args.db,
						args.sessionId,
						persistedAnchor.callId,
						persistedAnchor.messageId,
						args.lastTodoState,
					);
				}
				injectByAssistantId(args.messages, persistedAnchor.messageId, part);
				return args.messages;
			}
			const candidateId = injectIntoLatestAssistant(preview, part);
			if (!admit(candidateId)) return replay();
			removePair();
			const anchoredMessageId = injectIntoLatestAssistant(args.messages, part);
			if (anchoredMessageId) {
				setPersistedTodoSyntheticAnchor(
					args.db,
					args.sessionId,
					part.callID,
					anchoredMessageId,
					args.lastTodoState,
				);
			} else if (persistedAnchor) {
				clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
			}
			return args.messages;
		}

		// Replay the persisted todo state rather than the live snapshot: a real todowrite
		// between passes must not change the synthetic call/result bytes on a defer pass.
		// If its saved assistant is missing, skip replay instead of moving the pair.
		return replay();
	};
	return args.persistCompanion
		? pairedThinkingEdit({
				db: args.db,
				messages: args.messages,
				edit: apply,
				needsCompanion: () =>
					todoCompanionRequired(
						persistedAnchor,
						getPersistedTodoSyntheticAnchor(args.db, args.sessionId),
						source,
					),
				persistCompanion: args.persistCompanion,
			})
		: apply();
}
