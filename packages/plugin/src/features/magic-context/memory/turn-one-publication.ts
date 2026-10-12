import { randomUUID } from "node:crypto";
import type { Database } from "../../../shared/sqlite";
import { PROMOTABLE_CATEGORIES } from "./constants";
import { tsOwnsMemory } from "./lifecycle-applier";

/**
 * How a historian lane (one transport path to the historian model: the OpenCode host
 * prompt, the OpenCode 2 hidden completion, the Pi subagent, ...) runs its first
 * historian request, "turn one".
 * - `enabled`: the prompt has no project-memory block, facts carry source anchors,
 *   and every fact is published as a pending candidate (`memory_pending_facts`) for
 *   a later reconcile step to decide, instead of being promoted.
 * - `dormant`: the existing turn one. The prompt keeps the memory block, and facts
 *   are promoted through the lifecycle applier when this process holds memory
 *   authority (`tsOwnsMemory`).
 */
export type TurnOneLane = "enabled" | "dormant";

/**
 * A lane may run the `enabled` turn one only when its transport sends a response
 * schema the provider enforces (so a reply is either schema-valid JSON or an error,
 * never free text that could be misparsed into an automatic memory edit) and the
 * model profile the provider reports has passed a recorded replay of the trial
 * corpus. No transport (OpenCode host prompt, OpenCode 2 hidden completion, Pi
 * subagent, Rust host or Broca) sends such a field yet, so every production lane is
 * `dormant`. The override exists for tests that exercise the enabled contract.
 */
export function resolveTurnOneLane(override?: TurnOneLane): TurnOneLane {
    return override ?? "dormant";
}

/** The record persisted before turn one is dispatched. */
export interface TurnOneSend {
    publicationId: string;
    runAttempt: number;
    stageKey: string;
    lane: TurnOneLane;
}

export interface TurnOneSendInput {
    projectPath: string;
    sessionId: string;
    harness: string;
    /** Which transport carries the send, for diagnostics and later recovery. */
    carrier: string;
    lane: TurnOneLane;
    chunkStart: number;
    chunkEnd: number;
}

/**
 * Persist turn one's send record before the historian is dispatched, allocating the
 * publication id the compartment transaction will commit under. A publication that
 * never committed (a crash, a failed or refused pass) is reused by the session's
 * next run with the next `run_attempt`, so one chunk publishes under one id no
 * matter how many sends it took.
 */
export function allocateTurnOneSend(db: Database, input: TurnOneSendInput): TurnOneSend {
    return db
        .transaction((): TurnOneSend => {
            const reusable = db
                .prepare(
                    `SELECT p.publication_id FROM memory_publications p
                     WHERE p.project_path=? AND p.source_session_id=? AND p.commit_order IS NULL
                       AND EXISTS (SELECT 1 FROM memory_stage_attempts s
                                   WHERE s.publication_id=p.publication_id AND s.stage='turn_one'
                                     AND s.session_id=p.source_session_id AND s.harness=?)
                     ORDER BY p.rowid DESC LIMIT 1`,
                )
                .get(input.projectPath, input.sessionId, input.harness) as {
                publication_id: string;
            } | null;
            const publicationId = reusable?.publication_id ?? randomUUID();
            if (!reusable) {
                db.prepare(
                    "INSERT INTO memory_publications(publication_id,project_path,source_session_id) VALUES(?,?,?)",
                ).run(publicationId, input.projectPath, input.sessionId);
            }
            const prior = db
                .prepare(
                    "SELECT COALESCE(MAX(run_attempt),0) AS attempt FROM memory_stage_attempts WHERE project_path=? AND publication_id=? AND stage='turn_one'",
                )
                .get(input.projectPath, publicationId) as { attempt: number };
            const runAttempt = prior.attempt + 1;
            const stageKey = JSON.stringify([
                input.projectPath,
                publicationId,
                runAttempt,
                "turn_one",
            ]);
            db.prepare(
                `INSERT INTO memory_stage_attempts(stage_key,project_path,publication_id,run_attempt,stage,session_id,harness,carrier,state,request_json,started_at)
                 VALUES(?,?,?,?,'turn_one',?,?,?,'dispatched',?,?)`,
            ).run(
                stageKey,
                input.projectPath,
                publicationId,
                runAttempt,
                input.sessionId,
                input.harness,
                input.carrier,
                JSON.stringify({
                    lane: input.lane,
                    chunkStart: input.chunkStart,
                    chunkEnd: input.chunkEnd,
                }),
                Date.now(),
            );
            return { publicationId, runAttempt, stageKey, lane: input.lane };
        })
        .immediate();
}

/** A fact's source anchor as written by the historian (see `splitFactAnchorPrefix`). */
export interface TurnOneFactAnchor {
    compartmentIndex: number;
    startOrdinal?: number;
    endOrdinal?: number;
}

