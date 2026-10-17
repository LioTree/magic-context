import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    admitDreamChildStep,
    type DreamChildCapabilities,
    DreamChildClaimant,
    type DreamChildCredential,
    type DreamChildEvent,
    type DreamChildHost,
    type DreamChildRun,
    type DreamChildTranscriptMessage,
    decodeDreamClaim,
    decodeDreamControl,
    decodeDreamEventAck,
    decodeDreamPending,
    decodeDreamToolResult,
    dreamChildGate,
    dreamClaimWire,
    dreamRefusalOf,
} from "../../dream-child-claimant";

/**
 * Replays the frozen `dream-claim-v1` vectors through the TypeScript claimant.
 *
 * The vectors are generated from the real Rust routes by
 * `dream_claim::tests::vectors::dream_claim_v1_frozen_vectors`. Every request in
 * them is rebuilt here by the claimant's own wire encoder from the values the
 * request carries, and compared byte for byte in canonical (sorted-key) JSON;
 * every response is read by the claimant's own decoder. A drift on either side
 * of the wire turns this red.
 */

interface VectorCase {
    name: string;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
    setup?: Record<string, unknown>;
}

const vectors = JSON.parse(
    readFileSync(join(import.meta.dir, "vectors", "dream-claim-v1.json"), "utf8"),
) as { schema: string; cases: VectorCase[] };

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function credentialOf(request: Record<string, unknown>): DreamChildCredential {
    return {
        entry_id: String(request.entry_id),
        token: String(request.token),
        child_id: String(request.child_id),
        claimant_epoch: String(request.claimant_epoch),
    };
}

/** The claimant's own encoding of the request a vector case records. */
function encode(vector: VectorCase): Record<string, unknown> {
    const r = vector.request;
    const method = String(r.method);
    let body: Record<string, unknown>;
    switch (method) {
        case "dream.child.pending":
            body = dreamClaimWire.pending();
            // The one case that is not a v1 claimant's request: it pins the
            // refusal of a version this claimant never sends.
            if (vector.name === "version_refusal") body = { ...body, v: r.v };
            break;
        case "dream.child.claim":
            body = dreamClaimWire.claim(
                String(r.entry_id),
                String(r.claimant_epoch),
                r.capabilities as DreamChildCapabilities,
            );
            break;
        case "dream.child.opened":
            body = dreamClaimWire.opened(credentialOf(r), String(r.host_child_id));
            break;
        case "dream.child.heartbeat":
            body = dreamClaimWire.heartbeat(credentialOf(r));
            break;
        case "dream.child.event":
            body = dreamClaimWire.event(credentialOf(r), Number(r.seq), r.event as DreamChildEvent);
            break;
        case "dream.child.tool":
            body = dreamClaimWire.tool(
                credentialOf(r),
                String(r.call_id),
                String(r.tool),
                r.arguments,
            );
            break;
        case "dream.child.cleanup":
            body = dreamClaimWire.cleanup(credentialOf(r), {
                quiescent: r.quiescent === true,
                retired: r.retired === true,
            });
            break;
        case "dream.child.unavailable":
            body = dreamClaimWire.unavailable(credentialOf(r));
            break;
        default:
            throw new Error(`vector method ${method} has no claimant encoding`);
    }
    return { ...body, method };
}

