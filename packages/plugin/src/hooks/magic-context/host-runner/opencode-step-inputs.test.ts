import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createScheduler } from "../../../features/magic-context/scheduler";
import type { SessionMeta } from "../../../features/magic-context/types";
import { CONTEXT_USAGE_TTL_MS } from "../context-usage";
import { startOracle } from "./conformance/oracle";
import baseSnapshot from "./fixtures/opencode-step-inputs-base.json";
import { openCodeStepInputs } from "./opencode-step-inputs";
import type { StepInputs } from "./provider-client";

type Input = Parameters<typeof openCodeStepInputs>[0];
type Entry = NonNullable<Input["entry"]>;
const NOW = 1_800_000_000_000;
const MODEL = "fixture/model-a";

// opencode-step-inputs-base.json pins the adapter before host-fact ingress.
// Run its complete inputs() body verbatim instead of rewriting a reference
// formula that could repeat a mistake in the current code.
const baseFactory = new Function(
    "deps",
    "model",
    "randomUUID",
    `${new Bun.Transpiler({ loader: "ts" }).transformSync(baseSnapshot.inputs_typescript)}\nreturn inputs;`,
) as (
    deps: unknown,
    model: () => string,
    uuid: () => string,
) => (id: string, messages: unknown[], meta: Input["meta"]) => StepInputs;

function acceptedBase(input: Input): StepInputs {
    const contextUsageMap = new Map(input.entry ? [["session", input.entry]] : []);
    return baseFactory(
        { contextUsageMap },
        () => input.model,
        () => input.stepId,
    )("session", [{ info: { id: input.stepId } }], input.meta);
}

function freshInput(): Input {
    return {
        model: MODEL,
        stepId: "step",
        now: NOW,
        meta: { lastUsageContextLimit: 200_000, lastResponseTime: NOW - 10 },
        entry: {
            updatedAt: NOW - 10,
            usage: {
                inputTokens: 140_000,
                percentage: 70,
                providerUsage: {
                    model: MODEL,
                    input: 100_000,
                    cache_read: 30_000,
                    cache_write: 10_000,
                    output: 4000,
                    completed_at: NOW - 10,
                    finish_reason: "tool-calls",
                },
            },
        },
    };
}

test("ordinary provider inputs retain fresh meters and terminal metadata", () => {
    expect(openCodeStepInputs(freshInput())).toEqual({
        model: MODEL,
        step_id: "step",
        step_kind: "model",
        context_window: 200_000,
        previous_usage: {
            input: 100_000,
            cache_read: 30_000,
            cache_write: 10_000,
            output: 4000,
            completed_at: NOW - 10,
            finish_reason: "tool-calls",
        },
        estimate: { request_tokens: 140_000 },
    });
});

test("ordinary provider inputs expire usage only after the shared one-hour observation TTL", () => {
    const input = freshInput();
    expect(CONTEXT_USAGE_TTL_MS).toBe(3_600_000);
    input.entry!.updatedAt = NOW - CONTEXT_USAGE_TTL_MS;
    expect(openCodeStepInputs(input).previous_usage?.input).toBe(100_000);
    input.now++;
    expect(openCodeStepInputs(input).previous_usage).toBeUndefined();
    expect(openCodeStepInputs(input).estimate.request_tokens).toBe(0);
    expect(acceptedBase(input).estimate.request_tokens).toBe(140_000);
});

test("ordinary provider inputs reject another model's sample but retain unscoped aggregates", () => {
    const input = freshInput();
    input.model = "fixture/model-b";
    expect(openCodeStepInputs(input).previous_usage).toBeUndefined();
    expect(openCodeStepInputs(input).estimate.request_tokens).toBe(0);
    expect(acceptedBase(input).estimate.request_tokens).toBe(140_000);
    input.entry!.usage.providerUsage = undefined;
    expect(JSON.stringify(openCodeStepInputs(input))).toBe(JSON.stringify(acceptedBase(input)));
});

function random(seed: number) {
    let state = seed;
    return (limit: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % limit;
    };
}