export interface TurnOneFact {
    category: string;
    content: string;
    anchor?: TurnOneFactAnchor;
}

/** A `[N]`/`[N-M]` line of the chunk text the historian was sent. */
export interface TurnOnePrintedBlock {
    role: string;
    startOrdinal: number;
    endOrdinal: number;
    parts: readonly string[];
}

export interface TurnOneCompartmentRange {
    startMessage: number;
    endMessage: number;
}

export interface ResolvedFactAnchor {
    /** 1-based position of the anchored compartment among the published ones. */
    compartmentIndex: number;
    /** Printed blocks that exactly tile the cited range, in order. */
    blockIndexes: number[];
}

/**
 * Resolve a fact's anchor against the compartments of the same reply that are being
 * published and the lines the historian was actually sent. Anything that does not
 * resolve exactly is unknown; nothing is guessed:
 * - the index must name a published compartment (a discarded tail does not count);
 * - the cited range must lie inside that compartment;
 * - the range must start at a printed line's start and end at a printed line's end,
 *   so the printed lines inside it tile it exactly.
 * `historian_validate::resolve_fact_anchor` in the Rust module applies the same rules.
 */
export function resolveTurnOneFactAnchor(
    anchor: TurnOneFactAnchor | undefined,
    compartments: readonly TurnOneCompartmentRange[],
    blocks: ReadonlyArray<{ startOrdinal: number; endOrdinal: number }>,
): ResolvedFactAnchor | null {
    if (!anchor || anchor.startOrdinal === undefined || anchor.endOrdinal === undefined) {
        return null;
    }
    const { compartmentIndex, startOrdinal, endOrdinal } = anchor;
    if (compartmentIndex < 1 || compartmentIndex > compartments.length) return null;
    if (startOrdinal > endOrdinal) return null;
    const compartment = compartments[compartmentIndex - 1];
    if (startOrdinal < compartment.startMessage || endOrdinal > compartment.endMessage) {
        return null;
    }
    const blockIndexes: number[] = [];
    blocks.forEach((block, index) => {
        if (block.startOrdinal >= startOrdinal && block.endOrdinal <= endOrdinal) {
            blockIndexes.push(index);
        }
    });
    if (blockIndexes.length === 0) return null;
    const first = blocks[blockIndexes[0]];
    const last = blocks[blockIndexes[blockIndexes.length - 1]];
    if (first.startOrdinal !== startOrdinal || last.endOrdinal !== endOrdinal) return null;
    return { compartmentIndex, blockIndexes };
}

/**
 * The printed blocks whose whole line reached the historian. The runner may cut the
 * chunk text to fit the producer window; a line past the cut was not seen, so an
 * anchor naming it stays unknown.
 */
export function blocksSentToHistorian<T extends { textEnd: number }>(
    blocks: readonly T[] | undefined,
    chunkText: string,
    sentText: string,
): T[] {
    if (!blocks) return [];
    let common = 0;
    const limit = Math.min(chunkText.length, sentText.length);
    while (common < limit && chunkText.charCodeAt(common) === sentText.charCodeAt(common)) {
        common += 1;
    }
    return blocks.filter((block) => block.textEnd <= common);
}

export interface TurnOnePublicationInput {
    send: TurnOneSend;
    projectPath: string;
    sessionId: string;
    /**
     * The durable rows just appended for this reply, in reply order. Each carries its
     * stored range (`startMessage`/`endMessage`) and the range the reply gave that
     * compartment (`replyStartMessage`/`replyEndMessage`). If any row's two ranges
     * differ, the rows cannot be trusted to be this reply's compartments, so no fact
     * anchor is resolved to them and every candidate is stored with an unknown anchor.
     */
    compartments: ReadonlyArray<{
        id: number;
        startMessage: number;
        endMessage: number;
        replyStartMessage: number;
        replyEndMessage: number;
    }>;
    /** Printed blocks the historian was sent; used only when anchors are honoured. */
    blocks: readonly TurnOnePrintedBlock[];
    /** Facts to record as candidates, in reply order. Empty when none are recorded. */
    candidateFacts: readonly TurnOneFact[];
    /**
     * Resolve each candidate's source anchor against `compartments` and `blocks`. Only
     * an `enabled` lane asks the historian for anchors; when false every candidate's
     * anchor is stored as unknown.
     */
    honourAnchors: boolean;
}

export interface TurnOnePublicationResult {
    commitOrder: number;
    candidatesInserted: number;
    anchoredCandidates: number;
    blocksStored: number;
    activityIncrements: number;
    /** True when the project's memory is owned by the Rust module. */
    authorityElsewhere: boolean;
}

function isPromotableFact(fact: TurnOneFact): boolean {
    return (
        typeof fact.category === "string" &&
        typeof fact.content === "string" &&
        fact.content.trim().length > 0 &&
        PROMOTABLE_CATEGORIES.some((category) => category === fact.category)
    );
}

