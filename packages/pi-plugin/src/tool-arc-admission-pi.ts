import { toolBatchCoordinates } from "@magic-context/core/hooks/magic-context/tool-arc-admission";
import { isRecord } from "@magic-context/core/shared/record-type-guard";

/** Tool-result transcript carriers are synthetic; admission uses each real Pi entry instead. */
export function piToolBatchCoordinates(
	messages: readonly unknown[],
	stableId: (message: unknown, index: number) => string | undefined,
) {
	return toolBatchCoordinates({
		messages,
		stableId,
		partsOf: (message) => {
			if (!isRecord(message)) return [];
			if (message.role === "toolResult") return [message];
			return Array.isArray(message.content) ? message.content : [];
		},
		occurrence: (_message, part) => {
			if (!isRecord(part)) return {};
			if (part.type === "toolCall" && typeof part.id === "string")
				return { call: part.id };
			if (part.role === "toolResult" && typeof part.toolCallId === "string")
				return { result: part.toolCallId };
			return {};
		},
	});
}
