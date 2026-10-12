// Opt-in independent review evidence; assertions may fail without changing product code.
import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "../../../packages/pi-plugin/src/auto-search-pi";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "../../../packages/pi-plugin/src/context-handler";
import {
	injectM0M1Pi,
	materializeM0Pi,
} from "../../../packages/pi-plugin/src/inject-compartments-pi";
import {
	createFakePi,
	fakeContext,
	textOf,
	userMessage,
} from "../../../packages/pi-plugin/src/test-utils.test";
import { appendCompartments } from "../../../packages/plugin/src/features/magic-context/compartment-storage";
import {
	clearServedRecoveryTexts,
	recordServedRecoveryTexts,
} from "../../../packages/plugin/src/features/magic-context/memory/applied-projection";
import * as embedding from "../../../packages/plugin/src/features/magic-context/memory/embedding";
import {
	applyAgentMemoryMutation,
	applyMemoryAdmission,
	getMemoryRevision,
	recordAutomatedMemoryEdit,
} from "../../../packages/plugin/src/features/magic-context/memory/lifecycle-applier";
import { computeNormalizedHash } from "../../../packages/plugin/src/features/magic-context/memory/normalize-hash";
import { resolveProjectIdentityForSession } from "../../../packages/plugin/src/features/magic-context/memory/project-identity";
import {
	getMemoryById,
	insertMemory,
	updateMemoryContent,
} from "../../../packages/plugin/src/features/magic-context/memory/storage-memory";
import {
	getAutoSearchHintDecisions,
	getOrCreateSessionMeta,
} from "../../../packages/plugin/src/features/magic-context/storage";
import { bumpProjectMemoryEpoch } from "../../../packages/plugin/src/features/magic-context/storage-project-state";
import { createTagger } from "../../../packages/plugin/src/features/magic-context/tagger";
import {
	_resetAutoSearchCache,
	runAutoSearchHint,
} from "../../../packages/plugin/src/hooks/magic-context/auto-search-runner";
import { autoSearchTestSnapshot } from "../../../packages/plugin/src/hooks/magic-context/auto-search-snapshot.fixture";
import * as searchModule from "../../../packages/plugin/src/hooks/magic-context/auto-search-worker-client";
import {
	clearInjectionCache,
	getVisibleMemoryIds,
	injectM0M1,
	materializeM0,
} from "../../../packages/plugin/src/hooks/magic-context/inject-compartments";
import type { MessageLike } from "../../../packages/plugin/src/hooks/magic-context/transform-operations";
import { runPostTransformPhase } from "../../../packages/plugin/src/hooks/magic-context/transform-postprocess-phase";
import {
	_resetHarnessForTesting,
	type HarnessId,
	setHarness,
} from "../../../packages/plugin/src/shared/harness";
import {
	createProjectionFixture,
	type ProjectionFixture,
} from "../../../packages/plugin/src/shared/memory-projection-fixtures.test";
import { Database } from "../../../packages/plugin/src/shared/sqlite";

