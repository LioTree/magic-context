import { randomUUID } from "node:crypto";
import type { Database } from "../../../shared/sqlite";
import type { MessageLike } from "../transform-operations";
import {
    type BridgeReceipt,
    type BridgeRequestCompletion,
    completeBridgeReceipt,
} from "./bridge-receipt";
import { sourceDigest } from "./record";

export interface BridgeNativeTarget {
    ordinal: number;
    end_mid: string;
}
export type BridgeNativeCut =
    | {
          kind: "opencode";
          boundary_mid: string;
          summary_mid: string;
          compaction_part_id: string;
          tail_start_id?: string;
      }
    | { kind: "pi"; compaction_id: string; first_kept_id: string };
export type BridgeMarkerOutcome =
    | { kind: "applied" }
    | { kind: "deferred"; reason: string }
    | { kind: "unknown"; reason: string };
export type BridgeMarkerWrite =
    | "applied"
    | "deferred"
    | "unknown"
    | { kind: "applied"; native: BridgeNativeCut };
interface Saved {
    receipt: BridgeReceipt;
    through: number;
    digest: string;
    cut?: { target: BridgeNativeTarget; state: "unknown" | "applied"; native?: BridgeNativeCut };
}

/** Separate from the cancellable transform. Uses existing host-runner JSON storage,
 * not a schema migration. SQLite's writer lease serializes Pi appenders across processes. */
export function createBridgeReceiptStore(db: Database, sessionId: string, harness: string) {
    const key = { session_id: sessionId, harness: `bridge-receipt:${harness}` };
    const read = (): Saved | undefined => {
        const row = db
            .prepare("SELECT setup_json FROM host_runner_state WHERE session_id=? AND harness=?")
            .get(sessionId, key.harness) as { setup_json: string | null } | undefined;
        return row?.setup_json ? JSON.parse(row.setup_json) : undefined;
    };
    const save = (value: Saved) => {
        db.prepare(`INSERT INTO host_runner_state
            (session_id,harness,lineage_id,ancestry_json,next_ordinal,cursor,served_through_ordinal,unserved_json,setup_json)
            VALUES(?,?,?,'[]',1,0,?,'[]',?) ON CONFLICT(session_id,harness) DO UPDATE SET
            lineage_id=excluded.lineage_id, served_through_ordinal=excluded.served_through_ordinal, setup_json=excluded.setup_json`).run(
            sessionId,
            key.harness,
            value.receipt.lineage_id,
            value.receipt.served_through_ordinal,
            JSON.stringify(value),
        );
    };
    return {
        cutState(): "unknown" | "applied" | undefined {
            return read()?.cut?.state;
        },
        appliedCut(): BridgeNativeCut | undefined {
            const cut = read()?.cut;
            return cut?.state === "applied" ? cut.native : undefined;
        },
        current(): BridgeReceipt | undefined {
            return read()?.receipt;
        },
        /** Highest relay ordinal of the last view returned to the host for this lineage.
         * Those bytes may have reached the provider even while delivery stays pending. */
        publishedThrough(lineageId: string): number {
            const saved = read();
            return saved?.receipt.lineage_id === lineageId ? saved.through : 0;
        },
        publish(
            receipt: BridgeReceipt,
            messages: readonly MessageLike[],
            through: number,
        ): BridgeReceipt {
            return db
                .transaction(() => {
                    const previous = read();
                    const pending: BridgeReceipt = {
                        ...receipt,
                        request_id: randomUUID(),
                        delivery: "pending",
                        served_through_ordinal:
                            previous?.receipt.lineage_id === receipt.lineage_id
                                ? previous.receipt.served_through_ordinal
                                : 0,
                    };
                    save({
                        receipt: pending,
                        through,
                        digest: sourceDigest(JSON.stringify(messages)),
                        cut: previous?.cut,
                    });
                    return pending;
                })
                .immediate();
        },
        /** Headers, failed streams and non-200 responses never acknowledge delivery.
         * A clean refusal stop is still a completed carrying request. */
        complete(requestId: string, response: BridgeRequestCompletion): BridgeReceipt | undefined {
            return db
                .transaction(() => {
                    const held = read();
                    if (!held || held.receipt.request_id !== requestId) return undefined;
                    if (response.status === 200 && response.cleanEnd) {
                        held.receipt = completeBridgeReceipt(held.receipt, held.through, response);
                        save(held);
                    }
                    return held.receipt;
                })
                .immediate();
        },
        advance(
            input: {
                receipt: BridgeReceipt;
                target: BridgeNativeTarget;
                /** Check the applied messages against the current model's prompt limit,
                 * including the complete system prompt and tool definitions. */
                proveFit: () => { admissible: boolean; view?: readonly MessageLike[] };
                /** Complete canonical raw window, in order, before the native cut. */
                raw: readonly MessageLike[];
            },
            apply: () => BridgeMarkerWrite,
        ): BridgeMarkerOutcome {
            let held: Saved | undefined;
            let priorUnknown = false;
            const defer = (reason: string): BridgeMarkerOutcome => ({
                kind: held?.cut?.state === "unknown" ? "unknown" : "deferred",
                reason,
            });
            try {
                // Re-read under the writer lease. No host append may run outside this
                // lease, even when a second bridge has cached the same pending target.
                const checked = db
                    .transaction((): BridgeMarkerOutcome => {
                        held = read();
                        priorUnknown = held?.cut?.state === "unknown";
                        const receipt = held?.receipt;
                        const applied = receipt?.last_applied;
                        const coverage = receipt?.coverage;
                        if (
                            !receipt ||
                            JSON.stringify(receipt) !== JSON.stringify(input.receipt) ||
                            !applied ||
                            !coverage ||
                            receipt.last_not_applied
                        )
                            return defer("no-current-applied-receipt");
                        if (
                            !Number.isSafeInteger(coverage.ordinal) ||
                            coverage.ordinal < input.target.ordinal ||
                            (coverage.ordinal === input.target.ordinal &&
                                coverage.end_mid !== input.target.end_mid) ||
                            applied.range.from >= applied.range.to
                        )
                            return defer("coverage-does-not-cover-target");
                        const fit = input.proveFit();
                        if (
                            !fit.admissible ||
                            !fit.view ||
                            sourceDigest(JSON.stringify(fit.view)) !== held?.digest
                        )
                            return defer("fit-unproven");
                        if (
                            !safeBridgeCut(
                                input.raw,
                                fit.view,
                                coverage.end_mid,
                                input.target.end_mid,
                            )
                        )
                            return defer("uncovered-parts-or-tool-pair");
                        // Commit uncertainty BEFORE entering the irreversible host writer.
                        // This transaction contains no host write; the second lease below
                        // rechecks ownership before invoking the native integration.
                        if (held) {
                            held.cut = { target: input.target, state: "unknown" };
                            save(held);
                        }
                        return { kind: "unknown", reason: "ready" };
                    })
                    .immediate();
                return checked.kind === "unknown" && checked.reason === "ready" ? write() : checked;
            } catch {
                return defer("marker-evidence-or-writer-unavailable");
            }
            function write(): BridgeMarkerOutcome {
                return db
                    .transaction((): BridgeMarkerOutcome => {
                        const latest = read();
                        if (!held || !latest || JSON.stringify(latest) !== JSON.stringify(held))
                            return defer("receipt-superseded");
                        const outcome = apply();
                        if (
                            outcome === "applied" ||
                            (typeof outcome === "object" && outcome.kind === "applied")
                        ) {
                            latest.cut = {
                                target: input.target,
                                state: "applied",
                                ...(typeof outcome === "object" ? { native: outcome.native } : {}),
                            };
                            save(latest);
                            return { kind: "applied" };
                        }
                        if (outcome === "deferred") {
                            if (priorUnknown)
                                return { kind: "unknown", reason: "earlier-cut-still-unknown" };
                            latest.cut = undefined;
                            save(latest);
                            return { kind: "deferred", reason: "native-writer-deferred" };
                        }
                        return { kind: "unknown", reason: "native-write-outcome-unknown" };
                    })
                    .immediate();
            }
        },
    };
}

