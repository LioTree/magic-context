import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { calibrationForModelKey, providerMass } from "./decision-calibration";
import { countTokensExactly } from "./token-count-exact";

let tokenizer: unknown;
function countMaterial(text: string): number {
    // Importing the package must not open stores, start timers or register process
    // listeners. Reuse the Claude vocabulary and exact counter, loading them only
    // when needed; importing read-session-formatting would register a logger exit listener.
    if (!tokenizer) {
        const require = createRequire(import.meta.url);
        const module = require("ai-" + "tokenizer");
        const Tokenizer = module.default ?? module.Tokenizer;
        tokenizer = new Tokenizer(require("ai-tokenizer/encoding/" + "claude"));
    }
    return countTokensExactly(tokenizer, text);
}

export interface MarkerToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

/** Complete, final host material; an explicit empty array is different from missing evidence. */
export interface MarkerEnvelope {
    system: readonly string[];
    tools: readonly MarkerToolDefinition[];
}

// Source: marker-envelope.test.ts tokenizes real and randomized AI SDK/Anthropic/
// OpenAI/Google JSON with MC's Claude tokenizer. Beyond the separately counted
// names, descriptions and schemas (and array/system reserves), the largest
// serialization cost was 32 tokens/tool; reserve 64 before applying calibration.
export const MARKER_TOOL_ALLOWANCE = 64;
// Includes the outer tools array/object and system envelope even for an empty tool set.
// Source: the same serializer sweep's empty-envelope control (max 17; reserve 32 local tokens).
export const MARKER_ARRAY_ALLOWANCE = 32;
const SYSTEM_BLOCK_ALLOWANCE = 32;

export function markerEnvelopeKey(material: MarkerEnvelope): string {
    return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/** Only marker admission uses this bound; it never rewrites the request or changes serving. */
export function boundMarkerEnvelope(material: MarkerEnvelope, model: string): number | undefined {
    try {
        if (
            !Array.isArray(material.system) ||
            !material.system.every((text) => typeof text === "string") ||
            !Array.isArray(material.tools) ||
            !material.tools.every(
                (tool) =>
                    tool &&
                    typeof tool.name === "string" &&
                    typeof tool.description === "string" &&
                    tool.inputSchema !== null &&
                    typeof tool.inputSchema === "object" &&
                    !Array.isArray(tool.inputSchema),
            )
        )
            return undefined;
        countMaterial("");
        // Count JSON strings, not unescaped text: control characters and quotes can
        // grow during provider serialization. Separate fields cannot hide array costs.
        const system = material.system.reduce(
            (sum, text) => sum + countMaterial(JSON.stringify(text)) + SYSTEM_BLOCK_ALLOWANCE,
            0,
        );
        const tools = material.tools.reduce(
            (sum, tool) =>
                sum +
                countMaterial(JSON.stringify(tool.name)) +
                countMaterial(JSON.stringify(tool.description)) +
                countMaterial(JSON.stringify(tool.inputSchema)) +
                MARKER_TOOL_ALLOWANCE,
            MARKER_ARRAY_ALLOWANCE,
        );
        const seed = calibrationForModelKey(model);
        // A provider may place system/tool fields in one shared envelope. Use the
        // largest applicable bucket ratio. For an unmeasured model providerMass
        // instead uses max(2.0, the largest ratio in the static calibration seeds).
        const ratio = Math.max(seed.systemRatio, seed.toolsRatio, seed.proseRatio);
        return providerMass(
            { system, tools },
            { ...seed, systemRatio: ratio, toolsRatio: ratio },
            true,
        );
    } catch {
        return undefined;
    }
}
