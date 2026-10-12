/**
 * Historian turn two: reconcile candidate facts with existing project memory on the
 * same hidden child session that ran turn one, and resolve each fact through the
 * shared applier.
 *
 * Fact states (`memory_pending_facts.state`):
 * - `retryable`: nothing decided, no reservation. Only these are ever sent.
 * - `in_flight`: reserved by one turn-two stage record. The reservation is written in
 *   the same transaction that persists the stage key, before dispatch, and holds
 *   through the reply, every narrow check and the resolving transaction. While the
 *   outcome is unknown (a crash, a lost reply) it stays, and recovery reattaches the
 *   original stage key and `run_attempt` instead of sending again.
 * - `applied`, `covered`, `decided_pending`: terminal this release.
 *
 * Outcomes that consume an attempt (`fact_attempts` +1, `decided_pending` once it
 * reaches `MAX_STAGE2_ATTEMPTS`): a stage-2 transport failure, an unparseable,
 * length-capped or schema-invalid envelope (every fact of the send), a check
 * transport failure, an unvalidated reported profile for an edit, a CAS loss, and a
 * carrier that reports on recovery that the send or child no longer exists.
 * Pre-send skips (dormant lane, a carrier that cannot continue the child,
 * `authority_elsewhere`, the backlog limit) consume nothing.
 */
import type { Database } from "../../../shared/sqlite";
import {
    type ApplierReceipt,
    applyHistorianRevision,
    applyMemoryAdmission,
    resolveFactDecision,
    tsOwnsMemory,
} from "./lifecycle-applier";
import { RETRY_BACKLOG_PER_RUN } from "./lifecycle-constants";
import {
    type AddedClause,
    type ChangedClause,
    CheckOutcomeUnknownError,
    type CheckReply,
    type CheckRequest,
    type GateContext,
    type ReportedProfile,
    type RevisionDecision,
} from "./lifecycle-gates";
import { type EvidenceBlock, normalizeLifecycleText, splitMemoryClauses } from "./lifecycle-text";
import { getMemoryById } from "./storage-memory";
import type { TurnOneLane } from "./turn-one-publication";
import {
    buildTurnTwoPrompt,
    parseTurnTwoEnvelope,
    type TurnTwoDecision,
    type TurnTwoPromptFact,
} from "./turn-two-envelope";
import { retrieveTurnTwoNeighbours, type TurnTwoQueryEmbedder } from "./turn-two-retrieval";
import {
    classificationWatermark,
    dueItemSequences,
    promptItems,
    recordItemScores,
    storeDueExcerpts,
    type TurnTwoExcerptReader,
} from "./turn-two-scoring";
import type { MemoryCategory } from "./types";

export const TURN_TWO_STAGE = "turn_two";

/** What a carrier hands back for one turn-two send. */
export interface TurnTwoStageReply {
    text: string;
    lengthCapped: boolean;
    /**
     * The profile the provider reported for this reply (provider, the model id it
     * actually answered with, variant, temperature, and the historian system hash).
     * Null when the carrier could not tell; edits then defer.
     */
    profile: ReportedProfile | null;
    usage?: unknown;
}

/**
 * Thrown by a carrier when it cannot tell whether a send was answered. The facts
 * stay reserved and the child stays open; recovery reattaches the stage later.
 */
export class TurnTwoOutcomeUnknownError extends Error {
    constructor(message = "turn two outcome unknown") {
        super(message);
        this.name = "TurnTwoOutcomeUnknownError";
    }
}

export type TurnTwoReattach =
    | { kind: "reply"; reply: TurnTwoStageReply }
    /** The carrier is reachable but has no answer yet; the reservation stays. */
    | { kind: "unknown" }
    /** The carrier reports that the send or the child no longer exists. */
    | { kind: "gone" };

/** Sends narrow checks: each a fresh single-turn call, never on the historian child. */
export interface TurnTwoCheckCarrier {
    check(request: CheckRequest): Promise<CheckReply>;
    /**
     * Reattach a check an earlier run dispatched under `request.key`, without
     * sending it again. Absent when this process cannot reach such a check; the
     * check then stays dispatched and its fact stays reserved.
     */
    reattachCheck?(request: CheckRequest): Promise<CheckReply>;
}

