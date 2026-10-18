import assert from "node:assert/strict";
import type { MessageLike } from "../../transform-operations";
import {
    type BridgeReceipt,
    type BridgeRequestCompletion,
    bridgeReceipt,
    completeBridgeReceipt,
} from "../bridge-receipt";
import { providerIncoming, providerOpFunctions, providerSubjects } from "../opencode-adapter";
import {
    type FrozenProviderPlan,
    freezeProviderPlan,
    ProviderClient,
    type ProviderMethod,
} from "../provider-client";
import {
    acknowledgeStatus,
    acknowledgeUnserved,
    admit,
    applyCompaction,
    assemble,
    commitEntries,
    commitNonViewAnswer,
    commitScan,
    createRecord,
    finishEntry,
    type HookOutcome,
    hydrateEntry,
    issueRequest,
    type RunnerRecord,
    type Subject,
    scanWindow,
} from "../record";
import type { Action, Exchange, Snapshot, VectorCase, VectorFile, VectorStep } from "./format";

export type Oracle = (request: unknown) => Promise<string>;
type RecordState = RunnerRecord<MessageLike, FrozenProviderPlan>;
const params = { serializer_profile: "opencode-aisdk", observation: "answer" };

/** A fake relay drives the production adapter's projection, client and record transitions. */
class Relay {
    record!: RecordState;
    receipt!: BridgeReceipt;
    private carrying = 0;
    private clock = 1_000;
    private serial = 0;
    private aliases = new Map<string, string>();
    private trace: Exchange[] = [];
    private fault?: Extract<Action, { kind: "serve" }>["fault"];
    private client: ProviderClient;

    constructor(private oracle: Oracle) {
        this.client = this.makeClient();
    }

    private makeClient(): ProviderClient {
        return new ProviderClient({
            sessionId: "relay-v1",
            projectRoot: "/relay-conformance/project",
            harness: "opencode",
            newRequestId: () => `relay-${String(++this.serial).padStart(4, "0")}`,
            now: () => this.clock,
            persistFence: async () => {},
            moduleClient: {
                call: async (input) => {
                    const method = input.method as ProviderMethod;
                    assert(input.body instanceof Uint8Array);
                    const bytes = new TextDecoder().decode(input.body);
                    const request = JSON.parse(bytes);
                    const answer = await this.oracle(request);
                    const fault = this.fault;
                    const delivery =
                        method === "transform.hook" && fault && request.params.hook === fault.hook
                            ? fault.mode
                            : "answer";
                    this.trace.push({
                        method,
                        request_bytes: bytes,
                        answer_bytes: answer,
                        delivery,
                    });
                    if (delivery === "transport")
                        throw new Error("injected relay transport failure");
                    if (delivery === "timeout") this.clock += input.timeoutMs ?? 2_000;
                    return JSON.parse(answer);
                },
            },
        });
    }

    private async bootstrap() {
        const declared = await this.client.declare({ preset: "head", params });
        assert.equal(declared.status, "answered");
        if (declared.status !== "answered") throw new Error("declaration unavailable");
        const plan = freezeProviderPlan(declared.answer, { preset: "head", params });
        this.record = createRecord({
            lineage_id: "relay-lineage-v1",
            plan,
            initial: {
                compaction_id: "uninitialized",
                version: 0,
                range: { from: 0, to: 0 },
                replacement: [],
            },
        });
        const setup = await this.client.setup(this.record, {
            model: "fixture",
            context_window: 100_000,
            composition: {},
        });
        assert(setup.status === "answered" && setup.answer.answer === "ready");
        this.record.view = {
            ...setup.answer.initial,
            replacement: setup.answer.initial.replacement as MessageLike[],
            state: "applied",
        };
        // Establish the initial model baseline so later status ingest cannot trigger an initial rebuild.
        await this.status("accept", true);
    }

    private async serve(messages: MessageLike[]) {
        const served = this.record.served_through_ordinal;
        const scan = scanWindow(this.record, messages.map(providerIncoming));
        assert.equal(scan.exit, undefined);
        commitScan(this.record, scan);
        for (const candidate of scan.appends) {
            const admitted = admit(this.record, candidate, {
                session: "relay-v1",
                harness: "opencode",
                model: "fixture",
                now: this.clock,
                request_id: "relay-reserved-id",
            });
            assert(!("exit" in admitted));
            const subjects = providerSubjects(admitted.message).filter((subject) =>
                this.record.plan.subscriptions.some((sub) => sub.hook === subject.hook),
            );
            const outcomes: HookOutcome[] = [];
            for (const subject of subjects) {
                const result = await this.client.hook(
                    this.record,
                    { ...subject, subject_ordinal: candidate.ordinal },
                    admitted.ingest,
                );
                outcomes.push(
                    result.status === "answered" &&
                        (result.answer.answer === "ops" || result.answer.answer === "pass")
                        ? {
                              subject,
                              answer: {
                                  subject,
                                  ops: result.answer.answer === "ops" ? result.answer.ops : [],
                                  tags: Array.isArray(result.answer.tags) ? result.answer.tags : [],
                              },
                          }
                        : { subject, unavailable: true },
                );
            }
            commitEntries(this.record, [
                finishEntry(candidate, admitted, outcomes, providerOpFunctions),
            ]);
            this.record.served_through_ordinal = served;
        }
    }

