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
import vectors from "../../../test-vectors/project-resolve-v1/resolve.json";

const registered = vectors[0].reply.result;
if (!registered) throw new Error("Registered root vector has no result");
export const registeredProjectId = registered.projectId;

class PeerReader {
	private buffered = Buffer.alloc(0);
	private readonly iterator: AsyncIterator<Uint8Array>;
	constructor(socket: Socket) {
		this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
	}
	async bytes(length: number): Promise<Buffer> {
		while (this.buffered.length < length) {
			const next = await this.iterator.next();
			if (next.done) throw new Error("Fake peer closed");
			this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
		}
		const bytes = this.buffered.subarray(0, length);
		this.buffered = this.buffered.subarray(length);
		return bytes;
	}
	async auth(): Promise<Record<string, unknown>> {
		return JSON.parse(
			(await this.bytes((await this.bytes(4)).readUInt32LE())).toString(),
		);
	}
	async frame(): Promise<{
		header: EnvelopeHeader;
		body: Record<string, unknown>;
	}> {
		const header = decodeHeader(await this.bytes(HEADER_LEN));
		return {
			header,
			body: JSON.parse((await this.bytes(header.len)).toString()),
		};
	}
}

export async function createIdentityPeer(root: string, directory: string) {
	const connectionFile = join(root, "non-default-subc.json");
	const key = new Uint8Array(32).fill(9);
	const daemonId = new Uint8Array(16).fill(7);
	const serverNonce = new Uint8Array(32).fill(5);
	const sockets = new Set<Socket>();
	const reply = structuredClone(vectors[0].reply);
	if (!reply.result) throw new Error("Registered root vector has no result");
	reply.result.canonicalRoot = directory;
	const fake = {
		connectionFile,
		up: true,
		delayMs: 0,
		calls: [] as Record<string, unknown>[],
		onResolve: () => {},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
	function send(socket: Socket, request: EnvelopeHeader, body: unknown) {
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
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		void (async () => {
			const reader = new PeerReader(socket);
			const hello = await reader.auth();
			const bytes = Buffer.from(
				JSON.stringify({
					server_nonce: [...serverNonce],
					daemon_id: [...daemonId],
					server_proof: [
						...computeProof(
							key,
							SERVER_PROOF_DOMAIN,
							Uint8Array.from(hello.client_nonce as number[]),
							serverNonce,
							daemonId,
						),
					],
				}),
			);
			const size = Buffer.alloc(4);
			size.writeUInt32LE(bytes.length);
			socket.write(Buffer.concat([size, bytes]));
			await reader.auth();
			let channel = 7;
			while (!socket.destroyed) {
				const call = await reader.frame();
				if (call.body.op === "route.open") {
					send(socket, call.header, {
						route_channel: channel++,
						route_epoch: 77,
					});
					continue;
				}
				if (call.body.method !== "resolve") {
					send(socket, call.header, {});
					continue;
				}
				fake.calls.push(call.body);
				fake.onResolve();
				if (!fake.up) {
					socket.destroy();
					return;
				}
				if (fake.delayMs)
					await new Promise<void>((resolve) =>
						setTimeout(resolve, fake.delayMs),
					);
				if (!socket.destroyed) send(socket, call.header, reply);
			}
		})().catch(() => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fake endpoint address");
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
	return fake;
}
