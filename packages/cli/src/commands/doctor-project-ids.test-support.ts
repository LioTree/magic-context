import { chmodSync, writeFileSync } from "node:fs";
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
import vectors from "../../../../test-vectors/project-resolve-v1/resolve.json";

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
        return { header, body: JSON.parse((await this.bytes(header.len)).toString("utf8")) };
    }
}

function reply(socket: Socket, request: EnvelopeHeader, body: unknown): void {
    socket.write(
        encodeFrame(
            buildFrame(
                FrameType.Response,
                buildFlags(false, Priority.Interactive, false),
                request.channel,
                request.epoch,
                request.corr,
                Buffer.from(JSON.stringify(body)),
            ),
        ),
    );
}

/**
 * Fake daemon that authenticates the subc client and serves saved Entorhinal replies.
 * The unknown-via folder changes the reply's via field to simulate a newer protocol value.
 */
export async function fakeProjectEndpoint(root: string) {
    const connectionFile = join(root, "connection.json");
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const daemonId = Uint8Array.from({ length: 16 }, (_, index) => index + 100);
    const serverNonce = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
    const sockets = new Set<Socket>();
    const calls: string[] = [];
    const failures: unknown[] = [];
    const rootReply = vectors[0].reply;
    const implicitReply = vectors[3].reply;
    const projectId = rootReply.result?.projectId;
    if (!projectId) throw new Error("Missing vendored registered project");
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        void (async () => {
            const reader = new PeerReader(socket);
            const hello = await reader.auth();
            const clientNonce = Uint8Array.from(hello.client_nonce as number[]);
            const body = Buffer.from(
                JSON.stringify({
                    server_nonce: [...serverNonce],
                    daemon_id: [...daemonId],
                    server_proof: [
                        ...computeProof(
                            key,
                            SERVER_PROOF_DOMAIN,
                            clientNonce,
                            serverNonce,
                            daemonId,
                        ),
                    ],
                }),
            );
            const length = Buffer.alloc(4);
            length.writeUInt32LE(body.length);
            socket.write(Buffer.concat([length, body]));
            await reader.auth();
            const route = await reader.frame();
            reply(socket, route.header, { route_channel: 7, route_epoch: 77 });
            const call = await reader.frame();
            const directory = (call.body as { params: { canonicalRoot: string } }).params
                .canonicalRoot;
            calls.push(directory);
            const answer = structuredClone(
                directory.endsWith("/implicit") ? implicitReply : rootReply,
            );
            if (directory.endsWith("/unknown-via") && answer.result)
                Object.assign(answer.result, { via: "future-via", futureField: true });
            reply(socket, call.header, answer);
        })().catch((error) => {
            if (!socket.destroyed) failures.push(error);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fake subc port");
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
    return {
        connectionFile,
        projectId,
        calls,
        failures,
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
