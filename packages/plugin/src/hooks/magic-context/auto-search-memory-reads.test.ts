import { expect, spyOn, test } from "bun:test";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import {
    createProjectionFixture,
    isDashboardPayloadRead,
    type ProjectionFixture,
} from "../../shared/memory-projection-fixtures.test";
import * as autoSearch from "./auto-search-runner";
import { materializeM0 } from "./inject-compartments";
import { runPostTransformPhase } from "./transform-postprocess-phase";

/**
 * Automatic search is one of the two named memory readers outside the memory pair
 * (with explicit ctx_search). It reads current memory only while computing a new
 * hint for a new user message; a pass that replays an already-decided message reads
 * no canonical memories or log heads. Authorized SOFTs may still load immutable
 * dashboard payloads independently of search; no hint changes m[0]/m[1].
 */

/** Record every executed statement that reads memories or the mutation log. */
function observeMemoryReads(f: ProjectionFixture) {
    const seen: string[] = [];
    let on = false;
    const prepare = f.db.prepare.bind(f.db);
    Object.defineProperty(f.db, "prepare", {
        configurable: true,
        writable: true,
        value: (sql: string) => {
            const statement = prepare(sql);
            if (/\b(?:FROM|JOIN)\s+(?:memories|memory_mutation_log)\b/i.test(sql))
                for (const method of ["get", "all", "values", "iterate"] as const) {
                    const original = (statement as unknown as Record<string, unknown>)[method];
                    if (typeof original !== "function") continue;
                    Object.defineProperty(statement, method, {
                        configurable: true,
                        value: (...args: unknown[]) => {
                            if (on) seen.push(sql);
                            return (original as (...a: unknown[]) => unknown).apply(
                                statement,
                                args,
                            );
                        },
                    });
                }
            return statement;
        },
    });
    return {
        seen,
        start: () => {
            seen.length = 0;
            on = true;
        },
        stop: () => {
            on = false;
        },
    };
}

function m0m1Args(f: ProjectionFixture, sessionId: string) {
    return {
        db: f.db,
        state: getOrCreateSessionMeta(f.db, sessionId),
        sessionId,
        projectPath: f.projectPath,
        projectDirectory: f.directory,
        injectDocs: false,
        hardSignals: {
            systemHash: "system",
            modelKey: "anthropic/claude",
            cacheExpired: false,
            lastResponseTime: 1,
        },
    };
}

function postArgs(
    f: ProjectionFixture,
    sessionId: string,
    busting: boolean,
): Parameters<typeof runPostTransformPhase>[0] {
    return {
        sessionId,
        db: f.db,
        messages: [
            {
                info: { id: "fresh-user", role: "user" },
                parts: [{ type: "text", text: "ordinary append" }],
            },
        ],
        tags: [],
        targets: new Map(),
        reasoningByMessage: new Map(),
        messageTagNumbers: new Map(),
        tagger: createTagger(),
        ctxReduceAvailability: { callable: true, frozen: true },
        todowriteAvailability: { callable: true, frozen: true },
        batch: null,
        contextUsage: { percentage: 20, inputTokens: 1000 },
        usableWindow: 128000,
        schedulerDecision: busting ? "execute" : "defer",
        schedulerDeferReason: "scheduler_defer",
        fullFeatureMode: true,
        canRunCompartments: false,
        awaitedCompartmentRun: false,
        phaseJustAwaitedPublication: false,
        compartmentInProgress: false,
        historyRefreshExplicitBeforePrepare: false,
        deferredHistoryWasPendingAtPassStart: false,
        compartmentInjectionRebuiltFromDb: false,
        rebuiltHistoryFromInitialPrepare: false,
        historyRebuiltThisPass: false,
        canConsumeDeferredLate: false,
        sessionMeta: getOrCreateSessionMeta(f.db, sessionId),
        currentTurnId: "fresh-user",
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 999,
        protectedTagIds: new Set(),
        protectedTagNumbers: new Set(),
        protectedCutoff: null,
        protectedCount: 0,
        pendingCompartmentInjection: null,
        didMutateFromFlushedStatuses: false,
        watermark: 0,
        forceMaterializationPercentage: 85,
        hasRecentReduceCall: false,
        projectPath: f.projectPath,
        autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 },
        m0M1: m0m1Args(f, sessionId),
    };
}

for (const busting of [false, true])
    test(`a ${busting ? "busting" : "defer"} postprocess pass reads memory only when automatic search computes a new hint`, async () => {
        const f = createProjectionFixture(`auto-search-${busting}`);
        const reads = observeMemoryReads(f);
        let computeNewHint = false;
        const search = spyOn(autoSearch, "runAutoSearchHint").mockImplementation(
            async ({ options }) => {
                // A replayed decision never asks for visibility; a new hint does.
                expect(options.visibleMemoryIds).toBeUndefined();
                if (computeNewHint) options.resolveVisibleMemoryIds?.();
                return { ok: true };
            },
        );
        try {
            const [a] = f.sessions;
            insertMemory(f.db, {
                projectPath: f.projectPath,
                category: "ARCHITECTURE",
                content: "Served text for automatic visibility.",
            });
            materializeM0(m0m1Args(f, a));
            const m0 = getOrCreateSessionMeta(f.db, a).cachedM0Bytes;

            reads.start();
            const replay = await runPostTransformPhase(postArgs(f, a, busting));
            reads.stop();
            expect(replay.materialized).toBe(false);
            expect(search).toHaveBeenCalledTimes(1);
            expect(reads.seen.filter((sql) => !isDashboardPayloadRead(sql))).toEqual([]);
            if (!busting) expect(reads.seen).toEqual([]);

            computeNewHint = true;
            reads.start();
            await runPostTransformPhase(postArgs(f, a, busting));
            reads.stop();
            expect(reads.seen.length).toBeGreaterThan(0);
            expect(reads.seen.some((sql) => /FROM memories/i.test(sql))).toBe(true);
            expect(
                reads.seen.every(
                    (sql) => /FROM memories/i.test(sql) || isDashboardPayloadRead(sql),
                ),
            ).toBe(true);
            expect(getOrCreateSessionMeta(f.db, a).cachedM0Bytes).toEqual(m0);
        } finally {
            search.mockRestore();
            f.close();
        }
    });
