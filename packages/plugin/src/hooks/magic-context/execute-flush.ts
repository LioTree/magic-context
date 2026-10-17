import {
    getPendingOps,
    removePendingOp,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

export function executeFlush(db: Database, sessionId: string, deferToTransform = false): string {
    try {
        const pendingOps = getPendingOps(db, sessionId);

        if (pendingOps.length === 0) {
            return "No pending operations to flush.";
        }

        // Only the transform knows whether dropping this tool would edit messages
        // before signed thinking. Leave the tag active until that check admits it.
        if (deferToTransform)
            return `Queued ${pendingOps.length} pending operations for the next admitted materialization.`;

        let dropped = 0;

        db.transaction(() => {
            for (const op of pendingOps) {
                updateTagStatus(db, sessionId, op.tagId, "dropped");
                removePendingOp(db, sessionId, op.tagId);
                dropped++;
            }
        }).immediate();

        const parts: string[] = [];
        if (dropped > 0) parts.push(`${dropped} dropped`);

        return `Flushed: ${parts.join(", ")}. Changes take effect on next message.`;
    } catch (error) {
        sessionLog(sessionId, "ctx-flush failed:", error);
        return `Error: Failed to flush context operations. ${getErrorMessage(error)}`;
    }
}
