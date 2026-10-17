import type { MessageLike } from "../transform-operations";
import type { providerIncoming, providerOpFunctions, providerSubjects } from "./opencode-adapter";
import type { ProviderClientOptions } from "./provider-client";

/** Convert host messages at the edges; keep operation replay, deadline checks and database commits in one implementation. */
export interface ProviderCodec {
    harness: "pi";
    serializerProfile: string;
    incoming: typeof providerIncoming;
    subjects: typeof providerSubjects;
    ops: typeof providerOpFunctions;
    wire: NonNullable<ProviderClientOptions["wire"]>;
    manifest(sessionId: string): string;
    freezeUnavailableHooks: boolean;
    ordinals(sessionId: string, messages: readonly MessageLike[]): number[];
}
