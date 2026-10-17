import type { Hooks, ToolDefinition } from "@opencode-ai/plugin";
import {
    BRIDGED_SESSIONS_KEY,
    hasBridgedSessions,
    isBridgedSession,
} from "../shared/bridged-sessions";
import { isRecord } from "../shared/record-type-guard";
import type { MagicContextRpcServer } from "../shared/rpc-server";

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
    if (!hasBridgedSessions() || !isRecord(event)) return false;
    const properties = event.properties;
    if (!isRecord(properties)) return false;
    if (isBridgedSession(properties.sessionID)) return true;
    const info = properties.info;
    if (isRecord(info)) {
        if (isBridgedSession(info.sessionID)) return true;
        if (
            typeof event.type === "string" &&
            event.type.startsWith("session.") &&
            isBridgedSession(info.id)
        ) {
            return true;
        }
    }
    const part = properties.part;
    return isRecord(part) && isBridgedSession(part.sessionID);
}

/** Refuse Magic Context tool calls that arrive for an enrolled session. */
export function guardBridgedSessionTools(
    tools: Record<string, ToolDefinition>,
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
export function guardBridgedSessionRpc(server: MagicContextRpcServer): void {
    const register = server.handle.bind(server);
    server.handle = (method, handler) =>
        register(method, (params) =>
            isBridgedSession(params?.sessionId)
                ? Promise.resolve({ error: BRIDGED_SESSION_RPC_ERROR })
                : handler(params),
        );
}

/** Wrap the OpenCode 1 hooks object so enrolled sessions are left untouched. */
export function standDownForBridgedSessions(hooks: Hooks): Hooks {
    const guarded: Hooks = { ...hooks };
    const slots = guarded as Record<string, unknown>;

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
                      lastChatMessageBridged = isBridgedSession(input?.sessionID);
                      return lastChatMessageBridged ? RESOLVED : inner(input, output);
                  }
                : (input: { sessionID?: unknown }, output: unknown) =>
                      isBridgedSession(input?.sessionID) ? RESOLVED : inner(input, output);
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
        ) =>
            hasBridgedSessions() && isBridgedSession(transformSessionId(output.messages))
                ? Promise.resolve(output.messages)
                : transform(input, output);
    }

    const event = hooks.event;
    if (event) {
        guarded.event = (input) =>
            eventConcernsBridgedSession(input?.event) ? RESOLVED : event(input);
    }

    if (hooks.tool) guarded.tool = guardBridgedSessionTools(hooks.tool);

    return guarded;
}