/** The carrier of this run: the retained turn-one child plus a check sender. */
export interface TurnTwoCarrier extends TurnTwoCheckCarrier {
    /** Carrier kind written on stage records, so recovery can find its carrier again. */
    readonly carrier: string;
    readonly harness: string;
    /** True only when the provider enforces the turn-two response schema. */
    readonly enforcedJson: boolean;
    /** The turn-one child this carrier continues; null when it cannot continue one. */
    readonly childSessionId: string | null;
    /**
     * What the child showed before turn two was sent (for example a hash of turn
     * one's reply), stored on the stage record so recovery can tell whether a reply
     * to turn two has arrived.
     */
    readonly baseline?: string;
    /** Continue the child with the turn-two prompt (a second turn, same session id). */
    send(prompt: string, stageKey: string): Promise<TurnTwoStageReply>;
}

/** A stage record as recovery sees it. */
export interface TurnTwoStageRecord {
    stageKey: string;
    projectPath: string;
    publicationId: string;
    runAttempt: number;
    sessionId: string;
    harness: string;
    carrier: string;
    childSessionId: string | null;
    startedAt: number;
    baseline: string | null;
}

/** Reaches the carrier of an earlier stage, or null when this process cannot. */
export type TurnTwoRecoveryResolver = (record: TurnTwoStageRecord) =>
    | (TurnTwoCheckCarrier & {
          reattach(): Promise<TurnTwoReattach>;
          /** Close the stage's child once nothing of it is in flight any more. */
          close?(): Promise<void>;
      })
    | null;

export interface TurnTwoRunInput {
    projectPath: string;
    /** The publication turn one just committed; its facts and this stage's key. */
    publicationId: string;
    /** The session the historian ran for (the stage record's owner). */
    sessionId: string;
    lane: TurnOneLane;
    carrier: TurnTwoCarrier;
    memoryEnabled: boolean;
    autoPromote: boolean;
    /** Replay-validated profiles; an edit on any other reported profile defers. */
    validatedProfiles: readonly ReportedProfile[];
    embedQuery?: TurnTwoQueryEmbedder;
    readExcerpt?: TurnTwoExcerptReader;
    recover?: TurnTwoRecoveryResolver;
    log?: (message: string) => void;
}

export interface TurnTwoRunResult {
    status: "skipped" | "nothing_to_send" | "resolved" | "in_flight" | "failed";
    reason?: string;
    stageKey?: string;
    /** True while any stage of this run's child is still in flight: keep it open. */
    childInFlight: boolean;
}

interface StageRequest {
    baseline?: string;
    factAttempts: Record<string, number>;
    items: number[];
    lexicalOnly: boolean;
    prompt: string;
}

interface FactRow {
    id: number;
    project_path: string;
    publication_id: string;
    category: string;
    content: string;
    anchor_known: number;
    fact_attempts: number;
}

const PLACEHOLDER_PROFILE: ReportedProfile = {
    provider: "",
    modelId: "",
    variant: null,
    temperature: null,
    systemHash: "",
};

function factBlocks(db: Database, factId: number): Array<EvidenceBlock & { sessionId: string }> {
    return (
        db
            .prepare(
                `SELECT b.source_session_id AS sessionId,b.start_ordinal AS startOrdinal,b.end_ordinal AS endOrdinal,b.role AS role,b.parts_json AS partsJson,b.joined_text AS joinedText
                 FROM memory_fact_block_links l JOIN memory_fact_blocks b ON b.id=l.block_id
                 WHERE l.fact_id=? ORDER BY b.start_ordinal`,
            )
            .all(factId) as Array<{
            sessionId: string;
            startOrdinal: number;
            endOrdinal: number;
            role: string;
            partsJson: string;
            joinedText: string;
        }>
    ).map((row) => ({
        sessionId: row.sessionId,
        startOrdinal: row.startOrdinal,
        endOrdinal: row.endOrdinal,
        role: row.role,
        parts: JSON.parse(row.partsJson) as string[],
        joinedText: row.joinedText,
    }));
}

function publicationSession(db: Database, publicationId: string): string {
    const row = db
        .prepare("SELECT source_session_id FROM memory_publications WHERE publication_id=?")
        .get(publicationId) as { source_session_id: string } | null;
    return row?.source_session_id ?? "";
}

