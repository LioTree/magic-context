import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
    LKG_SLOT_CHUNKS_DDL,
    LKG_SLOTS_DDL,
} from "../../features/magic-context/migration-v94-write-split";
import {
    isRustMarkerAdmissionFenced,
    setRustMarkerAdmissionFence,
} from "../../features/magic-context/storage-replay-document";
import type { Database } from "../../shared/sqlite";
import {
    clearPersistedLkgSlot,
    drainStaleLkgSlots,
    loadPersistedLkgSlot,
    pruneStaleLkgSlots,
    saveLkgSlotToDb,
} from "./lkg-persist";
import type { LkgSlot } from "./lkg-slot";

function fixture(): { db: Database; raw: BunDatabase } {
    const raw = new BunDatabase(":memory:");
    raw.exec(`${LKG_SLOTS_DDL} ${LKG_SLOT_CHUNKS_DDL}
        CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, trailing_blank_decisions TEXT DEFAULT '');
        CREATE TABLE session_projects (session_id TEXT, updated_at INTEGER);`);
    return { db: raw as unknown as Database, raw };
}

const slot: LkgSlot = {
    jsonPrefix: '[{"text":"one"}]',
    inputIdSeq: ["m1"],
    inputContentDigests: ["digest"],
    lastInputMessageId: "m1",
    modelKey: "model",
    providerKey: "provider",
    capturedAt: 1,
};