const hosts: HarnessId[] = ["opencode", "opencode2", "pi"];
function required<T>(v: T | null | undefined): T {
	if (v === null || v === undefined)
		throw new Error("Absent probe prerequisite");
	return v;
}
function setup(host: HarnessId, label: string) {
	_resetHarnessForTesting();
	setHarness(host);
	return createProjectionFixture(`${host}-r5-${label}`);
}
function args(f: ProjectionFixture, s: string, budget = 8000, history = 60000) {
	return {
		db: f.db,
		state: getOrCreateSessionMeta(f.db, s),
		sessionId: s,
		projectPath: f.projectPath,
		projectDirectory: f.directory,
		injectDocs: false,
		memoryInjectionBudgetTokens: budget,
		historyBudgetTokens: history,
		hardSignals: {
			systemHash: "system",
			modelKey: "anthropic/claude",
			cacheExpired: false,
			lastResponseTime: 1,
		},
	};
}
function piArgs(
	f: ProjectionFixture,
	s: string,
	budget: number,
	history = 60000,
) {
	return {
		sessionId: s,
		projectIdentity: f.projectPath,
		projectDirectory: f.directory,
		injectDocs: false,
		injectionBudgetTokens: budget,
		historyBudgetTokens: history,
		hardSignals: args(f, s).hardSignals,
	};
}
function hard(
	host: HarnessId,
	f: ProjectionFixture,
	s: string,
	budget = 8000,
	history = 60000,
) {
	if (host === "pi") materializeM0Pi(piArgs(f, s, budget, history), f.db);
	else materializeM0(args(f, s, budget, history));
}
function pairText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { type?: string; text?: string }) =>
			part.type === "text" ? [part.text ?? ""] : [],
		)
		.join("");
}
function pass(
	host: HarnessId,
	f: ProjectionFixture,
	s: string,
	busting: boolean,
	budget = 8000,
	history = 60000,
) {
	if (host !== "pi") {
		const r = injectM0M1({
			...args(f, s, budget, history),
			isCacheBustingPass: busting,
		});
		return {
			m0: r.m0Bytes?.toString("utf8") ?? "",
			m1: r.m1Text ?? "",
			hard: r.m0RematerializedThisPass,
		};
	}
	const messages: Parameters<typeof injectM0M1Pi>[2] = [];
	const r = injectM0M1Pi(
		piArgs(f, s, budget, history),
		f.db,
		messages,
		undefined,
		busting,
	);
	return {
		m0: pairText(messages[0]),
		m1: pairText(messages[1]),
		hard: r.m0Materialized,
	};
}
function row(f: ProjectionFixture, text: string) {
	return insertMemory(f.db, {
		projectPath: f.projectPath,
		category: "ARCHITECTURE",
		content: text,
		importance: 50,
	});
}
function save(f: ProjectionFixture, s: string, text: string, key = text) {
	return applyMemoryAdmission(f.db, {
		key: `save:${s}:${key}`,
		operation: "agent_save",
		input: {
			projectPath: f.projectPath,
			sourceSessionId: s,
			sourceType: "agent",
			category: "ARCHITECTURE",
			content: text,
		},
	});
}
function edit(
	f: ProjectionFixture,
	s: string,
	operation: "update" | "merge" | "archive",
	ids: number[],
	content?: string,
	key = `${s}:${operation}:${ids}:${content}`,
) {
	return applyAgentMemoryMutation(f.db, {
		key,
		projectPath: f.projectPath,
		sourceSessionId: s,
		operation,
		targets: ids.map((id) => ({
			id,
			revision: required(getMemoryRevision(f.db, id)),
		})),
		content,
	});
}
function automated(f: ProjectionFixture, id: number, text: string) {
	const before = required(getMemoryById(f.db, id));
	updateMemoryContent(f.db, id, text, computeNormalizedHash(text));
	recordAutomatedMemoryEdit(f.db, {
		writer: "verify",
		before,
		reason: "verify_update",
	});
}
function reopen(f: ProjectionFixture) {
	f.db.close();
	for (const s of f.sessions) {
		clearInjectionCache(s);
		clearAutoSearchForPiSession(s);
	}
	_resetAutoSearchCache();
	f.db = new Database(join(f.directory, "context.db"));
	f.close = () => {
		f.db.close();
		rmSync(f.directory, { recursive: true, force: true });
	};
}
const receiptLines = (text: string) =>
	text.match(/ {2}<(?:added|updated|removed|superseded|stale-memory)[^\n]*/g) ??
	[];
const aggregate = (text: string) =>
	required(text.match(/ {2}<more-memory-edits[^\n]*/)?.[0]);
