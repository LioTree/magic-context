import { describe, expect, it, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { ParkedBustTriggers } from "./trigger-parking";

describe("parked bust triggers", () => {
    it("releases all parked triggers together only without a boundary", () => {
        const triggers = new ParkedBustTriggers();
        expect(triggers.permissions(true, true, true)).toEqual({
            materialization: true,
            force: true,
            history: false,
        });
        triggers.holdMaterialization();
        triggers.holdForce();
        expect(triggers.permissions(true, true, true)).toEqual({
            materialization: false,
            force: false,
            history: false,
        });
        expect(triggers.permissions(false, true, true)).toEqual({
            materialization: true,
            force: true,
            history: false,
        });
        triggers.settle(false, false);
        expect(triggers.pending).toBe(false);
    });

    it("cancels inactive obligations without granting a permission", () => {
        const triggers = new ParkedBustTriggers();
        triggers.holdMaterialization();
        triggers.holdForce();
        expect(triggers.permissions(true, false, false)).toEqual({
            materialization: false,
            force: false,
            history: false,
        });
        expect(triggers.pending).toBe(false);
        expect(triggers.permissions(false, false, false)).toEqual({
            materialization: false,
            force: false,
            history: false,
        });
    });

    it("settles each obligation independently", () => {
        const triggers = new ParkedBustTriggers();
        triggers.holdMaterialization();
        triggers.holdForce();
        triggers.settle(true, false);
        expect(triggers.permissions(true, true, true)).toEqual({
            materialization: false,
            force: true,
            history: false,
        });
        triggers.settle(false, true);
        expect(triggers.pending).toBe(false);
    });

    it("parks a history refresh only under a boundary and clears it with its signal", () => {
        const triggers = new ParkedBustTriggers();
        expect(triggers.permissions(true, false, false, true).history).toBe(true);
        triggers.holdHistory();
        expect(triggers.permissions(true, false, false, true).history).toBe(false);
        triggers.settle(false, false, true);
        expect(triggers.pending).toBe(true);
        expect(triggers.permissions(false, false, false, true).history).toBe(true);
        triggers.settle(false, false, false);
        expect(triggers.pending).toBe(false);
        expect(triggers.permissions(true, false, false, false).history).toBe(false);
    });
});

function database() {
    const db = new Database(":memory:");
    db.exec(
        "CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, held_release TEXT); INSERT INTO session_meta VALUES ('session', NULL)",
    );
    return db;
}

test("held obligations hydrate independently with original reasons and settle only their own work", () => {
    const db = database();
    try {
        const held = ParkedBustTriggers.load(db, "session");
        held.holdMaterialization("user_flush");
        held.holdMaterialization("thinking_hold");
        held.holdForce();
        held.persist(db, "session");
        const restarted = ParkedBustTriggers.load(db, "session");
        expect(restarted.reason("materialization")).toBe("user_flush");
        expect(restarted.permissions(true, true, true)).toEqual({
            materialization: false,
            force: false,
            history: false,
        });
        restarted.settle(true, false);
        restarted.persist(db, "session");
        const afterTailReclaim = ParkedBustTriggers.load(db, "session");
        expect(afterTailReclaim.reason("force")).toBeUndefined();
        expect(afterTailReclaim.permissions(false, true, false)).toEqual({
            materialization: true,
            force: false,
            history: false,
        });
        afterTailReclaim.settle(false, false);
        afterTailReclaim.persist(db, "session");
        expect(db.prepare("SELECT held_release FROM session_meta").get()).toEqual({
            held_release: null,
        });
    } finally {
        db.close();
    }
});

test("held obligation CAS conflict refuses the stale writer without deleting the peer request", () => {
    const db = database();
    try {
        const first = ParkedBustTriggers.load(db, "session");
        const stale = ParkedBustTriggers.load(db, "session");
        first.holdMaterialization("user_flush");
        first.persist(db, "session");
        stale.holdForce();
        expect(() => stale.persist(db, "session")).toThrow("Held release changed during transform");
        expect(ParkedBustTriggers.load(db, "session").reasons).toEqual(["user_flush"]);
    } finally {
        db.close();
    }
});
