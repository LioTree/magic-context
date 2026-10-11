import { providerMass, resolveDecisionCalibration } from "../decision-calibration";
import { measureLkgReplay } from "../lkg-fit-measure";
import type { MessageLike } from "../transform-operations";
import { estimateByteBoundedMessageTokens, hasCountableParts } from "../wire-content";
import { type RunnerRecord, sourceDigest } from "./record";

export interface FallbackInputs {
    /** Full host window in append order, normalized with providerIncoming(message).read(). */
    messages: readonly MessageLike[];
    /** Append-order position of the first message with an id, excluding compaction markers. */
    firstOrdinal?: number;
    model: string;
    /** Fingerprint of the complete system/tool envelope used for this request. */
    envelope: string;
    /** Usable prompt limit, after any output reserve; unknown limits always refuse. */
    contextWindow?: number;
    /** Envelope token bounds, required when no provider count matches this exact request prefix. */
    systemPromptTokens?: number;
    toolDefinitionTokens?: number;
}

export type FallbackAdmissibility =
    | { admissible: true; view: MessageLike[] }
    | { admissible: false; reason: "covered_range_changed" | "fit_unproven"; detail: string };

/** Record only provider input usage attributed to this exact served request, including cache tokens. */
export function recordProviderUsage<P>(
    record: RunnerRecord<MessageLike, P>,
    input: {
        messages: readonly MessageLike[];
        inputTokens: number;
        model: string;
        envelope: string;
    },
): void {
    if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens <= 0) {
        throw new Error("Provider input usage must be a positive integer");
    }
    record.measured_usage = {
        input_tokens: input.inputTokens,
        model: input.model,
        envelope: input.envelope,
        lineage_id: record.lineage_id,
        view_version: record.view.version,
        message_digests: input.messages.map((message) => sourceDigest(JSON.stringify(message))),
    };
}

/**
 * No provider, storage, session cache or tokenizer is consulted. Text uses the
 * fit estimator's UTF-8 upper-bound mode, with the same model token ratios
 * and independent wire-byte risk budget as Magic Context's saved-request fit guard. This can
 * decline a request a tokenizer would admit, but never borrows unrelated usage.
 */
