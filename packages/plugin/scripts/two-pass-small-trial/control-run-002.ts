import {
    lifecycleTextHash,
    splitMemoryClauses,
} from "../../src/features/magic-context/memory/lifecycle-text";
import {
    coverageNotice,
    LEXICAL_ONLY_NOTICE,
    type TurnTwoPromptBlock,
    type TurnTwoPromptFact,
    type TurnTwoPromptItem,
    type TurnTwoPromptNeighbour,
} from "../../src/features/magic-context/memory/turn-two-envelope";

/** Frozen run-2 control. Replay verifies its complete request hash before any send. */
export function controlRun002(input: {
    facts: readonly TurnTwoPromptFact[];
    items: readonly TurnTwoPromptItem[];
    lexicalOnly: boolean;
    deferred?: { facts: number; items: number };
}): string {
    const lines: string[] = [
        "Turn two: reconcile each candidate fact with existing project memory.",
        `allowed_fact_ids: ${JSON.stringify(input.facts.map((fact) => fact.factId))}`,
        "Return exactly one decision for each allowed fact_id and no others. Earlier reply bullets and compartment numbers are not fact ids. Unpublished and deferred facts are out of scope.",
        "Before choosing new, edit, merge or replaces, check the conversation. If it treats the statement as a proposal, hypothesis, open question, or still to be measured or decided, choose abstain. Example: 'Gemini reasoning resend is tiny' while a reasoning-budget investigation is still measuring resend cost is a hypothesis, not a new memory.",
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
        const clauses = splitMemoryClauses(neighbour.content)
            .map((clause) => `  c${clause.ordinal}: ${clause.text}`)
            .join("\n");
        lines.push(
            "",
            `### ${ref}`,
            `- #${neighbour.id} rev ${neighbour.revision} [${neighbour.category}]\n${clauses}`,
        );
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
