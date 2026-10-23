import { readFileSync } from "node:fs";
import type { MarkerEnvelope } from "./marker-envelope";

export const realMarkerTools = JSON.parse(
    readFileSync(
        new URL("../../../scripts/calibrate-tokenizer/fixture-tools.json", import.meta.url),
        "utf8",
    ),
) as {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}[];

export function markerRandom(seed = 0x50cafe) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
}

export function randomMarkerEnvelope(next: () => number): MarkerEnvelope {
    const texts = [
        "",
        "Read a file.\nKeep bytes unchanged.",
        "日本語 café 😀",
        'quoted " schema \\ \u0000',
        '<EOT> {"a":true}',
    ];
    return {
        system: Array.from({ length: Math.floor(next() * 5) }, () =>
            texts[Math.floor(next() * texts.length)].repeat(Math.floor(next() * 8)),
        ),
        tools: Array.from({ length: Math.floor(next() * 12) }, (_, i) => {
            const tool = realMarkerTools[Math.floor(next() * realMarkerTools.length)];
            return {
                name: `${tool.name}_${i}`,
                description: tool.description + texts[Math.floor(next() * texts.length)],
                inputSchema: {
                    ...tool.input_schema,
                    properties: {
                        ...(tool.input_schema.properties as object),
                        [`field_${i}`]: {
                            type: "string",
                            description: texts[Math.floor(next() * texts.length)],
                            enum: texts,
                        },
                    },
                },
            };
        }),
    };
}

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
