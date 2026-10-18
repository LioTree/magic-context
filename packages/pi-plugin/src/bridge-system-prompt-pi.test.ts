import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPluginConfigDetailed } from "@magic-context/core/config";
import { openDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta";
import { createBridgeDeps } from "@magic-context/core/hooks/magic-context/host-runner/bridge-deps";
import { createBridgeHostFacts } from "@magic-context/core/hooks/magic-context/host-runner/bridge-host-facts";
import { InjectedBridgeTransport } from "@magic-context/core/hooks/magic-context/host-runner/injected-transport";
import { Database } from "@magic-context/core/shared/sqlite";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";
import { createPiBridgeAdapter } from "./bridge-adapter-pi";
import magicContextPiExtension from "./index";
import { clearPiSystemPromptSession } from "./system-prompt";
import { createTestDb } from "./test-utils.test";

// The host renderer is a test oracle only, not a supported production deep import.
const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = await import(
	new URL("./core/system-prompt.js", import.meta.resolve("pi-coding-agent-087"))
		.href
);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) cleanupTestTempDir(root);
});

async function fixture(config: object = {}) {
	const root = createTestTempDir("pi-bridge-system-").dir;
	roots.push(root);
	mkdirSync(join(root, ".cortexkit"), { recursive: true });
	const configPath = join(root, ".cortexkit/magic-context.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			memory: { enabled: false },
			historian: { disable: true },
			dreamer: { disable: true },
			...config,
		}),
	);
	createTestDb(join(root, "context.db")).close();
	const adapter = createPiBridgeAdapter({
		projectRoot: root,
		storageDir: root,
		connectionFile: join(root, "unused.json"),
		configPath,
		reloadSession: () => ({
			readBranchEntries: () => [],
			appendCompaction() {
				throw new Error("unexpected append");
			},
		}),
		transport: {
			async request() {
				throw new Error("system prompts must not call the relay");
			},
		},
	});
	return { root, configPath, adapter };
}

