/**
 * The historian's second turn ("turn two"): the prompt that asks it to reconcile
 * candidate facts with existing project memory, and the strict parser for its
 * JSON reply.
 *
 * Turn two runs only on a lane whose carrier makes the provider enforce a response
 * schema, so a reply is either schema-valid JSON or an error. The parser therefore
 * never repairs or extracts JSON from prose: anything that is not exactly one JSON
 * object of the expected shape is an envelope failure, and every fact of that send
 * is retried (see `turn-two.ts`).
 */
import { splitMemoryClauses } from "./lifecycle-text";

/** Actions a turn-two decision may name. */
export const TURN_TWO_ACTIONS = [
    "new",
    "covered",
    "conflict",
    "edit",
    "merge",
    "replaces",
    "abstain",
    // Operations that need a human approval: they become proposals in the review
    // inbox (`memory_tool_proposals`) and are never applied automatically.
    "retire",
    "promote_rule",
] as const;
export type TurnTwoAction = (typeof TURN_TWO_ACTIONS)[number];

export interface TurnTwoCitedClause {
    memoryId: number;
    clause: number;
    block: number;
    excerpt: string;
}
export interface TurnTwoAddedClause {
    text: string;
    block: number;
    excerpt: string;
}

/** One decision as the historian wrote it, after per-decision schema validation. */
export interface TurnTwoDecision {
    factId: number;
    /** Position of the decision in the reply's `decisions` array. */
    ordinal: number;
    action: TurnTwoAction;
    /** `covered`, `conflict`, `edit`, `replaces`, `retire`, `promote_rule`: the existing memory addressed. */
    targetId?: number;
    /** `covered`, `edit`, `replaces`: the revision of `targetId` the decision read. */
    revision?: number;
    /** `merge`: every source with the revision the decision read. */
    sources?: Array<{ id: number; revision: number }>;
    /** `merge`: the source that survives. */
    survivorId?: number;
    /** `covered`: the clause ordinals of `targetId` that cover the fact. */
    clauses?: number[];
    /** `covered`: an optional quote of the fact's evidence. */
    excerpt?: string;
    removed?: TurnTwoCitedClause[];
    replaced?: TurnTwoCitedClause[];
    kept?: Array<{ memoryId: number; clause: number }>;
    added?: TurnTwoAddedClause[];
    finalText?: string;
}

export interface TurnTwoScore {
    item: number;
    importance: number;
    proposedClass: string;
}

export type TurnTwoEnvelope =
    | {
          ok: true;
          /** Decisions keyed by fact id; a fact named twice maps to `"malformed"`. */
          decisions: Map<number, TurnTwoDecision | "malformed">;
          scores: TurnTwoScore[];
      }
    | { ok: false; reason: "length_capped" | "unparseable" | "schema_invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isInt(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
}

function citedClauses(value: unknown): TurnTwoCitedClause[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;
    const out: TurnTwoCitedClause[] = [];
    for (const entry of value) {
        if (
            !isRecord(entry) ||
            !isInt(entry.memory_id) ||
            !isInt(entry.clause) ||
            !isInt(entry.block) ||
            typeof entry.excerpt !== "string"
        )
            return null;
        out.push({
            memoryId: entry.memory_id,
            clause: entry.clause,
            block: entry.block,
            excerpt: entry.excerpt,
        });
    }
    return out;
}

function addedClauses(value: unknown): TurnTwoAddedClause[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;
    const out: TurnTwoAddedClause[] = [];
    for (const entry of value) {
        if (
            !isRecord(entry) ||
            typeof entry.text !== "string" ||
            !isInt(entry.block) ||
            typeof entry.excerpt !== "string"
        )
            return null;
        out.push({ text: entry.text, block: entry.block, excerpt: entry.excerpt });
    }
    return out;
}

