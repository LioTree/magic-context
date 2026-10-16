import type { ContextUsage, SessionMeta } from "../../../features/magic-context/types";
import { CONTEXT_USAGE_TTL_MS } from "../context-usage";
import type { StepInputs } from "./provider-client";

/** Build the status frame used by both ordinary OpenCode and the bridge facade. */
export function openCodeStepInputs(input: {
    model: string;
    stepId: string;
    meta: Pick<SessionMeta, "lastUsageContextLimit" | "lastResponseTime">;
    entry?: { usage: ContextUsage; updatedAt: number };
    now: number;
}): StepInputs {
    const { model, stepId, meta, entry, now } = input;
    // Event delivery evicts observations older than this same interval. Check
    // here too because a transform can run after an idle gap with no new event.
    const fresh = entry && now - entry.updatedAt <= CONTEXT_USAGE_TTL_MS;
    // An outgoing model switch can precede its first usage event. Do not price
    // that model using another model's sample; legacy aggregate entries lack identity.
    const matchesModel = !entry?.usage.providerUsage || entry.usage.providerUsage.model === model;
    const usage = fresh && matchesModel ? entry.usage : undefined;
    const meters = usage?.providerUsage;
    return {
        model,
        step_id: stepId,
        step_kind: "model",
        context_window: meta.lastUsageContextLimit || 200_000,
        previous_usage: usage
            ? meters
                ? {
                      input: meters.input,
                      cache_read: meters.cache_read,
                      cache_write: meters.cache_write,
                      output: meters.output,
                      completed_at: meters.completed_at,
                      finish_reason: meters.finish_reason,
                  }
                : {
                      input: usage.inputTokens,
                      cache_read: 0,
                      cache_write: 0,
                      output: 0,
                      completed_at: meta.lastResponseTime,
                      finish_reason: "stop",
                  }
            : undefined,
        estimate: { request_tokens: usage?.inputTokens ?? 0 },
    };
}
