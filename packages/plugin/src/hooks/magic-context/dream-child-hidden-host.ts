import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import type { PluginContext } from "../../plugin/types";
import * as shared from "../../shared";
import { shouldKeepSubagents } from "../../shared/keep-subagents";
import { isRecord } from "../../shared/record-type-guard";
import { modelBodyField, parseProviderModel } from "../../shared/resolve-fallbacks";
import type { Database } from "../../shared/sqlite";
import { createV1HiddenCompletionExecutor } from "./compartment-runner-historian";
import type { HiddenCompletionExecutor, HiddenRunHandle } from "./compartment-runner-types";
import {
    DREAM_TASK_ROUTED_TOOLS,
    type DreamChildCapabilities,
    type DreamChildDescriptor,
    type DreamChildHost,
    type DreamChildRun,
    type DreamChildTranscriptMessage,
} from "./dream-child-claimant";

/**
 * Runs a claimed dream attempt on the host's existing hidden child executor
 * (`HiddenCompletionExecutor`): the OpenCode 1 child-session carrier or the
 * OpenCode 2 native hidden child. The executor already owns child creation,
 * prompting and teardown; what this adds is the descriptor check before
 * anything is created, a prompt sent once, and host-confirmed abort and
 * retirement evidence for the cleanup acknowledgement.
 *
 * The per-step, per-tool and token guards are not here. They run in the host
 * hooks that execute steps and tools (`chat.params` and `tool.execute.before`
 * on OpenCode 1, the context and `execute.before` hooks on OpenCode 2, and the
 * `ctx_memory` tool itself), which consult the gate the claimant registers for
 * the child id this host returns.
 */
export interface HiddenDreamChildHostOptions {
    executor: HiddenCompletionExecutor;
    capabilities: DreamChildCapabilities;
    /**
     * The hidden agents this host registers that may carry a dream child, each
     * with the fixed tool set its registration allows. A descriptor naming any
     * other agent, or needing a tool its agent does not carry, is refused rather
     * than run on a substitute agent.
     */
    agentTools: Readonly<Record<string, readonly string[]>>;
    /** The directory this plugin instance serves; children run only there. */
    directory: string;
    transcript(childId: string): Promise<DreamChildTranscriptMessage[]>;
    /** Removes the child, when the executor's own close does not. */
    remove?(childId: string): Promise<void>;
    /** True only once the host confirms the child no longer exists. */
    confirmRemoved(childId: string): Promise<boolean>;
    /**
     * Whether the host currently has `agent` registered and enabled. A hidden
     * agent the user's config turned off is not there to carry the child.
     */
    agentRegistered?(agent: string): Promise<boolean>;
    now?(): number;
    log?(message: string): void;
}

const MANDATORY_CAPABILITIES = [
    "child_guard",
    "steps",
    "tokens",
    "stop",
    "retire",
    "task_tools",
] as const;

function canonical(directory: string): string | undefined {
    try {
        return realpathSync(directory);
    } catch {
        return undefined;
    }
}

/** Why `host` cannot enforce `descriptor`, or undefined. Exported for tests. */
export function hiddenDreamChildRefusal(
    descriptor: DreamChildDescriptor,
    options: Pick<HiddenDreamChildHostOptions, "capabilities" | "agentTools" | "directory">,
): string | undefined {
    const capabilities = options.capabilities;
    const missing = MANDATORY_CAPABILITIES.find((name) => capabilities[name] !== true);
    if (missing) return `capability_missing:${missing}`;
    if (!Object.hasOwn(options.agentTools, descriptor.agent)) {
        return `agent_unsupported:${descriptor.agent}`;
    }
    const carried = options.agentTools[descriptor.agent] ?? [];
    for (const tool of descriptor.allowedTools) {
        if (!capabilities.tools.includes(tool)) return `tool_undeclared:${tool}`;
        if (!carried.includes(tool)) return `tool_not_carried:${descriptor.agent}:${tool}`;
        if (!DREAM_TASK_ROUTED_TOOLS.has(tool) && !capabilities.filesystem_fence) {
            return `filesystem_fence_unavailable:${tool}`;
        }
    }
    if (!Number.isInteger(descriptor.maxSteps) || descriptor.maxSteps < 1) {
        return "invalid_step_cap";
    }
    if (descriptor.model === null) {
        if (!capabilities.default_model) return "default_model_unavailable";
    } else if (!parseProviderModel(descriptor.model.model)) {
        return "model_unparseable";
    }
    // The descriptor's directory is already canonical. This instance's hooks see
    // only children created in its own directory.
    if (canonical(options.directory) !== descriptor.directory) {
        return "directory_not_served_here";
    }
    return undefined;
}

