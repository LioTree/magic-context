import {
    observeProviderRpc,
    startProviderRpc,
} from "../../../features/magic-context/provider-meters";
import { sessionLog } from "../../../shared/logger";
import { isRecord } from "../../../shared/record-type-guard";
import { moduleRequestBody, type SubcModuleTransport } from "../module-transport";
import { assembleReplyPages } from "../reply-pages";
import type { ModuleSessionClient } from "../module-session-kernel";
import { singleStoreMigrationRequiredFailure } from "../single-store-refusal";
import { storeAheadOfBinaryFailure } from "../store-ahead-refusal";
import type { BridgeTransport, BridgeTransportError } from "./bridge-types";

/** Keep the relay opaque: each request carries one unchanged subc payload, including reply.page. */
export class InjectedBridgeTransport implements ModuleSessionClient {
    private closed = false;
    private capabilities: { state_sync_deltas?: boolean; state_sync_resume?: boolean } | undefined;

    constructor(private readonly transport: BridgeTransport) {}

    getCachedStateSyncCapabilities() {
        return this.capabilities;
    }

    invalidateStateSyncCapabilities() {
        this.capabilities = undefined;
    }

    async stateSyncCapabilities(args: { sessionId: string; projectRoot: string }) {
        if (this.capabilities) return this.capabilities;
        const response = await this.call({
            ...args,
            method: "session.status",
            body: { method: "session.status", v: 1, session_id: args.sessionId },
        });
        const raw = isRecord(response) ? response : {};
        const value = isRecord(raw.result) ? raw.result : raw;
        const epochs = isRecord(value.epochs) ? value.epochs : {};
        this.capabilities = {
            state_sync_deltas: epochs.state_sync_deltas === true,
            ...(epochs.state_sync_resume === true ? { state_sync_resume: true } : {}),
        };
        return this.capabilities;
    }

    async call(args: Parameters<SubcModuleTransport["call"]>[0]): Promise<unknown> {
        if (this.closed) throw new Error("Module transport is closed");
        const body =
            args.body instanceof Uint8Array
                ? args.body
                : Buffer.from(JSON.stringify(moduleRequestBody(args.body, args.method)));
        const deadlineMs = Date.now() + (args.timeoutMs ?? 15_000);
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => {
            onAbort = () => {
                abort.abort(args.signal?.reason);
                reject({ source: "relay", code: "aborted" } satisfies BridgeTransportError);
            };
            args.signal?.addEventListener("abort", onAbort, { once: true });
            timer = setTimeout(
                () => {
                    abort.abort();
                    reject({ source: "relay", code: "deadline" } satisfies BridgeTransportError);
                },
                Math.max(0, deadlineMs - Date.now()),
            );
        });
        const request = async (method: string, payload: Uint8Array) => {
            if (args.signal?.aborted) onAbort();
            if (abort.signal.aborted) return await cancelled;
            if (Date.now() >= deadlineMs)
                throw { source: "relay", code: "deadline" } satisfies BridgeTransportError;
            const rpc = startProviderRpc(method, payload);
            const reply = await Promise.race([
                cancelled,
                observeProviderRpc(
                    rpc,
                    this.transport.request(method, payload, {
                        deadlineMs,
                        signal: abort.signal,
                    }),
                ),
            ]);
            // A response arriving after the deadline must not become a served view, even if the relay ignores cancellation.
            if (Date.now() >= deadlineMs)
                throw { source: "relay", code: "deadline" } satisfies BridgeTransportError;
            return JSON.parse(Buffer.from(reply).toString("utf8")) as unknown;
        };
        try {
            const response = await request(args.method, body);
            return await assembleReplyPages(response, (id, index) =>
                request(
                    "reply.page",
                    Buffer.from(
                        JSON.stringify({
                            method: "reply.page",
                            reply_page_id: id,
                            reply_page_index: index,
                        }),
                    ),
                ),
            );
        } catch (error) {
            if (isRecord(error) && error.source === "relay") {
                sessionLog(args.sessionId, `bridge relay transport refused: ${error.code}`);
            }
            throw (
                singleStoreMigrationRequiredFailure(error) ??
                storeAheadOfBinaryFailure(error) ??
                error
            );
        } finally {
            clearTimeout(timer);
            args.signal?.removeEventListener("abort", onAbort);
        }
    }

    close() {
        // The host owns the relay; disposal marks this bridge instance closed without closing the relay.
        this.closed = true;
        this.invalidateStateSyncCapabilities();
    }
}
