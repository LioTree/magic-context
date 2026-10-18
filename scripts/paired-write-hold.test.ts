import { expect, test } from "bun:test";
import { summarize } from "./paired-write-hold";

test("hold attribution retains environmental outliers and exposes quiet outliers", () => {
    const gaps: number[][] = [];
    for (let at = 0; at < 300; at += 5) if (at < 120 || at >= 145) gaps.push([at, at + 5, 5]);
    gaps.push([120, 145, 25]);
    gaps.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
    const result = summarize(
        [100, 200].map((start, index) => ({
            path: "pi",
            arm: "after",
            index,
            row: {
                kind: "busting",
                start,
                end: start + 70,
                wall: 70,
                paired: [{ site: "paired_thinking_edit", held: 70, start, end: start + 70 }],
            },
        })),
        gaps,
    );
    expect(result.outliers).toMatchObject([
        { index: 0, controlGap: 25, attribution: "environmental" },
        { index: 1, controlGap: 5, attribution: "ours" },
    ]);
    expect(result.summary["pi/after/busting"]).toMatchObject({
        passes: { all: 2, quiet: 1, environmental: 1 },
        paired_thinking_edit: { all: { n: 2, over50: 2 }, quiet: { n: 1, p95: 70, over50: 1 } },
    });
});

test("slow wall time without a write hold is not a lock outlier", () => {
    const result = summarize(
        [
            {
                path: "pi",
                arm: "after",
                index: 0,
                row: { kind: "defer", start: 0, end: 100, wall: 100, paired: [] },
            },
        ],
        [[0, 100, 5]],
    );
    expect(result.outliers).toEqual([]);
    expect(result.summary["pi/after/defer"]).toMatchObject({
        wallQuiet: { p95: 100 },
        paired_thinking_edit: { quiet: { p95: 0 } },
    });
});
