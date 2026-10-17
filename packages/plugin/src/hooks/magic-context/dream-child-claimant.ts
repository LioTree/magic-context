import { randomBytes } from "node:crypto";
import { log as defaultLog } from "../../shared/logger";

/**
 * The host half of the Rust dream-child claim protocol (`dream-claim-v1`).
 *
 * When the Rust module owns a dream task and its selected runner is the host,
 * `dream_runner` picks ONE attempt (agent, tools, step cap, token budget, model,
 * prompt, absolute deadline) and parks it in a process-owned queue. This
 * claimant takes that one attempt and runs it as a hidden child session of the
 * host it lives in. It never picks a model or a fallback, never widens the
 * tool list or the limits, and never sends the prompt twice.
 *
 * The protocol, in the order a claimant meets it:
 *
 *   dream.child.pending      entries waiting for this route's session
 *   dream.child.claim        take one, declaring what this host can enforce
 *   dream.child.unavailable  give back a claimed entry this host cannot run
 *   dream.child.opened       report the native id of the child just created
 *   dream.child.heartbeat    keep the claim alive; learn start / stop
 *   dream.child.event        ordered step / usage / message / receipt / complete
 *   dream.child.tool         run a Magic Context tool on the task-bound route
 *   dream.child.cleanup      the child is quiescent and retired
 *
 * Five rules shape everything below.
 *
 * 1. **Only what is enforced is declared.** The claim's capabilities are the
 *    host's promise about guards that run where the child's model steps and
 *    tool calls actually execute. A descriptor the host cannot enforce is given
 *    back as unavailable before anything is created.
 * 2. **Authority comes from this record, never from the model.** Every request
 *    after the claim carries the entry id, token, logical child id and epoch
 *    stored here when the claim was granted. Tool arguments are forwarded as
 *    data and cannot change which attempt a call belongs to.
 * 3. **Nothing paid starts without `start:true`.** The child is created and
 *    reported first; the prompt goes out once, only after a heartbeat says the
 *    module is waiting for it.
 * 4. **Every model step and every tool is admitted at the executor boundary.**
 *    The host's hooks call into the gate registered for that child before the
 *    step or the tool runs. A step the gate cannot report stops the child.
 * 5. **Stop always ends in cleanup.** Whatever stopped the attempt (the module,
 *    a lost heartbeat, the absolute deadline, a refused step), the child is
 *    aborted, retired, and only then acknowledged as quiescent and retired.
 */

export const DREAM_CLAIM_VERSION = 1;

export type DreamChildMethod =
    | "dream.child.pending"
    | "dream.child.claim"
    | "dream.child.opened"
    | "dream.child.heartbeat"
    | "dream.child.event"
    | "dream.child.tool"
    | "dream.child.cleanup"
    | "dream.child.unavailable";

/**
 * What a claimant promises to enforce, as the claim declares it. The meaning of
 * each flag is fixed by the protocol: `tools` lists exact tool names the host
 * can carry, and each boolean names a guard the host runs at execution time.
 */
export interface DreamChildCapabilities {
    tools: readonly string[];
    child_guard: boolean;
    steps: boolean;
    tokens: boolean;
    stop: boolean;
    retire: boolean;
    task_tools: boolean;
    filesystem_fence: boolean;
    default_model: boolean;
}

/** The attempt-scoped authentication every post-claim request carries. */
export interface DreamChildCredential {
    entry_id: string;
    token: string;
    child_id: string;
    claimant_epoch: string;
}

export interface DreamChildModel {
    model: string;
    qualifier: string | null;
}

/** The one selected attempt the module handed this claimant. */
export interface DreamChildDescriptor {
    task: string;
    invocation: string;
    parentSessionId: string;
    childId: string;
    directory: string;
    agent: string;
    allowedTools: readonly string[];
    maxSteps: number;
    model: DreamChildModel | null;
    system: string;
    prompt: string;
    deadlineMs: number;
    tokenBudget: number | null;
}

export interface DreamChildControl {
    start: boolean;
    stop: boolean;
    retire: boolean;
    claimDeadlineMs: number | null;
    heartbeatIntervalMs: number;
}

export interface DreamChildUsage {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
}

export type DreamChildEvent =
    | { kind: "step" }
    | { kind: "message"; message_id: string; role: string; text: string }
    | { kind: "usage"; message_id: string; usage: DreamChildUsage; completed: boolean }
    | { kind: "receipt"; call_id: string }
    | { kind: "complete"; text: string; length_capped: boolean };

export type DreamBudgetAction = "continue" | "finalize" | "stop";

/**
 * Request bodies, one per method, exactly as `dream-claim-v1` defines them. The
 * management call adds `method`. Field order is irrelevant on the wire; the
 * conformance test compares these against the frozen vectors in canonical form.
 */
