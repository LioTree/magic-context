/**
 * A loopback relay that lets the throwaway OpenCode host reach Cloud Code Assist (the Antigravity
 * subscription) without an OpenCode auth plugin or a stored OpenCode login.
 *
 * OpenCode's `@ai-sdk/google` provider speaks the public Gemini API:
 *
 *   POST {baseURL}/models/{model}:streamGenerateContent?alt=sse   body = GenerateContentRequest
 *
 * Cloud Code Assist takes the same request wrapped in an envelope:
 *
 *   POST {upstream}/v1internal:streamGenerateContent?alt=sse
 *   body = { model, project, request: GenerateContentRequest, requestType, userAgent, requestId }
 *
 * and answers each SSE event (or the whole JSON reply) wrapped as `{ response: ... }`.
 *
 * The relay does exactly that and nothing else:
 *
 * - the host's body becomes `request` unchanged (`contents`, `systemInstruction`, `tools`,
 *   `toolConfig`, `generationConfig` and any other field pass through as equal JSON);
 * - each upstream `{ response: X }` event is sent back as `X`, other events unchanged;
 * - the host must present the per-run random key it was configured with; the real upstream token is
 *   held only in this process's memory and is sent only to the upstream;
 * - the log records method, path, status, duration, byte counts and the upstream's token counts;
 *   only failed upstream responses include a body, with credentials scrubbed before logging.
 *
 * The route table is keyed by path prefix, so a second upstream (for example the ChatGPT Codex
 * backend) can be added as another route under the same rules.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { CredentialError, scrub } from "./credentials";

export interface RelayLogEntry {
    route: string;
    method: string;
    path: string;
    status: number;
    durationMs: number;
    bytesIn: number;
    bytesOut: number;
    /** Token counts from the upstream's `usageMetadata` (the last one seen), for the budget. */
    inputTokens: number;
    outputTokens: number;
    /** Sanitized upstream body for non-2xx responses; successful bodies are never logged. */
    errorBody?: string;
}

export interface CloudCodeRoute {
    kind: "cloud-code";
    /** Host-facing path prefix, e.g. `/gemini/v1beta`. */
    prefix: string;
    /** Upstream origin, e.g. `https://cloudcode-pa.googleapis.com`. */
    upstream: string;
    /** Returns the current upstream bearer; called per request so the token never sits in config. */
    token: () => string | Promise<string>;
    project: string;
}

export interface RelayOptions {
    routes: CloudCodeRoute[];
    /** All credential versions seen during the run, resolved when an error is logged. */
    secrets?: () => string[];
    /** Called once when the upstream rejects the credential (HTTP 401 or 403). */
    onAuthRejected?: (route: string, status: number) => void;
}

export interface Relay {
    /** `http://127.0.0.1:<port>`. */
    origin: string;
    /** The random key the host must send; it is worthless outside this relay. */
    hostKey: string;
    log: RelayLogEntry[];
    /** Set once an upstream answered 401 or 403; the harness stops the run on it. */
    authRejected: { route: string; status: number } | null;
    /** A vault refusal is terminal, even if the host retries its HTTP request. */
    credentialError: CredentialError | null;
    stop(): void;
}

const GEMINI_METHOD = /\/models\/([^/:]+):(streamGenerateContent|generateContent)$/;

/** The Cloud Code Assist envelope around one Gemini request. */
export function wrapCloudCodeRequest(
    model: string,
    project: string,
    request: unknown,
): Record<string, unknown> {
    return {
        model,
        project,
        request,
        requestType: "agent",
        userAgent: "antigravity",
        requestId: `agent-${randomUUID()}`,
    };
}

/** One upstream SSE `data:` payload as the host expects it: the `response` field when present. */
export function unwrapCloudCodeEvent(data: string): string {
    const trimmed = data.trim();
    if (!trimmed || trimmed === "[DONE]") return data;
    try {
        const parsed = JSON.parse(trimmed) as { response?: unknown };
        if (parsed && typeof parsed === "object" && "response" in parsed)
            return JSON.stringify(parsed.response);
    } catch {
        // Not JSON: pass it through untouched.
    }
    return data;
}

/** Copy the token counts out of one unwrapped Gemini reply, if it carries them. */
function readUsage(data: string, entry: RelayLogEntry): void {
    try {
        const usage = (
            JSON.parse(data) as {
                usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
            }
        ).usageMetadata;
        if (usage?.promptTokenCount !== undefined) entry.inputTokens = usage.promptTokenCount;
        if (usage?.candidatesTokenCount !== undefined)
            entry.outputTokens = usage.candidatesTokenCount;
    } catch {
        // Not JSON: nothing to count.
    }
}