function hintFixture(host: HarnessId, f: ProjectionFixture, s: string) {
	const snapshot = spyOn(
		embedding,
		"getProjectEmbeddingSnapshot",
	).mockReturnValue(autoSearchTestSnapshot(f.projectPath));
	const search = spyOn(searchModule, "searchAutoHint").mockResolvedValue([
		{
			source: "memory",
			content: "Independent search-only hint",
			score: 0.95,
			memoryId: 9000,
			category: "ARCHITECTURE",
			matchType: "fts",
		},
	]);
	let visibility = 0;
	const options = {
		enabled: true,
		projectPath: f.projectPath,
		scoreThreshold: 0,
		minPromptChars: 1,
		memoryEnabled: true,
		embeddingEnabled: false,
		gitCommitsEnabled: false,
		resolveVisibleMemoryIds: () => {
			visibility++;
			return new Set<number>();
		},
	};
	return {
		snapshot,
		search,
		count: () => visibility,
		invoke: async (id: string, answered = false) => {
			if (host === "pi") {
				const messages = [userMessage("Explain cache ownership", 1)];
				if (answered)
					messages.push({
						role: "assistant",
						content: [{ type: "text", text: "Answer" }],
						timestamp: 2,
					} as never);
				await runAutoSearchHintForPi({
					db: f.db,
					sessionId: s,
					messages,
					entryIds: answered ? [id, "answer"] : [id],
					options,
				});
				return textOf(messages[0]);
			}
			const messages: MessageLike[] = [
				{
					info: { id, role: "user" },
					parts: [{ type: "text", text: "Explain cache ownership" }],
				} as MessageLike,
			];
			if (answered)
				messages.push({
					info: { id: "answer", role: "assistant" },
					parts: [{ type: "text", text: "Answer" }],
				} as MessageLike);
			await runAutoSearchHint({ db: f.db, sessionId: s, messages, options });
			return messages[0].parts
				.map((p) => (p as { text?: string }).text ?? "")
				.join("");
		},
		close: () => {
			search.mockRestore();
			snapshot.mockRestore();
			clearAutoSearchForPiSession(s);
			_resetAutoSearchCache();
		},
	};
}

for (const host of hosts) {
	test(`${host} r5 a persisted hint replays after defer revert model fold and database reopen without changing the pair`, async () => {
		const f = setup(host, "hint-success");
		const [a] = f.sessions;
		const h = hintFixture(host, f, a);
		try {
			row(f, "Pair baseline distinct from hint.");
			hard(host, f, a);
			const before = pass(host, f, a, false);
			const hint = await h.invoke("u1");
			expect(hint).toContain("<ctx-search-hint>");
			expect(h.search).toHaveBeenCalledTimes(1);
			expect(pass(host, f, a, false)).toEqual(before);
			expect(await h.invoke("u1", true)).toBe(hint);
			expect(await h.invoke("u1")).toBe(hint); // Remove the simulated assistant reply: the same served user ID is last again.
			expect(pass(host, f, a, true)).toEqual(before);
			if (host === "pi")
				materializeM0Pi(
					{
						...piArgs(f, a, 8000),
						hardSignals: {
							...args(f, a).hardSignals,
							modelKey: "anthropic/other",
						},
					},
					f.db,
				);
			else
				materializeM0({
					...args(f, a),
					hardSignals: {
						...args(f, a).hardSignals,
						modelKey: "anthropic/other",
					},
				});
			expect(await h.invoke("u1")).toBe(hint);
			reopen(f);
			expect(await h.invoke("u1")).toBe(hint);
			expect(h.search).toHaveBeenCalledTimes(1);
			expect(h.count()).toBe(1);
			expect(getAutoSearchHintDecisions(f.db, a)).toHaveLength(1);
			await h.invoke("u2");
			expect(h.search).toHaveBeenCalledTimes(2);
		} finally {
			h.close();
			f.close();
		}
	});
	for (const scenario of ["defer", "revert", "model fold", "reopen"])
		test(`${host} r5 a search exception cannot rewrite an already-served user tail after ${scenario}`, async () => {
			const f = setup(host, "hint-error");
			const [a] = f.sessions;
			const h = hintFixture(host, f, a);
			try {
				h.search.mockImplementationOnce(async () => {
					throw new Error("Independent transient search error");
				});
				hard(host, f, a);
				const pair = pass(host, f, a, false);
				const served = await h.invoke("u1");
				expect(served).not.toContain("<ctx-search-hint>");
				expect(pass(host, f, a, false)).toEqual(pair);
				if (scenario === "revert")
					expect(await h.invoke("u1", true)).toBe(served);
				if (scenario === "reopen") reopen(f);
				if (scenario === "model fold") {
					if (host === "pi")
						materializeM0Pi(
							{
								...piArgs(f, a, 8000),
								hardSignals: {
									...args(f, a).hardSignals,
									modelKey: "anthropic/other",
								},
							},
							f.db,
						);
					else
						materializeM0({
							...args(f, a),
							hardSignals: {
								...args(f, a).hardSignals,
								modelKey: "anthropic/other",
							},
						});
				}
				const repeated = await h.invoke("u1");
				expect(repeated).toBe(served);
				expect(h.search).toHaveBeenCalledTimes(1);
			} finally {
				h.close();
				f.close();
			}
		});
}

