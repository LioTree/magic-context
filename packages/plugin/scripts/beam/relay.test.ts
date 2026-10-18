import { afterAll, describe, expect, test } from "bun:test";
import { BEAM_SESSION_HEADER, BEAM_WORKSPACE_HEADER } from "./cloud-code";
import { collectCloudCodeStream, startRelay, unwrapCloudCodeEvent } from "./relay";
import { startStub } from "./stub";

const expectations = {
    codexToken: "fake-codex-token",
    codexAccountId: "fake-account",
    cloudCodeToken: "fake-cloud-code-token",
    cloudCodeProject: "fake-project-123",
    voyageKey: "fake-voyage-key",
};
const sessionMetadata = {
    [BEAM_SESSION_HEADER]: "child-session-fixture",
    [BEAM_WORKSPACE_HEADER]: "file:///tmp/beam-fixture",
};
const userBody = { contents: [{ role: "user", parts: [{ text: "ok" }] }] };
const stub = startStub(expectations);
const relay = startRelay({
    routes: [
        {
            kind: "cloud-code",
            prefix: "/gemini/v1beta",
            upstream: stub.origin,
            token: () => expectations.cloudCodeToken,
            project: expectations.cloudCodeProject,
        },
    ],
});
afterAll(() => {
    relay.stop();
    stub.stop();
});

/** A small deterministic generator, so a failing seed can be replayed. */
function random(seed: number) {
    let state = seed >>> 0 || 1;
    const next = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x1_0000_0000;
    };
    const text = () => {
        const alphabet = ["a", "Z", " ", "\n", '"', "\\", "<", "é", "日", "😀", "$&", "{x}"];
        return Array.from(
            { length: 1 + Math.floor(next() * 12) },
            () => alphabet[Math.floor(next() * alphabet.length)],
        ).join("");
    };
    const value = (depth: number): unknown => {
        const pick = next();
        if (depth > 3 || pick < 0.3) return text();
        if (pick < 0.4) return Math.round(next() * 1e6) / 1e3;
        if (pick < 0.45) return next() < 0.5;
        if (pick < 0.5) return null;
        if (pick < 0.75)
            return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
        return Object.fromEntries(
            Array.from({ length: Math.floor(next() * 4) }, (_, i) => [
                `k${i}${text()}`,
                value(depth + 1),
            ]),
        );
    };
    return { next, text, value };
}

function randomGeminiBody(seed: number): Record<string, unknown> {
    const r = random(seed);
    const body: Record<string, unknown> = {
        contents: Array.from({ length: 1 + Math.floor(r.next() * 4) }, (_, i) => ({
            role: i % 2 ? "model" : "user",
            parts: [
                { text: r.text() },
                ...(r.next() < 0.3 ? [{ functionCall: { name: "f", args: r.value(1) } }] : []),
            ],
        })),
        systemInstruction: { parts: [{ text: r.text() }] },
        generationConfig: {
            temperature: r.next(),
            maxOutputTokens: Math.floor(r.next() * 9000),
            thinkingConfig: r.value(2),
        },
    };
    if (r.next() < 0.6)
        body.tools = [
            {
                functionDeclarations: [
                    { name: "f", description: r.text(), parameters: r.value(1) },
                ],
            },
        ];
    if (body.tools && r.next() < 0.5) body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    const last = (body.contents as { role: string }[]).at(-1);
    if (last) last.role = "user";
    return body;
}