async function standalone(root: string) {
	type Hook = (event: unknown, ctx: unknown) => unknown;
	const handlers = new Map<string, Hook>();
	const pi = {
		on(name: string, handler: Hook) {
			handlers.set(name, handler);
		},
		events: {
			on() {
				return () => {};
			},
		},
		registerTool() {},
		registerCommand() {},
		registerFlag() {},
		registerEntryRenderer() {},
		getActiveTools: () => [],
		setActiveTools() {},
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	const cwd = process.cwd();
	try {
		process.chdir(root);
		await magicContextPiExtension(pi);
	} finally {
		process.chdir(cwd);
	}
	return {
		async compose(
			sessionId: string,
			event: { systemPrompt: string },
			model = { provider: "fixture", id: "model" },
		) {
			const ctx = {
				cwd: root,
				hasUI: false,
				model,
				sessionManager: { getSessionId: () => sessionId },
				ui: { setStatus() {} },
			};
			const returned = await handlers.get("before_agent_start")?.(event, ctx);
			return returned &&
				typeof returned === "object" &&
				"systemPrompt" in returned &&
				typeof returned.systemPrompt === "string"
				? returned.systemPrompt
				: event.systemPrompt;
		},
		async close() {
			await handlers.get("session_shutdown")?.(
				{},
				{
					hasUI: false,
					sessionManager: { getSessionId: () => "cleanup" },
					ui: { setStatus() {} },
				},
			);
		},
	};
}
const model = { provider: "fixture", id: "model" };
const base = "Pi session.\nToday's date: 2026-10-12";

test("bridge freezes dates while warm and adopts dates on content changes and expiry", async () => {
	const { root, adapter } = await fixture();
	const db = new Database(join(root, "context.db"));
	const sessionId = "date-stability";
	getOrCreateSessionMeta(db, sessionId, "pi");
	updateSessionMeta(db, sessionId, {
		cacheTtl: "never",
		lastResponseTime: Date.now(),
	});
	const compose = (systemPrompt: string) =>
		adapter.systemPrompt({ sessionId, systemPrompt, model });
	try {
		const first = await compose(base);
		expect(await compose(base.replace("10-12", "10-13"))).toEqual(first);
		const changed = await compose(
			base.replace("Pi session.", "New identity.").replace("10-12", "10-14"),
		);
		expect(changed.systemPrompt).toContain("2026-10-14");
		await compose(
			base.replace("Pi session.", "New identity.").replace("10-12", "10-14"),
		);
		updateSessionMeta(db, sessionId, { cacheTtl: "5m", lastResponseTime: 1 });
		const expired = await compose(
			base.replace("Pi session.", "New identity.").replace("10-12", "10-15"),
		);
		expect(expired.systemPrompt).toContain("2026-10-15");
		expect(expired.digest).not.toBe(changed.digest);
		updateSessionMeta(db, sessionId, {
			cacheTtl: "never",
			lastResponseTime: Date.now(),
		});
		adapter.clearSystemPrompt(sessionId);
		expect(
			adapter.checkSystemPrompt({
				sessionId,
				systemBlocks: [expired.systemPrompt],
			}).reason,
		).toBe("system_prompt_not_prepared");
		expect(
			(
				await compose(
					base
						.replace("Pi session.", "New identity.")
						.replace("10-12", "10-16"),
				)
			).systemPrompt,
		).toContain("2026-10-16");
	} finally {
		await adapter.dispose();
		db.close();
	}
});

test("Pi bridge first-turn system prompt needs no receipt and checks actual bytes", async () => {
	const { adapter } = await fixture();
	try {
		const sessionId = "first-turn";
		expect(adapter.receipt(sessionId)).toBeUndefined();
		expect(
			adapter.checkSystemPrompt({ sessionId, systemBlocks: [base] }).reason,
		).toBe("system_prompt_not_prepared");
		const first = await adapter.systemPrompt({
			sessionId,
			systemPrompt: base,
			model,
		});
		expect(first.systemPrompt).toContain("## Magic Context");
		expect(first.force).toBe(true);
		expect(adapter.receipt(sessionId)).toBeUndefined();
		expect(
			await adapter.systemPrompt({ sessionId, systemPrompt: base, model }),
		).toEqual(first);
		expect(first.digest).toBe(
			createHash("sha256").update(first.systemPrompt).digest("hex"),
		);
		expect(
			adapter.checkSystemPrompt({
				sessionId,
				systemBlocks: [first.systemPrompt],
			}).managed,
		).toBe(true);
		expect(
			adapter.checkSystemPrompt({
				sessionId,
				systemBlocks: [`${first.systemPrompt} `],
			}),
		).toMatchObject({ managed: false, reason: "system_prompt_modified" });
		expect(
			adapter.checkSystemPrompt({
				sessionId: "other",
				systemBlocks: [first.systemPrompt],
			}).managed,
		).toBe(false);
		expect(
			await adapter.recordHostFact({
				kind: "system_prompt",
				sessionId,
				lineageId: "not-created",
				model: { providerID: "fixture", modelID: "model" },
				observedAt: 1,
				system: [base],
			}),
		).toEqual({
			accepted: false,
			reason: "use_system_prompt_before_agent_start",
		});
	} finally {
		await adapter.dispose();
	}
});

// Pi 1.3.0 keeps the leading prompt whole. These fixtures project only text,
// not Anthropic cache_control, Bedrock cachePoint, or Responses role metadata.
const providerFormats = [
	{
		name: "Anthropic OAuth Messages",
		blocks: (prompt: string) => {
			const request = {
				system: [
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
					},
					{ type: "text", text: prompt, cache_control: { type: "ephemeral" } },
				],
			};
			return request.system.map((block) => block.text);
		},
	},
	...["developer", "system"].map((role) => ({
		name: `OpenAI Responses ${role}`,
		blocks: (prompt: string) => {
			const request = {
				input: [
					{ role, content: prompt },
					{
						role,
						content:
							'Updated system prompt section "style":\n\nUse concise prose.',
					},
				],
			};
			return request.input.map((item) => item.content);
		},
	})),
	{
		name: "OpenAI Codex Responses",
		blocks: (prompt: string) => {
			// Separate updates require supportsMidConvoSystemMessages in Codex.
			const request = {
				instructions: prompt,
				input: [
					{
						role: "developer",
						content:
							'Updated system prompt section "style":\n\nUse concise prose.',
					},
				],
			};
			return [
				request.instructions,
				...request.input.map((item) => item.content),
			];
		},
	},
	{
		name: "Bedrock Converse",
		blocks: (prompt: string) => {
			const request = {
				system: [{ text: prompt }, { cachePoint: { type: "default" } }],
			};
			return request.system.flatMap((block) =>
				block.text === undefined ? [] : [block.text],
			);
		},
	},
];