/**
 * The facts a send carries: every `retryable` fact of this publication, then at most
 * `RETRY_BACKLOG_PER_RUN` `retryable` facts of earlier committed publications of the
 * project, oldest first by (publication commit order, fact id).
 */
export function selectTurnTwoFacts(
    db: Database,
    projectPath: string,
    publicationId: string,
): FactRow[] {
    const current = db
        .prepare(
            "SELECT id,project_path,publication_id,category,content,anchor_known,fact_attempts FROM memory_pending_facts WHERE project_path=? AND publication_id=? AND state='retryable' ORDER BY id",
        )
        .all(projectPath, publicationId) as FactRow[];
    const backlog = db
        .prepare(
            `SELECT f.id,f.project_path,f.publication_id,f.category,f.content,f.anchor_known,f.fact_attempts
             FROM memory_pending_facts f JOIN memory_publications p ON p.publication_id=f.publication_id
             WHERE f.project_path=? AND f.publication_id!=? AND f.state='retryable' AND p.commit_order IS NOT NULL
             ORDER BY p.commit_order, f.id LIMIT ?`,
        )
        .all(projectPath, publicationId, RETRY_BACKLOG_PER_RUN) as FactRow[];
    return [...current, ...backlog];
}

/** The decision key: one receipt per (fact, attempt, decision position, targets read). */
export function turnTwoDecisionKey(
    projectPath: string,
    factId: number,
    factAttempts: number,
    decision: TurnTwoDecision | null,
): string {
    const targets: Array<[number, number | null]> = [];
    if (decision?.sources)
        for (const source of decision.sources) targets.push([source.id, source.revision]);
    else if (decision?.targetId !== undefined)
        targets.push([decision.targetId, decision.revision ?? null]);
    targets.sort((a, b) => a[0] - b[0]);
    return JSON.stringify([projectPath, factId, factAttempts, decision?.ordinal ?? -1, targets]);
}

/** Consume one attempt of every fact still reserved by `stageKey`. */
function consumeStageAttempts(db: Database, stageKey: string, reason: string, state: string): void {
    db.transaction(() => {
        const facts = db
            .prepare(
                "SELECT id,project_path FROM memory_pending_facts WHERE state='in_flight' AND reserved_stage_key=?",
            )
            .all(stageKey) as Array<{ id: number; project_path: string }>;
        for (const fact of facts)
            resolveFactDecision(db, {
                key: JSON.stringify([stageKey, fact.id, reason]),
                projectPath: fact.project_path,
                factId: fact.id,
                operation: "turn_two",
                state: "retryable",
                reason,
            });
        db.prepare("UPDATE memory_stage_attempts SET state=? WHERE stage_key=?").run(
            state,
            stageKey,
        );
    }).immediate();
}

function readStageRequest(db: Database, stageKey: string): StageRequest | null {
    const row = db
        .prepare("SELECT request_json FROM memory_stage_attempts WHERE stage_key=?")
        .get(stageKey) as { request_json: string } | null;
    if (!row) return null;
    const parsed = JSON.parse(row.request_json) as Partial<StageRequest>;
    return parsed.factAttempts ? (parsed as StageRequest) : null;
}

interface Reserved {
    stageKey: string;
    runAttempt: number;
    factIds: number[];
    items: number[];
}

/**
 * Reserve the facts and persist the stage key, its start and the classification
 * watermark in one transaction, before anything is sent. A fact another run
 * reserved meanwhile is left out. Returns null when there is nothing to send.
 */
