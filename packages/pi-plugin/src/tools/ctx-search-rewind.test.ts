/// <reference types="bun-types" />

/**
 * End-to-end view of the rewind fix at the Pi tool boundary.
 *
 * The core lane tests (`search-branch-scope.test.ts`) prove the deny-list works;
 * this file proves `ctx_search` actually derives the deny-list from Pi's session
 * entries — the wiring that was missing and made a `/tree` jump leave the rewound
 * conversation searchable.
 *
 * The fixture is a real Pi shape: `getBranch()` returns the leaf→root path,
 * `getEntries()` returns the whole file, and the file still holds the abandoned
 * pair after the jump.
 */

import { describe, expect, it } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { clearPiAbandonedMessageIds } from "../pi-abandoned-message-ids";
import { createTestDb } from "../test-utils.test";
import { createCtxSearchTool } from "./ctx-search";

interface Entry {
	type: string;
	id: string;
	message: { role: string; content: [{ type: "text"; text: string }] };
}

function entry(id: string, role: string, text: string): Entry {
	return {
		type: "message",
		id,
		message: { role, content: [{ type: "text", text }] },
	};
}

function hostContext(
	sessionId: string,
	branch: Entry[],
	all: Entry[],
): unknown {
	return {
		cwd: process.cwd(),
		hasUI: true,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
			getEntries: () => all,
			getLeafId: () => branch[branch.length - 1]?.id ?? null,
		},
		getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 100_000 }),
	};
}

function textOf(result: { content: Array<{ text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

/** Index rows the way the ingest path would for these messages. */
function indexRows(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	rows: Array<{ ordinal: number; id: string; role: string; text: string }>,
): void {
	const insert = db.prepare(
		"INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
	);
	for (const row of rows)
		insert.run(sessionId, row.ordinal, row.id, row.role, row.text);
}

describe("pi ctx_search rewound-message exclusion", () => {
	it("hides the message a /tree jump abandoned and keeps the compacted archive", async () => {
		const db = createTestDb();
		const sessionId = "ses-rewind";
		clearPiAbandonedMessageIds(sessionId);
		try {
			// An older compaction does not detach its messages: Pi appends a
			// compaction entry and the pre-compaction messages stay ancestors on the
			// branch, which is why the archive must remain searchable. After the jump
			// the branch is old-user → u1 → a1 → u2, and only the rewound pair left it.
			const branch = [
				entry(
					"old-user",
					"user",
					"quokka telemetry background from the first day",
				),
				entry("u1", "user", "start the collector work"),
				entry("a1", "assistant", "the collector lives in collector.ts"),
				entry("u2", "user", "carry on"),
			];
			const abandoned = [
				entry(
					"dx-user",
					"user",
					"quokka telemetry should be written by dx_telemetry_writer",
				),
				entry(
					"dx-answer",
					"assistant",
					"confirmed: quokka telemetry goes through dx_telemetry_writer",
				),
			];
			const ctx = hostContext(sessionId, branch, [...branch, ...abandoned]);

			// A published compartment raises the ordinal cutoff past all of them, which
			// is what re-exposes the abandoned rows (before it, the cutoff is 0).
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 40,
					startMessageId: "old-user",
					endMessageId: "u2",
					title: "collector work",
					content: "Summary",
					p1: "Summary",
				},
			]);
			// Every row sits at or below the compartment boundary (40). A row past it
			// would be filtered as live tail instead, which is a different mechanism
			// and would make this test pass without the rewind exclusion.
			indexRows(db, sessionId, [
				{
					ordinal: 5,
					id: "old-user",
					role: "user",
					text: branch[0].message.content[0].text,
				},
				{
					ordinal: 20,
					id: "dx-user",
					role: "user",
					text: abandoned[0].message.content[0].text,
				},
				{
					ordinal: 21,
					id: "dx-answer",
					role: "assistant",
					text: abandoned[1].message.content[0].text,
				},
			]);

			const search = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
				resolveProjectIdentity: () => "git:rewind",
			});

			const found = textOf(
				await search.execute(
					"call",
					{ query: "quokka telemetry", sources: ["message"], limit: 10 },
					new AbortController().signal,
					undefined,
					ctx as never,
				),
			);

			// The rewound pair is gone…
			expect(found).not.toContain("dx_telemetry_writer");
			expect(found).not.toContain("ordinal=20");
			expect(found).not.toContain("ordinal=21");
			// …the archived message is still searchable, and the user is told why
			// the other hits vanished instead of silently getting fewer results.
			expect(found).toContain("ordinal=5");
			expect(found).toContain("no longer on the active conversation branch");
		} finally {
			clearPiAbandonedMessageIds(sessionId);
			closeQuietly(db);
		}
	});

	it("still searches everything when the host cannot enumerate the file", async () => {
		// A host without `getEntries()` must degrade to the old behaviour: an
		// unknown abandoned set can never be treated as "all rows are rewound".
		const db = createTestDb();
		const sessionId = "ses-rewind-unknown";
		clearPiAbandonedMessageIds(sessionId);
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 40,
					startMessageId: "old-user",
					endMessageId: "old-user",
					title: "t",
					content: "Summary",
					p1: "Summary",
				},
			]);
			indexRows(db, sessionId, [
				{
					ordinal: 5,
					id: "old-user",
					role: "user",
					text: "quokka telemetry archive",
				},
			]);
			const ctx = {
				cwd: process.cwd(),
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => [entry("u1", "user", "hi")],
				},
			};

			const search = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
				resolveProjectIdentity: () => "git:rewind",
			});

			const found = textOf(
				await search.execute(
					"call",
					{ query: "quokka telemetry", sources: ["message"], limit: 10 },
					new AbortController().signal,
					undefined,
					ctx as never,
				),
			);

			expect(found).toContain("ordinal=5");
		} finally {
			clearPiAbandonedMessageIds(sessionId);
			closeQuietly(db);
		}
	});
});
