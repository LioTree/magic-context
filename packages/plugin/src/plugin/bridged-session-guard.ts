import type { Hooks, ToolDefinition } from "@opencode-ai/plugin";
import { MOVED_SESSION_MESSAGE } from "../features/magic-context/mode3-move-record";
import { deleteSessionMetaWithPayloads } from "../features/magic-context/storage-session-payloads";
import {
    BRIDGED_SESSIONS_KEY,
    hasBridgedSessions,
    isBridgedSession,
} from "../shared/bridged-sessions";
import { getHarness } from "../shared/harness";
import { log } from "../shared/logger";
import { isRecord } from "../shared/record-type-guard";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type { Database } from "../shared/sqlite";

/**
 * OpenCode 1 stand-down for sessions another product's bridge has enrolled
 * (see `shared/bridged-sessions.ts`).
 *
 * The plugin entry hands OpenCode one hooks object; every per-session callback
 * the host makes enters through it. Wrapping that object here, instead of
 * guarding each feature (tagging, nudges, historian, markers, auto-search, todo
 * injection, Rust-mode module calls, ...), puts the check in front of all of
 * them at once: an enrolled session's callbacks return before any of that code
 * runs, so it gets no tags, no marker or database writes, no module calls and
 * no toasts. Sessions that are not enrolled reach the original callbacks with
 * the same arguments and get back the same promise, so they behave exactly as
 * before.
 *
 * The same gate refuses sessions the offline move handed to mode 3 (see
 * `features/magic-context/mode3-move-record.ts`), so no hook can manage one by
 * mistake. Those fail closed: their transform throws one clear message instead
 * of passing the history through unmanaged, and every other hook does nothing.
 *
 * OpenCode 2 (`v2/`) and Pi register through their own entry points and do not
 * use this wrapper.
 */

/** Hook keys whose first argument carries the session as `input.sessionID`. */
export const SESSION_INPUT_HOOKS = [
    "chat.message",
    "chat.params",
    "chat.headers",
    "command.execute.before",
    "tool.execute.before",
    "tool.execute.after",
    "experimental.chat.system.transform",
    "experimental.text.complete",
    "experimental.session.compacting",
    "experimental.compaction.autocontinue",
    "shell.env",
] as const satisfies ReadonlyArray<keyof Hooks>;

type SessionInputHook = (input: { sessionID?: unknown }, output: unknown) => Promise<void>;

const RESOLVED = Promise.resolve();

function bridgeProduct(sessionID: string): string | undefined {
    try {
        const sessions = (globalThis as unknown as Record<symbol, unknown>)[BRIDGED_SESSIONS_KEY];
        if (!(sessions instanceof Map)) return undefined;
        const owner = sessions.get(sessionID) as { product?: unknown } | undefined;
        return typeof owner?.product === "string" && owner.product.length > 0
            ? owner.product
            : undefined;
    } catch {
        return undefined;
    }
}

/** Text a Magic Context tool returns when the bridge owns the calling session. */
export function bridgedSessionToolRefusal(toolId: string, sessionID: string): string {
    const product = bridgeProduct(sessionID);
    return `Error: ${toolId} is served by the bridge${product ? ` (${product})` : ""} in this session, not by Magic Context. Use the bridge's tool instead.`;
}

/** RPC reply for a per-session request about a session the bridge owns. */
export const BRIDGED_SESSION_RPC_ERROR = "session is served by the bridge";

/**
 * The session a messages-transform pass belongs to. Mirrors how the transform
 * itself resolves it: the first message carrying a non-empty `sessionID`.
 */
function transformSessionId(messages: ReadonlyArray<{ info?: unknown }>): string | undefined {
    for (const message of messages) {
        const sessionID = (message?.info as { sessionID?: unknown } | undefined)?.sessionID;
        if (typeof sessionID === "string" && sessionID.length > 0) return sessionID;
    }
    return undefined;
}

/**
 * Whether a host event concerns an enrolled session. OpenCode puts the session
 * ID in different places per event family: top-level `properties.sessionID`
 * (session.idle, session.error, session.status, message.removed, ...),
 * `properties.info.sessionID` (message.updated), `properties.part.sessionID`
 * (message.part.updated), and `properties.info.id` for the session.* events
 * whose `info` is the session itself (session.created/updated/deleted). Events
 * with no session (server.instance.disposed, installation updates) never match.
 */
