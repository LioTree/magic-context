/**
 * Computes how many trailing messages Magic Context's protected tail would keep raw for the answer
 * model, using the production boundary code on the conversation's own stores.
 *
 * Run it as a child process whose environment points every store at a SCRATCH COPY of the root
 * (see `rootEnv` in host.ts): resolving the boundary seeds per-session metadata in context.db, and
 * that write must not reach the snapshot the questions are answered from.
 *
 * It resolves the boundary in `trigger` mode, the mode the transform uses before a historian run,
 * with the usage the first question turn would report: every raw message, tokenized by the same
 * index the boundary walks, over the answer model's context limit. Output is one JSON line.
 *
 * The session is passed the protected-tail metadata of a session that grew under Magic Context
 * from its first message (policy version 3, prior boundary 1). Without it, the boundary code treats
 * the offline-written session as one that predates that policy and floors the tail at the legacy
 * "last five user turns", which no session that grew under Magic Context ever carries. The
 * metadata is only an input; no production code is changed.
 *
 *   bun boundary-probe.ts <sessionId> <contextLimit> <executeThresholdPercentage>
 */
import { openDatabase } from "../../src/features/magic-context/storage-db";
import { resolveOpenCodeProtectedTailBoundary } from "../../src/hooks/magic-context/protected-tail-boundary";
import { prewarmRawSessionOrdinalsForDb } from "../../src/hooks/magic-context/raw-ordinal-warmup";
import { readRawSessionMessages } from "../../src/hooks/magic-context/read-session-chunk";
import { withReadOnlySessionDb } from "../../src/hooks/magic-context/read-session-db";
import { buildTrueRawTokenIndex } from "../../src/hooks/magic-context/read-session-true-raw-tokens";

export interface BoundaryProbeResult {
    rawMessageCount: number;
    sessionTokens: number;
    usagePercentage: number;
    protectedTailStart: number;
    /** Trailing messages kept raw: the `/ctx-wrapup` argument. */
    messagesToKeep: number;
    tailTokens: number;
    tailTargetTokens: number;
    boundaryReason: string;
}

if (import.meta.main) {
    const [sessionId, limitText, thresholdText] = process.argv.slice(2);
    if (!sessionId || !limitText || !thresholdText) {
        console.error(
            "usage: boundary-probe.ts <sessionId> <contextLimit> <executeThresholdPercentage>",
        );
        process.exit(2);
    }
    const contextLimit = Number(limitText);
    const executeThresholdPercentage = Number(thresholdText);
    const db = openDatabase();
    if (!db) throw new Error("could not open the scratch context database");
    // Large offline sessions need the same canonical ordinal preparation as a live transform.
    const readiness = await withReadOnlySessionDb((rawDb) =>
        prewarmRawSessionOrdinalsForDb(rawDb, sessionId),
    );
    if (readiness !== "warm")
        throw new Error(`could not prepare scratch raw ordinals for ${sessionId}`);
    const messages = readRawSessionMessages(sessionId);
    const index = buildTrueRawTokenIndex(sessionId, messages, {
        providerShapeVersion: "opencode-v1",
        cacheNamespace: `opencode:${sessionId}`,
    });
    const sessionTokens = index.rangeTokens(1, index.rawMessageCount + 1);
    const usagePercentage = (sessionTokens / contextLimit) * 100;
    const snapshot = resolveOpenCodeProtectedTailBoundary({
        db,
        sessionId,
        mode: "trigger",
        contextLimit,
        executeThresholdPercentage,
        usage: { percentage: usagePercentage, inputTokens: sessionTokens },
        usageSource: "live",
        protectedTailMeta: { priorBoundaryOrdinal: 1, protectedTailPolicyVersion: 3 },
    });
    const result: BoundaryProbeResult = {
        rawMessageCount: snapshot.rawMessageCountAtTrigger,
        sessionTokens,
        usagePercentage,
        protectedTailStart: snapshot.protectedTailStart,
        messagesToKeep: snapshot.rawMessageCountAtTrigger - snapshot.protectedTailStart + 1,
        tailTokens: index.rangeTokens(snapshot.protectedTailStart, index.rawMessageCount + 1),
        tailTargetTokens: snapshot.N,
        boundaryReason: snapshot.boundaryReason,
    };
    console.log(JSON.stringify(result));
    db.close();
}
