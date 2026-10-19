import { expect, it } from "bun:test";
import { adaptPayload } from "../../v2/hooks/payload";
import type { SessionContext } from "../../v2/hooks/types";
import { firstKeptDigest, type PrefixProvenance } from "./served-prefix";

const model = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" };
const provenance = (host: PrefixProvenance["host"]): PrefixProvenance => ({
    host,
    id_space: host,
    generation: host,
    projection: "messages",
    model,
});

function changed(message: unknown, path: string) {
    const copy = structuredClone(message) as Record<string, any>;
    const keys = path.split(".");
    let parent = copy;
    for (const key of keys.slice(0, -1)) parent = parent[key];
    const key = keys.at(-1)!;
    parent[key] = typeof parent[key] === "boolean" ? !parent[key] : `${parent[key]}-changed`;
    return copy;
}

// The cases list converter inputs independently of the implementation's allowlist.
// A newly read field must have a perturbation case, not just a matching hash oracle.
function perturb(host: PrefixProvenance["host"], message: unknown, paths: string[]) {
    for (const path of paths)
        it(`${host} converter input ${path} changes first-kept identity`, () => {
            const p = provenance(host);
            expect(firstKeptDigest(changed(message, path), p)).not.toBe(
                firstKeptDigest(message, p),
            );
        });
}

for (const host of ["opencode-v1", "opencode-v2"] as const) {
    const v2 = host === "opencode-v2";
    const user = {
        info: { role: "user" },
        parts: [{ type: "text", text: "Task", ignored: false }],
    };
    perturb(host, user, [
        "info.role",
        "parts.0.type",
        "parts.0.text",
        ...(!v2 ? ["parts.0.ignored"] : []),
    ]);
    const assistant = {
        info: {
            role: "assistant",
            providerID: "anthropic",
            modelID: "opus",
            error: { name: "MessageAbortedError" },
        },
        parts: [
            {
                type: "text",
                text: "Answer",
                metadata: { anthropic: { cacheControl: "ephemeral" } },
                cache: "ephemeral",
            },
            {
                type: "reasoning",
                text: "Thought",
                metadata: { anthropic: { signature: "sig" } },
                encrypted: "sig",
                providerMetadata: { anthropic: { signature: "sig" } },
            },
            {
                type: "tool",
                callID: "call",
                tool: "bash",
                metadata: { anthropic: { caller: "direct" } },
                state: {
                    status: "error",
                    input: { command: "pwd" },
                    output: "output",
                    error: "error",
                    content: "content",
                    time: { compacted: 1 },
                    metadata: { interrupted: true, output: "partial" },
                    attachments: [
                        { mime: "image/png", url: "data:image/png;base64,AA==", filename: "a.png" },
                    ],
                },
            },
        ],
    };
    perturb(host, assistant, [
        "parts.0.text",
        "parts.1.text",
        "parts.2.type",
        "parts.2.callID",
        "parts.2.tool",
        "parts.2.state.status",
        "parts.2.state.input.command",
        "parts.2.state.output",
        "parts.2.state.error",
        "parts.2.state.attachments.0.mime",
        "parts.2.state.attachments.0.url",
        "parts.2.state.attachments.0.filename",
        ...(v2
            ? [
                  "parts.0.cache",
                  "parts.1.encrypted",
                  "parts.1.providerMetadata.anthropic.signature",
                  "parts.2.state.content",
              ]
            : [
                  "info.providerID",
                  "info.modelID",
                  "info.error.name",
                  "parts.0.metadata.anthropic.cacheControl",
                  "parts.1.metadata.anthropic.signature",
                  "parts.2.metadata.anthropic.caller",
                  "parts.2.state.time.compacted",
                  "parts.2.state.metadata.interrupted",
                  "parts.2.state.metadata.output",
              ]),
    ]);
    const file = {
        info: { role: "user" },
        parts: [
            {
                type: "file",
                mime: "image/png",
                url: "data:image/png;base64,AA==",
                filename: "a.png",
            },
        ],
    };
    perturb(host, file, ["parts.0.mime", "parts.0.url", ...(!v2 ? ["parts.0.filename"] : [])]);
    it(`${host} host-only envelope and property order do not change first-kept identity`, () => {
        const a = {
            info: { role: "user", summary: { diffs: [] }, id: "u", time: { created: 1 } },
            parts: [{ id: "p", type: "text", text: "Task", synthetic: true }],
        };
        const b = {
            parts: [{ text: "Task", type: "text", id: "other", synthetic: false }],
            info: { time: { created: 2 }, id: "other", summary: { diffs: [1] }, role: "user" },
        };
        expect(firstKeptDigest(a, provenance(host))).toBe(firstKeptDigest(b, provenance(host)));
    });
}

