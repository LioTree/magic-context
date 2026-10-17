import { activeAnthropicTurnStart } from "./active-anthropic-turn";
import { thinkingAnchor } from "./edit-admission";

export type SystemDateRequestIdentity = object | string;
export interface SystemDateRequest {
    readonly sessionId: string;
    readonly identity: SystemDateRequestIdentity;
}
interface RequestState extends SystemDateRequest {
    turnId: string | undefined;
    explicit: boolean;
    systemSeen: boolean;
    systemDone: boolean;
    messagesSeen: boolean;
    permitted: boolean | undefined;
    keptSignedThinking?: boolean;
    ambiguous: boolean;
    waiting?: (permitted: boolean) => void;
}
type Channel = Map<string, Map<SystemDateRequestIdentity, RequestState>>;
const channels = new WeakMap<Set<string>, Channel>();
const outputUpdates = new WeakMap<string[], () => void>();
const outputIdentities = new WeakMap<object, SystemDateRequestIdentity>();
const outputRequests = new WeakMap<object, SystemDateRequest>();
const thinkingDateDebts = new WeakMap<Set<string>, Set<string>>();

/** Inspect the returned render, not raw history whose saved omissions still need replay. */
export function hasKeptSignedThinking(messages: readonly unknown[]): boolean {
    for (const raw of messages) {
        if (!raw || typeof raw !== "object") continue;
        const message = raw as {
            role?: string;
            info?: { role?: string };
            parts?: unknown;
            content?: unknown;
            providerPayload?: { items?: unknown[] };
        };
        if ((message.info?.role ?? message.role) !== "assistant") continue;
        const parts = message.parts ?? message.content;
        if (
            Array.isArray(parts) &&
            parts.some((part) => {
                if (!part || typeof part !== "object") return false;
                const block = part as {
                    type?: string;
                    kind?: string;
                    metadata?: object;
                    data?: unknown;
                };
                if (
                    ![
                        "reasoning",
                        "thinking",
                        "redacted_thinking",
                        "redactedThinking",
                        "redacted_reasoning",
                    ].includes(String(block.type ?? block.kind))
                )
                    return false;
                return (
                    thinkingAnchor(part) !== undefined ||
                    (typeof block.data === "string" && block.data.length > 0) ||
                    (!!block.metadata && Object.keys(block.metadata).length > 0)
                );
            })
        )
            return true;
        if (
            message.providerPayload?.items?.some(
                (item) =>
                    !!item &&
                    typeof item === "object" &&
                    (item as { type?: string }).type === "reasoning",
            )
        )
            return true;
    }
    return false;
}

export function systemDateThinkingHeld(
    history: Set<string>,
    request: SystemDateRequest | undefined,
): boolean | undefined {
    return state(history, request)?.keptSignedThinking;
}

export function deferSystemDateForThinking(
    history: Set<string>,
    request: SystemDateRequest | undefined,
): void {
    const current = state(history, request);
    if (current?.keptSignedThinking !== true) return;
    let pending = thinkingDateDebts.get(history);
    if (!pending) thinkingDateDebts.set(history, (pending = new Set()));
    pending.add(current.sessionId);
}

export function acknowledgeSystemDateAdvance(history: Set<string>, sessionId: string): void {
    thinkingDateDebts.get(history)?.delete(sessionId);
}

/** Use the last real-user message ID that anchors thinking recovery, including
 * its exclusions for synthetic messages and tool-result carriers. */
