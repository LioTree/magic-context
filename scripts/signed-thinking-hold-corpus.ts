/** Deterministic randomized passes shared by the hold-off and pre-hold source runs. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
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
	queuePendingOp,
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

const root = process.env.MC_HOLD_CORPUS_ROOT ?? "";
if (!root || !process.env.MC_HOLD_CORPUS_OUTPUT)
	throw new Error("isolated corpus root/output required");
mkdirSync(root, { recursive: true });
Date.now = () => 1_780_000_000_000;
let randomState = 630665;
function random(n: number) {
	randomState ^= randomState << 13;
	randomState ^= randomState >>> 17;
	randomState ^= randomState << 5;
	return (randomState >>> 0) % n;
}
// Compare decision payloads, not just rendered text. Wall-clock telemetry and
// filesystem identity are not decisions; the same logical session uses different roots.
function decisions(db: Database) {
	const names = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as { name: string }[];
	return Object.fromEntries(
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
				for (const row of rows) {
					if (row.served_prefix != null || row.held_release != null)
						throw new Error("hold-off wrote release metadata");
				}
				return [
					name,
					rows
						.map((row) =>
							Object.fromEntries(
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
							),
						)
						.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
				];
			}),
	);
}
const output: unknown[] = [];
const text =
	"The parser should return the current token and then advance to the next token. ".repeat(
		160,
	);
const setting = process.env.MC_HOLD_SETTING === "on" ? "on" : "off";

for (const harness of [
	process.env.MC_HOLD_HARNESS === "pi" ? "pi" : "opencode",
] as const) {
	setHarness(harness);
	for (let seed = 0; seed < 18; seed++) {
		const db = new Database(":memory:");
		initializeDatabase(db);
		runMigrations(db);
		const sid = `corpus-${harness}-${seed}`;
		const subagent = seed % 3 === 0;
		const signed = seed % 4 !== 0;
		const model = seed % 5 === 0 ? "claude-sonnet-4-6" : "claude-opus-5-5";
		getOrCreateSessionMeta(db, sid);
		updateSessionMeta(db, sid, { isSubagent: subagent });
		const pending = new Set<string>();
		const usage = new Map();
		let execute = false;
		let percentage = 20;
		const raw: (MessageLike | PiMessage)[] = [];
		const ids: string[] = [];
		const dir = join(root, sid);
		mkdirSync(dir, { recursive: true });
		let pass: () => Promise<unknown[]>;
		if (harness === "opencode") {
			const transform = createTransform({
				db,
				tagger: createTagger(),
				signedThinkingHold: setting,
				storeGeneration: seed % 2 ? "v1" : "v2",
				scheduler: {
					shouldExecute: () => (execute ? "execute" : "defer"),
				} as never,
				liveModelBySession: new Map([
					[sid, { providerID: "anthropic", modelID: model }],
				]),
				contextUsageMap: usage,
				protectedTokens: 4000,
				historianRunnable: false,
				directory: dir,
				sessionDirectoryBySession: new Map([[sid, dir]]),
				pendingMaterializationSessions: pending,
				historyRefreshSessions: new Set<string>(),
				lastHeuristicsTurnId: new Map<string, string>(),
				keepReasoningTokens: seed % 6 === 0 ? 0 : 1_000_000,
				cavemanTextCompression: { enabled: true, minChars: 40 },
			});
			pass = async () => {
				usage.set(sid, {
					usage: { percentage, inputTokens: percentage * 1000 },
					updatedAt: Date.now(),
					hasUsageTokens: true,
				});
				const messages = structuredClone(raw) as MessageLike[];
				await transform({}, { messages });
				return messages;
			};
		} else {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				signedThinkingHold: setting,
				protectedTokens: 4000,
				injection: {
					injectionBudgetTokens: 4000,
					memoryEnabled: false,
					injectDocs: false,
				},
				heuristics: {
					keepReasoningTokens: seed % 6 === 0 ? 0 : 1_000_000,
					caveman: { enabled: true, minChars: 40 },
				},
			});
			pass = async () => {
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
						tokens: percentage * 1000,
						percent: percentage,
						contextWindow: 100000,
					}),
				};
				const result = await (
					fake.handlers.get("context") as unknown as (
						event: { messages: PiMessage[] },
						ctx: unknown,
					) => Promise<{ messages: PiMessage[] } | undefined>
				)({ messages }, ctx);
				if (!result) throw new Error(`missing context output: ${sid}`);
				return result.messages;
			};
		}
		for (let turn = 0; turn < 14; turn++) {
			const newUser = turn === 0 || (!subagent && turn % 5 === 0);
			if (newUser) {
				const id = `user-${turn}`;
				raw.push(
					harness === "opencode"
						? {
								info: { id, role: "user", sessionID: sid },
								parts: [
									{ type: "text", text: "Inspect and repair the parser." },
								],
							}
						: userMessage("Inspect and repair the parser.", turn + 1),
				);
				ids.push(id);
			} else {
				const id = `assistant-${turn}`;
				const call = `read-${turn}`;
				const reasoning = signed && random(3) !== 0;
				raw.push(
					harness === "opencode"
						? {
								info: {
									id,
									role: "assistant",
									sessionID: sid,
								},
								parts: [
									...(reasoning
										? [
												{
													type: "reasoning",
													text: `Reasoning ${turn}`,
													metadata: {
														anthropic: { signature: `signed-${seed}-${turn}` },
													},
												},
											]
										: []),
									{ type: "text", text },
									{
										type: "tool",
										callID: call,
										tool: "read",
										state: {
											status: "completed",
											input: { path: `/project/file-${random(3)}.ts` },
											output: text,
										},
									},
								],
							}
						: assistantMessage(text, turn + 1, {
								provider: "anthropic",
								model,
								content: [
									...(reasoning
										? [
												{
													type: "thinking",
													thinking: `Reasoning ${turn}`,
													thinkingSignature: `signed-${seed}-${turn}`,
												},
											]
										: []),
									{ type: "text", text },
									{
										type: "toolCall",
										id: call,
										name: "Read",
										arguments: { path: `/project/file-${random(3)}.ts` },
									},
								],
								stopReason: "toolUse",
							}),
				);
				ids.push(id);
				if (harness === "pi") {
					raw.push(toolResultMessage(call, text, turn + 1));
					ids.push(`result-${turn}`);
				}
			}
			percentage = [20, 66, 86, 96][random(4)];
			execute = random(2) === 0;
			if (random(3) === 0) {
				if (harness === "pi") signalPiPendingMaterialization(sid);
				else pending.add(sid);
			}
			const tags = getTagsBySession(db, sid);
			if (tags.length && random(3) === 0)
				queuePendingOp(db, sid, tags[random(tags.length)].tagNumber, "drop");
			for (let replay = 0; replay < 2; replay++) {
				const served = await pass();
				output.push({
					harness,
					seed,
					turn,
					replay,
					served: JSON.stringify(served).replaceAll(root, "<root>"),
					decisions: decisions(db),
					pending: [...pending],
				});
			}
		}
		clearContextHandlerSession(sid);
		clearInjectionCache(sid);
		clearMessageTokensCache(sid);
		resetDegradedCacheCount(sid);
		db.close();
	}
}
writeFileSync(process.env.MC_HOLD_CORPUS_OUTPUT, JSON.stringify(output));
console.log(
	`signed-thinking hold corpus: ${output.length} passes; 18 sessions; seed=630665; setting=${setting}; harness=${process.env.MC_HOLD_HARNESS}`,
);
