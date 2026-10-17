import type { BridgeReceipt } from "@magic-context/core/hooks/magic-context/host-runner/bridge-receipt";
import type {
	BridgeOutcomeListener,
	BridgeStepKind,
	BridgeTransport,
} from "@magic-context/core/hooks/magic-context/host-runner/bridge-types";
import type { FallbackInputs } from "@magic-context/core/hooks/magic-context/host-runner/fallback-admissibility";
import type { PiBridgeEntry } from "./bridge-codec-pi";
import type { PiBridgeMarkerDeps } from "./bridge-marker-pi";

export interface PiBridgeAdapterOptions {
	projectRoot: string;
	connectionFile: string;
	storageDir: string;
	configPath: string;
	transport?: BridgeTransport;
	allowMigration?: boolean;
	/** Reload without changing the active journal entry selected by /tree; return its reader and appender together. */
	reloadSession(
		sessionId: string,
	): ReturnType<PiBridgeMarkerDeps["reloadSession"]>;
}
export interface PiBridgeHostSnapshot {
	model: { provider: string; id: string; api?: string; transport?: string };
	/** Host-resolved input limit after reserving space for the model's output. */
	contextWindow: number;
	system: string;
	/** Complete active tool definitions, not only names. */
	tools: readonly unknown[];
}
export interface PiBridgeRunInput {
	sessionId: string;
	/** Context-event messages bound to their real journal entry IDs, in branch order. */
	messages: PiBridgeEntry[];
	host: PiBridgeHostSnapshot;
	kind: "model";
}
export interface PiBridgeView {
	messages: PiBridgeEntry[];
	kind: BridgeStepKind;
	receipt: BridgeReceipt;
}
export type PiBridgeFallbackInputs = Omit<FallbackInputs, "messages"> & {
	messages: readonly PiBridgeEntry[];
};
export type { BridgeOutcomeListener };
