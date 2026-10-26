import { normalizeEvidenceWhitespace } from "../../src/features/magic-context/memory/turn-two-verifier";
import type { PlannedReplay } from "./replay";

/** Deliberately mixed decisions exercise the fence; these are not model-quality measurements. */
export function replayMockReply(p: PlannedReplay): string {
    const decisions = p.facts.map((f, i) => {
        const quote = normalizeEvidenceWhitespace(f.blocks[0]?.parts.join(" / ") ?? "").slice(
            0,
            120,
        );
        const decision = {
            fact_id: f.factId,
            action: "new",
            evidence_quote: quote,
            status: "settled",
            reversed_by: "",
        };
        if (p.prompt === "control") return { fact_id: f.factId, action: "new" };
        switch (i % 6) {
            case 0:
                return decision;
            case 1:
                return {
                    ...decision,
                    evidence_quote:
                        "A quote copied only from neighbouring memory, not the fact's blocks.",
                };
            case 2:
                return { ...decision, evidence_quote: "tiny" };
            case 3:
                return { ...decision, status: "planned" };
            case 4:
                return { ...decision, reversed_by: "Later source reverses this statement." };
            default:
                return { fact_id: f.factId, action: "abstain", status: "hypothesis" };
        }
    });
    return JSON.stringify({ result: { step: "turn_two", decisions, scores: [] } });
}

export function replayMockServer(
    plan: PlannedReplay[],
    options: { status?: number; error?: string; retryOnce?: boolean } = {},
) {
    let active = 0,
        maxActive = 0;
    const requests: Array<{ path: string; body: unknown }> = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            active++;
            maxActive = Math.max(maxActive, active);
            try {
                const path = new URL(request.url).pathname;
                const body = (await request.json()) as {
                    messages: Array<{ role: string; content: string | Array<{ text: string }> }>;
                };
                requests.push({ path, body });
                if (options.status || (options.retryOnce && requests.length === 1))
                    return Response.json(
                        { error: options.error ?? "rate limit" },
                        { status: options.status ?? 429, headers: { "retry-after": "0" } },
                    );
                if (
                    request.method !== "POST" ||
                    !["/chat/completions", "/v1/messages"].includes(path)
                )
                    return new Response("not found", { status: 404 });
                const last = body.messages.at(-1)?.content;
                const text = typeof last === "string" ? last : last?.map((b) => b.text).join("");
                const p = plan.find((p) => p.request.messages.at(-1)?.content === text);
                if (!p) return new Response("unbound mock request", { status: 400 });
                const reply = replayMockReply(p);
                if (path === "/v1/messages")
                    return Response.json({
                        id: "mock",
                        type: "message",
                        role: "assistant",
                        stop_reason: "end_turn",
                        content: [{ type: "text", text: reply }],
                        usage: {
                            input_tokens: 100,
                            output_tokens: 100,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                    });
                return Response.json({
                    choices: [
                        { finish_reason: "stop", message: { role: "assistant", content: reply } },
                    ],
                    usage: {
                        prompt_tokens: 100,
                        prompt_cache_hit_tokens: 0,
                        prompt_cache_miss_tokens: 100,
                        completion_tokens: 100,
                        total_tokens: 200,
                    },
                });
            } finally {
                active--;
            }
        },
    });
    return {
        url: `http://127.0.0.1:${server.port}`,
        requests,
        get maxActive() {
            return maxActive;
        },
        stop: () => server.stop(true),
    };
}
