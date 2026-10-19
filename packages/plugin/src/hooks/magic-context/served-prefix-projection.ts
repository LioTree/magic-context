import { isRecord } from "../../shared/record-type-guard";
import type { PrefixProvenance } from "./served-prefix";

export const PREFIX_DIGEST_FORMAT = "provider-input-v1:";

function pick(value: Record<string, unknown>, fields: readonly string[]) {
    return Object.fromEntries(fields.map((key) => [key, value[key]]));
}

function attachments(value: unknown) {
    return Array.isArray(value)
        ? value.map((file) => (isRecord(file) ? pick(file, ["mime", "url", "filename"]) : file))
        : value;
}

function openCodePart(value: unknown, v2: boolean, role: unknown): unknown {
    if (!isRecord(value)) return value;
    const type = value.type;
    // OC1's user branch reads text/ignored and file mime/url/filename only.
    // __fixtures__/opencode-v1.18.35-to-model-messages.txt:125-160.
    if (!v2 && role === "user") {
        if (type === "text") return pick(value, ["type", "text", "ignored"]);
        if (type === "file") return pick(value, ["type", "mime", "url", "filename"]);
        return type === "compaction" || type === "subtask" ? { type } : undefined;
    }
    // OpenCode 1 forwards text/reasoning metadata as providerMetadata; step-start
    // controls splitting. OpenCode 2 forwards native content fields at commit.
    if (type === "text" || type === "reasoning")
        return pick(
            value,
            v2
                ? type === "reasoning"
                    ? ["type", "text", "encrypted", "providerMetadata"]
                    : ["type", "text", "cache"]
                : ["type", "text", "metadata"],
        );
    if (!v2 && type === "step-start") return { type };
    if (type === "tool" && isRecord(value.state)) {
        const state = value.state;
        const projected = pick(
            state,
            v2
                ? ["status", "input", "output", "error", "content"]
                : ["status", "input", "output", "error"],
        );
        // OC2 rebuilds file results from attachments when output changes;
        // OC1 sends them unless compacted. Tool input is opaque: never sort it.
        projected.attachments = attachments(state.attachments);
        if (!v2) {
            projected.compacted = isRecord(state.time) ? state.time.compacted : undefined;
            if (state.status === "error" && isRecord(state.metadata))
                projected.interrupted =
                    state.metadata.interrupted === true
                        ? { interrupted: true, output: state.metadata.output }
                        : undefined;
        }
        return {
            ...pick(value, ["type", "callID", "tool"]),
            ...(!v2 ? { metadata: value.metadata } : {}),
            state: projected,
        };
    }
    // OC2 payload.ts:600-718 forwards native content, not store part ids or
    // synthetic flags. Media and result values are opaque host converter inputs.
    if (v2) {
        if (type === "tool-call")
            return pick(value, [
                "type",
                "id",
                "name",
                "input",
                "providerExecuted",
                "providerMetadata",
            ]);
        if (type === "tool-result")
            return pick(value, [
                "type",
                "id",
                "name",
                "result",
                "providerExecuted",
                "providerMetadata",
                "cache",
            ]);
        if (type === "media")
            return pick(value, ["type", "media", "metadata", "filename", "cache"]);
        if (type === "file") return pick(value, ["type", "mime", "url"]);
        if (type === "compaction") return pick(value, ["type", "provider", "text", "encrypted"]);
        if (type === "effort") return pick(value, ["type", "effort", "previous"]);
    }
    return undefined;
}

function piPart(value: unknown): unknown {
    if (!isRecord(value)) return value;
    // pi-ai transform-messages.js:66-122 and anthropic-messages.js:838-947.
    // Signatures and tool arguments affect replay; timestamps/details never do.
    switch (value.type) {
        case "text":
            return pick(value, ["type", "text"]);
        case "thinking":
            return pick(value, ["type", "thinking", "thinkingSignature", "redacted"]);
        case "image":
            return pick(value, ["type", "data", "mimeType"]);
        case "toolCall":
            return pick(value, ["type", "id", "name", "arguments"]);
        default:
            return undefined;
    }
}

/**
 * Hash inputs to the pinned host converters, not the mutable host envelope.
 * Fixed projection key order ignores host property insertion order; opaque tool
 * arguments/provider values retain their order because the converter sends it.
 * Converter identity and current model bind the interpretation of those inputs.
 * OpenCode 2 also restores original call/result fields in payload.commit().
 * Those separate fields never reached this digest, even before projection.
 * They are frozen by provider-record replay, but remain unfenced in TS mode.
 */
export function servedPrefixProjection(message: unknown, provenance: PrefixProvenance): unknown {
    if (!isRecord(message)) throw new Error("Cannot project an absent served message");
    const pi = provenance.host === "pi";
    const v2 = provenance.host === "opencode-v2";
    const info = isRecord(message.info) ? message.info : {};
    const role = pi ? message.role : info.role;
    return {
        converter: pi
            ? "pi-ai-0.83.0-anthropic"
            : v2
              ? "opencode2-payload-2.0.22"
              : "opencode1-1.18.35",
        model: provenance.model,
        role,
        // These assistant fields select same-model reasoning replay or error omission.
        replay:
            role === "assistant"
                ? pi
                    ? pick(message, ["provider", "api", "model", "stopReason"])
                    : !v2
                      ? {
                            ...pick(info, ["providerID", "modelID"]),
                            error: isRecord(info.error) ? info.error.name : undefined,
                        }
                      : undefined
                : undefined,
        // Pi tool results can load deferred tool references (anthropic-messages.js:810-835).
        result:
            pi && role === "toolResult"
                ? pick(message, ["toolCallId", "isError", "addedToolNames"])
                : undefined,
        content:
            pi && provenance.model?.api === "pi-messages"
                ? message
                : pi
                  ? Array.isArray(message.content)
                      ? message.content.map(piPart).filter((part) => part !== undefined)
                      : message.content
                  : Array.isArray(message.parts)
                    ? message.parts
                          .map((part) => openCodePart(part, v2, role))
                          .filter((part) => part !== undefined)
                    : undefined,
    };
}