for (const host of hosts) {
	test(`${host} r5 b aggregate count is replay-stable across retry reopen foreign changes and HARD`, () => {
		const f = setup(host, "aggregate");
		try {
			const [a, b] = f.sessions;
			const x = row(f, "Aggregate baseline.");
			hard(host, f, a, 500);
			let shown = pass(host, f, a, false, 500);
			for (let i = 0; i < 30; i++) {
				expect(
					edit(
						f,
						a,
						"update",
						[x.id],
						`Overflow revision ${i}.`,
						`aggregate-${i}`,
					).state,
				).toBe("applied");
				const next = pass(host, f, a, true, 500);
				expect(next.hard).toBe(false);
				expect(next.m0).toBe(shown.m0);
				for (const line of receiptLines(shown.m1))
					expect(next.m1).toContain(line);
				shown = next;
			}
			const line = aggregate(shown.m1);
			const count = Number(required(line.match(/count="(\d+)"/)?.[1]));
			expect(count).toBeGreaterThan(20);
			expect(shown.m1.match(/<more-memory-edits/g)).toHaveLength(1);
			expect(pass(host, f, a, false, 500)).toEqual(shown);
			expect(pass(host, f, a, true, 500)).toEqual(shown);
			expect(
				edit(f, a, "update", [x.id], "Overflow revision 29.", "aggregate-29")
					.state,
			).toBe("applied");
			expect(pass(host, f, a, true, 500)).toEqual(shown);
			automated(f, x.id, "Automated unseen final revision.");
			save(f, b, "Other session unseen rule.");
			hard(host, f, b);
			expect(pass(host, f, a, true, 500)).toEqual(shown);
			reopen(f);
			expect(pass(host, f, a, false, 500)).toEqual(shown);
			expect(pass(host, f, a, true, 500)).toEqual(shown);
			expect(
				edit(
					f,
					a,
					"update",
					[x.id],
					"Final folded own revision.",
					"aggregate-final",
				).state,
			).toBe("applied");
			const last = pass(host, f, a, true, 500);
			expect(
				Number(required(aggregate(last.m1).match(/count="(\d+)"/)?.[1])),
			).toBe(count + 1);
			expect(pass(host, f, a, false, 500)).toEqual(last);
			hard(host, f, a, 8000);
			const folded = pass(host, f, a, false);
			expect(folded.m0.match(/Final folded own revision\./g)).toHaveLength(1);
			expect(folded.m0).not.toContain("Overflow revision");
			expect(folded.m0).toContain("Other session unseen rule.");
			expect(folded.m1).not.toContain("<more-memory-edits");
			expect(folded.m1).not.toContain("<updated");
			expect(pass(host, f, a, true)).toEqual(folded);
		} finally {
			f.close();
		}
	});
	test(`${host} r5 c project epoch still triggers HARD without memory heads`, () => {
		const f = setup(host, "epoch");
		try {
			const [a] = f.sessions;
			const x = row(f, "Epoch baseline.");
			hard(host, f, a);
			const before = pass(host, f, a, true);
			automated(f, x.id, "Epoch repair now current.");
			expect(pass(host, f, a, true)).toEqual(before);
			bumpProjectMemoryEpoch(f.db, f.projectPath);
			const folded = pass(host, f, a, false);
			expect(folded.hard).toBe(true);
			expect(folded.m0).toContain("Epoch repair now current.");
			expect(pass(host, f, a, true).hard).toBe(false);
		} finally {
			f.close();
		}
	});
	test(`${host} r5 d served survivor text is session-local including committed fragments and older revisions`, () => {
		const f = setup(host, "cross-session");
		try {
			const [a, b] = f.sessions;
			hard(host, f, b);
			const survivor = row(f, "Exact survivor text.");
			hard(host, f, a);
			expect(pass(host, f, a, false).m0).toContain(survivor.content);
			expect(pass(host, f, b, false).m0).not.toContain(survivor.content);
			const sourceA = row(f, "A merge source.");
			const sourceB = row(f, "B merge source.");
			expect(
				edit(f, a, "merge", [sourceA.id, survivor.id], survivor.content).state,
			).toBe("applied");
			expect(pass(host, f, a, true).m1).not.toContain(survivor.content);
			expect(
				edit(f, b, "merge", [sourceB.id, survivor.id], survivor.content).state,
			).toBe("applied");
			const servedB = pass(host, f, b, true);
			expect(servedB.m1).toContain(survivor.content);
			const sourceB2 = row(f, "B second merge source.");
			expect(
				edit(f, b, "merge", [sourceB2.id, survivor.id], survivor.content).state,
			).toBe("applied");
			expect(
				pass(host, f, b, true).m1.match(/Exact survivor text\./g),
			).toHaveLength(1);
			automated(
				f,
				survivor.id,
				"Changed survivor text unseen by either session.",
			);
			const sourceA2 = row(f, "A second merge source.");
			expect(
				edit(
					f,
					a,
					"merge",
					[sourceA2.id, survivor.id],
					"Changed survivor text unseen by either session.",
				).state,
			).toBe("applied");
			expect(pass(host, f, a, true).m1).toContain(
				"Changed survivor text unseen by either session.",
			);
			expect(pass(host, f, b, false).m1).not.toContain(
				"Changed survivor text unseen by either session.",
			);
		} finally {
			f.close();
		}
	});
	test(`${host} r5 d duplicate save uses served state not foreign or pending fragments`, () => {
		const f = setup(host, "duplicate-cross-session");
		try {
			const [a, b] = f.sessions;
			hard(host, f, b);
			const x = row(f, "Cross-session duplicate rule.");
			hard(host, f, a);
			expect(save(f, a, x.content, "shown").memoryId).toBe(x.id);
			expect(pass(host, f, a, true).m1).not.toContain(x.content);
			expect(save(f, b, x.content, "unshown").memoryId).toBe(x.id);
			expect(pass(host, f, b, false).m1).not.toContain(x.content);
			expect(save(f, b, x.content, "still-pending").memoryId).toBe(x.id);
			const served = pass(host, f, b, true);
			expect(served.m1.match(/Cross-session duplicate rule\./g)).toHaveLength(
				2,
			);
			expect(save(f, b, x.content, "now-shown").memoryId).toBe(x.id);
			expect(pass(host, f, b, true)).toEqual(served);
		} finally {
			f.close();
		}
	});
	test(`${host} r5 e randomized 550-pass pair stability with mixed writers oversized edits and foreign HARDs`, () => {
		const f = setup(host, "random");
		try {
			const [a, b] = f.sessions;
			const x = row(f, "Random baseline.");
			hard(host, f, a);
			hard(host, f, b);
			let shown = pass(host, f, a, true);
			let seed = 0x91ce57b;
			let active = [x.id];
			const coverage = Array(9).fill(0) as number[];
			const random = () => {
				seed ^= seed << 13;
				seed ^= seed >>> 17;
				seed ^= seed << 5;
				return seed >>> 0;
			};
			for (let i = 0; i < 550; i++) {
				const action = i < 9 ? i : random() % 9;
				coverage[action]++;
				const before = shown;
				const target = required(active[random() % active.length]);
				let unchanged = false;
				switch (action) {
					case 0:
					case 1: {
						const text =
							action === 0
								? `Own random save ${i}.`
								: `Own oversized ${i}. ${"detail ".repeat(2500)}`;
						const r = save(f, a, text);
						expect(r.state).toBe("applied");
						active.push(required(r.memoryId));
						break;
					}
					case 2:
						expect(
							edit(f, a, "update", [target], `Own random updated ${i}.`).state,
						).toBe("applied");
						break;
					case 3:
						if (active.length > 1) {
							const ids = active.slice(0, 2);
							const r = edit(f, a, "merge", ids, `Own random merge ${i}.`);
							expect(r.state).toBe("applied");
							active = active.filter((id) => !ids.includes(id));
							active.push(required(r.memoryId));
						} else unchanged = true;
						break;
					case 4:
						if (active.length > 2) {
							const ids = active.slice(0, 2);
							expect(edit(f, a, "archive", ids).state).toBe("applied");
							active = active.filter((id) => !ids.includes(id));
						} else unchanged = true;
						break;
					case 5:
						automated(f, target, `Foreign automated random ${i}.`);
						unchanged = true;
						break;
					case 6:
						save(f, b, `Foreign agent random ${i}.`);
						hard(host, f, b);
						unchanged = true;
						break;
					case 7:
						unchanged = true;
						break;
					case 8:
						reopen(f);
						unchanged = true;
						break;
				}
				expect(pass(host, f, a, false)).toEqual(before);
				shown = pass(host, f, a, true);
				expect(shown.hard).toBe(false);
				expect(shown.m0).toBe(before.m0);
				if (unchanged) expect(shown).toEqual(before);
				expect(shown.m1).not.toContain("Foreign automated random");
				expect(shown.m1).not.toContain("Foreign agent random");
				for (const line of receiptLines(before.m1))
					expect(shown.m1).toContain(line);
				if (before.m1.includes("<more-memory-edits")) {
					const oldN = Number(
						required(aggregate(before.m1).match(/count="(\d+)"/)?.[1]),
					);
					const nextN = Number(
						required(aggregate(shown.m1).match(/count="(\d+)"/)?.[1]),
					);
					expect(nextN).toBeGreaterThanOrEqual(oldN);
					if (nextN === oldN)
						expect(aggregate(shown.m1)).toBe(aggregate(before.m1));
				}
				expect(pass(host, f, a, true)).toEqual(shown);
				expect(pass(host, f, a, false)).toEqual(shown);
			}
			for (const n of coverage) expect(n).toBeGreaterThan(20);
			console.log(
				`${host} r5 randomized seed=0x91ce57b passes=550 coverage=${coverage.join(",")}`,
			);
		} finally {
			f.close();
		}
	});
}

