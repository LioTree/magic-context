import { expect, it } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMockHistorianPayload,
	findHistorianOrdinalRange,
} from "../src/mock-historian";
import { PiTestHarness } from "../src/pi-harness";
import { createE2ETempDir } from "../src/temp-dir";
import { forEachHost } from "../src/scenario-hosts";
import type { MockResponse } from "../src/mock-provider/server";

/**
 * `ctx_search` must not return messages that a `/tree` jump abandoned.
 *
 * The Pi hosts keep every entry of every branch in the session JSONL, and the
 * raw-message index in `context.db` is keyed by `(session_id, message_id)`, so an
 * abandoned entry's rows outlive the jump. The lane bounds hits by an ordinal
 * cutoff only, so the rows stay unreachable until a compartment publish moves the
 * cutoff past them — after which they resurface. This scenario walks that path on
 * a real host: rewind, continue, publish, then search.
 *
 * The second search is the control that keeps the first honest: a message that
 * stayed on the branch is compacted into the same archive and MUST still be
 * returned. Without it, "hide everything" would pass.
 */

const ARCHIVE_MARKER = "zqxarchive";
const REWOUND_MARKER = "zqxrewound";

const LOW_USAGE = {
	input_tokens: 100,
	output_tokens: 20,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
};

function requestMessages(body: Record<string, unknown>): Array<{
	role?: string;
	content?: unknown;
}> {
	const messages = body.messages;
	return Array.isArray(messages)
		? (messages as Array<{ role?: string; content?: unknown }>)
		: [];
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
	return Array.isArray(content)
		? (content as Array<Record<string, unknown>>)
		: typeof content === "string"
			? [{ type: "text", text: content }]
			: [];
}

/**
 * The text a host sent back for the tool call `callId`.
 *
 * Only the result body is returned, never the surrounding JSON: the search
 * output echoes the query, so asserting "the marker is absent" against the whole
 * block would fail even when nothing was found.
 */
function toolResultText(
	requests: ReadonlyArray<{ body: Record<string, unknown> }>,
	callId: string,
): string | null {
	for (const request of requests) {
		for (const message of requestMessages(request.body)) {
			for (const block of contentBlocks(message.content)) {
				if (block.type !== "tool_result" || block.tool_use_id !== callId) continue;
				const content = block.content;
				if (typeof content === "string") return content;
				if (Array.isArray(content))
					return content
						.map((part) =>
							typeof (part as { text?: unknown }).text === "string"
								? (part as { text: string }).text
								: "",
						)
						.join("\n");
				return content === undefined ? null : JSON.stringify(content);
			}
		}
	}
	return null;
}

/** A rendered hit line, e.g. `ordinal=12`. Absent when the lane returned nothing. */
function hitCount(result: string): number {
	return result.match(/ordinal=\d+/g)?.length ?? 0;
}

/** Wire name of the `ctx_search` tool on this host. */
function ctxSearchToolName(body: Record<string, unknown>): string | null {
	const tools = Array.isArray(body.tools) ? body.tools : [];
	for (const tool of tools) {
		const name = (tool as { name?: unknown }).name;
		if (typeof name === "string" && /(^|_)ctx_search$/.test(name)) return name;
	}
	return null;
}

