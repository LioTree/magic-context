import { createHash } from "node:crypto";
import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import { DegradedPassRefusalError } from "./degraded-pass-refusal";
import { isAdmissionUser } from "./edit-admission";

export interface PrefixProvenance {
    host: "opencode-v1" | "opencode-v2" | "pi";
    id_space: string;
    generation: string;
    projection: "messages";
}

export interface ServedPrefix<M> {
    version: 1;
    head: M[];
    summary: M | null;
    first_kept: { id: string; digest: string } | null;
    cut_mode: { mode: "none" | "inclusive" | "partial"; id: string | null };
    turn: string | null;
    provenance: PrefixProvenance & { pass: number };
    pending_user?: {
        id: string;
        digest: string;
        branch_cursor: string | null;
        branch_path: string[];
    };
}

// The returned message bytes include tool-input key order; sorting fields
// would hide a prefix change from the replay fence.
export function prefixMessageDigest(message: unknown): string {
    const serialized = JSON.stringify(message);
    if (serialized === undefined) throw new Error("Cannot digest an absent served message");
    return createHash("sha256").update(serialized).digest("hex");
}

export function prefixTurn<M>(
    messages: readonly M[],
    stableId: (message: M, index: number) => string | undefined,
): string | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (isAdmissionUser(messages[index])) return stableId(messages[index], index) ?? null;
    }
    return null;
}

