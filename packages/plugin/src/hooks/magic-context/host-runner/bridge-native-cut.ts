import type { MessageLike } from "../transform-operations";
import type { BridgeNativeCut } from "./bridge-marker";

type OpenCodeCut = Extract<BridgeNativeCut, { kind: "opencode" }>;

/** Validate the boundary the host actually assembled, not just a stored marker part.
 * OpenCode moves the completed pair before its optional retained pre-boundary tail. */
export function openCodeCutProblem(
    messages: readonly MessageLike[],
    cut: OpenCodeCut,
): string | undefined {
    const boundaries = messages.filter((m) => m.info.id === cut.boundary_mid);
    const summaries = messages.filter((m) => m.info.id === cut.summary_mid);
    const boundary = boundaries[0];
    const summary = summaries[0];
    if (boundaries.length !== 1 || boundary?.info.role !== "user")
        return "native-cut-boundary-missing";
    if (summaries.length !== 1 || !summary) return "native-cut-summary-missing";
    const info = summary.info as Record<string, unknown>;
    if (
        info.role !== "assistant" ||
        info.parentID !== cut.boundary_mid ||
        info.summary !== true ||
        !info.finish ||
        info.error
    )
        return "native-cut-summary-incomplete";
    const parts = boundary.parts.filter(
        (p) => (p as Record<string, unknown>).type === "compaction",
    ) as Record<string, unknown>[];
    if (parts.length !== 1 || parts[0]?.id !== cut.compaction_part_id)
        return "native-cut-part-changed";
    if (parts[0]?.tail_start_id !== cut.tail_start_id) return "native-cut-tail-edited";
    if (cut.tail_start_id && messages.filter((m) => m.info.id === cut.tail_start_id).length !== 1)
        return "native-cut-tail-dangling";
    if (messages[0] !== boundary || messages[1] !== summary) return "native-cut-prefix-returned";
    if (cut.tail_start_id && messages[2]?.info.id !== cut.tail_start_id)
        return "native-cut-retained-tail-changed";
    return undefined;
}

/** Restore raw append order for source comparison. The host puts C/S before a
 * retained tail, while the runner's identities keep C at its original ordinal. */
export function openCodeCutSources(
    messages: readonly MessageLike[],
    cut: OpenCodeCut,
    ids: ReadonlyMap<string, number>,
): MessageLike[] | undefined {
    const boundary = messages.find((m) => m.info.id === cut.boundary_mid);
    const boundaryOrdinal = ids.get(cut.boundary_mid);
    if (!boundary || boundaryOrdinal === undefined) return undefined;
    const source = {
        ...boundary,
        parts: boundary.parts.filter((p) => (p as Record<string, unknown>).type !== "compaction"),
    };
    const rest = messages.filter(
        (m) => m.info.id !== cut.boundary_mid && m.info.id !== cut.summary_mid,
    );
    let insert = 0;
    if (cut.tail_start_id) {
        const tailOrdinal = ids.get(cut.tail_start_id);
        if (tailOrdinal === undefined || tailOrdinal >= boundaryOrdinal) return undefined;
        while (insert < rest.length) {
            const ordinal = ids.get(rest[insert]?.info.id ?? "");
            if (ordinal === undefined || ordinal >= boundaryOrdinal) break;
            insert++;
        }
    }
    return [...rest.slice(0, insert), source, ...rest.slice(insert)];
}
