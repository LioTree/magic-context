/**
 * Whether this request's messages are already final when its system hook runs.
 *
 * Stock OpenCode 1 builds every provider request in the same order: the prompt loop runs
 * `experimental.chat.messages.transform`, converts the messages, re-reads AGENTS.md
 * and configured instruction files, and only then runs
 * `experimental.chat.system.transform` inside the LLM request builder. So when the
 * system hook sees a changed system prompt, the messages of that same request are
 * already final, and the new system text is already going to the provider. That
 * request rewrites the provider's prompt cache from the system block onward.
 * Rebuilding Magic Context's frozen message prefix on the following request would
 * invalidate the provider's cached input a second time instead of sharing this
 * request's system-prompt cache invalidation.
 *
 * Some private OpenCode 1 hosts run system before messages instead. Learn the
 * session's order from its first non-skipped hook and retain it until session
 * cleanup. On a messages-first host each messages pass sets a marker for its own
 * later system hook. On a system-first host no system hook may consume a previous
 * request's marker as evidence that its own messages are final, even if that
 * previous request aborted without a completion event.
 *
 * This is order detection, not a request id: it requires a consistent hook order
 * and serialized requests within each session. Skipped internal-agent system
 * calls must not enter the tracker. Hosts that switch order or overlap requests
 * within one session need an explicit request identity shared by both hooks.
 * OpenCode 2 and Pi deliberately do not use this helper.
 *
 * A completion clears the marker only for a reply newer than every assistant
 * message the messages pass saw, so a late event for an earlier reply cannot clear
 * a fresh marker.
 */
export interface RequestHookOrder {
    /** The messages transform is preparing a provider request for this session. */
    messagesPrepared(
        sessionId: string,
        messages: readonly { info?: { id?: unknown; role?: unknown } }[],
    ): void;
    /** An assistant message finished (served, failed or aborted). */
    assistantCompleted(sessionId: string, messageId: string | undefined): void;
    /**
     * Called by a non-skipped system hook. Returns true only if a messages pass
     * ran since the last consumption or newer completion, and the session was
     * observed to run messages before system. Consumes that pass's marker.
     */
    consumeMessagesPrepared(sessionId: string): boolean;
    clearSession(sessionId: string): void;
}

export function createRequestHookOrder(): RequestHookOrder {
    // Value: the newest assistant message id the messages pass saw ("" when none).
    const prepared = new Map<string, string>();
    const messagesFirst = new Map<string, boolean>();
    return {
        messagesPrepared(sessionId, messages) {
            if (!messagesFirst.has(sessionId)) messagesFirst.set(sessionId, true);
            let newestAssistant = "";
            for (const message of messages) {
                const id = message.info?.id;
                if (message.info?.role !== "assistant" || typeof id !== "string") continue;
                if (id > newestAssistant) newestAssistant = id;
            }
            prepared.set(sessionId, newestAssistant);
        },
        assistantCompleted(sessionId, messageId) {
            const newestSeen = prepared.get(sessionId);
            if (newestSeen === undefined) return;
            // OpenCode message ids sort by creation time. An id we cannot compare is
            // treated as a newer reply: the fallback is the system-first path.
            if (messageId === undefined || messageId > newestSeen) prepared.delete(sessionId);
        },
        consumeMessagesPrepared(sessionId) {
            if (!messagesFirst.has(sessionId)) messagesFirst.set(sessionId, false);
            const had = messagesFirst.get(sessionId) === true && prepared.has(sessionId);
            prepared.delete(sessionId);
            return had;
        },
        clearSession(sessionId) {
            prepared.delete(sessionId);
            messagesFirst.delete(sessionId);
        },
    };
}
