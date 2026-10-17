import type { Database } from "../../../shared/sqlite";
import {
    applyDashboardMemoryEdit,
    applyMemoryRestore,
    listMemoryHistory,
    previewMemoryRestore,
    validateMemoryWriteRequest,
} from "./history-applier";
import type {
    MemoryEditRequest,
    MemoryHistoryRequest,
    MemoryRestoreRequest,
} from "./history-contract";
import { tsOwnsMemory } from "./lifecycle-applier";

type MemoryHistoryMethod =
    | "memory.history"
    | "memory.restore.preview"
    | "memory.restore"
    | "memory.edit";

/** Ownership is sampled here and rechecked by the admitted writer under its lock. */
export async function memoryHistoryRpc(
    options: { db: Database },
    method: MemoryHistoryMethod,
    params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const projectPath = params.projectPath;
    if (typeof projectPath !== "string" || !projectPath) throw new Error("invalid_request");
    if (method === "memory.history")
        return { ...listMemoryHistory(options.db, params as unknown as MemoryHistoryRequest) };
    if (method === "memory.restore.preview") {
        if (typeof params.decisionKey !== "string") throw new Error("invalid_request");
        return {
            ...previewMemoryRestore(options.db, { projectPath, decisionKey: params.decisionKey }),
        };
    }
    validateMemoryWriteRequest(
        params as unknown as MemoryRestoreRequest | MemoryEditRequest,
        method,
    );
    if (!tsOwnsMemory(options.db, projectPath)) throw new Error("authority_unavailable");
    switch (method) {
        case "memory.restore":
            return { ...applyMemoryRestore(options.db, params as unknown as MemoryRestoreRequest) };
        case "memory.edit":
            return {
                ...applyDashboardMemoryEdit(options.db, params as unknown as MemoryEditRequest),
            };
        default:
            throw new Error("unknown_memory_method");
    }
}