for (const host of hosts) {
	test(`${host} r5 c dashboard-shaped epoch write still invalidates a cached marker probe`, () => {
		const f = setup(host, "dashboard-epoch");
		try {
			const [a] = f.sessions;
			const x = row(f, "Before dashboard repair.");
			hard(host, f, a);
			const before = pass(host, f, a, true);
			const writer = new Database(join(f.directory, "context.db"));
			try {
				writer
					.prepare("UPDATE memories SET content=? WHERE id=?")
					.run("After dashboard repair.", x.id);
				writer
					.prepare(`INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
                    VALUES (?, 1, 0, ?) ON CONFLICT(project_path) DO UPDATE SET
                    project_memory_epoch = project_memory_epoch + 1, updated_at = excluded.updated_at`)
					.run(f.projectPath, Date.now());
			} finally {
				writer.close();
			}
			const folded = pass(host, f, a, false);
			expect(folded.hard).toBe(true);
			expect(folded.m0).not.toBe(before.m0);
			expect(folded.m0).toContain("After dashboard repair.");
			expect(pass(host, f, a, true).hard).toBe(false);
		} finally {
			f.close();
		}
	});
	test(`${host} r5 c independent history pressure backstop still refolds`, () => {
		const f = setup(host, "pressure");
		try {
			const [a] = f.sessions;
			const comp = (n: number, content: string) => ({
				sequence: n,
				startMessage: n,
				endMessage: n,
				startMessageId: `m${n}`,
				endMessageId: `m${n}`,
				title: `Section ${n}`,
				content,
				p1: content,
			});
			appendCompartments(f.db, a, [comp(0, "Ax")]);
			hard(host, f, a, 8000, 60);
			const before = pass(host, f, a, false, 8000, 60);
			appendCompartments(f.db, a, [
				comp(1, "Bravo delta with enough words to consume tokens"),
				comp(2, "Charlie delta with more words again to consume more tokens"),
				comp(3, "Delta delta even more words here for tokens and tokens"),
			]);
			const folded = pass(host, f, a, true, 8000, 60);
			expect(folded.hard).toBe(true);
			expect(folded.m0).not.toBe(before.m0);
			expect(folded.m1).not.toContain("Bravo delta");
		} finally {
			f.close();
		}
	});
	test(`${host} r5 e legacy multiline visibility and fresh recovery follow actually served revision`, () => {
		const f = setup(host, "old-visibility");
		const [a] = f.sessions;
		try {
			const x = row(
				f,
				"First line of complete memory.\nSecond line of complete memory.",
			);
			hard(host, f, a);
			const served = pass(host, f, a, false);
			f.db
				.prepare("DELETE FROM memory_applied_snapshots WHERE session_id=?")
				.run(a);
			f.db.prepare("DELETE FROM memory_applied_rows WHERE session_id=?").run(a);
			expect(getVisibleMemoryIds(f.db, a)?.has(x.id)).toBe(true);
			automated(
				f,
				x.id,
				"Changed current multiline rule.\nDifferent complete second line.",
			);
			expect(getVisibleMemoryIds(f.db, a)?.has(x.id) ?? false).toBe(false);
			recordServedRecoveryTexts(a, [served.m0, served.m1]);
			expect(getVisibleMemoryIds(f.db, a)?.has(x.id) ?? false).toBe(false);
			hard(host, f, a);
			const recovery = pass(host, f, a, false);
			recordServedRecoveryTexts(a, [recovery.m0, recovery.m1]);
			expect(getVisibleMemoryIds(f.db, a)?.has(x.id)).toBe(true);
			const truncated = recovery.m0.replace(
				"Different complete second line.",
				"",
			);
			recordServedRecoveryTexts(a, [truncated, recovery.m1]);
			expect(getVisibleMemoryIds(f.db, a)?.has(x.id) ?? false).toBe(false);
		} finally {
			clearServedRecoveryTexts(a);
			f.close();
		}
	});
}

