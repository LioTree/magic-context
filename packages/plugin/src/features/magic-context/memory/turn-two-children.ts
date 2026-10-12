/**
 * Hidden historian children kept open after turn one so turn two can continue them,
 * tracked per process.
 *
 * Each entry keeps the exact handle object the executor issued: the OpenCode 2
 * executor knows its runs by handle identity, so only that object can read the
 * run's reply or release its concurrency slot. Recovery uses the entry to reattach
 * or close a child it finds in flight, and deleting the owning session (or the child
 * itself) closes it, so no child outlives the work it was kept open for.
 */
import { sessionLog } from "../../../shared/logger";

export interface RetainedTurnTwoChild {
    childSessionId: string;
    parentSessionId: string;
    harness: string;
    /** The handle object the executor issued for this child's run. */
    handle: unknown;
    /** True while a turn two in this process is still working on the child. */
    active: boolean;
    close(): Promise<void>;
}

const children = new Map<string, RetainedTurnTwoChild>();

export function registerTurnTwoChild(child: RetainedTurnTwoChild): void {
    children.set(child.childSessionId, child);
}

export function retainedTurnTwoChild(childSessionId: string): RetainedTurnTwoChild | undefined {
    return children.get(childSessionId);
}

/** Close a retained child once and forget it; closing an unknown child does nothing. */
export async function closeTurnTwoChild(childSessionId: string): Promise<void> {
    const child = children.get(childSessionId);
    if (!child) return;
    children.delete(childSessionId);
    try {
        await child.close();
    } catch (error) {
        sessionLog(
            child.parentSessionId,
            `turn two: closing child ${childSessionId} failed`,
            error,
        );
    }
}

/**
 * Close every retained child owned by, or equal to, one of `sessionIds`. Called by
 * session deletion, which also releases the facts those children were reserved for.
 */
export function closeTurnTwoChildrenOfSessions(
    sessionIds: readonly string[],
    harness?: string,
): void {
    const ids = new Set(sessionIds);
    for (const child of [...children.values()]) {
        if (harness !== undefined && child.harness !== harness) continue;
        if (ids.has(child.parentSessionId) || ids.has(child.childSessionId))
            void closeTurnTwoChild(child.childSessionId);
    }
}

export const __turnTwoChildrenTest = {
    clear: () => children.clear(),
    size: () => children.size,
};
