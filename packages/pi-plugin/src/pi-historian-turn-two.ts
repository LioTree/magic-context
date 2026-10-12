import { resolveFactDecision } from "@magic-context/core/features/magic-context/memory/lifecycle-applier";
import type { ReportedProfile } from "@magic-context/core/features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "@magic-context/core/features/magic-context/memory/lifecycle-text";
import {
	runTurnTwo,
	type TurnTwoCarrier,
	type TurnTwoRecoveryResolver,
} from "@magic-context/core/features/magic-context/memory/turn-two";
import {
	closeTurnTwoChild,
	registerTurnTwoChild,
	retainedTurnTwoChild,
} from "@magic-context/core/features/magic-context/memory/turn-two-children";
import type { TurnTwoExcerptReader } from "@magic-context/core/features/magic-context/memory/turn-two-scoring";
import { renderCheckInput } from "@magic-context/core/hooks/magic-context/historian-turn-two-carrier";
import type { Database } from "@magic-context/core/shared/sqlite";
import type {
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";
import type {
	PiRpcHistorianChild,
	PiRpcHistorianRunner,
} from "./subagent-runner";

export const PI_RPC_CARRIER = "pi-historian-rpc";
const liveChildren = new Map<string, PiRpcHistorianChild>();
const liveCarriers = new Map<string, TurnTwoCarrier>();
const scheduled = new Set<Promise<void>>();

export function isPiRpcHistorianRunner(
	runner: SubagentRunner,
): runner is PiRpcHistorianRunner {
	return (
		"canRetainHistorian" in runner &&
		runner.canRetainHistorian === true &&
		"runRetainedHistorian" in runner &&
		typeof runner.runRetainedHistorian === "function"
	);
}

function processExists(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Leave facts reserved by another live Pi parent and its RPC child in flight; only that parent can finish their stage. */
function carrierAlive(id: string | null): boolean {
	if (!id) return false;
	const local = liveChildren.get(id);
	if (local) return local.alive;
	const match = /^pi-rpc:(\d+):(\d+):/.exec(id);
	return (
		!!match &&
		Number(match[1]) !== process.pid &&
		processExists(Number(match[1])) &&
		processExists(Number(match[2]))
	);
}

/** Pi keeps conversation and check state in its processes. After they exit, retry unfinished facts even if a reply was stored before checks completed. */
export function recoverLostPiRpcStages(
	db: Database,
	projectPath?: string,
): number {
	const stages = db
		.prepare(
			`SELECT stage_key,child_session_id FROM memory_stage_attempts
		 WHERE carrier=? AND stage='turn_two' AND state IN ('reserved','sending','replied')
		 ${projectPath ? "AND project_path=?" : ""}`,
		)
		.all(PI_RPC_CARRIER, ...(projectPath ? [projectPath] : [])) as Array<{
		stage_key: string;
		child_session_id: string | null;
	}>;
	let released = 0;
	for (const stage of stages) {
		if (carrierAlive(stage.child_session_id)) continue;
		db.transaction(() => {
			const facts = db
				.prepare(
					"SELECT id,project_path FROM memory_pending_facts WHERE state='in_flight' AND reserved_stage_key=?",
				)
				.all(stage.stage_key) as Array<{ id: number; project_path: string }>;
			for (const fact of facts)
				resolveFactDecision(db, {
					key: JSON.stringify([stage.stage_key, fact.id, "carrier_lost"]),
					projectPath: fact.project_path,
					factId: fact.id,
					operation: "turn_two",
					state: "retryable",
					reason: "carrier_lost",
				});
			db.prepare(
				"UPDATE memory_stage_attempts SET state='lost' WHERE stage_key=? AND state IN ('reserved','sending','replied')",
			).run(stage.stage_key);
			released += facts.length;
		}).immediate();
		if (stage.child_session_id) {
			liveChildren.delete(stage.child_session_id);
			void closeTurnTwoChild(stage.child_session_id);
		}
	}
	return released;
}

function reportedProfile(
	result: SubagentRunResult,
	options: SubagentRunOptions,
	systemHash: string,
): ReportedProfile | null {
	const provider = result.meta?.reportedProvider;
	const modelId = result.meta?.reportedModel;
	if (typeof provider !== "string" || typeof modelId !== "string") return null;
	return {
		provider,
		modelId,
		variant: options.thinkingLevel ?? null,
		temperature: options.temperature ?? null,
		systemHash,
	};
}

/** Tests can require JSON replies. Production Pi cannot enforce a reply schema, so it never enables this reconciliation carrier. */
export function createPiTurnTwoCarrier(args: {
	child: PiRpcHistorianChild;
	runner: PiRpcHistorianRunner;
	options: SubagentRunOptions;
	turnOneText: string;
	enforcedJson: boolean;
}): TurnTwoCarrier {
	const systemHash = lifecycleTextHash(args.options.systemPrompt);
	return {
		carrier: PI_RPC_CARRIER,
		harness: "pi",
		enforcedJson: args.enforcedJson,
		childSessionId: args.child.id,
		baseline: lifecycleTextHash(args.turnOneText),
		historianSystemHash: systemHash,
		variant: args.options.thinkingLevel ?? null,
		async send(prompt, key) {
			const result = await args.child.send(prompt, key);
			if (!result.ok)
				throw new Error(`Pi turn two: ${result.reason}: ${result.error}`);
			return {
				text: result.assistantText,
				lengthCapped: result.meta?.lengthCapped === true,
				profile: reportedProfile(result, args.options, systemHash),
				usage: result.meta?.usage,
			};
		},
		async check(request) {
			const options = {
				...args.options,
				systemPrompt: request.system,
				userMessage: renderCheckInput(request),
				fallbackModels: undefined,
			};
			const { result, child } = await args.runner.runRetainedHistorian(
				options,
				request.key,
			);
			try {
				if (!result.ok)
					throw new Error(`Pi check: ${result.reason}: ${result.error}`);
				const profile = reportedProfile(result, options, request.systemHash);
				let verdicts = [];
				try {
					verdicts = JSON.parse(result.assistantText).verdicts;
				} catch {
					/* Malformed output is a refusing verdict, not a transport retry. */
				}
				return {
					verdicts:
						Array.isArray(verdicts) && result.meta?.lengthCapped !== true
							? verdicts
							: [],
					profile: profile ?? {
						provider: "",
						modelId: "",
						variant: null,
						temperature: null,
						systemHash: request.systemHash,
					},
					usage: result.meta?.usage,
				};
			} finally {
				await child?.close();
			}
		},
	};
}

const recoverLivePiRpcStage: TurnTwoRecoveryResolver = (record) => {
	if (record.carrier !== PI_RPC_CARRIER || !record.childSessionId) return null;
	const child = liveChildren.get(record.childSessionId);
	const carrier = liveCarriers.get(record.childSessionId);
	if (!child || !carrier) return "busy";
	if (retainedTurnTwoChild(record.childSessionId)?.active) return "busy";
	return {
		check: carrier.check,
		reattach: async () => ({ kind: child.alive ? "unknown" : "gone" }),
		close: () => closeTurnTwoChild(child.id),
	};
};

/** Schedule memory reconciliation after publication so it holds no compartment write lease and user requests do not wait on it. Keep its RPC child open until the reserved facts resolve. */
export function schedulePiHistorianTurnTwo(args: {
	db: Database;
	projectPath: string;
	publicationId: string;
	sessionId: string;
	child: PiRpcHistorianChild;
	runner: PiRpcHistorianRunner;
	options: SubagentRunOptions;
	turnOneText: string;
	memoryEnabled: boolean;
	autoPromote: boolean;
	validatedProfiles: readonly ReportedProfile[];
	log: (message: string) => void;
	readExcerpt?: TurnTwoExcerptReader;
}): void {
	liveChildren.set(args.child.id, args.child);
	const carrier = createPiTurnTwoCarrier({ ...args, enforcedJson: true });
	liveCarriers.set(args.child.id, carrier);
	registerTurnTwoChild({
		childSessionId: args.child.id,
		parentSessionId: args.sessionId,
		harness: "pi",
		handle: args.child,
		active: true,
		close: async () => {
			liveChildren.delete(args.child.id);
			liveCarriers.delete(args.child.id);
			await args.child.close();
		},
	});
	const task = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
		async () => {
			try {
				const result = await runTurnTwo(args.db, {
					...args,
					lane: "enabled",
					carrier,
					recover: recoverLivePiRpcStage,
				});
				if (result.childInFlight) return;
			} catch (error) {
				args.log(`Pi turn two failed: ${String(error)}`);
				if (
					args.db
						.prepare(
							"SELECT 1 FROM memory_stage_attempts WHERE child_session_id=? AND stage='turn_two' AND state IN ('reserved','sending','replied')",
						)
						.get(args.child.id)
				)
					return;
			}
			await closeTurnTwoChild(args.child.id);
		},
	);
	scheduled.add(task);
	const settled = () => {
		scheduled.delete(task);
		const retained = retainedTurnTwoChild(args.child.id);
		if (retained) retained.active = false;
	};
	void task.then(settled, (error) => {
		args.log(`Pi turn two failed: ${String(error)}`);
		settled();
	});
}

export async function settlePiHistorianTurnTwoRuns(): Promise<void> {
	while (scheduled.size) await Promise.allSettled([...scheduled]);
}
