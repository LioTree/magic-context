import { log } from "../../../shared/logger";
import type { ClassifyModuleClient } from "./classify";
import { type DreamTaskName, isCanonicalDreamTask } from "./task-registry";

/**
 * Which dream tasks the ck-mc module runs for this project, read from the one
 * list the module publishes (`dream.ownership`). The scheduler skips exactly
 * these and runs every other task, so this host never keeps its own copy of
 * what Rust implements.
 *
 * The module publishes a task only when it can actually run it: the user's
 * `rust_background_enabled` is on there too, a Rust executor for the task is
 * wired, and a claimant that can carry the task's children (a daemon-attested
 * harness, or a Broca runner the user configured) has declared itself. A host
 * that is not attached to ck-mc, or whose read fails, skips nothing.
 */
export interface RustOwnershipReadArgs {
    /** The host's live `rust_background_enabled`, sampled for this run. */
    rustBackgroundEnabled: boolean | undefined;
    /** Present only when this host is attached to ck-mc. */
    moduleClient: ClassifyModuleClient | undefined;
    projectIdentity: string;
    projectRoot: string;
    timeoutMs?: number;
}

const NOTHING_OWNED: ReadonlySet<DreamTaskName> = new Set();
const OWNERSHIP_READ_TIMEOUT_MS = 5_000;

/**
 * Decode the module's answer. Anything that is not a well-formed v1 answer
 * means "Rust owns nothing": running a task here is always safe, because the
 * dream-domain leases keep the two runtimes from running it at the same time.
 */
export function decodeRustOwnership(response: unknown): ReadonlySet<DreamTaskName> {
    const body = (response as { result?: unknown } | null)?.result ?? response;
    if (!body || typeof body !== "object") return NOTHING_OWNED;
    const answer = body as { ok?: unknown; v?: unknown; activated?: unknown; published?: unknown };
    if (answer.ok !== true || answer.v !== 1 || answer.activated !== true) return NOTHING_OWNED;
    if (!Array.isArray(answer.published)) return NOTHING_OWNED;
    const owned = new Set<DreamTaskName>();
    for (const task of answer.published) {
        // A task name this host does not know cannot be one it would run.
        if (typeof task === "string" && isCanonicalDreamTask(task)) owned.add(task);
    }
    return owned;
}

export async function readRustOwnedDreamTasks(
    args: RustOwnershipReadArgs,
): Promise<ReadonlySet<DreamTaskName>> {
    // Off, or no ck-mc: no module call at all, so this host behaves as before.
    if (args.rustBackgroundEnabled !== true || !args.moduleClient) return NOTHING_OWNED;
    try {
        const response = await args.moduleClient.call({
            // The dreamer's module route is keyed by the project identity, the
            // same route the dreamer's own module calls use.
            sessionId: args.projectIdentity,
            projectRoot: args.projectRoot,
            method: "dream.ownership",
            body: { method: "dream.ownership", v: 1 },
            timeoutMs: args.timeoutMs ?? OWNERSHIP_READ_TIMEOUT_MS,
        });
        const owned = decodeRustOwnership(response);
        if (owned.size > 0) {
            log(`[dreamer] ck-mc runs ${[...owned].join(", ")} for ${args.projectIdentity}`);
        }
        return owned;
    } catch (error) {
        log(`[dreamer] ck-mc dream ownership unreadable; running every task here: ${error}`);
        return NOTHING_OWNED;
    }
}

/** What ck-mc answered when a manual `/ctx-dream` asked it to run a task it owns. */
export type RustManualRunOutcome = { started: true } | { started: false; reason: string };

/** Starts one Rust-owned task now; supplied only when the host is attached to ck-mc. */
export type RunRustOwnedDreamTask = (task: DreamTaskName) => Promise<RustManualRunOutcome>;

const DREAM_RUN_TIMEOUT_MS = 10_000;

/**
 * Decode ck-mc's `dream.run` answer: `{ok:true, started:true}` when the run
 * started, `{ok:false, refusal}` when ck-mc does not own the task (any more),
 * `{ok:false, started:false}` when a run for the project is already in flight.
 */
export function decodeRustDreamRun(response: unknown): RustManualRunOutcome {
    const body = (response as { result?: unknown } | null)?.result ?? response;
    const answer = (body && typeof body === "object" ? body : {}) as {
        ok?: unknown;
        started?: unknown;
        refusal?: unknown;
    };
    if (answer.ok === true && answer.started === true) return { started: true };
    if (typeof answer.refusal === "string") return { started: false, reason: answer.refusal };
    if (answer.started === false) return { started: false, reason: "a ck-mc run is in progress" };
    return { started: false, reason: "unexpected answer" };
}

/**
 * A runner for manual `/ctx-dream` that asks ck-mc to run a task it publishes as
 * its own (`dream.run {v:1, task, command_id}`), on the same module route as the
 * ownership read. Each call uses a fresh command id: ck-mc never runs one id
 * twice, and every manual command is a new request. The run itself proceeds in
 * ck-mc; the answer only says whether it started.
 */
export function createRustOwnedDreamRunner(args: {
    moduleClient: ClassifyModuleClient;
    projectIdentity: string;
    projectRoot: string;
    timeoutMs?: number;
}): RunRustOwnedDreamTask {
    return async (task) => {
        try {
            const response = await args.moduleClient.call({
                sessionId: args.projectIdentity,
                projectRoot: args.projectRoot,
                method: "dream.run",
                body: {
                    method: "dream.run",
                    v: 1,
                    task,
                    command_id: `ctx-dream:${crypto.randomUUID()}`,
                },
                timeoutMs: args.timeoutMs ?? DREAM_RUN_TIMEOUT_MS,
            });
            return decodeRustDreamRun(response);
        } catch (error) {
            log(`[dreamer] ck-mc dream.run ${task} failed: ${error}`);
            return { started: false, reason: "ck-mc unreachable" };
        }
    };
}
