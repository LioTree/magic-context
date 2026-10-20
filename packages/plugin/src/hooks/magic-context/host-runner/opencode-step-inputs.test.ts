import { expect, test } from "bun:test";
import type { SessionMeta } from "../../../features/magic-context/types";
import { CONTEXT_USAGE_TTL_MS } from "../context-usage";
import baseSnapshot from "./fixtures/opencode-step-inputs-base.json";
import { openCodeStepInputs } from "./opencode-step-inputs";
import type { StepInputs } from "./provider-client";

type Input = Parameters<typeof openCodeStepInputs>[0];
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

test("ordinary provider inputs omit zero-total samples", () => {
    const input = freshInput();
    input.entry!.usage.inputTokens = 0;
    input.entry!.usage.providerUsage = {
        ...input.entry!.usage.providerUsage!,
        input: 0,
        cache_read: 0,
        cache_write: 0,
    };

    const frame = openCodeStepInputs(input);
    expect(frame.previous_usage).toBeUndefined();
    expect(frame.estimate.request_tokens).toBe(0);
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