export function createHiddenDreamChildHost(options: HiddenDreamChildHostOptions): DreamChildHost {
    const now = () => options.now?.() ?? Date.now();
    const note = options.log ?? (() => {});
    return {
        capabilities: options.capabilities,
        async refusal(descriptor) {
            const refusal = hiddenDreamChildRefusal(descriptor, options);
            if (refusal) return refusal;
            if (options.agentRegistered && !(await options.agentRegistered(descriptor.agent))) {
                return `agent_not_registered:${descriptor.agent}`;
            }
            return undefined;
        },
        async create(descriptor) {
            const model = descriptor.model
                ? {
                      model: descriptor.model.model,
                      ...(descriptor.model.qualifier ? { qualifier: descriptor.model.qualifier } : {}),
                  }
                : undefined;
            const handle: HiddenRunHandle = await options.executor.open({
                parentSessionId: descriptor.parentSessionId,
                agent: descriptor.agent,
                kind: "dreamer-task",
                system: descriptor.system,
                ...(model ? { model, configuredModels: [model] } : {}),
                timeoutMs: Math.max(1, descriptor.deadlineMs - now()),
                // The title prefix marks the session as Magic Context's own hidden
                // child. The tag is local; the module's credentials never appear here.
                title: `magic-context-dream-child-${randomBytes(6).toString("hex")}`,
                directory: descriptor.directory,
            });
            const childId = handle.childSessionId ?? handle.id;
            if (!childId) throw new Error("hidden child executor returned no session id");
            let prompted = false;
            let settled = false;
            const run: DreamChildRun = {
                hostChildId: childId,
                async prompt(signal) {
                    if (prompted) throw new Error("a dream child prompt is sent once");
                    prompted = true;
                    await options.executor.attempt(handle, {
                        path: { id: childId },
                        query: { directory: descriptor.directory },
                        body: {
                            agent: descriptor.agent,
                            system: descriptor.system,
                            ...modelBodyField(model),
                            parts: [{ type: "text", text: descriptor.prompt }],
                        },
                        signal,
                    });
                    settled = true;
                },
                transcript: () => options.transcript(childId),
                async abort() {
                    if (!options.executor.interrupt) return settled || !prompted;
                    try {
                        await options.executor.interrupt(childId);
                        return true;
                    } catch (error) {
                        note(`dream child ${childId} interrupt unconfirmed: ${String(error)}`);
                        return false;
                    }
                },
                async retire() {
                    try {
                        await options.executor.close(handle, {
                            promptSettled: settled,
                            privacySensitive: true,
                            context: "[magic-context] dream child",
                            log: note,
                        });
                    } catch (error) {
                        note(`dream child ${childId} close failed: ${String(error)}`);
                    }
                    if (options.remove && !(await options.confirmRemoved(childId))) {
                        try {
                            await options.remove(childId);
                        } catch (error) {
                            note(`dream child ${childId} removal failed: ${String(error)}`);
                        }
                    }
                    // Only the host's own answer counts as evidence of retirement.
                    return options.confirmRemoved(childId);
                },
            };
            return run;
        },
    };
}

/** The dream agents OpenCode 1 registers (see hidden-agent-registrations.ts) and their tools. */
export const OPENCODE1_DREAM_AGENT_TOOLS: Readonly<Record<string, readonly string[]>> = {
    dreamer: ["ctx_memory"],
    "dreamer-classifier": [],
    "dreamer-reviewer": [],
};

/**
 * What OpenCode 1 enforces for a dream child, and why.
 *
 * - `child_guard`: `tool.execute.before` refuses any tool not admitted by the
 *   child's gate, whatever the user's permissions allow; the hidden agent's
 *   locked allow-only permission map is a second layer.
 * - `steps`, `tokens`: `chat.params` runs before every model call; the gate
 *   reports the host's recorded usage there and admits the step with the module.
 * - `stop`, `retire`: `session.abort`, then `session.delete` confirmed by a
 *   failing `session.get`. With `keep_subagents` on the child is kept, so
 *   retirement is not promised.
 * - `task_tools`: `ctx_memory` in a dream child goes to `dream.child.tool`.
 * - `filesystem_fence`: not declared. OpenCode's native read/grep/glob open and
 *   walk files inside the host with no hook at the actual open; a check of tool
 *   arguments before the call is not containment.
 * - `default_model`: not declared. A prompt without a model runs on the agent's
 *   or the host's default, not provably the creating session's.
 */
export function openCode1DreamChildCapabilities(): DreamChildCapabilities {
    return {
        tools: ["ctx_memory"],
        child_guard: true,
        steps: true,
        tokens: true,
        stop: true,
        retire: !shouldKeepSubagents(),
        task_tools: true,
        filesystem_fence: false,
        default_model: false,
    };
}

function partsText(parts: unknown): string {
    if (!Array.isArray(parts)) return "";
    return parts
        .flatMap((part) =>
            isRecord(part) && part.type === "text" && typeof part.text === "string"
                ? [part.text]
                : [],
        )
        .join("");
}

function tokenCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : 0;
}