function reserveTurnTwo(
    db: Database,
    input: TurnTwoRunInput,
    facts: readonly FactRow[],
    promptFacts: ReadonlyMap<number, TurnTwoPromptFact>,
    lexicalOnly: boolean,
): Reserved | null {
    return db
        .transaction((): Reserved | null => {
            const prior = db
                .prepare(
                    "SELECT COALESCE(MAX(run_attempt),0) AS attempt FROM memory_stage_attempts WHERE project_path=? AND publication_id=? AND stage=?",
                )
                .get(input.projectPath, input.publicationId, TURN_TWO_STAGE) as { attempt: number };
            const runAttempt = prior.attempt + 1;
            const stageKey = JSON.stringify([
                input.projectPath,
                input.publicationId,
                runAttempt,
                TURN_TWO_STAGE,
            ]);
            const watermark = classificationWatermark(db, input.projectPath);
            const items = dueItemSequences(db, input.projectPath, watermark);
            const reserve = db.prepare(
                "UPDATE memory_pending_facts SET state='in_flight',reserved_stage_key=? WHERE id=? AND state='retryable'",
            );
            // The stage row must exist before facts point at it, and facts are
            // reserved before the prompt is fixed, so the row is written first and its
            // request completed below.
            db.prepare(
                `INSERT INTO memory_stage_attempts(stage_key,project_path,publication_id,run_attempt,stage,session_id,harness,child_session_id,carrier,state,classification_watermark,request_json,started_at)
                 VALUES(?,?,?,?,?,?,?,?,?,'reserved',?,'{}',?)`,
            ).run(
                stageKey,
                input.projectPath,
                input.publicationId,
                runAttempt,
                TURN_TWO_STAGE,
                input.sessionId,
                input.carrier.harness,
                input.carrier.childSessionId,
                input.carrier.carrier,
                watermark,
                Date.now(),
            );
            const reserved: FactRow[] = [];
            for (const fact of facts)
                if (reserve.run(stageKey, fact.id).changes === 1) reserved.push(fact);
            const itemViews = promptItems(db, items);
            if (reserved.length === 0 && itemViews.length === 0) {
                db.prepare("DELETE FROM memory_stage_attempts WHERE stage_key=?").run(stageKey);
                return null;
            }
            const request: StageRequest = {
                ...(input.carrier.baseline !== undefined
                    ? { baseline: input.carrier.baseline }
                    : {}),
                factAttempts: Object.fromEntries(
                    reserved.map((fact) => [String(fact.id), fact.fact_attempts]),
                ),
                items: itemViews.map((item) => item.item),
                lexicalOnly,
                prompt: buildTurnTwoPrompt({
                    facts: reserved.map((fact) => promptFacts.get(fact.id)!),
                    items: itemViews,
                    lexicalOnly,
                }),
            };
            db.prepare("UPDATE memory_stage_attempts SET request_json=? WHERE stage_key=?").run(
                JSON.stringify(request),
                stageKey,
            );
            return {
                stageKey,
                runAttempt,
                factIds: reserved.map((fact) => fact.id),
                items: request.items,
            };
        })
        .immediate();
}

function recordStageReply(db: Database, stageKey: string, reply: TurnTwoStageReply): void {
    db.prepare(
        "UPDATE memory_stage_attempts SET reply_json=?,reported_profile_json=?,usage_json=?,state='replied' WHERE stage_key=?",
    ).run(
        JSON.stringify({ text: reply.text, lengthCapped: reply.lengthCapped }),
        JSON.stringify(reply.profile),
        JSON.stringify(reply.usage ?? null),
        stageKey,
    );
}

interface ResolveContext {
    memoryEnabled: boolean;
    autoPromote: boolean;
    enforcedJson: boolean;
    validatedProfiles: readonly ReportedProfile[];
    checks: TurnTwoCheckCarrier;
    owner: { sessionId: string; harness: string };
}

function stillReserved(db: Database, stageKey: string): number {
    const row = db
        .prepare(
            "SELECT COUNT(*) AS n FROM memory_pending_facts WHERE state='in_flight' AND reserved_stage_key=?",
        )
        .get(stageKey) as { n: number };
    return row.n;
}

/**
 * Resolve every fact of a stage from its recorded reply. Each fact resolves in its
 * own transaction with a receipt keyed by its decision key, so a run that resumes
 * after a crash skips the facts already resolved and applies nothing twice.
 * Returns false when a check's outcome is unknown: the rest stays reserved.
 */
