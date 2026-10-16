import {
	clearPendingPiCompactionMarkerStateIf,
	getPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	type BridgeMarkerOutcome,
	createBridgeReceiptStore,
} from "@magic-context/core/hooks/magic-context/host-runner/bridge-marker";
import type { BridgeReceipt } from "@magic-context/core/hooks/magic-context/host-runner/bridge-receipt";
import {
	type FallbackInputs,
	isFallbackAdmissible,
} from "@magic-context/core/hooks/magic-context/host-runner/fallback-admissibility";
import type { RunnerRecord } from "@magic-context/core/hooks/magic-context/host-runner/record";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/transform-operations";
import {
	type ApplyDeferredPiCompactionMarkerDeps,
	applyDeferredPiCompactionMarker,
} from "./compaction-marker-manager-pi";

export interface PiBridgeMarkerDeps {
	db: ApplyDeferredPiCompactionMarkerDeps["db"];
	/** Reload the host journal and return its reader/appender as one snapshot.
	 * Called under the writer lease; never return a previously cached branch. */
	reloadSession: () => Omit<ApplyDeferredPiCompactionMarkerDeps, "db">;
}

/** All mode-3 native appends for a session go through this owner. The shared MC
 * database writer lease, not a process-local mutex, excludes a second appender.
 * Standalone Pi continues to own its existing context-handler append path. */
export function createPiBridgeMarkerOwner(
	deps: PiBridgeMarkerDeps,
	sessionId: string,
) {
	const store = createBridgeReceiptStore(deps.db, sessionId, "pi");
	return {
		publish: store.publish,
		complete: store.complete,
		current: store.current,
		advance<P>(
			receipt: BridgeReceipt,
			record: RunnerRecord<MessageLike, P>,
			inputs: FallbackInputs,
		): BridgeMarkerOutcome {
			try {
				const pending = getPendingPiCompactionMarkerState(deps.db, sessionId);
				if (!pending) return { kind: "deferred", reason: "no-pending-target" };
				return store.advance(
					{
						receipt,
						target: { ordinal: pending.ordinal, end_mid: pending.endMessageId },
						raw: inputs.messages,
						proveFit: () => {
							if (
								record.lineage_id !== receipt.lineage_id ||
								record.view.compaction_id !==
									receipt.last_applied?.compaction_id ||
								record.view.version !== receipt.last_applied?.version
							)
								return { admissible: false };
							return isFallbackAdmissible(record, inputs);
						},
					},
					() => {
						if (
							JSON.stringify(
								getPendingPiCompactionMarkerState(deps.db, sessionId),
							) !== JSON.stringify(pending)
						)
							return "deferred";
						const outcome = applyDeferredPiCompactionMarker(
							{ db: deps.db, ...deps.reloadSession() },
							sessionId,
							pending,
						);
						if (
							outcome.kind === "applied" ||
							outcome.kind === "already-current"
						) {
							clearPendingPiCompactionMarkerStateIf(
								deps.db,
								sessionId,
								pending,
							);
							return "applied";
						}
						return outcome.kind === "retryable-failure"
							? "unknown"
							: "deferred";
					},
				);
			} catch {
				return {
					kind: "deferred",
					reason: "native-marker-evidence-unavailable",
				};
			}
		},
	};
}