for (const format of providerFormats) {
	const sessionId = "provider-blocks";
	async function prepared() {
		const { adapter } = await fixture();
		const { systemPrompt } = await adapter.systemPrompt({
			sessionId,
			systemPrompt: base,
			model,
		});
		return {
			adapter,
			systemPrompt,
			check: (systemBlocks: string[]) =>
				adapter.checkSystemPrompt({ sessionId, systemBlocks }),
		};
	}
	test(`${format.name}: accepts exact prepared block and provider-owned neighbors`, async () => {
		const { adapter, systemPrompt, check } = await prepared();
		try {
			const blocks = format.blocks(systemPrompt);
			expect(check(blocks)).toMatchObject({ managed: true, reason: undefined });
			expect(check(blocks).blockDigests).toEqual(
				blocks.map((block) => createHash("sha256").update(block).digest("hex")),
			);
			// Also admit host/provider-added text on either side; never allowlist it.
			expect(
				check(["Provider preface. 🧭", ...blocks, "Provider tail."]).managed,
			).toBe(true);
		} finally {
			await adapter.dispose();
		}
	});
	test(`${format.name}: refuses missing prepared block`, async () => {
		const { adapter, systemPrompt, check } = await prepared();
		try {
			const blocks = format
				.blocks(systemPrompt)
				.filter((b) => b !== systemPrompt);
			expect(check(blocks)).toMatchObject({
				managed: false,
				reason: "system_prompt_missing",
			});
		} finally {
			await adapter.dispose();
		}
	});
	test(`${format.name}: refuses modified prepared block`, async () => {
		const { adapter, systemPrompt, check } = await prepared();
		try {
			for (const modified of [
				`${systemPrompt} `,
				systemPrompt.replace("Pi session.", "Changed session."),
				systemPrompt.replace(/\n/g, "\r\n"),
			])
				expect(check(format.blocks(modified))).toMatchObject({
					managed: false,
					reason: "system_prompt_modified",
				});
			const split = systemPrompt.indexOf("## Magic Context");
			expect(
				check([systemPrompt.slice(0, split), systemPrompt.slice(split)]),
			).toMatchObject({
				managed: false,
				reason: "system_prompt_modified",
			});
		} finally {
			await adapter.dispose();
		}
	});
	test(`${format.name}: refuses duplicated prepared or stale MC head`, async () => {
		const { adapter, systemPrompt, check } = await prepared();
		try {
			for (const duplicate of [
				systemPrompt,
				`Wrapped ${systemPrompt} copy`,
				"## Magic Context\nStale guidance.",
				"<magic_context>Stale section</magic_context>",
			])
				expect(
					check([...format.blocks(systemPrompt), duplicate]),
				).toMatchObject({
					managed: false,
					reason: "system_prompt_duplicated",
				});
		} finally {
			await adapter.dispose();
		}
	});
	test(`${format.name}: refuses duplicated raw prompt alongside`, async () => {
		const { adapter, systemPrompt, check } = await prepared();
		try {
			for (const raw of [base, `Wrapped ${base} copy`])
				expect(check([...format.blocks(systemPrompt), raw])).toMatchObject({
					managed: false,
					reason: "system_prompt_unmanaged_alongside",
				});
		} finally {
			await adapter.dispose();
		}
	});
}

test("standalone before_agent_start and bridge compose byte-identically on Pi and Oh My Pi", async () => {
	const { root, adapter } = await fixture({
		prompt_surface: { default: "full", models: { "fixture/model": "light" } },
	});
	const host = await standalone(root);
	const bridgeDb = new Database(join(root, "context.db"));
	try {
		for (const sections of [false, true]) {
			const sessionId = `differential-${sections}`;
			for (const db of [bridgeDb, openDatabase()]) {
				getOrCreateSessionMeta(db, sessionId, "pi");
				updateSessionMeta(db, sessionId, {
					cacheTtl: "never",
					lastResponseTime: Date.now(),
				});
			}
			for (const systemPrompt of [
				base,
				base,
				base.replace("10-12", "10-13"),
				"Changed identity.\nToday's date: 2026-10-13",
			]) {
				const options = () =>
					normalizeBuildSystemPromptOptions({
						cwd: root,
						customPrompt: systemPrompt,
						sections: { earlier: "Earlier extension." },
					});
				const standaloneOptions = options();
				const bridgeOptions = options();
				const event = sections
					? {
							get systemPrompt() {
								return buildSystemPrompt(standaloneOptions);
							},
							systemPromptOptions: standaloneOptions,
						}
					: { systemPrompt };
				const expected = await host.compose(sessionId, event);
				const actual = await adapter.systemPrompt({
					sessionId,
					systemPrompt: sections
						? buildSystemPrompt(bridgeOptions)
						: systemPrompt,
					model,
					...(sections
						? {
								systemPromptOptions: bridgeOptions,
								renderSystemPrompt: () => buildSystemPrompt(bridgeOptions),
							}
						: {}),
				});
				expect(Buffer.from(actual.systemPrompt)).toEqual(Buffer.from(expected));
				expect(actual.force).toBe(!sections);
				if (sections) {
					expect(actual.systemPrompt).toContain("<magic_context>");
					expect(actual.systemPrompt).toContain("<earlier>");
					bridgeOptions.sections.later = "Later extension.";
					expect(
						adapter.checkSystemPrompt({
							sessionId,
							systemBlocks: [buildSystemPrompt(bridgeOptions)],
						}).managed,
					).toBe(false);
				}
			}
			clearPiSystemPromptSession(sessionId);
		}
	} finally {
		await host.close();
		await adapter.dispose();
		bridgeDb.close();
	}
}, 30_000);

