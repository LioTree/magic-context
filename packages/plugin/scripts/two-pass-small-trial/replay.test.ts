import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlRun002 } from "./control-run-002";
import { mockCases, mockReply } from "./mock";
import { requestHash, turnOne, turnTwo } from "./prompts";
import {
    type AnswerKey,
    evaluateReply,
    type PlannedReplay,
    planReplay,
    planTable,
    REPLAY_CASE_IDS,
    runReplay,
    type SavedRun,
} from "./replay";
import { replayMockServer } from "./replay-mock";
import { ReplayBudget, sendReplaySonnet } from "./replay-provider";

async function fixtures() {
    const cases = mockCases(REPLAY_CASE_IDS);
    const saved = { config: {}, cases: [] } as unknown as SavedRun;
    for (const c of cases) {
        const first = turnOne(c);
        const firstReply = mockReply(first).choices[0].message.content;
        const second = await turnTwo(c, first, firstReply);
        const control = {
            ...second.request,
            messages: [
                ...first.messages,
                { role: "assistant" as const, content: firstReply },
                {
                    role: "user" as const,
                    content: controlRun002({ facts: second.facts, items: [], lexicalOnly: true }),
                },
            ],
        };
        saved.cases.push({
            caseId: c.id,
            firstReply,
            firstRequestHash: requestHash(first),
            firstRequestBytes: Buffer.byteLength(JSON.stringify(first)),
            secondRequestHash: requestHash(control),
            secondRequestBytes: Buffer.byteLength(JSON.stringify(control)),
            secondReply: JSON.stringify({
                result: { step: "turn_two", decisions: [{ fact_id: 1, action: "new" }] },
            }),
        });
    }
    const plan = await planReplay(cases, saved);
    const key: AnswerKey = {
        version: 1,
        source: "synthetic",
        cases: Object.fromEntries(
            cases.map((c) => [
                c.id,
                { "1": { label: "keep", reason: "synthetic settled fact", sourceLine: 1 } },
            ]),
        ),
    };
    return { cases, saved, plan, key };
}
function scratch() {
    // The Sonnet handoff only accepts a disposable root under <tmpdir>/magic-context,
    // so build it there whatever TMPDIR the test runner was given.
    const root = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(root, { recursive: true });
    return mkdtempSync(`${root}/verifier-replay-`);
}
test("replay stops before sending when either recorded request hash differs", async () => {
    const { cases, saved } = await fixtures();
    const first = saved.cases[0];
    const original = first.firstRequestHash;
    first.firstRequestHash = "bad";
    await expect(planReplay(cases, saved)).rejects.toThrow("turn_one_hash_case_0");
    first.firstRequestHash = original;
    first.secondRequestHash = "bad";
    await expect(planReplay(cases, saved)).rejects.toThrow("turn_two_control_hash_case_0");
});
test("replay runs exactly twenty serial turn-two requests through both real client paths against mock", async () => {
    const { plan, key } = await fixtures();
    const server = replayMockServer(plan);
    const root = scratch();
    try {
        const result = await runReplay({
            plan,
            key,
            mode: "mock",
            outputDir: `${root}/run`,
            mockEndpoint: server.url,
            material: async () => "mock-secret",
            emit: () => {},
        });
        expect(result.failure).toBeUndefined();
        expect(result.records).toHaveLength(20);
        expect(server.requests).toHaveLength(20);
        expect(server.maxActive).toBe(1);
        expect(server.requests.filter((r) => r.path === "/v1/messages")).toHaveLength(10);
        expect(server.requests.filter((r) => r.path === "/chat/completions")).toHaveLength(10);
        expect(
            result.records
                .filter((r) => r.prompt === "control")
                .every((r) => r.outcomes[0].reason === "evidence_quote_missing"),
        ).toBe(true);
        expect(
            result.records
                .filter((r) => r.prompt === "verifier")
                .every((r) => r.outcomes[0].published),
        ).toBe(true);
        for (const c of REPLAY_CASE_IDS)
            expect(
                new Set(
                    plan.filter((p) => p.caseId === c).map((p) => p.request.messages[2].content),
                ).size,
            ).toBe(1);
        expect(
            planTable(plan)
                .text.split("\n")
                .filter((s) => /^\| \d/.test(s)),
        ).toHaveLength(20);
        expect(result.committedUSD).toBeLessThan(6);
    } finally {
        server.stop();
        rmSync(root, { recursive: true, force: true });
    }
}, 60_000);
test("scoring excludes borderline, accepts valid covered keep and isolates code-only wrong accepts", async () => {
    const { plan } = await fixtures();
    const p = structuredClone(plan[0]) as PlannedReplay;
    p.facts = [1, 2, 3, 4, 5].map((factId) => ({ ...p.facts[0], factId }));
    p.facts[3].neighbours = [
        {
            id: 90,
            revision: 1,
            category: "CONSTRAINTS",
            content: "Always serialize DeepSeek requests.",
        },
    ];
    const key: AnswerKey = {
        version: 1,
        source: "synthetic",
        cases: {
            "0": Object.fromEntries(
                ["abstain", "keep", "borderline", "keep", "abstain"].map((label, i) => [
                    i + 1,
                    { label, reason: "synthetic", sourceLine: 1 },
                ]),
            ) as AnswerKey["cases"][string],
        },
    };
    const evaluated = evaluateReply(
        JSON.stringify({
            result: {
                step: "turn_two",
                decisions: [
                    { fact_id: 1, action: "new" },
                    { fact_id: 2, action: "abstain" },
                    {
                        fact_id: 3,
                        action: "new",
                        status: "settled",
                        evidence_quote: "Always serialize DeepSeek requests.",
                    },
                    { fact_id: 4, action: "covered", target_id: 90, revision: 1, clauses: [1] },
                    {
                        fact_id: 5,
                        action: "new",
                        status: "settled",
                        evidence_quote: "Always serialize DeepSeek requests.",
                    },
                ],
            },
        }),
        p,
        key,
    );
    expect(evaluated.score).toEqual({
        wrongAccepts: 1,
        wrongAbstains: 1,
        correctAbstains: 1,
        borderline: 1,
        codeCaughtWrongAccepts: 1,
    });
});
test("shared six-dollar cap refuses before an over-budget request", async () => {
    const { plan } = await fixtures();
    const budget = new ReplayBudget(() => {});
    const request = { ...plan[0].request, max_tokens: 600001 };
    expect(() => budget.reserve(request, 0, 0, "sonnet", "verifier")).toThrow("spend_cap_refused");
    expect(budget.rows).toHaveLength(0);
});
test("Sonnet handoff backs off on 429 and reserves retries", async () => {
    const { plan } = await fixtures();
    const server = replayMockServer(plan, { retryOnce: true });
    const root = scratch();
    const budget = new ReplayBudget(() => {});
    try {
        const p = plan.find((p) => p.model === "sonnet")!;
        await sendReplaySonnet({
            request: p.request,
            caseId: 0,
            arm: "control",
            material: "mock-key",
            root,
            budget,
            mockEndpoint: `${server.url}/v1/messages`,
        });
        expect(server.requests).toHaveLength(2);
        expect(budget.rows).toHaveLength(3);
        expect(budget.rows[0].costCeilingUSD).toBeUndefined();
        expect(budget.rows[2].costCeilingUSD).toBe(0);
    } finally {
        server.stop();
        rmSync(root, { recursive: true, force: true });
    }
});
test("no-credit stops the whole matrix immediately without fetching another key", async () => {
    const { plan, key } = await fixtures();
    const server = replayMockServer(plan, { status: 429, error: "insufficient credit balance" });
    const root = scratch();
    const keys: string[] = [];
    try {
        const result = await runReplay({
            plan,
            key,
            mode: "mock",
            outputDir: `${root}/run`,
            mockEndpoint: server.url,
            material: async (model) => {
                keys.push(model);
                return "mock-secret";
            },
            emit: () => {},
        });
        expect(result.failure).toBe("credential_no_credit");
        expect(server.requests).toHaveLength(1);
        expect(keys).toEqual(["deepseek"]);
    } finally {
        server.stop();
        rmSync(root, { recursive: true, force: true });
    }
});
test("Sonnet no-credit stops the matrix without switching to DeepSeek", async () => {
    const { plan, key } = await fixtures();
    const server = replayMockServer(plan, { status: 402, error: "no credit" });
    const root = scratch();
    const keys: string[] = [];
    try {
        const ordered = [
            ...plan.filter((p) => p.model === "sonnet"),
            ...plan.filter((p) => p.model === "deepseek"),
        ];
        const result = await runReplay({
            plan: ordered,
            key,
            mode: "mock",
            outputDir: `${root}/run`,
            mockEndpoint: server.url,
            material: async (model) => {
                keys.push(model);
                return "mock-secret";
            },
            emit: () => {},
        });
        expect(result.failure).toBe("credential_no_credit");
        expect(server.requests).toHaveLength(1);
        expect(keys).toEqual(["sonnet"]);
    } finally {
        server.stop();
        rmSync(root, { recursive: true, force: true });
    }
});