/** OpenCode 1 assistant messages as the host records them, with their own usage. */
export function openCode1Transcript(messages: unknown): DreamChildTranscriptMessage[] {
    if (!Array.isArray(messages)) return [];
    const transcript: DreamChildTranscriptMessage[] = [];
    for (const message of messages) {
        if (!isRecord(message) || !isRecord(message.info)) continue;
        const info = message.info;
        if (info.role !== "assistant" || typeof info.id !== "string") continue;
        const tokens = isRecord(info.tokens) ? info.tokens : undefined;
        const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined;
        const finish = typeof info.finish === "string" ? info.finish : undefined;
        const completed = isRecord(info.time) && typeof info.time.completed === "number";
        transcript.push({
            id: info.id,
            text: partsText(message.parts),
            usage: tokens
                ? {
                      input: tokenCount(tokens.input),
                      output: tokenCount(tokens.output),
                      cache_read: tokenCount(cache?.read),
                      cache_write: tokenCount(cache?.write),
                  }
                : null,
            finished: finish !== undefined || completed,
            ...(finish !== undefined ? { finish } : {}),
        });
    }
    return transcript;
}

export function createOpenCode1DreamChildHost(args: {
    client: PluginContext["client"];
    db: Database;
    directory: string;
    log?(message: string): void;
}): DreamChildHost {
    const { client, directory } = args;
    return createHiddenDreamChildHost({
        executor: createV1HiddenCompletionExecutor(client, args.db, directory),
        capabilities: openCode1DreamChildCapabilities(),
        agentTools: OPENCODE1_DREAM_AGENT_TOOLS,
        directory,
        ...(args.log ? { log: args.log } : {}),
        async transcript(childId) {
            const response = await client.session.messages({
                path: { id: childId },
                query: { directory },
            });
            return openCode1Transcript(
                shared.normalizeSDKResponse(response, [] as unknown[], {
                    preferResponseOnMissingData: true,
                }),
            );
        },
        // The OpenCode 1 carrier keeps an unsettled child for its age-gated sweep;
        // a dream child is deleted whether or not its prompt settled.
        async remove(childId) {
            await client.session.delete({ path: { id: childId }, query: { directory } });
        },
        // The dreamer's hidden agents carry the user's dreamer overrides, so a
        // dreamer turned off in config leaves them disabled on this host.
        async agentRegistered(agent) {
            const response = await client.app.agents({ query: { directory } });
            const agents = shared.normalizeSDKResponse(response, [] as unknown[], {
                preferResponseOnMissingData: true,
            });
            return agents.some((entry) => isRecord(entry) && entry.name === agent);
        },
        async confirmRemoved(childId) {
            try {
                const response = await client.session.get({
                    path: { id: childId },
                    query: { directory },
                });
                const record = response as unknown as {
                    error?: unknown;
                    data?: unknown;
                    response?: { status?: number };
                };
                // The SDK reports a missing session as a 404 error body, not a throw.
                return record.response?.status === 404 && !record.data;
            } catch (error) {
                return isRecord(error) && error.status === 404;
            }
        },
    });
}

/** The dream agents OpenCode 2 registers (see v2/hooks/hidden-child.ts) and their tools. */
export const OPENCODE2_DREAM_AGENT_TOOLS: Readonly<Record<string, readonly string[]>> = {
    dreamer: ["ctx_memory"],
    "dreamer-classifier": [],
};

/**
 * What OpenCode 2 enforces for a dream child. The same guards as OpenCode 1,
 * attached to the context hook (once per model step) and `execute.before`, on
 * top of the host's session-level deny-all-then-allow rules for the agent. A
 * missing model resolves to the parent session's own model, so `default_model`
 * is declared. `filesystem_fence` is not, for the same reason as OpenCode 1.
 */
export function openCode2DreamChildCapabilities(keepSubagents: boolean): DreamChildCapabilities {
    return {
        tools: ["ctx_memory"],
        child_guard: true,
        steps: true,
        tokens: true,
        stop: true,
        retire: !keepSubagents,
        task_tools: true,
        filesystem_fence: false,
        default_model: true,
    };
}

/** One OpenCode 2 assistant row as the reader decodes it. */
export interface OpenCode2AssistantRow {
    id: string;
    data: {
        content?: Array<Record<string, unknown>>;
        finish?: string;
        outcome?: string;
        tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
    };
}

export function openCode2Transcript(rows: readonly OpenCode2AssistantRow[]): DreamChildTranscriptMessage[] {
    return rows.map((row) => {
        const tokens = row.data.tokens;
        return {
            id: row.id,
            text: partsText(row.data.content),
            usage: tokens
                ? {
                      input: tokenCount(tokens.input),
                      output: tokenCount(tokens.output),
                      cache_read: tokenCount(tokens.cache?.read),
                      cache_write: tokenCount(tokens.cache?.write),
                  }
                : null,
            finished: row.data.finish !== undefined || row.data.outcome !== undefined,
            ...(row.data.finish !== undefined ? { finish: row.data.finish } : {}),
        };
    });
}