perturb(
    "opencode-v2",
    {
        info: { role: "assistant" },
        parts: [
            {
                type: "tool-call",
                id: "call",
                name: "bash",
                input: { x: 1 },
                providerExecuted: true,
                providerMetadata: { anthropic: { a: "b" } },
            },
            {
                type: "tool-result",
                id: "call",
                name: "bash",
                result: { type: "text", value: "result" },
                providerExecuted: true,
                providerMetadata: { anthropic: { result: "value" } },
                cache: "ephemeral",
            },
            {
                type: "media",
                media: { mediaType: "image/png", data: "AA==" },
                metadata: { title: "title" },
                filename: "image.png",
                cache: "ephemeral",
            },
            { type: "compaction", provider: "anthropic", text: "summary", encrypted: "encrypted" },
            { type: "effort", effort: "high", previous: "low" },
        ],
    },
    [
        "parts.0.id",
        "parts.0.name",
        "parts.0.input.x",
        "parts.0.providerExecuted",
        "parts.0.providerMetadata.anthropic.a",
        "parts.1.id",
        "parts.1.name",
        "parts.1.result.type",
        "parts.1.result.value",
        "parts.1.providerExecuted",
        "parts.1.providerMetadata.anthropic.result",
        "parts.1.cache",
        "parts.2.media.data",
        "parts.2.media.mediaType",
        "parts.2.metadata.title",
        "parts.2.filename",
        "parts.2.cache",
        "parts.3.provider",
        "parts.3.text",
        "parts.3.encrypted",
        "parts.4.effort",
        "parts.4.previous",
    ],
);

const pi = {
    role: "assistant",
    provider: "anthropic",
    api: "anthropic-messages",
    model: "opus",
    stopReason: "toolUse",
    content: [
        { type: "text", text: "Answer" },
        { type: "thinking", thinking: "Thought", thinkingSignature: "sig", redacted: false },
        {
            type: "toolCall",
            id: "call",
            name: "bash",
            arguments: { command: "pwd", metadata: "opaque" },
        },
    ],
};
perturb("pi", { role: "user", content: "Task" }, ["content"]);
perturb("pi", pi, [
    "role",
    "provider",
    "api",
    "model",
    "stopReason",
    "content.0.type",
    "content.0.text",
    "content.1.thinking",
    "content.1.thinkingSignature",
    "content.1.redacted",
    "content.2.id",
    "content.2.name",
    "content.2.arguments.command",
    "content.2.arguments.metadata",
]);
perturb(
    "pi",
    {
        role: "toolResult",
        toolCallId: "call",
        isError: false,
        addedToolNames: ["read"],
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    },
    ["toolCallId", "isError", "addedToolNames.0", "content.0.data", "content.0.mimeType"],
);
it("Pi host-only envelope and property order do not change first-kept identity", () => {
    expect(
        firstKeptDigest(
            { ...pi, timestamp: 1, usage: { input: 1 }, details: "UI" },
            provenance("pi"),
        ),
    ).toBe(
        firstKeptDigest(
            { details: "other", usage: { input: 2 }, timestamp: 2, ...pi },
            provenance("pi"),
        ),
    );
});

for (const host of ["opencode-v1", "opencode-v2", "pi"] as const) {
    for (const field of ["provider", "id", "api"] as const)
        it(`${host} current model ${field} changes first-kept identity`, () => {
            const p = provenance(host);
            const msg =
                host === "pi"
                    ? pi
                    : { info: { role: "user" }, parts: [{ type: "text", text: "Task" }] };
            expect(firstKeptDigest(msg, { ...p, model: { ...model, [field]: "other" } })).not.toBe(
                firstKeptDigest(msg, p),
            );
        });
}

it("OC2 sidecar changes outside provider projection are not part of the digest", () => {
    const make = (providerExecuted: boolean) =>
        ({
            sessionID: "sidecar-digest",
            model: { providerID: "anthropic", id: "opus" },
            agent: "build",
            system: [],
            tools: {},
            options: {},
            messages: [
                {
                    id: "a",
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            id: "call",
                            name: "web_search",
                            input: {},
                            providerExecuted,
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            id: "call",
                            name: "web_search",
                            providerExecuted: true,
                            result: { type: "text", value: "same" },
                        },
                    ],
                },
            ],
        }) as SessionContext;
    const a = make(false);
    const b = make(true);
    const before = adaptPayload(a);
    const after = adaptPayload(b);
    expect(firstKeptDigest(before.messages[0], provenance("opencode-v2"))).toBe(
        firstKeptDigest(after.messages[0], provenance("opencode-v2")),
    );
    before.commit();
    after.commit();
    expect(JSON.stringify(a.messages)).toContain('"providerExecuted":false');
    expect(JSON.stringify(b.messages)).toContain('"providerExecuted":true');
});
