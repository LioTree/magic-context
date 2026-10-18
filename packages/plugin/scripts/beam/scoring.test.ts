import { describe, expect, test } from "bun:test";
import {
    alignWithJudge,
    kendallTauB,
    mean,
    orderingScore,
    parseJudgeJson,
    renderEquivalencePrompt,
    renderNuggetPrompt,
    scoreEventOrdering,
    scoreNuggets,
    summarize,
    unionRanks,
} from "./scoring";

// Expected tau-b values were computed with scipy 1.13 `kendalltau(x, y, variant="b")`, the call the
// BEAM release uses; `tauNorm` values come from its `event_ordering_score` with the LLM step removed.
describe("kendallTauB", () => {
    const cases: [number[], number[], number][] = [
        [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 1],
        [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1], -1],
        [[1, 2, 3, 4, 5], [3, 4, 1, 2, 5], 0.2],
        [[1, 2, 3, 6, 6, 6], [2, 1, 6, 3, 4, 5], 0.29814239699997197],
        [[1, 1, 2, 3], [1, 2, 2, 3], 0.8],
        [[1, 2, 3, 4, 4], [4, 1, 2, 3, 4], 0.2222222222222222],
    ];
    for (const [x, y, expected] of cases) {
        test(`${JSON.stringify(x)} vs ${JSON.stringify(y)}`, () => {
            expect(kendallTauB(x, y)).toBeCloseTo(expected, 12);
        });
    }

    test("is NaN when one side is entirely tied", () => {
        expect(kendallTauB([1, 1, 1], [1, 2, 3])).toBeNaN();
    });
});

describe("orderingScore", () => {
    const cases: [string[], string[], number][] = [
        [["A", "B", "C"], ["A", "B", "C"], 1],
        [["A", "B", "C"], ["C", "B", "A"], 0],
        [["A", "B", "C"], ["B", "A", "x", "C"], 0.6666666666666667],
        [["A", "B", "C"], ["A", "", ""], 0.5912870929175277],
        [["A", "B", "C"], ["x", "y"], 0.1220355269907728],
        [["A", "B", "C", "D"], ["A", "C", "", "B"], 0.7],
    ];
    for (const [reference, aligned, expected] of cases) {
        test(`${JSON.stringify(aligned)} against ${JSON.stringify(reference)}`, () => {
            expect(orderingScore(reference, aligned).tauNorm).toBeCloseTo(expected, 12);
        });
    }

    test("ranks a missing item after every item of the list", () => {
        expect(unionRanks(["A", "B"], ["B", "x"])).toEqual({
            union: ["A", "B", "x"],
            referenceRanks: [1, 2, 4],
            systemRanks: [4, 1, 2],
        });
    });
});

describe("event ordering with the equivalence judge", () => {
    test("each answer line takes the first unused reference item judged the same", async () => {
        const same = async (reference: string, system: string) => system.toLowerCase().includes(reference.toLowerCase());
        const aligned = await alignWithJudge(["setup", "auth", "deploy"], ["1) auth work", "2) setup again", "3) setup", "4) misc"], same);
        expect(aligned).toEqual(["auth", "setup", "3) setup", "4) misc"]);
    });

    test("scores the released code's way: answer split on newlines, YES anywhere means the same", async () => {
        const result = await scoreEventOrdering(["Core functionality", "Error handling", "Deployment"], "Deployment\nCore functionality\nError handling", async ({ user }) => {
            const [first, second] = user.split("\n").map((line) => line.replace(/^(First|Second) snippet: /, ""));
            return first === second ? "**YES**" : "NO";
        });
        // Aligned order [Deployment, Core, Error] against [Core, Error, Deployment]: tau-b = -1/3.
        expect(result.ordering?.aligned).toEqual(["Deployment", "Core functionality", "Error handling"]);
        expect(result.score).toBeCloseTo(1 / 3, 12);
    });
});

describe("nugget scoring", () => {
    test("averages the judge's 0 / 0.5 / 1 verdicts over the question's nuggets", async () => {
        const verdicts: Record<string, string> = {
            first: '{"score": 1.0, "reason": "met"}',
            second: '```json\n{"score": 0.5, "reason": "partly"}\n```',
            third: 'Here: {"score": 0, "reason": "missing"}',
        };
        const result = await scoreNuggets("Q?", "the answer", ["first", "second", "third"], async ({ user }) => {
            const nugget = /RUBRIC CRITERION \(what to check\): (\w+)/.exec(user)?.[1] ?? "";
            return verdicts[nugget] ?? "";
        });
        expect(result.nuggets?.map((verdict) => verdict.score)).toEqual([1, 0.5, 0]);
        expect(result.score).toBeCloseTo(0.5, 12);
    });

    test("an unparseable verdict scores 0 and records the error", async () => {
        const result = await scoreNuggets("Q?", "A", ["one", "two"], async ({ user }) =>
            user.includes(": one\n") ? '{"score": 1}' : "I cannot decide",
        );
        expect(result.score).toBe(0.5);
        expect(result.nuggets?.[1]?.error).toContain("no JSON object");
    });

    test("parseJudgeJson keeps an off-scale value in 0..1 but flags it, and rejects anything outside", () => {
        expect(parseJudgeJson('{"score": "0.5"}')).toEqual({ score: 0.5, reason: "", offScale: false });
        expect(parseJudgeJson('{"score": 0.75, "reason": "r"}')).toEqual({ score: 0.75, reason: "r", offScale: true });
        expect(() => parseJudgeJson('{"score": 2}')).toThrow();
    });
});

describe("prompt rendering", () => {
    test("Listing 20 receives the question, the nugget and the response, with `$` kept literal", async () => {
        const text = await renderNuggetPrompt("What is $HOME?", "LLM response should state: $1", "It is $& here");
        expect(text).toContain("- QUESTION (what the user asked): What is $HOME?");
        expect(text).toContain("- RUBRIC CRITERION (what to check): LLM response should state: $1");
        expect(text).toContain("- RESPONSE TO EVALUATE: It is $& here");
        expect(text).not.toMatch(/<question>|<rubric_item>|<llm_response>/);
    });

    test("Listing 21 splits into the instruction and the two snippets", async () => {
        const { system, user } = await renderEquivalencePrompt("one", "two");
        expect(system.startsWith("You are a binary classifier.")).toBe(true);
        expect(user).toBe("First snippet: one\nSecond snippet: two");
    });
});

describe("summaries", () => {
    test("the headline is the mean over questions, with a mean per ability", () => {
        const summary = summarize([
            { category: "b", score: 1 },
            { category: "a", score: 0 },
            { category: "a", score: 0.5 },
        ]);
        expect(summary.mean).toBeCloseTo(0.5, 12);
        expect(summary.byCategory).toEqual({ a: { questions: 2, mean: 0.25 }, b: { questions: 1, mean: 1 } });
        expect(mean([])).toBe(0);
    });
});
