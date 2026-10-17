import { randomBytes } from "node:crypto";

/**
 * A scripted stand-in for the module's dream-child queue, for tests that drive
 * the TypeScript claimant without a ck-mc process. Its state machine follows
 * `crates/mc-module/src/dream_dispatch/host_carrier.rs` (`DreamQueue::route`,
 * `event`, `tool`) and `TokenBudget` in `crates/mc-store/src/dream_scheduler/
 * budget.rs`; the frozen `dream-claim-v1.json` vectors pin the same answers.
 *
 * It also plays the Rust runner's part: once the claimant reports the child it
 * marks the entry started (as `HostCarrier::complete` does), and once a
 * completion arrives it closes the entry (as `HostCarrier::close` does).
 *
 * It is a fixture, not an implementation: it never grants authority on its own
 * and every effect goes through the `router` the test supplies.
 */

export interface PeerDescriptor {
    session: string;
    project: string;
    directory: string;
    agent: string;
    allowedTools: string[];
    maxSteps: number;
    model: { model: string; qualifier: string | null } | null;
    system: string;
    prompt: string;
    deadlineMs: number;
    tokenBudget: number | null;
    task?: string;
}

export type PeerRouter = (
    child: string,
    tool: string,
    args: unknown,
) => {
    output: unknown;
    receipt: { tool: string; affected_ids: string[]; details: unknown } | null;
};

interface PeerEntry {
    id: string;
    child: string;
    descriptor: PeerDescriptor;
    claim: { token: string; epoch: string; until: number } | null;
    hostChild: string | null;
    start: boolean;
    stop: boolean;
    cleaned: boolean;
    completion: { text: string; length_capped: boolean } | null;
    budget: PeerBudget | null;
    nextSeq: number;
    events: Map<number, { payload: string; response: unknown }>;
    calls: Map<string, { input: string; response: unknown }>;
    messages: Map<string, string>;
    meters: Map<string, { payload: string; response: unknown }>;
    steps: number;
    leaseLost: boolean;
    cleanupEvidence: { quiescent: boolean; retired: boolean } | null;
}

/**
 * The charging rules of mc-store's `TokenBudget` (dream_scheduler/budget.rs),
 * copied so this peer answers usage the way the module does.
 */
class PeerBudget {
    spent = 0;
    finalizeFired = false;
    refusedCalls = 0;
    forcedStop = false;
    constructor(readonly budget: number) {}
    hardStopped(): boolean {
        return this.forcedStop || this.spent >= this.budget || this.refusedCalls >= 2;
    }
    charge(input: number, cacheRead: number, cacheWrite: number, completed: boolean) {
        this.spent += input + cacheRead + cacheWrite;
        if (completed) return "continue";
        if (this.spent >= this.budget) return "stop";
        if (!this.finalizeFired && this.spent >= this.budget * 0.8) {
            this.finalizeFired = true;
            return "finalize";
        }
        return "continue";
    }
    refuseTool(): boolean {
        if (!this.finalizeFired && !this.hardStopped()) return false;
        this.refusedCalls += 1;
        return true;
    }
}

export class DreamPeerAdmissionError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

const CLAIM_MS = 15_000;
const MANDATORY = ["child_guard", "steps", "tokens", "stop", "retire", "task_tools"];

export class DreamClaimPeer {
    readonly entries = new Map<string, PeerEntry>();
    /** Every request the peer received, in order, as `{method, ...body}`. */
    readonly requests: Array<Record<string, unknown>> = [];
    /** Effects the router applied, in order. */
    readonly effects: Array<{ child: string; tool: string; args: unknown }> = [];
    autoStart = true;
    autoClose = true;
    /**
     * Heartbeat interval this peer reports in control answers. The module reports
     * 5000 ms; tests may shorten it so a stop reaches the claimant sooner.
     */
    heartbeatIntervalMs = 5000;

    constructor(
        private readonly options: {
            now?: () => number;
            router?: PeerRouter;
        } = {},
    ) {}

    now(): number {
        return this.options.now?.() ?? Date.now();
    }

    enqueue(descriptor: PeerDescriptor): string {
        const id = randomBytes(8).toString("hex");
        this.entries.set(id, {
            id,
            child: `dream-${randomBytes(8).toString("hex")}`,
            descriptor,
            claim: null,
            hostChild: null,
            start: false,
            stop: false,
            cleaned: false,
            completion: null,
            budget: descriptor.tokenBudget === null ? null : new PeerBudget(descriptor.tokenBudget),
            nextSeq: 1,
            events: new Map(),
            calls: new Map(),
            messages: new Map(),
            meters: new Map(),
            steps: 0,
            leaseLost: false,
            cleanupEvidence: null,
        });
        return id;
    }

