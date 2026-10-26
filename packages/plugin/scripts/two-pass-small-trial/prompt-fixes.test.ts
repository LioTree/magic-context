import { describe, expect, test } from "bun:test";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import {
    buildTurnTwoPrompt,
    fitTurnTwoPrompt,
    type TurnTwoPromptFact,
} from "../../src/features/magic-context/memory/turn-two-envelope";
import {
    buildCompartmentAgentPrompt,
    historianSystemPrompt,
} from "../../src/hooks/magic-context/compartment-prompt";
import { mockCases, mockReply } from "./mock";
import { memoryDrafts, requestHash, turnOne, turnTwo } from "./prompts";

const fixture = mockCases([0])[0]!;
function fact(id: number, content = `Fact ${id}`): TurnTwoPromptFact {
    return {
        factId: id,
        category: "CONSTRAINTS",
        content,
        sourceSessionId: "session-a",
        anchorKnown: false,
        backlog: false,
        blocks: [],
        neighbours: [],
    };
}

describe("two-pass prompt fixes", () => {
    test("turn-one request bytes and one-pass prompts stay pinned with exact continuation prefix", async () => {
        const first = turnOne(fixture);
        // Hash the serialized request, not a prompt rebuilt from the same expectation.
        expect(requestHash(first)).toBe(
            "1afc48441fdcfd176e3783253910eff59767a83ceaf4e8e0899be22ee9b181c3",
        );
        expect(lifecycleTextHash(historianSystemPrompt(false))).toBe(
            "b1bc6bd9318c6822c675d595206fdc4fc4ffbc6b007248ea6e9a47d528a28817",
        );
        expect(
            lifecycleTextHash(
                buildCompartmentAgentPrompt({
                    seedExamples: "",
                    sessionReferences: "",
                    projectMemory: "",
                    inputSource: "Messages 1-1:\n\n[1] user: Always serialize DeepSeek requests.",
                    memoryEnabled: true,
                }),
            ),
        ).toBe("671405f3e2f1a05fd48786068098d1444c963037cabdde715506baa97af9f590");
        const reply = mockReply(first).choices[0]!.message.content;
        const second = await turnTwo(fixture, first, reply);
        expect(JSON.stringify(second.request.messages.slice(0, 3))).toBe(
            JSON.stringify([...first.messages, { role: "assistant", content: reply }]),
        );
        expect(second.request.messages).toHaveLength(4);
        expect({ ...second.request, messages: first.messages }).toEqual(first);
    });

    test("allowed ids come only from the final fitted facts", () => {
        const fitted = fitTurnTwoPrompt({
            facts: [fact(41), fact(92, "x".repeat(4000))],
            items: [],
            lexicalOnly: true,
            maxLength: 2500,
        });
        expect(fitted.facts.map((f) => f.factId)).toEqual([41]);
        expect(fitted.prompt).toContain("allowed_fact_ids: [41]\n");
        expect(fitted.prompt).not.toContain("## Fact 92");
        expect(fitted.prompt).toContain(
            "exactly one decision for each allowed fact_id and no others",
        );
        expect(fitted.prompt).toContain(
            "Earlier reply bullets and compartment numbers are not fact ids",
        );
        expect(fitted.prompt).toContain("Unpublished and deferred facts are out of scope");
    });

    test("hypothesis veto is concrete and present only in the new turn-two message", () => {
        const prompt = buildTurnTwoPrompt({ facts: [fact(1)], items: [], lexicalOnly: false });
        const rule = "If status is not settled, abstain.";
        expect(prompt).toContain(rule);
        expect(prompt).toContain("status (settled|planned|hypothesis|snapshot|one_off)");
        expect(prompt).toContain(
            "copied from earlier memory but absent from this fact's blocks -> abstain",
        );
        for (const message of turnOne(fixture).messages)
            expect(message.content).not.toContain(rule);
        expect(historianSystemPrompt(false)).not.toContain(rule);
    });

    test("runner ignores and reports extra ids while retaining known drafts", async () => {
        const first = turnOne(fixture);
        const second = await turnTwo(fixture, first, mockReply(first).choices[0]!.message.content);
        const diagnostics = { extraFactIds: [] as number[] };
        const drafts = memoryDrafts(
            JSON.stringify({
                result: {
                    step: "turn_two",
                    decisions: [
                        { fact_id: 1, action: "new" },
                        { fact_id: 3, action: "new" },
                        { fact_id: 4, action: "abstain" },
                    ],
                },
            }),
            second.facts,
            fixture,
            diagnostics,
        );
        expect(drafts).toEqual([
            {
                factId: 1,
                action: "new",
                category: "CONSTRAINTS",
                text: "Always serialize DeepSeek requests.",
            },
        ]);
        expect(diagnostics.extraFactIds).toEqual([3, 4]);
    });

    test("oversized oldest backlog is serviced instead of being skipped forever", () => {
        const old = { ...fact(1, "old".repeat(4000)), backlog: true };
        const fitted = fitTurnTwoPrompt({
            facts: [fact(9), old, { ...fact(2), backlog: true }],
            items: [],
            lexicalOnly: false,
            maxLength: 5000,
        });
        expect(fitted.facts.map((f) => f.factId)).toEqual([1]);
        expect(fitted.deferred.facts).toBe(2);
    });

    test("fresh facts cannot borrow unused reserved backlog capacity", () => {
        const fitted = fitTurnTwoPrompt({
            facts: [fact(9, "x".repeat(121000)), { ...fact(1), backlog: true }],
            items: [],
            lexicalOnly: false,
            maxLength: 160000,
        });
        expect(fitted.facts.map((f) => f.factId)).toEqual([1]);
        expect(fitted.deferred.facts).toBe(1);
    });
});
