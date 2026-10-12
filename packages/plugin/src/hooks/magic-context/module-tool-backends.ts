import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import type { Database } from "../../shared/sqlite";
import type { RustModeModuleClient } from "./rust-mode-transform";

export interface ModuleToolBackends {
    backends: RustToolBackends;
}

export type ModuleCurateResult =
    | { state: "applied"; memory_id: number; superseded_ids: number[]; error_code: null }
    | { state: "refused"; memory_id: null; superseded_ids: []; error_code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMemoryId(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Human text is display-only; only a complete transaction receipt can claim an applied edit. */
function appliedCurateResult(response: unknown): Extract<ModuleCurateResult, { state: "applied" }> {
    const envelope = isRecord(response) && "result" in response ? response.result : response;
    const invalid = () => new Error("Invalid module curate response");
    if (!isRecord(envelope) || ("isError" in envelope && typeof envelope.isError !== "boolean"))
        throw invalid();
    const result = envelope.structuredContent;
    if (
        !isRecord(result) ||
        !Array.isArray(result.superseded_ids) ||
        ![...result.superseded_ids].every(isMemoryId) ||
        new Set(result.superseded_ids).size !== result.superseded_ids.length
    )
        throw invalid();
    if (result.state === "refused") {
        if (
            result.memory_id !== null ||
            result.superseded_ids.length !== 0 ||
            typeof result.error_code !== "string" ||
            !result.error_code.trim()
        )
            throw invalid();
        throw new Error(`Module curate refused: ${result.error_code}`);
    }
    if (
        result.state !== "applied" ||
        result.error_code !== null ||
        envelope.isError === true ||
        !isMemoryId(result.memory_id) ||
        result.superseded_ids.includes(result.memory_id)
    )
        throw invalid();
    return {
        state: "applied",
        memory_id: result.memory_id,
        superseded_ids: [...result.superseded_ids],
        error_code: null,
    };
}

/** Route automated memory edits and drops through the module so its transaction records their audit trail. */
export function createModuleToolBackends(options: {
    db: Database;
    moduleClient: RustModeModuleClient | undefined;
    directory: string;
    memorySyncRequestedSessions: Set<string>;
}): ModuleToolBackends | undefined {
    const { moduleClient } = options;
    if (!moduleClient) return undefined;
    return {
        backends: {
            curateMemory: async ({ projectRoot, ...request }) => {
                const response = await moduleClient.call({
                    sessionId: request.sourceSessionId,
                    projectRoot,
                    method: "memory.curate",
                    body: {
                        name: "memory.curate",
                        arguments: {
                            memory_project: request.projectPath,
                            command_id: request.key,
                            action: request.operation,
                            ids: request.targets.map((target) => target.id),
                            expected_revisions: request.targets,
                            content: request.content,
                            category: request.category,
                            reason: request.reason,
                            superseded_by: request.supersededById,
                        },
                    },
                });
                const result = appliedCurateResult(response);
                return {
                    state: "applied",
                    reason: request.operation,
                    adoptionClass: "deferred",
                    memoryId: result.memory_id,
                    supersededIds: result.superseded_ids,
                };
            },
            reduce: ({ sessionId, projectRoot, drop, commandId }) =>
                moduleClient.call({
                    sessionId,
                    projectRoot,
                    method: "agent_drops.append",
                    body: {
                        method: "agent_drops.append",
                        v: 1,
                        session_id: sessionId,
                        drop,
                        command_id: commandId,
                    },
                }),
        },
    };
}
