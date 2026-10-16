import { admissionStableId, type EditAdmission } from "./edit-admission";

/** Hold new gap markers before they can be saved or inserted ahead of signed thinking. */
export function admitTemporalCandidates(args: {
    candidates: ReadonlyMap<string, string>;
    frozen: ReadonlyMap<string, string>;
    locations: Iterable<{ id: string | undefined; block: number }>;
    admission: EditAdmission;
    onHeld?: (ids: string[]) => void;
}): Map<string, string> {
    const locations = new Map<string, number>();
    for (const { id, block } of args.locations) {
        const stableId = admissionStableId(id);
        if (stableId && block >= 0) locations.set(stableId, block);
    }
    const admitted = new Map<string, string>();
    const held: string[] = [];
    for (const [id, marker] of args.candidates) {
        // Restoring an already saved marker reproduces earlier requests; it is not a new edit.
        if (args.frozen.has(id)) continue;
        const block = locations.get(id);
        if (block !== undefined && args.admission.admit({ kind: "message", id, block })) {
            admitted.set(id, marker);
        } else if (marker) {
            held.push(id);
        }
    }
    if (held.length) args.onHeld?.(held);
    return admitted;
}