async function resolveStage(
    db: Database,
    stageKey: string,
    context: ResolveContext,
): Promise<boolean> {
    const row = db
        .prepare(
            "SELECT reply_json,reported_profile_json FROM memory_stage_attempts WHERE stage_key=?",
        )
        .get(stageKey) as {
        reply_json: string | null;
        reported_profile_json: string | null;
    } | null;
    const request = readStageRequest(db, stageKey);
    if (!row?.reply_json || !request) return true;
    const reply = JSON.parse(row.reply_json) as { text: string; lengthCapped: boolean };
    const profile =
        (row.reported_profile_json
            ? (JSON.parse(row.reported_profile_json) as ReportedProfile | null)
            : null) ?? PLACEHOLDER_PROFILE;
    const envelope = parseTurnTwoEnvelope(reply.text, reply.lengthCapped);
    if (!envelope.ok) {
        consumeStageAttempts(db, stageKey, `envelope_${envelope.reason}`, "envelope_failed");
        return true;
    }
    const facts = db
        .prepare(
            "SELECT id,project_path,publication_id,category,content,anchor_known,fact_attempts FROM memory_pending_facts WHERE state='in_flight' AND reserved_stage_key=? ORDER BY id",
        )
        .all(stageKey) as FactRow[];
    for (const fact of facts) {
        const attempts = request.factAttempts[String(fact.id)] ?? fact.fact_attempts;
        const decision = envelope.decisions.get(fact.id);
        try {
            await resolveFact(db, fact, attempts, decision, profile, context);
        } catch (error) {
            if (error instanceof CheckOutcomeUnknownError) return false;
            throw error;
        }
    }
    recordItemScores(db, request.items, envelope.scores);
    if (stillReserved(db, stageKey) === 0)
        db.prepare("UPDATE memory_stage_attempts SET state='resolved' WHERE stage_key=?").run(
            stageKey,
        );
    return true;
}

function pending(
    db: Database,
    fact: FactRow,
    key: string,
    reason: string,
    memoryId?: number,
    mapping?: unknown,
): ApplierReceipt {
    return resolveFactDecision(db, {
        key,
        projectPath: fact.project_path,
        factId: fact.id,
        operation: "turn_two",
        state: "decided_pending",
        reason,
        memoryId,
        mapping,
    });
}

function liveTarget(db: Database, projectPath: string, id: number | undefined) {
    if (id === undefined) return null;
    const memory = getMemoryById(db, id);
    if (!memory || memory.projectPath !== projectPath || memory.status === "archived") return null;
    const { revision } = db.prepare("SELECT revision FROM memories WHERE id=?").get(id) as {
        revision: number;
    };
    return { memory, revision };
}

async function resolveFact(
    db: Database,
    fact: FactRow,
    attempts: number,
    decision: TurnTwoDecision | "malformed" | undefined,
    profile: ReportedProfile,
    context: ResolveContext,
): Promise<ApplierReceipt> {
    if (decision === undefined || decision === "malformed")
        return pending(
            db,
            fact,
            turnTwoDecisionKey(fact.project_path, fact.id, attempts, null),
            decision === undefined ? "missing_decision" : "malformed_decision",
        );
    const key = turnTwoDecisionKey(fact.project_path, fact.id, attempts, decision);
    const sourceSessionId = publicationSession(db, fact.publication_id);
    const input = {
        projectPath: fact.project_path,
        category: fact.category as MemoryCategory,
        content: fact.content,
        sourceSessionId,
    };
    switch (decision.action) {
        case "abstain":
            return pending(db, fact, key, "abstain");
        case "retire":
        case "promote_rule":
            return pending(db, fact, key, "approval_gated");
        case "new":
            return applyMemoryAdmission(db, {
                key,
                operation: "new",
                input,
                memoryEnabled: context.memoryEnabled,
                autoPromote: context.autoPromote,
                factId: fact.id,
            });
        case "conflict": {
            if (!context.autoPromote) {
                const target = liveTarget(db, fact.project_path, decision.targetId);
                if (!target) return pending(db, fact, key, "conflict_target");
                // Nothing is admitted, but the disagreement with N stays recorded.
                return pending(db, fact, key, "auto_promote_disabled", target.memory.id, {
                    conflictWith: target.memory.id,
                });
            }
            return applyMemoryAdmission(db, {
                key,
                operation: "conflict",
                input,
                memoryEnabled: context.memoryEnabled,
                autoPromote: context.autoPromote,
                conflictTargetId: decision.targetId,
                factId: fact.id,
            });
        }
        case "covered":
            return resolveCovered(db, fact, key, decision);
        case "edit":
        case "replaces":
        case "merge":
            return resolveRevision(db, fact, key, decision, profile, context);
    }
}

