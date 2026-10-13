/** Capture a genuinely cold signed-thinking request through each real host transform. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "../packages/pi-plugin/src/context-handler";
import {
	assistantMessage,
	createFakePi,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "../packages/pi-plugin/src/test-utils.test";
import { runMigrations } from "../packages/plugin/src/features/magic-context/migrations";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	updateSessionMeta,
} from "../packages/plugin/src/features/magic-context/storage";
import { initializeDatabase } from "../packages/plugin/src/features/magic-context/storage-db";
import { createTagger } from "../packages/plugin/src/features/magic-context/tagger";
import { clearInjectionCache } from "../packages/plugin/src/hooks/magic-context/inject-compartments";
import type { MessageLike } from "../packages/plugin/src/hooks/magic-context/tag-messages";
import {
	clearMessageTokensCache,
	createTransform,
} from "../packages/plugin/src/hooks/magic-context/transform";
import { resetDegradedCacheCount } from "../packages/plugin/src/hooks/magic-context/transform-postprocess-phase";
import { setHarness } from "../packages/plugin/src/shared/harness";
import { Database } from "../packages/plugin/src/shared/sqlite";

const root = process.env.MC_HOLD_CORPUS_ROOT;
const output = process.env.MC_HOLD_CORPUS_OUTPUT;
if (!root || !output)
	throw new Error("isolated cold corpus root/output required");
mkdirSync(root, { recursive: true });
Date.now = () => 1_780_000_000_000;
const harness = process.env.MC_HOLD_HARNESS === "pi" ? "pi" : "opencode";
const hold = process.env.MC_HOLD_SETTING === "on" ? "on" : "off";
setHarness(harness);
const sid = `cold-signed-${harness}`;
const dir = join(root, sid);
mkdirSync(dir, { recursive: true });
const db = new Database(":memory:");
initializeDatabase(db);
runMigrations(db);
getOrCreateSessionMeta(db, sid);
// A recent response and current ID scheme prevent expiry or migration from
// supplying an independent reason to rewrite the request on this first pass.
updateSessionMeta(db, sid, {
	cacheTtl: "59m",
	lastResponseTime: Date.now(),
	piStableIdScheme: 1,
});
const rowBefore = db
	.prepare(
		"SELECT cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id = ?",
	)
	.get(sid) as Record<string, unknown>;
if (rowBefore.cached_m0_bytes !== null || rowBefore.cached_m1_bytes !== null)
	throw new Error("cold bootstrap unexpectedly has a cached pair");
const model = "claude-opus-5-5";
const compressible =
	"The parser should return the current token and then advance to the next token. ".repeat(
		160,
	);
const toolText = "export function parse(tokens) { return tokens; }\n".repeat(
	100,
);
const ids = ["u", "signed", "tail-old"];
const raw: (MessageLike | PiMessage)[] =
	harness === "opencode"
		? [
				{
					info: { id: "u", role: "user", sessionID: sid },
					parts: [{ type: "text", text: "Inspect the parser." }],
				},
				{
					info: { id: "signed", role: "assistant", sessionID: sid },
					parts: [
						{
							type: "reasoning",
							text: "Keep inspecting.",
							metadata: { anthropic: { signature: "cold-signed" } },
						},
						{ type: "text", text: "Keep inspecting." },
					],
				},
				{
					info: { id: "tail-old", role: "assistant", sessionID: sid },
					parts: [{ type: "text", text: compressible }],
				},
			]
		: [
				userMessage("Inspect the parser.", 1),
				assistantMessage("Keep inspecting.", 2, {
					provider: "anthropic",
					model,
					api: "anthropic-messages",
					content: [
						{
							type: "thinking",
							thinking: "Keep inspecting.",
							thinkingSignature: "cold-signed",
						},
						{ type: "text", text: "Keep inspecting." },
					],
				}),
				assistantMessage(compressible, 3, {
					provider: "anthropic",
					model,
					api: "anthropic-messages",
				}),
			];
// Put enough tool results after the long text to age it out of recent protection,
// while leaving it after the signed-thinking block. No transform has run yet,
// so there is still no cached m[0]/m[1] pair when cleanup first sees that text.
for (let index = 0; index < 20; index++) {
	const mid = `tail-${index}`;
	const call = `read-${index}`;
	if (harness === "opencode") {
		raw.push({
			info: { id: mid, role: "assistant", sessionID: sid },
			parts: [
				{
					type: "tool",
					tool: "read",
					callID: call,
					state: {
						status: "completed",
						input: { path: `/project/tail-${index}.ts` },
						output: toolText,
					},
				},
			],
		});
		ids.push(mid);
	} else {
		raw.push(
			assistantMessage("", index * 2 + 4, {
				provider: "anthropic",
				model,
				api: "anthropic-messages",
				content: [
					{
						type: "toolCall",
						id: call,
						name: "Read",
						arguments: { path: `/project/tail-${index}.ts` },
					},
				],
				stopReason: "toolUse",
			}),
			toolResultMessage(call, toolText, index * 2 + 5),
		);
		ids.push(mid, `${mid}-result`);
	}
}
const pending = new Set<string>();
let served: unknown[];
if (harness === "opencode") {
	const transform = createTransform({
		db,
		tagger: createTagger(),
		signedThinkingHold: hold,
		storeGeneration: "v2",
		scheduler: { shouldExecute: () => "defer" } as never,
		liveModelBySession: new Map([
			[sid, { providerID: "anthropic", modelID: model }],
		]),
		contextUsageMap: new Map([
			[
				sid,
				{
					usage: { percentage: 20, inputTokens: 20000 },
					updatedAt: Date.now(),
					hasUsageTokens: true,
				} as never,
			],
		]),
		protectedTokens: 4000,
		historianRunnable: false,
		directory: dir,
		sessionDirectoryBySession: new Map([[sid, dir]]),
		pendingMaterializationSessions: pending,
		historyRefreshSessions: new Set<string>(),
		lastHeuristicsTurnId: new Map<string, string>(),
		keepReasoningTokens: 1_000_000,
		cavemanTextCompression: { enabled: true, minChars: 40 },
	});
	const messages = structuredClone(raw) as MessageLike[];
	await transform({}, { messages });
	served = messages;
} else {
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		signedThinkingHold: hold,
		cacheTtlConfig: "59m",
		protectedTokens: 4000,
		injection: {
			injectionBudgetTokens: 4000,
			memoryEnabled: false,
			injectDocs: false,
		},
		heuristics: {
			keepReasoningTokens: 1_000_000,
			caveman: { enabled: true, minChars: 40 },
		},
	});
	const messages = structuredClone(raw) as PiMessage[];
	const ctx = {
		...fakeContext(sid, dir, ids, messages),
		model: {
			id: model,
			provider: "anthropic",
			api: "anthropic-messages",
			contextWindow: 100000,
			maxTokens: 8192,
		},
		getContextUsage: () => ({
			tokens: 20000,
			percent: 20,
			contextWindow: 100000,
		}),
	};
	const result = await (
		fake.handlers.get("context") as unknown as (
			event: { messages: PiMessage[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] } | undefined>
	)({ messages }, ctx);
	if (!result) throw new Error("cold Pi pass returned no output");
	served = result.messages;
}
const names = db
	.prepare(
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
	)
	.all() as { name: string }[];
const decisions = Object.fromEntries(
	names
		.filter(({ name }) =>
			/^(session_meta|tags|pending_ops|reasoning_removals|message_|caveman_)/.test(
				name,
			),
		)
		.map(({ name }) => {
			const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<
				string,
				unknown
			>[];
			return [
				name,
				rows
					.map((row) => {
						if (row.served_prefix != null || row.held_release != null)
							throw new Error("disabled cold bootstrap wrote hold metadata");
						return Object.fromEntries(
							Object.entries(row)
								.filter(
									([key]) =>
										!/^(served_prefix|held_release|cached_m0_score_selection_watermark)$/.test(
											key,
										),
								)
								.map(([key, value]) => [
									key,
									typeof value === "string"
										? value.replaceAll(root, "<root>")
										: value,
								]),
						);
					})
					.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
			];
		}),
);
const old = getTagsBySession(db, sid).find((tag) =>
	tag.messageId.includes("tail-old"),
);
writeFileSync(
	output,
	JSON.stringify({
		harness,
		rowBefore,
		served: JSON.stringify(served).replaceAll(root, "<root>"),
		decisions,
		pending: [...pending],
		compressedDepth: old?.cavemanDepth,
	}),
);
console.log(
	`cold signed-thinking ${harness}: missing cached pair; one pass; depth=${old?.cavemanDepth}`,
);
clearContextHandlerSession(sid);
clearInjectionCache(sid);
clearMessageTokensCache(sid);
resetDegradedCacheCount(sid);
db.close();
