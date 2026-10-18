import {
    boundMarkerEnvelope,
    deriveMarkerEnvelopeReading,
    type MarkerSentText,
    markerEnvelopeKey,
} from "../marker-envelope";
import type { MessageLike } from "../transform-operations";
import type { BridgeHostFact } from "./bridge-types";
import type { ProviderUsageInput } from "./fallback-admissibility";

/** The messages a bridge adapter last handed its host to send, and that request's id. */
export interface BridgePublishedRequest {
    requestId: string;
    messages: readonly MessageLike[];
}

/**
 * Provider usage from a host's `provider_response` fact, attributed to the request
 * the bridge adapter last published. Undefined (record nothing) when the fact has
 * no material or no usage, names a different request, reports a total input of 0,
 * or carries material whose size cannot be bounded. Only a successful response's
 * usage also derives the envelope reading that bounds unobserved tool schemas: an
 * aborted or failed request may report partial input usage. `sentText` is the
 * host's rule for which served message text certainly reaches the provider; it
 * defaults to `openCodeSentText`, OpenCode 1's rule.
 */
export function providerUsageFromHostFact(
    fact: BridgeHostFact,
    sent: BridgePublishedRequest | undefined,
    sentText?: MarkerSentText,
): ProviderUsageInput | undefined {
    if (fact.kind !== "provider_response" || !fact.material || !fact.usage) return undefined;
    const model = `${fact.model.providerID}/${fact.model.modelID}`;
    const inputTokens = fact.usage.input + fact.usage.cacheRead + fact.usage.cacheWrite;
    if (
        sent?.requestId !== fact.requestId ||
        !(inputTokens > 0) ||
        boundMarkerEnvelope(fact.material, model) === undefined
    )
        return undefined;
    return {
        messages: sent.messages,
        model,
        envelope: markerEnvelopeKey(fact.material),
        inputTokens,
        envelopeReading:
            fact.outcome === "success"
                ? deriveMarkerEnvelopeReading({
                      material: fact.material,
                      messages: sent.messages,
                      totalInput: inputTokens,
                      model,
                      sentText,
                  })
                : undefined,
    };
}