/**
 * `covered by #N`: the fact is retained with its clause mapping and written nowhere
 * else. A recitation (evidence with no user or tool part, or an excerpt that is a
 * current clause of N) and unknown lineage are not coverage.
 */
function resolveCovered(
    db: Database,
    fact: FactRow,
    key: string,
    decision: TurnTwoDecision,
): ApplierReceipt {
    const target = liveTarget(db, fact.project_path, decision.targetId);
    if (!target) return pending(db, fact, key, "covered_target");
    if (target.revision !== decision.revision)
        return resolveFactDecision(db, {
            key,
            projectPath: fact.project_path,
            factId: fact.id,
            operation: "turn_two",
            state: "retryable",
            reason: "cas_loss",
        });
    const clauses = splitMemoryClauses(target.memory.content);
    const ordinals = decision.clauses ?? [];
    if (
        new Set(ordinals).size !== ordinals.length ||
        ordinals.some((ordinal) => ordinal < 1 || ordinal > clauses.length)
    )
        return pending(db, fact, key, "covered_mapping");
    const blocks = factBlocks(db, fact.id);
    if (!fact.anchor_known || blocks.length === 0) return pending(db, fact, key, "unknown_lineage");
    if (!blocks.some((block) => block.role === "user" || block.role === "tool"))
        return pending(db, fact, key, "recitation");
    if (decision.excerpt !== undefined) {
        const excerpt = normalizeLifecycleText(decision.excerpt);
        if (clauses.some((clause) => normalizeLifecycleText(clause.text) === excerpt))
            return pending(db, fact, key, "recitation");
    }
    return resolveFactDecision(db, {
        key,
        projectPath: fact.project_path,
        factId: fact.id,
        operation: "covered",
        state: "covered",
        reason: "covered",
        memoryId: target.memory.id,
        mapping: { memoryId: target.memory.id, revision: target.revision, clauses: ordinals },
    });
}

async function resolveRevision(
    db: Database,
    fact: FactRow,
    key: string,
    decision: TurnTwoDecision,
    profile: ReportedProfile,
    context: ResolveContext,
): Promise<ApplierReceipt> {
    const expectedSources =
        decision.action === "merge"
            ? (decision.sources ?? [])
            : [{ id: decision.targetId ?? -1, revision: decision.revision ?? -1 }];
    const changes: ChangedClause[] = [
        ...(decision.removed ?? []).map((clause) => ({ clause, replacement: false })),
        ...(decision.replaced ?? []).map((clause) => ({ clause, replacement: true })),
    ].map(({ clause, replacement }) => ({
        memoryId: clause.memoryId,
        ordinal: clause.clause,
        replacement,
        evidence: { blockStartOrdinal: clause.block, excerpt: clause.excerpt },
    }));
    const added: AddedClause[] = (decision.added ?? []).map((clause) => ({
        text: clause.text,
        evidence: { blockStartOrdinal: clause.block, excerpt: clause.excerpt },
    }));
    // The decision names its kept clauses; they must be exactly the clauses it does
    // not change, read at the revisions it cites. A stale source is left to the
    // applier, which reports it as a CAS loss.
    const current = expectedSources.map((source) => liveTarget(db, fact.project_path, source.id));
    if (
        current.every(
            (target, index) =>
                target !== null && target.revision === expectedSources[index]!.revision,
        )
    ) {
        const expectedKept = current.flatMap((target) =>
            splitMemoryClauses(target!.memory.content)
                .filter(
                    (clause) =>
                        !changes.some(
                            (change) =>
                                change.memoryId === target!.memory.id &&
                                change.ordinal === clause.ordinal,
                        ),
                )
                .map((clause) => `${target!.memory.id}:${clause.ordinal}`),
        );
        const named = (decision.kept ?? []).map((clause) => `${clause.memoryId}:${clause.clause}`);
        if (
            named.length !== expectedKept.length ||
            new Set(named).size !== named.length ||
            named.some((entry) => !expectedKept.includes(entry))
        )
            return pending(db, fact, key, "kept_mismatch");
    }
    const revision: RevisionDecision = {
        key,
        action: decision.action as RevisionDecision["action"],
        projectPath: fact.project_path,
        expectedSources,
        survivorId:
            decision.action === "merge" ? (decision.survivorId ?? -1) : (decision.targetId ?? -1),
        finalText: decision.finalText ?? "",
        changes,
        added,
    };
    const gate: GateContext = {
        enabled: true,
        enforcedJson: context.enforcedJson,
        memoryEnabled: context.memoryEnabled,
        autoPromote: context.autoPromote,
        anchorKnown: fact.anchor_known === 1,
        blocks: factBlocks(db, fact.id).map(({ sessionId: _session, ...block }) => block),
        sources: [],
        historianProfile: profile,
        validatedProfiles: [...context.validatedProfiles],
    };
    return applyHistorianRevision(
        db,
        revision,
        gate,
        context.owner,
        (request, { reattach }) => {
            if (!reattach) return context.checks.check(request);
            if (!context.checks.reattachCheck) throw new CheckOutcomeUnknownError();
            return context.checks.reattachCheck(request);
        },
        fact.id,
    );
}

