/**
 * Runs historian turn two after turn one's publication committed, on the child
 * turn one ran in. Only an `enabled` lane reaches this (see `resolveTurnOneLane`).
 */

import type { ReportedProfile } from "../../features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "../../features/magic-context/memory/lifecycle-text";
import { runTurnTwo, type TurnTwoRunResult } from "../../features/magic-context/memory/turn-two";
import type { TurnTwoQueryEmbedder } from "../../features/magic-context/memory/turn-two-retrieval";
import type { TurnTwoExcerptReader } from "../../features/magic-context/memory/turn-two-scoring";
import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/project-embedding-registry";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { RetainedHistorianChild } from "./compartment-runner-types";
import {
    createOpenCodeTurnTwoCarrier,
    createOpenCodeTurnTwoRecovery,
} from "./historian-turn-two-carrier";
import { readSessionChunk } from "./read-session-chunk";

/** Reads a save's excerpt window from the session's raw source. */
export const readTurnTwoExcerpt: TurnTwoExcerptReader = (sessionId, from, to) => {
    const chunk = readSessionChunk(sessionId, Number.MAX_SAFE_INTEGER, from, to + 1);
    const blocks = (chunk.printedBlocks ?? []).filter(
        (block) => block.startOrdinal >= from && block.endOrdinal <= to,
    );
    if (blocks.length === 0) return null;
    const ordinals: number[] = [];
    for (const block of blocks)
        for (let ordinal = block.startOrdinal; ordinal <= block.endOrdinal; ordinal++)
            ordinals.push(ordinal);
    const text = blocks
        .map(
            (block) =>
                `[${block.startOrdinal === block.endOrdinal ? block.startOrdinal : `${block.startOrdinal}-${block.endOrdinal}`}] ${block.role}: ${block.parts.join(" / ")}`,
        )
        .join("\n");
    return { text, ordinals };
};

/** Embeds a fact under the project's current embedding model, for neighbour ranking. */
function projectEmbedder(projectPath: string): TurnTwoQueryEmbedder {
    return async (text) => {
        if (!getProjectEmbeddingSnapshot(projectPath)) return null;
        const embedded = await embedTextForProject(projectPath, text);
        return embedded ? { vector: embedded.vector, modelId: embedded.modelId } : null;
    };
}

export async function runHistorianTurnTwo(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    publicationId: string;
    child: RetainedHistorianChild;
    harness: string;
    carrier: string;
    memoryEnabled: boolean;
    autoPromote: boolean;
    timeoutMs: number;
    validatedProfiles?: readonly ReportedProfile[];
    embedQuery?: TurnTwoQueryEmbedder;
}): Promise<TurnTwoRunResult> {
    const log = (message: string) => sessionLog(args.sessionId, message);
    const result = await runTurnTwo(args.db, {
        projectPath: args.projectPath,
        publicationId: args.publicationId,
        sessionId: args.sessionId,
        // Only an enabled lane retains its child, and enabling a lane requires a
        // carrier whose provider enforces the response schema.
        lane: "enabled",
        carrier: createOpenCodeTurnTwoCarrier({
            child: args.child,
            parentSessionId: args.sessionId,
            harness: args.harness,
            carrier: args.carrier,
            enforcedJson: true,
            turnOneText: args.child.turnOneText,
            timeoutMs: args.timeoutMs,
        }),
        memoryEnabled: args.memoryEnabled,
        autoPromote: args.autoPromote,
        validatedProfiles: args.validatedProfiles ?? [],
        embedQuery: args.embedQuery ?? projectEmbedder(args.projectPath),
        readExcerpt: readTurnTwoExcerpt,
        recover: createOpenCodeTurnTwoRecovery({
            executor: args.child.executor,
            carrier: args.carrier,
            harness: args.harness,
            directory: args.child.directory,
            timeoutMs: args.timeoutMs,
        }),
        log,
    });
    log(
        `historian turn two: ${result.status}${result.reason ? ` (${result.reason})` : ""}${result.childInFlight ? "; child kept open while a stage is in flight" : ""} historianSystem=${lifecycleTextHash(args.child.system).slice(0, 12)}`,
    );
    return result;
}
