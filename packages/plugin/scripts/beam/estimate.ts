/** Offline pre-spend accounting. No credentials, host startup or provider clients are used. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { BoundaryProbeResult } from "./boundary-probe";
import { buildConversation, conversationDigest, loadRows } from "./dataset";
import { dataDir } from "./host";
import { releasedPromptSet } from "./prompts";
import { DATASET_REVISION } from "./run";
import { historianPayload, historianRange, type StubRecord } from "./stub";
import { pruneVanillaHistory, releasedTokenTotal, textTokenCounts } from "./vanilla";

function strings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === "object") return Object.values(value).flatMap(strings);
    return [];
}

const { values } = parseArgs({
    options: {
        split: { type: "string", default: "500K" },
        conversations: { type: "string", default: "1,2,3,4,5" },
        "context-limit": { type: "string", default: "272000" },
        "stub-run": { type: "string" },
    },
});
if (!values["stub-run"])
    throw new Error(
        "--stub-run is required: a completed one-question-per-conversation MC stub run",
    );
const run = join(dataDir(), "runs", values["stub-run"]);
const settings = JSON.parse(readFileSync(join(run, "settings.json"), "utf8"));
if (
    settings.mode !== "stub" ||
    settings.split !== values.split ||
    settings.datasetRevision !== DATASET_REVISION ||
    settings.answerContextLimit !== Number(values["context-limit"])
) {
    throw new Error(
        "estimate requires a stub run with the same split, dataset revision and context limit",
    );
}
const records: (Omit<StubRecord, "body"> & { body: Record<string, unknown> })[] = readdirSync(run)
    .filter((name) => /^stub-records-mc-.*\.json$/.test(name))
    .flatMap((name) => JSON.parse(readFileSync(join(run, name), "utf8")));
const rows = await loadRows(
    join(dataDir(), "dataset", `${values.split}-${DATASET_REVISION}.jsonl`),
);
const selected = values.conversations.split(",").map((id) => {
    const row = rows.find((candidate) => candidate.conversation_id === id);
    if (!row) throw new Error(`missing conversation ${id}`);
    return buildConversation(row);
});
const assumptions = {
    answerTextTokens: 1024,
    mcToolCallsPerQuestion: 1,
    mcToolCallOutputTokens: 128,
    historianVisibleOutputTokens: 4096,
    historianThinkingTokens: 4000,
    nuggetJudgeOutputTokens: 128,
    orderingAnswerLines: 16,
    orderingLineTokens: 64,
    equivalenceOutputTokens: 8,
};
interface ConversationEstimate {
    id: string;
    digest: string;
    turns: number;
    questions: number;
    rawCl100kTokens: number;
    retainedTurns: number;
    retainedCl100kTokens: number;
    vanillaInput: number;
    vanillaO200kInput: number;
    probe: BoundaryProbeResult;
    tailCl100kContentTokens: number;
    chunks: number;
    historianCalls: number;
    mcStubSerializedAnswerInputO200k: number;
    mcPlannedAnswerInputO200k: number;
    judgeInputO200k: number;
    nuggetCalls: number;
    equivalenceCalls: number;
}
const perConversation: ConversationEstimate[] = [];
for (const conversation of selected) {
    const raw = conversation.turns.map(({ role, content }) => ({ role, content }));
    const rawCounts = textTokenCounts(raw.map((message) => message.content));
    const retained = pruneVanillaHistory(raw, rawCounts, Number(values["context-limit"]));
    const retainedCounts = rawCounts.slice(raw.length - retained.length);
    // slice(-0) means the entire array, whereas an empty released suffix must count as empty.
    if (retained.length === 0) retainedCounts.length = 0;
    const questions = await Promise.all(
        conversation.questions.map(async (question) => ({
            question,
            turn: await releasedPromptSet.questionTurn(question.text),
        })),
    );
    const wrapperCounts = textTokenCounts(questions.map(({ turn }) => turn));
    const vanillaInput =
        questions.length * releasedTokenTotal(retainedCounts) +
        wrapperCounts.reduce((sum, count) => sum + 4 + count, 0);
    const o200kHistory = releasedTokenTotal(
        textTokenCounts(
            retained.map((message) => message.content),
            "o200k_base",
        ),
    );
    const vanillaO200kInput =
        questions.length * o200kHistory +
        textTokenCounts(
            questions.map(({ turn }) => turn),
            "o200k_base",
        ).reduce((sum, count) => sum + 4 + count, 0);

    const judgePrompts: { contents: string[]; extra: number; multiplier: number }[] = [];
    let nuggetCalls = 0;
    let equivalenceCalls = 0;
    for (const { question } of questions) {
        if (question.category === "event_ordering") {
            // Worst-case alignment tries every reference for each planned answer line.
            for (const nugget of question.rubric) {
                const prompt = await releasedPromptSet.equivalence({
                    reference: nugget,
                    system: "",
                });
                judgePrompts.push({
                    contents: prompt.map((message) => message.content),
                    extra: assumptions.orderingLineTokens,
                    multiplier: assumptions.orderingAnswerLines,
                });
                equivalenceCalls += assumptions.orderingAnswerLines;
            }
        } else {
            for (const nugget of question.rubric) {
                const prompt = await releasedPromptSet.nuggetJudge({
                    question: question.text,
                    nugget,
                    response: "",
                });
                judgePrompts.push({
                    contents: prompt.map((message) => message.content),
                    extra: assumptions.answerTextTokens,
                    multiplier: 1,
                });
                nuggetCalls++;
            }
        }
    }
    const judgeContentCounts = textTokenCounts(
        judgePrompts.flatMap((prompt) => prompt.contents),
        "o200k_base",
    );
    let cursor = 0;
    const judgeInput = judgePrompts.reduce((total, prompt) => {
        const contentCounts = judgeContentCounts.slice(cursor, cursor + prompt.contents.length);
        cursor += prompt.contents.length;
        return total + prompt.multiplier * (releasedTokenTotal(contentCounts) + prompt.extra);
    }, 0);
    const ingest = JSON.parse(
        readFileSync(join(run, "mc", "ingest", `c${conversation.id}.json`), "utf8"),
    );
    const probe = ingest.probe;
    const sample = questions.find(({ turn }) =>
        records.some(
            (record) =>
                record.route === "codex" &&
                strings(record.body?.input).some((text) => text.includes(turn)),
        ),
    );
    if (!sample) throw new Error(`no answer-prompt template for conversation ${conversation.id}`);
    const templates = records.filter(
        (record) =>
            record.route === "codex" &&
            (record.body?.tools as unknown[] | undefined)?.length &&
            strings(record.body?.input).some((text) => text.includes(sample.turn)),
    );
    if (templates.length !== 2)
        throw new Error(
            `expected exactly two stub answer requests for c${conversation.id}, got ${templates.length}`,
        );
    const answerPayloads = questions.flatMap(({ question, turn }) =>
        templates.map((record) => {
            const body = record.body ?? {};
            const payload = JSON.stringify({
                instructions: body.instructions,
                input: body.input,
                tools: body.tools,
            });
            return payload
                .replaceAll(
                    JSON.stringify(sample.turn).slice(1, -1),
                    JSON.stringify(turn).slice(1, -1),
                )
                .replaceAll(
                    JSON.stringify(sample.question.text).slice(1, -1),
                    JSON.stringify(question.text).slice(1, -1),
                );
        }),
    );
    const mcStubInput = textTokenCounts(answerPayloads, "o200k_base").reduce(
        (sum, count) => sum + count,
        0,
    );
    const tailContentTokens = textTokenCounts(
        conversation.turns.slice(-probe.messagesToKeep).map((turn) => turn.content),
    );
    perConversation.push({
        id: conversation.id,
        digest: conversationDigest(conversation),
        turns: raw.length,
        questions: questions.length,
        rawCl100kTokens: releasedTokenTotal(rawCounts),
        retainedTurns: retained.length,
        retainedCl100kTokens: releasedTokenTotal(retainedCounts),
        vanillaInput,
        vanillaO200kInput,
        probe,
        tailCl100kContentTokens: tailContentTokens.reduce((sum, count) => sum + count, 0),
        chunks: ingest.stats.compartments,
        historianCalls: ingest.historian.calls,
        mcStubSerializedAnswerInputO200k: mcStubInput,
        mcPlannedAnswerInputO200k:
            mcStubInput +
            questions.length *
                templates.length *
                ingest.historian.calls *
                assumptions.historianVisibleOutputTokens,
        judgeInputO200k: judgeInput,
        nuggetCalls,
        equivalenceCalls,
    });
}

const historianRequests = records.filter((record) => record.route === "cloud-code");
const expectedHistorianCalls = perConversation.reduce((sum, row) => sum + row.historianCalls, 0);
if (historianRequests.length !== expectedHistorianCalls)
    throw new Error("stub transcript must contain every ingest request exactly once");
const historianPrompts = historianRequests.map((record) => {
    const request = record.body.request as Record<string, unknown>;
    return JSON.stringify({
        contents: request.contents,
        systemInstruction: request.systemInstruction,
        tools: request.tools,
    });
});
const historianStubOutput = historianRequests.map((record) => {
    const range = historianRange(strings(record.body.request));
    if (!range)
        throw new Error(
            "unexpected non-incremental or repair historian call; estimate explicitly before proceeding",
        );
    return historianPayload(range);
});
const sum = (key: keyof (typeof perConversation)[number]) =>
    perConversation.reduce((total, row) => total + Number(row[key]), 0);
const questions = sum("questions");
const historianBaseInput = textTokenCounts(historianPrompts, "o200k_base").reduce(
    (total, count) => total + count,
    0,
);
const carriedSummaryAllowance = perConversation.reduce(
    (total, row) =>
        total +
        ((row.historianCalls * (row.historianCalls - 1)) / 2) *
            assumptions.historianVisibleOutputTokens,
    0,
);
const judgeOutput =
    sum("nuggetCalls") * assumptions.nuggetJudgeOutputTokens +
    sum("equivalenceCalls") * assumptions.equivalenceOutputTokens;
const result = {
    split: values.split,
    datasetRevision: DATASET_REVISION,
    contextLimit: Number(values["context-limit"]),
    assumptions,
    interpretation: [
        "No provider calls. cl100k is the released pruning metric, not GPT-6 billing. o200k is an explicitly uncalibrated planning proxy for both providers.",
        "MC prompt sizes use real host stub templates with each dataset question substituted; serialized JSON prompt BPE counts include keys/framing, unlike provider billing.",
        "MC planning adds a full 4096 visible tokens per earlier summary to each later historian call and per summary to both answer requests; actual compaction and retrieval may differ.",
        "Judge inputs render the actual released prompts with an empty answer, then add the planned answer tokens. Event ordering allows 16 lines and all reference comparisons (no early matches).",
        "Outputs are allowances, not known future usage. Answer/tool count and judge line count are scenarios, not enforced caps; historian maxOutputTokens=65536 is configured.",
    ],
    perConversation,
    exactReleasedVanillaInputCl100k: sum("vanillaInput"),
    scenarioO200k: {
        vanilla: {
            answer: {
                input: sum("vanillaO200kInput"),
                output: questions * assumptions.answerTextTokens,
            },
            judge: { input: sum("judgeInputO200k"), output: judgeOutput },
        },
        mc: {
            summarizer: {
                input: historianBaseInput + carriedSummaryAllowance,
                output:
                    expectedHistorianCalls *
                    (assumptions.historianVisibleOutputTokens +
                        assumptions.historianThinkingTokens),
                calls: expectedHistorianCalls,
                configuredOutputCeiling: expectedHistorianCalls * 65536,
            },
            answer: {
                input: sum("mcPlannedAnswerInputO200k"),
                output:
                    questions * (assumptions.answerTextTokens + assumptions.mcToolCallOutputTokens),
            },
            judge: { input: sum("judgeInputO200k"), output: judgeOutput },
        },
    },
    stubOnly: {
        historianSerializedInputO200k: historianBaseInput,
        historianTextOutputO200k: textTokenCounts(historianStubOutput, "o200k_base").reduce(
            (total, count) => total + count,
            0,
        ),
        mcSerializedAnswerInputO200k: sum("mcStubSerializedAnswerInputO200k"),
    },
};
const outputDir = join(dataDir(), "estimates");
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, `${values.split}-five.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