    entry(id: string): PeerEntry {
        const entry = this.entries.get(id);
        if (!entry) throw new Error(`no entry ${id}`);
        return entry;
    }

    /**
     * The runner stopped waiting for the child to open (its `HostCarrier::open`
     * future was dropped): the module stops the entry, as `DreamQueue::stop` does.
     */
    cancelOpen(id: string): void {
        const entry = this.entry(id);
        entry.stop = true;
        if (!entry.claim) entry.cleaned = true;
    }

    /** The runner's `close`: request stop and retirement. */
    close(id: string): void {
        this.entry(id).stop = true;
    }

    revokeLease(id: string): void {
        this.entry(id).leaseLost = true;
    }

    private live(entry: PeerEntry): string | null {
        const now = this.now();
        let refusal: string | null = null;
        if (entry.stop || entry.cleaned) refusal = "stopped";
        else if (now >= entry.descriptor.deadlineMs) refusal = "deadline";
        else if (entry.claim && now >= entry.claim.until) refusal = "claim_expired";
        else if (entry.leaseLost) refusal = "LeaseLost";
        if (refusal) entry.stop = true;
        return refusal;
    }

    private state(entry: PeerEntry): Record<string, unknown> {
        return {
            ok: true,
            start: entry.start && !entry.stop,
            stop: entry.stop,
            retire: entry.stop,
            claim_deadline_ms: entry.claim?.until ?? null,
            heartbeat_interval_ms: this.heartbeatIntervalMs,
        };
    }

    private refuse(refusal: string): Record<string, unknown> {
        return { ok: false, refusal };
    }

    /** One management request on the route bound to `session`. Throws for admission errors. */
    route(session: string, method: string, body: Record<string, unknown>): unknown {
        const request = { method, ...body };
        this.requests.push(JSON.parse(JSON.stringify(request)));
        if (body.v !== 1) throw new DreamPeerAdmissionError("bad_request");
        if (method === "dream.child.pending") {
            const entries = [...this.entries.values()]
                .filter((e) => e.descriptor.session === session)
                .filter((e) => this.live(e) === null && e.claim === null)
                .map((e) => ({ entry_id: e.id, deadline_ms: e.descriptor.deadlineMs }));
            return { ok: true, entries };
        }
        const entry = this.entries.get(String(body.entry_id));
        if (!entry || entry.descriptor.session !== session) return this.refuse("not_found");
        if (method === "dream.child.claim") {
            const live = this.live(entry);
            if (live) return this.refuse(live);
            if (entry.claim) return this.refuse("already_claimed");
            const caps = body.capabilities as Record<string, unknown> | undefined;
            const tools = Array.isArray(caps?.tools) ? (caps.tools as unknown[]) : null;
            if (!caps || !tools) return this.refuse("unavailable");
            const required = [...MANDATORY];
            if (entry.descriptor.allowedTools.some((t) => t !== "ctx_memory"))
                required.push("filesystem_fence");
            if (entry.descriptor.model === null) required.push("default_model");
            if (
                required.some((key) => caps[key] !== true) ||
                entry.descriptor.allowedTools.some((t) => !tools.includes(t))
            ) {
                entry.stop = true;
                entry.cleaned = true;
                return this.refuse("unavailable");
            }
            const token = randomBytes(16).toString("hex");
            entry.claim = {
                token,
                epoch: String(body.claimant_epoch),
                until: Math.min(entry.descriptor.deadlineMs, this.now() + CLAIM_MS),
            };
            const d = entry.descriptor;
            const scope = { project: d.project, session: d.session, generation: 1 };
            return {
                ok: true,
                entry_id: entry.id,
                token,
                descriptor: {
                    scope,
                    invocation: "invocation-1",
                    task: d.task ?? "curate",
                    task_lease: { scope, invocation: "invocation-1", expires_at_ms: d.deadlineMs },
                    domain: {
                        key: "dreaming",
                        holder: "owner",
                        generation: 1,
                        expires_at_ms: d.deadlineMs,
                    },
                    parent_session_id: d.session,
                    child_id: entry.child,
                    directory: d.directory,
                    agent: d.agent,
                    allowed_tools: d.allowedTools,
                    max_steps: d.maxSteps,
                    model: d.model,
                    system: d.system,
                    prompt: d.prompt,
                    deadline_ms: d.deadlineMs,
                    token_budget: d.tokenBudget,
                },
                control: this.state(entry),
            };
        }
        if (!entry.claim) return this.refuse("not_claimed");
        if (
            body.token !== entry.claim.token ||
            body.claimant_epoch !== entry.claim.epoch ||
            body.child_id !== entry.child
        ) {
            return this.refuse("stale_attempt");
        }
        switch (method) {
            case "dream.child.opened": {
                if (entry.cleaned) return this.refuse("stale_attempt");
                const hostChild = String(body.host_child_id);
                if (entry.hostChild !== null && entry.hostChild !== hostChild)
                    return this.refuse("child_changed");
                entry.hostChild = hostChild;
                this.live(entry);
                // The runner's `complete` starts the attempt as soon as open returns.
                if (this.autoStart && !entry.stop) entry.start = true;
                return this.state(entry);
            }
            case "dream.child.cleanup":
            case "dream.child.unavailable": {
                if (method === "dream.child.unavailable") {
                    if (entry.start) return this.refuse("already_started");
                    entry.stop = true;
                }
                if (!entry.stop) return this.refuse("stop_required");
                if (body.quiescent !== true || body.retired !== true)
                    return this.refuse("cleanup_unknown");
                entry.cleaned = true;
                entry.cleanupEvidence = { quiescent: true, retired: true };
                return { ok: true };
            }
            case "dream.child.heartbeat": {
                if (this.live(entry) === null && entry.claim) {
                    entry.claim.until = Math.min(
                        entry.descriptor.deadlineMs,
                        this.now() + CLAIM_MS,
                    );
                }
                return this.state(entry);
            }
            case "dream.child.event": {
                const live = this.live(entry);
                if (live) return this.refuse(live);
                return this.event(entry, body);
            }
            case "dream.child.tool": {
                const live = this.live(entry);
                if (live) return this.refuse(live);
                return this.tool(entry, body);
            }
            default:
                return this.refuse("unknown_method");
        }
    }

