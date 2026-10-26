import { describe, expect, test } from "bun:test";
import { parseTurnTwoEnvelope, type TurnTwoDecision } from "./turn-two-envelope";
import { turnTwoPublicationRefusal } from "./turn-two-verifier";

const quote = "Long compiles run in the background because AFT cuts foreground work at 30 minutes.";
const decision: TurnTwoDecision = {
    factId: 1,
    ordinal: 0,
    action: "new",
    evidenceQuote: quote,
    status: "settled",
};
const blocks = [{ parts: [quote] }];
describe("turn-two mechanical verification", () => {
    test("all refusal rules reject invalid writes independently", () => {
        const actual = [
            turnTwoPublicationRefusal({ ...decision, evidenceQuote: undefined }, blocks),
            turnTwoPublicationRefusal({ ...decision, evidenceQuote: "tiny" }, [
                { parts: ["tiny"] },
            ]),
            turnTwoPublicationRefusal(decision, [
                { parts: ["Measure Gemini and Pi reasoning costs before deciding the policy."] },
            ]),
            turnTwoPublicationRefusal({ ...decision, status: "planned" }, blocks),
            turnTwoPublicationRefusal(
                { ...decision, reversedBy: "The later fix supersedes this rule." },
                blocks,
            ),
        ];
        expect(actual).toEqual([
            "evidence_quote_missing",
            "evidence_quote_short",
            "evidence_quote_not_in_fact_blocks",
            "status_not_settled",
            "reversed_by_present",
        ]);
    });
    test("refuses missing evidence_quote", () => {
        expect(turnTwoPublicationRefusal({ ...decision, evidenceQuote: undefined }, blocks)).toBe(
            "evidence_quote_missing",
        );
    });
    test("refuses evidence_quote shorter than 25 normalized characters", () => {
        expect(
            turnTwoPublicationRefusal({ ...decision, evidenceQuote: "tiny" }, [
                { parts: ["tiny"] },
            ]),
        ).toBe("evidence_quote_short");
        expect(
            turnTwoPublicationRefusal({ ...decision, evidenceQuote: "a".repeat(24) }, [
                { parts: ["a".repeat(24)] },
            ]),
        ).toBe("evidence_quote_short");
        expect(
            turnTwoPublicationRefusal({ ...decision, evidenceQuote: "a".repeat(25) }, [
                { parts: ["a".repeat(25)] },
            ]),
        ).toBeNull();
    });
    test("case 10 imported background-compile fact cannot quote memory as its source", () => {
        const memoryBlock = quote;
        const ownSourceBlocks = [
            {
                parts: [
                    "Measure the reasoning resend costs in Gemini and Pi before deciding the policy.",
                ],
            },
        ];
        expect(
            turnTwoPublicationRefusal({ ...decision, evidenceQuote: memoryBlock }, ownSourceBlocks),
        ).toBe("evidence_quote_not_in_fact_blocks");
    });
    test("refuses status other than settled", () => {
        for (const status of [
            undefined,
            "planned",
            "hypothesis",
            "snapshot",
            "one_off",
            "unknown",
            "Settled",
        ])
            expect(turnTwoPublicationRefusal({ ...decision, status }, blocks)).toBe(
                "status_not_settled",
            );
    });
    test("refuses a nonempty reversed_by quote", () => {
        expect(
            turnTwoPublicationRefusal(
                {
                    ...decision,
                    reversedBy: "The fix now accepts the paging field on non-final pages.",
                },
                blocks,
            ),
        ).toBe("reversed_by_present");
    });
    test("matches exact substrings with whitespace collapse only within one own block", () => {
        expect(
            turnTwoPublicationRefusal(
                { ...decision, evidenceQuote: quote.replaceAll(" ", "\n\t") },
                blocks,
            ),
        ).toBeNull();
        expect(turnTwoPublicationRefusal(decision, [{ parts: [quote.toLowerCase()] }])).toBe(
            "evidence_quote_not_in_fact_blocks",
        );
        expect(
            turnTwoPublicationRefusal(decision, [
                { parts: [quote.slice(0, 40)] },
                { parts: [quote.slice(40)] },
            ]),
        ).toBe("evidence_quote_not_in_fact_blocks");
        expect(turnTwoPublicationRefusal({ ...decision, reversedBy: " \n " }, blocks)).toBeNull();
    });
    test("checks every writing action and leaves covered quote-free", () => {
        for (const action of ["new", "edit", "merge", "replaces", "conflict"] as const) {
            expect(turnTwoPublicationRefusal({ ...decision, action }, blocks)).toBeNull();
            expect(
                turnTwoPublicationRefusal(
                    { ...decision, action, evidenceQuote: undefined },
                    blocks,
                ),
            ).toBe("evidence_quote_missing");
        }
        expect(
            turnTwoPublicationRefusal({ factId: 1, ordinal: 0, action: "covered" }, []),
        ).toBeNull();
    });
    test("parses verifier fields and explicitly accepts old shapes for refusal at publication", () => {
        const parse = (d: unknown) =>
            parseTurnTwoEnvelope(
                JSON.stringify({ result: { step: "turn_two", decisions: [d] } }),
                false,
            );
        const parsed = parse({
            fact_id: 1,
            action: "new",
            evidence_quote: quote,
            status: "settled",
            reversed_by: "later line",
        });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error("expected parsed envelope");
        expect(parsed.decisions.get(1)).toEqual({ ...decision, reversedBy: "later line" });
        const old = parse({ fact_id: 1, action: "new" });
        expect(old.ok).toBe(true);
        if (!old.ok) throw new Error("expected old envelope");
        expect(turnTwoPublicationRefusal(old.decisions.get(1) as TurnTwoDecision, blocks)).toBe(
            "evidence_quote_missing",
        );
        for (const field of ["evidence_quote", "status", "reversed_by"]) {
            const malformed = parse({ fact_id: 1, action: "new", [field]: 7 });
            expect(malformed.ok && malformed.decisions.get(1)).toBe("malformed");
        }
    });
});