export function systemDateTurnId(messages: readonly unknown[]): string | undefined {
    const start = activeAnthropicTurnStart(messages, true);
    if (start === undefined) return;
    const message = messages[start - 1] as { info?: { id?: unknown }; id?: unknown };
    const id = message.info?.id ?? message.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Keep OpenCode 2's per-request draft identity on the adapted messages output
 * so both hook stages address the same request. */
export function bindSystemDateRequestIdentity(
    output: object,
    identity: SystemDateRequestIdentity,
): void {
    outputIdentities.set(output, identity);
}
export function systemDateRequestIdentity(output: object): SystemDateRequestIdentity | undefined {
    return outputIdentities.get(output);
}
export function bindSystemDateRequest(
    output: object,
    request: SystemDateRequest | undefined,
): void {
    if (request) outputRequests.set(output, request);
}
export function systemDateRequestForOutput(
    history: Set<string>,
    output: object,
): SystemDateRequest | undefined {
    const request = outputRequests.get(output);
    return state(history, request);
}

/** Reapply deferred host dates after the host copied the system prompt strings. */
export function bindSystemDateOutput(system: string[], update: () => void): void {
    outputUpdates.set(system, update);
}
export function publishSystemDateOutput(system: string[]): void {
    outputUpdates.get(system)?.();
    outputUpdates.delete(system);
}
export function registerSystemDateRefresh(history: Set<string>): void {
    if (!channels.has(history)) channels.set(history, new Map());
}
export function hasSystemDateRefresh(history: Set<string>): boolean {
    return channels.has(history);
}

/** Each pass owns a unique handle. Without a host request identity, opposite
 * stages may pair only on an unambiguous real-user turn. Overlapping unidentified
 * requests in that turn stay frozen rather than borrowing another pass's grant. */
export function beginSystemDateRequest(
    history: Set<string>,
    sessionId: string,
    stage: "system" | "system-after-messages" | "messages",
    turnId: string | undefined,
    identity?: SystemDateRequestIdentity,
): SystemDateRequest | undefined {
    const channel = channels.get(history);
    if (!channel) return;
    let requests = channel.get(sessionId);
    if (!requests) channel.set(sessionId, (requests = new Map()));
    let request = identity === undefined ? undefined : requests.get(identity);
    if (identity === undefined) {
        const candidates = [...requests.values()].filter(
            (candidate) =>
                !candidate.explicit &&
                !(candidate.systemSeen && candidate.messagesSeen) &&
                (stage === "system-after-messages" || candidate.turnId === turnId),
        );
        const matching = candidates.filter(
            (candidate) =>
                !candidate.ambiguous &&
                (stage === "messages"
                    ? candidate.systemSeen && !candidate.messagesSeen
                    : candidate.messagesSeen && !candidate.systemSeen),
        );
        if (turnId !== undefined && candidates.length === 1 && matching.length === 1) {
            request = matching[0];
        } else if (candidates.length > 0) {
            for (const candidate of candidates) candidate.ambiguous = true;
        }
    }
    if (!request) {
        const sameTurn = [...requests.values()].some(
            (candidate) =>
                !candidate.explicit &&
                !(candidate.systemSeen && candidate.messagesSeen) &&
                (stage === "system-after-messages" || candidate.turnId === turnId),
        );
        request = {
            sessionId,
            identity: identity ?? {},
            turnId,
            explicit: identity !== undefined,
            systemSeen: false,
            systemDone: false,
            messagesSeen: false,
            permitted: undefined,
            ambiguous: identity === undefined && (turnId === undefined || sameTurn),
        };
        const blocked = [...requests.values()].filter(
            (candidate) =>
                !candidate.explicit &&
                candidate.ambiguous &&
                !(candidate.systemSeen && candidate.messagesSeen) &&
                candidate.turnId === turnId,
        ).length;
        if (request.explicit || !request.ambiguous || blocked < 2)
            requests.set(request.identity, request);
    }
    if (stage === "messages") request.messagesSeen = true;
    else request.systemSeen = true;
    return request;
}
function state(
    history: Set<string>,
    request: SystemDateRequest | undefined,
): RequestState | undefined {
    if (!request) return;
    const current = channels.get(history)?.get(request.sessionId)?.get(request.identity);
    return current === request ? current : undefined;
}
export function systemDateRefreshPermission(
    history: Set<string>,
    request: SystemDateRequest | undefined,
): boolean | undefined {
    const current = state(history, request);
    return current?.ambiguous ? undefined : current?.permitted;
}
export function waitForSystemDateRefresh(
    history: Set<string>,
    request: SystemDateRequest | undefined,
    apply: (permitted: boolean) => void,
): boolean {
    const current = state(history, request);
    if (!current) return false;
    current.waiting = apply;
    return true;
}
function retire(history: Set<string>, current: RequestState): void {
    const unpairable = !current.explicit && current.turnId === undefined;
    if (!unpairable && (!current.systemDone || current.permitted === undefined)) return;
    if (unpairable) {
        const apply = current.waiting;
        current.waiting = undefined;
        apply?.(false);
    }
    const channel = channels.get(history);
    const requests = channel?.get(current.sessionId);
    requests?.delete(current.identity);
    if (requests?.size === 0) channel?.delete(current.sessionId);
}
export function finishSystemDateRefresh(
    history: Set<string>,
    request: SystemDateRequest | undefined,
    permitted: boolean,
    keptSignedThinking?: boolean,
): void {
    const current = state(history, request);
    if (!current) return;
    current.keptSignedThinking = keptSignedThinking;
    current.permitted =
        current.ambiguous || keptSignedThinking === true
            ? false
            : permitted ||
              (keptSignedThinking === false &&
                  thinkingDateDebts.get(history)?.has(current.sessionId) === true);
    const apply = current.waiting;
    current.waiting = undefined;
    apply?.(current.permitted);
    retire(history, current);
}
export function finishSystemDateHook(
    history: Set<string>,
    request: SystemDateRequest | undefined,
): void {
    const current = state(history, request);
    if (!current) return;
    current.systemDone = true;
    retire(history, current);
}
export function clearSystemDateRefresh(history: Set<string>, sessionId: string): void {
    channels.get(history)?.delete(sessionId);
    thinkingDateDebts.get(history)?.delete(sessionId);
}
