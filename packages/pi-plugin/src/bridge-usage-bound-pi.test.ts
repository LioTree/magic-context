import { expect, test } from "bun:test";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import {
	boundMarkerEnvelope,
	boundMarkerMessages,
	deriveMarkerEnvelopeReading,
	type MarkerEnvelope,
	markerRatioRange,
	qualifyingMarkerEnvelopeUpper,
} from "@magic-context/core/hooks/magic-context/marker-envelope";
import {
	markerRandom,
	randomMarkerEnvelope,
} from "@magic-context/core/hooks/magic-context/marker-envelope-test-support";
import {
	estimateTokens,
	hasTokenizerForFit,
} from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
	type PiBridgeEntry,
	piSentText,
	projectPiEntry,
} from "./bridge-codec-pi";

// The four pi-ai request serializers the sweep captures. Each stream builds the
// exact provider request body and hands it to onPayload before any network call;
// throwing there stops the request.
const SERIALIZERS = {
	"anthropic-messages": { stream: streamAnthropic, provider: "anthropic" },
	"openai-completions": { stream: streamOpenAICompletions, provider: "openai" },
	"openai-responses": { stream: streamOpenAIResponses, provider: "openai" },
	"google-generative-ai": { stream: streamGoogle, provider: "google" },
} as const;
type Api = keyof typeof SERIALIZERS;

const WIRE_MODEL_ID = "claude-sonnet-4-5";
const wireModel = (api: Api) => ({
	id: WIRE_MODEL_ID,
	name: WIRE_MODEL_ID,
	api,
	provider: SERIALIZERS[api].provider,
	baseUrl: "https://invalid.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1024,
});

/** The provider request body pi-ai would send for this system prompt, history and tool set. */
async function piWire(
	api: Api,
	systemPrompt: string,
	entries: readonly PiBridgeEntry[],
	tools: MarkerEnvelope["tools"],
): Promise<unknown> {
	let captured: unknown;
	const result = await SERIALIZERS[api]
		.stream(
			wireModel(api) as never,
			{
				systemPrompt,
				messages: entries.map((entry) => entry.message),
				tools: tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.inputSchema,
				})),
			} as never,
			{
				apiKey: "fixture",
				onPayload(payload: unknown) {
					captured = payload;
					throw new Error("captured");
				},
			} as never,
		)
		.result();
	if (captured === undefined)
		throw new Error(
			`${api} produced no payload: ${(result as { errorMessage?: string }).errorMessage}`,
		);
	return captured;
}

const texts = [
	"",
	"ok",
	"   ",
	"Read a file.\nKeep bytes unchanged.",
	"日本語 café 😀",
	'quoted " schema \\ \u0000',
	"lone surrogate \uD800 inside",
	'<EOT> {"a":true}',
	"The quick brown fox jumps over the lazy dog. ".repeat(40),
	'fn main() {\n    println!("hello");\n}\n'.repeat(12),
];

/**
 * Random Pi journal entries: user text (string or blocks), assistant text,
 * thinking and tool calls with every stop reason (pi-ai drops "error" and
 * "aborted" turns), and tool results answering earlier calls.
 */
function randomPiHistory(
	next: () => number,
	length: number,
	salt: string,
): PiBridgeEntry[] {
	const pick = <T>(items: readonly T[]) =>
		items[Math.floor(next() * items.length)] as T;
	const text = () => pick(texts).repeat(1 + Math.floor(next() * 4));
	const entries: PiBridgeEntry[] = [];
	let pendingCalls: { id: string; name: string }[] = [];
	for (let index = 0; index < length; index++) {
		const id = `pi_${salt}_${index}`;
		const message = (body: PiBridgeEntry["message"]): PiBridgeEntry => ({
			type: "message",
			id,
			parentId: null,
			message: { timestamp: index, ...body },
		});
		if (pendingCalls.length && next() < 0.7) {
			const call = pendingCalls.shift()!;
			entries.push(
				message({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: text() }],
					isError: next() < 0.2,
				}),
			);
			continue;
		}
		pendingCalls = [];
		if (index % 2 === 0) {
			entries.push(
				message({
					role: "user",
					content:
						next() < 0.3
							? text()
							: Array.from({ length: 1 + Math.floor(next() * 2) }, () => ({
									type: "text",
									text: text(),
								})),
				}),
			);
			continue;
		}
		const content: Record<string, unknown>[] = [];
		const calls: { id: string; name: string }[] = [];
		for (let n = 0; n < 1 + Math.floor(next() * 4); n++) {
			const roll = next();
			if (roll < 0.4) content.push({ type: "text", text: text() });
			else if (roll < 0.55)
				content.push({
					type: "thinking",
					thinking: text(),
					// When an assistant turn came from the request's own model, the
					// openai-responses serializer replays its signature by parsing it as a
					// JSON reasoning item, so signatures here must be valid JSON.
					...(next() < 0.5
						? {
								thinkingSignature: JSON.stringify({
									type: "reasoning",
									id: `rs_${id}_${n}`,
									summary: [],
								}),
							}
						: {}),
				});
			else {
				const call = {
					id: `toolu_${salt}_${index}_${n}`,
					name: pick(["read", "bash", "ctx_search", "edit"]),
				};
				calls.push(call);
				content.push({
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: { path: text(), offset: Math.floor(next() * 1000) },
				});
			}
		}
		const stopReason = pick([
			"stop",
			"toolUse",
			"length",
			"error",
			"aborted",
		] as const);
		pendingCalls = calls;
		entries.push(
			message({
				role: "assistant",
				content,
				api: pick(["anthropic-messages", "openai-responses"]),
				provider: pick(["anthropic", "openai"]),
				model: pick([WIRE_MODEL_ID, "gpt-5"]),
				stopReason,
				...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		);
	}
	return entries;
}