function postArgs(
	f: ProjectionFixture,
	s: string,
	id: string,
	busting: boolean,
): Parameters<typeof runPostTransformPhase>[0] {
	return {
		sessionId: s,
		db: f.db,
		messages: [
			{
				info: { id, role: "user" },
				parts: [{ type: "text", text: "Explain cache ownership" }],
			},
		],
		tags: [],
		targets: new Map(),
		reasoningByMessage: new Map(),
		messageTagNumbers: new Map(),
		tagger: createTagger(),
		ctxReduceAvailability: { callable: true, frozen: true },
		todowriteAvailability: { callable: true, frozen: true },
		batch: null,
		contextUsage: { percentage: 20, inputTokens: 1000 },
		usableWindow: 128000,
		schedulerDecision: busting ? "execute" : "defer",
		schedulerDeferReason: "scheduler_defer",
		fullFeatureMode: true,
		canRunCompartments: false,
		awaitedCompartmentRun: false,
		phaseJustAwaitedPublication: false,
		compartmentInProgress: false,
		historyRefreshExplicitBeforePrepare: false,
		deferredHistoryWasPendingAtPassStart: false,
		compartmentInjectionRebuiltFromDb: false,
		rebuiltHistoryFromInitialPrepare: false,
		historyRebuiltThisPass: false,
		canConsumeDeferredLate: false,
		sessionMeta: getOrCreateSessionMeta(f.db, s),
		currentTurnId: id,
		pendingMaterializationSessions: new Set(),
		deferredHistoryRefreshSessions: new Set(),
		deferredMaterializationSessions: new Set(),
		lastHeuristicsTurnId: new Map(),
		clearReasoningAge: 999,
		protectedTagIds: new Set(),
		protectedTagNumbers: new Set(),
		protectedCutoff: null,
		protectedCount: 0,
		pendingCompartmentInjection: null,
		didMutateFromFlushedStatuses: false,
		watermark: 0,
		forceMaterializationPercentage: 85,
		hasRecentReduceCall: false,
		projectPath: f.projectPath,
		autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 },
		m0M1: args(f, s),
	};
}
function hostHintPass(host: HarnessId, f: ProjectionFixture, s: string) {
	if (host !== "pi")
		return async (id: string, busting: boolean) => {
			const input = postArgs(f, s, id, busting);
			input.m0M1 = {
				...args(f, s),
				hardSignals: {
					...args(f, s).hardSignals,
					modelKey: busting ? "anthropic/other" : "anthropic/claude",
				},
			};
			await runPostTransformPhase(input);
			return input.messages
				.flatMap((m) => m.parts.map((p) => (p as { text?: string }).text ?? ""))
				.join("\n");
		};
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db: f.db,
		protectedTags: 0,
		injection: { injectionBudgetTokens: 8000, injectDocs: false },
		autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 },
	});
	const handler = required(fake.handlers.get("context"));
	return async (id: string, busting: boolean) => {
		const messages = [userMessage("Explain cache ownership", 1)];
		const percent = busting ? 80 : 20;
		const context = {
			...fakeContext(s, f.directory, [id], messages),
			model: {
				provider: "anthropic",
				id: busting ? "other" : "claude",
				contextWindow: 128000,
			},
			getContextUsage: () => ({
				tokens: percent * 1000,
				percent,
				contextWindow: 128000,
			}),
		};
		const result = (await handler({ messages } as never, context as never)) as
			| { messages?: typeof messages }
			| undefined;
		return (result?.messages ?? messages).map(textOf).join("\n");
	};
}
for (const host of hosts) {
	test(`${host} r5 a full host processor cannot retry a served search exception`, async () => {
		const f = setup(host, "host-exception");
		const [a] = f.sessions;
		if (host === "pi")
			f.projectPath = required(resolveProjectIdentityForSession(f.directory));
		const h = hintFixture(host, f, a);
		const invoke = hostHintPass(host, f, a);
		try {
			h.search.mockImplementationOnce(async () => {
				throw new Error("Independent transient host-search error");
			});
			const first = await invoke("u1", false);
			expect(first).not.toContain("<ctx-search-hint>");
			expect(h.search).toHaveBeenCalledTimes(1);
			const second = await invoke("u1", false);
			expect(second).not.toContain("<ctx-search-hint>");
			expect(h.search).toHaveBeenCalledTimes(1);
		} finally {
			h.close();
			clearContextHandlerSession(a);
			f.close();
		}
	});
	test(`${host} r5 a full host processor preserves a served hint when a truncated branch is restored`, async () => {
		const f = setup(host, "host-revert-gc");
		const [a] = f.sessions;
		if (host === "pi")
			f.projectPath = required(resolveProjectIdentityForSession(f.directory));
		const h = hintFixture(host, f, a);
		const invoke = hostHintPass(host, f, a);
		try {
			const first = await invoke("u1", false);
			expect(first).toContain("Independent search-only hint");
			await invoke("u2", true);
			expect(
				getAutoSearchHintDecisions(f.db, a).some((d) => d.messageId === "u1"),
			).toBe(false);
			h.search.mockResolvedValue([
				{
					source: "memory",
					content: "Recomputed changed hint",
					score: 0.95,
					memoryId: 9001,
					category: "ARCHITECTURE",
					matchType: "fts",
				},
			]);
			const restored = await invoke("u1", false);
			expect(restored).toContain("Independent search-only hint");
			expect(restored).not.toContain("Recomputed changed hint");
			expect(h.search).toHaveBeenCalledTimes(2);
		} finally {
			h.close();
			clearContextHandlerSession(a);
			f.close();
		}
	});
}

