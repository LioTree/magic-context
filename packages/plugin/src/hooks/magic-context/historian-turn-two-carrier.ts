/**
 * The carrier for historian turn two on OpenCode 1 and OpenCode 2 hosts (both run the
 * historian through a `HiddenCompletionExecutor`): it continues the retained
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
    TurnTwoStageRecord,
    TurnTwoStageReply,
} from "../../features/magic-context/memory/turn-two";
import { TurnTwoOutcomeUnknownError } from "../../features/magic-context/memory/turn-two";
import {
    closeTurnTwoChild,
    retainedTurnTwoChild,
} from "../../features/magic-context/memory/turn-two-children";
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

/**
 * The check prompt: an `Operands:` section listing each operand (or, for a
 * compatibility check, each A/B pair) under its identity, then the `Input:` text.
 */
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
    // `continueConversation` asks a carrier that rebuilds each request's context
    // (OpenCode 2's hidden-child hook) to put turn one's prompt and reply before this
    // prompt. OpenCode 1 keeps the session's history itself and ignores the field.
    const prompt = (handle: HiddenRunHandle, text: string) => ({
        path: { id: handle.id },
        query: { directory: child.directory },
        continueConversation: true,
        body: {
            agent: child.agent,
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
        historianSystemHash,
        variant: toModelEntry(child.model)?.qualifier ?? null,
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
        // Checks wait only for each other, never for the historian child that turn
        // two keeps open (OpenCode 2 serializes hidden runs per role).
        metadata: { memoryCheck: true },
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
            // A timed-out check is a known check transport failure (the fact is retried
            // with one attempt consumed), not an unknown outcome that keeps it reserved.
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
            // Unparseable check output becomes an empty verdict list, which the gates
            // treat as a malformed verdict (the decision is refused), not a transport
            // failure (which would retry it).
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
 * this carrier kind and harness.
 * - A child this process retained for turn two is reached through the handle the
 *   executor issued for it (OpenCode 2 knows its runs only by that object). While a
 *   turn two here is still working on it, the stage is "busy".
 * - Any other child is reached by its session id. A stage younger than the
 *   historian timeout may still be served by another live process, so it is "busy".
 * A recovered reply carries the profile the provider reported for it, with the
 * historian system hash and variant the stage recorded when it was sent.
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
        const childId = record.childSessionId;
        if (!childId) return null;
        const retained = retainedTurnTwoChild(childId);
        if (retained?.active) return "busy";
        const young = (args.now?.() ?? Date.now()) - record.startedAt < args.timeoutMs;
        if (!retained && young) return "busy";
        const handle = (retained?.handle as HiddenRunHandle | undefined) ?? {
            id: childId,
            childSessionId: childId,
        };
        return {
            async reattach(): Promise<TurnTwoReattach> {
                let completion: HiddenCompletion;
                try {
                    completion = await args.executor.collect(handle, 50);
                } catch {
                    // A retained child's run exists but has not settled; an unknown
                    // one is no longer there.
                    return retained ? { kind: "unknown" } : { kind: "gone" };
                }
                if (!completion.text || lifecycleTextHash(completion.text) === record.baseline)
                    return { kind: "unknown" };
                return {
                    kind: "reply",
                    reply: {
                        text: completion.text,
                        lengthCapped: completion.lengthCapped,
                        profile: recoveredProfile(completion, record),
                        usage: completion.usage,
                    },
                };
            },
            // A check child opened by an earlier process cannot be found again.
            // Rejecting makes the gates treat the check as a transport failure, so
            // the fact it belongs to is retried rather than left reserved forever.
            reattachCheck: () => Promise.reject(new Error("check session is not recoverable")),
            check: () => Promise.reject(new Error("recovered stage cannot open checks")),
            async close() {
                if (retained) {
                    await closeTurnTwoChild(childId);
                    return;
                }
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

function recoveredProfile(
    completion: HiddenCompletion,
    record: TurnTwoStageRecord,
): ReportedProfile | null {
    const answered = answeredBy(completion);
    if (!answered || !record.historianSystemHash) return null;
    return {
        provider: answered.provider,
        modelId: answered.modelId,
        variant: record.variant,
        temperature: null,
        systemHash: record.historianSystemHash,
    };
}
