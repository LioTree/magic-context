import { expect, test } from "bun:test";
import {
    boundMarkerEnvelope,
    boundMarkerMessages,
    deriveMarkerEnvelopeReading,
    MARKER_MESSAGE_ALLOWANCE,
    MARKER_PART_ALLOWANCE,
    type MarkerEnvelope,
    markerRatioRange,
    qualifyingMarkerEnvelopeUpper,
} from "./marker-envelope";
import {
    markerRandom,
    randomMarkerEnvelope,
    serializeEnvelopes,
} from "./marker-envelope-test-support";
import { type ModelMessage, opencode1ToModelMessages } from "./opencode1-to-model-messages.fixture";
import { estimateTokens, hasTokenizerForFit } from "./read-session-formatting";
import type { MessageLike } from "./transform-operations";

type Part = { type: string; [key: string]: unknown };

/** Provider message wire forms for AI SDK model messages, matching serializeEnvelopes' four shapes. */
function serializeMessages(messages: readonly ModelMessage[]) {
    const parts = (message: ModelMessage): Part[] =>
        typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : (message.content as Part[]);
    const resultText = (part: Part) => {
        const output = part.output as { type: string; value: unknown };
        return typeof output.value === "string" ? output.value : JSON.stringify(output.value);
    };
    return {
        sdk: messages,
        anthropic: messages.map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: parts(message).map((part) => {
                switch (part.type) {
                    case "reasoning":
                        return { type: "thinking", thinking: part.text, signature: "" };
                    case "tool-call":
                        return {
                            type: "tool_use",
                            id: part.toolCallId,
                            name: part.toolName,
                            input: part.input,
                        };
                    case "tool-result":
                        return {
                            type: "tool_result",
                            tool_use_id: part.toolCallId,
                            content: [{ type: "text", text: resultText(part) }],
                            is_error: (part.output as { type: string }).type.startsWith("error"),
                        };
                    default:
                        return { type: "text", text: part.text };
                }
            }),
        })),
        openai: messages.flatMap((message) => {
            const content = parts(message);
            if (message.role === "tool")
                return content.map((part) => ({
                    role: "tool",
                    tool_call_id: part.toolCallId,
                    content: resultText(part),
                }));
            const text = content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
            const calls = content.filter((part) => part.type === "tool-call");
            return [
                {
                    role: message.role,
                    content: text,
                    ...(calls.length
                        ? {
                              tool_calls: calls.map((part) => ({
                                  id: part.toolCallId,
                                  type: "function",
                                  function: {
                                      name: part.toolName,
                                      arguments: JSON.stringify(part.input),
                                  },
                              })),
                          }
                        : {}),
                },
            ];
        }),
        google: messages.map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: parts(message).map((part) => {
                switch (part.type) {
                    case "reasoning":
                        return { text: part.text, thought: true };
                    case "tool-call":
                        return { functionCall: { name: part.toolName, args: part.input } };
                    case "tool-result":
                        return {
                            functionResponse: {
                                name: part.toolName,
                                response: { name: part.toolName, content: resultText(part) },
                            },
                        };
                    default:
                        return { text: part.text };
                }
            }),
        })),
    };
}

/** One complete provider request body per wire form: envelope plus messages. */
function serializeRequests(material: MarkerEnvelope, messages: readonly ModelMessage[]) {
    const envelope = serializeEnvelopes(material);
    const rows = serializeMessages(messages);
    return {
        sdk: { ...envelope.sdk, messages: rows.sdk },
        anthropic: { ...envelope.anthropic, messages: rows.anthropic },
        openai: { ...envelope.openai, messages: [...envelope.openai.messages, ...rows.openai] },
        google: { ...envelope.google, contents: rows.google },
    };
}

const texts = [
    "",
    "ok",
    "   ",
    "Read a file.\nKeep bytes unchanged.",
    "日本語 café 😀",
    'quoted " schema \\ \u0000',
    '<EOT> {"a":true}',
    "The quick brown fox jumps over the lazy dog. ".repeat(40),
    'fn main() {\n    println!("hello");\n}\n'.repeat(12),
];

/** Random OpenCode 1 session rows: user/assistant text, reasoning, tool calls and errors. */
function randomHistory(next: () => number, length: number, salt: string): MessageLike[] {
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
    const text = () => pick(texts).repeat(1 + Math.floor(next() * 4));
    return Array.from({ length }, (_, index) => {
        const id = `msg_${salt}_${index}`;
        if (index % 2 === 0)
            return {
                info: { id, role: "user", sessionID: "session", time: { created: index } },
                parts: Array.from({ length: 1 + Math.floor(next() * 2) }, (_, n) => ({
                    id: `${id}_p${n}`,
                    type: "text",
                    text: text(),
                    ...(next() < 0.2 ? { synthetic: true } : {}),
                })),
            } as MessageLike;
        const parts: Part[] = [{ type: "step-start", id: `${id}_s` }];
        for (let n = 0; n < 1 + Math.floor(next() * 4); n++) {
            const roll = next();
            if (roll < 0.35) parts.push({ id: `${id}_t${n}`, type: "text", text: text() });
            else if (roll < 0.5)
                parts.push({ id: `${id}_r${n}`, type: "reasoning", text: text(), time: {} });
            else {
                const callID = `toolu_${salt}_${index}_${n}_${Math.floor(next() * 1e9).toString(36)}`;
                const input = { path: text(), offset: Math.floor(next() * 1000), flags: [text()] };
                const failed = next() < 0.2;
                parts.push({
                    id: `${id}_c${n}`,
                    type: "tool",
                    tool: pick(["read", "bash", "ctx_search", "task", "edit"]),
                    callID,
                    state: failed
                        ? { status: "error", input, error: text(), time: { start: 1, end: 2 } }
                        : {
                              status: "completed",
                              input,
                              output: text(),
                              title: "",
                              metadata: {},
                              time: { start: 1, end: 2 },
                          },
                });
            }
        }
        return {
            info: {
                id,
                role: "assistant",
                sessionID: "session",
                providerID: "anthropic",
                modelID: "claude-sonnet-4-5",
                time: { created: index },
            },
            parts,
        } as MessageLike;
    });
}

