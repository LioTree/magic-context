import { afterEach, expect, test } from "bun:test";
import {
	createDbLkgPersistence,
	loadPersistedLkgSlot,
} from "@magic-context/core/hooks/magic-context/lkg-persist";
import {
	checkLkgDurability,
	repairLkgDurability,
} from "@magic-context/core/hooks/magic-context/lkg-served-marker";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createPiLkgCoordinator } from "./pi-lkg";
import { publishPiServedNumbers } from "./pi-served-identities";
import { createTestDb, userMessage } from "./test-utils.test";

// Pi publishes a request, with its served tag numbers, before the context handler
// returns it. The certificate that names it as the last request sent is bound
// only when the handler hands the request to Pi (certifyDispatched). A handler
// that throws instead records the refusal (refuseDispatch). A process that stops
// in between leaves the request durable with an unconfirmed dispatch.

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
	resetLkgSlotsForTest();
	for (const db of databases.splice(0)) db.close();
});

const uncertified = { durable: true, servedCaptureId: null, certified: false };

function publicationFixture() {
	const db = createTestDb();
	databases.push(db);
	const sessionId = `pi-dispatch-certificate-${databases.length}`;
	const newCoordinator = () =>
		createPiLkgCoordinator(db, () => {
			throw new Error("managed publication must not defer");
		});
	const coordinator = newCoordinator();
	const raw = [userMessage("input", 1)];
	const begin = (
		via = coordinator,
		messages: unknown[] = raw,
		entryIds = ["entry-1"],
	) =>
		via.beginPass({
			sessionId,
			messages,
			entryIds,
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
	// A fresh process on the same database: nothing in memory.
	const restart = () => {
		resetLkgSlotsForTest();
		return newCoordinator();
	};
	const grown = [userMessage("input", 1), userMessage("a newer turn", 2)];
	const grownIds = ["entry-1", "entry-2"];
	return {
		db,
		sessionId,
		coordinator,
		begin,
		publish,
		restart,
		grown,
		grownIds,
	};
}

test("a published Pi request is certified only once its pass is dispatched", () => {
	const { db, sessionId, coordinator, begin, publish } = publicationFixture();
	const snapshot = begin();
	publish(snapshot, "§1§ dispatched", 1);
	expect(loadPersistedLkgSlot(db, sessionId)?.jsonPrefix).toContain(
		"§1§ dispatched",
	);
	expect(checkLkgDurability(db, sessionId)).toEqual(uncertified);
	// Before dispatch, not even the connection that saved it may certify it.
	expect(repairLkgDurability(db, sessionId)).toEqual(uncertified);
	coordinator.certifyDispatched(snapshot);
	expect(checkLkgDurability(db, sessionId)).toEqual({
		durable: true,
		servedCaptureId: 1,
	});
	// After a restart the dispatched request is the one replay may serve.
	const loaded = createDbLkgPersistence(db).load(sessionId);
	expect(loaded?.jsonPrefix).toContain("§1§ dispatched");
	expect(loaded?.dispatchUnconfirmed).toBeUndefined();
});

test("a publication the handler refused is durable, uncertified and not hydrated after a restart", () => {
	const { db, sessionId, coordinator, begin, publish, restart } =
		publicationFixture();
	const first = begin();
	publish(first, "§1§ dispatched", 1);
	coordinator.certifyDispatched(first);
	// The next pass publishes, then its handler throws before returning the request.
	const refused = begin();
	publish(refused, "§2§ never dispatched", 2);
	coordinator.refuseDispatch(refused);
	expect(checkLkgDurability(db, sessionId)).toEqual(uncertified);
	expect(loadPersistedLkgSlot(db, sessionId)?.jsonPrefix).toContain(
		"§2§ never dispatched",
	);
	expect(createDbLkgPersistence(db).load(sessionId)).toBeUndefined();
	const restarted = restart();
	expect(restarted.replay(begin(restarted))).toMatchObject({ ok: false });
});

test("a later pass's dispatch never certifies an earlier pass's undispatched publication", () => {
	const { db, sessionId, coordinator, begin, publish } = publicationFixture();
	const first = begin();
	publish(first, "§1§ dispatched", 1);
	coordinator.certifyDispatched(first);
	const undispatched = begin();
	publish(undispatched, "§2§ never dispatched", 2);
	// A later pass that captures nothing (for example a side turn) is dispatched.
	coordinator.certifyDispatched(begin());
	expect(checkLkgDurability(db, sessionId)).toEqual(uncertified);
});

test("after a stop between publication and dispatch, the request loads uncertified and replays only for its exact input", () => {
	const { db, sessionId, begin, publish, restart, grown, grownIds } =
		publicationFixture();
	// The process stops after the publication commit, before its handler either
	// returns the request or throws: neither certifyDispatched nor refuseDispatch runs.
	publish(begin(), "§1§ outcome unknown", 1);
	const restarted = restart();
	const loaded = getSlot(sessionId);
	expect(loaded?.jsonPrefix).toContain("§1§ outcome unknown");
	expect(loaded?.dispatchUnconfirmed).toBe(true);
	// Nothing that reads the certificate treats it as sent.
	expect(checkLkgDurability(db, sessionId)).toEqual(uncertified);
	const changes = db.prepare("SELECT total_changes() AS n").get();
	expect(repairLkgDurability(db, sessionId)).toEqual(uncertified);
	expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
	// A different input (a newer turn appended) must not anchor on these bytes.
	expect(restarted.replay(begin(restarted, grown, grownIds))).toEqual({
		ok: false,
		reason: "lkg_dispatch_unconfirmed",
	});
	// The exact input it was built from may replay it: that equals rebuilding it.
	const same = restarted.replay(begin(restarted));
	expect(same.ok).toBe(true);
	if (same.ok)
		expect(JSON.stringify(same.messages)).toContain("§1§ outcome unknown");
});

test("a dispatched request still replays under a newer turn after a restart", () => {
	const { coordinator, begin, publish, restart, grown, grownIds } =
		publicationFixture();
	const snapshot = begin();
	publish(snapshot, "§1§ dispatched", 1);
	coordinator.certifyDispatched(snapshot);
	const restarted = restart();
	const replay = restarted.replay(begin(restarted, grown, grownIds));
	expect(replay.ok).toBe(true);
	if (replay.ok) {
		expect(JSON.stringify(replay.messages)).toContain("§1§ dispatched");
		expect(JSON.stringify(replay.messages)).toContain("a newer turn");
	}
});
