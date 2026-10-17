import { afterEach, expect, spyOn, test } from "bun:test";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	LkgEntryDigestCache,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as move from "@magic-context/core/hooks/magic-context/move-inputs";
import { Database } from "@magic-context/core/shared/sqlite";
import { clearPiLkgSessionState, createPiLkgCoordinator } from "./pi-lkg";

afterEach(() => resetLkgSlotsForTest());

test("LKG memo review: entry cache stays within session, total and session-count bounds", () => {
	const cache = new LkgEntryDigestCache({
		sessionMaxBytes: 65536,
		totalMaxBytes: 131072,
		maxSessions: 4,
	});
	for (let i = 0; i < 40; i++) {
		cache
			.digests(
				`s-${i}`,
				Array.from({ length: 10 }, (_, j) => ({
					info: { id: `m-${j}`, role: "user" } as never,
					parts: [{ type: "text", text: "x".repeat(4096) }],
				})),
				move.moveMessageDigestFromFields,
			)
			.moveDigests.forEach((digest) => {
				digest?.();
			});
		const stats = cache.stats();
		expect(stats.totalBytes).toBeLessThanOrEqual(131072);
		expect(stats.sessions.length).toBeLessThanOrEqual(4);
		expect(stats.sessions.every((session) => session.bytes <= 65536)).toBe(
			true,
		);
	}
	cache.clear();
	expect(cache.stats()).toEqual({ totalBytes: 0, sessions: [] });
});

test("LKG memo review: Pi cleanup discards portable reuse proof for compacted large inputs", () => {
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	const coordinator = createPiLkgCoordinator(db, (capture) => capture());
	const sessionId = "pi-memo-heap";
	const messages = [
		{ role: "user", content: "x".repeat(2 * 1024 * 1024), timestamp: 1 },
	];
	const capture = () =>
		coordinator.captureAppliedPass({
			snapshot: coordinator.beginPass({
				sessionId,
				messages,
				entryIds: ["u"],
				modelKey: "test/model",
				providerKey: "test",
			}),
			outputMessages: [{ role: "user", content: "compact" }],
			outputEntryIds: ["u"],
			cacheBusting: false,
		});
	const hash = spyOn(move, "moveMessageDigestFromFields");
	try {
		capture();
		expect(hash).toHaveBeenCalledTimes(1);
		hash.mockClear();
		capture();
		expect(hash).toHaveBeenCalledTimes(0);
		clearPiLkgSessionState(sessionId);
		capture();
		expect(hash).toHaveBeenCalledTimes(1);
	} finally {
		hash.mockRestore();
		clearPiLkgSessionState(sessionId);
		db.close();
	}
});
