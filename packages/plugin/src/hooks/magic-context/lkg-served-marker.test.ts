import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    clearPersistedLkgSlotStrict,
    createDbLkgPersistence,
    lkgSlotCertificateDigest,
    loadPersistedLkgSlot,
    saveLkgSlotToDb,
} from "./lkg-persist";
import { captureLkgSlot, projectLkgEntry, replayLkg } from "./lkg-replay";
import {
    checkLkgDurability,
    failedPassRestoreMode,
    readServedMarker,
    recordServedCapture,
    recordServedSlotState,
    repairLkgDurability,
    startLkgDurabilityPoll,
} from "./lkg-served-marker";
import {
    captureSlot,
    dropSlot,
    forgetInMemorySlot,
    getSlot,
    type LkgSlot,
    registerLkgPersistence,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import {
    moveInputs,
    moveMessageDigestFromFields,
    persistedMoveInputs,
    summarizeMoveInputs,
} from "./move-inputs";
import type { MessageLike } from "./transform-operations";

const databases: Database[] = [];
function fixture(path = ":memory:"): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    registerLkgPersistence(createDbLkgPersistence(db));
    return db;
}
const slot = (servedCaptureId?: number): LkgSlot => ({
    jsonPrefix: '[{"text":"served"}]',
    inputIdSeq: ["u"],
    inputContentDigests: ["digest"],
    inputMoveDigests: ["a".repeat(64)],
    lastInputMessageId: "u",
    modelKey: "m",
    providerKey: "p",
    capturedAt: Date.now(),
    rowVersion: 900,
    captureSequence: 3,
    servedCaptureId,
    fullCoverage: true,
});
afterEach(() => {
    resetLkgSlotsForTest();
    for (const db of databases) db.close();
    databases.length = 0;
});