/** Rewrite an SSE stream event by event, unwrapping each `data:` line. */
function unwrapSseStream(
    body: ReadableStream<Uint8Array>,
    entry: RelayLogEntry,
): ReadableStream<Uint8Array> {
    const count = (bytes: number) => (entry.bytesOut += bytes);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    const transformLine = (line: string) => {
        if (!line.startsWith("data:")) return line;
        const data = unwrapCloudCodeEvent(line.slice(5));
        readUsage(data, entry);
        return `data: ${data}`;
    };
    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                buffer += decoder.decode(chunk, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                const out = lines
                    .map((line) => `${transformLine(line.replace(/\r$/, ""))}\n`)
                    .join("");
                if (out) {
                    const bytes = encoder.encode(out);
                    count(bytes.byteLength);
                    controller.enqueue(bytes);
                }
            },
            flush(controller) {
                buffer += decoder.decode();
                if (buffer) {
                    const bytes = encoder.encode(transformLine(buffer));
                    count(bytes.byteLength);
                    controller.enqueue(bytes);
                }
            },
        }),
    );
}

export function startRelay(options: RelayOptions): Relay {
    const hostKey = randomBytes(32).toString("hex");
    const log: RelayLogEntry[] = [];
    const relay: Relay = {
        origin: "",
        hostKey,
        log,
        authRejected: null,
        credentialError: null,
        stop: () => server.stop(true),
    };

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
            const started = Date.now();
            const url = new URL(request.url);
            const route = options.routes.find((candidate) =>
                url.pathname.startsWith(candidate.prefix),
            );
            const entry: RelayLogEntry = {
                route: route?.kind ?? "none",
                method: request.method,
                path: url.pathname,
                status: 0,
                durationMs: 0,
                bytesIn: 0,
                bytesOut: 0,
                inputTokens: 0,
                outputTokens: 0,
            };
            const finish = (response: Response) => {
                entry.status = response.status;
                entry.durationMs = Date.now() - started;
                log.push(entry);
                return response;
            };
            if (!route) return finish(new Response("no route", { status: 404 }));
            const presented =
                request.headers.get("x-goog-api-key") ??
                request.headers.get("authorization")?.replace(/^Bearer /, "");
            if (presented !== hostKey) return finish(new Response("unauthorized", { status: 401 }));
            if (relay.authRejected)
                return finish(
                    new Response("upstream credential rejected earlier", { status: 403 }),
                );
            if (relay.credentialError)
                return finish(new Response("credential refresh refused", { status: 403 }));

            const method = GEMINI_METHOD.exec(url.pathname.slice(route.prefix.length));
            if (request.method !== "POST" || !method)
                return finish(new Response("unsupported", { status: 404 }));
            const [, model, action] = method as unknown as [string, string, string];
            const text = await request.text();
            entry.bytesIn = Buffer.byteLength(text);
            const hostBody = JSON.parse(text) as unknown;
            const upstreamUrl = `${route.upstream}/v1internal:${action}${action === "streamGenerateContent" ? "?alt=sse" : ""}`;
            let token: string;
            try {
                token = await route.token();
            } catch (error) {
                if (!(error instanceof CredentialError)) throw error;
                relay.credentialError = error;
                return finish(new Response("credential refresh refused", { status: 403 }));
            }
            const upstream = await fetch(upstreamUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${token}`,
                    ...(action === "streamGenerateContent" ? { accept: "text/event-stream" } : {}),
                },
                body: JSON.stringify(wrapCloudCodeRequest(model, route.project, hostBody)),
                signal: request.signal,
            });
            if (upstream.status === 401 || upstream.status === 403) {
                relay.authRejected = { route: route.kind, status: upstream.status };
                options.onAuthRejected?.(route.kind, upstream.status);
            }
            const headers = {
                "content-type": upstream.headers.get("content-type") ?? "application/json",
            };
            if (!upstream.ok || !upstream.body) {
                const errorText = await upstream.text();
                const sanitized = scrub(errorText, [
                    token,
                    hostKey,
                    ...(options.secrets?.() ?? []),
                ]);
                if (!upstream.ok) entry.errorBody = sanitized;
                entry.bytesOut = Buffer.byteLength(sanitized);
                return finish(new Response(sanitized, { status: upstream.status, headers }));
            }
            if (action === "streamGenerateContent") {
                const stream = unwrapSseStream(upstream.body, entry);
                return finish(new Response(stream, { status: upstream.status, headers }));
            }
            const unwrapped = unwrapCloudCodeEvent(await upstream.text());
            readUsage(unwrapped, entry);
            entry.bytesOut = Buffer.byteLength(unwrapped);
            return finish(new Response(unwrapped, { status: upstream.status, headers }));
        },
    });
    relay.origin = `http://127.0.0.1:${server.port}`;
    return relay;
}