async function send(body: unknown, key = relay.hostKey, action = "streamGenerateContent") {
    return fetch(`${relay.origin}/gemini/v1beta/models/gemini-3.8-flash:${action}?alt=sse`, {
        method: "POST",
        headers: { ...sessionMetadata, "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
    });
}

describe("Cloud Code relay", () => {
    test("preserves prompt-bearing fields in 200 randomized native envelopes", async () => {
        for (let seed = 1; seed <= 200; seed++) {
            const body = randomGeminiBody(seed);
            const before = stub.records.length;
            const response = await send(body);
            expect(response.status).toBe(200);
            await response.text();
            const record = stub.records[before];
            expect(record?.route).toBe("cloud-code");
            const envelope = record?.body as Record<string, unknown>;
            const adapted = envelope.request as Record<string, unknown>;
            for (const field of ["contents", "systemInstruction", "tools"]) {
                expect(JSON.stringify(adapted[field])).toBe(JSON.stringify(body[field]));
            }
            expect(envelope.model).toBe("gemini-3.8-flash-medium");
            expect(record?.path).toBe("/v1internal:streamGenerateContent?alt=sse");
            expect(envelope.project).toBe(expectations.cloudCodeProject);
            expect(record?.credentialHeaders.authorization).toBe("present-matches");
        }
    });

    test("unwraps each streamed `response` event and the non-streamed reply", async () => {
        const streamed = await (await send(randomGeminiBody(7))).text();
        const event = JSON.parse(
            streamed
                .split("\n")
                .find((line) => line.startsWith("data:"))
                ?.slice(5) ?? "{}",
        );
        expect(event.candidates?.[0]?.content?.parts?.[0]?.text).toBe("ok");
        expect(event.response).toBeUndefined();
        const whole = (await (
            await send(randomGeminiBody(8), relay.hostKey, "generateContent")
        ).json()) as { candidates?: { finishReason?: string }[] };
        expect(whole.candidates?.[0]?.finishReason).toBe("STOP");
        expect(unwrapCloudCodeEvent(" [DONE]")).toBe(" [DONE]");
    });

    test("aggregates every SSE delta for a non-streaming host call", () => {
        const text = [
            {
                response: {
                    candidates: [
                        { index: 0, content: { role: "model", parts: [{ text: "one" }] } },
                    ],
                },
            },
            {
                response: {
                    candidates: [
                        { index: 0, content: { parts: [{ text: "two" }] }, finishReason: "STOP" },
                    ],
                    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
                },
            },
        ]
            .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
            .join("");
        const response = JSON.parse(collectCloudCodeStream(`${text}data: [DONE]\n`));
        expect(response.candidates[0].content.parts).toEqual([{ text: "one" }, { text: "two" }]);
        expect(response.candidates[0].finishReason).toBe("STOP");
        expect(response.usageMetadata).toEqual({ promptTokenCount: 5, candidatesTokenCount: 2 });
    });

    test("UUIDs are stable per child session and workspace, not per host or request", async () => {
        const call = async (child: string, workspace: string) => {
            const before = stub.records.length;
            const response = await fetch(
                `${relay.origin}/gemini/v1beta/models/gemini-3.8-flash-medium:generateContent`,
                {
                    method: "POST",
                    headers: {
                        "x-goog-api-key": relay.hostKey,
                        [BEAM_SESSION_HEADER]: child,
                        [BEAM_WORKSPACE_HEADER]: workspace,
                    },
                    body: JSON.stringify(userBody),
                },
            );
            expect(response.status).toBe(200);
            await response.text();
            return stub.records[before]?.body as {
                requestId: string;
                request: { sessionId: string };
            };
        };
        const first = await call("child-a", "file:///tmp/beam-a");
        const repeat = await call("child-a", "file:///tmp/beam-a");
        const otherChild = await call("child-b", "file:///tmp/beam-a");
        const otherWorkspace = await call("child-a", "file:///tmp/beam-b");
        const ids = (id: string) => [id.split("/")[1], id.split("/")[3]];
        expect(ids(first.requestId)).toEqual(ids(repeat.requestId));
        expect(ids(first.requestId)).not.toEqual(ids(otherChild.requestId));
        expect(ids(first.requestId)).not.toEqual(ids(otherWorkspace.requestId));
        expect(first.request.sessionId).toBe(otherChild.request.sessionId);
        expect(first.request.sessionId).not.toBe(otherWorkspace.request.sessionId);
    });

    test("missing child-session metadata refuses forwarding instead of sharing a trajectory", async () => {
        const before = stub.records.length;
        const response = await fetch(`${relay.origin}/gemini/v1beta/models/m:generateContent`, {
            method: "POST",
            headers: { "x-goog-api-key": relay.hostKey },
            body: JSON.stringify(userBody),
        });
        expect(response.status).toBe(400);
        expect(stub.records.length).toBe(before);
    });

    test("refuses a caller without the per-run key before anything reaches the upstream", async () => {
        const before = stub.records.length;
        expect((await send(randomGeminiBody(9), "wrong")).status).toBe(401);
        expect(stub.records.length).toBe(before);
    });

    test("its log carries no header or token", () => {
        const log = JSON.stringify(relay.log);
        expect(log).not.toContain(expectations.cloudCodeToken);
        expect(log).not.toContain(relay.hostKey);
        expect(Object.keys(relay.log[0] ?? {}).sort()).toEqual([
            "bytesIn",
            "bytesOut",
            "durationMs",
            "inputTokens",
            "method",
            "outputTokens",
            "path",
            "route",
            "status",
        ]);
    });

    test.each([
        400, 403, 500,
    ])("keeps the upstream HTTP %i body with every known secret scrubbed", async (status) => {
        const previousToken = "previous-cloud-code-token";
        const upstream = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                return Response.json(
                    {
                        error: {
                            message: "Model is not allowed for this project",
                            echoedToken: request.headers.get("authorization"),
                            previousToken,
                            voyage: expectations.voyageKey,
                            hostKey: diagnostic.hostKey,
                        },
                    },
                    { status },
                );
            },
        });
        const diagnostic = startRelay({
            secrets: () => [previousToken, expectations.voyageKey],
            routes: [
                {
                    kind: "cloud-code",
                    prefix: "/gemini/v1beta",
                    upstream: `http://127.0.0.1:${upstream.port}`,
                    token: () => expectations.cloudCodeToken,
                    project: expectations.cloudCodeProject,
                },
            ],
        });
        try {
            const response = await fetch(
                `${diagnostic.origin}/gemini/v1beta/models/m:generateContent`,
                {
                    method: "POST",
                    headers: { ...sessionMetadata, "x-goog-api-key": diagnostic.hostKey },
                    body: JSON.stringify(userBody),
                },
            );
            const expected = JSON.stringify({
                error: {
                    message: "Model is not allowed for this project",
                    echoedToken: "Bearer [REDACTED]",
                    previousToken: "[REDACTED]",
                    voyage: "[REDACTED]",
                    hostKey: "[REDACTED]",
                },
            });
            expect(response.status).toBe(status);
            expect(await response.text()).toBe(expected);
            expect(diagnostic.log[0]?.errorBody).toBe(expected);
            expect(diagnostic.log[0]?.bytesOut).toBe(Buffer.byteLength(expected));
        } finally {
            diagnostic.stop();
            upstream.stop(true);
        }
    });

    test("keeps plain-text upstream errors, including an empty body", async () => {
        let body = "Backend policy: model disabled";
        const upstream = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response(body, { status: 400 }),
        });
        const diagnostic = startRelay({
            routes: [
                {
                    kind: "cloud-code",
                    prefix: "/gemini/v1beta",
                    upstream: `http://127.0.0.1:${upstream.port}`,
                    token: () => expectations.cloudCodeToken,
                    project: expectations.cloudCodeProject,
                },
            ],
        });
        try {
            for (const text of [body, ""]) {
                body = text;
                const response = await fetch(
                    `${diagnostic.origin}/gemini/v1beta/models/m:generateContent`,
                    {
                        method: "POST",
                        headers: { ...sessionMetadata, "x-goog-api-key": diagnostic.hostKey },
                        body: JSON.stringify(userBody),
                    },
                );
                expect(await response.text()).toBe(text);
                expect(diagnostic.log.at(-1)?.errorBody).toBe(text);
            }
        } finally {
            diagnostic.stop();
            upstream.stop(true);
        }
    });

    test("an upstream 401 latches the rejection and stops forwarding", async () => {
        const rejecting = startRelay({
            routes: [
                {
                    kind: "cloud-code",
                    prefix: "/gemini/v1beta",
                    upstream: stub.origin,
                    token: () => "not-the-token",
                    project: expectations.cloudCodeProject,
                },
            ],
        });
        try {
            const call = () =>
                fetch(`${rejecting.origin}/gemini/v1beta/models/m:generateContent`, {
                    method: "POST",
                    headers: { ...sessionMetadata, "x-goog-api-key": rejecting.hostKey },
                    body: JSON.stringify(userBody),
                });
            expect((await call()).status).toBe(401);
            expect(rejecting.authRejected).toEqual({ route: "cloud-code", status: 401 });
            const before = stub.records.length;
            expect((await call()).status).toBe(403);
            expect(stub.records.length).toBe(before);
        } finally {
            rejecting.stop();
        }
    });
});