describe("served marker durability", () => {
    test("unchanged served captures do not write the marker", () => {
        const db = fixture();
        const first = slot(recordServedCapture(db, "s", true));
        expect(captureSlot("s", first)).toBe(true);
        db.exec(`CREATE TABLE marker_writes(n INTEGER);
            CREATE TRIGGER count_marker_writes AFTER UPDATE ON lkg_served_markers
            BEGIN INSERT INTO marker_writes VALUES(1); END`);
        const next = { ...first, capturedAt: first.capturedAt + 1, captureSequence: 4 };
        expect(recordServedCapture(db, "s", true, next)).toBe(first.servedCaptureId);
        expect(db.prepare("SELECT count(*) AS n FROM marker_writes").get()).toEqual({ n: 0 });
        expect(readServedMarker(db, "s")?.servedCaptureId).toBe(first.servedCaptureId);
    });

    test("changed frontiers and invalidated certificates allocate fresh served ids", () => {
        const db = fixture();
        const first = slot(recordServedCapture(db, "s", true));
        const variants: LkgSlot[] = [
            { ...first, jsonPrefix: "[]" },
            { ...first, inputIdSeq: ["different"] },
            { ...first, inputContentDigests: ["different"] },
            { ...first, inputMoveDigests: ["b".repeat(64)] },
            { ...first, modelKey: "other" },
            { ...first, providerKey: "other" },
            { ...first, rowVersion: 901 },
            { ...first, piOutputEntryIds: [null] },
        ];
        for (const candidate of variants) {
            const baseline = { ...first, servedCaptureId: recordServedCapture(db, "s", true) };
            expect(captureSlot("s", baseline)).toBe(true);
            expect(recordServedCapture(db, "s", true, candidate)).toBe(
                baseline.servedCaptureId! + 1,
            );
        }
        const baseline = { ...first, servedCaptureId: recordServedCapture(db, "s", true) };
        expect(captureSlot("s", baseline)).toBe(true);
        expect(recordServedCapture(db, "s", false, first)).toBe(baseline.servedCaptureId! + 1);
        const current = { ...first, servedCaptureId: recordServedCapture(db, "s", true) };
        expect(captureSlot("s", current)).toBe(true);
        recordServedSlotState(db, "s", "invalidated");
        expect(recordServedCapture(db, "s", true, current)).toBe(current.servedCaptureId! + 1);
        forgetInMemorySlot("s");
        expect(recordServedCapture(db, "s", true, current)).toBe(current.servedCaptureId! + 2);
    });

    test("an older marker never certifies a newer durable capture at the same row_version", () => {
        const db = fixture();
        expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: null });
        const first = slot(recordServedCapture(db, "s", true));
        expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
        const second = { ...slot(recordServedCapture(db, "s", true)), captureSequence: 4 };
        expect(second.servedCaptureId).toBe(2);
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
        expect(saveLkgSlotToDb(db, "s", second)).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: 2 });
        expect(loadPersistedLkgSlot(db, "s")?.rowVersion).toBe(900);
        expect(loadPersistedLkgSlot(db, "s")?.captureSequence).toBe(4);
        expect(saveLkgSlotToDb(db, "s", first, { force: true })).toBe(false);
        expect(loadPersistedLkgSlot(db, "s")?.servedCaptureId).toBe(2);
        // An uncertified legacy writer cannot leave the newer id attached to
        // different slot bytes and accidentally authorize their export.
        expect(
            saveLkgSlotToDb(db, "s", {
                ...second,
                servedCaptureId: undefined,
                inputMoveDigests: undefined,
            }),
        ).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
    });

    test("a stopped fresh process reports failed persistence as uncertified instead of exporting an older slot", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "served-marker-"));
        try {
            const db = fixture(join(root, "context.db"));
            const first = slot(recordServedCapture(db, "s", true));
            expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
            const second = { ...slot(recordServedCapture(db, "s", true)), captureSequence: 4 };
            expect(captureSlot("s", second)).toBe(true);
            db.exec(
                "CREATE TRIGGER fail_lkg BEFORE INSERT ON lkg_slots BEGIN SELECT RAISE(ABORT, 'injected save failure'); END",
            );
            expect(saveLkgSlotToDb(db, "s", second)).toBe(false);
            resetLkgSlotsForTest();
            const fresh = new Database(join(root, "context.db"));
            databases.push(fresh);
            expect(repairLkgDurability(fresh, "s")).toEqual({
                durable: true,
                servedCaptureId: null,
                certified: false,
            });
            expect(loadPersistedLkgSlot(fresh, "s")?.servedCaptureId).toBe(1);
        } finally {
            for (const db of databases.splice(0)) db.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the one-second draining poll re-persists only the matching live capture", async () => {
        const db = fixture();
        const current = slot(recordServedCapture(db, "s", true));
        expect(captureSlot("s", current)).toBe(true);
        db.exec(
            "CREATE TRIGGER fail_lkg BEFORE INSERT ON lkg_slots BEGIN SELECT RAISE(ABORT, 'injected save failure'); END",
        );
        expect(saveLkgSlotToDb(db, "s", current)).toBe(false);
        db.exec("DROP TRIGGER fail_lkg");
        let draining: string[] = [];
        let polls = 0;
        const errors: unknown[] = [];
        const stop = startLkgDurabilityPoll(
            db,
            () => {
                polls++;
                return draining;
            },
            (error) => errors.push(error),
        );
        try {
            expect(checkLkgDurability(db, "s")).toEqual({
                durable: true,
                servedCaptureId: null,
                certified: false,
            });
            draining = ["s"];
            await new Promise((resolve) => setTimeout(resolve, 1100));
            expect(polls).toBe(1);
            expect(errors).toEqual([]);
            expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: 1 });
            expect(readServedMarker(db, "s")?.servedCaptureId).toBe(1);
            // Eviction cannot turn an older disk slot into proof of a newer capture.
            recordServedCapture(db, "s", true);
            forgetInMemorySlot("s");
            expect(repairLkgDurability(db, "s")).toEqual({
                durable: true,
                servedCaptureId: null,
                certified: false,
            });
        } finally {
            stop();
        }
    });

    test.each([
        "lkg_cache_bust_pending_capture",
        "lkg_refresh_declined",
        "lkg_async_capture_failed",
        "rust_marker_admission_fenced",
    ])("a %s drop records its reason atomically and the next capture recovers", (reason) => {
        const db = fixture();
        const first = slot(recordServedCapture(db, "s", true));
        expect(captureSlot("s", first)).toBe(true);
        expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
        dropSlot("s", reason);
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: false,
            reason: "no_frontier",
            slotState: reason,
        });
        expect(loadPersistedLkgSlot(db, "s")).toBeUndefined();
        const next = slot(recordServedCapture(db, "s", true));
        expect(saveLkgSlotToDb(db, "s", next)).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: 2 });
    });

    test("failed capture and drop markers never refuse serving or preserve an old certificate on the new slot", () => {
        const db = fixture();
        const first = slot(recordServedCapture(db, "s", true));
        expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
        db.exec(
            "CREATE TRIGGER fail_marker BEFORE INSERT ON lkg_served_markers BEGIN SELECT RAISE(ABORT, 'marker write failure'); END",
        );
        const latest = {
            ...slot(recordServedCapture(db, "s", true)),
            jsonPrefix: '[{"text":"new served bytes"}]',
            captureSequence: 4,
        };
        expect(latest.servedCaptureId).toBeUndefined();
        expect(captureSlot("s", latest)).toBe(true);
        expect(saveLkgSlotToDb(db, "s", latest)).toBe(true);
        expect(loadPersistedLkgSlot(db, "s")?.jsonPrefix).toBe(latest.jsonPrefix);
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
        expect(readServedMarker(db, "s")?.servedCaptureId).toBe(1);
        expect(() => clearPersistedLkgSlotStrict(db, "s", "declined")).not.toThrow();
        expect(loadPersistedLkgSlot(db, "s")).toBeUndefined();
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
    });

    test("bounded busy acquisition loses certification without refusing the capture", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "served-marker-busy-"));
        const db = fixture(join(root, "context.db"));
        const blocker = new Database(join(root, "context.db"));
        try {
            blocker.exec("BEGIN IMMEDIATE");
            const started = performance.now();
            expect(recordServedCapture(db, "s", true)).toBeUndefined();
            expect(performance.now() - started).toBeLessThan(2000);
            expect(readServedMarker(db, "s")).toBeUndefined();
        } finally {
            blocker.exec("ROLLBACK");
            blocker.close();
            for (const connection of databases.splice(0)) connection.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("an unmarked replacement is durably uncertified across a fresh connection despite an older marker", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "unmarked-capture-"));
        try {
            const db = fixture(join(root, "context.db"));
            expect(saveLkgSlotToDb(db, "s", slot(recordServedCapture(db, "s", true)))).toBe(true);
            db.exec(
                "CREATE TRIGGER fail_marker BEFORE INSERT ON lkg_served_markers BEGIN SELECT RAISE(ABORT, 'marker write failure'); END",
            );
            const latest = {
                ...slot(recordServedCapture(db, "s", true)),
                jsonPrefix: '[{"text":"latest served bytes"}]',
                captureSequence: 4,
            };
            expect(captureSlot("s", latest)).toBe(true);
            expect(saveLkgSlotToDb(db, "s", latest)).toBe(true);
            expect(
                db.prepare("SELECT served_capture_id FROM lkg_slots WHERE session_id='s'").get(),
            ).toEqual({ served_capture_id: null });
            resetLkgSlotsForTest();
            const fresh = new Database(join(root, "context.db"));
            databases.push(fresh);
            expect(checkLkgDurability(fresh, "s")).toEqual({
                durable: true,
                servedCaptureId: null,
                certified: false,
            });
            expect(repairLkgDurability(fresh, "s")).toEqual({
                durable: true,
                servedCaptureId: null,
                certified: false,
            });
            expect(loadPersistedLkgSlot(fresh, "s")?.jsonPrefix).toBe(latest.jsonPrefix);
            expect(readServedMarker(fresh, "s")?.servedCaptureId).toBe(1);
        } finally {
            for (const db of databases.splice(0)) db.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a crash before deferred save leaves the old pair and replays all newer host messages as tail", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "marker-crash-window-"));
        try {
            const db = fixture(join(root, "context.db"));
            const first = [
                {
                    info: { id: "u1", role: "user", time: { created: 1 } },
                    parts: [{ type: "text", text: "first input" }],
                },
            ] as MessageLike[];
            const capture = (messages: MessageLike[]) =>
                captureLkgSlot({
                    sessionId: "s",
                    input: projectLkgEntry(messages),
                    output: messages,
                    modelKey: "test/model",
                    providerKey: "test",
                    onPrepared: (snapshot, full) => {
                        snapshot.servedCaptureId = recordServedCapture(db, "s", full);
                    },
                });
            expect(capture(first)).toBe(true);
            expect(saveLkgSlotToDb(db, "s", getSlot("s")!)).toBe(true);
            db.exec(
                "CREATE TRIGGER fail_marker BEFORE INSERT ON lkg_served_markers BEGIN SELECT RAISE(ABORT, 'marker write failure'); END",
            );
            const latest = [
                ...first,
                {
                    info: { id: "a1", role: "assistant", time: { created: 2 } },
                    parts: [{ type: "text", text: "first reply" }],
                },
                {
                    info: { id: "u2", role: "user", time: { created: 3 } },
                    parts: [{ type: "text", text: "newer input" }],
                },
            ] as MessageLike[];
            expect(capture(latest)).toBe(true);
            expect(getSlot("s")?.servedCaptureId).toBeUndefined();
            // Lose the process before its queued payload save runs. The durable
            // old pair is accepted, just as it is for an ordinary local restart.
            resetLkgSlotsForTest();
            const fresh = new Database(join(root, "context.db"));
            databases.push(fresh);
            registerLkgPersistence(createDbLkgPersistence(fresh));
            expect(checkLkgDurability(fresh, "s")).toEqual({ durable: true, servedCaptureId: 1 });
            const replay = replayLkg({
                sessionId: "s",
                messages: latest,
                modelKey: "test/model",
                providerKey: "test",
            });
            expect(replay.ok).toBe(true);
            if (replay.ok) expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(latest));
        } finally {
            for (const db of databases.splice(0)) db.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the draining poll certifies the final unmarked live capture without changing bytes or capture_sequence", async () => {
        const db = fixture();
        db.exec(
            "CREATE TRIGGER fail_marker BEFORE INSERT ON lkg_served_markers BEGIN SELECT RAISE(ABORT, 'marker write failure'); END",
        );
        const latest = { ...slot(recordServedCapture(db, "s", true)), captureSequence: 17 };
        expect(captureSlot("s", latest)).toBe(true);
        expect(saveLkgSlotToDb(db, "s", latest)).toBe(true);
        expect(repairLkgDurability(db, "s")).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
        db.exec("DROP TRIGGER fail_marker");
        const errors: unknown[] = [];
        const stop = startLkgDurabilityPoll(
            db,
            () => ["s"],
            (error) => errors.push(error),
        );
        try {
            await new Promise((resolve) => setTimeout(resolve, 1100));
            expect(errors).toEqual([]);
            expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: 1 });
            expect(getSlot("s")?.servedCaptureId).toBe(1);
            expect(loadPersistedLkgSlot(db, "s")?.jsonPrefix).toBe(latest.jsonPrefix);
            expect(loadPersistedLkgSlot(db, "s")?.captureSequence).toBe(17);
            const changes = db.prepare("SELECT total_changes() AS n").get();
            expect(repairLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: 1 });
            expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
        } finally {
            stop();
        }
    });

    test("an identical re-serve after a sibling's newer certificate takes a new id bound to the re-served bytes", () => {
        // Two connections share one context.db. The second commits a different
        // served request and certifies it. This connection then really serves its
        // older request again. The latest real serve wins the certificate, and the
        // certificate is proven by the bytes' digest, not by the id alone. This
        // replaces an earlier expectation that refused the re-serve; that
        // expectation assumed a certificate was identified by its id only.
        const root = createTestTempDirFromPath(join(tmpdir(), "served-marker-sibling-"));
        const db = fixture(join(root, "context.db"));
        const sibling = new Database(join(root, "context.db"));
        databases.push(sibling);
        try {
            const first = slot(recordServedCapture(db, "s", true));
            expect(captureSlot("s", first)).toBe(true);
            expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
            const replacement = {
                ...first,
                jsonPrefix: '[{"text":"sibling served bytes"}]',
                inputContentDigests: ["sibling-digest"],
                inputMoveDigests: ["b".repeat(64)],
                captureSequence: 9,
                servedCaptureId: recordServedCapture(sibling, "s", true),
            };
            expect(replacement.servedCaptureId).toBe(first.servedCaptureId! + 1);
            expect(saveLkgSlotToDb(sibling, "s", replacement)).toBe(true);
            expect(loadPersistedLkgSlot(sibling, "s")?.jsonPrefix).toBe(replacement.jsonPrefix);
            expect(readServedMarker(sibling, "s")?.servedDigest).toBe(
                lkgSlotCertificateDigest(replacement),
            );

            const reServed = {
                ...first,
                capturedAt: first.capturedAt + 1,
                captureSequence: 4,
            };
            const id = recordServedCapture(db, "s", true, reServed);
            expect(id).toBe(replacement.servedCaptureId! + 1);
            const certified = { ...reServed, servedCaptureId: id };
            expect(captureSlot("s", certified)).toBe(true);
            expect(saveLkgSlotToDb(db, "s", certified)).toBe(true);
            expect(loadPersistedLkgSlot(db, "s")?.jsonPrefix).toBe(first.jsonPrefix);
            expect(readServedMarker(db, "s")).toEqual({
                servedCaptureId: id!,
                fullCoverage: true,
                slotState: "captured",
                servedDigest: lkgSlotCertificateDigest(certified),
            });
            expect(checkLkgDurability(sibling, "s")).toEqual({
                durable: true,
                servedCaptureId: id!,
            });
            const changes = db.prepare("SELECT total_changes() AS n").get();
            expect(repairLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: id! });
            expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
            // The sibling's id is spent: its stale save cannot take the certificate back.
            expect(saveLkgSlotToDb(sibling, "s", replacement, { force: true })).toBe(false);
            expect(loadPersistedLkgSlot(db, "s")?.jsonPrefix).toBe(first.jsonPrefix);
        } finally {
            for (const connection of databases.splice(0)) connection.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("TS saves the same marker id and certifies partial anchor coverage as no_frontier", () => {
        const db = fixture();
        const input = [
            {
                info: { id: "u", role: "user", time: { created: 1 } },
                parts: [{ type: "text", text: "input" }],
            },
            {
                info: { id: "a", role: "assistant", time: { created: 2 } },
                parts: [{ type: "text", text: "reply" }],
            },
        ] as MessageLike[];
        let captured: LkgSlot | undefined;
        expect(
            captureLkgSlot({
                sessionId: "s",
                input: projectLkgEntry(input),
                output: input,
                modelKey: "m",
                providerKey: "p",
                onPrepared: (snapshot, full) => {
                    snapshot.servedCaptureId = recordServedCapture(db, "s", full);
                    captured = snapshot;
                },
            }),
        ).toBe(true);
        expect(saveLkgSlotToDb(db, "s", captured!)).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: false,
            reason: "no_frontier",
            slotState: "partial_capture",
        });
        expect(persistedMoveInputs(loadPersistedLkgSlot(db, "s")!)).toEqual(
            moveInputs("ts", input.slice(0, 1)),
        );
    });
});

