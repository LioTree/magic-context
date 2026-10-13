export interface CompartmentScoreVisibility {
    appliedWatermark: number;
    effectiveWatermark: number;
    scores: {
        compartmentId: number;
        base: number;
        effective: number;
        applied: number;
        pending: boolean;
    }[];
}

export function compartmentScoreStatusRows(
    view?: CompartmentScoreVisibility,
): Array<readonly [string, string]> {
    if (!view?.scores.length) return [];
    return view.scores.map((score) => [
        `History score #${score.compartmentId}`,
        `base ${score.base} · effective ${score.effective} · applied ${score.applied}${score.pending ? " — pending next natural rebuild" : ""}`,
    ]);
}