export function readServedPrefix<M>(db: Database, sessionId: string): ServedPrefix<M> | null {
    const row = db
        .prepare("SELECT served_prefix FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { served_prefix: string | null } | null;
    if (!row?.served_prefix) return null;
    try {
        const value = JSON.parse(row.served_prefix);
        if (
            !isRecord(value) ||
            value.version !== 1 ||
            !Array.isArray(value.head) ||
            !(value.summary === null || isRecord(value.summary)) ||
            !(value.turn === null || typeof value.turn === "string") ||
            !(
                value.pending_user === undefined ||
                (isRecord(value.pending_user) &&
                    typeof value.pending_user.id === "string" &&
                    typeof value.pending_user.digest === "string" &&
                    /^(?:[0-9a-f]{64})$/.test(value.pending_user.digest) &&
                    (value.pending_user.branch_cursor === null ||
                        typeof value.pending_user.branch_cursor === "string") &&
                    Array.isArray(value.pending_user.branch_path) &&
                    value.pending_user.branch_path.every((id: unknown) => typeof id === "string"))
            ) ||
            !isRecord(value.provenance) ||
            !isRecord(value.cut_mode) ||
            !["none", "inclusive", "partial"].includes(String(value.cut_mode.mode)) ||
            !(value.cut_mode.id === null || typeof value.cut_mode.id === "string") ||
            !(
                value.first_kept === null ||
                (isRecord(value.first_kept) &&
                    typeof value.first_kept.id === "string" &&
                    typeof value.first_kept.digest === "string")
            )
        )
            return null;
        return value as unknown as ServedPrefix<M>;
    } catch {
        return null;
    }
}

export function prefixRecordProblem<M>(
    record: ServedPrefix<M> | null,
    provenance: PrefixProvenance,
    turn: string | null,
    boundary: boolean,
): string | null {
    if (!record) return "record missing or invalid";
    if (record.head.length === 0) return "recorded head is empty";
    if (
        record.provenance.host !== provenance.host ||
        record.provenance.id_space !== provenance.id_space ||
        record.provenance.projection !== provenance.projection
    )
        return "host or id space mismatch";
    const messageShape = (message: unknown) =>
        isRecord(message) &&
        (provenance.host === "pi"
            ? typeof message.role === "string" &&
              (typeof message.content === "string" || Array.isArray(message.content))
            : isRecord(message.info) && Array.isArray(message.parts));
    if (
        !record.head.every(messageShape) ||
        (record.summary !== null && !messageShape(record.summary))
    )
        return "invalid serialized prefix messages";
    if (boundary && (!turn || record.turn !== turn))
        return `turn mismatch (record=${record.turn ?? "<none>"}, current=${turn ?? "<none>"})`;
    if (boundary && !record.first_kept) return "first kept message is absent from record";
    return null;
}

export function refuseServedPrefix(reason: string, sessionId: string): never {
    const detail = `served prefix cannot be reproduced while signed thinking is kept: ${reason}`;
    sessionLog(sessionId, `edit admission: held lane=served_prefix reason=${reason} held_edits=1`);
    const error = new DegradedPassRefusalError("served-prefix", { cause: new Error(detail) });
    error.message = `${error.message} ${detail}`;
    throw error;
}

/**
 * Resume raw host history at the first message retained in the last served request.
 * Retained reasoning signatures bind the preceding messages, so a newer background
 * summary must not move that resume point while those signatures are still sent.
 */
export function replayServedPrefix<M>(args: {
    messages: M[];
    record: ServedPrefix<M>;
    stableId: (message: M, index: number) => string | undefined;
    isHead: (message: M) => boolean;
    isSummary?: (message: M) => boolean;
    keepIdless?: (message: M) => boolean;
}): string | null {
    const { messages, record } = args;
    let headEnd = 0;
    while (headEnd < messages.length && args.isHead(messages[headEnd])) headEnd++;
    const raw = messages.filter((message, index) => index >= headEnd && !args.isSummary?.(message));
    let kept = raw;
    if (record.first_kept) {
        const positions = raw.flatMap((message, index) =>
            args.stableId(message, index) === record.first_kept?.id ? [index] : [],
        );
        if (positions.length !== 1) return "first kept id missing or ambiguous";
        const first = positions[0];
        kept = raw.filter((message, index) => index >= first || args.keepIdless?.(message));
    } else {
        if (raw.length) return "first kept message is absent from record";
        kept = [];
    }
    const head = structuredClone(record.head);
    const summary = record.summary ? structuredClone(record.summary) : null;
    // Keep large retained histories off the JavaScript call-argument stack.
    messages.length = 0;
    for (const message of head) messages.push(message);
    if (summary) messages.push(summary);
    for (const message of kept) messages.push(message);
    return null;
}

export function validateServedPrefix<M>(
    record: ServedPrefix<M>,
    messages: readonly M[],
    stableId: (message: M, index: number) => string | undefined,
): string | null {
    if (!record.first_kept) return null;
    const found = messages.filter(
        (message, index) => stableId(message, index) === record.first_kept?.id,
    );
    if (found.length !== 1) return "first kept id missing or ambiguous";
    return prefixMessageDigest(found[0]) === record.first_kept.digest
        ? null
        : "first kept digest mismatch";
}

/** Called after all wire edits, not from a cache writer that has not yet trimmed history. */
export function writeServedPrefix<M>(args: {
    db: Database;
    sessionId: string;
    head: M[];
    summary: M | null;
    firstKept: M | undefined;
    firstKeptId: string | undefined;
    turn: string | null;
    provenance: PrefixProvenance;
    cut?: ServedPrefix<M>["cut_mode"];
    pendingUser?: ServedPrefix<M>["pending_user"];
}): ServedPrefix<M> {
    const record: ServedPrefix<M> = {
        version: 1,
        head: args.head,
        summary: args.summary,
        first_kept:
            args.firstKept && args.firstKeptId
                ? { id: args.firstKeptId, digest: prefixMessageDigest(args.firstKept) }
                : null,
        cut_mode: args.cut ?? { mode: "none", id: null },
        turn: args.turn,
        provenance: { ...args.provenance, pass: Date.now() },
        ...(args.pendingUser ? { pending_user: args.pendingUser } : {}),
    };
    const previous = readServedPrefix<M>(args.db, args.sessionId);
    if (
        previous &&
        JSON.stringify({ ...previous, provenance: { ...previous.provenance, pass: 0 } }) ===
            JSON.stringify({ ...record, provenance: { ...record.provenance, pass: 0 } })
    )
        return previous;
    const result = args.db
        .prepare("UPDATE session_meta SET served_prefix = ? WHERE session_id = ?")
        .run(JSON.stringify(record), args.sessionId);
    if (result.changes !== 1) throw new Error("served prefix write found no session");
    return record;
}
