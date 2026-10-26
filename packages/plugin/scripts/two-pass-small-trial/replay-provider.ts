import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { measurementTransport } from "../two-pass-activation-runs/measurement-transports";
import { disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { type Attempt, cost, DeepSeek, type Prices, type Request, type Usage } from "./provider";

export const REPLAY_CAP_USD = 6;
export const REPLAY_OUTPUT_TOKENS = 8192;
export const REPLAY_PRICES = {
    deepseek: { hit: 0.3, miss: 0.3, output: 1.2 },
    // The direct client writes 5-minute caches. Charge every input token at the
    // higher cache-write price, even cache hits; never rely on discounts.
    sonnet: { hit: 2.5, miss: 2.5, output: 10 },
} satisfies Record<string, Prices>;
export type ReplayModel = keyof typeof REPLAY_PRICES;
export type ReplayAttempt = Attempt & { model: ReplayModel; arm: string };

export function requestCeiling(request: { max_tokens: number }, bytes: number, prices: Prices) {
    return (
        ((bytes + 4096) * Math.max(prices.hit, prices.miss) + request.max_tokens * prices.output) /
        1_000_000
    );
}
export class ReplayBudget {
    readonly rows: ReplayAttempt[] = [];
    constructor(readonly save: () => void) {}
    get committedUSD() {
        return this.rows.reduce((sum, r) => sum + (r.costCeilingUSD ?? r.reservedUSD), 0);
    }
    reserve(
        request: Request,
        caseId: number,
        attempt: number,
        model: ReplayModel,
        arm: string,
        bytes = Buffer.byteLength(JSON.stringify(request)),
    ) {
        const reservedUSD = requestCeiling(request, bytes, REPLAY_PRICES[model]);
        if (this.committedUSD + reservedUSD > REPLAY_CAP_USD) throw new Error("spend_cap_refused");
        const row: ReplayAttempt = { model, arm, caseId, turn: 2, attempt, reservedUSD };
        this.rows.push(row);
        this.save();
        return row;
    }
    settle(row: ReplayAttempt, usage: Usage) {
        const charged = cost(usage, REPLAY_PRICES[row.model]);
        if (charged > row.reservedUSD) throw new Error("usage_exceeds_reservation");
        row.usage = usage;
        row.costCeilingUSD = charged;
        this.save();
    }
}

export function replayDeepSeek(input: {
    endpoint: string;
    material: string;
    budget: ReplayBudget;
    arm: string;
    save(): void;
    log(text: string): void;
}) {
    return new DeepSeek({
        ...input,
        ledger: {
            reserve: (request, caseId, _turn, attempt) =>
                input.budget.reserve(request, caseId, attempt, "deepseek", input.arm),
            settle: (row, usage) => input.budget.settle(row as ReplayAttempt, usage),
        },
    });
}

export function anthropicReplayRequest(request: Request) {
    if (request.messages.map((m) => m.role).join() !== "system,user,assistant,user")
        throw new Error("replay_history_shape");
    return {
        model: "claude-sonnet-5-5" as const,
        maxOutputTokens: REPLAY_OUTPUT_TOKENS,
        system: request.messages[0].content,
        messages: request.messages.slice(1) as Array<{
            role: "user" | "assistant";
            content: string;
        }>,
        tools: [] as [],
        mode: "best_effort" as const,
    };
}

export async function sendReplaySonnet(input: {
    request: Request;
    caseId: number;
    arm: string;
    material: string;
    root: string;
    budget: ReplayBudget;
    mockEndpoint?: string;
}) {
    const request = anthropicReplayRequest(input.request);
    mkdirSync(input.root, { recursive: true, mode: 0o700 });
    // Reserve all possible attempts BEFORE the child can send or retry. Failed
    // attempts retain their ceiling; unused attempts are released only on success.
    const rows = Array.from({ length: 3 }, (_, n) =>
        input.budget.reserve(
            input.request,
            input.caseId,
            n,
            "sonnet",
            input.arm,
            Buffer.byteLength(JSON.stringify(request)) + 1024,
        ),
    );
    const session = await measurementTransport({
        mockAnthropicEndpoint: input.mockEndpoint,
        replayHistory: request.messages,
    }).openAnthropic({
        root: resolve(input.root),
        model: request.model,
        env: { ...disposableEnvironment(resolve(input.root)), ANTHROPIC_API_KEY: input.material },
    });
    try {
        const result = await session.send(request);
        const metadata = result.metadata as {
            attempts: number;
            response: {
                stop_reason: string;
                usage: {
                    input_tokens: number;
                    output_tokens: number;
                    cache_creation_input_tokens?: number;
                    cache_read_input_tokens?: number;
                };
            };
        };
        if (
            !Number.isSafeInteger(metadata?.attempts) ||
            metadata.attempts < 1 ||
            metadata.attempts > 3
        )
            throw new Error("usage_invalid_attempts");
        const u = metadata.response.usage;
        const inputTokens =
            u.input_tokens +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0);
        if (![inputTokens, u.output_tokens].every((n) => Number.isSafeInteger(n) && n >= 0))
            throw new Error("usage_invalid");
        input.budget.settle(rows[metadata.attempts - 1], {
            prompt_tokens: inputTokens,
            prompt_cache_miss_tokens: inputTokens,
            prompt_cache_hit_tokens: 0,
            completion_tokens: u.output_tokens,
            total_tokens: inputTokens + u.output_tokens,
        });
        for (const row of rows.slice(metadata.attempts)) row.costCeilingUSD = 0;
        input.budget.save();
        if (metadata.response.stop_reason !== "end_turn") throw new Error("incomplete_response");
        return result.text;
    } finally {
        await session.close();
    }
}
