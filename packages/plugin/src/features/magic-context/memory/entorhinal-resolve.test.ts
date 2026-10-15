import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
    buildFlags,
    buildFrame,
    computeProof,
    decodeHeader,
    type EnvelopeHeader,
    encodeFrame,
    FrameType,
    HEADER_LEN,
    Priority,
    SERVER_PROOF_DOMAIN,
} from "@cortexkit/subc-client";
import vectors from "../../../../../../test-vectors/project-resolve-v1/resolve.json";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { ENTORHINAL_RESOLVE_DEADLINE_MS, resolveEntorhinalProject } from "./entorhinal-resolve";

class PeerReader {
    private buffered = Buffer.alloc(0);
    private readonly iterator: AsyncIterator<Uint8Array>;

    constructor(socket: Socket) {
        this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
    }

    async bytes(length: number): Promise<Buffer> {
        while (this.buffered.length < length) {
            const next = await this.iterator.next();
            if (next.done) throw new Error("Fake subc connection closed");
            this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
        }
        const result = this.buffered.subarray(0, length);
        this.buffered = this.buffered.subarray(length);
        return result;
    }

    async auth(): Promise<Record<string, unknown>> {
        const length = (await this.bytes(4)).readUInt32LE();
        return JSON.parse((await this.bytes(length)).toString("utf8"));
    }

    async frame(): Promise<{ header: EnvelopeHeader; body: unknown }> {
        const header = decodeHeader(await this.bytes(HEADER_LEN));
        const body = await this.bytes(header.len);
        return { header, body: JSON.parse(body.toString("utf8")) };
    }
}

function authReply(socket: Socket, body: unknown): void {
    const bytes = Buffer.from(JSON.stringify(body));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    socket.write(Buffer.concat([length, bytes]));
}