export function eventConcernsBridgedSession(event: unknown): boolean {
    return hasBridgedSessions() && eventConcernsSession(event, isBridgedSession);
}

/** Whether a host event concerns a session `matches` accepts; see above. */
function eventConcernsSession(event: unknown, matches: (sessionID: unknown) => boolean): boolean {
    if (!isRecord(event)) return false;
    const properties = event.properties;
    if (!isRecord(properties)) return false;
    if (matches(properties.sessionID)) return true;
    const info = properties.info;
    if (isRecord(info)) {
        if (matches(info.sessionID)) return true;
        if (
            typeof event.type === "string" &&
            event.type.startsWith("session.") &&
            matches(info.id)
        ) {
            return true;
        }
    }
    const part = properties.part;
    return isRecord(part) && matches(part.sessionID);
}

/** The error a moved session's transform throws, so the user sees why. */
export class MovedSessionError extends Error {
    readonly code = "MAGIC_CONTEXT_SESSION_MOVED";

    constructor() {
        super(MOVED_SESSION_MESSAGE);
        this.name = "MovedSessionError";
    }
}

const NEVER_MOVED = (): boolean => false;

/**
 * The session a `session.deleted` event removes, when that session is
 * enrolled; otherwise undefined.
 */
function deletedBridgedSessionId(event: unknown): string | undefined {
    if (!isRecord(event) || event.type !== "session.deleted") return undefined;
    const properties = isRecord(event.properties) ? event.properties : undefined;
    const info = isRecord(properties?.info) ? properties.info : undefined;
    const sessionId = info?.id ?? properties?.sessionID;
    return typeof sessionId === "string" && isBridgedSession(sessionId) ? sessionId : undefined;
}

/**
 * Remove the metadata and project state OpenCode 1's `session.created` handler wrote for a
 * session that was enrolled in a bridge afterwards: its `session_meta` row
 * (subagent flag, cache TTL) and its `session_projects` row (project
 * identity). The bridge enrolls sessions that already exist, so their
 * `session.created` can reach Magic Context before the enrollment does (a
 * session enrolled earlier has its `session.created` stood down and owns no
 * rows here). After enrollment every hook skips the session, including normal
 * `session.deleted` cleanup. Remove that metadata, its separately stored payloads,
 * and the project row. Other writers may own further rows for the same session;
 * cleaning those up remains the bridge's job.
 */
export function dropBridgedSessionCreatedRows(db: Database, sessionId: string): void {
    const harness = getHarness();
    db.transaction(() => {
        deleteSessionMetaWithPayloads(db, sessionId, harness);
        db.prepare("DELETE FROM session_projects WHERE session_id = ? AND harness = ?").run(
            sessionId,
            harness,
        );
    }).immediate();
}

/** Refuse Magic Context tool calls that arrive for an enrolled or moved session. */
export function guardBridgedSessionTools(
    tools: Record<string, ToolDefinition>,
    isMovedSession: (sessionID: unknown) => boolean = NEVER_MOVED,
): Record<string, ToolDefinition> {
    return Object.fromEntries(
        Object.entries(tools).map(([id, definition]) => [
            id,
            {
                ...definition,
                execute(args, context) {
                    if (isBridgedSession(context?.sessionID)) {
                        return Promise.resolve(bridgedSessionToolRefusal(id, context.sessionID));
                    }
                    if (isMovedSession(context?.sessionID)) {
                        return Promise.resolve(`Error: ${MOVED_SESSION_MESSAGE}`);
                    }
                    return definition.execute(args, context);
                },
            } satisfies ToolDefinition,
        ]),
    );
}

/**
 * Make every per-session RPC method registered on `server` refuse requests
 * whose `sessionId` the bridge owns. Must run before the handlers are
 * registered. Methods without a session parameter (memory history,
 * announcements, toast duration) are unaffected.
 */
