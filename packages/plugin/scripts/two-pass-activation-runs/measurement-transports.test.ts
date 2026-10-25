import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { measurementTransport } from "./measurement-transports";
import { scopedCredentials } from "./scoped-credentials";
import type { MeasurementRequest } from "./cache-measurement-driver";

test("first-party child retains raw history and reports observed cache usage against mock only", async () => {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "anthropic-mock-"));
    const requests: Array<Record<string, any>> = [];
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        requests.push(await request.json() as Record<string, any>);
        return Response.json({ content: [{ type: "text", text: requests.length === 1 ? "raw first reply\n" : "second reply" }],
            usage: { input_tokens: requests.length === 1 ? 20 : 5, output_tokens: 7,
                cache_creation_input_tokens: requests.length === 1 ? 80 : 0,
                cache_read_input_tokens: requests.length === 2 ? 95 : 0 } });
    } });
    const transport = measurementTransport({ mockAnthropicEndpoint: `${mock.url}v1/messages` });
    let session: Awaited<ReturnType<typeof transport.openAnthropic>> | undefined;
    try {
        session = await transport.openAnthropic({ root, env: { ...disposableEnvironment(root), ANTHROPIC_API_KEY: "mock-only-key" }, model: "claude-sonnet-5-5" });
        const first: MeasurementRequest = { model: "claude-sonnet-5-5", maxOutputTokens: 20, system: "fixed system",
            messages: [{ role: "user", content: "first prompt" }], tools: [], mode: "best_effort" };
        const reply = await session.send(first);
        expect(reply.steps).toEqual([{ inputTokens: 100, outputTokens: 7 }]);
        const second = await session.send({ ...first, messages: [...first.messages,
            { role: "assistant", content: reply.text }, { role: "user", content: "second prompt" }] });
        expect(second.usage?.cache_read_input_tokens).toBe(95);
        expect(requests).toHaveLength(2);
        expect(requests[1].system).toEqual(requests[0].system);
        expect(requests[1].messages[0]).toEqual(requests[0].messages[0]);
        expect(requests[1].messages[1].content).toEqual([{ type: "text", text: "raw first reply\n" }]);
        expect(session.maxSteps).toBe(1);
        expect(session.hostRetries).toBe(0);
        expect(session.isolation.proof.pid).not.toBe(process.pid);
        expect(session.isolation.proof.output).toContain(root);
        await expect(session.send(first)).rejects.toThrow("measurement_session_bounds");
    } finally { await session?.close(); mock.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("measurement endpoint overrides cannot target a real provider", () => {
    expect(() => measurementTransport({ mockAnthropicEndpoint: "https://api.anthropic.com/v1/messages" })).toThrow("mock_endpoint_not_loopback");
});

test("CKCRED adapter fetches only the exact authorized grant with an in-memory token", async () => {
    const calls: unknown[] = [];
    const credentials = scopedCredentials({ enrollmentToken: "mock-enrollment-token", client: {
        async getScoped(request) { calls.push(request); return { material: "mock-material" }; },
    }, async onRunEnded(id) { calls.push({ ended: id }); } });
    expect(await credentials.getScoped("apikey:anthropic")).toBe("mock-material");
    await credentials.notifyRunEnded("apikey:anthropic");
    expect(calls).toEqual([{ credentialId: "apikey:anthropic", enrollmentToken: "mock-enrollment-token" }, { ended: "apikey:anthropic" }]);
});