/** Locate the cut by raw message ID, not a position in the relay's different message order.
 * Retain every later message part and keep tool calls/results together in the delivered request. */
export function safeBridgeCut(
    raw: readonly MessageLike[],
    delivered: readonly MessageLike[],
    coverageMid: string,
    targetMid: string,
): boolean {
    const rawIds = raw.map((m) => m.info.id);
    const deliveredIds = delivered.map((m) => m.info.id).filter(Boolean);
    if (
        rawIds.some((id) => !id) ||
        new Set(rawIds).size !== rawIds.length ||
        new Set(deliveredIds).size !== deliveredIds.length
    )
        return false;
    const end = raw.findIndex((m) => m.info.id === coverageMid);
    const target = raw.findIndex((m) => m.info.id === targetMid);
    if (end < 0 || target < 0 || target > end) return false;
    const retained = new Map(delivered.map((m) => [m.info.id, m]));
    if (
        raw.slice(end + 1).some((m) => {
            const kept = retained.get(m.info.id);
            if (!m.info.id || !kept) return true;
            return m.parts.some((part) => {
                const id = (part as Record<string, unknown>).id;
                return !id || !kept.parts.some((p) => (p as Record<string, unknown>).id === id);
            });
        })
    )
        return false;
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const message of delivered)
        for (const part of message.parts) {
            const p = part as Record<string, unknown>;
            const id = p.callID ?? p.toolCallId ?? p.id;
            if (p.type === "tool") {
                const state = p.state as { status?: string } | undefined;
                if (
                    typeof id !== "string" ||
                    (state?.status !== "completed" && state?.status !== "error")
                )
                    return false;
                if (calls.has(id) || results.has(id)) return false;
                calls.add(id);
                results.add(id);
            } else if (p.type === "toolCall" || p.type === "tool-call") {
                if (typeof id !== "string" || calls.has(id)) return false;
                calls.add(id);
            } else if (p.type === "toolResult" || p.type === "tool-result") {
                if (typeof id !== "string" || results.has(id) || !calls.has(id)) return false;
                results.add(id);
            }
        }
    return calls.size === results.size && [...calls].every((id) => results.has(id));
}