describe("dream-claim-v1 frozen vectors through the TypeScript claimant", () => {
    it("carries the frozen schema and all 31 recorded cases", () => {
        expect(vectors.schema).toBe("dream-claim-v1");
        expect(vectors.cases).toHaveLength(31);
    });

    for (const vector of vectors.cases) {
        it(`${vector.name}: the claimant encodes the recorded request byte for byte`, () => {
            expect(canonical(encode(vector))).toBe(canonical(vector.request));
        });

        it(`${vector.name}: the claimant reads the recorded response`, () => {
            const response = vector.response;
            const method = String(vector.request.method);
            if (typeof response.error === "string") {
                // Admission failures are error frames, not refusal bodies; the
                // claimant's transport surfaces them as thrown errors.
                expect(response.ok).toBeUndefined();
                return;
            }
            const refusal = dreamRefusalOf(response);
            if (response.ok === false) {
                expect(refusal).toBe(String(response.refusal));
                expect(decodeDreamClaim(response)).toBeNull();
                expect(decodeDreamControl(response)).toBeNull();
                return;
            }
            expect(refusal).toBeNull();
            switch (method) {
                case "dream.child.pending":
                    expect(decodeDreamPending(response)).toEqual(
                        (response.entries as Array<{ entry_id: string; deadline_ms: number }>).map(
                            (entry) => ({ entryId: entry.entry_id, deadlineMs: entry.deadline_ms }),
                        ),
                    );
                    break;
                case "dream.child.claim": {
                    const claim = decodeDreamClaim(response);
                    const d = response.descriptor as Record<string, unknown>;
                    expect(claim).not.toBeNull();
                    expect(claim?.credentialWithoutEpoch).toEqual({
                        entry_id: String(response.entry_id),
                        token: String(response.token),
                        child_id: String(d.child_id),
                    });
                    expect(claim?.descriptor).toMatchObject({
                        agent: d.agent,
                        allowedTools: d.allowed_tools,
                        maxSteps: d.max_steps,
                        // Model id and qualifier are carried unchanged, slashes and all.
                        model: d.model,
                        system: d.system,
                        prompt: d.prompt,
                        deadlineMs: d.deadline_ms,
                        tokenBudget: d.token_budget,
                        directory: d.directory,
                        parentSessionId: d.parent_session_id,
                    });
                    const control = response.control as Record<string, unknown>;
                    expect(claim?.control).toEqual({
                        start: control.start,
                        stop: control.stop,
                        retire: control.retire,
                        claimDeadlineMs: control.claim_deadline_ms,
                        heartbeatIntervalMs: control.heartbeat_interval_ms,
                    });
                    break;
                }
                case "dream.child.opened":
                case "dream.child.heartbeat":
                    expect(decodeDreamControl(response)).toEqual({
                        start: response.start,
                        stop: response.stop,
                        retire: response.retire,
                        claimDeadlineMs: response.claim_deadline_ms,
                        heartbeatIntervalMs: response.heartbeat_interval_ms,
                    });
                    break;
                case "dream.child.event":
                    expect(decodeDreamEventAck(response)).toEqual({
                        ok: true,
                        budgetAction: (response.budget_action as "stop" | undefined) ?? null,
                    });
                    break;
                case "dream.child.tool":
                    expect(decodeDreamToolResult(response)).toEqual({
                        ok: true,
                        output: response.output,
                        receipt: response.receipt !== null,
                    });
                    break;
                case "dream.child.cleanup":
                case "dream.child.unavailable":
                    expect(response).toEqual({ ok: true });
                    break;
                default:
                    throw new Error(`unread method ${method}`);
            }
        });
    }
});

/** A child that runs one scripted model step: one task tool call with model-supplied arguments. */
class VectorRun implements DreamChildRun {
    readonly hostChildId: string;
    constructor(
        hostChildId: string,
        private readonly args: unknown,
    ) {
        this.hostChildId = hostChildId;
    }
    async prompt(): Promise<void> {
        await admitDreamChildStep(this.hostChildId);
        await dreamChildGate(this.hostChildId)?.runTaskTool("ctx_memory", this.args);
    }
    async transcript(): Promise<DreamChildTranscriptMessage[]> {
        return [];
    }
    async abort(): Promise<boolean> {
        return true;
    }
    async retire(): Promise<boolean> {
        return true;
    }
}

