import type { ContextDatabase } from "../../features/magic-context/storage";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";

/** Commit a synchronous edit and its required thinking omissions as one decision. */
export function pairedThinkingEdit<T>(args: {
    db: ContextDatabase;
    messages: unknown[];
    edit: () => T;
    needsCompanion: (result: T) => boolean;
    persistCompanion: (result: T) => void;
    state?: object;
    onRollback?: () => void;
}): T {
    const before = snapshotRender(args.messages);
    const state = args.state ? { ...args.state } : undefined;
    // A nested pair runs as a savepoint inside its caller's write transaction;
    // only the outermost one acquires, and so measures, the write lock.
    const outermost = !args.db.inTransaction;
    let heldFrom = 0;
    try {
        const result = args.db
            .transaction(() => {
                heldFrom = performance.now();
                const result = args.edit();
                if (result && typeof (result as { then?: unknown }).then === "function")
                    throw new Error("A thinking companion transaction cannot contain awaited work");
                if (args.needsCompanion(result)) args.persistCompanion(result);
                return result;
            })
            .immediate();
        if (outermost) logSlowWriteTransaction("paired_thinking_edit", heldFrom);
        return result;
    } catch (error) {
        restoreCaller(args, before, state);
        throw error;
    }
}

/** Thrown by an edit running outside the companion transaction when it reaches a
 * decision whose thinking omissions must commit together with it. */
export class CompanionPairingRequired extends Error {
    constructor() {
        super("This edit must commit together with its thinking omissions");
    }
}

/**
 * Run an edit that is expected to need no thinking omissions without opening a
 * write transaction. A pass that writes nothing then takes no write lock, and
 * each write holds it only for its own statement or short transaction, exactly
 * as an unpaired pass does.
 *
 * The edit must call `requirePairing` before the first write that could need
 * omissions. That call aborts this attempt: the caller's render and in-memory
 * state are restored and `undefined` is returned, so the caller reruns the work
 * inside `pairedThinkingEdit`. Writes made before that point are the ones a
 * held pass makes anyway, so the rerun sees them as already applied.
 */
export function editOutsideCompanionTransaction<T>(args: {
    messages: unknown[];
    edit: (requirePairing: () => never) => T;
    state?: object;
    onRollback?: () => void;
}): { result: T } | undefined {
    const before = snapshotRender(args.messages);
    const state = args.state ? { ...args.state } : undefined;
    try {
        return {
            result: args.edit(() => {
                throw new CompanionPairingRequired();
            }),
        };
    } catch (error) {
        restoreCaller(args, before, state);
        if (error instanceof CompanionPairingRequired) return undefined;
        throw error;
    }
}

function restoreCaller(
    args: { messages: unknown[]; state?: object; onRollback?: () => void },
    before: RenderSnapshot,
    state: object | undefined,
): void {
    // SQL rollback does not restore the caller's render. A failed pair must
    // leave the same source bytes available to its refusal/replay fallback.
    // Each message keeps its object identity: hosts map message objects to
    // their stable entry ids, and a rerun must still resolve them.
    args.messages.splice(0, args.messages.length, ...before.items);
    before.items.forEach((item, index) => {
        const copy = before.copies[index];
        if (!isPlainContainer(item) || !isPlainContainer(copy)) return;
        for (const key of Reflect.ownKeys(item))
            if (!(Array.isArray(item) && key === "length")) Reflect.deleteProperty(item, key);
        for (const key of Reflect.ownKeys(copy))
            if (!(Array.isArray(copy) && key === "length"))
                (item as Record<PropertyKey, unknown>)[key] = (
                    copy as Record<PropertyKey, unknown>
                )[key];
    });
    if (args.state && state) {
        for (const key of Object.keys(args.state))
            if (!(key in state)) Reflect.deleteProperty(args.state, key);
        Object.assign(args.state, state);
    }
    args.onRollback?.();
}

interface RenderSnapshot {
    items: unknown[];
    copies: unknown[];
}

function isPlainContainer(value: unknown): value is object {
    if (value === null || typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

function snapshotRender(messages: unknown[]): RenderSnapshot {
    return { items: [...messages], copies: copyRender(messages) };
}

function copyRender(messages: unknown[]): unknown[] {
    const copies = new Map<object, unknown>();
    const copy = (value: unknown): unknown => {
        if (value === null || typeof value !== "object") return value;
        const previous = copies.get(value);
        if (previous !== undefined) return previous;
        const prototype = Object.getPrototypeOf(value);
        // These lanes edit JSON containers, not opaque extension instances.
        // Preserve opaque values and callbacks rather than rejecting a valid host render.
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
            return value;
        const result: Record<PropertyKey, unknown> | unknown[] = Array.isArray(value)
            ? new Array(value.length)
            : Object.create(prototype);
        copies.set(value, result);
        for (const key of Reflect.ownKeys(value)) {
            if (Array.isArray(value) && key === "length") continue;
            (result as Record<PropertyKey, unknown>)[key] = copy(
                (value as Record<PropertyKey, unknown>)[key],
            );
        }
        return result;
    };
    return copy(messages) as unknown[];
}

export function todoCompanionRequired(
    before: { messageId: string; callId: string; stateJson: string } | null,
    after: { messageId: string; callId: string; stateJson: string } | null,
    source: readonly { id: string | undefined; thinking: boolean }[],
    headId?: string,
): boolean {
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    let lastThinking = -1;
    for (let index = 0; index < source.length; index++)
        if (source[index].thinking) lastThinking = index;
    if (lastThinking < 0) return false;
    return [before, after].some((anchor) => {
        if (!anchor) return false;
        if (headId && anchor.messageId === headId) return true;
        const index = source.findIndex((message) => message.id === anchor.messageId);
        return index >= 0 && index < lastThinking;
    });
}

export function snapshotSessionFlag(flags: Set<string>, sessionId: string): () => void {
    const before = flags.has(sessionId);
    return () => {
        if (before) flags.add(sessionId);
        else flags.delete(sessionId);
    };
}

export function snapshotSessionValue<T>(
    values: {
        get(id: string): T | undefined;
        set(id: string, value: T): unknown;
        delete(id: string): unknown;
    },
    sessionId: string,
): () => void {
    const before = values.get(sessionId);
    return () => {
        if (before === undefined) values.delete(sessionId);
        else values.set(sessionId, before);
    };
}
