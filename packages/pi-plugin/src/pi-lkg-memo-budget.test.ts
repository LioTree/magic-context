import { afterEach, expect, spyOn, test } from "bun:test";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getSlot,
	lkgContentDigestFromFields,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as move from "@magic-context/core/hooks/magic-context/move-inputs";
import { Database } from "@magic-context/core/shared/sqlite";
import {
	clearPiLkgSessionState,
	createPiLkgCoordinator,
	piLkgMemoForTest,
} from "./pi-lkg";

const databases: Database[] = [];
const sessions = new Set<string>();
afterEach(() => {
	for (const id of sessions) clearPiLkgSessionState(id);
	sessions.clear();
	piLkgMemoForTest.setLimits();
	resetLkgSlotsForTest();
	for (const db of databases.splice(0)) db.close();
});

function harness() {
	piLkgMemoForTest.setLimits();
	const db = new Database(":memory:");
	databases.push(db);
	initializeDatabase(db);
	runMigrations(db);
	const coordinator = createPiLkgCoordinator(db, (capture) => capture());
	const messages = [
		{ role: "user", content: "pristine α".repeat(100), timestamp: 1 },
	];
	function capture(sessionId: string) {
		sessions.add(sessionId);
		const snapshot = coordinator.beginPass({
			sessionId,
			messages: structuredClone(messages),
			entryIds: ["u"],
			modelKey: "test/model",
			providerKey: "test",
		});
		const output = coordinator.captureAppliedPass({
			snapshot,
			outputMessages: messages,
			outputEntryIds: ["u"],
			cacheBusting: false,
		});
		const slot = getSlot(sessionId);
		expect(output?.json).toBe(JSON.stringify(messages));
		expect(slot?.jsonPrefix).toBe(JSON.stringify(messages));
		expect(slot?.inputContentDigests).toEqual(
			snapshot.inputs.map((input) => lkgContentDigestFromFields(input.fields)),
		);
		return { output, slot, snapshot };
	}
	return { coordinator, capture, messages };
}

test("Pi over-budget memo falls back to byte-identical cold hashing", () => {
	const h = harness();
	const initial = h.capture("budget-a");
	const bytes = piLkgMemoForTest.stats().totalBytes;
	expect(bytes).toBeGreaterThan(0);
	piLkgMemoForTest.setLimits({
		sessionMaxBytes: bytes - 1,
		totalMaxBytes: bytes * 2,
		maxSessions: 16,
	});
	const hash = spyOn(move, "moveMessageDigestFromFields");
	try {
		for (let pass = 0; pass < 3; pass++) {
			hash.mockClear();
			const cold = h.capture("budget-a");
			expect(hash).toHaveBeenCalledTimes(1);
			expect(cold.output).toEqual(initial.output);
			expect(cold.slot?.inputMoveDigests).toEqual(
				initial.slot?.inputMoveDigests,
			);
			expect(piLkgMemoForTest.stats()).toEqual({ totalBytes: 0, sessions: [] });
			const replay = h.coordinator.replay(cold.snapshot);
			expect(replay).toMatchObject({ ok: true, messages: h.messages });
		}
	} finally {
		hash.mockRestore();
	}
});

test("Pi total memo budget evicts the least recently used session", () => {
	const h = harness();
	h.capture("budget-a");
	const bytes = piLkgMemoForTest.stats().totalBytes;
	piLkgMemoForTest.setLimits({
		sessionMaxBytes: bytes,
		totalMaxBytes: bytes * 2,
		maxSessions: 16,
	});
	h.capture("budget-a");
	h.capture("budget-b");
	h.capture("budget-a");
	h.capture("budget-c");
	expect(
		piLkgMemoForTest.stats().sessions.map((entry) => entry.sessionId),
	).toEqual(["budget-a", "budget-c"]);
	expect(piLkgMemoForTest.stats().totalBytes).toBeLessThanOrEqual(bytes * 2);
	const hash = spyOn(move, "moveMessageDigestFromFields");
	try {
		h.capture("budget-b");
		expect(hash).toHaveBeenCalledTimes(1);
	} finally {
		hash.mockRestore();
	}
});

test("Pi memo session-count cap and teardown release accounted bytes", () => {
	const h = harness();
	piLkgMemoForTest.setLimits({
		sessionMaxBytes: 128 * 1024 * 1024,
		totalMaxBytes: 256 * 1024 * 1024,
		maxSessions: 2,
	});
	for (const id of ["budget-a", "budget-b", "budget-c"]) h.capture(id);
	const before = piLkgMemoForTest.stats();
	expect(before.sessions.map((entry) => entry.sessionId)).toEqual([
		"budget-b",
		"budget-c",
	]);
	clearPiLkgSessionState("budget-b");
	clearPiLkgSessionState("budget-b");
	expect(piLkgMemoForTest.stats().totalBytes).toBe(before.sessions[1].bytes);
	clearPiLkgSessionState("budget-c");
	expect(piLkgMemoForTest.stats()).toEqual({ totalBytes: 0, sessions: [] });
});
