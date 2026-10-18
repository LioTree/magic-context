import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Retained read results exercise a long-lived saved prefix. Every returned
// request must retain that record under signed thinking and fit the calibrated
// window. The separate shrunken-window test exercises the held-replay guard.
test("held-head witness: record hold and calibrated fit on every served request", () => {
	const root = resolve(import.meta.dir, "../../..");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		BUN_JSC_useOMGJIT: "0",
		R2_SEEDS: "8",
		R2_PASSES: "69",
		R2_WINDOW: "100000",
		R2_SERVED_EVIDENCE: "1",
	};
	delete env.OPENCODE_DB;
	const result = spawnSync(
		process.execPath,
		[
			"test",
			"--preload",
			resolve(import.meta.dir, "__tests__/held-head-retained-tools.preload.ts"),
			resolve(import.meta.dir, "issue-665-hold-review-r2.test.ts"),
			"-t",
			"Pi held driver seed 8:",
			"--timeout",
			"180000",
		],
		{ cwd: root, env, encoding: "utf8", timeout: 180000, windowsHide: true },
	);
	expect(result.stderr).toContain("Pi held driver seed 8:");
	expect(result.status, result.stdout + result.stderr).toBe(0);
	const prefix = "PI_SERVED_WINDOW ";
	const evidence = result.stdout
		.split("\n")
		.filter((line) => line.startsWith(prefix))
		.map((line) => JSON.parse(line.slice(prefix.length)));
	expect(evidence.length).toBeGreaterThanOrEqual(69);
	expect(evidence.some((request) => request.held)).toBe(true);
	for (const [index, request] of evidence.entries()) {
		expect(request).toMatchObject({
			request: index + 1,
			limit: 100000,
			calibrated: true,
			recordValid: true,
		});
		expect(request.tokens).toBeGreaterThan(0);
		expect(request.tokens).toBeLessThanOrEqual(request.limit);
	}
	console.log(
		"PI_RECORD_WINDOW_WITNESS",
		JSON.stringify({
			requests: evidence.length,
			held: evidence.filter((request) => request.held).length,
			maxTokens: Math.max(...evidence.map((request) => request.tokens)),
			limit: 100000,
		}),
	);
}, 180000);
