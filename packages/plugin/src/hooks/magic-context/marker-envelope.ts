import { createHash } from "node:crypto";
import { calibrationForModelKey, providerMass } from "./decision-calibration";
import { countTokensExactly } from "./token-count-exact";
import { UNKNOWN_FIT_RATIO, UNKNOWN_LOWER_RATIO } from "./tokenizer-calibration";
import { loadTokenizerSync, type TokenizerLike } from "./tokenizer-loader";
import type { MessageLike } from "./transform-operations";
import { serializedWireText, visitWireContent } from "./wire-content";

let tokenizer: TokenizerLike | undefined;
let byteBoundWarningSent = false;

function warnByteBound(error: unknown): void {
    if (byteBoundWarningSent) return;
    byteBoundWarningSent = true;
    // Import the logger only after counting needs a fallback; importing the
    // public host-runner package must not register the logger's exit listener.
    void import("../../shared/logger")
        .then(({ log }) =>
            log(
                "[magic-context] ai-tokenizer unavailable for marker admission; using a conservative approximate UTF-8 byte bound:",
                error instanceof Error ? error.message : String(error),
            ),
        )
        .catch(() => {});
}

/** When the tokenizer is unavailable, `bytes` counts UTF-8 bytes (an upper bound on
 * tokens) and `zero` counts nothing (the only safe lower bound, used for message
 * text that is subtracted from provider usage). */
function materialCounter(fallback: "bytes" | "zero" = "bytes"): (text: string) => number {
    let active = tokenizer;
    try {
        active ??= tokenizer = loadTokenizerSync();
    } catch (error) {
        warnByteBound(error);
    }
    return (text) => {
        if (active) {
            try {
                return countTokensExactly(active, text);
            } catch (error) {
                active = tokenizer = undefined;
                warnByteBound(error);
            }
        }
        // These inputs are JSON-stringified fields. Each Claude byte-pair token
        // consumes at least one UTF-8 byte, so their byte lengths bound the local
        // count even for escaped/non-ASCII text, before applying model ratios.
        return fallback === "bytes" ? Buffer.byteLength(text, "utf8") : 0;
    };
}

export interface MarkerToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

/** Complete, final host material; an explicit empty array is different from missing evidence. */
export interface MarkerEnvelope {
    /** Exact final system strings, in order. */
    system: readonly string[];
    /** Tools whose final name/description/JSON input schema the host can see exactly. */
    tools: readonly MarkerToolDefinition[];
    /**
     * Names of the other sent tools, whose final schema the host cannot see (for
     * example OpenCode built-ins whose JSON schema is generated after the plugin
     * hook, or MCP tools that bypass it). Their size is bounded only through a
     * qualifying provider usage reading. Absent means every sent tool is in `tools`.
     */
    unobserved_tools?: readonly string[];
}

/** What a provider usage reading must share with a later request before its envelope bound applies. */
export interface MarkerEnvelopeIdentity {
    /** Sorted names of every sent tool, visible and unobserved. */
    tool_names: string[];
    /** SHA-256 of the JSON array of exact final system strings. */
    system_digest: string;
    /** SHA-256 of the JSON array of visible tool definitions, as sent. */
    visible_tools_digest: string;
}

/**
 * Upper bound on a request's system/tool envelope, derived from one completed
 * request Magic Context served: provider input usage (uncached + cache read +
 * cache write) minus a lower bound on that request's message tokens. All values
 * are provider tokens.
 */
