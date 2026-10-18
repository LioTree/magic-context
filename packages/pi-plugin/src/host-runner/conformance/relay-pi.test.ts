import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	generatePiVectors,
	PI_VECTOR_PATH,
	type PiVectorFile,
	replayPiExchangesAgainstMc,
} from "./generate";

const bytes = readFileSync(PI_VECTOR_PATH, "utf8");
const vectors = JSON.parse(bytes) as PiVectorFile;
const exchangesOf = (file: PiVectorFile, id: string) =>
	file.cases
		.filter((vector) => vector.id === id)
		.flatMap((vector) => vector.steps.flatMap((step) => step.exchanges));

test("Pi relay vectors regenerate byte-identically through the real adapter and McHandler", async () => {
	const first = `${JSON.stringify(await generatePiVectors(), null, 4)}\n`;
	expect(first).toBe(bytes);
	const second = `${JSON.stringify(await generatePiVectors(), null, 4)}\n`;
	expect(second).toBe(first);
	const parsed = JSON.parse(first) as PiVectorFile;
	expect(parsed.cases.map((item) => item.id)).toEqual([
		"single-op-retry",
		"hook-timeout-fallback-freeze",
		"receipt-publish-and-complete",
		"native-cut-applied-and-recovered",
		"tree-branch-switch",
		"forked-session",
		"session-delete-idempotent-and-terminal-step",
	]);
	// Steps and exchanges use relay-v1's field names, in relay-v1's key order.
	for (const vector of parsed.cases) {
		expect(Object.keys(vector)).toEqual(["id", "steps", "expected"]);
		expect(vector.steps.length).toBeGreaterThan(0);
		for (const step of vector.steps) {
			expect(Object.keys(step)).toEqual(["action", "exchanges"]);
			for (const exchange of step.exchanges)
				expect(Object.keys(exchange)).toEqual([
					"method",
					"request_bytes",
					"answer_bytes",
					"delivery",
				]);
		}
	}
	const exchanges = parsed.cases.flatMap((vector) =>
		vector.steps.flatMap((step) => step.exchanges),
	);
	expect(new Set(exchanges.map((exchange) => exchange.method))).toEqual(
		new Set([
			"transform.declare",
			"compaction.setup",
			"state_sync",
			"compaction.step",
			"transform.hook",
			"compaction.delete",
		]),
	);
	const frozen = exchangesOf(parsed, "hook-timeout-fallback-freeze");
	expect(frozen.map((exchange) => exchange.delivery)).toEqual(["timeout"]);
	// Run-specific UUIDs and wall-clock times never reach the recorded bytes.
	expect(first).not.toMatch(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
	);
	expect(first).not.toMatch(/\\"now\\":\d{6,}/);
}, 300_000);

test("recorded Pi exchanges replay against a fresh McHandler with byte-identical answers", async () => {
	const recorded = vectors.cases.flatMap((vector) =>
		vector.steps.flatMap((step) => step.exchanges),
	).length;
	expect(recorded).toBe(25);
	expect(await replayPiExchangesAgainstMc(vectors)).toBe(recorded);
}, 300_000);

test("Pi exchange replay rejects a single changed answer byte", async () => {
	const mutated = structuredClone(vectors);
	const [hook] = exchangesOf(mutated, "single-op-retry").filter(
		(exchange) => exchange.method === "transform.hook",
	);
	const at = hook.answer_bytes.indexOf("§1§");
	expect(at).toBeGreaterThan(0);
	// One byte: the visible tag number 1 becomes 2 in MC's recorded hook answer.
	hook.answer_bytes = `${hook.answer_bytes.slice(0, at + 1)}2${hook.answer_bytes.slice(at + 2)}`;
	await expect(replayPiExchangesAgainstMc(mutated)).rejects.toThrow(
		"single-op-retry step 2 exchange 0 (transform.hook): MC answer bytes differ",
	);
}, 300_000);
