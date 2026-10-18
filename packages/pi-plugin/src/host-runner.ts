/** Import-safe bridge exports; the standalone Pi extension is not imported here. */

export { StoreVersionMismatchError } from "@magic-context/core/features/magic-context/store-version-mismatch";
export type { BridgeMarkerOutcome } from "@magic-context/core/hooks/magic-context/host-runner/bridge-marker";
export type {
	BridgeReceipt,
	BridgeRequestCompletion,
} from "@magic-context/core/hooks/magic-context/host-runner/bridge-receipt";
export type {
	BridgeHostFact,
	BridgeHostFactResult,
	BridgeOutcomeListener,
	BridgeTransport,
} from "@magic-context/core/hooks/magic-context/host-runner/bridge-types";
export type { PiBridgeEntry } from "./bridge-codec-pi";
export type {
	PiBridgeAdapterOptions,
	PiBridgeFallbackInputs,
	PiBridgeHostSnapshot,
	PiBridgeRunInput,
	PiBridgeSystemPromptInput,
	PiBridgeView,
} from "./bridge-types-pi";
export type PiBridgeAdapter = Awaited<ReturnType<typeof createPiBridgeAdapter>>;

/** Storage and relay handles are opened only by an explicit construction call. */
export async function createPiBridgeAdapter(
	options: import("./bridge-types-pi").PiBridgeAdapterOptions,
) {
	return (await import("./bridge-adapter-pi")).createPiBridgeAdapter(options);
}