export interface MarkerEnvelopeReading extends MarkerEnvelopeIdentity {
    total_input: number;
    messages_lower: number;
    envelope_upper: number;
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

function validMarkerEnvelope(material: MarkerEnvelope): boolean {
    if (
        !material ||
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
        return false;
    const unobserved = material.unobserved_tools;
    if (unobserved === undefined) return true;
    if (
        !Array.isArray(unobserved) ||
        !unobserved.every((name) => typeof name === "string" && name.length > 0)
    )
        return false;
    // A name listed both ways, or twice, makes the sent tool set ambiguous.
    return (
        new Set(unobserved).size === unobserved.length &&
        material.tools.every((tool) => !unobserved.includes(tool.name))
    );
}

export function markerEnvelopeIdentity(
    material: MarkerEnvelope,
): MarkerEnvelopeIdentity | undefined {
    try {
        if (!validMarkerEnvelope(material)) return undefined;
        const digest = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");
        return {
            tool_names: [
                ...material.tools.map((tool) => tool.name),
                ...(material.unobserved_tools ?? []),
            ].sort(),
            system_digest: digest(material.system),
            visible_tools_digest: digest(material.tools),
        };
    } catch {
        return undefined;
    }
}

/** Whether some sent tool can be bounded only through a provider usage reading. */
export function hasUnobservedTools(material: MarkerEnvelope): boolean {
    return (material.unobserved_tools?.length ?? 0) > 0;
}

/**
 * The smallest and largest static calibration ratio (provider tokens per local
 * Claude token) that `tokenizer-calibration.ts` seeds give this model across its
 * system, tools and prose buckets. Unmeasured models use UNKNOWN_LOWER_RATIO and
 * UNKNOWN_FIT_RATIO, the same fallbacks fit checks use.
 */
export function markerRatioRange(model: string): { lower: number; upper: number } {
    const seed = calibrationForModelKey(model);
    if (!seed.seeded) return { lower: UNKNOWN_LOWER_RATIO, upper: UNKNOWN_FIT_RATIO };
    const ratios = [seed.systemRatio, seed.toolsRatio, seed.proseRatio];
    return { lower: Math.min(...ratios), upper: Math.max(...ratios) };
}

/** Only marker admission uses this bound; it never rewrites the request or changes serving.
 * It covers the system strings and visible tools; unobserved tools are not included. */
export function boundMarkerEnvelope(material: MarkerEnvelope, model: string): number | undefined {
    try {
        if (!validMarkerEnvelope(material)) return undefined;
        const countMaterial = materialCounter();
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

// Wrapper allowances for message rows, in local tokens, on top of the JSON-escaped
// UTF-8 bytes of every sent field. Source: marker-usage-bound.test.ts serializes
// randomized OpenCode histories through OpenCode 1.18.35's own toModelMessages and
// into AI SDK, Anthropic, OpenAI-compatible and Gemini wire forms; see the
// measured maxima it prints. Tool call ids and names are counted separately.
export const MARKER_MESSAGE_ALLOWANCE = 32;
export const MARKER_PART_ALLOWANCE = 64;

const TOOL_IDENTITY_FIELDS = ["callID", "callId", "toolCallId", "tool", "toolName"] as const;

/**
 * Upper bound on the provider tokens of a request's message rows, at the model's
 * largest calibration ratio. Every sent field counts its JSON-escaped UTF-8 bytes
 * (each local token holds at least one byte), plus fixed per-message and per-part
 * wrapper allowances, plus tool call ids and names twice (call and result).
 * Callers separately require countable parts; this does not prove that.
 */
export function boundMarkerMessages(messages: readonly MessageLike[], model: string): number {
    let local = 0;
    for (const message of messages) {
        local += MARKER_MESSAGE_ALLOWANCE;
        for (const part of message.parts) {
            local += MARKER_PART_ALLOWANCE;
            if (!part || typeof part !== "object") continue;
            const fields = part as unknown as Record<string, unknown>;
            for (const field of TOOL_IDENTITY_FIELDS) {
                const value = fields[field];
                if (typeof value === "string")
                    local += 2 * Buffer.byteLength(JSON.stringify(value), "utf8");
            }
        }
        visitWireContent(message, {
            text: (_bucket, value) => {
                local += Buffer.byteLength(JSON.stringify(serializedWireText(value)), "utf8");
            },
            image: (_bucket, tokens) => {
                local += tokens;
            },
        });
    }
    const total = local * markerRatioRange(model).upper;
    return Number.isFinite(total) ? Math.ceil(total) : Number.POSITIVE_INFINITY;
}

/**
 * The text of one served message that its host certainly sends to the provider
 * unchanged. Each host drops or rewrites different messages before the provider
 * sees them, so each host supplies its own. Returning less text is always safe;
 * returning text the host drops or rewrites makes the subtracted message bound too
 * large, and the envelope bound derived from usage could then under-count.
 */
export type MarkerSentText = (message: MessageLike) => readonly string[];

/**
 * OpenCode 1: non-ignored text parts of user messages and of assistant messages
 * without an error (OpenCode drops most errored assistant turns).
 */
export const openCodeSentText: MarkerSentText = (message) => {
    const info = message.info as { role?: unknown; error?: unknown };
    if (info.role !== "user" && (info.role !== "assistant" || info.error)) return [];
    const texts: string[] = [];
    for (const part of message.parts) {
        const p = part as { type?: unknown; text?: unknown; ignored?: unknown };
        if (p?.type !== "text" || p.ignored || typeof p.text !== "string") continue;
        texts.push(p.text);
    }
    return texts;
};

/**
 * Lower bound on the provider tokens of a served request's message rows, at the
 * model's smallest calibration ratio. Only text the host certainly sends is
 * counted, as chosen by `sentText` (OpenCode 1's rule by default). Tool calls and
 * results (outputs may be cleared or truncated), reasoning (providers may strip
 * earlier thinking) and every wrapper count zero. Leading and trailing whitespace
 * is not counted, since a provider adapter may trim it. If the local tokenizer is
 * unavailable the bound is 0.
 */
export function lowerBoundMarkerMessages(
    messages: readonly MessageLike[],
    model: string,
    sentText: MarkerSentText = openCodeSentText,
): number {
    const count = materialCounter("zero");
    let local = 0;
    for (const message of messages) {
        for (const raw of sentText(message)) {
            const text = raw.trim();
            if (text) local += count(text);
        }
    }
    const total = local * markerRatioRange(model).lower;
    return Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0;
}

/**
 * Derive an envelope reading from a completed request Magic Context served:
 * envelope_upper = total input − messages_lower(served messages). Returns
 * undefined when the material is invalid or the subtraction leaves nothing.
 * `sentText` picks the message text the host certainly sends; see MarkerSentText.
 */
export function deriveMarkerEnvelopeReading(args: {
    material: MarkerEnvelope;
    messages: readonly MessageLike[];
    totalInput: number;
    model: string;
    sentText?: MarkerSentText;
}): MarkerEnvelopeReading | undefined {
    const identity = markerEnvelopeIdentity(args.material);
    if (!identity || !Number.isSafeInteger(args.totalInput) || args.totalInput <= 0)
        return undefined;
    const messagesLower = lowerBoundMarkerMessages(args.messages, args.model, args.sentText);
    const envelopeUpper = args.totalInput - messagesLower;
    if (!Number.isSafeInteger(messagesLower) || envelopeUpper <= 0) return undefined;
    return {
        ...identity,
        total_input: args.totalInput,
        messages_lower: messagesLower,
        envelope_upper: envelopeUpper,
    };
}

/**
 * The envelope bound from a reading taken with the same model, the same sorted
 * set of sent tool names, the same system digest and the same visible tool
 * definitions as `material`; undefined when any of them differs.
 */
export function qualifyingMarkerEnvelopeUpper(
    reading: { model: string; envelope_reading?: MarkerEnvelopeReading } | undefined,
    material: MarkerEnvelope,
    model: string,
): number | undefined {
    const held = reading?.envelope_reading;
    const identity = markerEnvelopeIdentity(material);
    if (!held || !identity || reading.model !== model) return undefined;
    if (
        !Array.isArray(held.tool_names) ||
        held.tool_names.length !== identity.tool_names.length ||
        held.tool_names.some((name, index) => name !== identity.tool_names[index])
    )
        return undefined;
    if (held.system_digest !== identity.system_digest) return undefined;
    if (held.visible_tools_digest !== identity.visible_tools_digest) return undefined;
    if (
        !Number.isSafeInteger(held.envelope_upper) ||
        held.envelope_upper <= 0 ||
        held.envelope_upper !== held.total_input - held.messages_lower
    )
        return undefined;
    return held.envelope_upper;
}