export function guardBridgedSessionRpc(
    server: MagicContextRpcServer,
    isMovedSession: (sessionID: unknown) => boolean = NEVER_MOVED,
): void {
    const register = server.handle.bind(server);
    server.handle = (method, handler) =>
        register(method, (params) =>
            isBridgedSession(params?.sessionId)
                ? Promise.resolve({ error: BRIDGED_SESSION_RPC_ERROR })
                : isMovedSession(params?.sessionId)
                  ? Promise.resolve({ error: MOVED_SESSION_MESSAGE })
                  : handler(params),
        );
}

export interface StandDownOptions {
    /**
     * Called, instead of the normal event handling, when an enrolled session is
     * deleted. The plugin entry uses it to run `dropBridgedSessionCreatedRows`.
     */
    onBridgedSessionDeleted?: (sessionId: string) => void;
    /**
     * Whether the offline move handed the session to mode 3. Such a session is
     * stood down like an enrolled one, except that its transform fails closed.
     */
    isMovedSession?: (sessionId: unknown) => boolean;
}

/** Wrap the OpenCode 1 hooks object so enrolled sessions are left untouched. */
export function standDownForBridgedSessions(hooks: Hooks, options: StandDownOptions = {}): Hooks {
    const guarded: Hooks = { ...hooks };
    const slots = guarded as Record<string, unknown>;
    const isMovedSession = options.isMovedSession ?? NEVER_MOVED;
    const standsDown = (sessionID: unknown) =>
        isBridgedSession(sessionID) || isMovedSession(sessionID);

    // `tool.definition` carries no session; the plugin entry (src/index.ts)
    // attributes it to the provider and model of the most recent
    // `chat.message`. When that message
    // belonged to an enrolled session the flight's tool set is the bridge's,
    // so measuring it would charge the bridge's tools to our model key.
    let lastChatMessageBridged = false;

    for (const key of SESSION_INPUT_HOOKS) {
        const inner = hooks[key] as SessionInputHook | undefined;
        if (!inner) continue;
        slots[key] =
            key === "chat.message"
                ? (input: { sessionID?: unknown }, output: unknown) => {
                      lastChatMessageBridged = standsDown(input?.sessionID);
                      return lastChatMessageBridged ? RESOLVED : inner(input, output);
                  }
                : (input: { sessionID?: unknown }, output: unknown) =>
                      standsDown(input?.sessionID) ? RESOLVED : inner(input, output);
    }

    const toolDefinition = hooks["tool.definition"];
    if (toolDefinition) {
        guarded["tool.definition"] = (input, output) =>
            lastChatMessageBridged ? RESOLVED : toolDefinition(input, output);
    }

    const transform = hooks["experimental.chat.messages.transform"] as
        | ((
              input: Record<string, never>,
              output: { messages: Array<{ info?: unknown }> },
          ) => Promise<unknown>)
        | undefined;
    if (transform) {
        // Standing down returns the host's array untouched: no tag prefixes, no
        // injected blocks, no fail-closed refusal, no storage pass.
        slots["experimental.chat.messages.transform"] = (
            input: Record<string, never>,
            output: { messages: Array<{ info?: unknown }> },
        ) => {
            if (hasBridgedSessions() && isBridgedSession(transformSessionId(output.messages))) {
                return Promise.resolve(output.messages);
            }
            // A moved session is never served unmanaged: the history it would
            // send is the full uncompacted session.
            if (isMovedSession(transformSessionId(output.messages))) {
                return Promise.reject(new MovedSessionError());
            }
            return transform(input, output);
        };
    }

    const event = hooks.event;
    if (event) {
        guarded.event = (input) => {
            if (eventConcernsSession(input?.event, isMovedSession)) return RESOLVED;
            if (!eventConcernsBridgedSession(input?.event)) return event(input);
            const deleted = deletedBridgedSessionId(input?.event);
            if (deleted && options.onBridgedSessionDeleted) {
                try {
                    options.onBridgedSessionDeleted(deleted);
                } catch (error) {
                    log(
                        `[magic-context] bridged session ${deleted}: dropping created rows failed`,
                        error,
                    );
                }
            }
            return RESOLVED;
        };
    }

    if (hooks.tool) guarded.tool = guardBridgedSessionTools(hooks.tool, isMovedSession);

    return guarded;
}