export const dreamClaimWire = {
    pending: (): Record<string, unknown> => ({ v: DREAM_CLAIM_VERSION }),
    claim: (
        entryId: string,
        claimantEpoch: string,
        capabilities: DreamChildCapabilities,
    ): Record<string, unknown> => ({
        v: DREAM_CLAIM_VERSION,
        entry_id: entryId,
        claimant_epoch: claimantEpoch,
        capabilities: {
            tools: [...capabilities.tools],
            child_guard: capabilities.child_guard,
            steps: capabilities.steps,
            tokens: capabilities.tokens,
            stop: capabilities.stop,
            retire: capabilities.retire,
            task_tools: capabilities.task_tools,
            filesystem_fence: capabilities.filesystem_fence,
            default_model: capabilities.default_model,
        },
    }),
    opened: (credential: DreamChildCredential, hostChildId: string): Record<string, unknown> => ({
        v: DREAM_CLAIM_VERSION,
        ...credentialFields(credential),
        host_child_id: hostChildId,
    }),
    heartbeat: (credential: DreamChildCredential): Record<string, unknown> => ({
        v: DREAM_CLAIM_VERSION,
        ...credentialFields(credential),
    }),
    event: (
        credential: DreamChildCredential,
        seq: number,
        event: DreamChildEvent,
    ): Record<string, unknown> => ({
        v: DREAM_CLAIM_VERSION,
        ...credentialFields(credential),
        seq,
        event,
    }),
    tool: (
        credential: DreamChildCredential,
        callId: string,
        tool: string,
        args: unknown,
    ): Record<string, unknown> => ({
        v: DREAM_CLAIM_VERSION,
        ...credentialFields(credential),
        call_id: callId,
        tool,
        arguments: args ?? {},
    }),
    cleanup: (
        credential: DreamChildCredential,
        evidence: { quiescent: boolean; retired: boolean },
    ): Record<string, unknown> => ({
        v: DREAM_CLAIM_VERSION,
        ...credentialFields(credential),
        quiescent: evidence.quiescent,
        retired: evidence.retired,
    }),
    /** Pre-start give-back. Only sent when nothing was created or the child is already retired. */
    unavailable: (credential: DreamChildCredential): Record<string, unknown> => ({
        v: DREAM_CLAIM_VERSION,
        ...credentialFields(credential),
        quiescent: true,
        retired: true,
    }),
};