function frameReply(
    socket: Socket,
    request: EnvelopeHeader,
    body: unknown,
    type = FrameType.Response,
    raw = false,
): void {
    socket.write(
        encodeFrame(
            buildFrame(
                type,
                buildFlags(false, Priority.Interactive, false),
                request.channel,
                request.epoch,
                request.corr,
                Buffer.from(raw ? String(body) : JSON.stringify(body)),
            ),
        ),
    );
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

type FakeOptions = {
    stall?: "connect" | "route" | "reply";
    authDelay?: number;
    replyDelay?: number;
    error?: boolean;
    routeError?: boolean;
    raw?: boolean;
    disconnect?: boolean;
};

async function fakeEndpoint(reply: unknown = vectors[0].reply, options: FakeOptions = {}) {
    const temp = createTestTempDir("mc-entorhinal-");
    const connectionFile = join(temp.dir, "connection.json");
    const folder = join(temp.dir, "project");
    mkdirSync(folder);
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const daemonId = Uint8Array.from({ length: 16 }, (_, index) => index + 100);
    const serverNonce = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const routes: unknown[] = [];
    const calls: unknown[] = [];
    const hellos: unknown[] = [];
    const failures: unknown[] = [];
    const delay = (ms: number) =>
        new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                timers.delete(timer);
                resolve();
            }, ms);
            timers.add(timer);
        });
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        void (async () => {
            const reader = new PeerReader(socket);
            const hello = await reader.auth();
            hellos.push(hello);
            if (options.stall === "connect") return;
            if (options.authDelay) await delay(options.authDelay);
            const clientNonce = Uint8Array.from(hello.client_nonce as number[]);
            authReply(socket, {
                server_nonce: [...serverNonce],
                daemon_id: [...daemonId],
                server_proof: [
                    ...computeProof(key, SERVER_PROOF_DOMAIN, clientNonce, serverNonce, daemonId),
                ],
            });
            await reader.auth();
            const route = await reader.frame();
            routes.push(route.body);
            if (options.stall === "route") return;
            if (options.routeError) {
                frameReply(socket, route.header, reply, FrameType.Error);
                return;
            }
            frameReply(socket, route.header, { route_channel: 7, route_epoch: 77 });
            const call = await reader.frame();
            calls.push(call.body);
            if (options.disconnect) {
                socket.destroy();
                return;
            }
            if (options.stall === "reply") return;
            if (options.replyDelay) await delay(options.replyDelay);
            frameReply(
                socket,
                call.header,
                reply,
                options.error ? FrameType.Error : FrameType.Response,
                options.raw,
            );
        })().catch((error) => {
            if (!socket.destroyed) failures.push(error);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fake endpoint port");
    writeFileSync(
        connectionFile,
        JSON.stringify({
            schema: 1,
            endpoints: [{ host: "127.0.0.1", port: address.port }],
            key: [...key],
            daemon_id: [...daemonId],
            pid: process.pid,
            daemon_ver: "fake",
        }),
    );
    chmodSync(connectionFile, 0o600);
    cleanups.push(async () => {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        temp.cleanup();
        expect(failures).toEqual([]);
    });
    return { connectionFile, folder, server, routes, calls, hellos, delay };
}

function mutatedRoot(fields: Record<string, unknown>): unknown {
    const reply = structuredClone(vectors[0].reply);
    return { ...reply, result: { ...reply.result, ...fields } };
}

describe("Entorhinal project resolution", () => {
    test("uses its own bind identity and the exact management resolve envelope", async () => {
        const endpoint = await fakeEndpoint();
        const result = await resolveEntorhinalProject(endpoint.folder, {
            connectionFile: endpoint.connectionFile,
            identity: { project_root: endpoint.folder, harness: "pi", session: "session-own" },
        });
        expect(result.status).toBe("resolved");
        expect(endpoint.routes).toEqual([
            {
                op: "route.open",
                target: { kind: "management_surface", module_id: "entorhinal" },
                identity: { project_root: endpoint.folder, harness: "pi", session: "session-own" },
            },
        ]);
        expect(endpoint.calls).toEqual([
            { method: "resolve", params: { canonicalRoot: endpoint.folder } },
        ]);
    });

    for (const index of [0, 1, 2, 4]) {
        test(`selects projectId for vendored resolve case ${index}`, async () => {
            const vector = vectors[index];
            const endpoint = await fakeEndpoint(vector.reply);
            const result = await resolveEntorhinalProject(endpoint.folder, endpoint);
            expect(result.status).toBe("resolved");
            if (result.status !== "resolved") throw new Error("Expected a registered project");
            expect(result.projectId).toBe(vector.reply.result?.projectId);
            expect<string>(result.via).toBe(vector.reply.result?.via ?? "");
            expect(result.canonicalRoot).toBe(vector.reply.result?.canonicalRoot);
            expect(endpoint.calls).toHaveLength(1);
        });
    }

    test("accepts containment and ignores new fields", async () => {
        const endpoint = await fakeEndpoint(mutatedRoot({ via: "containment", futureField: true }));
        const result = await resolveEntorhinalProject(endpoint.folder, endpoint);
        expect(result.status).toBe("resolved");
        if (result.status === "resolved") expect(result.projectId).toBe("pj-resolve-root");
    });

    test("implicit keeps both git and directory fallback identities", async () => {
        const endpoint = await fakeEndpoint(vectors[3].reply);
        for (const fallback of ["git:existing-root", "dir:existing-folder"]) {
            const result = await resolveEntorhinalProject(endpoint.folder, endpoint);
            expect(result).toEqual({ status: "implicit" });
            expect(result.status === "resolved" ? result.projectId : fallback).toBe(fallback);
        }
    });

    test("no connection file is absent and makes no connection or calls", async () => {
        const endpoint = await fakeEndpoint();
        rmSync(endpoint.connectionFile);
        expect(await resolveEntorhinalProject(endpoint.folder, endpoint)).toEqual({
            status: "absent",
            reason: "no_connection_file",
        });
        expect(endpoint.hellos).toHaveLength(0);
        expect(endpoint.routes).toHaveLength(0);
        expect(endpoint.calls).toHaveLength(0);
    });

    test("a connection file with a down daemon is not answering, not absent", async () => {
        const endpoint = await fakeEndpoint();
        await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
        expect(await resolveEntorhinalProject(endpoint.folder, endpoint)).toEqual({
            status: "not_answering",
            reason: "transport",
        });
    });

    for (const routeError of [false, true]) {
        test(`module unknown_module is absent with no retry (route error: ${routeError})`, async () => {
            const reply = { ...vectors[5].reply, code: "unknown_module" };
            const endpoint = await fakeEndpoint(reply, { error: true, routeError });
            expect(await resolveEntorhinalProject(endpoint.folder, endpoint)).toEqual({
                status: "absent",
                reason: "unknown_module",
            });
            expect(endpoint.routes).toHaveLength(1);
            expect(endpoint.calls).toHaveLength(routeError ? 0 : 1);
        });
    }

    for (const code of ["storage_unavailable", "invalid_params"] as const) {
        for (const error of [false, true]) {
            test(`${code} is not answering without failing session start (error frame: ${error})`, async () => {
                const endpoint = await fakeEndpoint({ ...vectors[5].reply, code }, { error });
                const logs: string[] = [];
                for (let attempt = 0; attempt < 2; attempt++) {
                    expect(
                        await resolveEntorhinalProject(endpoint.folder, {
                            ...endpoint,
                            log: (message) => logs.push(message),
                        }),
                    ).toEqual({ status: "not_answering", reason: code });
                }
                if (code === "invalid_params" && !error) {
                    expect(logs).toHaveLength(1);
                    expect(logs[0]).toContain("invalid_params");
                }
                expect(endpoint.calls).toHaveLength(2);
            });
        }
    }

    test("a transport disconnect never fails session start", async () => {
        const endpoint = await fakeEndpoint(vectors[0].reply, { disconnect: true });
        expect(await resolveEntorhinalProject(endpoint.folder, endpoint)).toEqual({
            status: "not_answering",
            reason: "transport",
        });
        expect(endpoint.calls).toHaveLength(1);
    });

    test("unknown via plus an extra field falls back and logs once per value", async () => {
        const logs: string[] = [];
        for (const via of ["future-root", "future-root", "future-walk"]) {
            const endpoint = await fakeEndpoint(mutatedRoot({ via, futureField: true }));
            const result = await resolveEntorhinalProject(endpoint.folder, {
                ...endpoint,
                log: (message) => logs.push(message),
            });
            expect(result).toEqual({ status: "not_answering", reason: "unknown_via" });
            const fallback = "git:unchanged-session";
            expect(result.status === "resolved" ? result.projectId : fallback).toBe(fallback);
        }
        expect(logs).toHaveLength(2);
        expect(logs[0]).toContain("future-root");
        expect(logs[1]).toContain("future-walk");
    });

    for (const [name, reply, raw] of [
        ["invalid JSON", "{", true],
        ["numeric projectId", mutatedRoot({ projectId: 42 }), false],
        ["invalid projectId grammar", mutatedRoot({ projectId: "git:wrong" }), false],
        [
            "implicit id on registered via",
            mutatedRoot({ projectId: "pj-implicit1-forbidden" }),
            false,
        ],
        ["missing generation", mutatedRoot({ generation: undefined }), false],
        ["invalid nullable field", mutatedRoot({ canonicalRoot: 42 }), false],
    ] as const) {
        test(`decode failure (${name}) is not answering and logs once`, async () => {
            const endpoint = await fakeEndpoint(reply, { raw });
            const logs: string[] = [];
            for (let attempt = 0; attempt < 2; attempt++) {
                expect(
                    await resolveEntorhinalProject(endpoint.folder, {
                        ...endpoint,
                        log: (message) => logs.push(message),
                    }),
                ).toEqual({ status: "not_answering", reason: "decode" });
            }
            expect(logs).toHaveLength(1);
        });
    }

    for (const stall of ["connect", "route", "reply"] as const) {
        test(`the 500 ms whole-attempt deadline bounds a never-completing ${stall}`, async () => {
            const endpoint = await fakeEndpoint(vectors[0].reply, { stall });
            expect(ENTORHINAL_RESOLVE_DEADLINE_MS).toBe(500);
            const start = performance.now();
            expect(await resolveEntorhinalProject(endpoint.folder, endpoint)).toEqual({
                status: "not_answering",
                reason: "deadline",
            });
            expect(performance.now() - start).toBeGreaterThanOrEqual(450);
            expect(performance.now() - start).toBeLessThan(900);
            expect(endpoint.calls.length).toBeLessThanOrEqual(1);
        });
    }

    test("connect and reply share a single deadline; late replies publish and write nothing", async () => {
        const endpoint = await fakeEndpoint(vectors[0].reply, { authDelay: 300, replyDelay: 300 });
        const before = readdirSync(endpoint.folder);
        const published: string[] = [];
        const start = performance.now();
        const result = await resolveEntorhinalProject(endpoint.folder, endpoint).then(
            (decision) => {
                if (decision.status === "resolved") {
                    published.push(decision.projectId);
                    writeFileSync(join(endpoint.folder, "pin.json"), JSON.stringify(decision));
                }
                return decision;
            },
        );
        expect(result).toEqual({ status: "not_answering", reason: "deadline" });
        expect(performance.now() - start).toBeLessThan(900);
        await endpoint.delay(250);
        expect(published).toEqual([]);
        expect(readdirSync(endpoint.folder)).toEqual(before);
        expect(endpoint.calls).toHaveLength(1);
    });
});
