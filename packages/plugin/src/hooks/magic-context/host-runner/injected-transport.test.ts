import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { SubcClient } from "@cortexkit/subc-client";
import * as logger from "../../../shared/logger";
import { SubcModuleTransport } from "../module-transport";
import type { BridgeTransport, BridgeTransportError } from "./bridge-types";
import { InjectedBridgeTransport } from "./injected-transport";

afterEach(() => mock.restore());
const args = {
    sessionId: "session",
    projectRoot: "/tmp",
    method: "session.status" as const,
    body: { v: 1, session_id: "session" },
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

test("injected request payloads are byte-identical to direct subc frames for provider and management calls", async () => {
    const directFrames: Uint8Array[] = [];
    spyOn(SubcClient, "connect").mockResolvedValue({
        routeOpen: async () => ({ channel: 1, epoch: 1 }),
        request: async (_route: unknown, body: Uint8Array) => {
            directFrames.push(body.slice());
            return {};
        },
        close() {},
    } as any);
    const direct = new SubcModuleTransport("/tmp/unused.json");
    const relayFrames: Uint8Array[] = [];
    const relay = new InjectedBridgeTransport({
        async request(_method, body) {
            relayFrames.push(body.slice());
            return bytes({});
        },
    });
    try {
        for (const body of [
            args.body,
            { method: "state_sync", messages: [], pass_complete: true },
            Buffer.from(
                '{"method":"transform.hook", "params":{"message":{"n":1.00,"text":"\\u00e9"}}}',
            ),
            { name: "ctx_note", arguments: { text: "hello" } },
        ]) {
            await direct.call({ ...args, body });
            await relay.call({ ...args, body });
        }
        expect(relayFrames).toEqual(directFrames);
        expect(relayFrames).toHaveLength(4);
    } finally {
        direct.close();
        relay.close();
    }
});

test("injected transport assembles pages locally with one frame per request and one deadline", async () => {
    const text = JSON.stringify({ result: "é".repeat(100) });
    const id = createHash("sha256").update(text).digest("hex");
    const chunks = [text.slice(0, 20), text.slice(20)];
    const calls: { method: string; body: Uint8Array; deadlineMs: number }[] = [];
    const transport = new InjectedBridgeTransport({
        async request(method, body, opts) {
            const index = calls.length;
            calls.push({ method, body, deadlineMs: opts.deadlineMs });
            return bytes({
                reply_page: {
                    id,
                    index,
                    total: 2,
                    bytes: Buffer.byteLength(text),
                    data: chunks[index],
                },
            });
        },
    });
    expect(await transport.call(args)).toEqual(JSON.parse(text));
    expect(calls.map((c) => c.method)).toEqual(["session.status", "reply.page"]);
    expect(calls[1].body).toEqual(
        bytes({ method: "reply.page", reply_page_id: id, reply_page_index: 1 }),
    );
    expect(calls[1].deadlineMs).toBe(calls[0].deadlineMs);
});

test("injected module errors pass through unchanged", async () => {
    const error: BridgeTransportError = {
        source: "module",
        code: "host_lane_scope_missing",
        message: "Scope required",
    };
    const transport = new InjectedBridgeTransport({
        async request() {
            throw error;
        },
    });
    await expect(transport.call(args)).rejects.toBe(error);
});

for (const code of ["relay_unavailable", "session_scope_missing", "deadline", "aborted"] as const) {
    test(`injected relay ${code} is logged with its code`, async () => {
        const log = spyOn(logger, "sessionLog").mockImplementation(() => {});
        const error: BridgeTransportError = { source: "relay", code };
        const transport = new InjectedBridgeTransport({
            async request() {
                throw error;
            },
        });
        await expect(transport.call(args)).rejects.toBe(error);
        expect(log).toHaveBeenCalledWith("session", `bridge relay transport refused: ${code}`);
    });
}

test("injected transport enforces a deadline even when the relay ignores it", async () => {
    let signal: AbortSignal | undefined;
    const request: BridgeTransport["request"] = async (_method, _body, opts) => {
        signal = opts.signal;
        return new Promise(() => {});
    };
    const transport = new InjectedBridgeTransport({ request });
    await expect(transport.call({ ...args, timeoutMs: 10 })).rejects.toEqual({
        source: "relay",
        code: "deadline",
    });
    expect(signal?.aborted).toBe(true);
});

test("injected transport aborts in flight and never issues an already aborted call", async () => {
    const request = mock<BridgeTransport["request"]>(async () => new Promise(() => {}));
    const transport = new InjectedBridgeTransport({ request });
    const abort = new AbortController();
    const pending = transport.call({ ...args, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toEqual({ source: "relay", code: "aborted" });
    await expect(transport.call({ ...args, signal: abort.signal })).rejects.toEqual({
        source: "relay",
        code: "aborted",
    });
    expect(request).toHaveBeenCalledTimes(1);
});
