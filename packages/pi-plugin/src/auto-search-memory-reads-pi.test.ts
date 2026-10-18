import { expect, spyOn, test } from "bun:test";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	createProjectionFixture,
	isDashboardPayloadRead,
} from "@magic-context/core/shared/memory-projection-fixtures.test";
import * as autoSearchPi from "./auto-search-pi";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

/**
 * Automatic search reads canonical memory only to compute a new hint for a user
 * message. Replaying a previously decided hint reads no canonical rows or log
 * heads. A separately authorized delta refresh may read immutable dashboard
 * payloads, but search hints never rewrite the cached baseline or delta blocks.
 */
for (const busting of [false, true])
	test(`a Pi ${busting ? "busting" : "defer"} context pass reads memory only when automatic search computes a new hint`, async () => {
		const f = createProjectionFixture(
			`pi-auto-search-${busting}`,
			createTestDb,
		);
		const seen: string[] = [];
		let observing = false;
		const prepare = f.db.prepare.bind(f.db);
		Object.defineProperty(f.db, "prepare", {
			configurable: true,
			writable: true,
			value: (sql: string) => {
				const statement = prepare(sql);
				if (/\b(?:FROM|JOIN)\s+(?:memories|memory_mutation_log)\b/i.test(sql))
					for (const method of ["get", "all", "values", "iterate"] as const) {
						const original = (statement as unknown as Record<string, unknown>)[
							method
						];
						if (typeof original !== "function") continue;
						Object.defineProperty(statement, method, {
							configurable: true,
							value: (...args: unknown[]) => {
								if (observing) seen.push(sql);
								return (original as (...a: unknown[]) => unknown).apply(
									statement,
									args,
								);
							},
						});
					}
				return statement;
			},
		});
		const [a] = f.sessions;
		const fake = createFakePi();
		let computeNewHint = false;
		const search = spyOn(
			autoSearchPi,
			"runAutoSearchHintForPi",
		).mockImplementation(async (input) => {
			// A replayed decision never asks for visibility; a new hint does.
			expect(input.options.visibleMemoryIds).toBeUndefined();
			if (computeNewHint) input.options.resolveVisibleMemoryIds?.();
			return input.messages;
		});
		try {
			const projectPath = resolveProjectIdentityForSession(f.directory);
			expect(projectPath).toBeTruthy();
			insertMemory(f.db, {
				projectPath: projectPath as string,
				category: "ARCHITECTURE",
				content: "Pi served text for automatic visibility.",
			});
			registerPiContextHandler(fake.pi as never, {
				db: f.db,
				protectedTags: 0,
				injection: { injectionBudgetTokens: 8000, injectDocs: false },
				autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 },
			});
			const handler = fake.handlers.get("context");
			expect(handler).toBeDefined();
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
				return await handler?.({ messages } as never, context as never);
			};
			await invoke(20);
			search.mockClear();
			const m0 = () =>
				f.db
					.prepare(
						"SELECT cached_m0_bytes FROM session_meta WHERE session_id=?",
					)
					.get(a);
			const before = m0();

			observing = true;
			await invoke(busting ? 80 : 20);
			observing = false;
			expect(m0()).toEqual(before);
			expect(search).toHaveBeenCalledTimes(1);
			expect(seen.filter((sql) => !isDashboardPayloadRead(sql))).toEqual([]);

			computeNewHint = true;
			observing = true;
			await invoke(busting ? 80 : 20);
			observing = false;
			expect(seen.length).toBeGreaterThan(0);
			expect(seen.some((sql) => /FROM memories/i.test(sql))).toBe(true);
			expect(
				seen.every(
					(sql) => /FROM memories/i.test(sql) || isDashboardPayloadRead(sql),
				),
			).toBe(true);
			expect(m0()).toEqual(before);
		} finally {
			search.mockRestore();
			clearContextHandlerSession(a);
			f.close();
		}
	});
