import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as admission from "@magic-context/core/hooks/magic-context/edit-admission";
import * as slots from "@magic-context/core/hooks/magic-context/lkg-slot";
import { moveMessageDigestFromFields } from "@magic-context/core/hooks/magic-context/move-inputs";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/transform-operations";
import { withAsyncPrivilegedWriter } from "@magic-context/core/shared/sqlite";

import * as piLkg from "./pi-lkg";

const host = process.env.LKG_MEMO_REVIEW_HOST;
const root = process.env.LKG_MEMO_REVIEW_ROOT;
const phase = Number(process.env.LKG_MEMO_REVIEW_PHASE ?? 0);
const fresh = process.env.LKG_MEMO_REVIEW_FRESH === "1";
const seed = Number(process.env.LKG_MEMO_REVIEW_SEED ?? 6132344);

function random() {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

// Both hashes must change when a host edits a message in place, without
// replacing its id or object.
test("LKG memo review: in-place host edit invalidates both entry digests", async () => {
	const { createLkgEntryProjector } = await import(
		"@magic-context/core/hooks/magic-context/lkg-replay"
	);
	const project = createLkgEntryProjector({ maxBytes: 65536 });
	const raw = [
		{
			info: { id: "same", role: "user" },
			parts: [{ type: "text", text: "before" }],
		},
	] as MessageLike[];
	const before = project("memo-control", raw)[0];
	const priorMove = before.moveDigest?.();
	(raw[0].parts[0] as { text: string }).text = "after";
	const actual = project("memo-control", raw)[0];
	const fields = slots.lkgContentFields(raw[0]);
	if (!fields) throw new Error("missing fields");
	expect(actual.contentDigest?.()).toBe(
		slots.lkgContentDigestFromFields(fields),
	);
	expect(actual.moveDigest?.()).toBe(moveMessageDigestFromFields(fields));
	expect(actual.moveDigest?.()).not.toBe(priorMove);
});

test.skipIf(!host || !root)(
	"LKG memo review: randomized complete host passes agree with fresh certification",
	async () => {
		if (!root || !host)
			throw new Error("missing isolated review configuration");
		mkdirSync(root, { recursive: true });
		const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
		const sessions = ["memo-session-a", "memo-session-b"];
		const wires: unknown[] = [];
		let comparedEntries = 0;
		let comparedCaptures = 0;
		let forcedFresh = 0;
		let busyAttempts = 0;
		let recoveredPasses = 0;
		let signedHolds = 0;
		let signedFrames = 0;
		const originalAdmission = admission.createEditAdmission;
		const admissionSpy = spyOn(
			admission,
			"createEditAdmission",
		).mockImplementation((args) => {
			const frame = originalAdmission(args);
			if (args.prefixBound && frame.frame.kind === "boundary") signedFrames++;
			const admit = frame.admit;
			frame.admit = (coordinate) => {
				const accepted = admit(coordinate);
				if (!accepted) signedHolds++;
				return accepted;
			};
			return frame;
		});
		const originalDigests = slots.LkgEntryDigestCache.prototype.digests;
		const entrySpy = spyOn(
			slots.LkgEntryDigestCache.prototype,
			"digests",
		).mockImplementation(function (
			this: slots.LkgEntryDigestCache,
			session,
			messages,
			portable,
		) {
			const actual = originalDigests.call(this, session, messages, portable);
			const fields = messages.map((message) => slots.lkgContentFields(message));
			const digests = fields.map((input) =>
				input ? slots.lkgContentDigestFromFields(input) : null,
			);
			expect(actual.digests).toEqual(digests);
			const moves = fields.map((input) =>
				input ? () => moveMessageDigestFromFields(input) : undefined,
			);
			if (portable)
				expect(actual.moveDigests.map((digest) => digest?.())).toEqual(
					moves.map((digest) => digest?.()),
				);
			comparedEntries += messages.length;
			return fresh
				? { ...actual, digests, moveDigests: portable ? moves : [] }
				: actual;
		});
		const originalPrefix = slots.exactReusablePrefix;
		const prefixSpy = spyOn(slots, "exactReusablePrefix").mockImplementation(
			(current, prior) => {
				// Disable capture and serialization reuse, but leave the exact-input
				// comparisons that authorize recovery and usage measurements unchanged.
				if (
					fresh &&
					/captureAppliedPass|\bcommit\b/.test(new Error().stack ?? "")
				) {
					forcedFresh++;
					return 0;
				}
				return originalPrefix(current, prior);
			},
		);
		const originalCoordinator = piLkg.createPiLkgCoordinator;
		const coordinatorSpy = spyOn(
			piLkg,
			"createPiLkgCoordinator",
		).mockImplementation((db, schedule, timing) => {
			const coordinator = originalCoordinator(db, schedule, timing);
			const capture = coordinator.captureAppliedPass;
			coordinator.captureAppliedPass = (args) => {
				const expectedJson = JSON.stringify(args.outputMessages);
				const expectedDigests = args.snapshot.inputs.map((input) =>
					slots.lkgContentDigestFromFields(input.fields),
				);
				const expectedMoves = args.snapshot.inputs.map((input) =>
					moveMessageDigestFromFields(input.fields),
				);
				const result = capture(args);
				if (result) {
					expect(result.json).toBe(expectedJson);
					expect(JSON.parse(result.json)).toEqual(args.outputMessages);
				}
				if (args.publishServedNumbers) {
					const slot = slots.getSlot(args.snapshot.sessionId);
					expect(slot?.jsonPrefix).toBe(expectedJson);
					expect(slot?.inputContentDigests).toEqual(expectedDigests);
					expect(slot?.inputMoveDigests).toEqual(expectedMoves);
					comparedCaptures++;
				}
				return result;
			};
			return coordinator;
		});
		const { setHarness } = await import("@magic-context/core/shared/harness");
		setHarness(host === "pi" ? "pi" : "opencode");
		const { createTransform } = await import(
			"@magic-context/core/hooks/magic-context/transform"
		);
		const { createMessagesTransformHandler } = await import(
			"@magic-context/core/plugin/messages-transform"
		);
		const { createTagger } = await import(
			"@magic-context/core/features/magic-context/tagger"
		);
		const { openDatabase, closeDatabase } = await import(
			"@magic-context/core/features/magic-context/storage-db"
		);
		const {
			setCtxReduceRegisteredGlobally,
			resetCtxReduceRegisteredGloballyForTest,
		} = await import(
			"@magic-context/core/hooks/magic-context/ctx-reduce-availability"
		);
		const { adaptPayload } = await import(
			"@magic-context/core/v2/hooks/payload"
		);
		const { registerPiContextHandler, clearContextHandlerSession } =
			await import("./context-handler");
		const {
			createFakePi,
			createTestDb,
			fakeContext,
			userMessage,
			assistantMessage,
		} = await import("./test-utils.test");
		const db =
			host === "pi"
				? createTestDb(join(root, "context.db"))
				: openDatabase(join(root, "context.db"));
		if (!db) throw new Error("isolated database unavailable");
		db.exec("PRAGMA busy_timeout=0");
		const { updateSessionMeta } = await import(
			"@magic-context/core/features/magic-context/storage-meta"
		);
		const { __test: decisions } = await import(
			"@magic-context/core/features/magic-context/transform-decision-log"
		);
		for (const session of sessions)
			updateSessionMeta(db, session, {
				piStableIdScheme: 1,
				systemPromptTokens: 100,
			});
		setCtxReduceRegisteredGlobally(true);
		let execute = false;
		const refresh = new Set<string>();
		const transform = createTransform({
			db,
			signedThinkingHold: "on",
			tagger: createTagger(),
			scheduler: { shouldExecute: () => (execute ? "execute" : "defer") },
			contextUsageMap: new Map(),
			historyRefreshSessions: refresh,
			pendingMaterializationSessions: new Set(),
			lastHeuristicsTurnId: new Map(),
			historianRunnable: false,
			protectedTokens: 0,
			clearReasoningAge: 1000,
			directory: root,
			memoryConfig: { enabled: false },
			injectDocs: false,
			liveModelBySession: new Map(sessions.map((session) => [session, model])),
		});
		const wrapper = createMessagesTransformHandler({
			magicContext: { "experimental.chat.messages.transform": transform },
		});
		const fake = createFakePi();
		Object.assign(fake.pi, { getAllTools: () => [] });
		registerPiContextHandler(fake.pi, {
			db,
			signedThinkingHold: "on",
			scheduler: { executeThresholdPercentage: 80 },
			heuristics: { keepReasoningTokens: 1000 },
			injection: {
				memoryEnabled: false,
				injectDocs: false,
				temporalAwareness: false,
			},
		});
		const raw: MessageLike[][] = [[], []];
		const native: ReturnType<typeof userMessage>[][] = [[], []];
		const next = random();
		let serial = 0;
		const answers = new Map<
			number,
			{ index: number; text: string; signed: boolean }
		>();
		const append = (which: number, text: string, signed: boolean) => {
			const index = serial++;
			const id = `m-${index}`;
			raw[which].push({
				info: {
					id,
					role: "user",
					sessionID: sessions[which],
					model,
					time: { created: index * 2 + 1 },
				} as never,
				parts: [{ type: "text", text }],
			});
			native[which].push(userMessage(text, index * 2 + 1));
			answers.set(which, { index, text, signed });
		};
		const answer = (which: number) => {
			const pending = answers.get(which);
			if (!pending) throw new Error("missing planned assistant");
			const { index, text, signed } = pending;
			raw[which].push({
				info: {
					id: `m-${index}-a`,
					role: "assistant",
					sessionID: sessions[which],
					model,
					time: { created: index * 2 + 2 },
					finish: "stop",
				} as never,
				parts: [
					...(signed
						? [
								{
									type: "reasoning",
									text: `reason ${index}`,
									metadata: { anthropic: { signature: `signature-${index}` } },
								},
							]
						: []),
					{ type: "text", text: `answer ${text}` },
				],
			});
			const assistant = assistantMessage(`answer ${text}`, index * 2 + 2, {
				api: "anthropic-messages",
				provider: "anthropic",
				model: model.modelID,
			});
			if (signed)
				assistant.content.unshift({
					type: "thinking",
					thinking: `reason ${index}`,
					thinkingSignature: `signature-${index}`,
				});
			native[which].push(assistant as ReturnType<typeof userMessage>);
		};
		append(0, "fixed head A", false);
		append(1, "fixed head B", false);
		let busy = false;
		const exec = db.exec.bind(db);
		const busySpy = spyOn(db, "exec").mockImplementation((sql) => {
			if (busy && sql === "BEGIN IMMEDIATE") {
				busyAttempts++;
				throw Object.assign(new Error("review synthetic writer busy"), {
					code: "SQLITE_BUSY",
				});
			}
			return exec(sql);
		});
		try {
			for (let index = 0; index < (phase + 1) * 100; index++) {
				const which = index % 2;
				const round = Math.floor(index / 2);
				const session = sessions[which];
				const value = next();
				if (round % 5 === 0)
					append(
						which,
						`turn-${round} ${value} é🙂\n§literal§`,
						value % 3 === 0,
					);
				if (round % 5 === 1) answer(which);
				if (round % 23 === 12) {
					(raw[which][0].parts[0] as { text: string }).text += ` edit-${round}`;
					native[which][0] = userMessage(`host edit-${round}`, 1);
				}
				if (round % 31 === 20 && raw[which].length > 8) {
					raw[which].splice(0, 2);
					native[which].splice(0, 2);
				}
				if (index < phase * 100) continue;
				busy = false;
				execute = round % 7 === 0;
				if (round % 19 === 12) {
					await withAsyncPrivilegedWriter(db, () =>
						db
							.prepare(
								"UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = (SELECT MIN(tag_number) FROM tags WHERE session_id = ?)",
							)
							.run(session, session),
					);
					refresh.add(session);
				}
				let output: unknown;
				busy = round % 20 === 6;
				try {
					if (host === "pi") {
						const messages = structuredClone(native[which]);
						const ids = raw[which].map((message) => String(message.info.id));
						output = await fake.handlers.get("context")(
							{ messages },
							{
								...fakeContext(session, root, ids, messages),
								getSystemPrompt: () => "Memo differential system.",
								getContextUsage: () => ({
									tokens: 10000,
									percent: 5,
									contextWindow: 200000,
								}),
								model: {
									provider: model.providerID,
									id: model.modelID,
									api: "anthropic-messages",
									contextWindow: 200000,
									maxTokens: 10000,
								},
							},
						);
						const decision = decisions.getPendingPi(session);
						if (decision?.lkgFrozenReleaseReason) recoveredPasses++;
					} else if (host === "oc2") {
						const draft = {
							sessionID: session,
							model: {
								providerID: model.providerID,
								id: model.modelID,
								limit: { context: 200000 },
							},
							agent: "build",
							system: [],
							options: {},
							tools: {
								ctx_reduce: {
									description: "reduce",
									input: { type: "object" },
								},
							},
							messages: structuredClone(raw[which]).map((message) => ({
								id: message.info.id,
								role: message.info.role,
								content: message.parts,
							})),
						};
						const adapted = adaptPayload(draft as never);
						await wrapper({}, adapted);
						adapted.commit();
						output = draft;
					} else {
						const result = { messages: structuredClone(raw[which]) };
						await wrapper({}, result);
						output = result;
					}
				} catch (error) {
					throw new Error(
						`seed=${seed} host=${host} phase=${phase} pass=${index} busy=${busy}: ${String(error)}`,
						{ cause: error },
					);
				} finally {
					busy = false;
				}
				await new Promise<void>((done) => setImmediate(done));
				const slot = slots.getSlot(session);
				const digests = slot && {
					ids: slot.inputIdSeq,
					content: slot.inputContentDigests,
					move: slot.inputMoveDigests,
					json: slot.jsonPrefix,
				};
				wires.push({ index, output, digests });
			}
			expect(wires).toHaveLength(100);
			expect(busyAttempts).toBeGreaterThan(0);
			expect(signedFrames).toBeGreaterThan(0);
			if (host === "pi") {
				expect(comparedCaptures).toBeGreaterThan(0);
				expect(recoveredPasses).toBeGreaterThan(0);
				if (fresh) expect(forcedFresh).toBeGreaterThan(0);
			} else expect(comparedEntries).toBeGreaterThan(0);
			const file = join(root, `phase-${phase}.json`);
			writeFileSync(file, JSON.stringify(wires));
			const baseline = process.env.LKG_MEMO_REVIEW_BASELINE;
			if (baseline)
				expect(JSON.stringify(wires)).toBe(
					readFileSync(join(baseline, `phase-${phase}.json`), "utf8"),
				);
			console.log(
				`MEMO_DIFFERENTIAL ${JSON.stringify({ host, seed, phase, fresh, completePasses: wires.length, comparedEntries, comparedCaptures, forcedFresh, busyAttempts, recoveredPasses, signedHolds, signedFrames })}`,
			);
		} finally {
			busySpy.mockRestore();
			admissionSpy.mockRestore();
			entrySpy.mockRestore();
			prefixSpy.mockRestore();
			coordinatorSpy.mockRestore();
			for (const session of sessions) clearContextHandlerSession(session);
			if (host === "pi") db.close();
			else closeDatabase();
			resetCtxReduceRegisteredGloballyForTest();
		}
	},
	120000,
);
