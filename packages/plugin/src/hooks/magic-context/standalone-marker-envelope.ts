import { getMarkerToolDefinitions } from "../../features/magic-context/tool-definition-tokens";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { calibrationForModelKey, providerMass } from "./decision-calibration";
import { measureLkgReplay } from "./lkg-fit-measure";
import {
    currentLkgRequestIdentity,
    isCurrentOrPreviousLkgRequest,
    type LkgRequestIdentity,
} from "./lkg-measured-request";
import { boundMarkerEnvelope } from "./marker-envelope";
import type { MessageLike } from "./transform-operations";
import { estimateByteBoundedMessageTokens, hasCountableParts } from "./wire-content";

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

/** Measure the final raw envelope before an optional host history cut. The caller
 * also requires the original count-only fit, so this check can only defer a cut.
 *
 * The recorded system must belong to this request or the one directly before it,
 * and its hash must equal the session's persisted system hash. Requiring this
 * request alone admits no cut on either OpenCode host: OpenCode 1 runs the messages
 * transform before the system hook, so only the previous request's final system
 * exists here, and OpenCode 2 starts a new request identity between its system
 * stage and the transform. The hash check still defers when the recorded system
 * is not the persisted one. */
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
    const tools = getMarkerToolDefinitions(
        args.model.slice(0, slash),
        args.model.slice(slash + 1),
        args.agentName,
    );
    const envelope =
        system &&
        isCurrentOrPreviousLkgRequest(args.sessionId, system.request) &&
        system.model === args.model &&
        system.hash === args.systemHash &&
        tools
            ? boundMarkerEnvelope({ system: system.system, tools }, args.model)
            : undefined;
    return measureLkgReplay({
        messages: args.messages,
        limit: args.limit,
        estimate: () => ({
            tokens:
                (envelope ?? Number.POSITIVE_INFINITY) +
                providerMass(
                    args.messages.reduce(
                        (mass, message) => {
                            const count = estimateByteBoundedMessageTokens(message);
                            mass.prose += count.conversation;
                            mass.tools += count.toolCall;
                            return mass;
                        },
                        { prose: 0, tools: 0 },
                    ),
                    calibrationForModelKey(args.model),
                    true,
                ),
            trusted: envelope !== undefined && args.messages.every(hasCountableParts),
        }),
    });
}
