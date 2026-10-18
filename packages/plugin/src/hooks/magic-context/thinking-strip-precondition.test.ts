import { describe, expect, it } from "bun:test";
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
        db.exec(`CREATE TRIGGER reject_companion BEFORE UPDATE OF merged_reasoning_stripped_ids ON session_meta
            BEGIN SELECT RAISE(ABORT, 'companion write rejected'); END`);
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