/** Validate one decision object; null when it is malformed. */
function parseDecision(
    raw: Record<string, unknown>,
    factId: number,
    ordinal: number,
): TurnTwoDecision | null {
    const action = raw.action;
    if (typeof action !== "string" || !TURN_TWO_ACTIONS.includes(action as TurnTwoAction))
        return null;
    const decision: TurnTwoDecision = { factId, ordinal, action: action as TurnTwoAction };
    switch (decision.action) {
        case "new":
        case "abstain":
            return decision;
        case "retire":
        case "promote_rule":
        case "conflict":
            if (!isInt(raw.target_id)) return null;
            decision.targetId = raw.target_id;
            return decision;
        case "covered": {
            if (!isInt(raw.target_id) || !isInt(raw.revision) || !Array.isArray(raw.clauses))
                return null;
            if (raw.clauses.length === 0 || !raw.clauses.every(isInt)) return null;
            if (raw.excerpt !== undefined && typeof raw.excerpt !== "string") return null;
            decision.targetId = raw.target_id;
            decision.revision = raw.revision;
            decision.clauses = raw.clauses as number[];
            if (typeof raw.excerpt === "string") decision.excerpt = raw.excerpt;
            return decision;
        }
        case "edit":
        case "replaces":
        case "merge": {
            const removed = citedClauses(raw.removed);
            const replaced = citedClauses(raw.replaced);
            const added = addedClauses(raw.added);
            if (!removed || !replaced || !added) return null;
            if (!Array.isArray(raw.kept) || typeof raw.final_text !== "string") return null;
            const kept: Array<{ memoryId: number; clause: number }> = [];
            for (const entry of raw.kept) {
                if (!isRecord(entry) || !isInt(entry.memory_id) || !isInt(entry.clause))
                    return null;
                kept.push({ memoryId: entry.memory_id, clause: entry.clause });
            }
            decision.removed = removed;
            decision.replaced = replaced;
            decision.added = added;
            decision.kept = kept;
            decision.finalText = raw.final_text;
            if (decision.action === "merge") {
                if (
                    !Array.isArray(raw.sources) ||
                    raw.sources.length < 2 ||
                    !isInt(raw.survivor_id)
                )
                    return null;
                const sources: Array<{ id: number; revision: number }> = [];
                for (const source of raw.sources) {
                    if (!isRecord(source) || !isInt(source.id) || !isInt(source.revision))
                        return null;
                    sources.push({ id: source.id, revision: source.revision });
                }
                decision.sources = sources;
                decision.survivorId = raw.survivor_id;
                return decision;
            }
            if (!isInt(raw.target_id) || !isInt(raw.revision)) return null;
            decision.targetId = raw.target_id;
            decision.revision = raw.revision;
            return decision;
        }
    }
}

/**
 * Parse a turn-two reply. Envelope-level failures (length-capped output, text that
 * is not one JSON object, an object without a `decisions` array) apply to the whole
 * send. A decision that fails its own schema, or a fact named by two decisions,
 * marks only that fact malformed.
 */
export function parseTurnTwoEnvelope(text: string, lengthCapped: boolean): TurnTwoEnvelope {
    if (lengthCapped) return { ok: false, reason: "length_capped" };
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, reason: "unparseable" };
    }
    if (!isRecord(raw) || !Array.isArray(raw.decisions))
        return { ok: false, reason: "schema_invalid" };
    if (raw.scores !== undefined && !Array.isArray(raw.scores))
        return { ok: false, reason: "schema_invalid" };
    const decisions = new Map<number, TurnTwoDecision | "malformed">();
    raw.decisions.forEach((entry, ordinal) => {
        // A decision that names no fact cannot be attributed; the fact it was
        // meant for is then missing, which is the same malformed outcome.
        if (!isRecord(entry) || !isInt(entry.fact_id)) return;
        const factId = entry.fact_id;
        if (decisions.has(factId)) {
            decisions.set(factId, "malformed");
            return;
        }
        decisions.set(factId, parseDecision(entry, factId, ordinal) ?? "malformed");
    });
    const scores: TurnTwoScore[] = [];
    for (const entry of (raw.scores as unknown[] | undefined) ?? []) {
        if (
            isRecord(entry) &&
            isInt(entry.item) &&
            isInt(entry.importance) &&
            entry.importance >= 1 &&
            entry.importance <= 100 &&
            typeof entry.class === "string" &&
            entry.class.length > 0 &&
            entry.class.length <= 64
        )
            scores.push({
                item: entry.item,
                importance: entry.importance,
                proposedClass: entry.class,
            });
    }
    return { ok: true, decisions, scores };
}

