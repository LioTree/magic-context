import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { dashboardCacheProof } from "./dashboard-cache-proof.test";
import { clearInjectionCache, injectM0M1 } from "./inject-compartments";

for (const host of ["opencode", "opencode2"] as const) {
    test(`${host} dashboard delta holds, admits, freezes across SOFT+, and folds naturally`, () => {
        const db = new Database(":memory:");
        _resetHarnessForTesting();
        setHarness(host);
        initializeDatabase(db);
        runMigrations(db);
        let generation = 0;
        try {
            dashboardCacheProof(db, "git:dashboard-proof", host, (bust, hard) => {
                if (hard) generation++;
                const result = injectM0M1({
                    db,
                    sessionId: host,
                    projectPath: "git:dashboard-proof",
                    injectDocs: false,
                    memoryInjectionBudgetTokens: 10000,
                    historyBudgetTokens: 10000,
                    state: getOrCreateSessionMeta(db, host),
                    hardSignals: {
                        modelKey: `model-${generation}`,
                        systemHash: "",
                        cacheExpired: false,
                        lastResponseTime: 0,
                    },
                    messages: [
                        {
                            info: { id: "tail", role: "user" },
                            parts: [{ type: "text", text: "tail" }],
                        },
                    ],
                    isCacheBustingPass: bust,
                });
                expect(result.m0Bytes).not.toBeNull();
                return {
                    m0: result.m0Bytes!.toString(),
                    m1: result.m1Text ?? "",
                    hard: result.m0RematerializedThisPass,
                };
            });
        } finally {
            clearInjectionCache(host);
            db.close();
            _resetHarnessForTesting();
        }
    });
}