for (const host of hosts)
	test(`${host} r5 e forty-two-source merge traces one whole operation and folds its survivor once`, () => {
		const f = setup(host, "large-merge");
		try {
			const [a] = f.sessions;
			const rows = Array.from({ length: 42 }, (_, i) =>
				row(f, `Multi-source rule ${i}.`),
			);
			hard(host, f, a);
			const ids = rows.map((r) => r.id);
			const receipt = edit(
				f,
				a,
				"merge",
				ids,
				"One final large-merge survivor.",
				"r5-large-merge",
			);
			expect(receipt.state).toBe("applied");
			expect(
				edit(
					f,
					a,
					"merge",
					ids,
					"One final large-merge survivor.",
					"r5-large-merge",
				),
			).toEqual(receipt);
			const soft = pass(host, f, a, true);
			expect(soft.hard).toBe(false);
			expect(soft.m1).toContain("<stale-memory");
			expect(soft.m1).not.toContain("<superseded");
			expect(soft.m1).not.toContain("One final large-merge survivor.");
			expect(pass(host, f, a, false)).toEqual(soft);
			hard(host, f, a);
			const folded = pass(host, f, a, false);
			expect(folded.m0.match(/One final large-merge survivor\./g)).toHaveLength(
				1,
			);
			expect(folded.m0).not.toContain("Multi-source rule");
			expect(folded.m1).not.toContain("<stale-memory");
		} finally {
			f.close();
		}
	});
