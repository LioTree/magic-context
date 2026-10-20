import { describe, expect, it } from "bun:test";
import { rejectSessionMetaCollectionWrites } from "../../features/magic-context/__tests__/session-meta-faults";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getMergedReasoningStrippedIds } from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import type { MessageLike } from "./tag-messages";
import { freezeReasoningOnBustingPass } from "./transform-postprocess-phase";

const assistant = (id?: string): MessageLike => ({
    info: { id, role: "assistant" },
    parts: [{ type: "reasoning", text: "signed", metadata: { anthropic: { signature: "sig" } } }],
});

describe("thinking companion precondition", () => {
    it("withholds the whole companion plan when an older assistant lacks an id", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        try {
            const messages = [assistant("older"), assistant()];
            const before = structuredClone(messages);
            expect(
                freezeReasoningOnBustingPass({
                    db,
                    sessionId: "missing-id",
                    messages,
                    alreadyFrozen: new Set(),
                }),
            ).toEqual({ strip: null, persistenceFailed: true });
            expect(messages).toEqual(before);
            expect(getMergedReasoningStrippedIds(db, "missing-id").size).toBe(0);
        } finally {
            db.close();
        }
    });

    it("reports a failed companion write before any omission can be served", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, "write-failure");
        rejectSessionMetaCollectionWrites(db, "merged_reasoning_stripped_ids", "reject_companion", {
            error: "companion write rejected",
        });
        try {
            const messages = [assistant("older")];
            const before = structuredClone(messages);
            expect(
                freezeReasoningOnBustingPass({
                    db,
                    sessionId: "write-failure",
                    messages,
                    alreadyFrozen: new Set(),
                }),
            ).toEqual({ strip: null, persistenceFailed: true });
            expect(messages).toEqual(before);
            expect(getMergedReasoningStrippedIds(db, "write-failure").size).toBe(0);
        } finally {
            db.close();
        }
    });
});
