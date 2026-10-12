/**
 * The OpenCode (1 and 2) carrier for historian turn two: it continues the retained
 * turn-one child with a second prompt on the same session id, and sends each narrow
 * check as a fresh single-turn child of its own.
 *
 * No production lane is enabled yet (see `resolveTurnOneLane`): the OpenCode prompt
 * body has no response-schema field the provider honours, so this carrier is only
 * reached on a lane a test enables. Before a lane is enabled, a recorded replay must
 * also show that a check request reaches the provider with only its own fixed system
 * prompt (the OpenCode agent registration can add its own).
 */

import type {
    CheckReply,
    CheckRequest,
    ReportedProfile,
} from "../../features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "../../features/magic-context/memory/lifecycle-text";
import type {
    TurnTwoCarrier,
    TurnTwoReattach,
    TurnTwoRecoveryResolver,
    TurnTwoStageReply,
} from "../../features/magic-context/memory/turn-two";
import { TurnTwoOutcomeUnknownError } from "../../features/magic-context/memory/turn-two";
import { modelBodyField, toModelEntry } from "../../shared/resolve-fallbacks";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
    HiddenRunHandle,
    RetainedHistorianChild,
} from "./compartment-runner-types";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            timer = setTimeout(
                // A local timeout with no provider result says nothing about the
                // outcome; the stage stays reserved for recovery.
                () => reject(new TurnTwoOutcomeUnknownError("turn two send timed out locally")),
                timeoutMs,
            );
            (timer as unknown as { unref?: () => void }).unref?.();
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * The provider and model that answered: the carrier's own report, else the latest
 * assistant message's `providerID`/`modelID` (OpenCode records the model that
 * actually ran, which differs from the configured one after a fallback).
 */
function answeredBy(completion: HiddenCompletion): { provider: string; modelId: string } | null {
    if (completion.providerId && completion.modelId)
        return { provider: completion.providerId, modelId: completion.modelId };
    const messages = Array.isArray(completion.messages) ? completion.messages : [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const info = (messages[index] as { info?: Record<string, unknown> } | null)?.info;
        if (info?.role !== "assistant") continue;
        if (typeof info.providerID === "string" && typeof info.modelID === "string")
            return { provider: info.providerID, modelId: info.modelID };
        return null;
    }
    return null;
}

function reportedProfile(
    completion: HiddenCompletion,
    model: RetainedHistorianChild["model"],
    systemHash: string,
): ReportedProfile | null {
    const answered = answeredBy(completion);
    if (!answered) return null;
    return {
        provider: answered.provider,
        modelId: answered.modelId,
        variant: toModelEntry(model)?.qualifier ?? null,
        // No OpenCode carrier reports the sampling temperature.
        temperature: null,
        systemHash,
    };
}

function parseCheckVerdicts(text: string | null): CheckReply["verdicts"] {
    const parsed = JSON.parse(text ?? "") as { verdicts?: unknown };
    if (!Array.isArray(parsed.verdicts)) throw new Error("check reply has no verdicts");
    return parsed.verdicts as CheckReply["verdicts"];
}

/** The check input as the provider sees it: operands by identity, then the input. */
export function renderCheckInput(request: CheckRequest): string {
    const operands =
        request.kind === "compatibility"
            ? request.pairs.map(
                  (pair) => `${pair.id}\n  A: ${pair.left.text}\n  B: ${pair.right.text}`,
              )
            : request.operands.map((operand) => `${operand.id}: ${operand.text}`);
    return [`Operands:`, ...operands, "", "Input:", request.input].join("\n");
}

export function createOpenCodeTurnTwoCarrier(args: {
    child: RetainedHistorianChild;
    parentSessionId: string;
    harness: string;
    carrier: string;
    enforcedJson: boolean;
    /** Turn one's reply; a later reply that differs from it is turn two's. */
    turnOneText: string;
    timeoutMs: number;
}): TurnTwoCarrier {
    const { child } = args;
    const historianSystemHash = lifecycleTextHash(child.system);
    const prompt = (handle: HiddenRunHandle, text: string, system?: string) => ({
        path: { id: handle.id },
        query: { directory: child.directory },
        body: {
            agent: child.agent,
            ...(system ? { system } : {}),
            ...modelBodyField(child.model),
            parts: [{ type: "text", text, synthetic: true }],
        },
    });
    return {
        carrier: args.carrier,
        harness: args.harness,
        enforcedJson: args.enforcedJson,
        childSessionId: child.handle.childSessionId ?? child.handle.id,
        baseline: lifecycleTextHash(args.turnOneText),
        async send(text: string): Promise<TurnTwoStageReply> {
            await withTimeout(
                child.executor.attempt(child.handle, prompt(child.handle, text)),
                args.timeoutMs,
            );
            const completion = await child.executor.collect(child.handle, 50);
            if (!completion.text || completion.text === args.turnOneText)
                throw new TurnTwoOutcomeUnknownError("turn two reply not yet available");
            return {
                text: completion.text,
                lengthCapped: completion.lengthCapped,
                profile: reportedProfile(completion, child.model, historianSystemHash),
                usage: completion.usage,
            };
        },
        check: (request) =>
            sendCheck(child.executor, child, args.parentSessionId, request, args.timeoutMs),
    };
}

