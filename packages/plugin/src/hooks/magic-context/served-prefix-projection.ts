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

// OpenCode 2 forwards these native content parts to its provider converter
// unchanged apart from the `synthetic` flag (v2/hooks/payload.ts commit(), the
// `const { synthetic, ...clean } = part` branch). The fields are the part schemas
// of @opencode/ai 2.0.22 (dist/schema/messages.d.ts): its protocols read
// `metadata` too, for example Anthropic citations and file ids
// (dist/protocols/anthropic-messages.js:509-607), so it is provider-visible.
const OC2_NATIVE_PART_FIELDS: Readonly<Record<string, readonly string[]>> = {
    text: ["type", "text", "cache", "metadata", "providerMetadata"],
    reasoning: ["type", "text", "encrypted", "cache", "metadata", "providerMetadata"],
    media: ["type", "media", "filename", "cache", "metadata", "providerMetadata"],
    "tool-call": [
        "type",
        "id",
        "name",
        "namespace",
        "input",
        "providerExecuted",
        "cache",
        "metadata",
        "providerMetadata",
    ],
    "tool-result": [
        "type",
        "id",
        "name",
        "namespace",
        "result",
        "providerExecuted",
        "cache",
        "metadata",
        "providerMetadata",
    ],
    compaction: ["type", "provider", "id", "text", "encrypted"],
    effort: ["type", "effort", "previous"],
};

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
    // OpenCode 1 forwards text/reasoning metadata as providerMetadata
    // (fixture lines 199-205 and 286-298); step-start controls message splitting.
    if (!v2 && (type === "text" || type === "reasoning"))
        return pick(value, ["type", "text", "metadata"]);
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
    if (v2) {
        const fields = typeof type === "string" ? OC2_NATIVE_PART_FIELDS[type] : undefined;
        if (fields) return pick(value, fields);
        // commit() turns a store file part into media from its mime type and URL.
        if (type === "file") return pick(value, ["type", "mime", "url"]);
    }
    // Every other part type is dropped by the host converter (OpenCode 1) or
    // rejected by commit() (OpenCode 2), so it never reaches the provider.
    return undefined;
}

// Union of the content fields read by the supported pi-ai converters (0.83-0.87:
// transform-messages.js, anthropic-messages.js, google-shared.js,
// openai-responses-shared.js). It is a superset of the pi-plugin view in
// provider-visible-parts-pi.ts, which a parity test checks. Signatures and tool
// arguments affect replay; timestamps and UI details never reach a provider.
const PI_PART_FIELDS: Readonly<Record<string, readonly string[]>> = {
    text: ["type", "text", "textSignature"],
    thinking: ["type", "thinking", "thinkingSignature", "redacted"],
    image: ["type", "data", "mimeType"],
    toolCall: ["type", "id", "name", "arguments", "thoughtSignature", "namespace"],
};

function piPart(value: unknown): unknown {
    if (!isRecord(value)) return value;
    const fields = typeof value.type === "string" ? PI_PART_FIELDS[value.type] : undefined;
    // A content type this list does not know may be read by a newer converter,
    // so it is digested whole: an unknown part can only cause a refusal, never
    // let a provider-visible change through.
    return fields ? pick(value, fields) : value;
}

// Message-level fields read by the same pi-ai converters as PI_PART_FIELDS
// (@earendil-works/pi-ai 0.83 through 0.87). On assistant messages,
// provider/api/model/stopReason decide whether a signature is replayed (same
// model) or an errored turn is omitted. On tool results, toolCallId/toolName/
// isError link the result to its call and addedToolNames loads deferred tools
// (0.83 anthropic-messages.js:810-835). pi-ai 0.87 also reads the assistant's
// providerThinkingLevel and a system message's sections/toolsAdded/toolsRemoved.
const PI_MESSAGE_FIELDS = [
    "role",
    "provider",
    "api",
    "model",
    "stopReason",
    "toolCallId",
    "toolName",
    "isError",
    "addedToolNames",
    "providerThinkingLevel",
    "sections",
    "toolsAdded",
    "toolsRemoved",
] as const;

/**
 * The part of a served message that the host's converter reads, i.e. what the
 * provider is sent for it; host-only envelope fields (OpenCode `info.summary`,
 * Pi timestamps) are left out. The projection emits its own fixed key order,
 * because the converters build new objects and the host's property order never
 * reaches the provider. Opaque values the converter passes through (tool
 * arguments, provider metadata) keep their own key order, because that order
 * does reach the provider. The converter label and the request model are part
 * of the projection because they decide how these inputs become provider bytes.
 *
 * Not covered: OpenCode 2's commit() (v2/hooks/payload.ts) also copies tool-call
 * and tool-result fields such as providerExecuted from the host's original
 * draft, which the transformed message never carries. Saved provider requests
 * replay those fields unchanged, but this digest cannot detect a change to them.
 */
export function servedPrefixProjection(message: unknown, provenance: PrefixProvenance): unknown {
    if (!isRecord(message)) throw new Error("Cannot project an absent served message");
    const pi = provenance.host === "pi";
    const v2 = provenance.host === "opencode-v2";
    const info = isRecord(message.info) ? message.info : {};
    const role = pi ? message.role : info.role;
    return {
        converter: pi ? "pi-ai-0.83-0.87" : v2 ? "opencode2-payload-2.0.22" : "opencode1-1.18.35",
        model: provenance.model,
        role,
        // OpenCode 1 reads these assistant fields to select same-model reasoning
        // replay and to omit errored turns.
        replay:
            !pi && !v2 && role === "assistant"
                ? {
                      ...pick(info, ["providerID", "modelID"]),
                      error: isRecord(info.error) ? info.error.name : undefined,
                  }
                : undefined,
        message: pi ? pick(message, PI_MESSAGE_FIELDS) : undefined,
        content:
            pi && provenance.model?.api === "pi-messages"
                ? // The native pi-messages API sends the raw message, so every
                  // field of it is provider-visible.
                  message
                : pi
                  ? Array.isArray(message.content)
                      ? message.content.map(piPart)
                      : message.content
                  : Array.isArray(message.parts)
                    ? message.parts
                          .map((part) => openCodePart(part, v2, role))
                          .filter((part) => part !== undefined)
                    : undefined,
    };
}