function stageRecords(db: Database, projectPath: string): TurnTwoStageRecord[] {
    return (
        db
            .prepare(
                `SELECT s.stage_key AS stageKey,s.project_path AS projectPath,s.publication_id AS publicationId,s.run_attempt AS runAttempt,
                        s.session_id AS sessionId,s.harness AS harness,s.carrier AS carrier,s.child_session_id AS childSessionId,
                        s.started_at AS startedAt,s.request_json AS requestJson
                 FROM memory_stage_attempts s
                 WHERE s.project_path=? AND s.stage=?
                   AND EXISTS (SELECT 1 FROM memory_pending_facts f WHERE f.state='in_flight' AND f.reserved_stage_key=s.stage_key)
                 ORDER BY s.started_at, s.stage_key`,
            )
            .all(projectPath, TURN_TWO_STAGE) as Array<
            Omit<TurnTwoStageRecord, "baseline"> & { requestJson: string }
        >
    ).map(({ requestJson, ...record }) => {
        const request = JSON.parse(requestJson) as Partial<StageRequest>;
        return { ...record, baseline: request.baseline ?? null };
    });
}

/**
 * Reattach every turn-two stage of the project that still holds reservations: a
 * recorded reply is resolved without a second send; otherwise the stage's carrier
 * is asked for the outcome under the original stage key. A stage this process
 * cannot reach stays reserved.
 */
export async function recoverTurnTwoStages(
    db: Database,
    input: {
        projectPath: string;
        memoryEnabled: boolean;
        autoPromote: boolean;
        validatedProfiles: readonly ReportedProfile[];
        resolver: TurnTwoRecoveryResolver | undefined;
        log?: (message: string) => void;
    },
): Promise<void> {
    for (const record of stageRecords(db, input.projectPath)) {
        const carrier = input.resolver?.(record) ?? null;
        const replied = db
            .prepare(
                "SELECT reply_json IS NOT NULL AS replied FROM memory_stage_attempts WHERE stage_key=?",
            )
            .get(record.stageKey) as { replied: number };
        if (!replied.replied) {
            if (!carrier) continue;
            let outcome: TurnTwoReattach;
            try {
                outcome = await carrier.reattach();
            } catch {
                continue;
            }
            if (outcome.kind === "unknown") continue;
            if (outcome.kind === "gone") {
                consumeStageAttempts(db, record.stageKey, "carrier_lost", "lost");
                await carrier.close?.();
                continue;
            }
            recordStageReply(db, record.stageKey, outcome.reply);
        }
        const done = await resolveStage(db, record.stageKey, {
            memoryEnabled: input.memoryEnabled,
            autoPromote: input.autoPromote,
            // A reply was only ever recorded on an enabled lane.
            enforcedJson: true,
            validatedProfiles: input.validatedProfiles,
            checks: carrier ?? {
                check: () => Promise.reject(new CheckOutcomeUnknownError("no carrier")),
            },
            owner: { sessionId: record.sessionId, harness: record.harness },
        });
        input.log?.(
            `turn two: recovered stage ${record.stageKey} (${done ? "resolved" : "still in flight"})`,
        );
        if (done && stillReserved(db, record.stageKey) === 0) await carrier?.close?.();
    }
}