describe("dream-claim-v1 lifecycle replay through the running claimant", () => {
    const byName = new Map(vectors.cases.map((vector) => [vector.name, vector]));
    const vector = (name: string): VectorCase => {
        const found = byName.get(name);
        if (!found) throw new Error(`missing vector ${name}`);
        return found;
    };

    it("sends the recorded claim, tool, stop and cleanup requests when driven by the recorded answers", async () => {
        const claim = vector("selected_attempt_claim");
        const forged = vector("forged_arguments_are_not_authority");
        const stopAck = vector("stop_ack");
        const cleanupAck = vector("cleanup_ack");
        const sent: Array<Record<string, unknown>> = [];
        const capabilities = claim.request.capabilities as DreamChildCapabilities;
        const host: DreamChildHost = {
            capabilities,
            refusal: () => undefined,
            create: async () =>
                new VectorRun("host-child-1", (forged.request.arguments as unknown) ?? {}),
        };
        const control = (stop: boolean) => ({
            ok: true,
            start: !stop,
            stop,
            retire: stop,
            claim_deadline_ms: 70_000,
            heartbeat_interval_ms: 5_000,
        });
        let stopped = false;
        const claimant = new DreamChildClaimant({
            claimantEpoch: String(claim.request.claimant_epoch),
            // The fixture clock the vectors were recorded at.
            now: () => 60_000,
            fastPollMs: 1,
            host,
            call: async ({ method, body }) => {
                const request = { ...body, method };
                sent.push(request);
                switch (method) {
                    case "dream.child.pending":
                        return {
                            ok: true,
                            entries: [{ entry_id: "<entry-1>", deadline_ms: 70_000 }],
                        };
                    case "dream.child.claim":
                        return claim.response;
                    case "dream.child.opened":
                        return control(false);
                    case "dream.child.event":
                        return { ok: true };
                    case "dream.child.tool":
                        // The module stops the entry after the recorded effect.
                        stopped = true;
                        return forged.response;
                    case "dream.child.heartbeat":
                        return stopped ? stopAck.response : control(false);
                    case "dream.child.cleanup":
                        return cleanupAck.response;
                    default:
                        return { ok: false, refusal: "unexpected" };
                }
            },
        });
        await claimant.pump("parent");
        await claimant.settled();

        const first = (method: string) => sent.find((request) => request.method === method);
        expect(canonical(first("dream.child.claim"))).toBe(canonical(claim.request));
        // The call id is the claimant's own choice; everything else, including the
        // forged model arguments forwarded as data, matches the recorded request.
        expect(canonical({ ...first("dream.child.tool"), call_id: forged.request.call_id })).toBe(
            canonical(forged.request),
        );
        expect(canonical(sent.filter((r) => r.method === "dream.child.heartbeat").at(-1))).toBe(
            canonical(stopAck.request),
        );
        expect(canonical(sent.at(-1))).toBe(canonical(cleanupAck.request));
    });

    it("sends the recorded late-child report and cleanup after an open was cancelled", async () => {
        const opened = vector("cancel_during_open_late_child");
        const retired = vector("late_child_retired");
        const sent: Array<Record<string, unknown>> = [];
        const host: DreamChildHost = {
            capabilities: vector("selected_attempt_claim").request
                .capabilities as DreamChildCapabilities,
            refusal: () => undefined,
            create: async () => new VectorRun(String(opened.request.host_child_id), {}),
        };
        const claimant = new DreamChildClaimant({
            claimantEpoch: String(opened.request.claimant_epoch),
            now: () => 60_000,
            fastPollMs: 1,
            host,
            call: async ({ method, body }) => {
                sent.push({ ...body, method });
                switch (method) {
                    case "dream.child.pending":
                        return {
                            ok: true,
                            entries: [{ entry_id: "<entry-2>", deadline_ms: 70_000 }],
                        };
                    case "dream.child.claim": {
                        const granted = structuredClone(
                            vector("fresh_attempt_after_cleanup").response,
                        ) as Record<string, unknown>;
                        granted.entry_id = "<entry-2>";
                        granted.token = "<token-2>";
                        (granted.descriptor as Record<string, unknown>).child_id = "<child-2>";
                        return granted;
                    }
                    case "dream.child.heartbeat":
                        return {
                            ok: true,
                            start: false,
                            stop: false,
                            retire: false,
                            claim_deadline_ms: 70_000,
                            heartbeat_interval_ms: 5_000,
                        };
                    case "dream.child.opened":
                        return opened.response;
                    case "dream.child.cleanup":
                        return retired.response;
                    default:
                        return { ok: false, refusal: "unexpected" };
                }
            },
        });
        await claimant.pump("parent");
        await claimant.settled();
        expect(canonical(sent.find((r) => r.method === "dream.child.opened"))).toBe(
            canonical(opened.request),
        );
        expect(canonical(sent.at(-1))).toBe(canonical(retired.request));
        expect(sent.some((r) => r.method === "dream.child.event")).toBe(false);
    });

    it("declines the token capability exactly as recorded and receives no descriptor", async () => {
        const unavailable = vector("capability_unavailable");
        const sent: Array<Record<string, unknown>> = [];
        let created = 0;
        const claimant = new DreamChildClaimant({
            claimantEpoch: String(unavailable.request.claimant_epoch),
            now: () => 60_000,
            host: {
                capabilities: unavailable.request.capabilities as DreamChildCapabilities,
                refusal: () => undefined,
                create: async () => {
                    created += 1;
                    return new VectorRun("never", {});
                },
            },
            call: async ({ method, body }) => {
                sent.push({ ...body, method });
                return method === "dream.child.pending"
                    ? { ok: true, entries: [{ entry_id: "<entry-4>", deadline_ms: 70_000 }] }
                    : unavailable.response;
            },
        });
        await claimant.pump("parent");
        await claimant.settled();
        expect(canonical(sent.at(-1))).toBe(canonical(unavailable.request));
        expect(created).toBe(0);
    });
});