describe("LKG durable write discipline", () => {
    it("metadata preparation failure retains the durable request without publishing Pi metadata", () => {
        const { db, raw } = fixture();
        try {
            expect(saveLkgSlotToDb(db, "ses", slot)).toBe(true);
            let serializations = 0;
            const digests = [...slot.inputContentDigests];
            Object.defineProperty(digests, "toJSON", {
                value: () => {
                    if (++serializations === 2) throw new Error("metadata preparation failed");
                    return [...digests];
                },
            });
            let published = false;
            expect(
                saveLkgSlotToDb(db, "ses", { ...slot, inputContentDigests: digests }, () => {
                    published = true;
                }),
            ).toBe(false);
            expect(serializations).toBe(2);
            expect(published).toBe(false);
            expect(raw.inTransaction).toBe(false);
            expect(loadPersistedLkgSlot(db, "ses")?.jsonPrefix).toBe(slot.jsonPrefix);
        } finally {
            raw.close();
        }
    });
    // Only the full-array Rust transform writes this fence, and no host runs it
    // any more. A fence left on disk by an earlier process has no adapter to
    // clear it, so it must not disable disk hydration for that session.
    it("hydrates a durable slot when the fence on disk was left by an earlier process", () => {
        const { db, raw } = fixture();
        try {
            expect(saveLkgSlotToDb(db, "ses-stale-fence", slot)).toBe(true);
            raw.query("INSERT INTO session_meta VALUES (?, ?)").run(
                "ses-stale-fence",
                '{"version":2,"trailingBlank":{},"rustMarkerAdmissionFence":true}',
            );
            expect(isRustMarkerAdmissionFenced(db, "ses-stale-fence")).toBe(false);
            expect(loadPersistedLkgSlot(db, "ses-stale-fence")?.jsonPrefix).toBe(slot.jsonPrefix);
        } finally {
            raw.close();
        }
    });
    it("does not hydrate a durable slot while marker rebuilding admission is fenced in this process", () => {
        const { db, raw } = fixture();
        try {
            expect(saveLkgSlotToDb(db, "ses-live-fence", slot)).toBe(true);
            raw.query("INSERT INTO session_meta VALUES (?, ?)").run(
                "ses-live-fence",
                '{"version":2,"trailingBlank":{}}',
            );
            setRustMarkerAdmissionFence(db, "ses-live-fence", true);
            expect(loadPersistedLkgSlot(db, "ses-live-fence")).toBeUndefined();
            setRustMarkerAdmissionFence(db, "ses-live-fence", false);
            expect(loadPersistedLkgSlot(db, "ses-live-fence")?.jsonPrefix).toBe(slot.jsonPrefix);
        } finally {
            raw.close();
        }
    });
    it("writes once for identical passes, but persists a one-byte change and a clear", () => {
        const { db, raw } = fixture();
        try {
            expect(saveLkgSlotToDb(db, "ses", slot)).toBe(true);
            const initial = raw.query("SELECT total_changes() AS count").get() as { count: number };
            for (let i = 0; i < 5; i++)
                expect(saveLkgSlotToDb(db, "ses", { ...slot, capturedAt: i + 2 })).toBe(true);
            expect(
                (raw.query("SELECT total_changes() AS count").get() as { count: number }).count,
            ).toBe(initial.count);
            const changed = { ...slot, jsonPrefix: '[{"text":"onf"}]' };
            expect(saveLkgSlotToDb(db, "ses", changed)).toBe(true);
            expect(loadPersistedLkgSlot(db, "ses")?.jsonPrefix).toBe(changed.jsonPrefix);
            // Two row changes: the prefix's only slice and the slot's metadata row.
            expect(
                (raw.query("SELECT total_changes() AS count").get() as { count: number }).count,
            ).toBe(initial.count + 2);
            clearPersistedLkgSlot(db, "ses");
            expect(saveLkgSlotToDb(db, "ses", changed)).toBe(true);
            expect(loadPersistedLkgSlot(db, "ses")?.jsonPrefix).toBe(changed.jsonPrefix);
        } finally {
            raw.close();
        }
    });

    it("bounds LKG pruning to 25 slices and resumes orphan cleanup without a replayable partial prefix", () => {
        const { db, raw } = fixture();
        try {
            saveLkgSlotToDb(db, "large-old", { ...slot, jsonPrefix: "x".repeat(60 * 65536) });
            const count = () =>
                (raw.query("SELECT COUNT(*) AS n FROM lkg_slot_chunks").get() as { n: number }).n;
            expect(count()).toBe(60);
            expect(pruneStaleLkgSlots(db, 20 * 86400000)).toBe(1);
            expect(count()).toBe(35);
            expect(loadPersistedLkgSlot(db, "large-old")).toBeUndefined();
            expect(pruneStaleLkgSlots(db, 20 * 86400000)).toBe(0);
            expect(count()).toBe(10);
            expect(pruneStaleLkgSlots(db, 20 * 86400000)).toBe(0);
            expect(count()).toBe(0);
        } finally {
            raw.close();
        }
    });

    it("drains orphan-only batches and multiple old slots within one tick", async () => {
        const { db, raw } = fixture();
        try {
            for (let i = 0; i < 3; i++)
                saveLkgSlotToDb(db, `large-old-${i}`, {
                    ...slot,
                    jsonPrefix: "x".repeat(60 * 65536),
                });
            expect(await drainStaleLkgSlots(db, 20 * 86400000)).toBe(3);
            expect(raw.query("SELECT COUNT(*) AS n FROM lkg_slot_chunks").get()).toEqual({ n: 0 });
        } finally {
            raw.close();
        }
    });

    it("prunes old slots but keeps recent captures and recent session bindings", () => {
        const { db, raw } = fixture();
        try {
            const now = 20 * 24 * 60 * 60 * 1000;
            saveLkgSlotToDb(db, "old", slot);
            saveLkgSlotToDb(db, "active", slot);
            saveLkgSlotToDb(db, "recent", { ...slot, capturedAt: now });
            raw.query("INSERT INTO session_projects VALUES (?, ?)").run("active", now);
            expect(pruneStaleLkgSlots(db, now)).toBe(1);
            expect(loadPersistedLkgSlot(db, "old")).toBeUndefined();
            expect(loadPersistedLkgSlot(db, "active")).toBeDefined();
            expect(loadPersistedLkgSlot(db, "recent")).toBeDefined();
            expect(saveLkgSlotToDb(db, "old", slot)).toBe(true);
            expect(loadPersistedLkgSlot(db, "old")).toBeDefined();
        } finally {
            raw.close();
        }
    });
});