test("standalone and bridge share injection disable, signature skip, and marker dedup rules", async () => {
	for (const [config, systemPrompt, skipped] of [
		[{ enabled: false }, base, true],
		[{ system_prompt_injection: { enabled: false } }, base, true],
		[
			{ system_prompt_injection: { skip_signatures: ["SKIP", ""] } },
			`SKIP ${base}`,
			true,
		],
		[{}, "## Magic Context\nExisting guidance.", false],
	] as const) {
		const { root, adapter } = await fixture(config);
		const host = await standalone(root);
		try {
			const expected = await host.compose("skip-dedup", { systemPrompt });
			const actual = await adapter.systemPrompt({
				sessionId: "skip-dedup",
				systemPrompt,
				model,
			});
			expect(actual.systemPrompt).toBe(expected);
			expect(actual.systemPrompt).toBe(systemPrompt);
			expect(actual.skipped).toBe(skipped);
		} finally {
			clearPiSystemPromptSession("skip-dedup");
			await host.close();
			await adapter.dispose();
		}
	}
}, 30_000);

test("legacy OpenCode-shaped system fact is not the standalone Pi composition", async () => {
	const { root, configPath, adapter } = await fixture();
	const config = loadPluginConfigDetailed(root, false, configPath).config;
	const db = createTestDb();
	const deps = createBridgeDeps(
		config,
		{
			db,
			directory: root,
			rustModeModuleClient: new InjectedBridgeTransport({
				async request() {
					throw new Error("unexpected relay");
				},
			}),
		},
		"pi",
	);
	const fact = createBridgeHostFacts(deps, config);
	const host = await standalone(root);
	try {
		for (const [label, systemPrompt, sections] of [
			["ordinary", base, false],
			[
				"opencode-title-signature",
				"You are a title generator. You output ONLY a thread title.\nToday's date: 2026-10-12",
				false,
			],
			["empty-base", "", false],
			["pi-structured", base, true],
		] as const) {
			const sessionId = `legacy-diff-${label}`;
			const options = normalizeBuildSystemPromptOptions({
				cwd: "/pi-vector-project",
				customPrompt: systemPrompt,
			});
			const event = sections
				? {
						get systemPrompt() {
							return buildSystemPrompt(options);
						},
						systemPromptOptions: options,
					}
				: { systemPrompt };
			const inputBytes = event.systemPrompt;
			const old = await fact({
				kind: "system_prompt",
				sessionId,
				lineageId: "lineage",
				model: { providerID: "fixture", modelID: "model" },
				observedAt: 1,
				system: [inputBytes],
			});
			const expected = await host.compose(sessionId, event);
			const bridgeOptions = normalizeBuildSystemPromptOptions({
				cwd: "/pi-vector-project",
				customPrompt: systemPrompt,
			});
			const actual = await adapter.systemPrompt({
				sessionId,
				systemPrompt: inputBytes,
				model,
				...(sections
					? {
							systemPromptOptions: bridgeOptions,
							renderSystemPrompt: () => buildSystemPrompt(bridgeOptions),
						}
					: {}),
			});
			expect(old.accepted).toBe(true);
			expect(actual.systemPrompt).toBe(expected);
			expect(old.system?.join("\n\n")).not.toBe(expected);
			const summary = (text: string) => ({
				bytes: Buffer.byteLength(text),
				sha256: createHash("sha256").update(text).digest("hex"),
			});
			if (!old.system)
				throw new Error("Legacy system fact returned no system bytes");
			const oldText = old.system.join("\n\n");
			const at =
				Array.from(
					{ length: Math.max(oldText.length, expected.length) },
					(_, i) => i,
				).find((i) => oldText[i] !== expected[i]) ?? -1;
			console.log(
				"PI_SYSTEM_DIFFERENTIAL",
				JSON.stringify({
					label,
					standalone: summary(expected),
					legacy: summary(oldText),
					firstDifference: at,
					standaloneAt: expected.slice(at, at + 120),
					legacyAt: oldText.slice(at, at + 120),
				}),
			);
			clearPiSystemPromptSession(sessionId);
		}
	} finally {
		clearPiSystemPromptSession("legacy-diff");
		await host.close();
		await adapter.dispose();
		db.close();
	}
}, 30_000);
