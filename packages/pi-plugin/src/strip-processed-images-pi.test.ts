import { describe, expect, it } from "bun:test";
import { getProcessedImageStrippedIds } from "@magic-context/core/features/magic-context/storage";
import {
	createEditAdmission,
	isAdmissionUser,
	thinkingAnchor,
} from "@magic-context/core/hooks/magic-context/edit-admission";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { stripPiProcessedImages } from "./strip-processed-images-pi";
import { assistantMessage, createTestDb } from "./test-utils.test";

const IMAGE_DATA = "a".repeat(240);

function imageMessage(role: "user" | "toolResult", timestamp: number) {
	return {
		role,
		timestamp,
		...(role === "toolResult"
			? {
					toolCallId: `call-${timestamp}`,
					toolName: "screenshot",
					isError: false,
				}
			: {}),
		content: [
			{ type: "text", text: `${role} ${timestamp}` },
			{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
		],
	};
}

function idByTimestamp(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const timestamp = (message as { timestamp?: unknown }).timestamp;
	return typeof timestamp === "number" ? `entry-${timestamp}` : undefined;
}

describe("stripPiProcessedImages", () => {
	it("admits only tail images before persistence and replays held bytes until a later permitted bust", () => {
		const db = createTestDb();
		try {
			const raw = [
				imageMessage("user", 1),
				{
					...assistantMessage("kept", 2),
					content: [
						{ type: "thinking", thinking: "kept", signature: "signed" },
					],
				},
				imageMessage("toolResult", 3),
				assistantMessage("processed", 4),
			];
			raw[0].content.push({
				type: "image",
				data: IMAGE_DATA,
				mimeType: "image/png",
			});
			const applied: string[] = [];
			const pass = (detect: boolean) => {
				const messages = structuredClone(raw);
				const admission = createEditAdmission({
					messages,
					stableId: idByTimestamp,
					partsOf: (m) => m.content,
					isRealUser: isAdmissionUser,
					prefixBound: true,
					isRetainedThinking: (_m, p) =>
						(p as { type?: string }).type === "thinking",
					anchorOf: thinkingAnchor,
				});
				const coords: string[] = [];
				const result = stripPiProcessedImages({
					db,
					sessionId: "ses-admission",
					messages,
					detect,
					watermark: 5,
					messageIdToMaxTag: new Map(),
					stableId: idByTimestamp,
					admitFirstApplication: (m, _index, block) => {
						const id = idByTimestamp(m);
						coords.push(`${id}:${block}`);
						return admission.admit({ kind: "message", id, block });
					},
					onFirstApplication: (m, _index, block) => {
						applied.push(`${idByTimestamp(m)}:${block}`);
					},
				});
				return { messages, result, coords };
			};
			const held = pass(true);
			expect(held.coords).toEqual(["entry-3:1", "entry-1:1"]);
			expect(held.result).toEqual({
				stripped: 1,
				newlyStrippedIds: ["entry-3"],
			});
			expect(held.messages[0]).toEqual(raw[0]);
			expect(pass(false).messages).toEqual(held.messages);
			expect([...getProcessedImageStrippedIds(db, "ses-admission")]).toEqual([
				"entry-3",
			]);
			expect(applied).toEqual(["entry-3:1"]);
			expect(pass(false).coords).toEqual([]);
			expect(pass(true).messages).toEqual(held.messages);
			raw.push({
				role: "user",
				timestamp: 5,
				content: [{ type: "text", text: "next task" }],
			});
			expect(pass(false).result.newlyStrippedIds).toEqual([]);
			const release = pass(true);
			expect(release.result.newlyStrippedIds).toEqual(["entry-1"]);
			expect(pass(false).messages).toEqual(release.messages);
		} finally {
			closeQuietly(db);
		}
	});
	it("freezes old processed user/tool-result images and replays identical bytes on defer", () => {
		const db = createTestDb();
		try {
			const buildMessages = () => [
				imageMessage("user", 1),
				assistantMessage("processed user image", 2),
				imageMessage("toolResult", 3),
				assistantMessage("processed tool image", 4),
			];
			const tags = new Map([
				["entry-1", 2],
				["entry-3", 3],
			]);
			const first = buildMessages();
			const detected = stripPiProcessedImages({
				db,
				sessionId: "ses-images",
				messages: first,
				detect: true,
				watermark: 5,
				messageIdToMaxTag: tags,
				stableId: idByTimestamp,
			});
			const firstWire = JSON.stringify(first);

			const replay = buildMessages();
			const replayed = stripPiProcessedImages({
				db,
				sessionId: "ses-images",
				messages: replay,
				detect: false,
				watermark: 99,
				messageIdToMaxTag: new Map(),
				stableId: idByTimestamp,
			});

			expect(detected).toEqual({
				stripped: 2,
				newlyStrippedIds: ["entry-3", "entry-1"],
			});
			expect(replayed.stripped).toBe(2);
			expect(JSON.stringify(replay)).toBe(firstWire);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps an image-only tool result non-empty and byte-stable on defer replay", () => {
		const db = createTestDb();
		try {
			const buildMessages = () => {
				const toolResult = {
					...imageMessage("toolResult", 3),
					content: [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }],
				};
				return [toolResult, assistantMessage("processed tool image", 4)];
			};

			const first = buildMessages();
			const detected = stripPiProcessedImages({
				db,
				sessionId: "ses-image-only-tool-result",
				messages: first,
				detect: true,
				watermark: 5,
				messageIdToMaxTag: new Map([["entry-3", 3]]),
				stableId: idByTimestamp,
			});
			const firstWire = JSON.stringify(first);

			const replay = buildMessages();
			const replayed = stripPiProcessedImages({
				db,
				sessionId: "ses-image-only-tool-result",
				messages: replay,
				detect: false,
				watermark: 99,
				messageIdToMaxTag: new Map(),
				stableId: idByTimestamp,
			});

			expect(detected).toEqual({
				stripped: 1,
				newlyStrippedIds: ["entry-3"],
			});
			expect(replayed.stripped).toBe(1);
			expect((first[0] as { content: unknown[] }).content).toEqual([
				{ type: "text", text: "[image stripped]" },
			]);
			expect(JSON.stringify(replay)).toBe(firstWire);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses the same non-empty marker for user-message images", () => {
		const db = createTestDb();
		try {
			const image = imageMessage("user", 1);
			stripPiProcessedImages({
				db,
				sessionId: "ses-user-image-marker",
				messages: [image, assistantMessage("processed", 2)],
				detect: true,
				watermark: 5,
				messageIdToMaxTag: new Map([["entry-1", 1]]),
				stableId: idByTimestamp,
			});

			expect(image.content[1]).toEqual({
				type: "text",
				text: "[image stripped]",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("leaves images newer than the dropped-tag watermark untouched", () => {
		const db = createTestDb();
		try {
			const image = imageMessage("user", 9);
			const messages = [image, assistantMessage("processed", 10)];
			const result = stripPiProcessedImages({
				db,
				sessionId: "ses-new-image",
				messages,
				detect: true,
				watermark: 5,
				messageIdToMaxTag: new Map([["entry-9", 9]]),
				stableId: idByTimestamp,
			});

			expect(result).toEqual({ stripped: 0, newlyStrippedIds: [] });
			expect((image.content[1] as { type: string }).type).toBe("image");
		} finally {
			closeQuietly(db);
		}
	});

	it("does not strip newly detected bytes when frozen-id persistence fails", () => {
		const db = createTestDb();
		try {
			const image = imageMessage("user", 1);
			const result = stripPiProcessedImages({
				db,
				sessionId: "ses-image-cas-failure",
				messages: [image, assistantMessage("processed", 2)],
				detect: true,
				watermark: 5,
				messageIdToMaxTag: new Map([["entry-1", 1]]),
				stableId: idByTimestamp,
				addIds: () => false,
			});

			expect(result).toEqual({ stripped: 0, newlyStrippedIds: [] });
			expect((image.content[1] as { type: string }).type).toBe("image");
			expect(
				getProcessedImageStrippedIds(db, "ses-image-cas-failure").size,
			).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});
});
