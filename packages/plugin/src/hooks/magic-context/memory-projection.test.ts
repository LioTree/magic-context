import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    type ProjectionFixture,
    type ProjectionOptions,
    registerMemoryProjectionRegressions,
} from "../../shared/memory-projection-fixtures.test";
import { injectM0M1, materializeM0 } from "./inject-compartments";

function options(f: ProjectionFixture, sessionId: string, render: ProjectionOptions = {}) {
    return {
        db: f.db,
        state: getOrCreateSessionMeta(f.db, sessionId),
        sessionId,
        projectPath: f.projectPath,
        projectDirectory: f.directory,
        injectDocs: false,
        memoryInjectionBudgetTokens: render.memoryBudget,
        historyBudgetTokens: render.historyBudget,
        hardSignals: {
            systemHash: "system",
            modelKey: "anthropic/claude",
            cacheExpired: render.cacheExpired ?? false,
            // An idle expiry folds only for a response newer than the last fold.
            lastResponseTime: render.cacheExpired ? Date.now() + 60_000 : 1,
        },
    };
}

registerMemoryProjectionRegressions({
    host: "OpenCode",
    hard: (f, sessionId, render) => {
        materializeM0(options(f, sessionId, render));
    },
    pass: (f, sessionId, busting, render) => {
        const result = injectM0M1({
            ...options(f, sessionId, render),
            isCacheBustingPass: busting,
        });
        return {
            m0: result.m0Bytes?.toString("utf8") ?? "",
            m1: result.m1Text ?? "",
            materialized: result.m0RematerializedThisPass,
        };
    },
});
