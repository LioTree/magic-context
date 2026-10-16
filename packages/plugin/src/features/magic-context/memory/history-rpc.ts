import type { RustModeModuleClient } from "../../../hooks/magic-context/rust-mode-transform";
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

/** Ownership is sampled before routing and rechecked by the admitted writer under its lock. */
export async function memoryHistoryRpc(
    options: { db: Database; directory: string; moduleClient?: RustModeModuleClient },
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
    if (!tsOwnsMemory(options.db, projectPath)) {
        if (!options.moduleClient) throw new Error("authority_unavailable");
        const response = await options.moduleClient.call({
            sessionId: "dashboard-memory",
            projectRoot: options.directory,
            method,
            body: { name: method, arguments: params },
        });
        const raw =
            response && typeof response === "object" && "result" in response
                ? response.result
                : response;
        const payload =
            raw && typeof raw === "object" && "structuredContent" in raw
                ? raw.structuredContent
                : null;
        if (
            !payload ||
            typeof payload !== "object" ||
            !("version" in payload) ||
            payload.version !== 1
        )
            throw new Error("invalid_module_receipt");
        if (method === "memory.restore" || method === "memory.edit") {
            if (
                !("state" in payload) ||
                !["applied", "refused", "conflict"].includes(String(payload.state)) ||
                !("operationId" in payload) ||
                payload.operationId !== params.operationId ||
                !("projectPath" in payload) ||
                payload.projectPath !== projectPath ||
                !("revisions" in payload) ||
                !Array.isArray(payload.revisions) ||
                !("conflicts" in payload) ||
                !Array.isArray(payload.conflicts)
            )
                throw new Error("invalid_module_receipt");
        }
        const value = payload as Record<string, unknown>;
        const record = (item: unknown): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item);
        const positive = (item: unknown) =>
            typeof item === "number" && Number.isSafeInteger(item) && item > 0;
        const revisions = value.revisions as unknown[];
        const conflicts = value.conflicts as unknown[];
        const newKey = method === "memory.restore" ? value.restoredDecisionKey : value.decisionKey;
        if (
            !("reason" in value) ||
            (value.reason !== null && typeof value.reason !== "string") ||
            !((method === "memory.restore" ? "restoredDecisionKey" : "decisionKey") in value) ||
            revisions.some(
                (row) => !record(row) || !positive(row.memoryId) || !positive(row.revision),
            ) ||
            new Set(revisions.map((row) => (row as Record<string, unknown>).memoryId)).size !==
                revisions.length ||
            conflicts.some(
                (row) =>
                    !record(row) ||
                    !positive(row.memoryId) ||
                    !("expectedRevision" in row) ||
                    !("currentRevision" in row) ||
                    (row.expectedRevision !== null && !positive(row.expectedRevision)) ||
                    (row.currentRevision !== null && !positive(row.currentRevision)) ||
                    ("duplicateId" in row && !positive(row.duplicateId)),
            )
        )
            throw new Error("invalid_module_receipt");
        if (
            method === "memory.restore" &&
            (value.decisionKey !== params.decisionKey || value.adoption !== "dashboard_epoch_hard")
        )
            throw new Error("invalid_module_receipt");
        if (value.state === "applied") {
            const expected = params.expectedRevisions;
            if (
                value.reason !== null ||
                typeof newKey !== "string" ||
                !newKey ||
                !Array.isArray(expected) ||
                expected.length !== revisions.length ||
                revisions.some(
                    (row) =>
                        !expected.some(
                            (target) =>
                                record(target) &&
                                target.memoryId === (row as Record<string, unknown>).memoryId,
                        ),
                ) ||
                (record(raw) && raw.isError === true)
            )
                throw new Error("invalid_module_receipt");
        } else if (
            newKey !== null ||
            revisions.length !== 0 ||
            typeof value.reason !== "string" ||
            !value.reason
        )
            throw new Error("invalid_module_receipt");
        return { ...payload };
    }
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
