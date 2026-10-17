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