forEachHost(import.meta.url, null, (host) => {
	if (host !== "pi" && host !== "omp")
		throw new Error(`Unsupported host ${host}`);

	it(`${host}: ctx_search hides messages a /tree jump abandoned and keeps the archive`, async () => {
		const base = join(realpathSync(tmpdir()), "magic-context/rewound-search");
		mkdirSync(base, { recursive: true });
		const previousTmp = process.env.TMPDIR;
		process.env.TMPDIR = base;
		const fixture = createE2ETempDir(`${host}-rewound-search-`);
		const snapshotPath = join(fixture, "tree.json");
		const extension = join(fixture, "tree-probe.mjs");
		writeFileSync(
			extension,
			`
import { writeFileSync } from "node:fs";
export default function(pi) {
    const preview = message => JSON.stringify(message?.content ?? "").slice(0, 400);
    pi.registerCommand("rw-snapshot", { description: "Capture the real host tree", handler(_args, ctx) {
        writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({
            leaf: ctx.sessionManager.getLeafId(),
            branch: ctx.sessionManager.getBranch().map(e => ({
                id: e.id,
                type: e.type,
                role: e.message?.role,
                preview: e.message ? preview(e.message) : undefined,
                customType: e.customType,
                text: e.data?.text,
            })),
        }));
    }});
    pi.registerCommand("rw-goto", { description: "Navigate with the same host API as /tree", async handler(id, ctx) {
        await ctx.navigateTree(id.trim(), { summarize: false });
    }});
}
`,
		);

		let h: PiTestHarness | undefined;
		try {
			h = await PiTestHarness.create({
				host,
				extensionsBeforeMagicContext: [extension],
				magicContextConfig: {
					execute_threshold_percentage: 95,
					protected_tokens: 4000,
				},
			});
			const harness = h;
			const session = await h.createSession();
			const snapshot = () => {
				harness.map; // keep host alive across awaits
				return JSON.parse(readFileSync(snapshotPath, "utf8")) as {
					leaf: string;
					branch: Array<{
						id: string;
						type: string;
						role?: string;
						preview?: string;
						customType?: string;
						text?: string;
					}>;
				};
			};
			const takeSnapshot = async () => {
				await harness.invokeExtensionCommand("rw-snapshot");
				return snapshot();
			};

			// The historian is a hidden agent with its own system prompt; answer it so
			// `ctx-wrapup` can publish a compartment on the new branch. Without a
			// publish the ordinal cutoff never moves and the stale row stays
			// unreachable anyway, which would make the assertion below vacuous.
			h.mock.addMatcher((body): MockResponse | null => {
				if (
					!JSON.stringify(body.system).includes(
						"the hippocampus of a long-running coding agent",
					)
				)
					return null;
				const range = findHistorianOrdinalRange(body);
				if (!range) throw new Error("Historian source range missing");
				return {
					text: buildMockHistorianPayload({
						start: range.start,
						end: range.end,
						title: "REACHABLE_AFTER_JUMP",
						body: "REACHABLE_AFTER_JUMP: work continued on the reachable branch.",
					}),
					usage: { input_tokens: 500, output_tokens: 200 },
				};
			});

			// One search per stage; the matcher answers only the prompt that asks.
			let searchStage = 0;
			h.mock.addMatcher((body): MockResponse | null => {
				const toolName = ctxSearchToolName(body);
				if (!toolName) return null;
				const recent = requestMessages(body)
					.slice(-3)
					.map((message) => JSON.stringify(message.content ?? ""))
					.join("\n");
				const call = (marker: string, callId: string) => ({
					content: [
						{
							type: "text" as const,
							text: "Searching the archived conversation.",
						},
						{
							type: "tool_use" as const,
							id: callId,
							name: toolName,
							input: { query: marker, sources: ["message"], limit: 10 },
						},
					],
					stop_reason: "tool_use" as const,
					usage: LOW_USAGE,
				});
				if (searchStage === 0 && recent.includes("SEARCH_REWOUND_NOW")) {
					searchStage = 1;
					return call(REWOUND_MARKER, "toolu_search_rewound");
				}
				if (searchStage === 1 && recent.includes("SEARCH_ARCHIVE_NOW")) {
					searchStage = 2;
					return call(ARCHIVE_MARKER, "toolu_search_archive");
				}
				return null;
			});
			h.mock.setDefault({ text: "noted", usage: LOW_USAGE });

			// Original branch: an early turn that will survive the jump, ballast,
			// then a late turn that the jump will abandon.
			await h.sendPrompt(
				session,
				`ORIGINAL_EARLY_TURN. The ${ARCHIVE_MARKER} note lives here. ${h.ballast(1500)}`,
			);
			for (let i = 0; i < 3; i++)
				await h.sendPrompt(session, `ORIGINAL_FILLER_${i}. ${h.ballast(1500)}`);
			await h.sendPrompt(
				session,
				`ORIGINAL_LATE_TURN. The ${REWOUND_MARKER} note lives here and will be rewound. ${h.ballast(1500)}`,
			);
			await h.sendPrompt(session, `ORIGINAL_TAIL. ${h.ballast(1500)}`);

			// The rows must already be indexed before the jump: the leak is that an
			// already-indexed row survives the rewind. Indexing itself is a background
			// reconciliation that waits out the 120 s boot-quiet window
			// (plugin/boot-quiet.ts), so wait for it here rather than after the jump —
			// and note that indexing also pauses while the branch has no compartment
			// anchor to align stored ordinals against, which the jump itself causes.
			const indexedRows = await h.waitFor(
				() => {
					const row = harness
						.contextDb()
						.prepare(
							"SELECT COUNT(*) AS n FROM message_history_fts WHERE session_id = ? AND content LIKE ?",
						)
						.get(session, `%${REWOUND_MARKER}%`) as { n: number };
					return row.n > 0 ? row.n : null;
				},
				{ timeoutMs: 200_000, label: "the raw-message index catches up" },
			);
			expect(indexedRows).toBeGreaterThan(0);
			const rewoundIndexedAt = (
				harness
					.contextDb()
					.prepare(
						"SELECT MIN(message_ordinal) AS ordinal FROM message_history_fts WHERE session_id = ? AND content LIKE ?",
					)
					.get(session, `%${REWOUND_MARKER}%`) as { ordinal: number | null } | null
			)?.ordinal;
			expect(rewoundIndexedAt ?? null).not.toBeNull();
			expect(
				(
					harness
						.contextDb()
						.prepare(
							"SELECT COUNT(*) AS n FROM message_history_fts WHERE session_id = ? AND content LIKE ?",
						)
						.get(session, `%${ARCHIVE_MARKER}%`) as { n: number }
				).n,
			).toBeGreaterThan(0);

			// Jump to the entry immediately before the late turn, so that turn and
			// everything after it leave the active branch.
			const before = await takeSnapshot();
			const lateIndex = before.branch.findIndex(
				(entry) => entry.preview?.includes(REWOUND_MARKER) === true,
			);
			expect(lateIndex).toBeGreaterThan(0);
			const target = before.branch[lateIndex - 1]!.id;
			await h.invokeExtensionCommand(`rw-goto ${target}`);
			const jumped = await takeSnapshot();
			expect(jumped.leaf).toBe(target);
			expect(jumped.branch.length).toBeLessThan(before.branch.length);
			expect(
				jumped.branch.some((entry) => entry.preview?.includes(REWOUND_MARKER) === true),
			).toBe(false);

			// Continue on the new branch, then publish history there. The publish is
			// what moves the ordinal cutoff past the abandoned rows: a new branch
			// reuses the ordinals the abandoned one vacated, so the fresh compartment's
			// end lands at or above theirs and they re-enter the searchable window.
			// Without enough post-jump turns the cutoff stays below them and the rows
			// are hidden by the live-tail rule instead — a different mechanism, which
			// would make the search assertion vacuous.
			for (let i = 0; i < 4; i++)
				await h.sendPrompt(session, `REACHABLE_AFTER_JUMP_${i}. ${h.ballast(1500)}`);
			await h.invokeExtensionCommand("ctx-wrapup 2");
			const cutoff = await h.waitFor(
				() => {
					const row = harness
						.contextDb()
						.prepare(
							"SELECT MAX(end_message) AS cutoff FROM compartments WHERE session_id = ?",
						)
						.get(session) as { cutoff: number | null } | null;
					return row?.cutoff ?? null;
				},
				{ timeoutMs: 30000, label: "a compartment publishes on the new branch" },
			);
			// The stale row must actually sit inside the searchable window, or the
			// search asserts nothing about branch scoping. `>=` is the whole premise:
			// at a cutoff below it the live-tail rule already hides the row.
			expect(cutoff).toBeGreaterThanOrEqual(rewoundIndexedAt!);

			await h.sendPrompt(session, "SEARCH_REWOUND_NOW", { timeoutMs: 60000 });
			const rewoundResult = await h.waitFor(
				() => toolResultText(h!.mock.requests(), "toolu_search_rewound"),
				{ timeoutMs: 30000, label: "ctx_search answers the rewound query" },
			);

			await h.sendPrompt(session, "SEARCH_ARCHIVE_NOW", { timeoutMs: 60000 });
			const archiveResult = await h.waitFor(
				() => toolResultText(h!.mock.requests(), "toolu_search_archive"),
				{ timeoutMs: 30000, label: "ctx_search answers the archive query" },
			);

			writeFileSync(
				join(fixture, "observations.json"),
				JSON.stringify(
					{ host, session, cutoff, rewoundIndexedAt, rewoundResult, archiveResult },
					null,
					2,
				),
			);
			writeFileSync(join(fixture, "diagnostics.txt"), h.diagnostics());

			// The abandoned message must not come back as a hit, and the agent must be
			// told why the result set is empty rather than silently getting nothing.
			expect(hitCount(rewoundResult)).toBe(0);
			expect(rewoundResult).toContain("No hidden results found");
			expect(rewoundResult).toContain("no longer on the active conversation branch");
			// …while the one that stayed on the branch is still returned from the
			// archive. This is the control that makes the first assertion meaningful:
			// hiding everything would satisfy it but destroy history search.
			expect(hitCount(archiveResult)).toBeGreaterThan(0);
			expect(archiveResult).toContain(ARCHIVE_MARKER);
		} finally {
			await h?.dispose();
			if (previousTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmp;
		}
	}, 420000);
});
