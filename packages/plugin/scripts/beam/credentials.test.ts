import { describe, expect, test } from "bun:test";
import { BEAM_SESSION_HEADER, BEAM_WORKSPACE_HEADER } from "./cloud-code";
import {
    type ClaustrumClientLike,
    CredentialError,
    credentialGetter,
    scopedCredentials,
    scrub,
} from "./credentials";
import { AuthRejectedError, codexComplete } from "./llm";
import { startRelay } from "./relay";
import { startStub } from "./stub";

const MINUTE = 60_000;

async function fakeVault(expiry: "known" | "null" | "missing" = "known") {
    let now = 1_000_000;
    let refuse = false;
    let closed = 0;
    const counts = { codex: 0, cloud: 0 };
    const requests: { credentialId: string; minTtlMs?: number }[] = [];
    const expected = {
        codexToken: "",
        codexAccountId: "fake-account",
        cloudCodeToken: "",
        cloudCodeProject: "fake-project",
        voyageKey: "fake-voyage-key",
    };
    const client: ClaustrumClientLike = {
        async listScoped() {
            return {
                rows: ["chatgpt:openai", "antigravity:google"].map((id) => ({
                    id,
                    state: "ready",
                    categories: [],
                })),
            };
        },
        async getScoped(input) {
            requests.push(input);
            if (refuse) throw new Error("ttl_unsatisfiable");
            const codex = input.credentialId === "chatgpt:openai";
            const count = codex ? ++counts.codex : ++counts.cloud;
            const material = `fake-${codex ? "codex" : "cloud"}-token-${count}`;
            if (codex) expected.codexToken = material;
            else expected.cloudCodeToken = material;
            return {
                material,
                ...(expiry === "missing"
                    ? {}
                    : { expiresAtMs: expiry === "known" ? now + 60 * MINUTE : null }),
                ...(codex
                    ? { accountId: expected.codexAccountId }
                    : { projectId: expected.cloudCodeProject }),
            };
        },
        close() {
            closed++;
        },
    };
    const credentials = await scopedCredentials(
        { antigravityCredential: "antigravity:google", voyageKeyFile: "unused" },
        { client, enrollment: "fake-enrollment", voyageKey: expected.voyageKey, now: () => now },
    );
    return {
        credentials,
        expected,
        counts,
        requests,
        advance(ms: number) {
            now += ms;
        },
        refuse() {
            refuse = true;
        },
        closed: () => closed,
    };
}