export function isFallbackAdmissible<P>(
    record: RunnerRecord<MessageLike, P>,
    input: FallbackInputs,
): FallbackAdmissibility {
    const changed = (detail: string): FallbackAdmissibility => ({
        admissible: false,
        reason: "covered_range_changed",
        detail,
    });
    const unproven = (detail: string): FallbackAdmissibility => ({
        admissible: false,
        reason: "fit_unproven",
        detail,
    });
    if (
        record.pipeline_exit ||
        record.view.state !== "applied" ||
        record.history_gap_from !== undefined
    ) {
        return changed("The recorded view is exited, invalidated or has a history gap");
    }
    const { from, to } = record.view.range;
    const compacted = from < to;
    const seen = new Set<string>();
    const seenOrdinals = new Set<number>();
    const entries = new Map(record.entries.map((entry) => [entry.id, entry]));
    const tail: MessageLike[] = [];
    let ordinal = input.firstOrdinal ?? record.first_ordinal;
    if (!Number.isSafeInteger(ordinal) || ordinal < 1)
        return changed("Invalid host window ordinal");
    try {
        for (const message of input.messages) {
            const id = message.info.id;
            // Synthetic heads without ids and host compaction markers do not
            // count toward append-order positions in the provider conversation.
            const info = message.info as Record<string, unknown>;
            const marker =
                (info.summary === true && info.finish === "stop") ||
                message.parts.some(
                    (part) => (part as Record<string, unknown>).type === "compaction",
                );
            if (record.elided.has(id ?? "") || marker) continue;
            if (!id) {
                const head =
                    message.parts.length > 0 &&
                    message.parts.every(
                        (part) => (part as Record<string, unknown>).synthetic === true,
                    );
                if (compacted && !head && ordinal < to)
                    return changed("Unidentified insertion in covered range");
                if (!compacted || !head) tail.push(message);
                continue;
            }
            const held = record.ids.get(id);
            if (compacted && ordinal >= from && ordinal < to) {
                if (
                    seen.has(id) ||
                    held !== ordinal ||
                    record.source_digests.get(id) !== sourceDigest(JSON.stringify(message))
                ) {
                    return changed(`Covered source mismatch at ordinal ${ordinal} (${id})`);
                }
                seen.add(id);
                seenOrdinals.add(ordinal);
            } else if (compacted && held !== undefined && held >= from && held < to) {
                return changed(`Covered message ${id} moved outside its recorded ordinal`);
            }
            if (!compacted || ordinal >= to) {
                const entry = entries.get(id);
                tail.push(
                    compacted &&
                        entry &&
                        sourceDigest(entry.ingest) === sourceDigest(JSON.stringify(message))
                        ? entry.served
                        : message,
                );
            }
            ordinal++;
        }
        if (compacted) {
            for (const [id, held] of record.ids) {
                if (held >= from && held < to && !seen.has(id)) {
                    return changed(`Covered message ${id} at ordinal ${held} was removed`);
                }
            }
            // Old stores without source hashes cannot prove that all messages
            // replaced by compaction still exist at their original positions.
            for (let covered = Math.max(from, record.first_ordinal); covered < to; covered++) {
                if (!seenOrdinals.has(covered)) {
                    return changed(`No source evidence for covered ordinal ${covered}`);
                }
            }
        }
        const view = compacted ? [...record.view.replacement, ...tail] : tail;
        const limit = input.contextWindow;
        if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
            return unproven("The model's usable context window is unknown");
        }
        const usage = record.measured_usage;
        const digests = view.map((message) => sourceDigest(JSON.stringify(message)));
        const measured =
            usage &&
            usage.model === input.model &&
            usage.envelope === input.envelope &&
            usage.lineage_id === record.lineage_id &&
            usage.view_version === record.view.version &&
            Number.isSafeInteger(usage.input_tokens) &&
            usage.input_tokens > 0 &&
            usage.message_digests.length <= digests.length &&
            usage.message_digests.every((digest, index) => digest === digests[index]);
        const messages = measured ? view.slice(usage.message_digests.length) : view;
        const slash = input.model.indexOf("/");
        const calibration = resolveDecisionCalibration(
            slash > 0 ? input.model.slice(0, slash) : undefined,
            slash > 0 ? input.model.slice(slash + 1) : input.model,
        );
        const measure = measureLkgReplay({
            messages,
            limit,
            measuredInputTokens: measured ? usage.input_tokens : undefined,
            estimate: () => {
                const complete = messages.every(hasCountableParts);
                const mass = messages.reduce(
                    (total, message) => {
                        const count = estimateByteBoundedMessageTokens(message);
                        total.prose += count.conversation;
                        total.tools += count.toolCall;
                        return total;
                    },
                    { prose: 0, tools: 0, system: 0 },
                );
                if (!measured) {
                    if (
                        input.systemPromptTokens === undefined ||
                        input.systemPromptTokens <= 0 ||
                        input.toolDefinitionTokens === undefined ||
                        input.toolDefinitionTokens < 0
                    ) {
                        return { tokens: 0, trusted: false };
                    }
                    mass.system = input.systemPromptTokens;
                    mass.tools += input.toolDefinitionTokens;
                }
                const tokens = providerMass(mass, calibration, true);
                return { tokens, trusted: complete && Number.isFinite(tokens) };
            },
        });
        return measure.fit === "under"
            ? { admissible: true, view }
            : unproven(
                  `Fallback fit ${measure.fit}: tokens=${measure.tokens ?? "unknown"}, limit=${limit}`,
              );
    } catch {
        return unproven("Fallback source or wire content could not be measured");
    }
}
