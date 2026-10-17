import type { EditAdmission, EditCoord } from "./edit-admission";
import { admitCompound } from "./edit-admission";
import type { MessageLike, TagTarget } from "./tag-messages";
import { extractToolCallObservation, partHasCompletedResult } from "./tool-drop-target";

export interface ToolOccurrence {
    call?: string;
    result?: string;
}

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
}): ReadonlyMap<string, readonly EditCoord[]> {
    type Batch = { coords: EditCoord[]; pending: Set<string> };
    const batches: Batch[] = [];
    const pending = new Map<string, Batch[]>();
    const byMessage = new Map<string, Set<Batch>>();
    const attach = (id: string | undefined, batch: Batch, block: number) => {
        batch.coords.push({ kind: "message", id, block });
        if (id) {
            const owners = byMessage.get(id) ?? new Set<Batch>();
            owners.add(batch);
            byMessage.set(id, owners);
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
                attach(id, batch, block);
                const queue = pending.get(part.call) ?? [];
                queue.push(batch);
                pending.set(part.call, queue);
            });
        }
        parts.forEach((part, block) => {
            if (!part.result) return;
            const batch = pending.get(part.result)?.shift();
            if (!batch) return;
            batch.pending.delete(part.result);
            attach(id, batch, block);
        });
    });
    for (const batch of batches) {
        // An unanswered call cannot authorize shortening any sibling in its parallel batch.
        if (batch.pending.size)
            batch.coords.push({ kind: "message", id: undefined, block: "whole" });
    }
    return new Map(
        [...byMessage].map(([id, owners]) => [id, [...owners].flatMap((batch) => batch.coords)]),
    );
}

/** Keep the existing tag guards, adding the earliest call and every result of a parallel batch. */
export function protectToolBatchMutations(
    targets: Map<number, TagTarget>,
    admission: EditAdmission,
    batches: ReadonlyMap<string, readonly EditCoord[]>,
): Map<number, TagTarget> {
    if (admission.admit({ kind: "prefix" })) return targets;
    return new Map(
        [...targets].map(([tag, target]) => {
            if (!target.canDrop) return [tag, target];
            const sources = (target.mutationParts ?? []).flatMap(
                ({ message }) => batches.get(message.info.id ?? "") ?? [],
            );
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
