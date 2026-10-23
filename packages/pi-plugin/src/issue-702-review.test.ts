import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { withRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { repairPiHistoryBoundary } from "./history-boundary-repair-pi";
import {
	injectM0M1Pi,
	materializeM0Pi,
	trimPiMessagesToCachedBoundary,
} from "./inject-compartments-pi";
import { readPiHistoryRetirement } from "./pi-history-retirement";
import { convertEntriesToRawMessages } from "./read-session-pi";
import { createTestDb } from "./test-utils.test";

function userMessage(content: string, timestamp = 1) {
	return { role: "user" as const, content, timestamp };
}

function stateFor(sessionId: string) {
	return {
		sessionId,
		injectDocs: false,
		projectIdentity: "issue-702-review",
		projectDirectory: "/tmp/issue-702-review",
	};
}

// The 128 samples draw from one seeded stream in a fixed order (boundary,
// row text, then the window filter), so they are generated up front and the
// work is split in two tests that each fit the per-test timeout under CI load.
// The printed digest covers all 128 samples in the original order.
const ISSUE_702_PI_SAMPLES = (() => {
	let seed = 702;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 0x100000000;
	};
	return Array.from({ length: 128 }, (_, sample) => {
		const boundaryIndex = 1 + Math.floor(random() * 24);
		const partial = sample % 3 === 0;
		const source = Array.from({ length: 32 }, (_, index) => ({
			id: `entry-${index}`,
			message: userMessage(`row ${index} ${random()} §`, index + 1),
		}));
		const window = source.filter(
			(_, index) => index === boundaryIndex || random() > 0.3,
		);
		return { sample, boundaryIndex, partial, source, window };
	});
})();
const issue702PiHash = createHash("sha256");
let issue702PiCases = 0;

function runIssue702PiSamples(from: number, to: number): void {
	for (const {
		sample,
		boundaryIndex,
		partial,
		source,
		window,
	} of ISSUE_702_PI_SAMPLES.slice(from, to)) {
		const db = createTestDb();
		const sessionId = `issue-702-pi-differential-${sample}`;
		const state = stateFor(sessionId);
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: boundaryIndex + 1,
					startMessageId: source[0]!.id,
					endMessageId: source[boundaryIndex]!.id,
					...(partial ? { endBlockIndex: 0 } : {}),
					title: "Covered",
					content: "Fixed summary",
					p1: "Fixed summary",
				},
			]);
			materializeM0Pi(state, db);
			for (const rebuild of [true, false]) {
				const messages = structuredClone(window.map((entry) => entry.message));
				const result = injectM0M1Pi(
					state,
					db,
					messages,
					window.map((entry) => entry.id),
					rebuild,
				);
				const expected = window
					.filter((entry) => partial || source.indexOf(entry) > boundaryIndex)
					.map((entry) => entry.message);
				expect(messages.slice(result.injected ? 2 : 0)).toEqual(expected);
				issue702PiHash.update(JSON.stringify(messages));
				issue702PiCases++;
			}
		} finally {
			closeQuietly(db);
		}
	}
}

test("issue 702 differential: Pi randomized in-order serialized arrays (samples 0-63)", () => {
	runIssue702PiSamples(0, 64);
}, 30000);

test("issue 702 differential: Pi randomized in-order serialized arrays (samples 64-127)", () => {
	runIssue702PiSamples(64, 128);
	expect(issue702PiCases).toBe(256);
	console.log(
		`ISSUE_702_DIFFERENTIAL pi cases=${issue702PiCases} sha256=${issue702PiHash.digest("hex")}`,
	);
}, 30000);

test("issue 702 control: active-branch fallback cannot resurrect a boundary abandoned by tree", () => {
	const db = createTestDb();
	const sessionId = "issue-702-tree";
	const entry = (id: string, parentId: string | null) => ({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: userMessage(id, 1),
	});
	const shared = entry("shared", null);
	const abandoned = entry("abandoned-boundary", "shared");
	const active = [
		shared,
		entry("new-branch", "shared"),
		entry("new-tail", "new-branch"),
	];
	try {
		appendCompartments(db, sessionId, [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 2,
				startMessageId: "shared",
				endMessageId: abandoned.id,
				title: "ABANDONED",
				content: "Do not replay this branch",
				p1: "Do not replay this branch",
			},
		]);
		materializeM0Pi(stateFor(sessionId), db);
		withRawMessageProvider(
			sessionId,
			{ readMessages: () => convertEntriesToRawMessages(active) },
			() => {
				const source = active.map((item) => item.message);
				const messages = structuredClone(source);
				const ids = active.map((item) => item.id);
				expect(
					trimPiMessagesToCachedBoundary(db, sessionId, messages, ids),
				).toBe(0);
				expect(messages).toEqual(source);
				repairPiHistoryBoundary(db, sessionId, {
					sessionManager: {
						getBranch: () => active,
						getLeafId: () => "new-tail",
						getEntry: (id: string) =>
							[...active, abandoned].find((item) => item.id === id),
					},
				});
				expect(getCompartments(db, sessionId)).toEqual([]);
				expect(readPiHistoryRetirement(db, sessionId)).toBe("shared");
				expect(
					trimPiMessagesToCachedBoundary(db, sessionId, messages, ids),
				).toBe(0);
				expect(messages).toEqual(source);
			},
		);
	} finally {
		closeQuietly(db);
	}
});
