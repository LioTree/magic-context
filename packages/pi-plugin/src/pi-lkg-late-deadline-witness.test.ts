import { afterEach, expect, test } from "bun:test";
import { loadPersistedLkgSlot } from "@magic-context/core/hooks/magic-context/lkg-persist";
import { checkLkgDurability } from "@magic-context/core/hooks/magic-context/lkg-served-marker";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createPiLkgCoordinator } from "./pi-lkg";
import { publishPiServedNumbers } from "./pi-served-identities";
import { createTestDb, userMessage } from "./test-utils.test";

// Witnesses for a Pi publication that commits and then misses its outcome
// deadline. Pi saves the request, its served tag numbers and its served-capture
// certificate in one transaction before the context handler returns. When the
// deadline check right after that commit throws, the handler refuses the turn,
// so the provider never receives the request, yet storage keeps it as the
// session's last good request and certifies it. These tests state the intended
// behavior and fail today.

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
	resetLkgSlotsForTest();
	for (const db of databases.splice(0)) db.close();
});

function lateDeadlineFixture() {
	const db = createTestDb();
	databases.push(db);
	const sessionId = `pi-late-deadline-${databases.length}`;
	const raw = [userMessage("input", 1)];
	const pass = (
		coordinator: ReturnType<typeof createPiLkgCoordinator>,
		text: string,
		number: number,
		expireAfterCommit: boolean,
	) => {
		let committed = false;
		return coordinator.captureAppliedPass({
			snapshot: coordinator.beginPass({
				sessionId,
				messages: raw,
				entryIds: ["entry-1"],
				modelKey: null,
				providerKey: null,
			}),
			outputMessages: [userMessage(text, 1)],
			outputEntryIds: ["entry-1"],
			cacheBusting: false,
			// Runs inside the publication transaction, so the request has committed
			// by the time the deadline check after it runs.
			publishServedNumbers: () => {
				publishPiServedNumbers(db, sessionId, [number]);
				committed = true;
			},
			assertCurrentPass: () => {
				if (expireAfterCommit && committed)
					throw new Error("pass crossed its outcome deadline");
			},
		});
	};
	const coordinator = createPiLkgCoordinator(db, () => {
		throw new Error("managed publication must not defer");
	});
	// A served pass: the provider received these bytes.
	expect(
		JSON.stringify(pass(coordinator, "§1§ dispatched", 1, false)),
	).toContain("§1§ dispatched");
	// The next pass commits its request, then misses the deadline and refuses.
	expect(() => pass(coordinator, "§2§ never dispatched", 2, true)).toThrow(
		"pass crossed its outcome deadline",
	);
	return { db, sessionId, raw };
}

test("a Pi pass refused after its publication commit leaves no certificate on the undispatched request", () => {
	const { db, sessionId } = lateDeadlineFixture();
	const durability = checkLkgDurability(db, sessionId);
	const stored = loadPersistedLkgSlot(db, sessionId)?.jsonPrefix ?? "";
	// Either the dispatched request is still the stored one, or nothing is certified.
	const certifiesUndispatched =
		durability.durable &&
		durability.servedCaptureId !== null &&
		stored.includes("§2§ never dispatched");
	expect(certifiesUndispatched).toBe(false);
});

test("after a restart, Pi never replays a request whose pass was refused at the deadline", () => {
	const { db, sessionId, raw } = lateDeadlineFixture();
	// A fresh process: no in-memory slot, so replay reads storage.
	resetLkgSlotsForTest();
	const restarted = createPiLkgCoordinator(db);
	const replay = restarted.replay(
		restarted.beginPass({
			sessionId,
			messages: raw,
			entryIds: ["entry-1"],
			modelKey: null,
			providerKey: null,
		}),
	);
	const replayed = replay.ok ? JSON.stringify(replay.messages) : "";
	expect(replayed).not.toContain("§2§ never dispatched");
});