describe("served certificates are bound to their bytes", () => {
    const certifiedPair = (db: Database) => {
        const first = slot(recordServedCapture(db, "s", true));
        expect(captureSlot("s", first)).toBe(true);
        expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: 1 });
        return first;
    };

    test("matching ids do not certify stored bytes or identity that differ from the bound digest", () => {
        const db = fixture();
        certifiedPair(db);
        // Same id, same slice hashes on the row, but a stored slice body changed.
        db.prepare("UPDATE lkg_slot_chunks SET body = ? WHERE session_id = 's'").run(
            '[{"text":"SERVED"}]',
        );
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
        const db2 = fixture();
        certifiedPair(db2);
        // Same id and bytes, but the certified input identity changed.
        db2.prepare("UPDATE lkg_slots SET input_content_digests = ? WHERE session_id = 's'").run(
            '["other"]',
        );
        expect(checkLkgDurability(db2, "s")).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
    });

    test("an unbound marker never certifies by id alone, and the next real save binds it", () => {
        const db = fixture();
        const first = certifiedPair(db);
        // Rows written before the digest column existed have a NULL digest.
        db.exec("UPDATE lkg_served_markers SET served_digest = NULL");
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
        const next = { ...first, capturedAt: first.capturedAt + 1, captureSequence: 4 };
        const id = recordServedCapture(db, "s", true, next);
        expect(saveLkgSlotToDb(db, "s", { ...next, servedCaptureId: id })).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: id! });
        expect(readServedMarker(db, "s")?.servedDigest).toBe(lkgSlotCertificateDigest(next));
    });

    test("the digest binding and the slot bytes commit in one transaction", () => {
        const db = fixture();
        const first = certifiedPair(db);
        const boundBefore = readServedMarker(db, "s")?.servedDigest;
        const next = {
            ...first,
            jsonPrefix: '[{"text":"next served bytes"}]',
            captureSequence: 4,
        };
        next.servedCaptureId = recordServedCapture(db, "s", true, next);
        db.exec(`CREATE TRIGGER fail_bind BEFORE UPDATE OF served_digest ON lkg_served_markers
            WHEN NEW.served_digest IS NOT NULL
            BEGIN SELECT RAISE(ABORT, 'injected bind failure'); END`);
        expect(saveLkgSlotToDb(db, "s", next)).toBe(false);
        // The failed transaction wrote neither the new slot bytes nor the digest:
        // the first request's bytes remain, and the new id stays unbound.
        expect(loadPersistedLkgSlot(db, "s")?.jsonPrefix).toBe(first.jsonPrefix);
        expect(readServedMarker(db, "s")).toEqual({
            servedCaptureId: next.servedCaptureId!,
            fullCoverage: true,
            slotState: "captured",
            servedDigest: null,
        });
        expect(boundBefore).toBe(lkgSlotCertificateDigest(first));
        db.exec("DROP TRIGGER fail_bind");
        expect(saveLkgSlotToDb(db, "s", next)).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: true,
            servedCaptureId: next.servedCaptureId!,
        });
    });

    test("a stale writer holding a restarted id cannot claim bytes another writer bound to it", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "served-marker-restart-"));
        const db = fixture(join(root, "context.db"));
        const sibling = new Database(join(root, "context.db"));
        databases.push(sibling);
        try {
            const stale = slot(recordServedCapture(db, "s", true));
            // Session cleanup removes the marker row, so the counter restarts.
            db.exec("DELETE FROM lkg_served_markers");
            const fresh = {
                ...stale,
                jsonPrefix: '[{"text":"recreated session"}]',
                servedCaptureId: recordServedCapture(sibling, "s", true),
            };
            expect(fresh.servedCaptureId).toBe(stale.servedCaptureId);
            expect(saveLkgSlotToDb(sibling, "s", fresh)).toBe(true);
            expect(saveLkgSlotToDb(db, "s", stale)).toBe(false);
            expect(loadPersistedLkgSlot(db, "s")?.jsonPrefix).toBe(fresh.jsonPrefix);
            expect(readServedMarker(db, "s")?.servedDigest).toBe(lkgSlotCertificateDigest(fresh));
            expect(checkLkgDurability(db, "s")).toEqual({
                durable: true,
                servedCaptureId: fresh.servedCaptureId!,
            });
        } finally {
            for (const connection of databases.splice(0)) connection.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("an identical re-serve never reuses an id another writer bound to different bytes", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "served-marker-reuse-bound-"));
        const db = fixture(join(root, "context.db"));
        const sibling = new Database(join(root, "context.db"));
        databases.push(sibling);
        try {
            const served = slot(recordServedCapture(db, "s", true));
            expect(captureSlot("s", served)).toBe(true);
            expect(saveLkgSlotToDb(db, "s", served)).toBe(true);
            // Session cleanup removes the marker row; another writer then takes
            // the same restarted id for its own bytes and binds it.
            db.exec("DELETE FROM lkg_served_markers");
            const other = {
                ...served,
                jsonPrefix: '[{"text":"recreated session"}]',
                servedCaptureId: recordServedCapture(sibling, "s", true),
            };
            expect(other.servedCaptureId).toBe(served.servedCaptureId);
            expect(saveLkgSlotToDb(sibling, "s", other)).toBe(true);
            // The first connection serves its original request again. Its in-memory id
            // equals the marker's id, but the marker is bound to the other bytes.
            const again = { ...served, capturedAt: served.capturedAt + 1, captureSequence: 4 };
            const id = recordServedCapture(db, "s", true, again);
            expect(id).toBe(other.servedCaptureId! + 1);
            expect(saveLkgSlotToDb(db, "s", { ...again, servedCaptureId: id })).toBe(true);
            expect(checkLkgDurability(sibling, "s")).toEqual({
                durable: true,
                servedCaptureId: id!,
            });
        } finally {
            for (const connection of databases.splice(0)) connection.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("an older deferred save racing a newer serve by the same process leaves the sibling's bytes", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "served-marker-race-"));
        const db = fixture(join(root, "context.db"));
        const sibling = new Database(join(root, "context.db"));
        databases.push(sibling);
        try {
            const siblingSlot = {
                ...slot(),
                jsonPrefix: '[{"text":"sibling served bytes"}]',
            };
            siblingSlot.servedCaptureId = recordServedCapture(sibling, "s", true);
            expect(saveLkgSlotToDb(sibling, "s", siblingSlot)).toBe(true);
            // This process serves an older request and then a newer one before the
            // older request's deferred save runs.
            const older = slot(recordServedCapture(db, "s", true));
            const newer = {
                ...slot(),
                jsonPrefix: '[{"text":"newer served bytes"}]',
                captureSequence: 5,
            };
            newer.servedCaptureId = recordServedCapture(db, "s", true, newer);
            expect(saveLkgSlotToDb(db, "s", older)).toBe(false);
            expect(loadPersistedLkgSlot(db, "s")?.jsonPrefix).toBe(siblingSlot.jsonPrefix);
            expect(readServedMarker(db, "s")).toMatchObject({
                servedCaptureId: newer.servedCaptureId!,
                servedDigest: null,
            });
            expect(saveLkgSlotToDb(db, "s", newer)).toBe(true);
            expect(checkLkgDurability(sibling, "s")).toEqual({
                durable: true,
                servedCaptureId: newer.servedCaptureId!,
            });
        } finally {
            for (const connection of databases.splice(0)) connection.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the drained repair never rewrites another writer's certified pair or certifies an unreturned capture", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "served-marker-repair-"));
        const db = fixture(join(root, "context.db"));
        const sibling = new Database(join(root, "context.db"));
        databases.push(sibling);
        try {
            // This process's latest capture has no id (its marker write failed).
            const unmarked = { ...slot(), jsonPrefix: '[{"text":"unmarked live bytes"}]' };
            expect(captureSlot("s", unmarked)).toBe(true);
            const siblingSlot = slot(recordServedCapture(sibling, "s", true));
            expect(saveLkgSlotToDb(sibling, "s", siblingSlot)).toBe(true);
            const certified = { durable: true, servedCaptureId: siblingSlot.servedCaptureId! };
            expect(checkLkgDurability(db, "s")).toEqual(certified);
            const changes = db.prepare("SELECT total_changes() AS n").get();
            expect(repairLkgDurability(db, "s")).toEqual({
                durable: true,
                servedCaptureId: null,
                certified: false,
            });
            expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
            expect(checkLkgDurability(db, "s")).toEqual(certified);
            expect(loadPersistedLkgSlot(db, "s")?.jsonPrefix).toBe(siblingSlot.jsonPrefix);

            // A capture whose pass has not returned it is never certified by a poll.
            sibling.exec("DELETE FROM lkg_slots; DELETE FROM lkg_slot_chunks");
            expect(captureSlot("s", { ...unmarked, servedCaptureWithheld: true })).toBe(true);
            expect(repairLkgDurability(db, "s")).toEqual({
                durable: true,
                servedCaptureId: null,
                certified: false,
            });
            expect(loadPersistedLkgSlot(db, "s")).toBeUndefined();
            expect(readServedMarker(db, "s")?.servedCaptureId).toBe(siblingSlot.servedCaptureId);
        } finally {
            for (const connection of databases.splice(0)) connection.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a move that ships the LKG rows verbatim, without the drained repair, carries exactly the source's certification", () => {
        // The agent-move source half acquires its draining fence and freezes it in
        // the same call, then copies lkg_served_markers, lkg_slots and
        // lkg_slot_chunks row by row. No drained repair can run in between. The
        // certificate must therefore prove itself from the shipped rows alone.
        const ship = (source: Database) => {
            const destination = fixture();
            for (const table of ["lkg_served_markers", "lkg_slots", "lkg_slot_chunks"]) {
                for (const row of source
                    .prepare(`SELECT * FROM ${table} WHERE session_id = 's'`)
                    .all() as Record<string, unknown>[]) {
                    const columns = Object.keys(row);
                    destination
                        .prepare(
                            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
                        )
                        .run(...(columns.map((column) => row[column]) as never[]));
                }
            }
            return checkLkgDurability(destination, "s");
        };
        const certified = fixture();
        const first = slot(recordServedCapture(certified, "s", true));
        expect(saveLkgSlotToDb(certified, "s", first)).toBe(true);
        expect(ship(certified)).toEqual({ durable: true, servedCaptureId: first.servedCaptureId! });

        // The latest serve's save failed: the shipped pair is uncertified, so the
        // importer rebuilds instead of trusting the older bytes.
        const unsaved = fixture();
        expect(saveLkgSlotToDb(unsaved, "s", slot(recordServedCapture(unsaved, "s", true)))).toBe(
            true,
        );
        recordServedCapture(unsaved, "s", true);
        expect(ship(unsaved)).toEqual({ durable: true, servedCaptureId: null, certified: false });

        // Different bytes stored under the certified id are not certified either.
        const replaced = fixture();
        expect(saveLkgSlotToDb(replaced, "s", slot(recordServedCapture(replaced, "s", true)))).toBe(
            true,
        );
        replaced
            .prepare("UPDATE lkg_slots SET last_input_message_id = 'other' WHERE session_id = 's'")
            .run();
        expect(ship(replaced)).toEqual({ durable: true, servedCaptureId: null, certified: false });
    });

    test("a failed pass restores storage only where it still owns the certificate or the bytes", () => {
        const db = fixture();
        const previous = slot(recordServedCapture(db, "s", true));
        expect(saveLkgSlotToDb(db, "s", previous)).toBe(true);
        const failedPrefix = '[{"text":"failed pass bytes"}]';
        // The marker still holds this pass's own id, so the restore may rewrite and
        // re-certify storage as it did before the binding existed.
        expect(failedPassRestoreMode(db, "s", [previous.servedCaptureId], failedPrefix)).toBe(
            "certify",
        );
        // Another writer allocated an id and saved its own slot: the failed pass must
        // leave both that slot and the marker unchanged.
        const siblingSlot = {
            ...slot(),
            jsonPrefix: '[{"text":"sibling served bytes"}]',
            servedCaptureId: recordServedCapture(db, "s", true),
        };
        expect(saveLkgSlotToDb(db, "s", siblingSlot)).toBe(true);
        expect(failedPassRestoreMode(db, "s", [previous.servedCaptureId], failedPrefix)).toBe(
            "leave",
        );
        // Another writer allocated an id but has not saved, so storage still holds the
        // failed pass's bytes: replace them, but without a certificate.
        expect(saveLkgSlotToDb(db, "s", { ...slot(), jsonPrefix: failedPrefix })).toBe(true);
        recordServedCapture(db, "s", true);
        expect(failedPassRestoreMode(db, "s", [previous.servedCaptureId], failedPrefix)).toBe(
            "uncertified",
        );
    });
});

