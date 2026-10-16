import type { Memory } from "./types";

export interface MemoryHistorySnapshot extends Omit<Memory, "importance" | "sourceType"> {
    revision: number;
    importance: number | null;
    sourceType: string | null;
}
export interface MemoryHistoryChange {
    memoryId: number;
    role: "source" | "survivor" | "target";
    beforeRevision: number | null;
    afterRevision: number | null;
    before: MemoryHistorySnapshot | null;
    after: MemoryHistorySnapshot | null;
    completeness: "complete" | "legacy-partial" | "unsupported";
}
export interface MemoryHistoryDecision {
    version: 1;
    decisionKey: string;
    projectPath: string;
    writer: string;
    operation: string;
    reason: string;
    appliedAt: number;
    evidence: unknown;
    sourceIds: number[];
    survivorId: number | null;
    rows: MemoryHistoryChange[];
    restorable: boolean;
    refusalReason: string | null;
}
export interface MemoryRevisionExpectation {
    memoryId: number;
    revision: number;
}
export interface MemoryWriteConflict {
    memoryId: number;
    expectedRevision: number | null;
    currentRevision: number | null;
    duplicateId?: number;
}
export interface MemoryRestoreRequest {
    projectPath: string;
    decisionKey: string;
    operationId: string;
    expectedRevisions: MemoryRevisionExpectation[];
}
export interface MemoryEditRequest {
    projectPath: string;
    operationId: string;
    expectedRevisions: MemoryRevisionExpectation[];
    changes: Array<{
        memoryId: number;
        status?: Memory["status"];
        category?: string;
        content?: string;
    }>;
}
export interface MemoryEditReceipt {
    version: 1;
    state: "applied" | "refused" | "conflict";
    projectPath: string;
    operationId: string;
    reason: string | null;
    detail?: "module_host_not_running";
    decisionKey: string | null;
    revisions: MemoryRevisionExpectation[];
    conflicts: MemoryWriteConflict[];
}
export interface MemoryRestoreReceipt extends Omit<MemoryEditReceipt, "decisionKey"> {
    decisionKey: string;
    restoredDecisionKey: string | null;
    adoption: "dashboard_epoch_hard";
}
export interface MemoryRestorePreview {
    version: 1;
    state: "ready" | "refused" | "conflict";
    projectPath: string;
    decisionKey: string;
    reason: string | null;
    decision: MemoryHistoryDecision | null;
    expectedRevisions: MemoryRevisionExpectation[];
    changes: Array<{
        memoryId: number;
        before: MemoryHistorySnapshot;
        after: MemoryHistorySnapshot;
    }>;
    adoption: "dashboard_epoch_hard";
}
export interface MemoryHistoryRequest {
    projectPath: string;
    memoryId?: number;
    limit?: number;
    cursor?: string;
}
export interface MemoryHistoryPage {
    version: 1;
    decisions: MemoryHistoryDecision[];
    nextCursor: string | null;
}
