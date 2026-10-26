/**
 * The historian's second turn ("turn two"): the prompt that asks it to reconcile
 * candidate facts with existing project memory, and the strict parser for its
 * JSON reply.
 *
 * The schema is a prompt contract, not provider enforcement. The parser
 * never repairs or extracts JSON from prose: anything that is not exactly one JSON
 * object of the expected shape is an envelope failure, and every fact of that send
 * is retried (see `turn-two.ts`).
 */
import { lifecycleTextHash, splitMemoryClauses } from "./lifecycle-text";

/** Known reply actions, including unsupported actions that are dropped rather than retried. */
export const TURN_TWO_ACTIONS = [
    "new",
    "covered",
    "conflict",
    "edit",
    "merge",
    "replaces",
    "abstain",
    // Recognized so a model's unsupported retirement or rule promotion can be
    // dropped and logged without retrying the entire envelope.
    "retire",
    "promote_rule",
] as const;
export type TurnTwoAction = (typeof TURN_TWO_ACTIONS)[number];
export const TURN_TWO_STATUSES = [
    "settled",
    "planned",
    "hypothesis",
    "snapshot",
    "one_off",
] as const;
export type TurnTwoStatus = (typeof TURN_TWO_STATUSES)[number];

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
    /** Optional only for old replies; publication refuses writes without verification. */
    evidenceQuote?: string;
    status?: string;
    reversedBy?: string;
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
          /** False when the wrapper is valid but a decision or score is refused. */
          schemaValid: boolean;
      }
    | { ok: false; reason: "length_capped" | "unparseable" | "schema_invalid" | "tool_activity" };

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
    for (const [wire, field] of [
        ["evidence_quote", "evidenceQuote"],
        ["status", "status"],
        ["reversed_by", "reversedBy"],
    ] as const) {
        if (raw[wire] !== undefined && typeof raw[wire] !== "string") return null;
        if (typeof raw[wire] === "string") decision[field] = raw[wire];
    }
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
export function parseTurnTwoEnvelope(
    text: string,
    lengthCapped: boolean,
    toolActivity = false,
): TurnTwoEnvelope {
    if (toolActivity) return { ok: false, reason: "tool_activity" };
    if (lengthCapped) return { ok: false, reason: "length_capped" };
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, reason: "unparseable" };
    }
    if (!isRecord(raw) || !isRecord(raw.result) || raw.result.step !== "turn_two")
        return { ok: false, reason: "schema_invalid" };
    const result = raw.result;
    if (!Array.isArray(result.decisions)) return { ok: false, reason: "schema_invalid" };
    if (result.scores !== undefined && !Array.isArray(result.scores))
        return { ok: false, reason: "schema_invalid" };
    let schemaValid = true;
    const decisions = new Map<number, TurnTwoDecision | "malformed">();
    result.decisions.forEach((entry, ordinal) => {
        // A decision that names no fact cannot be attributed; the fact it was
        // meant for is then missing, which is the same malformed outcome.
        if (!isRecord(entry) || !isInt(entry.fact_id)) {
            schemaValid = false;
            return;
        }
        const factId = entry.fact_id;
        if (decisions.has(factId)) {
            decisions.set(factId, "malformed");
            schemaValid = false;
            return;
        }
        const decision = parseDecision(entry, factId, ordinal);
        if (!decision || decision.action === "retire" || decision.action === "promote_rule")
            schemaValid = false;
        decisions.set(factId, decision ?? "malformed");
    });
    const scores = new Map<number, TurnTwoScore>();
    const seenScores = new Set<number>();
    for (const entry of (result.scores as unknown[] | undefined) ?? []) {
        if (isRecord(entry) && isInt(entry.item)) {
            if (seenScores.has(entry.item)) {
                schemaValid = false;
                scores.delete(entry.item);
                continue;
            }
            seenScores.add(entry.item);
        }
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
            scores.set(entry.item, {
                item: entry.item,
                importance: entry.importance,
                proposedClass: entry.class,
            });
        else schemaValid = false;
    }
    return { ok: true, decisions, scores: [...scores.values()], schemaValid };
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
 * not cover every pending candidate. Later eligible runs may retry the rest.
 */
