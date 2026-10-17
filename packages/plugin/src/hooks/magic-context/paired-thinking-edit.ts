import type { ContextDatabase } from "../../features/magic-context/storage";

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
    try {
        return args.db
            .transaction(() => {
                const result = args.edit();
                if (result && typeof (result as { then?: unknown }).then === "function")
                    throw new Error("A thinking companion transaction cannot contain awaited work");
                if (args.needsCompanion(result)) args.persistCompanion(result);
                return result;
            })
            .immediate();
    } catch (error) {
        // SQL rollback does not restore the caller's render. A failed pair must
        // leave the same source bytes available to its refusal/replay fallback.
        args.messages.splice(0, args.messages.length, ...before);
        if (args.state && state) {
            for (const key of Object.keys(args.state))
                if (!(key in state)) Reflect.deleteProperty(args.state, key);
            Object.assign(args.state, state);
        }
        args.onRollback?.();
        throw error;
    }
}

function snapshotRender(messages: unknown[]): unknown[] {
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
