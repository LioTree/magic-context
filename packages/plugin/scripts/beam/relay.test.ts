import { afterAll, describe, expect, test } from "bun:test";
import { startRelay, unwrapCloudCodeEvent } from "./relay";
import { startStub } from "./stub";

const expectations = {
    codexToken: "fake-codex-token",
    codexAccountId: "fake-account",
    cloudCodeToken: "fake-cloud-code-token",
    cloudCodeProject: "fake-project-123",
    voyageKey: "fake-voyage-key",
};
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
        return Array.from({ length: 1 + Math.floor(next() * 12) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
    };
    const value = (depth: number): unknown => {
        const pick = next();
        if (depth > 3 || pick < 0.3) return text();
        if (pick < 0.4) return Math.round(next() * 1e6) / 1e3;
        if (pick < 0.45) return next() < 0.5;
        if (pick < 0.5) return null;
        if (pick < 0.75) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
        return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, (_, i) => [`k${i}${text()}`, value(depth + 1)]));
    };
    return { next, text, value };
}

function randomGeminiBody(seed: number): Record<string, unknown> {
    const r = random(seed);
    const body: Record<string, unknown> = {
        contents: Array.from({ length: 1 + Math.floor(r.next() * 4) }, (_, i) => ({
            role: i % 2 ? "model" : "user",
            parts: [{ text: r.text() }, ...(r.next() < 0.3 ? [{ functionCall: { name: "f", args: r.value(1) } }] : [])],
        })),
        systemInstruction: { parts: [{ text: r.text() }] },
        generationConfig: { temperature: r.next(), maxOutputTokens: Math.floor(r.next() * 9000), thinkingConfig: r.value(2) },
    };
    if (r.next() < 0.6) body.tools = [{ functionDeclarations: [{ name: "f", description: r.text(), parameters: r.value(1) }] }];
    if (r.next() < 0.5) body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    if (r.next() < 0.5) body[`extra${r.text()}`] = r.value(0);
    return body;
}

async function send(body: unknown, key = relay.hostKey, action = "streamGenerateContent") {
    return fetch(`${relay.origin}/gemini/v1beta/models/gemini-3.8-flash:${action}?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
    });
}

describe("Cloud Code relay", () => {
    test("passes 200 randomized request bodies through as equal JSON inside the envelope", async () => {
        for (let seed = 1; seed <= 200; seed++) {
            const body = randomGeminiBody(seed);
            const before = stub.records.length;
            const response = await send(body);
            expect(response.status).toBe(200);
            await response.text();
            const record = stub.records[before];
            expect(record?.route).toBe("cloud-code");
            const envelope = record?.body as Record<string, unknown>;
            expect(envelope.request).toEqual(body);
            expect(JSON.stringify(envelope.request)).toBe(JSON.stringify(body));
            expect(envelope.model).toBe("gemini-3.8-flash");
            expect(envelope.project).toBe(expectations.cloudCodeProject);
            expect(record?.credentialHeaders.authorization).toBe("present-matches");
        }
    });

    test("unwraps each streamed `response` event and the non-streamed reply", async () => {
        const streamed = await (await send(randomGeminiBody(7))).text();
        const event = JSON.parse(streamed.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}");
        expect(event.candidates?.[0]?.content?.parts?.[0]?.text).toBe("ok");
        expect(event.response).toBeUndefined();
        const whole = (await (await send(randomGeminiBody(8), relay.hostKey, "generateContent")).json()) as { candidates?: { finishReason?: string }[] };
        expect(whole.candidates?.[0]?.finishReason).toBe("STOP");
        expect(unwrapCloudCodeEvent(" [DONE]")).toBe(" [DONE]");
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
        expect(Object.keys(relay.log[0] ?? {}).sort()).toEqual(["bytesIn", "bytesOut", "durationMs", "inputTokens", "method", "outputTokens", "path", "route", "status"]);
    });

    test("an upstream 401 latches the rejection and stops forwarding", async () => {
        const rejecting = startRelay({
            routes: [{ kind: "cloud-code", prefix: "/gemini/v1beta", upstream: stub.origin, token: () => "not-the-token", project: expectations.cloudCodeProject }],
        });
        try {
            const call = () =>
                fetch(`${rejecting.origin}/gemini/v1beta/models/m:generateContent`, {
                    method: "POST",
                    headers: { "x-goog-api-key": rejecting.hostKey },
                    body: "{}",
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