/**
 * Run turn two for one publication on the retained turn-one child. The caller keeps
 * the child open until this returns and closes it only when `childInFlight` is false.
 */
export async function runTurnTwo(db: Database, input: TurnTwoRunInput): Promise<TurnTwoRunResult> {
    const skip = (reason: string): TurnTwoRunResult => ({
        status: "skipped",
        reason,
        childInFlight: false,
    });
    if (input.lane !== "enabled" || !input.carrier.enforcedJson) return skip("lane_dormant");
    if (!input.memoryEnabled) return skip("memory_disabled");
    if (!tsOwnsMemory(db, input.projectPath)) {
        // The module owns this project's memory: no provider call, and the
        // candidates wait as backlog for a turn two run under that authority.
        db.prepare(
            "UPDATE memory_pending_facts SET reason='authority_elsewhere' WHERE project_path=? AND publication_id=? AND state='retryable'",
        ).run(input.projectPath, input.publicationId);
        return skip("authority_elsewhere");
    }
    if (!input.carrier.childSessionId) return skip("carrier_cannot_continue");

    await recoverTurnTwoStages(db, {
        projectPath: input.projectPath,
        memoryEnabled: input.memoryEnabled,
        autoPromote: input.autoPromote,
        validatedProfiles: input.validatedProfiles,
        resolver: input.recover,
        log: input.log,
    });

    storeDueExcerpts(db, input.projectPath, input.readExcerpt);
    const facts = selectTurnTwoFacts(db, input.projectPath, input.publicationId);
    const promptFacts = new Map<number, TurnTwoPromptFact>();
    let lexicalOnly = false;
    for (const fact of facts) {
        const blocks = factBlocks(db, fact.id);
        const retrieved = await retrieveTurnTwoNeighbours(
            db,
            input.projectPath,
            fact.content,
            input.embedQuery,
        );
        lexicalOnly ||= retrieved.lexicalOnly;
        promptFacts.set(fact.id, {
            factId: fact.id,
            category: fact.category,
            content: fact.content,
            sourceSessionId: blocks[0]?.sessionId ?? publicationSession(db, fact.publication_id),
            anchorKnown: fact.anchor_known === 1,
            backlog: fact.publication_id !== input.publicationId,
            blocks,
            neighbours: retrieved.neighbours,
        });
    }
    const reserved = reserveTurnTwo(db, input, facts, promptFacts, lexicalOnly);
    if (!reserved) return { status: "nothing_to_send", childInFlight: false };
    const request = readStageRequest(db, reserved.stageKey)!;
    let reply: TurnTwoStageReply;
    try {
        db.prepare("UPDATE memory_stage_attempts SET state='sending' WHERE stage_key=?").run(
            reserved.stageKey,
        );
        reply = await input.carrier.send(request.prompt, reserved.stageKey);
    } catch (error) {
        if (error instanceof TurnTwoOutcomeUnknownError)
            return { status: "in_flight", stageKey: reserved.stageKey, childInFlight: true };
        // A known transport failure (including a prompt the provider refused as
        // too long): every fact of the send is retried later.
        consumeStageAttempts(db, reserved.stageKey, "stage2_transport", "transport_failed");
        input.log?.(`turn two: send failed (${String(error)})`);
        return {
            status: "failed",
            reason: "stage2_transport",
            stageKey: reserved.stageKey,
            childInFlight: false,
        };
    }
    recordStageReply(db, reserved.stageKey, reply);
    const done = await resolveStage(db, reserved.stageKey, {
        memoryEnabled: input.memoryEnabled,
        autoPromote: input.autoPromote,
        enforcedJson: input.carrier.enforcedJson,
        validatedProfiles: input.validatedProfiles,
        checks: input.carrier,
        owner: { sessionId: input.sessionId, harness: input.carrier.harness },
    });
    const inFlight = !done || stillReserved(db, reserved.stageKey) > 0;
    return {
        status: inFlight ? "in_flight" : "resolved",
        stageKey: reserved.stageKey,
        childInFlight: inFlight,
    };
}
