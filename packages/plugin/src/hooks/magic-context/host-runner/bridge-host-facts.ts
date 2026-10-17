import type { loadPluginConfigDetailed } from "../../../config";
import { isCompactionEnabled } from "../../../config/agent-disable";
import { createCompactionHandler } from "../../../features/magic-context/compaction";
import {
    clearDetectedContextLimit,
    clearEmergencyRecovery,
    getOverflowState,
} from "../../../features/magic-context/storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../../features/magic-context/storage-meta";
import { sessionLog } from "../../../shared/logger";
import { createEventHandler } from "../event-handler";
import { createSystemPromptHashHandler } from "../system-prompt-hash";
import { normalizeTodoStateJson } from "../todo-view";
import type { TransformDeps } from "../transform";
import type { BridgeHostFact, BridgeHostFactResult } from "./bridge-types";

/** Feed host observations through the plugin's existing usage, prompt and todo policies. */
export function createBridgeHostFacts(
    deps: TransformDeps,
    config: ReturnType<typeof loadPluginConfigDetailed>["config"],
) {
    const {
        historyRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId,
        rustModeModuleClient,
        directory,
        liveModelBySession,
    } = deps;
    if (
        !historyRefreshSessions ||
        !pendingMaterializationSessions ||
        !lastHeuristicsTurnId ||
        !rustModeModuleClient ||
        !directory ||
        !liveModelBySession
    )
        throw new Error("Bridge host facts require initialized provider dependencies");
    const windows = new Map<string, { model: string; limit: number }>();
    const latest = new Map<string, number>();
    const modelTimes = new Map<string, number>();
    const zeroUsageLogSeen = new Set<string>();
    const events = createEventHandler({
        db: deps.db,
        tagger: deps.tagger,
        contextUsageMap: deps.contextUsageMap,
        compactionHandler: createCompactionHandler(),
        config,
        compactionOff: !isCompactionEnabled(config),
        usageContextWindow: (id, model) => {
            const window = windows.get(id);
            if (!window || window.model !== model) return undefined;
            const detected = getOverflowState(deps.db, id, model).detectedContextLimit;
            return detected > 0 ? Math.min(window.limit, detected) : window.limit;
        },
    });
    const system = createSystemPromptHashHandler({
        db: deps.db,
        dreamerEnabled: false,
        memoryEnabled: config.memory?.enabled !== false,
        promptSurface: config.prompt_surface,
        systemPromptRefreshSessions: new Set(),
        historyRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId,
        resolveModel: (id) => liveModelBySession.get(id),
    });
    return async (fact: BridgeHostFact): Promise<BridgeHostFactResult> => {
        const id = fact.sessionId;
        const key = `${id}\0${fact.lineageId}\0${fact.kind}`;
        const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
        if (
            !integer(fact.observedAt) ||
            fact.observedAt === 0 ||
            fact.observedAt > Date.now() + 60_000 ||
            !fact.model.providerID ||
            !fact.model.modelID
        )
            throw new Error("Invalid bridge host-fact identity/time");
        const previous = liveModelBySession.get(id);
        const model = `${fact.model.providerID}/${fact.model.modelID}`;
        const switched = previous && `${previous.providerID}/${previous.modelID}` !== model;
        if (
            fact.observedAt < (latest.get(key) ?? 0) ||
            (switched && fact.observedAt <= (modelTimes.get(id) ?? 0))
        )
            return { accepted: false };
        if (fact.kind === "provider_response") {
            if (
                !integer(fact.completedAt) ||
                fact.completedAt === 0 ||
                fact.completedAt > fact.observedAt ||
                !fact.finishReason ||
                !["success", "failed", "aborted"].includes(fact.outcome) ||
                !integer(fact.contextWindow) ||
                fact.contextWindow === 0 ||
                (fact.usage && !Object.values(fact.usage).every(integer))
            )
                throw new Error("Invalid bridge provider meters/window/time");
        }
        if (
            fact.kind === "provider_response" &&
            fact.usage &&
            fact.usage.input + fact.usage.cacheRead + fact.usage.cacheWrite === 0
        ) {
            if (!zeroUsageLogSeen.has(id)) {
                zeroUsageLogSeen.add(id);
                sessionLog(id, "[debug] ignoring provider response with no input or cache tokens");
            }
            return { accepted: true };
        }
        if (switched) {
            deps.contextUsageMap.delete(id);
            windows.delete(id);
            clearDetectedContextLimit(deps.db, id);
            clearEmergencyRecovery(deps.db, id);
        }
        liveModelBySession.set(id, fact.model);
        modelTimes.set(id, Math.max(modelTimes.get(id) ?? 0, fact.observedAt));
        if (fact.kind === "provider_response") {
            windows.set(id, { model, limit: fact.contextWindow });
            // Usage and completion time are not delivery acknowledgements.
            // Only completeRequest can certify delivery; recordProviderUsage
            // separately binds a token count to the exact outgoing messages.
            await events({
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            role: "assistant",
                            sessionID: id,
                            providerID: fact.model.providerID,
                            modelID: fact.model.modelID,
                            time: { completed: fact.completedAt },
                            finish: fact.finishReason,
                            error:
                                fact.error ??
                                (fact.outcome !== "success"
                                    ? { message: `Provider request ${fact.outcome}` }
                                    : undefined),
                            ...(fact.usage
                                ? {
                                      tokens: {
                                          input: fact.usage.input,
                                          output: fact.usage.output,
                                          cache: {
                                              read: fact.usage.cacheRead,
                                              write: fact.usage.cacheWrite,
                                          },
                                      },
                                  }
                                : {}),
                        },
                    },
                },
            });
            const reading = deps.contextUsageMap.get(id);
            if (reading && fact.usage) reading.updatedAt = fact.observedAt;
            const detected = getOverflowState(deps.db, id, model).detectedContextLimit;
            updateSessionMeta(deps.db, id, {
                lastUsageContextLimit:
                    detected > 0 ? Math.min(fact.contextWindow, detected) : fact.contextWindow,
            });
        } else if (fact.kind === "system_prompt") {
            const output = { system: [...fact.system] };
            await system.handler({ sessionID: id, model: fact.model }, output);
            latest.set(key, fact.observedAt);
            return { accepted: true, system: output.system };
        } else {
            if (
                fact.tool !== "todowrite" ||
                !fact.callable ||
                getOrCreateSessionMeta(deps.db, id).isSubagent
            )
                return { accepted: false };
            const state = normalizeTodoStateJson(fact.todos);
            if (state === null || !fact.ownerMessageId)
                throw new Error("Invalid native todo state");
            await rustModeModuleClient.call({
                sessionId: id,
                projectRoot: directory,
                method: "todo_state.set",
                body: {
                    method: "todo_state.set",
                    v: 1,
                    session_id: id,
                    state_json: state,
                    owner_message_id: fact.ownerMessageId,
                },
            });
            updateSessionMeta(deps.db, id, { lastTodoState: state });
        }
        latest.set(key, fact.observedAt);
        return { accepted: true };
    };
}