function sequence(seed: number) {
    const next = random(seed);
    let now = NOW + seed * 10_000;
    let model = `fixture/model-${seed}-a`;
    const other = `fixture/model-${seed}-b`;
    const window = [128_000, 200_000, 1_000_000][next(3)];
    let lastResponseTime = 0;
    let entry: Entry | undefined;
    const states: {
        input: Input;
        midToolUse: boolean;
        exception?: "expired" | "model_mismatch";
        cacheTtl: string;
    }[] = [];
    const sample = (finish: string, failed = false) => {
        const total = Math.floor((window * next(121)) / 100);
        const read = next(Math.max(1, Math.floor(total / 3)));
        const write = next(Math.max(1, Math.floor(total / 5)));
        if (!failed) lastResponseTime = now;
        entry = {
            updatedAt: now,
            usage: {
                inputTokens: total,
                percentage: (total / window) * 100,
                providerUsage: {
                    model,
                    input: total - read - write,
                    cache_read: read,
                    cache_write: write,
                    output: next(20_000),
                    completed_at: now,
                    finish_reason: finish,
                },
            },
        };
    };
    for (let step = 0; step < 12; step++) {
        now += next(10_000) + 1;
        let exception: "expired" | "model_mismatch" | undefined;
        switch (step) {
            case 0:
                sample("stop");
                break;
            case 1:
                sample("tool-calls");
                break;
            case 2:
                sample("error", true);
                break;
            case 3:
                sample("unknown", true);
                break;
            case 4:
                lastResponseTime = now;
                break; // Success without new usage retains the older sample.
            case 5:
                now = entry!.updatedAt + CONTEXT_USAGE_TTL_MS;
                break;
            case 6:
                now = entry!.updatedAt + CONTEXT_USAGE_TTL_MS + next(10_000) + 1;
                exception = "expired";
                break;
            case 7:
                sample("tool-calls");
                model = other;
                exception = "model_mismatch";
                break;
            case 8:
                sample("stop");
                break;
            case 9:
                sample("stop");
                entry!.usage.providerUsage = undefined;
                break;
            case 10:
                entry = undefined;
                break;
            case 11:
                sample("tool-calls");
                break;
        }
        states.push({
            input: structuredClone({
                model,
                stepId: `${seed}-${step}`,
                now,
                entry,
                meta: { lastUsageContextLimit: window, lastResponseTime },
            }),
            midToolUse: next(3) === 0,
            exception,
            cacheTtl: next(2) ? "5m" : "never",
        });
    }
    return states;
}

