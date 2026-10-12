import type { Database } from "../../../shared/sqlite";
import {
    type CheckOutcome,
    CheckOutcomeUnknownError,
    type CheckReply,
    type CheckRequest,
    type GateContext,
    makeCheckRequest,
    planMemoryRevision,
    type RevisionDecision,
    runMemoryChecks,
} from "./lifecycle-gates";
import { lifecycleTextHash } from "./lifecycle-text";

/**
 * Run a revision's narrow checks through the attempt ledger. Every check is one
 * `memory_check_attempts` row keyed by its request key, written before the request
 * leaves. A check whose row already has a reply is answered from that reply; a
 * check whose row exists without a reply was dispatched by an earlier, interrupted
 * run, so `reattachOrSend` is told to reattach it by key rather than send it again.
 */
export async function checkMemoryRevision(
    db: Database,
    owner: { sessionId: string; harness: string },
    decision: RevisionDecision,
    context: GateContext,
    reattachOrSend: (request: CheckRequest, options: { reattach: boolean }) => Promise<CheckReply>,
): Promise<CheckOutcome> {
    const plan = planMemoryRevision(decision, context);
    if (!plan.ok) return { ok: false, reason: plan.reason, retryable: false };
    return runMemoryChecks(decision.key, plan, context, async (request) => {
        const row = db
            .prepare("SELECT reply_json FROM memory_check_attempts WHERE check_key=?")
            .get(request.key) as { reply_json: string | null } | null;
        if (row?.reply_json) return JSON.parse(row.reply_json) as CheckReply;
        const reattach = row !== null;
        const planned = plan.checks.find(
            (check) =>
                makeCheckRequest(decision.key, check, context.historianProfile).key === request.key,
        )!;
        const operandIds =
            request.kind === "compatibility"
                ? request.pairs.map((pair) => pair.id)
                : request.operands.map((operand) => operand.id);
        db.prepare(
            `INSERT OR IGNORE INTO memory_check_attempts(check_key,decision_key,session_id,harness,kind,operand_ids_json,input_hash,request_profile_hash,request_json,state,started_at) VALUES(?,?,?,?,?,?,?,?,?,'in_flight',?)`,
        ).run(
            request.key,
            decision.key,
            owner.sessionId,
            owner.harness,
            request.kind,
            JSON.stringify(operandIds),
            lifecycleTextHash(planned.input),
            lifecycleTextHash(
                JSON.stringify({ ...context.historianProfile, systemHash: request.systemHash }),
            ),
            JSON.stringify(request),
            Date.now(),
        );
        try {
            const reply = await reattachOrSend(request, { reattach });
            db.prepare(
                "UPDATE memory_check_attempts SET reply_json=?,reported_profile_json=?,usage_json=?,state='resolved' WHERE check_key=?",
            ).run(
                JSON.stringify(reply),
                JSON.stringify(reply.profile),
                JSON.stringify(reply.usage ?? null),
                request.key,
            );
            return reply;
        } catch (error) {
            // An unknown outcome leaves the check dispatched so a later run reattaches it.
            if (error instanceof CheckOutcomeUnknownError) throw error;
            db.prepare(
                "UPDATE memory_check_attempts SET state='transport_failed' WHERE check_key=?",
            ).run(request.key);
            throw error;
        }
    });
}
