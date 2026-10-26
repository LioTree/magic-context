import type { TurnTwoDecision, TurnTwoPromptBlock } from "./turn-two-envelope";

// Twenty-five normalized characters exclude labels and tiny fragments without
// requiring a whole sentence. This is a grounding fence, not an entailment test.
export const MIN_EVIDENCE_QUOTE_LENGTH = 25;
export type TurnTwoRefusal =
    | "evidence_quote_missing"
    | "evidence_quote_short"
    | "evidence_quote_not_in_fact_blocks"
    | "status_not_settled"
    | "reversed_by_present";

export const normalizeEvidenceWhitespace = (text: string): string => text.replace(/\s+/g, " ");

/** No memory text, other facts' blocks, case folding or fuzzy matching is eligible. */
export function turnTwoPublicationRefusal(
    decision: TurnTwoDecision,
    blocks: readonly Pick<TurnTwoPromptBlock, "parts">[],
): TurnTwoRefusal | null {
    // conflict can also admit a memory; it must not bypass the grounding fence.
    if (!["new", "edit", "merge", "replaces", "conflict"].includes(decision.action)) return null;
    const quote = normalizeEvidenceWhitespace(decision.evidenceQuote ?? "");
    if (!quote.trim()) return "evidence_quote_missing";
    if (quote.trim().length < MIN_EVIDENCE_QUOTE_LENGTH) return "evidence_quote_short";
    if (
        !blocks.some((block) =>
            normalizeEvidenceWhitespace(block.parts.join(" / ")).includes(quote),
        )
    )
        return "evidence_quote_not_in_fact_blocks";
    if (decision.status !== "settled") return "status_not_settled";
    if (decision.reversedBy?.trim()) return "reversed_by_present";
    return null;
}