const models = [
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5",
    "xai/grok-4",
    "google/gemini-2.5-pro",
    "unmeasured/future-model",
];

function splitEnvelope(material: MarkerEnvelope, next: () => number): MarkerEnvelope {
    const hidden = material.tools.filter(() => next() < 0.6);
    return {
        system: material.system,
        tools: material.tools.filter((tool) => !hidden.includes(tool)),
        unobserved_tools: hidden.map((tool) => tool.name),
    };
}

test("usage-derived post-cut bound covers every serializer with unobserved tool schemas", async () => {
    expect(hasTokenizerForFit()).toBe(true);
    const next = markerRandom(0x5eed);
    const wireModel = {
        providerID: "anthropic",
        id: "claude-sonnet-4-5",
        api: { npm: "@ai-sdk/anthropic", id: "claude-sonnet-4-5" },
    };
    let comparisons = 0;
    let wrapperPerRow = 0;
    let tightest = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 90; round++) {
        const full = randomMarkerEnvelope(next);
        const observed = splitEnvelope(full, next);
        // Long served histories followed by short post-cut views are where an
        // over-subtracted message lower bound would show; mix in the reverse too.
        const prev = randomHistory(
            next,
            Math.floor(next() * (round % 3 === 0 ? 8 : 40)),
            `p${round}`,
        );
        const post = randomHistory(
            next,
            Math.floor(next() * (round % 3 === 0 ? 40 : 6)),
            `c${round}`,
        );
        const prevWire = serializeRequests(full, await opencode1ToModelMessages(prev, wireModel));
        const postModel = await opencode1ToModelMessages(post, wireModel);
        const postWire = serializeRequests(full, postModel);
        const postRows = serializeMessages(postModel);
        // Wrapper cost measured against the field bytes alone (ratio 1.0 model).
        const fieldsOnly =
            boundMarkerMessages(post, "openai/gpt-5") -
            post.reduce(
                (sum, row) =>
                    sum + MARKER_MESSAGE_ALLOWANCE + row.parts.length * MARKER_PART_ALLOWANCE,
                0,
            );
        const rows = post.length + post.reduce((sum, row) => sum + row.parts.length, 0);
        for (const wire of Object.values(postRows)) {
            if (rows)
                wrapperPerRow = Math.max(
                    wrapperPerRow,
                    (estimateTokens(JSON.stringify(wire)) - fieldsOnly) / rows,
                );
        }
        for (const provider of Object.keys(prevWire) as (keyof typeof prevWire)[]) {
            const prevLocal = estimateTokens(JSON.stringify(prevWire[provider]));
            const postLocal = estimateTokens(JSON.stringify(postWire[provider]));
            for (const model of models) {
                const { lower, upper } = markerRatioRange(model);
                // No live endpoint: the provider's count is modeled as the local count
                // at any ratio inside the model's calibrated range, both ends included.
                for (const ratio of [lower, (lower + upper) / 2, upper]) {
                    const reading = deriveMarkerEnvelopeReading({
                        material: observed,
                        messages: prev,
                        totalInput: Math.ceil(prevLocal * ratio),
                        model,
                    });
                    expect(reading, `${model} ${provider} ${round}`).toBeDefined();
                    const derived = qualifyingMarkerEnvelopeUpper(
                        { model, envelope_reading: reading },
                        observed,
                        model,
                    );
                    const bound =
                        Math.max(derived!, boundMarkerEnvelope(observed, model)!) +
                        boundMarkerMessages(post, model);
                    const actual = Math.ceil(postLocal * ratio);
                    expect(
                        bound,
                        `${model} ${provider} round ${round} ratio ${ratio}`,
                    ).toBeGreaterThanOrEqual(actual);
                    // Identical empty histories make bound === actual by construction.
                    if (post.length) tightest = Math.min(tightest, bound / actual);
                    comparisons++;
                }
            }
        }
    }
    console.log(
        `marker-usage-bound: ${comparisons} comparisons; max wrapper tokens per message/part=${wrapperPerRow.toFixed(2)}; tightest bound/actual with a non-empty post-cut view=${tightest.toFixed(4)}`,
    );
});
