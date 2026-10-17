import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { calibrationForModelKey } from "./decision-calibration";
import { boundMarkerEnvelope, type MarkerEnvelope } from "./marker-envelope";
import {
    markerRandom,
    randomMarkerEnvelope,
    realMarkerTools as realTools,
} from "./marker-envelope-test-support";
import { estimateTokens, hasTokenizerForFit } from "./read-session-formatting";
import { UNKNOWN_FIT_RATIO } from "./tokenizer-calibration";

// Independent provider wire shapes: AI SDK LanguageModelV3 function tools,
// @ai-sdk/anthropic 3.0.82, @ai-sdk/openai-compatible 2.0.41, and the Gemini
// parametersJsonSchema countTokens request in scripts/calibrate-tokenizer/providers/gemini.ts.
export function serializeEnvelopes(material: MarkerEnvelope) {
    return {
        sdk: {
            system: material.system,
            tools: material.tools.map((tool) => ({ type: "function", ...tool })),
        },
        anthropic: {
            system: material.system.map((text) => ({
                type: "text",
                text,
                cache_control: { type: "ephemeral", ttl: "1h" },
            })),
            tools: material.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
                cache_control: { type: "ephemeral", ttl: "1h" },
                eager_input_streaming: true,
                strict: true,
            })),
        },
        openai: {
            messages: material.system.map((content) => ({ role: "system", content })),
            tools: material.tools.map((tool) => ({
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                    strict: true,
                },
            })),
        },
        google: {
            systemInstruction: { parts: material.system.map((text) => ({ text })) },
            tools: [
                {
                    functionDeclarations: material.tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        parametersJsonSchema: tool.inputSchema,
                    })),
                },
            ],
        },
    };
}

test("provider fixtures agree with the pinned AI SDK tool serializers", async () => {
    const require = createRequire(import.meta.url);
    const anthropic = await import(
        new URL(
            "../src/anthropic-prepare-tools.ts",
            pathToFileURL(require.resolve("@ai-sdk/anthropic")),
        ).href
    );
    const openai = await import(
        new URL(
            "../src/chat/openai-compatible-prepare-tools.ts",
            pathToFileURL(require.resolve("@ai-sdk/openai-compatible")),
        ).href
    );
    const material = {
        system: [],
        tools: realTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema,
        })),
    };
    const tools = material.tools.map((tool) => ({ type: "function", ...tool, strict: true }));
    const prepared = await anthropic.prepareTools({
        tools,
        supportsStrictTools: true,
        supportsStructuredOutput: false,
        defaultEagerInputStreaming: true,
    });
    expect(JSON.parse(JSON.stringify(prepared.tools))).toEqual(
        serializeEnvelopes(material).anthropic.tools.map(({ cache_control, ...tool }) => tool),
    );
    expect(openai.prepareTools({ tools }).tools).toEqual(serializeEnvelopes(material).openai.tools);
});

test("randomized envelope bound covers all provider serializers including empty arrays", () => {
    expect(hasTokenizerForFit()).toBe(true);
    const next = markerRandom();
    const models = [
        "anthropic/claude-sonnet-4-5",
        "openai/gpt-5",
        "google/gemini-2.5-pro",
        "unmeasured/future-model",
    ];
    const corpus = [
        { system: [], tools: [] },
        { system: [""], tools: [] },
        {
            system: [
                readFileSync(
                    new URL(
                        "../../../scripts/calibrate-tokenizer/fixture-system.txt",
                        import.meta.url,
                    ),
                    "utf8",
                ),
            ],
            tools: realTools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.input_schema,
            })),
        },
        ...Array.from({ length: 240 }, () => randomMarkerEnvelope(next)),
    ];
    let comparisons = 0;
    let toolDelta = 0;
    let arrayDelta = 0;
    for (const material of corpus) {
        for (const wire of Object.values(serializeEnvelopes(material))) {
            const fields =
                material.system.reduce(
                    (sum, text) => sum + estimateTokens(JSON.stringify(text)) + 32,
                    0,
                ) +
                material.tools.reduce(
                    (sum, tool) =>
                        sum +
                        estimateTokens(JSON.stringify(tool.name)) +
                        estimateTokens(JSON.stringify(tool.description)) +
                        estimateTokens(JSON.stringify(tool.inputSchema)),
                    0,
                );
            const delta = estimateTokens(JSON.stringify(wire)) - fields;
            if (material.tools.length)
                toolDelta = Math.max(toolDelta, Math.ceil((delta - 32) / material.tools.length));
            else arrayDelta = Math.max(arrayDelta, delta);
        }
        for (const model of models) {
            const calibration = calibrationForModelKey(model);
            // No recorded API counts cover these randomized schemas. Compare the
            // calibrated estimator at its largest bucket ratio, not a live endpoint.
            const ratio = calibration.seeded
                ? Math.max(calibration.systemRatio, calibration.toolsRatio, calibration.proseRatio)
                : UNKNOWN_FIT_RATIO;
            const bound = boundMarkerEnvelope(material, model)!;
            for (const [provider, wire] of Object.entries(serializeEnvelopes(material))) {
                const actual = Math.ceil(estimateTokens(JSON.stringify(wire)) * ratio);
                expect(bound, `${model} ${provider} ${comparisons}`).toBeGreaterThanOrEqual(actual);
                comparisons++;
            }
        }
    }
    console.log(
        `marker-envelope: ${corpus.length} envelopes, ${comparisons} calibrated serializer comparisons; max per-tool delta=${toolDelta}, empty-array delta=${arrayDelta}`,
    );
});
