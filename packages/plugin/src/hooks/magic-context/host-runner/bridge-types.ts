import type { PluginContext } from "../../../plugin/types";
import type { V2Context } from "../../../v2/hooks/types";
import { EmergencyFailClosedError } from "../emergency-fail-closed";
import type { MessageLike } from "../transform-operations";
import type { BridgeReceipt } from "./bridge-receipt";
import type { FallbackInputs } from "./fallback-admissibility";
import type { OpenCodeProviderOptions } from "./opencode-adapter";

/** Opaque Magic Context payload relay: one whole subc frame payload per call, with an absolute Unix-ms deadline.
 * The bridge owns JSON encoding and reply-page assembly; failures reject with BridgeTransportError. */
export interface BridgeTransport {
    request(
        method: string,
        body: Uint8Array,
        opts: { deadlineMs: number; signal?: AbortSignal },
    ): Promise<Uint8Array>;
}

export type BridgeTransportError =
    | { source: "module"; code: string; message: string }
    | {
          source: "relay";
          code: "relay_unavailable" | "session_scope_missing" | "deadline" | "aborted";
      };

export interface BridgeAdapterOptions {
    openCodeClient: PluginContext["client"] | V2Context;
    projectRoot: string;
    connectionFile: string;
    storageDir: string;
    configPath: string;
    /** Caller-owned relay; when supplied, the bridge never opens its own subc connection. */
    transport?: BridgeTransport;
    /** OpenCode/Pi share context.db; upgrades can make older binaries unable to open it, so opt-in is required. */
    allowMigration?: boolean;
}

export interface BridgeRunInput {
    sessionId: string;
    messages: MessageLike[];
    /** Model step only; the native adapter decides when history must be rebuilt from persisted source/model state. */
    kind: "model";
}

export type BridgeStepKind = "ordinary" | "bootstrap" | "rebuild";

export interface BridgeView {
    messages: MessageLike[];
    kind: BridgeStepKind;
    receipt: BridgeReceipt;
}

export class StepBudgetExceededError extends Error {
    readonly code = "step_budget_exceeded";
    constructor(
        readonly budget_ms: number,
        readonly kind: BridgeStepKind,
    ) {
        super(`Bridge ${kind} step exceeded its ${budget_ms} ms budget`);
        this.name = "StepBudgetExceededError";
    }
}

export type BridgeFallbackInputs = Omit<FallbackInputs, "messages"> & {
    /** Complete host-sent window; the facade normalizes OpenCode's C/S-before-tail order. */
    messages: readonly MessageLike[];
};

export type BridgeRefusalReason =
    | NonNullable<Parameters<NonNullable<OpenCodeProviderOptions["fullRequest"]>>[5]>
    | "raw_history_provider_missing"
    | "covered_range_changed";

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