test("ordinary OpenCode inputs and Rust scheduler match the accepted base over 256 randomized sequences", async () => {
    expect(baseSnapshot.source_commit).toBe("27fa9e8e77d20e6f8324b728047269fc9a797c13");
    expect(createHash("sha256").update(baseSnapshot.inputs_typescript).digest("hex")).toBe(
        "6737da86e28f3440310b200f7201086dede022cebef9b7046d9701d6832832e3",
    );
    const cases: { frame: StepInputs; now: number; mid_tool_use: boolean }[] = [];
    const states = Array.from({ length: 256 }, (_, seed) => sequence(seed + 1)).flat();
    const scheduler = createScheduler({ executeThresholdPercentage: 65 });
    let metadataDifferences = 0;
    let filtered = 0;
    for (const { input, exception, cacheTtl, midToolUse } of states) {
        const base = acceptedBase(input);
        const current = openCodeStepInputs(input);
        const projected = structuredClone(current);
        if (exception) {
            filtered++;
            expect(current.previous_usage).toBeUndefined();
            expect(current.estimate.request_tokens).toBe(0);
            projected.previous_usage = base.previous_usage;
            projected.estimate = base.estimate;
        } else if (input.entry?.usage.providerUsage) {
            const { model: _model, ...raw } = input.entry.usage.providerUsage;
            expect(current.previous_usage).toEqual(raw);
            expect(current.estimate).toEqual(base.estimate);
            expect(
                current.previous_usage!.input +
                    current.previous_usage!.cache_read +
                    current.previous_usage!.cache_write,
            ).toBe(base.previous_usage!.input);
            if (JSON.stringify(current.previous_usage) !== JSON.stringify(base.previous_usage))
                metadataDifferences++;
            projected.previous_usage = base.previous_usage;
        }
        // Fresh samples may change only previous_usage input/cache/output and
        // completion metadata. Expired or other-model samples may be omitted.
        // Every other serialized byte, including key order, must match the base.
        expect(JSON.stringify(projected)).toBe(JSON.stringify(base));
        const decision = (frame: StepInputs) =>
            scheduler.shouldExecute(
                { ...input.meta, cacheTtl } as SessionMeta,
                {
                    inputTokens: frame.estimate.request_tokens,
                    percentage:
                        (frame.estimate.request_tokens / (frame.context_window ?? 200_000)) * 100,
                },
                input.now,
                "session",
                input.model,
                frame.context_window,
            );
        if (!exception) expect(decision(current)).toBe(decision(base));
        cases.push(
            { frame: base, now: input.now, mid_tool_use: midToolUse },
            { frame: current, now: input.now, mid_tool_use: midToolUse },
        );
    }
    expect(states).toHaveLength(3072);
    expect(filtered).toBe(512);
    expect(metadataDifferences).toBeGreaterThan(2000);
    const oracle = startOracle();
    try {
        const decisions = JSON.parse(await oracle.call({ control: "input_decisions", cases }));
        expect(decisions).toHaveLength(cases.length);
        let changedDecisions = 0;
        for (let index = 0; index < states.length; index++) {
            const state = states[index];
            const before = decisions[index * 2];
            const after = decisions[index * 2 + 1];
            expect(before.input_tokens).toBe(state.input.entry?.usage.inputTokens ?? 0);
            if (state.exception) {
                expect(after.input_tokens).toBe(0);
                expect(after.outcome.pass).toBe("Defer");
                if (before.outcome.pass !== after.outcome.pass) changedDecisions++;
            } else expect(after).toEqual(before);
        }
        expect(changedDecisions).toBeGreaterThan(0);
        console.info(
            `ordinary-input differential: 256 sequences, 3072 steps, ${metadataDifferences} raw-meter byte differences, ${filtered} justified filter cases, ${changedDecisions} filter decision differences`,
        );
    } finally {
        await oracle.close();
    }
}, 1_800_000);

test("terminal usage metadata is inert through the real provider facade", async () => {
    const vectors = JSON.parse(
        readFileSync(new URL("./conformance/vectors/relay-v1.json", import.meta.url), "utf8"),
    );
    const bootstrap = vectors.cases[0].steps[0].exchanges.map(
        (exchange: { request_bytes: string }) => JSON.parse(exchange.request_bytes),
    );
    const oracle = startOracle();
    let reference: { answer: string; outcome: unknown } | undefined;
    try {
        for (const finish of ["stop", "tool-calls", "error", "unknown", "unrecognized_failure"]) {
            for (const completedAt of [0, 1, NOW]) {
                await oracle.call({ control: "reset" });
                for (const request of bootstrap) await oracle.call(request);
                await oracle.call({ control: "scheduler" });
                const request = structuredClone(bootstrap.at(-1));
                delete request.params.prefix_rebuilding;
                request.params.request_id = "terminal-metadata";
                request.params.previous_usage = {
                    input: 50_000,
                    cache_read: 15_000,
                    cache_write: 5000,
                    output: 4000,
                    completed_at: completedAt,
                    finish_reason: finish,
                };
                request.params.estimate = { request_tokens: 70_000 };
                const answer = await oracle.call(request);
                const outcome = JSON.parse(await oracle.call({ control: "scheduler" }));
                expect(outcome).toMatchObject({
                    pass: "Execute",
                    pressure_execute: true,
                    idle_ttl_fired: false,
                });
                const result = { answer, outcome };
                if (reference) expect(result).toEqual(reference);
                else reference = result;
            }
        }
    } finally {
        await oracle.close();
    }
}, 1_800_000);
