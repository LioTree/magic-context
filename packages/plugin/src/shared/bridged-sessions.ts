/**
 * Sessions served by another CortexKit product's bridge inside the same host
 * process.
 *
 * When THALAMUS runs its OpenCode bridge next to Magic Context in the user's
 * own OpenCode server, it owns context management for every session it has
 * enrolled. Before any hook of such a session runs, it publishes the session ID
 * in a process-global `Map` (session ID -> `{ product, version }`) under the
 * registry symbol below. Magic Context must then leave that session alone and
 * behave exactly as before for every other session.
 *
 * The symbol comes from the global symbol registry, so both plugins reach the
 * same slot without importing each other.
 */
export const BRIDGED_SESSIONS_KEY = Symbol.for("cortexkit.bridged-sessions");

const registry = globalThis as unknown as Record<symbol, unknown>;

/**
 * True when another product's bridge has enrolled `sessionID`. Runs at the top
 * of every per-session hook, so it does one property read and one `Map.has`
 * and allocates nothing. A missing slot, a value that is not a `Map`, a
 * non-string or empty ID, or any error while reading all mean "not bridged":
 * this check must never break a session it does not own.
 */
export function isBridgedSession(sessionID: unknown): boolean {
    if (typeof sessionID !== "string" || sessionID.length === 0) return false;
    try {
        const sessions = registry[BRIDGED_SESSIONS_KEY];
        return sessions instanceof Map && sessions.has(sessionID);
    } catch {
        return false;
    }
}

/**
 * True when the bridge has published a non-empty map. Lets callers that would
 * have to dig several candidate IDs out of a payload skip that work entirely in
 * the common case where no bridge is running.
 */
export function hasBridgedSessions(): boolean {
    try {
        const sessions = registry[BRIDGED_SESSIONS_KEY];
        return sessions instanceof Map && sessions.size > 0;
    } catch {
        return false;
    }
}