/**
 * A narrow check: a fresh child per request, never the historian's, carrying only
 * the check's fixed system prompt, its operands and its input.
 */
async function sendCheck(
    executor: HiddenCompletionExecutor,
    child: RetainedHistorianChild,
    parentSessionId: string,
    request: CheckRequest,
    timeoutMs: number,
): Promise<CheckReply> {
    const handle = await executor.open({
        parentSessionId,
        agent: child.agent,
        kind: "historian",
        system: request.system,
        model: child.model,
        configuredModels: child.model ? [child.model] : [],
        timeoutMs,
        title: `magic-context-memory-check-${request.key.slice(0, 16)}`,
        directory: child.directory,
    });
    let settled = false;
    try {
        await withTimeout(
            executor.attempt(handle, {
                path: { id: handle.id },
                query: { directory: child.directory },
                body: {
                    agent: child.agent,
                    system: request.system,
                    ...modelBodyField(child.model),
                    parts: [{ type: "text", text: renderCheckInput(request), synthetic: true }],
                },
            }),
            timeoutMs,
        ).catch((error) => {
            // A check timing out is a known check failure: it is retried later.
            if (error instanceof TurnTwoOutcomeUnknownError) throw new Error("check timed out");
            throw error;
        });
        const completion = await executor.collect(handle, 10);
        settled = true;
        const profile = reportedProfile(completion, child.model, request.systemHash);
        if (!profile) throw new Error("check carrier reported no model");
        let verdicts: CheckReply["verdicts"];
        try {
            verdicts = parseCheckVerdicts(completion.text);
        } catch {
            // Malformed check output is a refusal, not a transport failure.
            verdicts = [];
        }
        return { verdicts, profile, usage: completion.usage };
    } finally {
        await executor.close(handle, {
            promptSettled: settled,
            privacySensitive: false,
            context: "historian-check",
            log: () => {},
        });
    }
}

/**
 * Reach a turn-two stage an earlier run or process left in flight, for records of
 * this carrier kind and harness. A stage younger than the historian timeout may
 * still be served by another live process, so it is left alone.
 */
export function createOpenCodeTurnTwoRecovery(args: {
    executor: HiddenCompletionExecutor;
    carrier: string;
    harness: string;
    directory: string;
    timeoutMs: number;
    now?: () => number;
}): TurnTwoRecoveryResolver {
    return (record) => {
        if (record.carrier !== args.carrier || record.harness !== args.harness) return null;
        if (!record.childSessionId) return null;
        const handle: HiddenRunHandle = {
            id: record.childSessionId,
            childSessionId: record.childSessionId,
        };
        const young = (args.now?.() ?? Date.now()) - record.startedAt < args.timeoutMs;
        return {
            async reattach(): Promise<TurnTwoReattach> {
                if (young) return { kind: "unknown" };
                let completion: HiddenCompletion;
                try {
                    completion = await args.executor.collect(handle, 50);
                } catch {
                    return { kind: "gone" };
                }
                if (!completion.text || lifecycleTextHash(completion.text) === record.baseline)
                    return { kind: "unknown" };
                return {
                    kind: "reply",
                    reply: {
                        text: completion.text,
                        lengthCapped: completion.lengthCapped,
                        profile: null,
                        usage: completion.usage,
                    },
                };
            },
            // A check session of an earlier process cannot be found again, so the
            // check counts as a known transport failure and its fact is retried.
            reattachCheck: () => Promise.reject(new Error("check session is not recoverable")),
            check: () => Promise.reject(new Error("recovered stage cannot open checks")),
            async close() {
                await args.executor.close(handle, {
                    promptSettled: true,
                    privacySensitive: false,
                    context: "historian-turn-two-recovery",
                    log: () => {},
                });
            },
        };
    };
}
