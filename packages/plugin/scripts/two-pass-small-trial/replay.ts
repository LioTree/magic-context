import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
    lifecycleTextHash,
    splitMemoryClauses,
} from "../../src/features/magic-context/memory/lifecycle-text";
import {
    parseTurnTwoEnvelope,
    type TurnTwoDecision,
    type TurnTwoPromptFact,
} from "../../src/features/magic-context/memory/turn-two-envelope";
import { turnTwoPublicationRefusal } from "../../src/features/magic-context/memory/turn-two-verifier";
import { fetchForRun, macCredentialSource } from "../two-pass-activation-runs/container-launcher";
import type { ReplayCase } from "../two-pass-live-replay/artifact-schema";
import { controlRun002 } from "./control-run-002";
import { requestHash, turnOne, turnTwo } from "./prompts";
import { logger, type Request, sanitizer } from "./provider";
import {
    anthropicReplayRequest,
    REPLAY_CAP_USD,
    REPLAY_OUTPUT_TOKENS,
    REPLAY_PRICES,
    ReplayBudget,
    type ReplayModel,
    replayDeepSeek,
    requestCeiling,
    sendReplaySonnet,
} from "./replay-provider";
import { type Config, loadCases } from "./run";

export const TRIAL_DIR = ".cortexkit/internal-docs/investigations/two-pass-small-trial";
export const REPLAY_CASE_IDS = [0, 8, 10, 12, 35];
export type PromptArm = "control" | "verifier";
export interface SavedRun {
    config: Config;
    cases: Array<{
        caseId: number;
        firstReply: string;
        firstRequestHash: string;
        firstRequestBytes: number;
        secondRequestHash: string;
        secondRequestBytes: number;
        secondReply: string;
    }>;
}
export interface KeyEntry {
    label: "keep" | "abstain" | "borderline";
    reason: string;
    sourceLine: number;
    resolvedByHead?: boolean;
}
export interface AnswerKey {
    version: 1;
    source: string;
    cases: Record<string, Record<string, KeyEntry>>;
}
export interface PlannedReplay {
    caseId: number;
    model: ReplayModel;
    prompt: PromptArm;
    request: Request;
    facts: TurnTwoPromptFact[];
    firstRequestHash: string;
    controlRequestHash: string;
}
export async function planReplay(cases: ReplayCase[], saved: SavedRun): Promise<PlannedReplay[]> {
    if (
        cases.map((c) => c.id).join() !== REPLAY_CASE_IDS.join() ||
        saved.cases.map((c) => c.caseId).join() !== REPLAY_CASE_IDS.join()
    )
        throw new Error("replay_case_binding");
    const planned: PlannedReplay[] = [];
    for (const c of cases) {
        const record = saved.cases.find((r) => r.caseId === c.id)!;
        const first = turnOne(c);
        if (
            requestHash(first) !== record.firstRequestHash ||
            Buffer.byteLength(JSON.stringify(first)) !== record.firstRequestBytes
        )
            throw new Error(`turn_one_hash_case_${c.id}`);
        const second = await turnTwo(c, first, record.firstReply);
        const control = {
            ...second.request,
            messages: [
                ...first.messages,
                { role: "assistant" as const, content: record.firstReply },
                {
                    role: "user" as const,
                    content: controlRun002({
                        facts: second.facts,
                        items: [],
                        lexicalOnly: true,
                        deferred: { facts: second.deferredFacts, items: 0 },
                    }),
                },
            ],
        };
        if (
            requestHash(control) !== record.secondRequestHash ||
            Buffer.byteLength(JSON.stringify(control)) !== record.secondRequestBytes
        )
            throw new Error(`turn_two_control_hash_case_${c.id}`);
        const parsed = parseTurnTwoEnvelope(record.secondReply, false);
        if (
            !parsed.ok ||
            [...parsed.decisions.keys()].sort((a, b) => a - b).join() !==
                second.facts
                    .map((f) => f.factId)
                    .sort((a, b) => a - b)
                    .join()
        )
            throw new Error(`fact_binding_case_${c.id}`);
        for (const model of ["deepseek", "sonnet"] as const)
            for (const prompt of ["control", "verifier"] as const) {
                planned.push({
                    caseId: c.id,
                    model,
                    prompt,
                    request: {
                        ...(prompt === "control" ? control : second.request),
                        max_tokens: REPLAY_OUTPUT_TOKENS,
                    },
                    facts: second.facts,
                    firstRequestHash: record.firstRequestHash,
                    controlRequestHash: record.secondRequestHash,
                });
            }
    }
    return planned;
}
export function planTable(plan: PlannedReplay[]) {
    let total = 0,
        estimate = 0;
    const rows = plan.map((p) => {
        const bytes =
            p.model === "sonnet"
                ? Buffer.byteLength(JSON.stringify(anthropicReplayRequest(p.request))) + 1024
                : Buffer.byteLength(JSON.stringify(p.request));
        const ceiling = requestCeiling(p.request, bytes, REPLAY_PRICES[p.model]);
        total += ceiling;
        estimate +=
            (((bytes + 4096) / 4) * REPLAY_PRICES[p.model].miss +
                REPLAY_OUTPUT_TOKENS * REPLAY_PRICES[p.model].output) /
            1_000_000;
        return `| ${p.caseId} | ${p.model} | ${p.prompt} | ${bytes} | ${p.facts.length} | ${REPLAY_OUTPUT_TOKENS} | $${ceiling.toFixed(6)} |`;
    });
    return {
        total,
        estimate,
        text: [
            "| Case | Model | Prompt | Request UTF-8 bytes (Sonnet includes wire padding) | Facts | Max output tokens | No-cache ceiling |",
            "|---|---|---|---:|---:|---:|---:|",
            ...rows,
            "\nVerified against run 2 before planning (turn-one bytes and SHA256; frozen control bytes and SHA256):",
            ...plan
                .filter((p) => p.model === "deepseek" && p.prompt === "control")
                .map(
                    (p) =>
                        `- Case ${p.caseId}: turn one ${p.firstRequestHash}; control turn two ${p.controlRequestHash}.`,
                ),
            `\n20 planned turn-two requests; turn-one calls=0. Illustrative estimate (4 UTF-8 bytes/input token, full output, no cache discount): $${estimate.toFixed(6)}. This is NOT the cap calculation. Sum of byte-bounded, full-output ceilings: $${total.toFixed(6)}; hard whole-run cap: $${REPLAY_CAP_USD}. The run may stop short if usage or retries exhaust the cap. Before every send, reserve the byte bound, then settle at the higher tariff using observed usage. Retries reserve again before sending (Sonnet pre-reserves all three attempts).`,
        ].join("\n"),
    };
}
export interface FactOutcome {
    factId: number;
    text: string;
    key: KeyEntry;
    raw: TurnTwoDecision | "malformed" | "missing";
    published: boolean;
    covered: boolean;
    postAction: string;
    reason: string | null;
}
export interface Score {
    wrongAccepts: number;
    wrongAbstains: number;
    correctAbstains: number;
    borderline: number;
    codeCaughtWrongAccepts: number;
}
const WRITES = ["new", "edit", "merge", "replaces", "conflict"];
export function evaluateReply(
    reply: string,
    p: PlannedReplay,
    key: AnswerKey,
): { outcomes: FactOutcome[]; score: Score; envelopeValid: boolean } {
    const parsed = parseTurnTwoEnvelope(reply, false);
    const score: Score = {
        wrongAccepts: 0,
        wrongAbstains: 0,
        correctAbstains: 0,
        borderline: 0,
        codeCaughtWrongAccepts: 0,
    };
    const outcomes = p.facts.map((fact): FactOutcome => {
        const k = key.cases[String(p.caseId)]?.[String(fact.factId)];
        if (!k) throw new Error("answer_key_missing_fact");
        const raw = parsed.ok ? (parsed.decisions.get(fact.factId) ?? "missing") : "malformed";
        const decision = typeof raw === "string" ? null : raw;
        const reason = decision ? turnTwoPublicationRefusal(decision, fact.blocks) : String(raw);
        const published = !!decision && WRITES.includes(decision.action) && !reason;
        const target = fact.neighbours.find(
            (n) => n.id === decision?.targetId && n.revision === decision.revision,
        );
        const clauses = target ? splitMemoryClauses(target.content) : [];
        const covered =
            decision?.action === "covered" &&
            !!target &&
            !!decision.clauses?.length &&
            new Set(decision.clauses).size === decision.clauses.length &&
            decision.clauses.every((n) => n >= 1 && n <= clauses.length) &&
            fact.anchorKnown &&
            fact.blocks.some((b) => b.role === "user" || b.role === "tool") &&
            (decision.excerpt === undefined ||
                !clauses.some(
                    (c) =>
                        c.text.replace(/\s+/g, " ").trim() ===
                        decision.excerpt!.replace(/\s+/g, " ").trim(),
                ));
        if (k.label === "borderline") score.borderline++;
        else if (k.label === "abstain") {
            if (published) score.wrongAccepts++;
            else score.correctAbstains++;
            if (decision && WRITES.includes(decision.action) && reason)
                score.codeCaughtWrongAccepts++;
        } else if (!published && !covered) score.wrongAbstains++;
        return {
            factId: fact.factId,
            text: fact.content,
            key: k,
            raw,
            published,
            covered,
            postAction: reason ? "abstain" : (decision?.action ?? "abstain"),
            reason:
                reason ??
                (decision?.action === "covered" && !covered ? "covered_mapping_invalid" : null),
        };
    });
    return { outcomes, score, envelopeValid: parsed.ok };
}