    private event(entry: PeerEntry, body: Record<string, unknown>): unknown {
        const seq = body.seq;
        if (typeof seq !== "number") return this.refuse("invalid_seq");
        const payload = JSON.stringify(body.event);
        const previous = entry.events.get(seq);
        if (previous) {
            return previous.payload === payload
                ? previous.response
                : this.refuse("sequence_conflict");
        }
        if (!entry.start || entry.hostChild === null || entry.completion)
            return this.refuse("not_running");
        if (seq !== entry.nextSeq) return this.refuse("out_of_order");
        const event = body.event as Record<string, unknown>;
        let response: Record<string, unknown> = { ok: true };
        switch (event.kind) {
            case "step":
                if (entry.budget?.refuseTool()) return this.refuse("token_budget");
                if (entry.steps >= entry.descriptor.maxSteps) {
                    entry.stop = true;
                    return this.refuse("step_budget");
                }
                entry.steps += 1;
                break;
            case "message": {
                const id = String(event.message_id);
                const known = entry.messages.get(id);
                if (known !== undefined && known !== payload)
                    return this.refuse("message_conflict");
                entry.messages.set(id, payload);
                break;
            }
            case "usage": {
                const id = String(event.message_id);
                const known = entry.meters.get(id);
                if (known) {
                    if (known.payload !== payload) return this.refuse("usage_conflict");
                    response = known.response as Record<string, unknown>;
                    break;
                }
                const usage = event.usage as Record<string, number>;
                const action =
                    entry.budget?.charge(
                        usage.input ?? 0,
                        usage.cache_read ?? 0,
                        usage.cache_write ?? 0,
                        event.completed === true,
                    ) ?? "continue";
                response = { ok: true, budget_action: action };
                entry.meters.set(id, { payload, response });
                break;
            }
            case "receipt":
                if (!entry.calls.has(String(event.call_id))) return this.refuse("unknown_receipt");
                break;
            case "complete":
                entry.completion = {
                    text: String(event.text),
                    length_capped: event.length_capped === true,
                };
                // The runner validates the result and closes the child.
                if (this.autoClose) entry.stop = true;
                break;
            default:
                return this.refuse("invalid_event_kind");
        }
        entry.events.set(seq, { payload, response });
        entry.nextSeq += 1;
        return response;
    }

    private tool(entry: PeerEntry, body: Record<string, unknown>): unknown {
        if (!entry.start || entry.completion) return this.refuse("not_running");
        const callId = String(body.call_id);
        const tool = String(body.tool);
        const input = JSON.stringify({ tool, arguments: body.arguments });
        const previous = entry.calls.get(callId);
        if (previous)
            return previous.input === input ? previous.response : this.refuse("call_conflict");
        if (!entry.descriptor.allowedTools.includes(tool)) return this.refuse("tool_not_admitted");
        if (entry.budget?.refuseTool()) return this.refuse("token_budget");
        const child = entry.hostChild ?? "";
        this.effects.push({ child, tool, args: body.arguments });
        const result = this.options.router?.(child, tool, body.arguments) ?? {
            output: { effect: "applied" },
            receipt: { tool, affected_ids: ["memory-1"], details: { committed: true } },
        };
        const response = { ok: true, output: result.output, receipt: result.receipt };
        entry.calls.set(callId, { input, response });
        return response;
    }
}
