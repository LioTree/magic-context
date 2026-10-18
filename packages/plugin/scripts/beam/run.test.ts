import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../src/shared/test-temp-dir";
import { STUB_CREDENTIALS, stubCredentials } from "./credentials";
import { codexRequestBody } from "./llm";
import { startRelay } from "./relay";
import { parseBeamArgs, smokeTransport, summarizeRun } from "./run";
import { startStub } from "./stub";

const settings: Parameters<typeof summarizeRun>[0] = {
    run: "sampling-test",
    mode: "stub",
    split: "100K",
    datasetRevision: "fixture",
    conversations: [],
    answerModel: "gpt-6-luna",
    historianModel: "gemini-3.8-flash-medium",
    historianVariant: "medium",
    reasoningEffort: "none",
    answerContextLimit: 272000,
    answerOutputLimit: 32000,
    historianContextLimit: 1048576,
    historianOutputLimit: 65536,
    executeThresholdPercentage: 65,
    dreamer: false,
    embeddingModel: "voyage-4",
    promptSet: "fixture",
    promptHashes: {},
    opencodeVersion: "fixture",
    pluginDistSha256: "fixture",
    maxInputTokensPerArm: 30000000,
    vanillaTrimming: "beam-released-cl100k-v1",
};

describe("Codex sampling", () => {
    test("defaults to omitting temperature and keeps the explicit zero override", () => {
        expect(parseBeamArgs([]).values.temperature).toBe("omit");
        expect(parseBeamArgs(["--stub", "--temperature", "0"]).values.temperature).toBe("0");
        const codex = {
            model: settings.answerModel,
            baseURL: "http://127.0.0.1",
            credentials: stubCredentials().codex,
        };
        const messages = [{ role: "user" as const, content: "ok" }];
        expect(codexRequestBody(codex, messages)).not.toHaveProperty("temperature");
        expect(codexRequestBody({ ...codex, temperature: 0 }, messages).temperature).toBe(0);
    });

    test("summary.json explicitly records unset answer/judge temperatures and the paper deviation", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "beam-summary-"));
        const previous = process.env.BEAM_DATA_DIR;
        process.env.BEAM_DATA_DIR = root;
        try {
            summarizeRun(settings);
            const summary = JSON.parse(
                readFileSync(join(root, "runs", settings.run, "summary.json"), "utf8"),
            );
            expect(summary.cloudCode).toMatchObject({
                historianVariant: "medium",
                model: "gemini-3.8-flash-medium",
                thinkingConfig: { thinkingBudget: 4000, includeThoughts: true },
                maxOutputTokens: 65536,
            });
            expect(summary.sampling).toEqual({
                answerTemperature: null,
                judgeTemperature: null,
                temperatureSet: false,
                paperTemperature: 0,
            });
            expect(summary.protocolDeviations).toEqual([
                "Answer and judge temperature was not set: the Codex subscription backend rejects temperature. The paper used temperature 0.",
            ]);
            const explicit = summarizeRun({ ...settings, temperature: 0 });
            expect(explicit.sampling).toEqual({
                answerTemperature: 0,
                judgeTemperature: 0,
                temperatureSet: true,
                paperTemperature: 0,
            });
            expect(explicit.protocolDeviations).toEqual([]);
        } finally {
            if (previous === undefined) delete process.env.BEAM_DATA_DIR;
            else process.env.BEAM_DATA_DIR = previous;
            rmSync(root, { recursive: true, force: true });
        }
    });
});

test("--smoke-transport is an alias for the transport smoke command", () => {
    expect(parseBeamArgs([]).values["historian-variant"]).toBe("medium");
    expect(parseBeamArgs(["--historian-variant", "low"]).values["historian-variant"]).toBe("low");
    expect(parseBeamArgs(["--smoke-transport", "--run", "smoke"]).values["smoke-transport"]).toBe(
        true,
    );
});

test("smoke prints the complete sanitized JSON 403 body before stopping without retry", async () => {
    const credentials = stubCredentials();
    const stub = startStub(STUB_CREDENTIALS);
    const reason = `${"diagnostic ".repeat(80)}model not allowed`;
    let calls = 0;
    const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
            calls++;
            return Response.json(
                { error: { message: reason, token: STUB_CREDENTIALS.cloudCodeToken } },
                { status: 403 },
            );
        },
    });
    const relay = startRelay({
        secrets: credentials.secrets,
        routes: [
            {
                kind: "cloud-code",
                prefix: "/gemini/v1beta",
                upstream: `http://127.0.0.1:${upstream.port}`,
                token: async () => (await credentials.cloudCode()).token,
                project: STUB_CREDENTIALS.cloudCodeProject,
            },
        ],
    });
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.join(" "));
    };
    try {
        await expect(
            smokeTransport(settings, {
                credentials,
                stub,
                relay,
                wiring: {
                    codexBaseURL: `${stub.origin}/backend-api/codex`,
                    geminiBaseURL: `${relay.origin}/gemini/v1beta`,
                    embeddingEndpoint: `${stub.origin}/v1`,
                    embeddingModel: settings.embeddingModel,
                },
                codex: () => ({
                    baseURL: `${stub.origin}/backend-api/codex`,
                    credentials: credentials.codex,
                    model: settings.answerModel,
                }),
                stop() {},
            }),
        ).rejects.toThrow("Cloud Code Assist rejected the credential (HTTP 403)");
        const expected = JSON.stringify({ error: { message: reason, token: "[REDACTED]" } });
        expect(lines).toContain(`gemini via relay: FAILED HTTP 403 ${expected}`);
        expect(JSON.stringify(lines)).not.toContain(STUB_CREDENTIALS.cloudCodeToken);
        expect(calls).toBe(1);
        expect(stub.records.some((record) => record.route === "voyage")).toBe(false);
    } finally {
        console.log = original;
        relay.stop();
        stub.stop();
        upstream.stop(true);
        credentials.close();
    }
});