/**
 * Commit turn one's publication inside the caller's compartment transaction:
 * - mark the publication committed exactly once and give it the next commit order;
 * - count each newly published compartment once in the project activity ledger;
 * - record the candidate facts with their stored source blocks.
 * Candidates need no memory authority, so they are written here even when the Rust
 * module owns the project's memory; their resolution goes through that authority.
 * Throws when the publication has already committed, which rolls the caller's
 * transaction back instead of publishing the same id twice.
 */
export function commitTurnOnePublication(
    db: Database,
    input: TurnOnePublicationInput,
): TurnOnePublicationResult {
    const now = Date.now();
    const committed = db
        .prepare(
            `UPDATE memory_publications
             SET commit_order=(SELECT COALESCE(MAX(commit_order),0)+1 FROM memory_publications), committed_at=?
             WHERE publication_id=? AND commit_order IS NULL`,
        )
        .run(now, input.send.publicationId);
    if (committed.changes !== 1) {
        throw new Error(`memory publication ${input.send.publicationId} is already committed`);
    }
    const { commit_order: commitOrder } = db
        .prepare("SELECT commit_order FROM memory_publications WHERE publication_id=?")
        .get(input.send.publicationId) as { commit_order: number };
    db.prepare("UPDATE memory_stage_attempts SET state='published' WHERE stage_key=?").run(
        input.send.stageKey,
    );

    let activityIncrements = 0;
    const ledger = db.prepare(
        "INSERT OR IGNORE INTO memory_activity_ledger(project_path,publication_id,compartment_id,committed_at) VALUES(?,?,?,?)",
    );
    for (const compartment of input.compartments) {
        activityIncrements += ledger.run(
            input.projectPath,
            input.send.publicationId,
            compartment.id,
            now,
        ).changes;
    }

    const authorityElsewhere = !tsOwnsMemory(db, input.projectPath);
    const bound = input.compartments.every(
        (row) =>
            row.startMessage === row.replyStartMessage && row.endMessage === row.replyEndMessage,
    );
    const ranges = input.compartments.map((row) => ({
        startMessage: row.startMessage,
        endMessage: row.endMessage,
    }));
    const insertFact = db.prepare(
        `INSERT OR IGNORE INTO memory_pending_facts(project_path,publication_id,fact_index,compartment_id,category,content,anchor_known,state,fact_attempts,reason)
         VALUES(?,?,?,?,?,?,?,'retryable',0,?)`,
    );
    const insertBlock = db.prepare(
        "INSERT OR IGNORE INTO memory_fact_blocks(publication_id,source_session_id,start_ordinal,end_ordinal,role,parts_json,joined_text) VALUES(?,?,?,?,?,?,?)",
    );
    const findBlock = db.prepare(
        "SELECT id FROM memory_fact_blocks WHERE publication_id=? AND start_ordinal=? AND end_ordinal=?",
    );
    const linkBlock = db.prepare(
        "INSERT OR IGNORE INTO memory_fact_block_links(fact_id,block_id) VALUES(?,?)",
    );
    let candidatesInserted = 0;
    let anchoredCandidates = 0;
    let blocksStored = 0;
    input.candidateFacts.forEach((fact, factIndex) => {
        if (!isPromotableFact(fact)) return;
        const resolved =
            input.honourAnchors && bound
                ? resolveTurnOneFactAnchor(fact.anchor, ranges, input.blocks)
                : null;
        const compartmentId = resolved
            ? input.compartments[resolved.compartmentIndex - 1].id
            : null;
        const inserted = insertFact.run(
            input.projectPath,
            input.send.publicationId,
            factIndex,
            compartmentId,
            fact.category,
            fact.content,
            resolved ? 1 : 0,
            authorityElsewhere ? "authority_elsewhere" : null,
        );
        if (inserted.changes !== 1) return;
        candidatesInserted += 1;
        if (!resolved) return;
        anchoredCandidates += 1;
        const factId = Number(inserted.lastInsertRowid);
        for (const blockIndex of resolved.blockIndexes) {
            const block = input.blocks[blockIndex];
            blocksStored += insertBlock.run(
                input.send.publicationId,
                input.sessionId,
                block.startOrdinal,
                block.endOrdinal,
                block.role,
                JSON.stringify(block.parts),
                block.parts.join(" / "),
            ).changes;
            const { id } = findBlock.get(
                input.send.publicationId,
                block.startOrdinal,
                block.endOrdinal,
            ) as { id: number };
            linkBlock.run(factId, id);
        }
    });

    return {
        commitOrder,
        candidatesInserted,
        anchoredCandidates,
        blocksStored,
        activityIncrements,
        authorityElsewhere,
    };
}