export interface ReplayRecord {
    caseId: number;
    model: ReplayModel;
    prompt: PromptArm;
    requestHash: string;
    firstRequestHash: string;
    rawReply: string;
    outcomes: FactOutcome[];
    score: Score;
    envelopeValid: boolean;
}
const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 220);
export function replayReport(records: ReplayRecord[], failure?: string) {
    const lines = [
        "# Turn-two replay",
        "",
        "Sonnet continues the **same saved DeepSeek turn-one reply** as Flash. Both models judge identical facts. No new turn-one calls. All four arms use the same mechanical publication check. Scores measure publication candidates after that check, not actual database writes or additional paid lifecycle checks.",
        "",
        "Borderline facts are excluded from every score. A valid covered mapping to a retrieved existing memory is fine for keep; covered never publishes a new memory. Unpublished XML facts (including case 10 NAMING/f18) are listed as not offered, not silently scored.",
        "",
        `Failure: ${failure ?? "none"}`,
        "",
        "| Model | Prompt | Wrong accepts | Wrong abstains | Correct abstains | Borderline | Wrong accepts caught by code alone |",
        "|---|---|---:|---:|---:|---:|---:|",
    ];
    for (const model of ["deepseek", "sonnet"] as const)
        for (const prompt of ["control", "verifier"] as const) {
            const rows = records.filter((r) => r.model === model && r.prompt === prompt);
            const sums = [
                "wrongAccepts",
                "wrongAbstains",
                "correctAbstains",
                "borderline",
                "codeCaughtWrongAccepts",
            ].map((name) => rows.reduce((sum, r) => sum + r.score[name as keyof Score], 0));
            lines.push(`| ${model} | ${prompt} | ${sums.join(" | ")} |`);
        }
    for (const r of records) {
        lines.push(
            "",
            `## Case ${r.caseId}: ${r.model} / ${r.prompt}`,
            "",
            `Scores: ${JSON.stringify(r.score)}. Envelope valid: ${r.envelopeValid}.`,
            "",
            "| Fact | Answer key | Raw action | Status | Quote | Post-check | Reason |",
            "|---|---|---|---|---|---|---|",
        );
        for (const f of r.outcomes) {
            const raw = typeof f.raw === "string" ? null : f.raw;
            lines.push(
                `| f${f.factId}: ${cell(f.text)} | ${f.key.label} | ${raw?.action ?? f.raw} | ${raw?.status ?? "missing"} | ${cell(raw?.evidenceQuote ?? "")} | ${f.postAction}${f.covered ? " (valid mapping)" : ""} | ${f.reason ?? "—"} |`,
            );
        }
    }
    return `${lines.join("\n")}\n`;
}
export async function runReplay(input: {
    plan: PlannedReplay[];
    key: AnswerKey;
    outputDir: string;
    mode: "mock" | "live";
    material(model: ReplayModel): Promise<string>;
    mockEndpoint?: string;
    emit?: (text: string) => void;
}) {
    if (input.mode === "live" && (process.platform !== "darwin" || input.mockEndpoint))
        throw new Error("live_requires_mac_direct_endpoint");
    if (input.mode === "mock" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.mockEndpoint ?? ""))
        throw new Error("mock_endpoint_required");
    if (input.plan.length !== 20) throw new Error("replay_matrix_size");
    mkdirSync(input.outputDir, { mode: 0o700 });
    const records: ReplayRecord[] = [];
    let failure: string | undefined;
    const materials: string[] = [];
    const clean = (text: string) =>
        materials.reduce((out, material) => sanitizer(material)(out), text);
    const save = () =>
        writeFileSync(
            resolve(input.outputDir, "replay.json"),
            clean(
                JSON.stringify(
                    {
                        mode: input.mode,
                        hardCapUSD: REPLAY_CAP_USD,
                        records,
                        attempts: budget.rows,
                        committedUSD: budget.committedUSD,
                        failure,
                    },
                    null,
                    2,
                ),
            ),
            { mode: 0o600 },
        );
    const budget = new ReplayBudget(save);
    try {
        for (const p of input.plan) {
            let material = await input.material(p.model);
            if (!materials.includes(material)) materials.push(material);
            const log = logger(material, input.emit ?? ((s) => process.stdout.write(s)));
            const arm = `${p.model}/${p.prompt}`;
            log(`case=${p.caseId} turn=2 arm=${arm} sending`);
            let rawReply: string;
            try {
                rawReply =
                    p.model === "deepseek"
                        ? await replayDeepSeek({
                              endpoint: input.mockEndpoint
                                  ? `${input.mockEndpoint}/chat/completions`
                                  : "https://api.deepseek.com/chat/completions",
                              material,
                              budget,
                              arm,
                              save,
                              log,
                          }).send(p.request, p.caseId, 2)
                        : await sendReplaySonnet({
                              request: p.request,
                              caseId: p.caseId,
                              arm,
                              material,
                              root: resolve(tmpdir(), "magic-context", `replay-${randomUUID()}`),
                              budget,
                              mockEndpoint: input.mockEndpoint
                                  ? `${input.mockEndpoint}/v1/messages`
                                  : undefined,
                          });
            } finally {
                material = "";
            }
            const evaluated = evaluateReply(rawReply, p, input.key);
            const refusals = evaluated.outcomes.filter(
                (f) => f.reason && typeof f.raw !== "string" && WRITES.includes(f.raw.action),
            );
            if (refusals.length)
                log(
                    `verifier abstained ${refusals.length}: ${refusals.map((f) => `f${f.factId} ${f.reason}`).join(", ")}`,
                );
            records.push({
                caseId: p.caseId,
                model: p.model,
                prompt: p.prompt,
                requestHash: requestHash(p.request),
                firstRequestHash: p.firstRequestHash,
                rawReply,
                ...evaluated,
            });
            save();
        }
    } catch (error) {
        // Never serialize provider or vault error bodies, which can echo a key.
        const code = error instanceof Error ? error.message : "replay_failed";
        failure =
            /^(credential_[a-z_]+|spend_cap_refused|usage_[a-z_]+|incomplete_response|measurement_[a-z_]+|transport_[a-z_]+|answer_key_missing_fact|provider_http_error)$/.test(
                code,
            )
                ? code
                : "replay_failed";
    } finally {
        save();
        writeFileSync(
            resolve(input.outputDir, "review.md"),
            clean(replayReport(records, failure)),
            { mode: 0o600 },
        );
        materials.fill("");
    }
    return { records, failure, committedUSD: budget.committedUSD };
}