describe("portable move input projection", () => {
    test("pins canonical hex and ordered-line digests independent of object key order", () => {
        const first = { info: { role: "user", id: "z" }, parts: [{ text: "hello", type: "text" }] };
        const second = {
            parts: [{ type: "text", text: "hello" }],
            info: { id: "z", role: "user" },
        };
        // Independent known canonical bytes, rather than reproducing the projection.
        const expected = "366a58936ed9f6c52f3c72ad304d525c373f9af4bf4a3a9126a7318a98fb5f5a";
        expect(moveInputs("ts", [first]).digest).toBe(expected);
        expect(moveInputs("ts", [first])).toEqual(moveInputs("rust", [second]));
        expect(summarizeMoveInputs([], [])).toEqual({
            count: 0,
            digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        });
        expect(moveInputs("ts", [first]).count).toBe(1);
        expect(() => summarizeMoveInputs(["bad\nid"], ["a".repeat(64)])).toThrow();
        expect(() => summarizeMoveInputs(["id"], ["A".repeat(64)])).toThrow();
    });

    test("normalized synth-user ids stay intact and same-id edits change the frontier", () => {
        const messages = [
            {
                info: { id: "synth-user-tool-1", role: "user" },
                parts: [{ type: "text", text: "alpha" }],
            },
        ] as MessageLike[];
        const original = moveInputs("ts", messages);
        expect(moveInputs("rust", messages)).toEqual(original);
        messages[0]!.parts[0]!.text = "bravo";
        expect(moveInputs("ts", messages)).not.toEqual(original);
        expect(() => moveMessageDigestFromFields([])).toThrow();
    });
});
