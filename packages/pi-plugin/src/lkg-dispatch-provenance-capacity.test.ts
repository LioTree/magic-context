import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	isPreparedUndispatchedLkgSlot,
	saveLkgSlotToDb,
} from "@magic-context/core/hooks/magic-context/lkg-persist";
import {
	checkLkgDurability,
	recordServedCapture,
	repairLkgDurability,
} from "@magic-context/core/hooks/magic-context/lkg-served-marker";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { clearPiLkgSessionState, createPiLkgCoordinator } from "./pi-lkg";
import { createTestDb, userMessage } from "./test-utils.test";

const sessions = ["capacity-pending", "capacity-noise"];
afterEach(() => {
	for (const sessionId of sessions) clearPiLkgSessionState(sessionId);
	resetLkgSlotsForTest();
});

test("pending dispatch cannot be certified by repair after prepared receipt eviction", () => {
	const { dir, cleanup } = createTestTempDir("lkg-dispatch-capacity-");
	const path = join(dir, "fixture.db");
	const db = createTestDb(path);
	let reader: Database | undefined;
	try {
		const sessionId = sessions[0];
		const coordinator = createPiLkgCoordinator(db);
		const raw = [userMessage("original input")];
		const snapshot = coordinator.beginPass({
			sessionId,
			messages: raw,
			entryIds: ["entry-1"],
			modelKey: null,
			providerKey: null,
		});
		coordinator.captureAppliedPass({
			snapshot,
			outputMessages: [userMessage("never dispatched")],
			outputEntryIds: ["entry-1"],
			cacheBusting: false,
			publishServedNumbers: () => {},
		});
		const pending = getSlot(sessionId);
		if (!pending) throw new Error("pending capture was not installed");
		expect(
			isPreparedUndispatchedLkgSlot(db, sessionId, pending.servedCaptureId),
		).toBe(true);
		expect(checkLkgDurability(db, sessionId)).toEqual({
			durable: true,
			servedCaptureId: null,
			certified: false,
		});
		// One other session can exhaust the per-capture receipt cache while this
		// database handle still remembers allocating the first session's pending
		// marker, and its never-dispatched request is still in memory.
		for (let index = 0; index < 1_000; index++) {
			const servedCaptureId = recordServedCapture(db, sessions[1], true);
			expect(servedCaptureId).toBeDefined();
			expect(
				saveLkgSlotToDb(
					db,
					sessions[1],
					{ ...pending, servedCaptureId },
					{ deferCertificate: true },
				),
			).toBe(true);
		}
		const repaired = repairLkgDurability(db, sessionId);
		db.close();
		clearPiLkgSessionState(sessionId);
		resetLkgSlotsForTest();
		reader = new Database(path);
		const cold = createPiLkgCoordinator(reader);
		const loaded = getSlot(sessionId);
		const replay = cold.replay(
			cold.beginPass({
				sessionId,
				messages: [...raw, userMessage("new input", 2)],
				entryIds: ["entry-1", "entry-2"],
				modelKey: null,
				providerKey: null,
			}),
		);
		expect({
			repaired,
			unconfirmed: loaded?.dispatchUnconfirmed === true,
			replay,
		}).toEqual({
			repaired: { durable: true, servedCaptureId: null, certified: false },
			unconfirmed: true,
			replay: { ok: false, reason: "lkg_dispatch_unconfirmed" },
		});
	} finally {
		if (reader) reader.close();
		else db.close();
		cleanup();
	}
});