const models = [
	"anthropic/claude-sonnet-4-5",
	"openai/gpt-5",
	"xai/grok-4",
	"google/gemini-2.5-pro",
	"unmeasured/future-model",
];

test("Pi usage-derived post-cut bound covers every pi-ai serializer with unobserved tool schemas", async () => {
	expect(hasTokenizerForFit()).toBe(true);
	const next = markerRandom(0x9150);
	let comparisons = 0;
	let tightest = Number.POSITIVE_INFINITY;
	const missingReadings: string[] = [];
	for (let round = 0; round < 60; round++) {
		const full = randomMarkerEnvelope(next);
		// Pi sends one system prompt; the host reads it back from the request body.
		const systemPrompt = full.system.join("\n\n") || "Pi system prompt.";
		const hidden = full.tools.filter(() => next() < 0.6);
		const observed: MarkerEnvelope = {
			system: [systemPrompt],
			tools: full.tools.filter((tool) => !hidden.includes(tool)),
			unobserved_tools: hidden.map((tool) => tool.name),
		};
		// Long served histories followed by short post-cut views are where an
		// over-subtracted message lower bound would show; mix in the reverse too.
		const prev = randomPiHistory(
			next,
			Math.floor(next() * (round % 3 === 0 ? 8 : 40)),
			`p${round}`,
		);
		const post = randomPiHistory(
			next,
			Math.floor(next() * (round % 3 === 0 ? 40 : 6)),
			`c${round}`,
		);
		const prevServed = prev.map((entry) => projectPiEntry(entry));
		const postServed = post.map((entry) => projectPiEntry(entry));
		for (const api of Object.keys(SERIALIZERS) as Api[]) {
			const prevLocal = estimateTokens(
				JSON.stringify(await piWire(api, systemPrompt, prev, full.tools)),
			);
			const postLocal = estimateTokens(
				JSON.stringify(await piWire(api, systemPrompt, post, full.tools)),
			);
			for (const model of models) {
				const { lower, upper } = markerRatioRange(model);
				// No live endpoint: the provider's count is modeled as the local count
				// at any ratio inside the model's calibrated range, both ends included.
				for (const ratio of [lower, (lower + upper) / 2, upper]) {
					const where = `${model} ${api} round ${round} ratio ${ratio}`;
					const reading = deriveMarkerEnvelopeReading({
						material: observed,
						messages: prevServed,
						totalInput: Math.ceil(prevLocal * ratio),
						model,
						sentText: piSentText,
					});
					// The true envelope is positive, so a correct subtraction always
					// leaves a reading; count misses and assert after the bound checks.
					if (!reading) {
						missingReadings.push(where);
						continue;
					}
					const derived = qualifyingMarkerEnvelopeUpper(
						{ model, envelope_reading: reading },
						observed,
						model,
					);
					const bound =
						Math.max(derived!, boundMarkerEnvelope(observed, model)!) +
						boundMarkerMessages(postServed, model);
					const actual = Math.ceil(postLocal * ratio);
					expect(bound, where).toBeGreaterThanOrEqual(actual);
					if (post.length) tightest = Math.min(tightest, bound / actual);
					comparisons++;
				}
			}
		}
	}
	expect(missingReadings).toEqual([]);
	console.log(
		`pi-usage-bound: ${comparisons} comparisons; tightest bound/actual with a non-empty post-cut view=${tightest.toFixed(4)}`,
	);
}, 120_000);

test("Pi errored and aborted assistant turns are not subtracted from provider usage", async () => {
	expect(hasTokenizerForFit()).toBe(true);
	const long = "Partial answer that pi-ai never replays. ".repeat(200);
	const assistant = (id: string, stopReason: string): PiBridgeEntry => ({
		type: "message",
		id,
		parentId: null,
		message: {
			role: "assistant",
			content: [{ type: "text", text: long }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: WIRE_MODEL_ID,
			stopReason,
			timestamp: 1,
		},
	});
	const user: PiBridgeEntry = {
		type: "message",
		id: "u",
		parentId: null,
		message: { role: "user", content: "Short question.", timestamp: 1 },
	};
	const served = [
		user,
		assistant("errored", "error"),
		assistant("aborted", "aborted"),
	];
	const material: MarkerEnvelope = {
		system: ["Pi system prompt."],
		tools: [],
		unobserved_tools: ["bash", "read"],
	};
	expect(piSentText(projectPiEntry(served[1]!))).toEqual([]);
	expect(piSentText(projectPiEntry(served[2]!))).toEqual([]);
	expect(piSentText(projectPiEntry(assistant("done", "stop")))).toEqual([long]);
	const model = "anthropic/claude-sonnet-4-5";
	const wire = await piWire(
		"anthropic-messages",
		"Pi system prompt.",
		served,
		[],
	);
	// pi-ai sends neither failed turn, so the request holds only the short user text.
	expect(JSON.stringify(wire)).not.toContain("never replays");
	const totalInput = Math.ceil(
		estimateTokens(JSON.stringify(wire)) * markerRatioRange(model).lower,
	);
	const piReading = deriveMarkerEnvelopeReading({
		material,
		messages: served.map((entry) => projectPiEntry(entry)),
		totalInput,
		model,
		sentText: piSentText,
	});
	expect(piReading?.envelope_upper).toBeGreaterThan(0);
	// OpenCode's rule would subtract the dropped text and leave no reading at all.
	expect(
		deriveMarkerEnvelopeReading({
			material,
			messages: served.map((entry) => projectPiEntry(entry)),
			totalInput,
			model,
		}),
	).toBeUndefined();
});