export async function replayMain(args: string[]) {
    const option = (name: string) => args[args.indexOf(name) + 1];
    if (
        ["--dry-run", "--mock", "--live"].filter((m) => args.includes(m)).length !== 1 ||
        !args.includes("--output")
    )
        throw new Error("replay_usage");
    const savedText = readFileSync(`${TRIAL_DIR}/paid-run-002/run.json`, "utf8");
    const saved = JSON.parse(savedText) as SavedRun;
    const { selected } = loadCases(saved.config);
    const plan = await planReplay(selected, saved);
    const key = JSON.parse(
        readFileSync(`${TRIAL_DIR}/answer-key-run-002.json`, "utf8"),
    ) as AnswerKey;
    for (const p of plan)
        for (const f of p.facts)
            if (!key.cases[String(p.caseId)]?.[String(f.factId)])
                throw new Error("answer_key_missing_fact");
    const outputDir = option("--output");
    if (!outputDir.startsWith(`${TRIAL_DIR}/`) || outputDir.split("/").includes(".."))
        throw new Error("replay_output_path");
    const table = planTable(plan);
    console.log(`Run-2 artifact SHA256: ${lifecycleTextHash(savedText)}\n${table.text}`);
    if (args.includes("--dry-run")) {
        mkdirSync(outputDir, { mode: 0o700 });
        writeFileSync(resolve(outputDir, "plan.md"), `${table.text}\n`, { mode: 0o600 });
        return;
    }
    if (resolve(tmpdir()) !== resolve("target/scratch"))
        throw new Error("replay_tmpdir_must_be_worktree_target_scratch");
    if (args.includes("--mock")) {
        const { replayMockServer } = await import("./replay-mock");
        const server = replayMockServer(plan);
        try {
            const result = await runReplay({
                plan,
                key,
                outputDir,
                mode: "mock",
                material: async () => "mock-replay-key",
                mockEndpoint: server.url,
            });
            console.log(
                `mock requests=${server.requests.length} maxActive=${server.maxActive} records=${result.records.length} failure=${result.failure ?? "none"}`,
            );
            if (result.failure || result.records.length !== 20 || server.maxActive !== 1)
                process.exitCode = 1;
        } finally {
            server.stop();
        }
        return;
    }
    if (process.platform !== "darwin") throw new Error("credential_broker_trusted_host_required");
    if (!args.includes("--enrollment")) throw new Error("credential_enrollment_path_required");
    const source = await macCredentialSource(option("--enrollment"));
    const keys = new Map<ReplayModel, string>();
    try {
        const result = await runReplay({
            plan,
            key,
            outputDir,
            mode: "live",
            material: async (model) => {
                if (!keys.has(model))
                    keys.set(
                        model,
                        await fetchForRun(
                            source,
                            {
                                name:
                                    model === "deepseek"
                                        ? "apikey:deepseek"
                                        : "apikey:anthropic:ufukaltinokgmail",
                                kind: "api_key",
                            },
                            3_600_000,
                        ),
                    );
                return keys.get(model)!;
            },
        });
        if (result.failure || result.records.length !== 20) process.exitCode = 1;
    } finally {
        keys.clear();
        await source.close();
    }
}
