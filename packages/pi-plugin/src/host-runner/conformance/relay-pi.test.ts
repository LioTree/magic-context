import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generatePiVectors, PI_VECTOR_PATH } from "./generate";

test("Pi relay vectors regenerate byte-identically through the real adapter and McHandler", async () => {
	const first = `${JSON.stringify(await generatePiVectors(), null, 4)}\n`;
	expect(first).toBe(readFileSync(PI_VECTOR_PATH, "utf8"));
	const second = `${JSON.stringify(await generatePiVectors(), null, 4)}\n`;
	expect(second).toBe(first);
	expect(
		JSON.parse(first).cases.map((item: { id: string }) => item.id),
	).toEqual([
		"single-op-retry",
		"hook-timeout-fallback-freeze",
		"receipt-publish-and-complete",
		"native-cut-applied-and-recovered",
		"tree-branch-switch",
		"forked-session",
	]);
}, 180_000);
