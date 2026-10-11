import type { PluginContext } from "../../../plugin/types";
import type { V2Context } from "../../../v2/hooks/types";
import { EmergencyFailClosedError } from "../emergency-fail-closed";
import type { MessageLike } from "../transform-operations";
import type { FallbackInputs } from "./fallback-admissibility";
import type { OpenCodeProviderOptions } from "./opencode-adapter";

export interface BridgeAdapterOptions {
    openCodeClient: PluginContext["client"] | V2Context;
    projectRoot: string;
    connectionFile: string;
    storageDir: string;
    configPath: string;
    /** OpenCode/Pi share context.db; upgrades can make older binaries unable to open it, so opt-in is required. */
    allowMigration?: boolean;
}

export interface BridgeRunInput {
    sessionId: string;
    messages: MessageLike[];
    /** Model step only; the native adapter decides when history must be rebuilt from persisted source/model state. */
    kind: "model";
}

export type BridgeView = MessageLike[];

export type BridgeFallbackInputs = Omit<FallbackInputs, "messages"> & {
    /** Complete raw host window in append order; the facade applies provider normalization. */
    messages: readonly MessageLike[];
};

export type BridgeRefusalReason =
    | NonNullable<Parameters<NonNullable<OpenCodeProviderOptions["fullRequest"]>>[5]>
    | "raw_history_provider_missing";

/** Refuse the native adapter's full-request execution path; callers must prove fallback admission before sending history. */
export class BridgeRefusalError extends EmergencyFailClosedError {
    constructor(readonly reason: BridgeRefusalReason) {
        super(
            reason === "raw_history_provider_missing"
                ? "OpenCode 2 bridge requires a registered per-session raw-history provider before run"
                : `Bridge provider handoff refused: ${reason}; check isFallbackAdmissible or refuse the step`,
            { code: `bridge_${reason}` },
        );
        this.name = "BridgeRefusalError";
    }
}

export type BridgeOutcomeListener = NonNullable<OpenCodeProviderOptions["onOutcome"]>;