export function coverageNotice(facts: number, items: number): string {
    return `Coverage: this request is partial. ${facts} pending fact(s) and ${items} agent memory item(s) were left out to fit the request size. They remain eligible for a later run, but no later request is guaranteed; judge only what is listed here.`;
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
 * Shared evidence is printed once, with stable references under each fact.
 * Citations still use the stored start ordinal and are checked only against that
 * fact's linked blocks, never another fact's evidence. Memories are not truncated.
 */
export function buildTurnTwoPrompt(input: {
    facts: readonly TurnTwoPromptFact[];
    items: readonly TurnTwoPromptItem[];
    lexicalOnly: boolean;
    /** Facts and items left out of this request by the prompt size bound. */
    deferred?: { facts: number; items: number };
}): string {
    const lines: string[] = [
        "Turn two: verify each candidate fact against its own source blocks BEFORE reconciling with memory.",
        `allowed_fact_ids: ${JSON.stringify(input.facts.map((fact) => fact.factId))}`,
        "Return exactly one decision for each allowed fact_id and no others. Earlier reply bullets and compartment numbers are not fact ids. Unpublished and deferred facts are out of scope.",
        "For each decision first report evidence_quote (a verbatim quote stating the fact from one of THIS fact's source blocks), status (settled|planned|hypothesis|snapshot|one_off), and optional reversed_by (a verbatim later quote in those blocks reversing or superseding it). Then choose the action. new, edit, merge and replaces require evidence_quote of at least 25 characters. covered writes nothing and needs no quote.",
        "If the fact is not stated in its own source blocks, abstain: memory and earlier summaries are NOT evidence. If status is not settled, abstain. If a later line reverses the fact, abstain. Only then reconcile with eligible neighbouring memories using the existing action fields. Return these fields inside each decision, not prose.",
        "Examples: 'run long compiles in the background, AFT 30-minute limit' copied from earlier memory but absent from this fact's blocks -> abstain (no evidence_quote). 'ck-mc refuses the paging field on non-final pages' followed by the fix accepting it -> quote both lines as evidence_quote and reversed_by, then abstain.",
        "Source block refs and neighbour refs below point to the shared evidence tables. Cite a source block by its printed start ordinal in the block field, and only if that block is referenced by the fact being decided. Only that fact's neighbour refs are eligible targets.",
    ];
    if (input.lexicalOnly) lines.push(LEXICAL_ONLY_NOTICE);
    if (input.deferred && (input.deferred.facts > 0 || input.deferred.items > 0))
        lines.push(coverageNotice(input.deferred.facts, input.deferred.items));
    const sources = new Map<string, { session: string; block: TurnTwoPromptBlock }>();
    const neighbours = new Map<string, TurnTwoPromptNeighbour>();
    for (const fact of input.facts) {
        lines.push(
            "",
            `## Fact ${fact.factId}${fact.backlog ? " (backlog)" : ""} [${fact.category}] from session ${fact.sourceSessionId}`,
            fact.content,
        );
        if (!fact.anchorKnown)
            lines.push("Source blocks: unknown (this fact cannot evidence an edit).");
        const refs = fact.blocks.map((block) => {
            const ref = `source:${lifecycleTextHash(JSON.stringify([fact.sourceSessionId, block.startOrdinal, block.endOrdinal, block.role, block.parts]))}`;
            sources.set(ref, { session: fact.sourceSessionId, block });
            return ref;
        });
        if (refs.length > 0) lines.push(`Source block refs: ${refs.join(", ")}`);
        lines.push("Neighbour refs:");
        if (fact.neighbours.length === 0) lines.push("- none retrieved");
        for (const neighbour of fact.neighbours) {
            const ref = `memory:${neighbour.id}@${neighbour.revision}`;
            neighbours.set(ref, neighbour);
            lines.push(ref);
        }
    }
    if (sources.size > 0) lines.push("", "## Shared source blocks");
    for (const [ref, { session, block }] of sources)
        lines.push(
            "",
            `### ${ref} (session ${session})`,
            `[${block.startOrdinal === block.endOrdinal ? block.startOrdinal : `${block.startOrdinal}-${block.endOrdinal}`}] ${block.role}: ${block.parts.join(" / ")}`,
        );
    if (neighbours.size > 0) lines.push("", "## Shared neighbouring memories");
    for (const [ref, neighbour] of neighbours) {
        lines.push("", `### ${ref}`, renderNeighbour(neighbour));
    }
    if (input.items.length > 0) {
        lines.push("", "## Agent memories to score");
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

/** Reserve 25% of the prompt cap for backlog when older retryable facts exist. */
export const TURN_TWO_BACKLOG_SHARE = 0.25;

/** Fit without truncation; backlog is a prefix in oldest-first selection order. */
export function fitTurnTwoPrompt(input: {
    facts: readonly TurnTwoPromptFact[];
    items: readonly TurnTwoPromptItem[];
    lexicalOnly: boolean;
    maxLength: number;
}) {
    const backlog = input.facts.filter((fact) => fact.backlog);
    const fresh = input.facts.filter((fact) => !fact.backlog);
    const old: TurnTwoPromptFact[] = [];
    const current: TurnTwoPromptFact[] = [];
    const items: TurnTwoPromptItem[] = [];
    const worstCase = { facts: input.facts.length, items: input.items.length };
    const render = (facts: readonly TurnTwoPromptFact[], itemViews = items) =>
        buildTurnTwoPrompt({
            facts,
            items: itemViews,
            lexicalOnly: input.lexicalOnly,
            deferred: worstCase,
        });
    const backlogLimit = Math.floor(input.maxLength * TURN_TWO_BACKLOG_SHARE);
    // Keep the oldest backlog fact even when its evidence alone exceeds the
    // reserved share or total cap: it cannot be split and must not starve.
    for (const fact of backlog) {
        old.push(fact);
        if (old.length > 1 && render(old, []).length > backlogLimit) {
            old.pop();
            break;
        }
    }
    const freshLimit = backlog.length > 0 ? input.maxLength - backlogLimit : input.maxLength;
    for (const fact of fresh) {
        current.push(fact);
        if (
            (backlog.length > 0 || current.length > 1) &&
            (render(current, []).length > freshLimit ||
                render([...current, ...old]).length > input.maxLength)
        )
            current.pop();
    }
    // Unused fresh capacity can serve more backlog, but never skip an older fact.
    for (const fact of backlog.slice(old.length)) {
        old.push(fact);
        if (render([...current, ...old]).length > input.maxLength) {
            old.pop();
            break;
        }
    }
    const facts = [...current, ...old];
    for (const item of input.items) {
        items.push(item);
        if ((facts.length > 0 || items.length > 1) && render(facts).length > input.maxLength)
            items.pop();
    }
    const deferred = {
        facts: input.facts.length - facts.length,
        items: input.items.length - items.length,
    };
    return {
        facts,
        items,
        deferred,
        prompt: buildTurnTwoPrompt({ facts, items, lexicalOnly: input.lexicalOnly, deferred }),
    };
}
