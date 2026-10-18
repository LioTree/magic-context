import { test } from "bun:test";
import { dashboardCacheProof } from "../../plugin/src/hooks/magic-context/dashboard-cache-proof";
import { _resetHarnessForTesting } from "../../plugin/src/shared/harness";
import { injectM0M1Pi } from "./inject-compartments-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

test("Pi dashboard delta holds, admits, freezes across SOFT+, and folds naturally", () => {
	_resetHarnessForTesting();
	const db = createTestDb();
	let generation = 0;
	try {
		dashboardCacheProof(
			db,
			"git:dashboard-proof",
			"pi-dashboard-proof",
			(bust, hard) => {
				if (hard) generation++;
				const messages = [userMessage("tail", 1)];
				const result = injectM0M1Pi(
					{
						sessionId: "pi-dashboard-proof",
						projectIdentity: "git:dashboard-proof",
						projectPath: "/nonexistent",
						injectDocs: false,
						injectionBudgetTokens: 10000,
						historyBudgetTokens: 10000,
						hardSignals: {
							modelKey: `model-${generation}`,
							systemHash: "",
							cacheExpired: false,
							lastResponseTime: 0,
						},
					},
					db,
					messages as never,
					undefined,
					bust,
				);
				return {
					m0: textOf(messages[0] as never),
					m1: textOf(messages[1] as never),
					hard: result.m0Materialized,
				};
			},
		);
	} finally {
		db.close();
		_resetHarnessForTesting();
	}
});
