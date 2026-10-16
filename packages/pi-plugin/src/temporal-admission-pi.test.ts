import { expect, it } from "bun:test";
import { admitTemporalCandidates } from "@magic-context/core/hooks/magic-context/temporal-admission";
import {
	collectPiTemporalCandidates,
	injectPiTemporalMarkers,
} from "./temporal-awareness-pi";

it("Pi temporal decisions and first applications use the renderer's stable resolver", () => {
	const messages: unknown[] = [
		{ role: "assistant", timestamp: 1000, content: [] },
		{
			role: "user",
			timestamp: 721000,
			content: [{ type: "image" }, { type: "text", text: "question" }],
		},
	];
	const resolveId = (_message: unknown, index: number) =>
		index === 1 ? "entry-by-reference" : "earlier";
	const candidates = collectPiTemporalCandidates(
		messages,
		["wrong-0", "wrong-1"],
		resolveId,
	);
	expect([...candidates]).toEqual([["entry-by-reference", "<!-- +12m -->\n"]]);
	const admitted = admitTemporalCandidates({
		candidates,
		frozen: new Map(),
		locations: [{ id: resolveId(messages[1], 1), block: 1 }],
		admission: { frame: { kind: "none" }, admit: () => true },
	});
	const edits: string[] = [];
	const apply = (frozen: ReadonlyMap<string, string>) =>
		injectPiTemporalMarkers(
			messages,
			frozen,
			resolveId,
			(message, index, block) => {
				const id = resolveId(message, index);
				if (admitted.has(id)) edits.push(`${id}:${block}`);
			},
		);
	expect(apply(admitted)).toBe(1);
	expect(edits).toEqual(["entry-by-reference:1"]);
	expect(apply(admitted)).toBe(0);
	const replay = structuredClone(messages);
	(replay[1] as { content: { text?: string }[] }).content[1].text = "question";
	const replayEdits: string[] = [];
	const newCandidates = admitTemporalCandidates({
		candidates,
		frozen: admitted,
		locations: [{ id: "entry-by-reference", block: 1 }],
		admission: {
			frame: { kind: "none" },
			admit: () => {
				throw new Error("replay must not ask admission");
			},
		},
	});
	expect(
		injectPiTemporalMarkers(replay, admitted, resolveId, (m, i) => {
			if (newCandidates.has(resolveId(m, i))) replayEdits.push("new");
		}),
	).toBe(1);
	expect(replayEdits).toEqual([]);
});
