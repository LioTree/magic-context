import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { VectorFile } from "./format";
import { encodeVectors, generateVectors, VECTOR_PATH } from "./generate";
import { replayCase } from "./runner";

const bytes = await readFile(VECTOR_PATH, "utf8");
const vectors = JSON.parse(bytes) as VectorFile;

describe("relay-v1 frozen-byte conformance", () => {
    for (const vector of vectors.cases) {
        test(vector.id, async () => {
            await replayCase(vector);
        });
    }

    test("regeneration is byte-identical through real MC routes", async () => {
        expect(encodeVectors(await generateVectors())).toBe(bytes);
    }, 1_800_000);

    test("vectors carry positive coverage and whole-message burn controls", () => {
        const applied = vectors.cases.find((entry) => entry.id === "view-accept-coverage")!;
        expect(applied.steps[3].expected.coverage).toEqual({ end_mid: "m1", ordinal: 1 });
        for (const reason of ["structural", "late", "superseded"]) {
            const vector = vectors.cases.find((entry) => entry.id === `view-${reason}-coverage`)!;
            expect(vector.steps[3].exchanges[0].answer_bytes).toContain('"coverage"');
            expect(vector.steps[3].expected.coverage).toBeNull();
            expect(vector.steps[3].expected.last_not_applied).not.toBeNull();
        }
        for (const mode of ["transport", "timeout"]) {
            const raw = vectors.cases.find((entry) => entry.id === `whole-message-raw-${mode}`)!;
            const snapshot = raw.steps[1].expected;
            expect(snapshot.unserved_subjects.map((subject) => subject.hook)).toEqual([
                "post_assistant",
                "post_tool",
                "post_tool",
            ]);
            expect(snapshot.entries[1].served_bytes).toBe(snapshot.entries[1].ingest_bytes);
            expect(raw.steps[3].expected.served_bytes).toBe(snapshot.served_bytes);
            expect(raw.steps[3].expected.after_ordinal).toBe(2);
        }
    });
});
