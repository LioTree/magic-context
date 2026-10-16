import type { RunnerRecord, Subject } from "./record";

/** Chosen representation of one request; delivery becomes clean only after its response ends.
 * The relay counts admitted messages, while native stores can contain different rows.
 * Only coverage.end_mid links the relay's replaced range to the native history order. */
export interface BridgeReceipt {
    request_id: string;
    delivery: "pending" | "clean";
    lineage_id: string;
    served_through_ordinal: number;
    unserved_subjects: Subject[];
    last_applied?: {
        compaction_id: string;
        version: number;
        /** Replaced message positions in the relay's conversation: from inclusive, to exclusive. */
        range: { from: number; to: number };
    };
    coverage?: { end_mid: string; ordinal: number };
    last_not_applied?: RunnerRecord<unknown>["last_not_applied"];
}

export interface BridgeRequestCompletion {
    status: number;
    cleanEnd: boolean;
    stop_reason?: string;
}

export function completeBridgeReceipt(
    receipt: BridgeReceipt,
    through: number,
    response: BridgeRequestCompletion,
): BridgeReceipt {
    return response.status === 200 && response.cleanEnd
        ? {
              ...receipt,
              delivery: "clean",
              served_through_ordinal: Math.max(receipt.served_through_ordinal, through),
          }
        : structuredClone(receipt);
}

/** Call only after publication commits; an in-flight record is not a delivery receipt. */
export function bridgeReceipt<M>(record: RunnerRecord<M>, request_id = ""): BridgeReceipt {
    const applied = record.view.state === "applied" && !record.pipeline_exit;
    return structuredClone({
        request_id,
        delivery: "pending" as const,
        lineage_id: record.lineage_id,
        served_through_ordinal: record.served_through_ordinal,
        unserved_subjects: record.unserved_subjects,
        ...(applied
            ? {
                  last_applied: {
                      compaction_id: record.view.compaction_id,
                      version: record.view.version,
                      range: record.view.range,
                  },
                  ...(record.view.coverage ? { coverage: record.view.coverage } : {}),
              }
            : {}),
        ...(record.last_not_applied ? { last_not_applied: record.last_not_applied } : {}),
    });
}
