import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { pairedThinkingEdit } from "./paired-thinking-edit";
import {
    clearPendingMaterialization,
    hasOnlySystemHashMaterialization,
    pendingMaterializationOrigin,
    requestPendingMaterialization,
    snapshotPendingMaterialization,
} from "./pending-materialization";

function fixture() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE decisions (kind TEXT PRIMARY KEY)");
    const messages: unknown[] = [{ text: "unchanged" }];
    const kinds = () => db.prepare("SELECT kind FROM decisions ORDER BY kind").all();
    const pair = (
        edit: () => boolean,
        companion = () => {
            db.exec("INSERT INTO decisions VALUES ('strip')");
        },
    ) =>
        pairedThinkingEdit({
            db,
            messages,
            edit,
            needsCompanion: (changed) => changed,
            persistCompanion: companion,
        });
    return { db, messages, kinds, pair };
}

describe("paired thinking decisions", () => {
    it("commits a landed edit only together with its companion", () => {
        const f = fixture();
        try {
            f.pair(() => {
                f.db.exec("INSERT INTO decisions VALUES ('edit')");
                return true;
            });
            expect(f.kinds()).toEqual([{ kind: "edit" }, { kind: "strip" }]);
        } finally {
            f.db.close();
        }
    });
    it("a failed edit never commits a strip ahead of its edit", () => {
        const f = fixture();
        try {
            expect(() =>
                f.pair(() => {
                    f.messages[0] = { text: "changed" };
                    f.db.exec("INSERT INTO decisions VALUES ('edit')");
                    throw new Error("edit failed");
                }),
            ).toThrow("edit failed");
            expect(f.kinds()).toEqual([]);
            expect(f.messages).toEqual([{ text: "unchanged" }]);
        } finally {
            f.db.close();
        }
    });
    it("a companion failure rolls back the edit and the rendered bytes", () => {
        const f = fixture();
        try {
            expect(() =>
                f.pair(
                    () => {
                        f.messages[0] = { text: "changed" };
                        f.db.exec("INSERT INTO decisions VALUES ('edit')");
                        return true;
                    },
                    () => {
                        throw new Error("strip failed");
                    },
                ),
            ).toThrow("strip failed");
            expect(f.kinds()).toEqual([]);
            expect(f.messages).toEqual([{ text: "unchanged" }]);
        } finally {
            f.db.close();
        }
    });
    it("a no-op never creates a companion decision", () => {
        const f = fixture();
        try {
            f.pair(() => false);
            expect(f.kinds()).toEqual([]);
            expect(f.messages).toEqual([{ text: "unchanged" }]);
        } finally {
            f.db.close();
        }
    });
});

it("paired rollback preserves opaque host callbacks without refusing the render", () => {
    const db = new Database(":memory:");
    const callback = () => "opaque extension";
    const messages = [{ text: "before", callback }];
    try {
        expect(() =>
            pairedThinkingEdit({
                db,
                messages,
                edit: () => {
                    messages[0].text = "after";
                    throw new Error("failed");
                },
                needsCompanion: () => false,
                persistCompanion: () => {},
            }),
        ).toThrow("failed");
        expect(messages[0].text).toBe("before");
        expect(messages[0].callback).toBe(callback);
    } finally {
        db.close();
    }
});

it("a failed pair restores the trigger's original reasons and in-memory metadata", () => {
    const db = new Database(":memory:");
    const flags = new Set<string>();
    requestPendingMaterialization(flags, "session", "system_hash");
    requestPendingMaterialization(flags, "session", "user_flush");
    const restore = snapshotPendingMaterialization(flags, "session");
    const state = { watermark: 0 };
    try {
        expect(() =>
            pairedThinkingEdit({
                db,
                messages: [],
                state,
                edit: () => {
                    clearPendingMaterialization(flags, "session");
                    state.watermark = 10;
                    return true;
                },
                needsCompanion: () => true,
                persistCompanion: () => {
                    throw new Error("refuse companion");
                },
                onRollback: restore,
            }),
        ).toThrow("refuse companion");
        expect(flags.has("session")).toBe(true);
        expect(pendingMaterializationOrigin(flags, "session")).toBe("system_hash");
        expect(hasOnlySystemHashMaterialization(flags, "session")).toBe(false);
        expect(state.watermark).toBe(0);
    } finally {
        db.close();
    }
});
