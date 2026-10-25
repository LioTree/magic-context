import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { UsageStep } from "../two-pass-live-replay/artifact-schema";
import type { CallBound, CallMeter } from "./activation-driver";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
    value !== null && typeof value === "object" ? (value as Json) : {};

function tokens(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new Error("invalid_provider_usage");
    return value;
}

/** Parse each provider response event so usage from every step is retained. */
export function providerUsage(body: string, contentType: string): UsageStep[] | undefined {
    const payloads: Json[] = [];
    if (contentType.includes("text/event-stream")) {
        for (const event of body.split(/\r?\n\r?\n/)) {
            const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart()).join("\n");
            if (data && data !== "[DONE]") payloads.push(object(JSON.parse(data)));
        }
    } else {
        payloads.push(object(JSON.parse(body)));
    }
    const steps: UsageStep[] = [];
    let anthropicInput: number | undefined;
    for (const payload of payloads) {
        // Anthropic splits one step's input and output counters across two events.
        if (payload.type === "message_start") {
            const usage = object(object(payload.message).usage);
            anthropicInput = tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens ?? 0)
                + tokens(usage.cache_read_input_tokens ?? 0);
            continue;
        }
        if (payload.type === "message_delta" && anthropicInput !== undefined) {
            steps.push({ inputTokens: anthropicInput, outputTokens: tokens(object(payload.usage).output_tokens) });
            anthropicInput = undefined;
            continue;
        }
        const usage = object(payload.usage ?? object(payload.response).usage);
        if (usage.input_tokens !== undefined) {
            steps.push({
                inputTokens: tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens ?? 0)
                    + tokens(usage.cache_read_input_tokens ?? 0),
                outputTokens: tokens(usage.output_tokens),
            });
        } else if (usage.prompt_tokens !== undefined) {
            steps.push({ inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens) });
        }
    }
    return steps.length ? steps : undefined;
}

export function sumProviderSteps(steps: readonly UsageStep[]): UsageStep {
    return steps.reduce((total, step) => ({
        inputTokens: total.inputTokens + tokens(step.inputTokens),
        outputTokens: total.outputTokens + tokens(step.outputTokens),
    }), { inputTokens: 0, outputTokens: 0 });
}

export interface DispatchReceipt {
    reservation: number;
    request: { path: string; body: string };
    response: { status: number; body: string; contentType: string };
    steps?: UsageStep[];
}

/** A single boundary for foreground, historian, check, grader, and retry HTTP sends. */
export async function meteredDispatch(input: {
    meter: CallMeter;
    bound: CallBound;
    dispatch(): Promise<{ status: number; body: string; contentType: string }>;
}) {
    const reservation = input.meter.beforeSend(input.bound);
    const response = await input.dispatch();
    // Error responses without usage retain the reservation; they are not free calls.
    const steps = response.status < 400 ? providerUsage(response.body, response.contentType) : undefined;
    input.meter.settle(reservation, steps);
    return { reservation, response, steps };
}

/** Require a loopback upstream; the caller supplies the mock and disables external network access. */
export async function mockMeteringProxy(input: {
    upstream: string;
    meter: CallMeter;
    outputCeiling: number;
    classify(path: string, body: string): CallBound["kind"];
}) {
    const upstream = new URL(input.upstream);
    if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || upstream.username || upstream.password)
        throw new Error("mock_upstream_must_be_loopback");
    const receipts: DispatchReceipt[] = [];
    const failures: string[] = [];
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of request) {
                size += Buffer.byteLength(chunk);
                if (size > 16 * 1024 * 1024) throw new Error("provider_request_too_large");
                chunks.push(Buffer.from(chunk));
            }
            const body = Buffer.concat(chunks).toString("utf8");
            const path = request.url ?? "/";
            if (!path.startsWith("/") || path.startsWith("//")) throw new Error("invalid_provider_path");
            const target = new URL(upstream.href);
            target.pathname = `${upstream.pathname.replace(/\/$/, "")}${path.split("?")[0]}`;
            target.search = new URL(path, upstream).search;
            const bound: CallBound = {
                kind: input.classify(path, body), inputTokens: Buffer.byteLength(body),
                outputCeiling: input.outputCeiling, maxSteps: 1, hostRetries: 0,
            };
            const result = await meteredDispatch({
                meter: input.meter, bound,
                async dispatch() {
                    const reply = await fetch(target, {
                        method: request.method, headers: forwardHeaders(request.headers), body,
                        redirect: "error", signal: AbortSignal.timeout(120_000),
                    });
                    return { status: reply.status, body: await reply.text(), contentType: reply.headers.get("content-type") ?? "application/json" };
                },
            });
            receipts.push({ ...result, request: { path, body } });
            response.writeHead(result.response.status, { "content-type": result.response.contentType });
            response.end(result.response.body);
        } catch {
            failures.push("provider_dispatch_failed");
            response.writeHead(502).end("provider_dispatch_failed");
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        receipts, failures,
        close: () => new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
        }),
    };
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
    return Object.fromEntries(Object.entries(headers)
        .filter(([key, value]) => typeof value === "string" && !["host", "connection", "content-length", "authorization", "x-api-key"].includes(key))
        .map(([key, value]) => [key, value as string]));
}
