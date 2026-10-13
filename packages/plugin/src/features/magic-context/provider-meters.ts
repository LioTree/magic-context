import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** A pass owns its counters even when another session awaits a module response. */
export interface ProviderPassMeters {
    pass_id: string;
    session_id: string;
    host: string;
    host_version: string | null;
    pipeline: "provider" | "full_request";
    partial_fields: string[];
    pass_kind: "ordinary" | "bootstrap" | "rebuild" | "exit" | "refused";
    appended: number;
    hook_count: number;
    rpc_count: number;
    rpc_request_bytes: number;
    rpc_response_json_bytes: number;
    fallback_count: number;
    recovery_count: number;
    retry_count: number;
    rebuild_count: number;
    historian_pump_count: number;
    ingest_json_bytes: number;
    hook_ops_json_bytes: number;
    host_state_bytes: number;
    host_view_bytes: number;
    host_logical_payload_bytes: number;
    stages: Record<string, number>;
    requests: {
        method: string;
        request_id: string | null;
        transport_ms: number | null;
        status: string;
    }[];
    pass_ms: number;
}

const active = new AsyncLocalStorage<ProviderPassMeters>();
export const currentProviderMeters = () => active.getStore();
export const jsonBytes = (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
export const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

export async function meterProviderStage<T>(
    name: string,
    action: () => T | Promise<T>,
): Promise<T> {
    const meters = active.getStore();
    const start = performance.now();
    try {
        return await action();
    } finally {
        if (meters) meters.stages[name] = (meters.stages[name] ?? 0) + performance.now() - start;
    }
}

/** Count encoded module requests before sending them, using the same helper as the real transport. */
export function meterProviderRpc<T>(
    method: string,
    body: unknown,
    action: () => Promise<T>,
): Promise<T> {
    if (!active.getStore()) return action();
    const bytes =
        body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
    const token = startProviderRpc(method, bytes);
    try {
        return observeProviderRpc(token, action());
    } catch (error) {
        return observeProviderRpc(token, Promise.reject(error));
    }
}

export async function withProviderMeters<T>(
    sessionId: string,
    host: string,
    hostVersion: string | null,
    action: () => Promise<T>,
    emit: (meters: ProviderPassMeters) => void,
): Promise<T> {
    if (active.getStore()?.session_id === sessionId) return action();
    const meters: ProviderPassMeters = {
        pass_id: randomUUID(),
        session_id: sessionId,
        host,
        host_version: hostVersion,
        pipeline: "provider",
        partial_fields: [
            "host_logical_payload_bytes: structural flag and lineage updates excluded",
            "rpc_response_json_bytes: decoded logical JSON, not raw wire frames",
            "module store rows: provider result-row subset; engine and state-sync unavailable",
            "background_delta_bytes and background_page_rows: unavailable",
            "host_version: collector required",
        ],
        pass_kind: "ordinary",
        appended: 0,
        hook_count: 0,
        rpc_count: 0,
        rpc_request_bytes: 0,
        rpc_response_json_bytes: 0,
        fallback_count: 0,
        recovery_count: 0,
        retry_count: 0,
        rebuild_count: 0,
        historian_pump_count: 0,
        ingest_json_bytes: 0,
        hook_ops_json_bytes: 0,
        host_state_bytes: 0,
        host_view_bytes: 0,
        host_logical_payload_bytes: 0,
        stages: {},
        requests: [],
        pass_ms: 0,
    };
    const start = performance.now();
    return active.run(meters, async () => {
        try {
            return await action();
        } catch (error) {
            meters.pass_kind = "refused";
            throw error;
        } finally {
            meters.pass_ms = performance.now() - start;
            emit(meters);
        }
    });
}

interface HostWriteLedger {
    appended: number;
    ingest: number;
    ops: number;
    actual: number;
    state: number;
    view: number;
}
const hostWrites = new AsyncLocalStorage<HostWriteLedger>();

/** Merge host write counters only after the transaction commits; if it throws, discard its local byte ledger. */
export function withProviderHostWrites<T>(action: () => T): T {
    const meters = active.getStore();
    if (!meters) return action();
    const writes: HostWriteLedger = {
        appended: 0,
        ingest: 0,
        ops: 0,
        actual: 0,
        state: 0,
        view: 0,
    };
    const result = hostWrites.run(writes, action);
    meters.appended += writes.appended;
    meters.ingest_json_bytes += writes.ingest;
    meters.hook_ops_json_bytes += writes.ops;
    meters.host_logical_payload_bytes += writes.actual;
    meters.host_state_bytes += writes.state;
    meters.host_view_bytes += writes.view;
    return result;
}

export function recordProviderHostWrite(values: readonly unknown[], kind?: "state" | "view"): void {
    const writes = hostWrites.getStore();
    if (!writes) return;
    let bytes = 0;
    for (const value of values) {
        if (value !== null && value !== undefined)
            bytes += value instanceof Uint8Array ? value.byteLength : utf8Bytes(String(value));
    }
    writes.actual += bytes;
    if (kind) writes[kind] += bytes;
}

export function recordProviderAdmission(ingest: string, ops: string): void {
    const writes = hostWrites.getStore();
    if (!writes) return;
    writes.appended++;
    writes.ingest += utf8Bytes(ingest);
    writes.ops += utf8Bytes(ops);
}

export function meterProviderCall<T>(method: string, action: () => Promise<T>): Promise<T> {
    const meters = active.getStore();
    if (meters && method === "transform.hook") meters.hook_count++;
    return action();
}

/** The module client returns decoded objects. Response bytes measure their JSON encoding, not the original bytes received on the socket. */
export function startProviderRpc(method: string, body: Uint8Array) {
    const meters = active.getStore();
    if (!meters) return undefined;
    meters.rpc_count++;
    meters.rpc_request_bytes += body.byteLength;
    let requestId: string | null = null;
    try {
        const wire = JSON.parse(new TextDecoder().decode(body));
        if (typeof wire?.params?.request_id === "string") requestId = wire.params.request_id;
    } catch {
        // If the body is not valid JSON, leave its ID unset and let the transport handle the input.
        meters.partial_fields.push("request_id: encoded body is not JSON");
    }
    const row = {
        method,
        request_id: requestId,
        transport_ms: null as number | null,
        status: "pending",
    };
    meters.requests.push(row);
    return { meters, row, start: performance.now() };
}
export function observeProviderRpc<T>(
    token: ReturnType<typeof startProviderRpc>,
    request: Promise<T>,
): Promise<T> {
    if (!token) return request;
    return request.then(
        (response) => {
            try {
                token.meters.rpc_response_json_bytes += jsonBytes(response);
            } catch {
                token.meters.partial_fields.push(
                    "rpc_response_json_bytes: response cannot be JSON encoded",
                );
            }
            token.row.status = "response";
            token.row.transport_ms = performance.now() - token.start;
            return response;
        },
        (error) => {
            token.row.status = "error";
            token.row.transport_ms = performance.now() - token.start;
            throw error;
        },
    );
}

export function withoutProviderMeters<T>(action: () => T): T {
    return active.exit(action);
}
