import { afterEach, expect, test } from "bun:test";
import {
	createDbLkgPersistence,
	loadPersistedLkgSlot,
} from "@magic-context/core/hooks/magic-context/lkg-persist";
import { checkLkgDurability } from "@magic-context/core/hooks/magic-context/lkg-served-marker";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createPiLkgCoordinator } from "./pi-lkg";
import { publishPiServedNumbers } from "./pi-served-identities";
import { createTestDb, userMessage } from "./test-utils.test";

// Pi publishes a request, with its served tag numbers, before the context handler
// returns it. The certificate that names it as the last request sent is bound
// only when the handler hands the request to Pi (certifyDispatched).

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
	resetLkgSlotsForTest();
	for (const db of databases.splice(0)) db.close();
});

function publicationFixture() {
	const db = createTestDb();
	databases.push(db);
	const sessionId = `pi-dispatch-certificate-${databases.length}`;
	const raw = [userMessage("input", 1)];
	const coordinator = createPiLkgCoordinator(db, () => {
		throw new Error("managed publication must not defer");
	});
	const begin = () =>
		coordinator.beginPass({
			sessionId,
			messages: raw,
			entryIds: ["entry-1"],
			modelKey: null,
			providerKey: null,
		});
	const publish = (
		snapshot: ReturnType<typeof begin>,
		text: string,
		number: number,
	) =>
		coordinator.captureAppliedPass({
			snapshot,
			outputMessages: [userMessage(text, 1)],
			outputEntryIds: ["entry-1"],
			cacheBusting: false,
			publishServedNumbers: () =>
				publishPiServedNumbers(db, sessionId, [number]),
		});
	return { db, sessionId, coordinator, begin, publish };
}

test("a published Pi request is certified only once its pass is dispatched", () => {
	const { db, sessionId, coordinator, begin, publish } = publicationFixture();
	const snapshot = begin();
	publish(snapshot, "§1§ dispatched", 1);
	expect(loadPersistedLkgSlot(db, sessionId)?.jsonPrefix).toContain(
		"§1§ dispatched",
	);
	expect(checkLkgDurability(db, sessionId)).toEqual({
		durable: true,
		servedCaptureId: null,
		certified: false,
	});
	coordinator.certifyDispatched(snapshot);
	expect(checkLkgDurability(db, sessionId)).toEqual({
		durable: true,
		servedCaptureId: 1,
	});
	// After a restart the dispatched request is the one replay may serve.
	expect(createDbLkgPersistence(db).load(sessionId)?.jsonPrefix).toContain(
		"§1§ dispatched",
	);
});

test("a later pass's dispatch never certifies an earlier pass's undispatched publication", () => {
	const { db, sessionId, coordinator, begin, publish } = publicationFixture();
	const first = begin();
	publish(first, "§1§ dispatched", 1);
	coordinator.certifyDispatched(first);
	// The next pass publishes, then its handler refuses before returning the
	// request, so it is never dispatched.
	const refused = begin();
	publish(refused, "§2§ never dispatched", 2);
	// A later pass that captures nothing (for example a side turn) is dispatched.
	coordinator.certifyDispatched(begin());
	expect(checkLkgDurability(db, sessionId)).toEqual({
		durable: true,
		servedCaptureId: null,
		certified: false,
	});
	// The refused request stays durable, but a restarted process does not hydrate it.
	expect(loadPersistedLkgSlot(db, sessionId)?.jsonPrefix).toContain(
		"§2§ never dispatched",
	);
	expect(createDbLkgPersistence(db).load(sessionId)).toBeUndefined();
});
