/** Import-safe host-runner surface. Storage-backed adapter initialization is explicit and lazy. */

export { StoreVersionMismatchError } from "./features/magic-context/store-version-mismatch";
export {
    type BridgeAdapterOptions,
    type BridgeFallbackInputs,
    type BridgeOutcomeListener,
    BridgeRefusalError,
    type BridgeRefusalReason,
    type BridgeRunInput,
    type BridgeStepKind,
    type BridgeTransport,
    type BridgeTransportError,
    type BridgeView,
    StepBudgetExceededError,
} from "./hooks/magic-context/host-runner/bridge-types";
export {
    type FallbackAdmissibility,
    type FallbackInputs,
    isFallbackAdmissible,
    type ProviderUsageInput,
    recordProviderUsage,
} from "./hooks/magic-context/host-runner/fallback-admissibility";
export type { OpenCodeProviderOptions } from "./hooks/magic-context/host-runner/opencode-adapter";
export * as record from "./hooks/magic-context/host-runner/record";
export * from "./hooks/magic-context/host-runner/record";
export type { MessageLike } from "./hooks/magic-context/transform-operations";

export type BridgeAdapter = Awaited<ReturnType<typeof createBridgeAdapter>>;

/** Construct the provider bridge explicitly; no storage or transport opens during import. */
export async function createBridgeAdapter(
    options: import("./hooks/magic-context/host-runner/bridge-types").BridgeAdapterOptions,
) {
    const runtime = await import("./hooks/magic-context/host-runner/bridge-adapter");
    return runtime.createBridgeAdapter(options);
}

/** Loading the adapter opts into its storage/runtime dependencies; importing this entry does not. */
export async function loadOpenCodeProviderAdapter() {
    return import("./hooks/magic-context/host-runner/opencode-adapter");
}