export interface TurnTwoPromptBlock {
    startOrdinal: number;
    endOrdinal: number;
    role: string;
    parts: string[];
}
export interface TurnTwoPromptFact {
    factId: number;
    category: string;
    content: string;
    sourceSessionId: string;
    anchorKnown: boolean;
    /**
     * True for a fact of an earlier historian publication (an earlier committed turn
     * one) that is still `retryable`, sent again as backlog.
     */
    backlog: boolean;
    blocks: TurnTwoPromptBlock[];
    neighbours: TurnTwoPromptNeighbour[];
}
export interface TurnTwoPromptNeighbour {
    id: number;
    revision: number;
    category: string;
    content: string;
}
export interface TurnTwoPromptItem {
    item: number;
    memoryId: number;
    content: string;
    excerpt: string;
}

/**
 * Rendered when the prompt size bound left facts or items out: this request does
 * not cover every pending candidate, and the rest are sent in a later request.
 */
export function coverageNotice(facts: number, items: number): string {
    return `Coverage: this request is partial. ${facts} pending fact(s) and ${items} agent memory item(s) were left out to fit the request size and will be sent in a later request; judge only what is listed here.`;
}

/** Rendered when the semantic lane could not rank neighbours for this send. */
export const LEXICAL_ONLY_NOTICE =
    "Neighbour retrieval was lexical-only for this request (no usable stored embeddings); a fact with no neighbour listed may still duplicate an existing memory.";

function renderNeighbour(neighbour: TurnTwoPromptNeighbour): string {
    const clauses = splitMemoryClauses(neighbour.content)
        .map((clause) => `  c${clause.ordinal}: ${clause.text}`)
        .join("\n");
    return `- #${neighbour.id} rev ${neighbour.revision} [${neighbour.category}]\n${clauses}`;
}

/**
 * The turn-two prompt. Each fact is rendered under its own heading with its own
 * stored blocks and its source session, because ordinals of different sessions
 * collide: a cited block ordinal is resolved only within that fact's blocks.
 * Memories are never truncated.
 */
export function buildTurnTwoPrompt(input: {
    facts: readonly TurnTwoPromptFact[];
    items: readonly TurnTwoPromptItem[];
    lexicalOnly: boolean;
    /** Facts and items left out of this request by the prompt size bound. */
    deferred?: { facts: number; items: number };
}): string {
    const lines: string[] = [
        "Turn two: reconcile each candidate fact with existing project memory.",
        'Reply with exactly one JSON object: {"decisions":[...],"scores":[...]}.',
        "One decision per fact_id. Actions: new, covered, conflict, edit, merge, replaces, abstain, retire, promote_rule.",
        "covered needs target_id, revision and clauses; conflict, retire and promote_rule need target_id; edit and replaces need target_id, revision, removed, replaced, kept, added and final_text; merge needs sources, survivor_id, removed, replaced, kept, added and final_text.",
        "Every removed, replaced and added clause cites a block start ordinal of that fact's own blocks and an exact excerpt.",
    ];
    if (input.lexicalOnly) lines.push(LEXICAL_ONLY_NOTICE);
    if (input.deferred && (input.deferred.facts > 0 || input.deferred.items > 0))
        lines.push(coverageNotice(input.deferred.facts, input.deferred.items));
    for (const fact of input.facts) {
        lines.push(
            "",
            `## Fact ${fact.factId}${fact.backlog ? " (backlog)" : ""} [${fact.category}] from session ${fact.sourceSessionId}`,
            fact.content,
        );
        if (!fact.anchorKnown)
            lines.push("Source blocks: unknown (this fact cannot evidence an edit).");
        for (const block of fact.blocks)
            lines.push(
                `[${block.startOrdinal === block.endOrdinal ? block.startOrdinal : `${block.startOrdinal}-${block.endOrdinal}`}] ${block.role}: ${block.parts.join(" / ")}`,
            );
        lines.push("Neighbours:");
        if (fact.neighbours.length === 0) lines.push("- none retrieved");
        for (const neighbour of fact.neighbours) lines.push(renderNeighbour(neighbour));
    }
    if (input.items.length > 0) {
        lines.push("", "## Agent memories to score (importance 1-100 and a proposed decay class)");
        for (const item of input.items)
            lines.push(
                "",
                `### Item ${item.item} (memory #${item.memoryId})`,
                item.content,
                "Excerpt:",
                item.excerpt,
            );
    }
    return lines.join("\n");
}
