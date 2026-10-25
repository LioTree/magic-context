import { openSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";

/** The parent owns metering; this worker performs exactly one HTTP attempt per send. */
export async function anthropicSend(request: {
    model: string;
    maxOutputTokens: number;
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    tools: unknown[];
}, key: string, endpoint = "https://api.anthropic.com/v1/messages") {
    if (request.model !== "claude-sonnet-5-5" || request.tools.length)
        throw new Error("measurement_request_contract");
    const wire = {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: request.messages.map((message, index) => ({
            role: message.role,
            content: [{ type: "text", text: message.content,
                // Keep the first-turn breakpoint identical when appending the actual reply.
                ...(index === 0 ? { cache_control: { type: "ephemeral" } } : {}),
            }],
        })),
    };
    const reply = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key },
        body: JSON.stringify(wire),
    });
    if (!reply.ok) throw new Error(`anthropic_http_${reply.status}`);
    const body = await reply.json() as {
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };
    const usage = body.usage;
    const steps = usage?.input_tokens !== undefined && usage.output_tokens !== undefined ? [{
        inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
    }] : undefined;
    return { text: body.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
        usage, steps, metadata: { wireRequest: wire, response: body } };
}

if (import.meta.main) {
    const key = process.env.ANTHROPIC_API_KEY;
    const witness = process.env.TWO_PASS_WITNESS;
    if (!key || !witness) throw new Error("measurement_worker_environment");
    const fd = openSync(witness, "a", 0o600);
    const endpoint = process.env.TWO_PASS_MOCK_ANTHROPIC_ENDPOINT;
    if (endpoint) {
        const url = new URL(endpoint);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("mock_endpoint_not_loopback");
    }
    const lines = createInterface({ input: process.stdin });
    process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
    try {
        for await (const line of lines) {
            const input = JSON.parse(line);
            try {
                const result = await anthropicSend(input.request, key, endpoint);
                process.stdout.write(`${JSON.stringify({ id: input.id, result })}\n`);
            } catch {
                // Provider errors may echo credentials; the parent needs only a bounded failure.
                process.stdout.write(`${JSON.stringify({ id: input.id, error: "measurement_dispatch_failed" })}\n`);
            }
        }
    } finally { closeSync(fd); }
}
