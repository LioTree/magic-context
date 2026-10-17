import { expect, test } from "bun:test";
import { closeDatabase, getDatabasePath, openDatabase } from "../features/magic-context/storage-db";
import { createTagger } from "../features/magic-context/tagger";
import {
    lkgSlotCertificateDigest,
    loadPersistedLkgSlot,
    saveLkgSlotToDb,
} from "../hooks/magic-context/lkg-persist";
import {
    checkLkgDurability,
    readServedMarker,
    recordServedCapture,
} from "../hooks/magic-context/lkg-served-marker";
import { dropSlot, getSlot } from "../hooks/magic-context/lkg-slot";
import { createTransform } from "../hooks/magic-context/transform";
import { Database } from "../shared/sqlite";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("OpenCode 1: a pass that throws after capturing leaves another connection's certified slot and marker untouched", async () => {
    const sessionId = `unreturned-oc1-${Date.now()}`;
    const db = openDatabase();
    if (!db) throw new Error("throwaway database unavailable");
    const sibling = new Database(getDatabasePath(db)!);
    let failAfterCapture = false;
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => "defer" },
        contextUsageMap: new Map([
            [sessionId, { usage: { percentage: 10, inputTokens: 10_000 }, updatedAt: Date.now() }],
        ]),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        protectedTokens: 1,
        protectedTags: 0,
        directory: process.cwd(),
        // The last step of a pass, after its capture: throwing here means the pass
        // never returns the request it captured.
        onPostprocess: () => {
            if (failAfterCapture) throw new Error("injected failure after capture");
        },
    });
    const turns = [
        {
            info: { id: "start", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "start" }],
        },
    ];
    const pass = async () => {
        const output = { messages: structuredClone(turns) };
        await (transform as (input: unknown, output: unknown) => Promise<void>)({}, output);
    };
    try {
        await pass();
        await settle();
        const first = checkLkgDurability(db, sessionId);
        expect(first.durable && typeof first.servedCaptureId).toBe("number");

        // Another connection serves and certifies a different request.
        const siblingSlot = {
            ...loadPersistedLkgSlot(sibling, sessionId)!,
            jsonPrefix: '[{"text":"sibling served bytes"}]',
            servedCaptureId: recordServedCapture(sibling, sessionId, true),
        };
        expect(saveLkgSlotToDb(sibling, sessionId, siblingSlot, { force: true })).toBe(true);
        const siblingMarker = readServedMarker(sibling, sessionId);
        expect(siblingMarker?.servedDigest).toBe(lkgSlotCertificateDigest(siblingSlot));

        failAfterCapture = true;
        turns.push({
            info: { id: "next", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "next turn" }],
        });
        await expect(pass()).rejects.toThrow("injected failure after capture");
        // The failed pass did capture its request in memory, but withheld its certificate.
        expect(getSlot(sessionId)?.servedCaptureWithheld).toBe(true);
        await settle();
        await settle();
        expect(readServedMarker(db, sessionId)).toEqual(siblingMarker);
        expect(loadPersistedLkgSlot(db, sessionId)?.jsonPrefix).toBe(siblingSlot.jsonPrefix);
        expect(checkLkgDurability(db, sessionId)).toEqual({
            durable: true,
            servedCaptureId: siblingSlot.servedCaptureId!,
        });
    } finally {
        dropSlot(sessionId);
        sibling.close();
        closeDatabase();
    }
});
