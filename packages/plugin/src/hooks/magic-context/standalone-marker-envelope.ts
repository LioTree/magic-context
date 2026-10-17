import { createHash } from "node:crypto";
import {
    getHookToolNames,
    getMarkerToolDefinitions,
} from "../../features/magic-context/tool-definition-tokens";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { measureLkgReplay } from "./lkg-fit-measure";
import {
    currentLkgRequestIdentity,
    type LkgMarkerIdentity,
    type LkgRequestIdentity,
    lkgMarkerReading,
} from "./lkg-measured-request";
import {
    boundMarkerEnvelope,
    boundMarkerMessages,
    lowerBoundMarkerMessages,
} from "./marker-envelope";
import type { MessageLike } from "./transform-operations";
import { hasCountableParts } from "./wire-content";

const systems = new BoundedSessionMap<{
    model: string;
    hash: string;
    system: string[];
    request?: LkgRequestIdentity;
}>(1000);

export function recordMarkerSystem(
    sessionId: string,
    model: string,
    hash: string,
    system: string[],
): void {
    systems.set(sessionId, {
        model,
        hash,
        system: [...system],
        request: currentLkgRequestIdentity(sessionId),
    });
}

export function clearMarkerSystem(sessionId: string): void {
    systems.delete(sessionId);
}

/**
 * Envelope identity of `request`: its model, a digest of the exact system strings
 * the system-transform hook recorded for it, and the sorted tool names the
 * `tool.definition` hook reported. Undefined unless the recorded system belongs
 * to this request. OpenCode does not run that hook for MCP tools, so an MCP
 * tool-set change is not part of this identity.
 */
export function standaloneMarkerIdentity(
    sessionId: string,
    request: LkgRequestIdentity | undefined,
    agentName: string | undefined,
): LkgMarkerIdentity | undefined {
    const system = systems.get(sessionId);
    if (!request || !system || system.request !== request || system.model !== request.modelKey)
        return undefined;
    const slash = system.model.indexOf("/");
    if (slash <= 0) return undefined;
    const toolNames = getHookToolNames(
        system.model.slice(0, slash),
        system.model.slice(slash + 1),
        agentName,
    );
    if (!toolNames) return undefined;
    return {
        model: system.model,
        systemDigest: createHash("sha256").update(JSON.stringify(system.system)).digest("hex"),
        toolNames,
    };
}

function sameIdentity(a: LkgMarkerIdentity, b: LkgMarkerIdentity): boolean {
    return (
        a.model === b.model &&
        a.systemDigest === b.systemDigest &&
        a.toolNames.length === b.toolNames.length &&
        a.toolNames.every((name, index) => name === b.toolNames[index])
    );
}

/**
 * Upper bound on the current request's system/tool envelope from the most recent
 * completed request: its provider input usage minus a lower bound on the message
 * array Magic Context returned for it. Qualifies only when that request had the
 * same model, system strings and hook-visible tool names as the current one.
 */
function standaloneEnvelopeUpper(
    sessionId: string,
    model: string,
    agentName: string | undefined,
): number | undefined {
    const reading = lkgMarkerReading(sessionId);
    const current = standaloneMarkerIdentity(
        sessionId,
        currentLkgRequestIdentity(sessionId),
        agentName,
    );
    if (!reading || !current || current.model !== model || !sameIdentity(reading.marker, current))
        return undefined;
    try {
        const served = JSON.parse(reading.jsonPrefix) as MessageLike[];
        if (!Array.isArray(served)) return undefined;
        const upper = reading.inputTokens - lowerBoundMarkerMessages(served, model);
        return Number.isSafeInteger(upper) && upper > 0 ? upper : undefined;
    } catch {
        return undefined;
    }
}

/** Measure the final raw envelope before an optional host history cut. The caller
 * also requires the original count-only fit, so this check can only defer a cut. */
export function measureStandaloneMarker(args: {
    sessionId: string;
    model: string;
    systemHash: string;
    agentName?: string;
    messages: readonly MessageLike[];
    limit: number;
}) {
    const system = systems.get(args.sessionId);
    const slash = args.model.indexOf("/");
    const current =
        system?.request &&
        system.request === currentLkgRequestIdentity(args.sessionId) &&
        system.model === args.model &&
        system.hash === args.systemHash;
    const tools = getMarkerToolDefinitions(
        args.model.slice(0, slash),
        args.model.slice(slash + 1),
        args.agentName,
    );
    // The plugin cannot see MCP tools, and on OpenCode 1.18.35 the hook's
    // parameters are not the JSON schema sent. The envelope is therefore bounded
    // only by the most recent completed request with the same model, system strings
    // and hook-visible tool names: its provider input usage minus a lower bound on
    // the messages it carried. Exact visible material can only raise that bound.
    const derived = current
        ? standaloneEnvelopeUpper(args.sessionId, args.model, args.agentName)
        : undefined;
    const visible =
        system && current && tools
            ? boundMarkerEnvelope({ system: system.system, tools }, args.model)
            : undefined;
    const envelope = derived === undefined ? undefined : Math.max(derived, visible ?? 0);
    return measureLkgReplay({
        messages: args.messages,
        limit: args.limit,
        estimate: () => ({
            tokens:
                (envelope ?? Number.POSITIVE_INFINITY) +
                boundMarkerMessages(args.messages, args.model),
            trusted: envelope !== undefined && args.messages.every(hasCountableParts),
        }),
    });
}