    private publishReceipt() {
        this.receipt = bridgeReceipt(this.record, `carrying-${++this.carrying}`);
    }

    private complete(response: BridgeRequestCompletion) {
        this.receipt = completeBridgeReceipt(this.receipt, this.record.next_ordinal - 1, response);
        this.record.served_through_ordinal = this.receipt.served_through_ordinal;
    }

    private async status(
        admission: Extract<Action, { kind: "status" }>["admission"],
        rebuild?: true,
    ) {
        const newest = this.record.entries.at(-1);
        const result = await this.client.step(this.record, {
            step_id: `status-${this.serial}`,
            step_kind: "user_turn",
            model: "fixture",
            context_window: 100_000,
            estimate: { request_tokens: 1_000 },
            ...(rebuild ? { prefix_rebuilding: { reason: "pipeline_switch" } } : {}),
            ...(newest ? { newest: { mid: newest.id, ordinal: newest.ordinal } } : {}),
        });
        assert.equal(result.status, "answered");
        if (result.status !== "answered") throw new Error("status unavailable");
        const answer = result.answer;
        let accepted = false;
        if (answer.answer === "compaction_message") {
            assert(this.record.issued);
            if (admission === "superseded")
                issueRequest(this.record, "superseding-request", this.clock + 2_000);
            const applied = applyCompaction(
                this.record,
                {
                    request_id: result.request_id,
                    arrived_ms:
                        admission === "late" ? this.record.issued.deadline_ms : result.arrived_ms,
                    compaction: {
                        ...answer.compaction,
                        replacement: answer.compaction.replacement as MessageLike[],
                    },
                    coverage: answer.coverage,
                },
                () => admission !== "structural",
            );
            accepted = applied.applied;
        } else if (answer.answer === "noop") {
            accepted = !commitNonViewAnswer(
                this.record,
                result.request_id,
                result.arrived_ms,
                "noop",
            );
        } else {
            throw new Error(`unexpected MC status answer: ${answer.answer}`);
        }
        if (accepted && result.page) {
            acknowledgeStatus(this.record, new Set(result.page.messages.map((entry) => entry.id)));
            acknowledgeUnserved(
                this.record,
                (result.page.control.unserved_subjects ?? []) as Subject[],
            );
        }
    }

    private restartRelay() {
        this.receipt = JSON.parse(JSON.stringify(this.receipt));
        const record = this.record;
        // Serialization deliberately discards served objects, as the durable store does.
        const saved = JSON.parse(JSON.stringify({ ...record, entries: [] })) as RecordState;
        this.record = {
            ...saved,
            ids: new Map(record.ids),
            source_digests: new Map(record.source_digests),
            elided: new Set(record.elided),
            hole_ids: new Set(record.hole_ids),
            entries: record.entries.map(
                ({ served: _, ...entry }) =>
                    hydrateEntry(JSON.parse(JSON.stringify(entry)), {
                        current: 2,
                        versions: new Map([
                            ...providerOpFunctions.versions,
                            [
                                2,
                                () => {
                                    throw new Error("restart must reuse the recorded op version");
                                },
                            ],
                        ]),
                    }).entry,
            ),
        };
        this.client = this.makeClient();
    }