function credentialFields(credential: DreamChildCredential): DreamChildCredential {
    // Copied field by field so nothing else the record holds can ride along.
    return {
        entry_id: credential.entry_id,
        token: credential.token,
        child_id: credential.child_id,
        claimant_epoch: credential.claimant_epoch,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ok:false, refusal}` is an ordinary answer; anything unreadable is treated as a refusal too. */
export function dreamRefusalOf(response: unknown): string | null {
    if (!isRecord(response)) return "malformed_response";
    if (response.ok === true) return null;
    const refusal = response.refusal;
    return typeof refusal === "string" && refusal.length > 0 ? refusal : "malformed_response";
}

export function decodeDreamPending(
    response: unknown,
): Array<{ entryId: string; deadlineMs: number }> {
    if (!isRecord(response) || response.ok !== true || !Array.isArray(response.entries)) return [];
    const entries: Array<{ entryId: string; deadlineMs: number }> = [];
    for (const entry of response.entries) {
        if (!isRecord(entry) || typeof entry.entry_id !== "string") continue;
        entries.push({
            entryId: entry.entry_id,
            deadlineMs: typeof entry.deadline_ms === "number" ? entry.deadline_ms : 0,
        });
    }
    return entries;
}

export function decodeDreamControl(response: unknown): DreamChildControl | null {
    if (!isRecord(response) || response.ok !== true) return null;
    if (typeof response.start !== "boolean" || typeof response.stop !== "boolean") return null;
    return {
        start: response.start,
        stop: response.stop,
        retire: response.retire === true,
        claimDeadlineMs:
            typeof response.claim_deadline_ms === "number" ? response.claim_deadline_ms : null,
        heartbeatIntervalMs:
            typeof response.heartbeat_interval_ms === "number" && response.heartbeat_interval_ms > 0
                ? response.heartbeat_interval_ms
                : 5_000,
    };
}

function finiteNonNegative(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A granted claim, or null when the body is not one this claimant can read.
 * Every descriptor field is required: a claim missing its step cap or deadline
 * cannot be enforced, so it is not run.
 */
export function decodeDreamClaim(response: unknown): {
    credentialWithoutEpoch: Omit<DreamChildCredential, "claimant_epoch">;
    descriptor: DreamChildDescriptor;
    control: DreamChildControl;
} | null {
    if (!isRecord(response) || response.ok !== true) return null;
    const d = response.descriptor;
    const control = decodeDreamControl(response.control);
    if (
        typeof response.entry_id !== "string" ||
        typeof response.token !== "string" ||
        !isRecord(d) ||
        !control
    ) {
        return null;
    }
    const allowed = Array.isArray(d.allowed_tools) ? d.allowed_tools : null;
    const maxSteps = finiteNonNegative(d.max_steps);
    const deadlineMs = finiteNonNegative(d.deadline_ms);
    const model = d.model;
    let decodedModel: DreamChildModel | null = null;
    if (model !== null) {
        if (!isRecord(model) || typeof model.model !== "string" || model.model.length === 0)
            return null;
        decodedModel = {
            model: model.model,
            qualifier: typeof model.qualifier === "string" ? model.qualifier : null,
        };
    }
    const tokenBudget = d.token_budget === null ? null : finiteNonNegative(d.token_budget);
    if (
        typeof d.child_id !== "string" ||
        typeof d.parent_session_id !== "string" ||
        typeof d.directory !== "string" ||
        typeof d.agent !== "string" ||
        typeof d.system !== "string" ||
        typeof d.prompt !== "string" ||
        !allowed ||
        allowed.some((tool) => typeof tool !== "string") ||
        maxSteps === null ||
        deadlineMs === null ||
        (d.token_budget !== null && tokenBudget === null)
    ) {
        return null;
    }
    return {
        credentialWithoutEpoch: {
            entry_id: response.entry_id,
            token: response.token,
            child_id: d.child_id,
        },
        descriptor: {
            task: typeof d.task === "string" ? d.task : "",
            invocation: typeof d.invocation === "string" ? d.invocation : "",
            parentSessionId: d.parent_session_id,
            childId: d.child_id,
            directory: d.directory,
            agent: d.agent,
            allowedTools: allowed as string[],
            maxSteps,
            model: decodedModel,
            system: d.system,
            prompt: d.prompt,
            deadlineMs,
            tokenBudget,
        },
        control,
    };
}

export function decodeDreamEventAck(
    response: unknown,
): { ok: true; budgetAction: DreamBudgetAction | null } | { ok: false; refusal: string } {
    const refusal = dreamRefusalOf(response);
    if (refusal !== null) return { ok: false, refusal };
    const action = isRecord(response) ? response.budget_action : undefined;
    return {
        ok: true,
        budgetAction:
            action === "continue" || action === "finalize" || action === "stop" ? action : null,
    };
}

export function decodeDreamToolResult(
    response: unknown,
): { ok: true; output: unknown; receipt: boolean } | { ok: false; refusal: string } {
    const refusal = dreamRefusalOf(response);
    if (refusal !== null) return { ok: false, refusal };
    const body = response as Record<string, unknown>;
    return { ok: true, output: body.output, receipt: isRecord(body.receipt) };
}

/**
 * Tools whose calls leave the host on the credential-bearing task route
 * (`dream.child.tool`) instead of executing in the host. Their effects are
 * applied by the module's task router, which rechecks the task and domain
 * leases inside the transaction that applies them.
 */
export const DREAM_TASK_ROUTED_TOOLS: ReadonlySet<string> = new Set(["ctx_memory"]);

/** One assistant message the host recorded for a dream child, with the provider's own usage. */
export interface DreamChildTranscriptMessage {
    id: string;
    text: string;
    /** Null when the host recorded no usage for this message. */
    usage: DreamChildUsage | null;
    /** The provider finished this message (its usage is final). */
    finished: boolean;
    finish?: string;
}

/** A hidden child created for one claimed attempt. */
export interface DreamChildRun {
    readonly hostChildId: string;
    /** Sends the claim's prompt exactly once and resolves when the child is idle. */
    prompt(signal: AbortSignal): Promise<void>;
    /** Assistant messages in the order the host recorded them. */
    transcript(): Promise<DreamChildTranscriptMessage[]>;
    /** Interrupts the child; resolves true only once the host confirms it is idle. */
    abort(): Promise<boolean>;
    /** Removes the child; resolves true only once the host confirms it is gone. */
    retire(): Promise<boolean>;
}

/** The host-specific half: which descriptors it can carry and how it creates a child. */
export interface DreamChildHost {
    readonly capabilities: DreamChildCapabilities;
    /** Why this host cannot enforce `descriptor`, or undefined when it can. */
    refusal(descriptor: DreamChildDescriptor): string | undefined | Promise<string | undefined>;
    create(descriptor: DreamChildDescriptor, signal: AbortSignal): Promise<DreamChildRun>;
}

export class DreamChildRefusal extends Error {
    constructor(readonly reason: string) {
        super(`Magic Context dream child refused: ${reason}`);
        this.name = "DreamChildRefusal";
    }
}

/**
 * What the host hooks call for a session that is a claimed dream child. Every
 * method is keyed by the host's own child session id, which the claimant
 * recorded when it created the child; nothing a model sends selects a gate.
 */
export interface DreamChildGate {
    readonly hostChildId: string;
    /** Admit the next paid model step, or throw `DreamChildRefusal`. */
    admitStep(): Promise<void>;
    /** Why `tool` must not execute in this child now, or undefined when it may. */
    toolRefusal(tool: string): string | undefined;
    /** Run a task-routed tool on the credential-bearing route; returns the model-facing output. */
    runTaskTool(tool: string, args: unknown): Promise<string>;
}

// Process-wide so every copy of this module (plugin source, a bundled build, a
// test plugin in the same host) consults the same set of live dream children.
const GATE_REGISTRY_KEY = Symbol.for("magic-context.dream-child-gates");

function gateRegistry(): Map<string, DreamChildGate> {
    const holder = globalThis as unknown as Record<symbol, Map<string, DreamChildGate> | undefined>;
    let registry = holder[GATE_REGISTRY_KEY];
    if (!registry) {
        registry = new Map();
        holder[GATE_REGISTRY_KEY] = registry;
    }
    return registry;
}

/** The gate for a host session that is a live claimed dream child, if it is one. */
export function dreamChildGate(sessionId: string | undefined): DreamChildGate | undefined {
    return sessionId === undefined ? undefined : gateRegistry().get(sessionId);
}

/** Host hook helper: refusal text for a tool call in a dream child, or undefined. */
export function dreamChildToolRefusal(
    sessionId: string | undefined,
    tool: string,
): string | undefined {
    return dreamChildGate(sessionId)?.toolRefusal(tool);
}

/** Host hook helper: admit a model step for a dream child; a no-op for any other session. */
export async function admitDreamChildStep(sessionId: string | undefined): Promise<void> {
    await dreamChildGate(sessionId)?.admitStep();
}

export interface DreamChildCallArgs {
    method: DreamChildMethod;
    sessionId: string;
    body: Record<string, unknown>;
}

export interface DreamChildClaimantDeps {
    /** Sends one management op on the route bound to `sessionId` and returns its decoded body. */
    call(args: DreamChildCallArgs): Promise<unknown>;
    host: DreamChildHost;
    /** Identifies this claimant incarnation in diagnostics; a fresh random value by default. */
    claimantEpoch?: string;
    now?(): number;
    log?(message: string): void;
    /** Test seam: replaces the wall-clock timers. */
    schedule?(callback: () => void, delayMs: number): () => void;
    /** How often to ask for control while waiting for start or for the module's close. */
    fastPollMs?: number;
    /** How often to look for pending entries on sessions this host has served recently. */
    pollIntervalMs?: number;
    /** Most attempts this claimant runs at once. */
    maxConcurrent?: number;
}

/** An entry this close to its deadline is not worth creating a child for. */
const CLAIM_START_MARGIN_MS = 2_000;
const FAST_POLL_MS = 50;
const POLL_INTERVAL_MS = 2_000;
/** A session not pumped for this long is no longer polled on a timer. */
const SESSION_IDLE_MS = 10 * 60_000;
const MAX_CONCURRENT = 4;

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * Refusals from the tool route that mean this attempt can do no more paid work.
 * `tool_not_admitted` and `call_conflict` refuse one call only; `token_budget`
 * blocks further tools (handled as finalization) without ending the attempt.
 */
const NON_TERMINAL_TOOL_REFUSALS = new Set(["tool_not_admitted", "call_conflict", "token_budget"]);

type ControlRead = DreamChildControl | "over" | "unsent";

interface AttemptDeps {
    call: DreamChildClaimantDeps["call"];
    host: DreamChildHost;
    routeSessionId: string;
    now(): number;
    log(message: string): void;
    schedule(callback: () => void, delayMs: number): () => void;
    fastPollMs: number;
}

/** One claimed attempt: its credential record, its child, and the gate the host hooks consult. */
export class DreamChildAttempt implements DreamChildGate {
    hostChildId = "";
    private run: DreamChildRun | undefined;
    private started = false;
    private stopReason: string | null = null;
    private moduleStopped = false;
    private claimOver = false;
    private finalized = false;
    private settling = false;
    private steps = 0;
    private seq = 0;
    private calls = 0;
    private completionSent = false;
    private readonly charged = new Set<string>();
    private readonly announced = new Set<string>();
    private eventTail: Promise<unknown> = Promise.resolve();
    private readonly abortController = new AbortController();
    private claimDeadlineMs: number | null;
    private cancelDeadline: (() => void) | null = null;
    private aborting: Promise<boolean> | null = null;

    constructor(
        private readonly deps: AttemptDeps,
        readonly credential: DreamChildCredential,
        readonly descriptor: DreamChildDescriptor,
        control: DreamChildControl,
    ) {
        this.claimDeadlineMs = control.claimDeadlineMs;
        this.moduleStopped = control.stop;
    }

    /** Why this attempt stopped, or null while it may still work. Diagnostics and tests. */
    get stoppedBecause(): string | null {
        return this.stopReason;
    }

    get stepsAdmitted(): number {
        return this.steps;
    }

    private send(method: DreamChildMethod, body: Record<string, unknown>): Promise<unknown> {
        return this.deps.call({ method, sessionId: this.deps.routeSessionId, body });
    }

    /**
     * The absolute instant this attempt must have stopped by: its own deadline,
     * or the last claim deadline the module acknowledged when that is earlier.
     * A claimant that loses contact still stops here without hearing from Rust.
     */
    private stopAt(): number {
        return this.claimDeadlineMs === null
            ? this.descriptor.deadlineMs
            : Math.min(this.descriptor.deadlineMs, this.claimDeadlineMs);
    }

    private armDeadline(): void {
        this.cancelDeadline?.();
        if (this.stopReason) return;
        const delay = Math.max(0, this.stopAt() - this.deps.now());
        this.cancelDeadline = this.deps.schedule(() => {
            this.cancelDeadline = null;
            void this.stop(
                this.deps.now() >= this.descriptor.deadlineMs ? "deadline" : "claim_deadline",
            );
        }, delay);
    }

    /** Latch a stop: no further steps, tools or events are admitted, and the child is interrupted. */
    stop(reason: string): Promise<boolean> {
        if (!this.stopReason) {
            this.stopReason = reason;
            this.deps.log(`dream child ${this.hostChildId || "(not created)"} stopping: ${reason}`);
            this.abortController.abort(new DreamChildRefusal(reason));
        }
        if (this.run && !this.aborting) {
            this.aborting = this.run.abort().catch((error) => {
                this.deps.log(`dream child ${this.hostChildId} abort failed: ${describeError(error)}`);
                return false;
            });
        }
        return this.aborting ?? Promise.resolve(true);
    }

    private async heartbeat(): Promise<ControlRead> {
        let response: unknown;
        try {
            response = await this.send(
                "dream.child.heartbeat",
                dreamClaimWire.heartbeat(this.credential),
            );
        } catch (error) {
            // Not evidence the claim is gone; the deadline timer still bounds the run.
            this.deps.log(`dream heartbeat could not be sent: ${describeError(error)}`);
            return "unsent";
        }
        return this.readControl(response);
    }

    private readControl(response: unknown): ControlRead {
        const refusal = dreamRefusalOf(response);
        if (refusal !== null) {
            this.claimOver = true;
            void this.stop(`claim_over:${refusal}`);
            return "over";
        }
        const control = decodeDreamControl(response);
        if (!control) {
            this.claimOver = true;
            void this.stop("claim_over:malformed_control");
            return "over";
        }
        if (control.claimDeadlineMs !== null) {
            this.claimDeadlineMs = control.claimDeadlineMs;
            this.armDeadline();
        }
        if (control.stop) {
            this.moduleStopped = true;
            void this.stop("module_stop");
        }
        return control;
    }

    /** Ends the control loop's current wait early (the attempt just settled). */
    private wake: (() => void) | null = null;

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const signal = this.abortController.signal;
            let finished = false;
            const done = () => {
                if (finished) return;
                finished = true;
                cancel();
                signal.removeEventListener("abort", done);
                if (this.wake === done) this.wake = null;
                resolve();
            };
            const cancel = this.deps.schedule(done, Math.max(0, ms));
            this.wake = done;
            if (signal.aborted) done();
            else signal.addEventListener("abort", done, { once: true });
        });
    }

    /** Ask for control until `until` holds, the attempt stops, or the claim ends. */
    private async pollControl(
        until: (control: DreamChildControl) => boolean,
        intervalMs: () => number,
    ): Promise<DreamChildControl | null> {
        for (;;) {
            if (this.stopReason || this.claimOver) return null;
            const control = await this.heartbeat();
            if (control === "over") return null;
            if (control !== "unsent") {
                if (control.stop) return control;
                if (until(control)) return control;
            }
            await this.sleep(intervalMs());
        }
    }

    /** Ordered event delivery: one in flight at a time, each with the next sequence number. */
    private sendEvent(
        event: DreamChildEvent,
    ): Promise<{ ok: true; budgetAction: DreamBudgetAction | null } | { ok: false; refusal: string }> {
        const next = this.eventTail.then(async () => {
            this.seq += 1;
            const body = dreamClaimWire.event(this.credential, this.seq, event);
            let response: unknown;
            try {
                response = await this.send("dream.child.event", body);
            } catch {
                // An exact replay of an accepted sequence returns its cached ack, so
                // resending the identical body once is safe.
                try {
                    response = await this.send("dream.child.event", body);
                } catch (error) {
                    return { ok: false as const, refusal: `unsent:${describeError(error)}` };
                }
            }
            const ack = decodeDreamEventAck(response);
            if (!ack.ok) {
                // A rejected event did not consume its sequence number.
                this.seq -= 1;
            }
            return ack;
        });
        this.eventTail = next.catch(() => undefined);
        return next;
    }

    private applyBudget(action: DreamBudgetAction | null): void {
        if (action === "finalize") this.finalized = true;
        if (action === "stop") {
            this.finalized = true;
            void this.stop("token_budget");
        }
    }

    /**
     * Charge every finished assistant message not charged yet, with the usage the
     * host recorded for it. `final` marks the last message as the completed
     * attempt's final provider report.
     */
    private async reportUsage(final: boolean): Promise<void> {
        const run = this.run;
        if (!run) return;
        const messages = await run.transcript();
        const pending = messages.filter(
            (message) => message.finished && message.usage && !this.charged.has(message.id),
        );
        for (const [index, message] of pending.entries()) {
            const usage = message.usage as DreamChildUsage;
            const ack = await this.sendEvent({
                kind: "usage",
                message_id: message.id,
                usage: {
                    input: usage.input,
                    output: usage.output,
                    cache_read: usage.cache_read,
                    cache_write: usage.cache_write,
                },
                completed: final && index === pending.length - 1,
            });
            if (!ack.ok) {
                if (!final) void this.stop(`usage_refused:${ack.refusal}`);
                return;
            }
            this.charged.add(message.id);
            this.applyBudget(ack.budgetAction);
        }
    }

    async admitStep(): Promise<void> {
        if (!this.started || this.settling) {
            // The child is running a step the module never started, or one after its
            // result was reported. Either way nobody is accountable for it.
            await this.stop(this.started ? "step_after_completion" : "step_before_start");
        }
        if (this.stopReason) throw new DreamChildRefusal(this.stopReason);
        await this.reportUsage(false);
        if (this.stopReason) throw new DreamChildRefusal(this.stopReason);
        // The claimant's own immutable cap, checked before the module is asked:
        // step N+1 never starts after cap N even if the module were to admit it.
        if (this.steps >= this.descriptor.maxSteps) {
            await this.stop("step_budget");
            throw new DreamChildRefusal("step_budget");
        }
        const ack = await this.sendEvent({ kind: "step" });
        if (!ack.ok) {
            await this.stop(`step_refused:${ack.refusal}`);
            throw new DreamChildRefusal(`step_refused:${ack.refusal}`);
        }
        if (this.stopReason) throw new DreamChildRefusal(this.stopReason);
        this.steps += 1;
    }

    toolRefusal(tool: string): string | undefined {
        if (this.stopReason) return `dream child stopped (${this.stopReason}); ${tool} refused`;
        if (!this.started || this.settling) return `dream child is not running; ${tool} refused`;
        const capabilities = this.deps.host.capabilities;
        if (
            !this.descriptor.allowedTools.includes(tool) ||
            !capabilities.tools.includes(tool) ||
            (!DREAM_TASK_ROUTED_TOOLS.has(tool) && !capabilities.filesystem_fence)
        ) {
            return `dream child ${this.descriptor.agent} may only use ${
                this.descriptor.allowedTools.length > 0
                    ? this.descriptor.allowedTools.join(", ")
                    : "no tools"
            }; ${tool} refused`;
        }
        if (this.finalized) return `Out of token budget: no more tool calls; ${tool} refused`;
        return undefined;
    }

    async runTaskTool(tool: string, args: unknown): Promise<string> {
        const refusal = this.toolRefusal(tool);
        if (refusal) throw new DreamChildRefusal(refusal);
        if (!DREAM_TASK_ROUTED_TOOLS.has(tool)) {
            throw new DreamChildRefusal(`${tool} is not a task-routed tool`);
        }
        this.calls += 1;
        const callId = `call-${this.calls}`;
        const body = dreamClaimWire.tool(this.credential, callId, tool, args);
        let response: unknown;
        try {
            response = await this.send("dream.child.tool", body);
        } catch {
            // The module replays a repeated call id without a second effect, so one
            // identical resend cannot apply the effect twice.
            try {
                response = await this.send("dream.child.tool", body);
            } catch (error) {
                throw new DreamChildRefusal(`tool route unavailable: ${describeError(error)}`);
            }
        }
        const result = decodeDreamToolResult(response);
        if (!result.ok) {
            if (result.refusal === "token_budget") this.finalized = true;
            if (!NON_TERMINAL_TOOL_REFUSALS.has(result.refusal)) {
                void this.stop(`tool_refused:${result.refusal}`);
            }
            throw new DreamChildRefusal(result.refusal);
        }
        if (result.receipt) await this.sendEvent({ kind: "receipt", call_id: callId });
        return typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.output ?? null);
    }

    /** Report the settled child's usage, messages and terminal text, once. */
    private async report(): Promise<void> {
        const run = this.run;
        if (!run || this.completionSent || this.claimOver) return;
        this.completionSent = true;
        let messages: DreamChildTranscriptMessage[] = [];
        try {
            await this.reportUsage(true);
            messages = await run.transcript();
        } catch (error) {
            this.deps.log(`dream child ${this.hostChildId} transcript unreadable: ${describeError(error)}`);
        }
        for (const message of messages) {
            if (!message.finished || message.text.length === 0 || this.announced.has(message.id))
                continue;
            const ack = await this.sendEvent({
                kind: "message",
                message_id: message.id,
                role: "assistant",
                text: message.text,
            });
            if (!ack.ok) return;
            this.announced.add(message.id);
        }
        const last = [...messages].reverse().find((message) => message.finished);
        const ack = await this.sendEvent({
            kind: "complete",
            text: last?.text ?? "",
            length_capped: last?.finish === "length" || last?.finish === "max_tokens",
        });
        if (!ack.ok) this.deps.log(`dream child ${this.hostChildId} completion refused: ${ack.refusal}`);
    }

    /** Give back an entry with no child: nothing was created, so nothing runs. */
    private async giveBack(reason: string): Promise<void> {
        this.deps.log(`dream entry given back unavailable: ${reason}`);
        try {
            const response = await this.send(
                "dream.child.unavailable",
                dreamClaimWire.unavailable(this.credential),
            );
            const refusal = dreamRefusalOf(response);
            if (refusal !== null) this.deps.log(`dream unavailable refused: ${refusal}`);
        } catch (error) {
            this.deps.log(`dream unavailable could not be sent: ${describeError(error)}`);
        }
    }

    /**
     * Interrupt, retire and acknowledge the child. The acknowledgement carries
     * only what the host confirmed: a child that could not be confirmed idle or
     * removed is reported as such, which the module treats as unknown cleanup.
     */
    private async cleanup(): Promise<void> {
        const run = this.run;
        if (!run) return;
        const quiescent = await this.stop(this.stopReason ?? "cleanup");
        let retired = false;
        try {
            retired = await run.retire();
        } catch (error) {
            this.deps.log(`dream child ${this.hostChildId} retire failed: ${describeError(error)}`);
        }
        const evidence = { quiescent, retired };
        if (!this.started && !this.moduleStopped) {
            // Stopped here before start while the module still waits: the explicit
            // pre-start give-back, with the same quiescent+retired evidence.
            const response = await this.send(
                "dream.child.unavailable",
                dreamClaimWire.cleanup(this.credential, evidence),
            ).catch((error) => ({ ok: false, refusal: `unsent:${describeError(error)}` }));
            const refusal = dreamRefusalOf(response);
            if (refusal !== "already_started") {
                if (refusal !== null) this.deps.log(`dream unavailable refused: ${refusal}`);
                return;
            }
            // The module started the attempt before this host saw it; take the
            // ordinary completion-and-cleanup path.
            this.started = true;
        }
        if (this.started) await this.report();
        for (;;) {
            const response = await this.send(
                "dream.child.cleanup",
                dreamClaimWire.cleanup(this.credential, evidence),
            ).catch((error) => ({ ok: false, refusal: `unsent:${describeError(error)}` }));
            const refusal = dreamRefusalOf(response);
            if (refusal === null) return;
            if (refusal !== "stop_required" && !refusal.startsWith("unsent:")) {
                this.deps.log(`dream cleanup for ${this.hostChildId} refused: ${refusal}`);
                return;
            }
            // The module has not latched its stop yet: it is still waiting for the
            // completion just reported, or for its own deadline. Ask again until it
            // does. Past the deadline any heartbeat latches it.
            if (this.deps.now() > this.descriptor.deadlineMs + 10_000) {
                this.deps.log(`dream cleanup for ${this.hostChildId} gave up: ${refusal}`);
                return;
            }
            const control = await this.heartbeat();
            if (control === "over") return;
            await new Promise<void>((resolve) => this.deps.schedule(resolve, this.deps.fastPollMs));
        }
    }

    /** Run the whole attempt. Resolves when the child is cleaned up or was never created. */
    async execute(): Promise<void> {
        this.armDeadline();
        const background: Promise<unknown>[] = [];
        try {
            let local: string | undefined;
            try {
                local = await this.deps.host.refusal(this.descriptor);
            } catch (error) {
                local = `host_check_failed: ${describeError(error)}`;
            }
            if (local) {
                await this.giveBack(local);
                return;
            }
            if (this.moduleStopped) {
                await this.giveBack("stopped_at_claim");
                return;
            }
            // Control is checked before anything is created.
            const before = await this.heartbeat();
            if (before === "over") return;
            if (before === "unsent" || before.stop || this.stopReason) {
                await this.giveBack(this.stopReason ?? "stopped_before_create");
                return;
            }
            let run: DreamChildRun;
            try {
                run = await this.deps.host.create(this.descriptor, this.abortController.signal);
            } catch (error) {
                await this.giveBack(`create_failed: ${describeError(error)}`);
                return;
            }
            this.run = run;
            this.hostChildId = run.hostChildId;
            // Registered before the module hears about the child, so any step or
            // tool the host runs on it from now on goes through this gate.
            gateRegistry().set(run.hostChildId, this);
            if (this.stopReason) void this.stop(this.stopReason);
            // A child created after a stop is still reported, so the module can pin
            // it and expect its cleanup.
            let opened: ControlRead;
            try {
                opened = this.readControl(
                    await this.send(
                        "dream.child.opened",
                        dreamClaimWire.opened(this.credential, run.hostChildId),
                    ),
                );
            } catch (error) {
                this.deps.log(`dream opened could not be sent: ${describeError(error)}`);
                opened = "unsent";
            }
            if (opened === "over" || this.stopReason) return;
            // Checked again after create and before the prompt.
            const start =
                opened !== "unsent" && opened.start
                    ? opened
                    : await this.pollControl(
                          (control) => control.start,
                          () => this.deps.fastPollMs,
                      );
            if (!start || start.stop || this.stopReason) return;
            this.started = true;
            background.push(
                this.pollControl(
                    () => false,
                    () => (this.settling ? this.deps.fastPollMs : start.heartbeatIntervalMs),
                ),
            );
            try {
                await run.prompt(this.abortController.signal);
            } catch (error) {
                if (!this.stopReason) {
                    this.deps.log(`dream child ${run.hostChildId} prompt failed: ${describeError(error)}`);
                }
            }
            this.settling = true;
            await this.report();
            this.wake?.();
            // The module closes the child once it has the result; wait for that stop.
            await Promise.all(background);
        } finally {
            this.cancelDeadline?.();
            this.cancelDeadline = null;
            try {
                await this.cleanup();
            } finally {
                if (this.run && gateRegistry().get(this.run.hostChildId) === this) {
                    gateRegistry().delete(this.run.hostChildId);
                }
                this.abortController.abort(new DreamChildRefusal("attempt_finished"));
            }
        }
    }
}

/**
 * Polls for dream-child entries on the sessions this host serves, claims them,
 * and runs each claimed attempt to cleanup.
 *
 * Pending entries are confined by the module to the route's bound session, so
 * each session this host has served recently is asked on its own route. A
 * transform pass calls `pump` for its session; between passes a bounded timer
 * keeps asking, because dream work is queued on the module's schedule rather
 * than by a pass.
 */
export class DreamChildClaimant {
    private readonly attempts = new Map<string, { attempt: DreamChildAttempt; done: Promise<void> }>();
    private readonly sessions = new Map<string, number>();
    private readonly polling = new Map<string, Promise<void>>();
    private readonly epoch: string;
    private timerCancel: (() => void) | null = null;
    private stopped = false;

    constructor(private readonly deps: DreamChildClaimantDeps) {
        this.epoch = deps.claimantEpoch ?? `ts-${process.pid}-${randomBytes(12).toString("hex")}`;
    }

    get claimantEpoch(): string {
        return this.epoch;
    }

    /** Attempts this claimant currently runs. Diagnostics and tests. */
    activeAttempts(): DreamChildAttempt[] {
        return [...this.attempts.values()].map((entry) => entry.attempt);
    }

    /** Settles once every attempt running now has been cleaned up. */
    async settled(): Promise<void> {
        await Promise.allSettled([...this.attempts.values()].map((entry) => entry.done));
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now();
    }

    private log(message: string): void {
        (this.deps.log ?? defaultLog)(`[magic-context] dream child claimant: ${message}`);
    }

    private schedule(callback: () => void, delayMs: number): () => void {
        if (this.deps.schedule) return this.deps.schedule(callback, delayMs);
        const timer = setTimeout(callback, delayMs);
        // Never hold the process open for a poll, heartbeat or deadline.
        (timer as unknown as { unref?: () => void }).unref?.();
        return () => clearTimeout(timer);
    }

    /** Look for work on `routeSessionId` now, and keep looking on a timer for a while. */
    pump(routeSessionId: string): Promise<void> {
        if (this.stopped) return Promise.resolve();
        this.sessions.set(routeSessionId, this.now());
        this.armTimer();
        return this.poll(routeSessionId);
    }

    /** Stop every attempt (each still ends in cleanup) and stop looking for more. */
    async stop(): Promise<void> {
        this.stopped = true;
        this.timerCancel?.();
        this.timerCancel = null;
        for (const { attempt } of this.attempts.values()) void attempt.stop("claimant_stopped");
        await this.settled();
    }

    private armTimer(): void {
        if (this.timerCancel || this.stopped) return;
        this.timerCancel = this.schedule(() => {
            this.timerCancel = null;
            const cutoff = this.now() - SESSION_IDLE_MS;
            for (const [session, seenAt] of this.sessions) {
                if (seenAt < cutoff) this.sessions.delete(session);
                else void this.poll(session);
            }
            if (this.sessions.size > 0) this.armTimer();
        }, this.deps.pollIntervalMs ?? POLL_INTERVAL_MS);
    }

    private poll(routeSessionId: string): Promise<void> {
        const inFlight = this.polling.get(routeSessionId);
        if (inFlight) return inFlight;
        const pass = this.runPoll(routeSessionId)
            .catch((error) => this.log(`poll failed: ${describeError(error)}`))
            .finally(() => this.polling.delete(routeSessionId));
        this.polling.set(routeSessionId, pass);
        return pass;
    }

    private async runPoll(routeSessionId: string): Promise<void> {
        if (this.stopped) return;
        const response = await this.deps.call({
            method: "dream.child.pending",
            sessionId: routeSessionId,
            body: dreamClaimWire.pending(),
        });
        const refusal = dreamRefusalOf(response);
        if (refusal !== null) {
            this.log(`the module refused this host's poll: ${refusal}`);
            return;
        }
        for (const entry of decodeDreamPending(response)) {
            if (this.stopped) return;
            if (this.attempts.size >= (this.deps.maxConcurrent ?? MAX_CONCURRENT)) return;
            if (this.attempts.has(entry.entryId)) continue;
            if (entry.deadlineMs - this.now() <= CLAIM_START_MARGIN_MS) continue;
            await this.claim(routeSessionId, entry.entryId);
        }
    }

    private async claim(routeSessionId: string, entryId: string): Promise<void> {
        let response: unknown;
        try {
            response = await this.deps.call({
                method: "dream.child.claim",
                sessionId: routeSessionId,
                body: dreamClaimWire.claim(entryId, this.epoch, this.deps.host.capabilities),
            });
        } catch (error) {
            this.log(`claim for ${entryId} could not be sent: ${describeError(error)}`);
            return;
        }
        const refusal = dreamRefusalOf(response);
        if (refusal !== null) {
            // `unavailable` here means the module itself found this host's declared
            // capabilities insufficient and retired the entry without a descriptor.
            this.log(`claim for ${entryId} refused: ${refusal}`);
            return;
        }
        const granted = decodeDreamClaim(response);
        if (!granted) {
            this.log(`claim for ${entryId} answered with a body this host cannot read`);
            const record = response as Record<string, unknown>;
            const descriptor = isRecord(record.descriptor) ? record.descriptor : {};
            if (typeof record.token === "string" && typeof descriptor.child_id === "string") {
                // Nothing was created, so the explicit give-back is honest.
                await this.deps
                    .call({
                        method: "dream.child.unavailable",
                        sessionId: routeSessionId,
                        body: dreamClaimWire.unavailable({
                            entry_id: entryId,
                            token: record.token,
                            child_id: descriptor.child_id,
                            claimant_epoch: this.epoch,
                        }),
                    })
                    .catch(() => undefined);
            }
            return;
        }
        const credential: DreamChildCredential = {
            ...granted.credentialWithoutEpoch,
            claimant_epoch: this.epoch,
        };
        const attempt = new DreamChildAttempt(
            {
                call: this.deps.call,
                host: this.deps.host,
                routeSessionId,
                now: () => this.now(),
                log: (message) => this.log(message),
                schedule: (callback, delayMs) => this.schedule(callback, delayMs),
                fastPollMs: this.deps.fastPollMs ?? FAST_POLL_MS,
            },
            credential,
            granted.descriptor,
            granted.control,
        );
        // Started, not awaited: one slow child must not delay claiming another.
        const done = attempt
            .execute()
            .catch((error) => this.log(`attempt ${entryId} ended unexpectedly: ${describeError(error)}`))
            .finally(() => this.attempts.delete(entryId));
        this.attempts.set(entryId, { attempt, done });
    }
}

export const __dreamChildClaimantTest = {
    CLAIM_START_MARGIN_MS,
    FAST_POLL_MS,
    POLL_INTERVAL_MS,
    gateRegistry,
};
