// Opt-in review evidence: run with `bun test ./docs/reports/probes/memory-s3-r4.probe.ts`.
// These assertions pin the requested contract, including deliberately red witnesses.

import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as autoSearchPi from "../../../packages/pi-plugin/src/auto-search-pi";
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
	userMessage,
} from "../../../packages/pi-plugin/src/test-utils.test";
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
	MIGRATIONS,
	runMigrations,
} from "../../../packages/plugin/src/features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../../packages/plugin/src/features/magic-context/storage";
import { initializeDatabase } from "../../../packages/plugin/src/features/magic-context/storage-db";
import { createTagger } from "../../../packages/plugin/src/features/magic-context/tagger";
import * as autoSearch from "../../../packages/plugin/src/hooks/magic-context/auto-search-runner";
import {
	getVisibleMemoryIds,
	injectM0M1,
	materializeM0,
} from "../../../packages/plugin/src/hooks/magic-context/inject-compartments";
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
function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined)
		throw new Error("Review fixture prerequisite is absent");
	return value;
}
function setup(host: HarnessId, label: string) {
	_resetHarnessForTesting();
	setHarness(host);
	return createProjectionFixture(`${host}-r4-${label}`);
}
function args(f: ProjectionFixture, s: string, memoryBudget = 8000) {
	return {
		db: f.db,
		state: getOrCreateSessionMeta(f.db, s),
		sessionId: s,
		projectPath: f.projectPath,
		projectDirectory: f.directory,
		injectDocs: false,
		memoryInjectionBudgetTokens: memoryBudget,
		historyBudgetTokens: 60000,
		hardSignals: {
			systemHash: "system",
			modelKey: "anthropic/claude",
			cacheExpired: false,
			lastResponseTime: 1,
		},
	};
}
function piArgs(f: ProjectionFixture, s: string, budget: number) {
	return {
		sessionId: s,
		projectIdentity: f.projectPath,
		projectDirectory: f.directory,
		injectDocs: false,
		injectionBudgetTokens: budget,
		historyBudgetTokens: 60000,
		hardSignals: args(f, s).hardSignals,
	};
}
function hard(host: HarnessId, f: ProjectionFixture, s: string, budget = 8000) {
	if (host === "pi") materializeM0Pi(piArgs(f, s, budget), f.db);
	else materializeM0(args(f, s, budget));
}
function pass(
	host: HarnessId,
	f: ProjectionFixture,
	s: string,
	busting: boolean,
	budget = 8000,
) {
	if (host !== "pi") {
		const r = injectM0M1({
			...args(f, s, budget),
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
		piArgs(f, s, budget),
		f.db,
		messages,
		undefined,
		busting,
	);
	const text = (m: unknown) => {
		const c = (m as { content: unknown }).content;
		return typeof c === "string"
			? c
			: (c as { type: string; text?: string }[])
					.filter((p) => p.type === "text")
					.map((p) => p.text ?? "")
					.join("");
	};
	return {
		m0: text(messages[0]),
		m1: text(messages[1]),
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
function automated(f: ProjectionFixture, id: number, text: string) {
	const before = required(getMemoryById(f.db, id));
	updateMemoryContent(f.db, id, text, computeNormalizedHash(text));
	recordAutomatedMemoryEdit(f.db, {
		writer: "verify",
		before,
		reason: "verify_update",
	});
}
function observer(f: ProjectionFixture) {
	const seen: string[] = [];
	let on = false;
	const prepare = f.db.prepare.bind(f.db);
	Object.defineProperty(f.db, "prepare", {
		configurable: true,
		value: (sql: string) => {
			const st = prepare(sql);
			if (/\b(?:FROM|JOIN)\s+(?:memories|memory_mutation_log)\b/i.test(sql))
				for (const method of ["get", "all", "values", "iterate"] as const) {
					const original = (st as unknown as Record<string, unknown>)[method];
					if (typeof original !== "function") continue;
					Object.defineProperty(st, method, {
						configurable: true,
						value: (...a: unknown[]) => {
							if (on) seen.push(sql);
							return original.apply(st, a);
						},
					});
				}
			return st;
		},
	});
	return {
		seen,
		start: () => {
			seen.length = 0;
			on = true;
		},
		stop: () => {
			on = false;
		},
	};
}
for (const host of hosts) {
	test(`${host} r4 strict SOFT gate includes memory and log watermark SELECTs`, () => {
		const f = setup(host, "strict-gate");
		const o = observer(f);
		try {
			row(f, "strict gate baseline");
			hard(host, f, f.sessions[0]);
			o.start();
			const soft = pass(host, f, f.sessions[0], true);
			o.stop();
			expect(soft.hard).toBe(false);
			expect(o.seen).toEqual([]);
		} finally {
			f.close();
		}
	});
	test(`${host} r4 randomized 180-round replay preserves own receipts and ignores foreign HARDs`, () => {
		const f = setup(host, "random");
		try {
			const [a, b] = f.sessions;
			const baseline = row(f, "Random baseline.");
			hard(host, f, a);
			hard(host, f, b);
			let shown = pass(host, f, a, true);
			let seed = 0x5a17;
			let active = [baseline.id];
			let own = 0;
			let foreign = 0;
			const random = () => {
				seed ^= seed << 13;
				seed ^= seed >>> 17;
				seed ^= seed << 5;
				return seed >>> 0;
			};
			for (let i = 0; i < 180; i++) {
				const action = i < 8 ? i : random() % 8;
				const before = shown;
				const target = required(active[random() % active.length]);
				let unchanged = false;
				switch (action) {
					case 0:
					case 1: {
						const text =
							action === 0
								? `Own save ${i}.`
								: `Own oversized save ${i}. ${"detail ".repeat(1800)}`;
						const r = save(f, a, text);
						expect(r.state).toBe("applied");
						active.push(required(r.memoryId));
						own++;
						break;
					}
					case 2:
						expect(
							edit(f, a, "update", [target], `Own updated ${i}.`).state,
						).toBe("applied");
						own++;
						break;
					case 3:
						if (active.length >= 2) {
							const ids = active.slice(0, 2);
							const r = edit(f, a, "merge", ids, `Own merge ${i}.`);
							expect(r.state).toBe("applied");
							active = active.filter((id) => !ids.includes(id));
							active.push(required(r.memoryId));
							own++;
						} else unchanged = true;
						break;
					case 4:
						if (active.length >= 3) {
							const ids = active.slice(0, 2);
							expect(edit(f, a, "archive", ids).state).toBe("applied");
							active = active.filter((id) => !ids.includes(id));
							own++;
						} else unchanged = true;
						break;
					case 5:
						automated(f, target, `Automated rule ${i}.`);
						foreign++;
						unchanged = true;
						break;
					case 6:
						save(f, b, `Foreign save ${i}.`);
						hard(host, f, b);
						foreign++;
						unchanged = true;
						break;
					case 7:
						unchanged = true;
						break;
				}
				expect(pass(host, f, a, false)).toEqual(before);
				f.gate.blocking = true;
				try {
					shown = pass(host, f, a, true);
				} finally {
					f.gate.blocking = false;
				}
				expect(shown.hard).toBe(false);
				expect(shown.m0).toBe(before.m0);
				if (unchanged) expect(shown).toEqual(before);
				expect(shown.m1).not.toContain("Automated rule");
				expect(shown.m1).not.toContain("Foreign save");
				const receipt = (text: string) =>
					text.match(
						/ {2}<(?:added|updated|removed|superseded|stale-memory)[^\n]*/g,
					) ?? [];
				for (const r of receipt(before.m1)) expect(shown.m1).toContain(r);
				expect(pass(host, f, a, true)).toEqual(shown);
				expect(pass(host, f, a, false)).toEqual(shown);
			}
			expect(own).toBeGreaterThan(50);
			expect(foreign).toBeGreaterThan(15);
			expect(f.gate.blocked).toEqual([]);
			hard(host, f, a);
			const folded = pass(host, f, a, false);
			expect(folded.m1).not.toContain("<stale-memory");
			expect(folded.m1).not.toContain("<added");
		} finally {
			f.close();
		}
	});
	test(`${host} r4 full allowance still gives an oversized operation a marker`, () => {
		const f = setup(host, "no-marker-room");
		try {
			const [a] = f.sessions;
			const m = row(f, "Marker baseline.");
			hard(host, f, a, 500);
			expect(pass(host, f, a, false, 500).m0).toContain(m.content);
			for (let i = 0; i < 20; i++) {
				expect(
					edit(f, a, "update", [m.id], `Adopted receipt ${i}.`).state,
				).toBe("applied");
				const receipt = pass(host, f, a, true, 500);
				expect(receipt.hard).toBe(false);
				if (i === 0) expect(receipt.m1).toContain("Adopted receipt 0.");
			}
			const before = pass(host, f, a, false, 500);
			const oversized = save(f, a, "oversized ".repeat(500));
			expect(oversized.state).toBe("applied");
			const p = pass(host, f, a, true, 500);
			expect(p.hard).toBe(false);
			expect(p.m1).toContain("Adopted receipt 0.");
			expect(pass(host, f, a, false, 500)).toEqual(p);
			expect(p.m0).toBe(before.m0);
			expect(p.m1).toContain(`<stale-memory ids="${oversized.memoryId}"`);
		} finally {
			f.close();
		}
	});
	test(`${host} r4 merge into an unshown existing survivor shows the survivor text`, () => {
		const f = setup(host, "unshown-survivor");
		try {
			const [a] = f.sessions;
			hard(host, f, a);
			const x = row(f, "Foreign source.");
			const y = row(f, "Existing survivor never shown.");
			const r = edit(f, a, "merge", [x.id, y.id], y.content);
			expect(r.state).toBe("applied");
			const p = pass(host, f, a, true);
			expect(p.hard).toBe(false);
			expect(p.m1).toContain(`<superseded id="${x.id}" by="${y.id}"/>`);
			expect(p.m1).toContain(y.content);
		} finally {
			f.close();
		}
	});
	test(`${host} r4 explicit agent save of an unshown duplicate reaches its session`, () => {
		const f = setup(host, "duplicate");
		try {
			const [a] = f.sessions;
			hard(host, f, a);
			const x = row(f, "Unshown duplicate manual save.");
			const r = save(f, a, x.content);
			expect(r.state).toBe("applied");
			expect(r.memoryId).toBe(x.id);
			const p = pass(host, f, a, true);
			expect(p.hard).toBe(false);
			expect(p.m1).toContain(x.content);
		} finally {
			f.close();
		}
	});
	test(`${host} r4 multi-row archive is one immutable operation and retry folds once`, () => {
		const f = setup(host, "atomic");
		try {
			const [a] = f.sessions;
			const rows = Array.from({ length: 42 }, (_, i) =>
				row(f, `Archive source ${i}.`),
			);
			hard(host, f, a);
			const r = edit(
				f,
				a,
				"archive",
				rows.map((r) => r.id),
				undefined,
				"atomic-42",
			);
			expect(r.state).toBe("applied");
			expect(
				edit(
					f,
					a,
					"archive",
					rows.map((r) => r.id),
					undefined,
					"atomic-42",
				),
			).toEqual(r);
			expect(
				f.db
					.prepare(
						"SELECT COUNT(*) AS n FROM memory_agent_fragments WHERE operation_key='atomic-42'",
					)
					.get(),
			).toEqual({ n: 1 });
			expect(
				f.db
					.prepare(
						"SELECT COUNT(*) AS n FROM memory_mutation_log WHERE operation_id='atomic-42'",
					)
					.get(),
			).toEqual({ n: 42 });
			const p = pass(host, f, a, true);
			expect(p.hard).toBe(false);
			expect(p.m1).toContain("<stale-memory");
			expect(p.m1).not.toContain("<removed");
			expect(pass(host, f, a, true)).toEqual(p);
			hard(host, f, a);
			const h = pass(host, f, a, false);
			expect(h.m0).not.toContain("Archive source");
			expect(h.m1).not.toContain("<stale-memory");
		} finally {
			f.close();
		}
	});
}

function postArgs(
	f: ProjectionFixture,
	s: string,
	busting: boolean,
): Parameters<typeof runPostTransformPhase>[0] {
	return {
		sessionId: s,
		db: f.db,
		messages: [
			{
				info: { id: "fresh-user", role: "user" },
				parts: [{ type: "text", text: "ordinary append" }],
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
		currentTurnId: "fresh-user",
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
for (const host of ["opencode", "opencode2"] as const)
	for (const busting of [false, true]) {
		test(`${host} r4 ${busting ? "SOFT+" : "SOFT/defer"} postprocess auto-search reads no canonical text`, async () => {
			const f = setup(host, `post-${busting}`);
			const o = observer(f);
			const search = spyOn(autoSearch, "runAutoSearchHint").mockResolvedValue({
				ok: false,
				kind: "timeout",
			});
			try {
				const [a] = f.sessions;
				row(f, "Served text for automatic visibility.");
				hard(host, f, a);
				o.start();
				const result = await runPostTransformPhase(postArgs(f, a, busting));
				o.stop();
				expect(result.materialized).toBe(false);
				expect(search).toHaveBeenCalledTimes(1);
				expect(
					o.seen.filter((sql) =>
						/SELECT id, content, status FROM memories/i.test(sql),
					),
				).toEqual([]);
			} finally {
				search.mockRestore();
				f.close();
			}
		});
	}

for (const busting of [false, true])
	test(`pi r4 ${busting ? "SOFT+" : "SOFT/defer"} context handler auto-search reads no canonical text`, async () => {
		const f = setup("pi", `handler-${busting}`);
		const o = observer(f);
		const [a] = f.sessions;
		const fake = createFakePi();
		const search = spyOn(
			autoSearchPi,
			"runAutoSearchHintForPi",
		).mockImplementation(async (input) => input.messages);
		try {
			f.projectPath = required(resolveProjectIdentityForSession(f.directory));
			expect(f.projectPath).toBeTruthy();
			row(f, "Pi served text for automatic visibility.");
			registerPiContextHandler(fake.pi as never, {
				db: f.db,
				protectedTags: 0,
				injection: { injectionBudgetTokens: 8000, injectDocs: false },
				autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 },
			});
			const handler = required(fake.handlers.get("context"));
			const invoke = async (percent: number) => {
				const messages = [userMessage("ordinary fresh append", 1)];
				const context = {
					...fakeContext(a, f.directory, ["entry-1"], messages),
					model: { provider: "anthropic", id: "claude", contextWindow: 128000 },
					getContextUsage: () => ({
						tokens: percent * 1000,
						percent,
						contextWindow: 128000,
					}),
				};
				return await handler({ messages } as never, context as never);
			};
			await invoke(20);
			search.mockClear();
			const before = f.db
				.prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id=?")
				.get(a);
			o.start();
			await invoke(busting ? 80 : 20);
			o.stop();
			expect(
				f.db
					.prepare(
						"SELECT cached_m0_bytes FROM session_meta WHERE session_id=?",
					)
					.get(a),
			).toEqual(before);
			expect(search).toHaveBeenCalledTimes(1);
			expect(
				o.seen.filter((sql) =>
					/SELECT id, content, status FROM memories/i.test(sql),
				),
			).toEqual([]);
		} finally {
			search.mockRestore();
			clearContextHandlerSession(a);
			f.close();
		}
	});
for (const host of hosts)
	test(`${host} r4 populated v98-shaped cache preserves nonempty multiline memory bytes on first SOFT`, () => {
		const f = setup(host, "v98");
		try {
			const [a] = f.sessions;
			const x = row(f, "Legacy original rule.");
			hard(host, f, a);
			const old = `<session-history-since>\n<memory-updates>\nThese memories changed since the snapshot below — trust these:\n  <updated id="${x.id}" category="ARCHITECTURE">Legacy complete correction.\nSecond line preserved.</updated>\n</memory-updates>\n<new-memories>\n#999 [ARCHITECTURE]: Legacy addition.\n</new-memories>\n</session-history-since>`;
			f.db
				.prepare("UPDATE session_meta SET cached_m1_bytes=? WHERE session_id=?")
				.run(Buffer.from(old), a);
			const lifecycle = [
				"memory_fact_block_links",
				"memory_pending_facts",
				"memory_fact_blocks",
				"memory_publications",
				"memory_history",
				"memory_journal",
				"memory_clause_evidence",
				"memory_successor_links",
				"memory_conflict_links",
				"memory_classification_items",
				"memory_tool_proposals",
				"memory_stage_attempts",
				"memory_check_attempts",
				"memory_decision_receipts",
				"memory_activity_ledger",
				"memory_applied_rows",
				"memory_applied_snapshots",
				"memory_agent_fragments",
			];
			for (const table of lifecycle) f.db.exec(`DROP TABLE ${table}`);
			for (const col of [
				"revision",
				"verify_result",
				"verify_files_json",
				"verify_commit",
			])
				f.db.exec(`ALTER TABLE memories DROP COLUMN ${col}`);
			f.db.exec(
				"DROP INDEX idx_memory_mutation_log_operation;ALTER TABLE memory_mutation_log DROP COLUMN operation_id;DELETE FROM schema_migrations WHERE version>=99",
			);
			const before = pass(host, f, a, false);
			expect(before.m1).toBe(old);
			required(MIGRATIONS.find((m) => m.version === 99)).up(f.db);
			f.db
				.prepare(
					"INSERT INTO schema_migrations(version,description,applied_at) VALUES(99,'review upgrade',0)",
				)
				.run();
			automated(f, x.id, "Canonical changed after cached correction.");
			f.gate.blocking = true;
			let after: ReturnType<typeof pass>;
			try {
				after = pass(host, f, a, true);
			} finally {
				f.gate.blocking = false;
			}
			expect(after).toEqual(before);
			expect(after.m1).not.toContain("stale-memory");
			expect(getVisibleMemoryIds(f.db, a)?.has(x.id) ?? false).toBe(false);
			const r = save(f, a, "First post-upgrade own fragment.");
			expect(r.state).toBe("applied");
			const next = pass(host, f, a, true);
			expect(next.m0).toBe(before.m0);
			expect(next.m1).toContain(
				"Legacy complete correction.\nSecond line preserved.",
			);
			expect(next.m1).toContain("Legacy addition.");
			expect(next.m1).toContain("First post-upgrade own fragment.");
		} finally {
			f.close();
		}
	});

test("r4 generated context schema matches committed Rust fixture", () => {
	const generated = Bun.spawnSync(
		["bun", "scripts/dump-context-db-schema.ts"],
		{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
	);
	expect(generated.exitCode).toBe(0);
	const fixture = readFileSync(
		"crates/mc-module/tests/fixtures/context-db-schema.sql",
		"utf8",
	);
	expect(generated.stdout.toString()).toBe(fixture);
});

for (const host of hosts)
	test.skipIf(!process.env.MC_R4_V98_EXPORT)(
		`${host} r4 actual old renderer cache survives populated v98 upgrade`,
		async () => {
			const root = required(process.env.MC_R4_V98_EXPORT);
			const oldDbModule = await import(
				`${root}/packages/plugin/src/features/magic-context/storage-db.ts`
			);
			const oldSqlite = await import(
				`${root}/packages/plugin/src/shared/sqlite.ts`
			);
			const oldMigrations = await import(
				`${root}/packages/plugin/src/features/magic-context/migrations.ts`
			);
			const oldStorage = await import(
				`${root}/packages/plugin/src/features/magic-context/storage.ts`
			);
			const oldMemory = await import(
				`${root}/packages/plugin/src/features/magic-context/memory/storage-memory.ts`
			);
			const oldHarness = await import(
				`${root}/packages/plugin/src/shared/harness.ts`
			);
			oldHarness._resetHarnessForTesting();
			oldHarness.setHarness(host);
			_resetHarnessForTesting();
			setHarness(host);
			const directory = mkdtempSync(
				join(tmpdir(), `r4-actual-upgrade-${host}-`),
			);
			const path = join(directory, "context.db");
			const oldDb = new oldSqlite.Database(path);
			let currentDb: Database | undefined;
			try {
				oldDbModule.initializeDatabase(oldDb);
				oldMigrations.runMigrations(oldDb);
				expect(
					oldDb
						.prepare("SELECT MAX(version) AS version FROM schema_migrations")
						.get(),
				).toEqual({ version: 97 });
				required(MIGRATIONS.find((m) => m.version === 98)).up(oldDb);
				oldDb
					.prepare(
						"INSERT INTO schema_migrations(version,description,applied_at) VALUES(98,'v98 before memory projection',0)",
					)
					.run();
				const sessionId = `actual-v98-${host}`;
				const projectPath = "git:r4-upgrade";
				const m = oldMemory.insertMemory(oldDb, {
					projectPath,
					category: "ARCHITECTURE",
					content: "Actual old baseline.",
					importance: 50,
				});
				oldStorage.getOrCreateSessionMeta(oldDb, sessionId);
				const f = {
					db: oldDb,
					directory,
					projectPath,
					sessions: [sessionId, "other"],
					gate: { blocking: false, blocked: [] },
					close: () => {},
				} as ProjectionFixture;
				let before: { m0: string; m1: string };
				if (host !== "pi") {
					const renderer = await import(
						`${root}/packages/plugin/src/hooks/magic-context/inject-compartments.ts`
					);
					renderer.materializeM0(args(f, sessionId));
					oldMemory.updateMemoryContent(
						oldDb,
						m.id,
						"Actual old correction.\nWith complete second line.",
						computeNormalizedHash(
							"Actual old correction.\nWith complete second line.",
						),
					);
					oldStorage.queueMemoryMutation(oldDb, {
						projectPath,
						mutationType: "update",
						targetMemoryId: m.id,
						category: "ARCHITECTURE",
						newContent: "Actual old correction.\nWith complete second line.",
					});
					const r = renderer.injectM0M1({
						...args(f, sessionId),
						isCacheBustingPass: true,
					});
					before = { m0: r.m0Bytes.toString("utf8"), m1: r.m1Text };
				} else {
					const renderer = await import(
						`${root}/packages/pi-plugin/src/inject-compartments-pi.ts`
					);
					renderer.materializeM0Pi(piArgs(f, sessionId, 8000), oldDb);
					oldMemory.updateMemoryContent(
						oldDb,
						m.id,
						"Actual old correction.\nWith complete second line.",
						computeNormalizedHash(
							"Actual old correction.\nWith complete second line.",
						),
					);
					oldStorage.queueMemoryMutation(oldDb, {
						projectPath,
						mutationType: "update",
						targetMemoryId: m.id,
						category: "ARCHITECTURE",
						newContent: "Actual old correction.\nWith complete second line.",
					});
					const messages: Parameters<typeof injectM0M1Pi>[2] = [];
					renderer.injectM0M1Pi(
						piArgs(f, sessionId, 8000),
						oldDb,
						messages,
						undefined,
						true,
					);
					const text = (message: unknown) => {
						const content = (message as { content: unknown }).content;
						return typeof content === "string"
							? content
							: (content as { type: string; text?: string }[])
									.filter((p) => p.type === "text")
									.map((p) => p.text ?? "")
									.join("");
					};
					before = { m0: text(messages[0]), m1: text(messages[1]) };
				}
				expect(before.m0).toContain("Actual old baseline.");
				expect(before.m1).toContain(
					"Actual old correction.\nWith complete second line.",
				);
				expect(
					oldDb
						.prepare("SELECT MAX(version) AS version FROM schema_migrations")
						.get(),
				).toEqual({ version: 98 });
				oldDb.close();
				currentDb = new Database(path);
				initializeDatabase(currentDb);
				runMigrations(currentDb);
				f.db = currentDb;
				const defer = pass(host, f, sessionId, false);
				expect(defer).toEqual({ ...before, hard: false });
				const soft = pass(host, f, sessionId, true);
				expect(soft).toEqual(defer);
				expect(soft.m1).not.toContain("stale-memory");
			} finally {
				try {
					oldDb.close();
				} catch {}
				currentDb?.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
