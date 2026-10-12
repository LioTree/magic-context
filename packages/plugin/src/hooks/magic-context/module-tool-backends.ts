import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import type { Database } from "../../shared/sqlite";
import type { RustModeModuleClient } from "./rust-mode-transform";

export interface ModuleToolBackends {
    backends: RustToolBackends;
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
                const result = (response as { result?: unknown }).result ?? response;
                const text =
                    (result as { content?: Array<{ text?: string }> }).content
                        ?.map((part) => part.text ?? "")
                        .join("\n") ?? "";
                if ((result as { isError?: boolean }).isError)
                    throw new Error(text || "Module curate refused");
                const canonicalId = /canonical memory \[ID: (\d+)\]/.exec(text)?.[1];
                const superseded = /; superseded \[([\d, ]*)\]/.exec(text)?.[1];
                if (!/^(Updated memory|Archived memor|Merged memories)/.test(text))
                    throw new Error(`Invalid module curate response: ${text}`);
                return {
                    state: "applied",
                    reason: request.operation,
                    adoptionClass: "deferred",
                    memoryId: canonicalId ? Number(canonicalId) : request.targets[0]!.id,
                    supersededIds: superseded
                        ? superseded.split(",").map((id) => Number(id.trim()))
                        : [],
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
