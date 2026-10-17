import { afterEach, expect, test } from "bun:test";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { createLkgEntryProjector } from "@magic-context/core/hooks/magic-context/lkg-replay";
import {
	captureSlot,
	dropSlot,
	getSlot,
	lkgContentDigestFromFields,
	resetLkgSlotsForTest,
	sharedLkgEntryDigests,
	signatureForFields,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { moveMessageDigestFromFields } from "@magic-context/core/hooks/magic-context/move-inputs";
import { Database } from "@magic-context/core/shared/sqlite";

import { clearPiLkgSessionState, createPiLkgCoordinator } from "./pi-lkg";

// These assertions reject digest reuse from replaced slots or caller-edited snapshots.
// Opt in explicitly so the ordinary test suite can still run independently.
const witness = test.skipIf(process.env.LKG_MEMO_REVIEW_WITNESSES !== "1");
const sessionId = "pi-memo-review-witness";
const databases: Database[] = [];
afterEach(() => {
	clearPiLkgSessionState(sessionId);
	resetLkgSlotsForTest();
	for (const db of databases.splice(0)) db.close();
});

function harness() {
	const db = new Database(":memory:");
	databases.push(db);
	initializeDatabase(db);
	runMigrations(db);
	const coordinator = createPiLkgCoordinator(db, (capture) => capture());
	const begin = (messages: unknown[]) =>
		coordinator.beginPass({
			sessionId,
			messages,
			entryIds: messages.map((_, i) => `entry-${i}`),
			modelKey: "test/model",
			providerKey: "test",
		});
	return { coordinator, begin };
}

witness(
	"Pi accepted input snapshot edits cannot certify a stale content digest",
	() => {
		const { coordinator, begin } = harness();
		const messages = [{ role: "user", content: "before", timestamp: 1 }];
		const old = begin(messages);
		coordinator.captureAppliedPass({
			snapshot: old,
			outputMessages: messages,
			cacheBusting: false,
		});
		messages[0].content = "after host mutation";
		const next = begin(messages);
		// The returned snapshot must be separate from the stored previous-input
		// tokens, otherwise editing it can make changed host bytes appear unchanged.
		old.inputs[0].fields = [...next.inputs[0].fields];
		coordinator.captureAppliedPass({
			snapshot: next,
			outputMessages: messages,
			cacheBusting: false,
		});
		expect(getSlot(sessionId)?.inputContentDigests).toEqual(
			next.inputs.map((input) => lkgContentDigestFromFields(input.fields)),
		);
	},
);

witness(
	"Pi returned serialization edits cannot rewrite the next output snapshot",
	() => {
		const { coordinator, begin } = harness();
		const messages = [{ role: "user", content: "unaltered", timestamp: 1 }];
		const capture = () =>
			coordinator.captureAppliedPass({
				snapshot: begin(messages),
				outputMessages: messages,
				cacheBusting: false,
			});
		const output = capture();
		if (!output) throw new Error("missing serialized output");
		output.json = '[{"role":"user","content":"not served"}]';
		expect(capture()?.json).toBe(JSON.stringify(messages));
	},
);

witness(
	"Pi output snapshot preserves JSON changes excluded by OpenCode input normalization",
	() => {
		const { coordinator, begin } = harness();
		const messages = [
			{
				info: { id: "u", role: "user", summary: { diffs: [] } },
				parts: [{ type: "text", text: "adapter input" }],
			},
		];
		coordinator.captureAppliedPass({
			snapshot: begin(messages),
			outputMessages: messages,
			cacheBusting: false,
		});
		delete (messages[0].info as { summary?: unknown }).summary;
		const output = coordinator.captureAppliedPass({
			snapshot: begin(messages),
			outputMessages: messages,
			cacheBusting: false,
		});
		expect(output?.json).toBe(JSON.stringify(messages));
	},
);

witness("Pi replacement slot cannot supply stale replay digests", () => {
	const { coordinator, begin } = harness();
	const before = [{ role: "user", content: "before", timestamp: 1 }];
	const after = [{ role: "user", content: "after", timestamp: 1 }];
	coordinator.captureAppliedPass({
		snapshot: begin(before),
		outputMessages: before,
		cacheBusting: false,
	});
	const saved = getSlot(sessionId);
	if (!saved) throw new Error("missing initial slot");
	const changed = begin(after);
	expect(
		captureSlot(sessionId, {
			...saved,
			jsonPrefix: JSON.stringify(after),
			inputContentSignatures: changed.inputs.map((input) =>
				signatureForFields(input.fields),
			),
			inputContentDigests: changed.inputs.map((input) =>
				lkgContentDigestFromFields(input.fields),
			),
			inputMoveDigests: changed.inputs.map((input) =>
				moveMessageDigestFromFields(input.fields),
			),
		}),
	).toBe(true);
	const snapshot = begin(before);
	coordinator.captureAppliedPass({
		snapshot,
		outputMessages: before,
		cacheBusting: false,
	});
	expect(coordinator.replay(begin(after))).toMatchObject({
		ok: false,
		reason: "lkg_content_mismatch",
	});
	expect(getSlot(sessionId)?.inputContentDigests).toEqual(
		snapshot.inputs.map((input) => lkgContentDigestFromFields(input.fields)),
	);
});

witness("OpenCode dropping a session releases its digest memo", () => {
	createLkgEntryProjector()(sessionId, [
		{
			info: { id: "u", role: "user" } as never,
			parts: [{ type: "text", text: "ended session".repeat(1024) }],
		},
	]);
	expect(sharedLkgEntryDigests.stats().totalBytes).toBeGreaterThan(0);
	dropSlot(sessionId, "session_deleted");
	expect(
		sharedLkgEntryDigests
			.stats()
			.sessions.some((session) => session.sessionId === sessionId),
	).toBe(false);
});
