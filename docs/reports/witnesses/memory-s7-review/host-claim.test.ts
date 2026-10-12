import { expect, test } from "bun:test";
import type { HiddenCompletionExecutor } from "../../../../packages/plugin/src/hooks/magic-context/compartment-runner-types";
import { HistorianHostRunner } from "../../../../packages/plugin/src/hooks/magic-context/historian-host-runner";

const review = process.env.MC_S7_REVIEW === "1" ? test : test.skip;

review(
	"S7 additive claim metadata leaves the TypeScript host's executor and reports unchanged",
	async () => {
		async function run(
			additive: boolean,
			outcome: "output" | "failure" | "capped",
		) {
			const trace: unknown[] = [];
			let done!: () => void;
			const reported = new Promise<void>((resolve) => {
				done = resolve;
			});
			const executor: HiddenCompletionExecutor = {
				capabilities: { tools: false, harness: "opencode" },
				open: async (request) => {
					trace.push(["open", request]);
					return { id: "fresh-child", childSessionId: "fresh-child" };
				},
				attempt: async (handle, request) => {
					trace.push(["attempt", handle, request]);
				},
				collect: async () => {
					if (outcome === "failure") throw new Error("review timeout");
					return {
						text: "<compartments>review</compartments>",
						usage: {
							input: 0,
							output: 0,
							reasoning: 0,
							cacheRead: 0,
							cacheWrite: 0,
						},
						lengthCapped: outcome === "capped",
					};
				},
				close: async (handle, options) => {
					trace.push([
						"close",
						handle,
						{
							promptSettled: options.promptSettled,
							privacySensitive: options.privacySensitive,
						},
					]);
				},
			};
			const runner = new HistorianHostRunner({
				claimantInstanceId: "review-host",
				enabled: () => true,
				now: () => 1_000,
				schedule: () => () => {},
				openExecutor: () => ({
					executor,
					sessionDirectory: "/tmp/review-project",
				}),
				call: async ({ method, body }) => {
					trace.push(["call", method, body]);
					if (method === "historian.pending")
						return {
							ok: true,
							runs: [
								{
									run_id: "review-run",
									session_id: "review-session",
									deadline_ms: 661_000,
								},
							],
						};
					if (method === "historian.claim")
						return {
							ok: true,
							run_id: "review-run",
							session_id: "review-session",
							attempt: 1,
							token: "review-token",
							prompt: { system: "s", user: "p" },
							model_chain: ["test/review"],
							await_budget_ms: 660_000,
							claim_deadline_ms: 601_000,
							heartbeat_interval_ms: 10_000,
							...(additive
								? {
										lifecycle: {
											publication_id: "rust-publication:review",
											run_attempt: 1,
											stage: "turn_one",
											stage_key: "review-stage-key",
											lane: "dormant",
											child_session_id: "previously-retained-child",
											retain_child: true,
										},
									}
								: {}),
						};
					if (method === "historian.complete") {
						done();
						return { ok: true, accepted: true };
					}
					return { ok: true };
				},
			});
			await runner.pump("review-session");
			await reported;
			await runner.stop();
			return trace;
		}
		for (const outcome of ["output", "failure", "capped"] as const) {
			const legacy = await run(false, outcome);
			const additive = await run(true, outcome);
			expect(additive).toEqual(legacy);
			expect(
				additive.some((entry) => Array.isArray(entry) && entry[0] === "close"),
			).toBe(true);
			expect(JSON.stringify(additive)).not.toContain(
				"previously-retained-child",
			);
			expect(JSON.stringify(additive)).not.toContain("review-stage-key");
		}
	},
);
