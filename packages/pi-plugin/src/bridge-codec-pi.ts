import type { ProviderCodec } from "@magic-context/core/hooks/magic-context/host-runner/provider-codec";
import type { HookAnswer } from "@magic-context/core/hooks/magic-context/host-runner/record";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/transform-operations";

export interface PiBridgeEntry {
	id?: string;
	type?: string;
	parentId?: string | null;
	message: { role: string; content: unknown; [key: string]: unknown };
	[key: string]: unknown;
}
const object = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** The journal entry is retained verbatim; only text blocks selected by hook operations change. */
export function projectPiEntry(
	source: PiBridgeEntry,
	sessionId = "",
): MessageLike {
	const entry = source.message
		? source
		: ({ message: source } as unknown as PiBridgeEntry);
	const m = entry.message;
	const content =
		typeof m.content === "string"
			? [{ type: "text", text: m.content }]
			: Array.isArray(m.content)
				? m.content
				: [];
	return {
		info: {
			id: entry.id,
			sessionID: sessionId,
			role: m.role === "toolResult" ? "tool" : m.role,
			piEntry: entry,
		},
		parts:
			m.role === "toolResult"
				? [
						{
							id: `${entry.id ?? "head"}#0`,
							type: "tool-result",
							callID: m.toolCallId,
							output: content,
							...(content.length === 1 &&
							Object.keys(object(content[0])).every(
								(key) => key === "type" || key === "text",
							) &&
							object(content[0]).type === "text"
								? { text: object(content[0]).text }
								: {}),
						},
					]
				: content.map((p, index) => ({
						...object(p),
						id: `${entry.id ?? "head"}#${index}`,
						...(!entry.id ? { synthetic: true } : {}),
						...(object(p).type === "toolCall"
							? {
									type: "tool-call",
									callID: object(p).id,
									input: object(p).arguments,
								}
							: {}),
						...(m.role === "toolResult"
							? {
									type: "toolResult",
									callID: m.toolCallId,
									text: object(p).text,
								}
							: {}),
					})),
	} as unknown as MessageLike;
}

export function nativePiEntry(projected: MessageLike): PiBridgeEntry {
	const entry = (projected.info as unknown as { piEntry: PiBridgeEntry })
		.piEntry;
	if (!entry?.message) throw new Error("Missing Pi journal projection");
	const original = entry.message.content;
	if (entry.message.role === "toolResult") {
		const p = object(projected.parts[0]);
		return { ...entry, message: { ...entry.message, content: p.output } };
	}
	const content = projected.parts.map((p, index) => {
		const old = object(Array.isArray(original) ? original[index] : undefined);
		return {
			...old,
			...(typeof object(p).text === "string" ? { text: object(p).text } : {}),
		};
	});
	return {
		...entry,
		message: {
			...entry.message,
			content:
				typeof original === "string"
					? String(object(projected.parts[0]).text ?? original)
					: content,
		},
	};
}

function apply(
	message: MessageLike,
	answers: readonly HookAnswer[],
): MessageLike {
	const parts = message.parts.map((p) => ({ ...object(p) }));
	for (const answer of answers) {
		const indexes = parts.flatMap((p, i) =>
			typeof p.text === "string" ? [i] : [],
		);
		for (const value of answer.ops) {
			const op = object(value);
			const index = indexes[Number(op.block)];
			if (index === undefined)
				throw new Error("Pi operation outside text subject");
			const old = String(parts[index]?.text);
			const text =
				op.op === "prepend"
					? String(op.text) + old
					: op.op === "append"
						? old + String(op.text)
						: op.op === "replace"
							? String(op.value)
							: undefined;
			if (text === undefined) throw new Error("Unknown Pi text operation");
			const p = parts[index];
			parts[index] = {
				...p,
				text,
				...(p?.type === "tool-result"
					? { output: [{ ...object((p.output as unknown[])[0]), text }] }
					: {}),
			};
		}
	}
	return { ...message, parts } as MessageLike;
}

export function piProviderCodec(
	manifest: (id: string) => string,
	ordinals: ProviderCodec["ordinals"],
): ProviderCodec {
	return {
		harness: "pi",
		serializerProfile: "pi",
		manifest,
		ordinals,
		freezeUnavailableHooks: true,
		incoming: (message) => ({
			id: message.info.id,
			read: () => message,
			classify: () => "terminal",
		}),
		subjects: (message) => {
			const entry = nativePiEntry(message),
				id = entry.id;
			if (!id) return [];
			const blocks = message.parts.flatMap((p) =>
				typeof object(p).text === "string" ? [String(object(p).text)] : [],
			);
			switch (entry.message.role) {
				case "user":
					return [{ hook: "pre_user", subject_mid: id, blocks }];
				case "assistant":
					return [
						{ hook: "post_assistant", subject_mid: id, step_id: id, blocks },
					];
				case "toolResult":
					return [
						{
							hook: "post_tool",
							subject_mid: id,
							subject_part: `${id}#0`,
							step_id: id,
							tool: String(entry.message.toolName),
							tool_call_id: String(entry.message.toolCallId),
							blocks,
							is_error: entry.message.isError === true,
						},
					];
				default:
					return [];
			}
		},
		ops: { current: 1, versions: new Map([[1, apply]]) },
		wire: {
			request(_method, encoded) {
				const wire = JSON.parse(encoded);
				const p = wire.params;
				if (p?.message) p.message = nativePiEntry(p.message);
				if (p?.messages)
					p.messages = p.messages.map((m: { message: MessageLike }) => ({
						...m,
						message: nativePiEntry(m.message),
					}));
				return JSON.stringify(wire);
			},
			answer(_method, answer) {
				const a = object(answer);
				const view = object(a.compaction ?? a.initial);
				if (!Array.isArray(view.replacement)) return answer;
				const replacement = (view.replacement as PiBridgeEntry[]).map((entry) =>
					projectPiEntry(entry),
				);
				return {
					...a,
					[a.compaction ? "compaction" : "initial"]: { ...view, replacement },
				};
			},
		},
	};
}
