import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { resolveMemoriesByIdsForSearch } from "../search";
import { initializeDatabase } from "../storage-db";
import { readFullyVisibleMemoryIds, writeHardProjection } from "./applied-projection";
import { archiveMemory, insertMemory } from "./storage-memory";

function store() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}
const projectPath = "git:applied-projection";

describe("applied projection visibility", () => {
    // A mural cue is not the full claim: it never hides a memory from search,
    // even at the revision the cue was drawn from. Text rendering does.
    test("cue_visibility_does_not_hide_full_text", () => {
        const db = store();
        try {
            const cued = insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE",
                content: "Cue only.",
            });
            const shown = insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE",
                content: "Shown in full.",
            });
            writeHardProjection(db, {
                sessionId: "ses",
                projectPath,
                m0Text: "m0",
                hardMemoryBlock: JSON.stringify({ updateLines: [], newMemories: "" }),
                fragmentWatermark: 0,
                revisions: new Map([
                    [cued.id, 1],
                    [shown.id, 1],
                ]),
                textMemories: [shown],
                cueMemories: [cued, shown],
                deltaMemories: [],
            });
            expect([...(readFullyVisibleMemoryIds(db, "ses") ?? [])]).toEqual([shown.id]);
        } finally {
            db.close();
        }
    });

    // Retired rows are history, not current memory: asking for an archived id by
    // number finds nothing, while live ids in the same request still resolve.
    test("retired_rows_are_history_only", () => {
        const db = store();
        try {
            const live = insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE",
                content: "Live claim.",
            });
            const retired = insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE",
                content: "Retired claim.",
            });
            archiveMemory(db, retired.id, "obsolete");
            const both = resolveMemoriesByIdsForSearch({
                db,
                projectPath,
                ids: [retired.id, live.id],
                limit: 10,
            });
            expect(both?.map((result) => result.memoryId)).toEqual([live.id]);
            expect(
                resolveMemoriesByIdsForSearch({ db, projectPath, ids: [retired.id], limit: 10 }),
            ).toBeNull();
        } finally {
            db.close();
        }
    });
});