describe("BEAM scoped credential refresh", () => {
    test("refreshes both credentials before expiry with a 15-minute fetch window", async () => {
        const vault = await fakeVault();
        try {
            const codex = await vault.credentials.codex();
            const cloud = await vault.credentials.cloudCode();
            vault.advance(50 * MINUTE - 1);
            expect(await vault.credentials.codex()).toBe(codex);
            expect(await vault.credentials.cloudCode()).toBe(cloud);
            vault.advance(1);
            expect((await vault.credentials.codex()).token).not.toBe(codex.token);
            expect((await vault.credentials.cloudCode()).token).not.toBe(cloud.token);
            expect(vault.counts).toEqual({ codex: 2, cloud: 2 });
            expect(vault.requests.map((request) => request.minTtlMs)).toEqual([
                900_000, 900_000, 900_000, 900_000,
            ]);
            expect(vault.closed()).toBe(0);
            const all = [
                codex.token,
                cloud.token,
                vault.expected.codexToken,
                vault.expected.cloudCodeToken,
            ];
            expect(scrub(all.join(" "), vault.credentials.secrets())).toBe(
                Array(4).fill("[REDACTED]").join(" "),
            );
        } finally {
            vault.credentials.close();
        }
        expect(vault.closed()).toBe(1);
    });

    test.each([
        "null",
        "missing",
    ] as const)("re-reads credentials with %s expiry every 30 minutes", async (expiry) => {
        const vault = await fakeVault(expiry);
        try {
            vault.advance(30 * MINUTE - 1);
            await vault.credentials.codex();
            await vault.credentials.cloudCode();
            expect(vault.counts).toEqual({ codex: 1, cloud: 1 });
            vault.advance(1);
            await vault.credentials.codex();
            await vault.credentials.cloudCode();
            expect(vault.counts).toEqual({ codex: 2, cloud: 2 });
        } finally {
            vault.credentials.close();
        }
    });

    test("concurrent callers share the initial read and each refresh", async () => {
        let now = 0;
        let reads = 0;
        let release: (value: { expiresAtMs: number }) => void = () => {};
        const get = credentialGetter(
            () => {
                reads++;
                return new Promise<{ expiresAtMs: number }>((resolve) => {
                    release = resolve;
                });
            },
            () => now,
        );
        const first = [get(), get(), get()];
        expect(reads).toBe(1);
        release({ expiresAtMs: 60 * MINUTE });
        await Promise.all(first);
        now = 50 * MINUTE;
        const refreshed = [get(), get(), get()];
        expect(reads).toBe(2);
        release({ expiresAtMs: 110 * MINUTE });
        const values = await Promise.all(refreshed);
        expect(values[0]).toBe(values[1]);
        expect(values[1]).toBe(values[2]);
    });

    test("a refresh refusal is terminal and never serves the old token", async () => {
        const vault = await fakeVault();
        try {
            vault.advance(50 * MINUTE);
            vault.refuse();
            await expect(vault.credentials.codex()).rejects.toThrow(
                "the vault refused chatgpt:openai (ttl_unsatisfiable)",
            );
            const reads = vault.requests.length;
            await expect(vault.credentials.codex()).rejects.toBeInstanceOf(CredentialError);
            expect(vault.requests.length).toBe(reads);
        } finally {
            vault.credentials.close();
        }
    });

    test("answer and judge requests resolve fresh credentials on a reused client", async () => {
        const vault = await fakeVault();
        const stub = startStub(vault.expected);
        const settings = {
            baseURL: `${stub.origin}/backend-api/codex`,
            credentials: vault.credentials.codex,
            model: "gpt-6-luna",
        };
        try {
            await codexComplete(settings, [{ role: "user", content: "Reply ok" }]);
            vault.advance(50 * MINUTE);
            await codexComplete(settings, [{ role: "user", content: "RUBRIC CRITERION: ok" }]);
            expect(vault.counts.codex).toBe(2);
            expect(stub.records.map((record) => record.credentialHeaders.authorization)).toEqual([
                "present-matches",
                "present-matches",
            ]);
            expect(stub.records.map((record) => record.status)).toEqual([200, 200]);
            vault.advance(50 * MINUTE);
            vault.refuse();
            await expect(
                codexComplete(settings, [{ role: "user", content: "Reply ok" }]),
            ).rejects.toThrow("ttl_unsatisfiable");
            expect(stub.records.length).toBe(2);
        } finally {
            stub.stop();
            vault.credentials.close();
        }
    });

    test("a token rejected after a fresh read stops without another vault read or HTTP retry", async () => {
        const vault = await fakeVault();
        const stub = startStub(vault.expected);
        try {
            vault.advance(50 * MINUTE);
            stub.rejectCodex = true;
            await expect(
                codexComplete(
                    {
                        baseURL: `${stub.origin}/backend-api/codex`,
                        credentials: vault.credentials.codex,
                        model: "gpt-6-luna",
                    },
                    [{ role: "user", content: "Reply ok" }],
                ),
            ).rejects.toBeInstanceOf(AuthRejectedError);
            expect(vault.counts.codex).toBe(2);
            expect(stub.records.length).toBe(1);
            expect(stub.records[0]?.status).toBe(401);
        } finally {
            stub.stop();
            vault.credentials.close();
        }
    });

    test("the historian relay refreshes per request and latches a vault refusal without forwarding", async () => {
        const vault = await fakeVault();
        const stub = startStub(vault.expected);
        const relay = startRelay({
            routes: [
                {
                    kind: "cloud-code",
                    prefix: "/gemini/v1beta",
                    upstream: stub.origin,
                    token: async () => (await vault.credentials.cloudCode()).token,
                    project: vault.expected.cloudCodeProject,
                },
            ],
        });
        const send = () =>
            fetch(`${relay.origin}/gemini/v1beta/models/gemini:generateContent`, {
                method: "POST",
                headers: {
                    [BEAM_SESSION_HEADER]: "refresh-test-child",
                    [BEAM_WORKSPACE_HEADER]: "file:///tmp/beam-refresh-fixture",
                    "x-goog-api-key": relay.hostKey,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ok" }] }] }),
            });
        try {
            expect((await send()).status).toBe(200);
            vault.advance(50 * MINUTE);
            expect((await send()).status).toBe(200);
            expect(vault.counts.cloud).toBe(2);
            expect(stub.records.map((record) => record.credentialHeaders.authorization)).toEqual([
                "present-matches",
                "present-matches",
            ]);
            vault.advance(50 * MINUTE);
            vault.refuse();
            expect((await send()).status).toBe(403);
            expect(relay.credentialError?.message).toBe(
                "the vault refused antigravity:google (ttl_unsatisfiable)",
            );
            const reads = vault.requests.length;
            expect((await send()).status).toBe(403);
            expect(vault.requests.length).toBe(reads);
            expect(stub.records.length).toBe(2);
            expect(JSON.stringify(relay.log)).not.toContain("fake-cloud-token");
        } finally {
            relay.stop();
            stub.stop();
            vault.credentials.close();
        }
    });
});
