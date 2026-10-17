import { isRecord } from "../../shared/record-type-guard";
import type { EditAdmission, EditCoord } from "./edit-admission";
import { admitCompound } from "./edit-admission";
import type { MessageLike, TagTarget } from "./tag-messages";
import { extractToolCallObservation, partHasCompletedResult } from "./tool-drop-target";

export interface ToolOccurrence {
    call?: string;
    result?: string;
}

export type ToolBatchCoordinates = ReadonlyMap<string, ReadonlyMap<string, readonly EditCoord[]>>;

export function openCodeToolBatchCoordinates(messages: readonly MessageLike[]) {
    return toolBatchCoordinates({
        messages,
        stableId: (message) => message.info.id,
        partsOf: (message) => message.parts,
        occurrence: (_message, part) => {
            const observed = extractToolCallObservation(part);
            if (!observed) return {};
            if ((part as { type?: string }).type === "tool")
                return {
                    call: observed.callId,
                    ...(partHasCompletedResult(part) ? { result: observed.callId } : {}),
                };
            return observed.kind === "invocation"
                ? { call: observed.callId }
                : { result: observed.callId };
        },
    });
}

/** Coordinates come from the same raw array and stable ids as the thinking frame, not a transcript. */
export function toolBatchCoordinates<M>(args: {
    messages: readonly M[];
    stableId: (message: M, index: number) => string | undefined;
    partsOf: (message: M) => readonly unknown[];
    occurrence: (message: M, part: unknown) => ToolOccurrence;
}): ToolBatchCoordinates {
    type Batch = { coords: EditCoord[]; pending: Set<string> };
    const batches: Batch[] = [];
    const pending = new Map<string, Batch[]>();
    const byPart = new Map<string, Map<string, Batch>>();
    const attach = (id: string | undefined, batch: Batch, block: number, callId: string) => {
        batch.coords.push({ kind: "message", id, block });
        if (id) {
            const owners = byPart.get(id) ?? new Map<string, Batch>();
            owners.set(callId, batch);
            byPart.set(id, owners);
        }
    };
    args.messages.forEach((message, index) => {
        const id = args.stableId(message, index);
        const parts = args.partsOf(message).map((part) => args.occurrence(message, part));
        const isNewCall = (part: ToolOccurrence) =>
            part.call && !(part.call === part.result && pending.get(part.call)?.length);
        const calls = parts.flatMap((part) => (part.call && isNewCall(part) ? [part.call] : []));
        const callSet = new Set(calls);
        if (calls.length) {
            const batch: Batch = { coords: [], pending: new Set(calls) };
            batches.push(batch);
            parts.forEach((part, block) => {
                if (!part.call || !callSet.has(part.call)) return;
                attach(id, batch, block, part.call);
                const queue = pending.get(part.call) ?? [];
                queue.push(batch);
                pending.set(part.call, queue);
            });
        }
        parts.forEach((part, block) => {
            if (!part.result) return;
            const batch = pending.get(part.result)?.shift();
            if (!batch) {
                const orphan: Batch = {
                    coords: [{ kind: "message", id: undefined, block: "whole" }],
                    pending: new Set(),
                };
                attach(id, orphan, block, part.result);
                return;
            }
            batch.pending.delete(part.result);
            attach(id, batch, block, part.result);
        });
    });
    for (const batch of batches) {
        // An unanswered call cannot authorize shortening any sibling in its parallel batch.
        if (batch.pending.size)
            batch.coords.push({ kind: "message", id: undefined, block: "whole" });
    }
    return new Map(
        [...byPart].map(([id, owners]) => [
            id,
            new Map([...owners].map(([block, batch]) => [block, batch.coords])),
        ]),
    );
}

/** Keep the existing tag guards, adding the earliest call and every result of a parallel batch. */
export function protectToolBatchMutations(
    targets: Map<number, TagTarget>,
    admission: EditAdmission,
    batches: ToolBatchCoordinates,
): Map<number, TagTarget> {
    if (admission.admit({ kind: "prefix" })) return targets;
    return new Map(
        [...targets].map(([tag, target]) => {
            if (!target.canDrop) return [tag, target];
            const sources = (target.mutationParts ?? []).flatMap(({ message, part }) => {
                const observed = extractToolCallObservation(part);
                // Pi targets expose TranscriptPart proxies, not the raw AgentMessage parts.
                const callId =
                    observed?.callId ??
                    (isRecord(part) &&
                    (part.kind === "tool_use" || part.kind === "tool_result") &&
                    typeof part.id === "string"
                        ? part.id
                        : undefined);
                return callId ? (batches.get(message.info.id ?? "")?.get(callId) ?? []) : [];
            });
            if (admitCompound(admission, sources)) return [tag, target];
            return [
                tag,
                {
                    ...target,
                    thinkingDropProtected: true,
                    thinkingRewriteProtected: true,
                    canDrop: () => false,
                    prepareDrop: () => false,
                    drop: () => "incomplete",
                    truncate: () => "incomplete",
                    skeletonReal: () => "incomplete",
                    skeletonStripped: () => "incomplete",
                    editMarker: () => "incomplete",
                    editMarkerStripped: () => "incomplete",
                    setContent: () => false,
                } satisfies TagTarget,
            ];
        }),
    );
}