    async step(action: Action): Promise<VectorStep> {
        this.trace = [];
        switch (action.kind) {
            case "delete":
            case "step_deleted": {
                const method = action.kind === "delete" ? "compaction.delete" : "compaction.step";
                const request = {
                    method,
                    params: {
                        session: "relay-v1",
                        harness: "opencode",
                        ...(action.kind === "step_deleted"
                            ? {
                                  request_id: "deleted-step",
                                  lineage_id: this.record.lineage_id,
                                  step_id: "deleted-step",
                                  step_kind: "user_turn",
                                  model: "fixture",
                                  context_window: 100_000,
                                  estimate: { request_tokens: 1 },
                                  messages: [],
                                  now: this.clock,
                              }
                            : {}),
                    },
                };
                const request_bytes = JSON.stringify(request);
                const answer_bytes = await this.oracle(JSON.parse(request_bytes));
                this.trace.push({ method, request_bytes, answer_bytes, delivery: "answer" });
                const answer = JSON.parse(answer_bytes);
                if (action.kind === "delete") assert.deepEqual(answer, { answer: "deleted" });
                else assert.equal(answer.oracle_error?.code, "provider_conversation_missing");
                break;
            }
            case "bootstrap":
                await this.bootstrap();
                this.publishReceipt();
                break;
            case "serve":
                this.fault = action.fault;
                await this.serve(action.messages);
                this.fault = undefined;
                this.publishReceipt();
                if (!action.defer_delivery) this.complete({ status: 200, cleanEnd: true });
                break;
            case "status":
                await this.status(action.admission, action.rebuild);
                this.publishReceipt();
                break;
            case "restart":
                if (action.target === "relay") this.restartRelay();
                else await this.oracle({ control: "restart" });
                break;
            case "publish":
                await this.oracle({ control: "publish", ...action });
                break;
            case "delivery":
                this.complete(action);
                break;
            case "retry": {
                const entry = this.record.entries.find((entry) => entry.id === action.mid);
                assert(entry);
                const { served, ...persisted } = entry;
                const retried = hydrateEntry(persisted, providerOpFunctions).entry;
                assert.equal(JSON.stringify(retried.served), JSON.stringify(served));
                assert.equal(retried.op_version, entry.op_version);
                assert.deepEqual(retried.hook.answers, entry.hook.answers);
                break;
            }
            case "alias": {
                assert(this.record.ids.has(action.from));
                assert(!this.record.ids.has(action.to));
                this.aliases.set(action.to, action.from);
                break;
            }
            case "pi":
                await this.serve(
                    action.entries.map(
                        (entry) =>
                            ({
                                info: {
                                    id: this.aliases.get(entry.id) ?? entry.id,
                                    role: entry.message.role,
                                    time: { created: entry.message.timestamp },
                                },
                                parts: entry.message.content.map((part, index) => ({
                                    ...part,
                                    id: `${this.aliases.get(entry.id) ?? entry.id}-part-${index}`,
                                })),
                            }) as MessageLike,
                    ),
                );
                this.publishReceipt();
                this.complete({ status: 200, cleanEnd: true });
                break;
        }
        return { action, exchanges: this.trace, expected: this.snapshot() };
    }

    private snapshot(): Snapshot {
        const record = this.record;
        return JSON.parse(
            JSON.stringify({
                receipt: this.receipt,
                served_bytes: JSON.stringify(assemble(record)),
                lineage_id: record.lineage_id,
                served_through_ordinal: record.served_through_ordinal,
                after_ordinal: record.after_ordinal,
                unserved_subjects: record.unserved_subjects.map(
                    ({ subject_mid, hook, subject_part }) => ({
                        subject_mid,
                        hook,
                        ...(subject_part ? { subject_part } : {}),
                    }),
                ),
                last_applied: {
                    compaction_id: record.view.compaction_id,
                    version: record.view.version,
                },
                last_not_applied: record.last_not_applied ?? null,
                coverage: record.view.coverage ?? null,
                entries: record.entries.map((entry) => ({
                    mid: entry.id,
                    ordinal: entry.ordinal,
                    ingest_bytes: entry.ingest,
                    served_bytes: JSON.stringify(entry.served),
                    op_version: entry.op_version,
                    answers_bytes: JSON.stringify(entry.hook.answers),
                })),
                aliases: [...this.aliases],
            }),
        ) as Snapshot;
    }
}

export async function generateCase(
    id: string,
    actions: Action[],
    oracle: Oracle,
): Promise<VectorCase> {
    await oracle({ control: "reset" });
    const relay = new Relay(oracle);
    const steps = [];
    for (const action of actions) steps.push(await relay.step(action));
    return { id, steps };
}

/** Only recorded wire answers drive replay; expected served bytes/receipts are comparison outputs. */
export async function replayCase(vector: VectorCase): Promise<void> {
    let pending: Exchange[] = [];
    const relay = new Relay(async (request) => {
        const wire = request as { control?: string; method: ProviderMethod; params: unknown };
        if (wire.control) return "";
        const expected = pending.shift();
        assert(expected, `${vector.id}: unexpected ${wire.method}`);
        assert.equal(wire.method, expected.method);
        assert.deepEqual(wire.params, JSON.parse(expected.request_bytes).params);
        return expected.answer_bytes;
    });
    for (const [index, step] of vector.steps.entries()) {
        pending = [...step.exchanges];
        const actual = await relay.step(step.action);
        assert.equal(pending.length, 0, `${vector.id} step ${index}: missing provider calls`);
        assert.deepEqual(actual, step, `${vector.id} step ${index}: relay conformance`);
    }
}

export async function replayVectors(vectors: VectorFile): Promise<void> {
    assert.equal(vectors.schema, "mc-relay/v1");
    for (const vector of vectors.cases) await replayCase(vector);
}
