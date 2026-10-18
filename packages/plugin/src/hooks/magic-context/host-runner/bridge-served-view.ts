import type { MessageLike } from "../transform-operations";
import type { BridgeReceipt } from "./bridge-receipt";
import { BridgeRefusalError, type BridgeStepKind } from "./bridge-types";
import { providerIncoming, providerRevertsToRaw } from "./opencode-adapter";

/** Admitted host messages from the last returned session view, excluding heads
 * and still-running passthrough rows. The host may already have sent these bytes. */
export interface ServedView {
    lineageId: string;
    viewVersion?: number;
    messages: Map<string, { bytes: string; message: MessageLike }>;
}

export function servedView(
    receipt: BridgeReceipt,
    messages: readonly MessageLike[],
    ordinals: ReadonlyMap<string, number> | undefined,
    through: number,
): ServedView {
    const frozen: ServedView["messages"] = new Map();
    for (const message of messages) {
        const id = message.info?.id;
        const ordinal = id ? ordinals?.get(id) : undefined;
        if (!id || ordinal === undefined || ordinal > through) continue;
        frozen.set(id, { bytes: JSON.stringify(message), message: structuredClone(message) });
    }
    return {
        lineageId: receipt.lineage_id,
        viewVersion: receipt.last_applied?.version,
        messages: frozen,
    };
}

/**
 * A lineage change does not undo bytes already returned for this session. Retained
 * messages must repeat those bytes unless a rebuild is declared or a new view is
 * applied. Even a rebuild may not restore raw host text after hook edits. Host
 * reverts and compaction cuts remove messages from comparison, not from history.
 */
export function checkServedBytes(
    previous: ServedView | undefined,
    receipt: BridgeReceipt,
    kind: BridgeStepKind,
    next: readonly MessageLike[],
    host: readonly MessageLike[],
): void {
    if (!previous) return;
    const rebuilt = kind === "rebuild" || receipt.last_applied?.version !== previous.viewVersion;
    const rawById = new Map(host.map((message) => [message.info?.id, message]));
    for (const message of next) {
        const id = message.info?.id;
        const raw = id ? rawById.get(id) : undefined;
        const before = id ? previous.messages.get(id) : undefined;
        if (!raw || !before || before.bytes === JSON.stringify(message)) continue;
        if (!rebuilt || providerRevertsToRaw(before.message, message, providerIncoming(raw).read()))
            throw new BridgeRefusalError("served_bytes_changed");
    }
}
