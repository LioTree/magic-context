import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { drainSingleStoreEmbeddingWatermarks } from "../../../features/magic-context/memory/single-store-embedding-drain";
import {
    currentProviderMeters,
    meterProviderCall,
    meterProviderStage,
    type ProviderPassMeters,
    withoutProviderMeters,
    withProviderMeters,
} from "../../../features/magic-context/provider-meters";
import { computeHardCacheExpired } from "../../../features/magic-context/scheduler";
import {
    commitHostRunnerAnswer,
    commitHostRunnerExit,
    commitHostRunnerFence,
    commitHostRunnerPass,
    createHostRunnerState,
    type HostRunnerKey,
    type HostRunnerPass,
    type HostRunnerState,
    type HostRunnerView,
    loadHostRunnerRecord,
} from "../../../features/magic-context/storage-host-runner";
import { getOrCreateSessionMeta } from "../../../features/magic-context/storage-meta";
import type { SessionMeta } from "../../../features/magic-context/types";
import { sessionLog } from "../../../shared/logger";
import { EmergencyFailClosedError } from "../emergency-fail-closed";
import { createHistorianHostRunner } from "../historian-host-runner";
import {
    type ModuleStateSyncState,
    readAuthoritySeqMismatch,
    syncModuleState,
} from "../module-state-sync";
import { resolveOrdinalsForModule } from "../module-wire";
import { providerNativeMessage } from "../provider-visible-parts";
import { hasRawSessionMessageById } from "../read-session-chunk";
import { isRawCompactionSummaryInfo } from "../read-session-raw";
import type { createRustModeTransform, HistorianHostRunnerSeam } from "../rust-mode-transform";
import { storeAheadOfBinaryFailure } from "../store-ahead-refusal";
import type { TransformDeps } from "../transform";
import type { MessageLike } from "../transform-operations";
import { bridgeReceipt } from "./bridge-receipt";
import type { BridgeStep } from "./bridge-step";
import type { BridgeStepKind } from "./bridge-types";
import {
    type FallbackAdmissibility,
    type FallbackInputs,
    isFallbackAdmissible,
    type ProviderUsageInput,
    recordProviderUsage,
} from "./fallback-admissibility";
import { openCodeStepInputs } from "./opencode-step-inputs";
import {
    type FrozenProviderPlan,
    freezeProviderPlan,
    type HostHookSubject,
    type PageResult,
    type ProviderAnswers,
    ProviderClient,
    type ProviderResult,
    type StepInputs,
} from "./provider-client";
import type { ProviderCodec } from "./provider-codec";
import {
    type Admission,
    acknowledgeStatus,
    acknowledgeUnserved,
    admit,
    applyCompaction,
    assemble,
    commitEntries,
    commitExit,
    commitHistoryGap,
    commitNonViewAnswer,
    commitScan,
    createRecord,
    descendModuleAhead,
    type ExitReason,
    finishEntry,
    type HookAnswer,
    type HookOutcome,
    hydrateEntry,
    type Incoming,
    type OpFunctions,
    type RunnerRecord,
    type Subject,
    scanWindow,
    sourceDigest,
} from "./record";

export type {
    FallbackAdmissibility,
    FallbackInputs,
    ProviderUsageInput,
} from "./fallback-admissibility";
export { isFallbackAdmissible, recordProviderUsage } from "./fallback-admissibility";

type Legacy = ReturnType<typeof createRustModeTransform>;
type RecordState = RunnerRecord<MessageLike, FrozenProviderPlan>;
type Admitted = Extract<Admission<MessageLike>, { entry: unknown }>;
class StepOrdinalConflict extends Error {}
type Part = Record<string, unknown>;
function part(value: unknown): Part {
    return value as Part;
}
function mid(message: MessageLike): string | undefined {
    return message.info.id;
}
/** The v2 projection has a call ID, not a v1 store part ID. The part position
 * disambiguates repeated call IDs within a terminal message and survives JSON. */
export function providerSubjectPart(tool: Part, index: number): string {
    if (typeof tool.id === "string" && tool.id) return tool.id;
    if (typeof tool.callID !== "string" || !tool.callID)
        throw new Error("Terminal tool has no stable identity");
    const identity = `v2:${index}:${tool.callID}`;
    return Buffer.byteLength(identity, "utf8") <= 256
        ? identity
        : `v2:${index}:${createHash("sha256").update(tool.callID).digest("hex")}`;
}
function toolTextField(state: Part): "error" | "output" {
    return state.status === "error" && typeof state.error === "string" ? "error" : "output";
}
const publishedSources = new WeakMap<MessageLike, MessageLike>();
const hostReplay = new WeakMap<MessageLike, () => unknown>();
/** Defer copying v2 tool-result and host metadata until rust_pipeline's provider
 * mode records a new message; the legacy full-request path never reads it. */
export function rememberOpenCodeHostReplay(message: MessageLike, read: () => unknown): void {
    hostReplay.set(message, read);
}
/** Let v2 reuse its rendered content for the unchanged recorded message, even
 * though each publication gives the host a new, independently mutable copy. */
export function providerMessageSource(message: MessageLike): MessageLike {
    return publishedSources.get(message) ?? message;
}
// Publication copies the whole served window on every pass, so this walks each
// value once without the intermediate arrays of entries/filter/fromEntries. It
// copies the same own enumerable string keys in the same order.
function copyPublishedData<T>(value: T): T {
    if (Array.isArray(value)) {
        const copy = new Array(value.length);
        for (let index = 0; index < value.length; index++) {
            if (index in value) copy[index] = copyPublishedData(value[index]);
        }
        return copy as T;
    }
    if (value && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const copy: Record<string, unknown> = {};
        for (const key of Object.keys(source)) {
            const entry = source[key];
            // Protocol messages are JSON data. An in-process transport's serializer
            // method is not message data; copying must neither invoke nor publish it.
            if (key === "toJSON" && typeof entry === "function") continue;
            if (key === "__proto__") {
                // An own `__proto__` key (JSON.parse can produce one) must stay a
                // data property, as Object.fromEntries kept it, not set the prototype.
                Object.defineProperty(copy, key, {
                    value: copyPublishedData(entry),
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            } else copy[key] = copyPublishedData(entry);
        }
        return copy as T;
    }
    return value;
}
export function publishMessages(
    output: { messages: unknown[] },
    managed: readonly MessageLike[],
): void {
    // OpenCode may edit any object it receives. Copy only the live served window,
    // never the retained history, and keep the host's array identity intact.
    const published = managed.map((message) => {
        const copy = copyPublishedData(message);
        publishedSources.set(copy, message);
        return copy;
    });
    output.messages.splice(0, output.messages.length, ...published);
}
export interface OpenCodeProviderProjection {
    /** Owns the front projection's pointer cache, never a legacy LKG slot. */
    owner: object;
    ids: ReadonlyMap<string, number>;
}
const providerProjections = new Map<
    string,
    { owner: object; read: () => OpenCodeProviderProjection | undefined }
>();
/** Only explicitly selected, active v2 provider sessions participate. */
export function getOpenCodeProviderProjection(
    sessionId: string,
): OpenCodeProviderProjection | undefined {
    return providerProjections.get(sessionId)?.read();
}

/** Magic Context's own head messages never enter the provider ordinal space. */
export function isMagicContextHead(message: MessageLike): boolean {
    return (
        !mid(message) &&
        message.parts.length > 0 &&
        message.parts.every((p) => part(p).synthetic === true)
    );
}
export function providerIncoming(message: MessageLike): Incoming<MessageLike> {
    return {
        id: mid(message),
        classify: () => {
            if (
                isRawCompactionSummaryInfo(message.info) ||
                message.parts.some((p) => part(p).type === "compaction")
            )
                return "marker";
            return message.parts.some(
                (p) =>
                    part(p).type === "tool" &&
                    !["completed", "error"].includes(String(part(part(p).state).status)),
            )
                ? "non_terminal"
                : "terminal";
        },
        read: () => {
            // This shared input becomes ck-mc's hook and bootstrap/history JSON.
            // LSP diagnostics are host UI data, not model input. Reuse replay's
            // model projection, plus the answer markers needed to prevent removal
            // of user answers, before the context module stores rows or views.
            const visible = providerNativeMessage(message);
            // Persist the projected identity in ingest as well as the hook. The
            // module can address the same part after a rebuild changes part order.
            let changed = false;
            const parts = visible.parts.map((p, index) => {
                const tool = part(p);
                if (
                    tool.type !== "tool" ||
                    (typeof tool.id === "string" && tool.id) ||
                    !["completed", "error"].includes(String(part(tool.state).status))
                )
                    return p;
                changed = true;
                return { ...tool, id: providerSubjectPart(tool, index) };
            });
            const replay = hostReplay.get(message);
            return replay
                ? { ...visible, info: { ...visible.info, magicContextHostReplay: replay() }, parts }
                : changed
                  ? { ...visible, parts }
                  : visible;
        },
    };
}
export function providerSubjects(message: MessageLike): (HostHookSubject & Subject)[] {
    const id = mid(message);
    if (!id) return [];
    const blocks = message.parts
        .filter((p) => part(p).type === "text" && typeof part(p).text === "string")
        .map((p) => String(part(p).text));
    if (message.info.role === "user") return [{ hook: "pre_user", subject_mid: id, blocks }];
    if (message.info.role !== "assistant") return [];
    const result: (HostHookSubject & Subject)[] = [
        { hook: "post_assistant", subject_mid: id, step_id: id, blocks },
    ];
    for (const [index, p] of message.parts.entries()) {
        const tool = part(p);
        if (tool.type !== "tool") continue;
        const state = part(tool.state);
        if (state.status !== "completed" && state.status !== "error") continue;
        result.push({
            hook: "post_tool",
            subject_mid: id,
            subject_part: providerSubjectPart(tool, index),
            step_id: id,
            tool: String(tool.tool),
            tool_call_id: String(tool.callID ?? tool.id),
            blocks: [String(state[toolTextField(state)] ?? "")],
            is_error: state.status === "error",
        });
    }
    return result;
}

/** Clone only the text targets. Reasoning, signatures, inputs and images are untouched. */
export function applyProviderOps(
    message: MessageLike,
    answers: readonly HookAnswer[],
): MessageLike {
    const parts = [...message.parts];
    for (const answer of answers) {
        const indexes = parts.flatMap((p, i) =>
            answer.subject.hook === "post_tool"
                ? part(p).type === "tool" &&
                  providerSubjectPart(part(p), i) === answer.subject.subject_part
                    ? [i]
                    : []
                : part(p).type === "text" && typeof part(p).text === "string"
                  ? [i]
                  : [],
        );
        for (const value of answer.ops) {
            const op = part(value);
            const index = indexes[Number(op.block)];
            if (index === undefined) throw new Error("Provider op outside text subject");
            const p = part(parts[index]);
            const tool = answer.subject.hook === "post_tool";
            const state = tool ? part(p.state) : p;
            const field = tool ? toolTextField(state) : "text";
            const old = String(state[field] ?? "");
            const next =
                op.op === "prepend"
                    ? String(op.text) + old
                    : op.op === "append"
                      ? old + String(op.text)
                      : op.op === "replace"
                        ? String(op.value)
                        : undefined;
            if (next === undefined) throw new Error("Unknown provider operation");
            parts[index] = tool
                ? { ...p, state: { ...state, [field]: next } }
                : { ...p, [field]: next };
        }
    }
    return { ...message, parts };
}
export const providerOpFunctions: OpFunctions<MessageLike> = {
    current: 1,
    versions: new Map([[1, applyProviderOps]]),
};

/** OpenCode embeds results in assistant rows; Pi returns separate tool-role messages. */
export function providerReplacementValid(
    message: MessageLike,
    harness: "opencode" | "opencode2" | "pi",
    incoming: typeof providerIncoming = providerIncoming,
): boolean {
    const role = message?.info?.role;
    return (
        (role === "user" || role === "assistant" || (harness === "pi" && role === "tool")) &&
        Array.isArray(message?.parts) &&
        incoming(message).classify() !== "non_terminal"
    );
}

/** Same strict TTL clock and self-consuming baseline as the full-request renderer. */
export function providerCold(
    meta: Pick<SessionMeta, "cacheTtl" | "lastResponseTime" | "cachedM0MaterializedAt">,
    now: number,
    materializedAt = meta.cachedM0MaterializedAt ?? 0,
): boolean {
    return (
        computeHardCacheExpired(meta.cacheTtl, meta.lastResponseTime, now) &&
        meta.lastResponseTime > materializedAt
    );
}
interface Metadata {
    first: number;
    setup?: ProviderAnswers["compaction.setup"];
    active: boolean;
    initial: RecordState["view"];
    model: string;
    manifest: string;
    materializedAt: number;
    flush: string;
    newestMid?: string;
    gap?: number;
    retryAt?: number;
    switchGeneration?: number;
    reentry?: boolean;
    fullRequestNamespace?: string;
    sourceDigests?: [string, string][];
    measuredUsage?: RecordState["measured_usage"];
}
interface Session {
    record: RecordState;
    state: HostRunnerState;
    metadata: Metadata;
    sync: ModuleStateSyncState;
    client: ProviderClient;
    pendingDescent?: number;
    syncSignature?: string;
    replaceRecord?: string;
}
export interface OpenCodeProviderOptions {
    /** A bridge acknowledges messages after their request finishes cleanly, not before sending it. */
    deferServed?: boolean;
    servedThrough?: (sessionId: string, lineageId: string) => number;
    emitMeters?: (meters: ProviderPassMeters) => void;
    now?: () => number;
    /** Await newly saved hook ops/unavailability before serving messages; context.db owns their replay. */
    onOutcome?: (messageId: string, subject: Subject, outcome: HookOutcome) => Promise<void>;
    resolveOrdinals?: typeof resolveOrdinalsForModule;
    persisted?: typeof hasRawSessionMessageById;
    sync?: (sessionId: string, state: ModuleStateSyncState, passComplete: boolean) => Promise<void>;
    historian?: HistorianHostRunnerSeam;
    marker?: (sessionId: string, coverage: { end_mid: string; ordinal: number }) => Promise<void>;
    fullRequest?: (
        sessionId: string,
        messages: MessageLike[],
        output: { messages: unknown[] },
        meta: SessionMeta,
        namespace?: string,
        reason?: ExitReason | "bootstrap_declined" | "provider_disabled" | "rollback",
    ) => Promise<void>;
}

// Bootstrap renders the complete retained session, unlike ordinary steps.
// Keep its deadline separate so large-session cutovers can complete without
// increasing the latency allowed for message hooks or ordinary status calls.
// Offline Linux handler measurements: 17k rows took 9.61 s for all four pages,
// with a 5.224 s slowest page. Each page gets over 5x measured headroom.
export const OPENCODE_PROVIDER_BOOTSTRAP_BUDGET_MS = 30_000;

/** All provider state is session-scoped; a failed write never installs staged bytes. */
export function createOpenCodeProviderTransform(
    deps: TransformDeps,
    legacy: Legacy,
    options: OpenCodeProviderOptions = {},
) {
    return createProviderTransform(deps, legacy, options);
}

/** Share request-deadline checks, saved hook answers and database commits across host message formats. */
export function createProviderTransform(
    deps: TransformDeps,
    legacy: Legacy,
    options: OpenCodeProviderOptions = {},
    codec?: ProviderCodec,
) {
    const incoming = codec?.incoming ?? providerIncoming;
    const subjectsFor = codec?.subjects ?? providerSubjects;
    const ops = codec?.ops ?? providerOpFunctions;
    const sessions = new Map<string, Session>();
    const projectionOwner = {};
    const projectionTokens = new Map<string, { generation: number; token: object }>();
    const busy = new Set<string>();
    const now = options.now ?? Date.now;
    const commitProviderEntries: typeof commitEntries = (record, admissions) => {
        const served = record.served_through_ordinal;
        commitEntries(record, admissions);
        if (options.deferServed) record.served_through_ordinal = served;
    };
    const harness = codec?.harness ?? (deps.storeGeneration === "v2" ? "opencode2" : "opencode");
    const projectRoot = deps.rustModeProjectRoot ?? deps.directory ?? process.cwd();
    const configuredModule = deps.rustModeModuleClient;
    if (!configuredModule) throw new Error("Provider pipeline requires a module client");
    const passContext = new AsyncLocalStorage<BridgeStep>();
    const checkpoint = () => passContext.getStore()?.check();
    const stage = <T>(work: Promise<T>): Promise<T> => passContext.getStore()?.wait(work) ?? work;
    const write = (work: () => void): void => {
        const pass = passContext.getStore();
        if (pass) pass.write(work);
        else work();
    };
    const afterCommit = (work: () => void): void => {
        const pass = passContext.getStore();
        if (pass) pass.afterCommit(work);
        else work();
    };
    const moduleClient = new Proxy(configuredModule, {
        get(target, name) {
            if (name === "call")
                return async (args: Parameters<typeof target.call>[0]) => {
                    checkpoint();
                    const pass = passContext.getStore();
                    const result = await meterProviderCall(args.method, () =>
                        stage(
                            target.call({
                                ...args,
                                signal: pass
                                    ? AbortSignal.any([
                                          pass.signal,
                                          ...(args.signal ? [args.signal] : []),
                                      ])
                                    : args.signal,
                            }),
                        ),
                    );
                    checkpoint();
                    return result;
                };
            if (name === "stateSyncCapabilities" && target.stateSyncCapabilities) {
                const capabilities = target.stateSyncCapabilities.bind(target);
                return (...args: Parameters<typeof capabilities>) => {
                    checkpoint();
                    return stage(capabilities(...args));
                };
            }
            const value = Reflect.get(target, name);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    const key = (sessionId: string): HostRunnerKey => ({ session_id: sessionId, harness });
    const log = (id: string, text: string) => sessionLog(id, `provider pipeline: ${text}`);
    function registerProjection(id: string): void {
        if (harness !== "opencode2") return;
        providerProjections.set(id, {
            owner: projectionOwner,
            read: () => {
                if (deps.rustPipeline !== "provider") return undefined;
                const s = hydrate(id);
                if (!s?.metadata.active || s.record.pipeline_exit) return undefined;
                const generation = s.metadata.switchGeneration ?? 1;
                let held = projectionTokens.get(id);
                if (!held || held.generation !== generation) {
                    held = { generation, token: {} };
                    projectionTokens.set(id, held);
                }
                return { owner: held.token, ids: s.record.ids };
            },
        });
    }
    const historian =
        options.historian ??
        (deps.historianRunner !== "broca"
            ? createHistorianHostRunner({
                  call: (args) =>
                      moduleClient.call({
                          ...args,
                          projectRoot,
                          body: { ...args.body, method: args.method },
                      }),
                  db: deps.db,
                  client: deps.client,
                  hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
                  sessionDirectory: (id) => deps.sessionDirectoryBySession?.get(id) ?? projectRoot,
                  enabled: () => deps.historianHostRunnerEnabled !== false,
                  maxOutputTokens: deps.historianMaxOutputTokens,
                  attemptTimeoutMs: () =>
                      deps.resolveHistorianRun?.().timeoutMs ?? deps.historianTimeoutMs,
              })
            : undefined);
    function stateFor(s: Session): HostRunnerState {
        const r = s.record;
        return {
            ...s.state,
            lineage_id: r.lineage_id,
            ancestry_json: JSON.stringify(r.ancestry),
            next_ordinal: r.next_ordinal,
            cursor: r.after_ordinal,
            served_through_ordinal: r.served_through_ordinal,
            setup_json: JSON.stringify({
                ...s.metadata,
                gap: r.history_gap_from,
                sourceDigests: [...r.source_digests],
                measuredUsage: r.measured_usage,
            }),
            unserved_json: JSON.stringify(r.unserved_subjects),
            ordinal_divergence: r.ordinal_divergence,
            last_not_applied_json: r.last_not_applied ? JSON.stringify(r.last_not_applied) : null,
        };
    }
    function save(
        id: string,
        s: Session,
        admissions: Admitted[] = [],
        elided: string[] = [],
        gap?: number,
    ): void {
        s.metadata.newestMid = admissions.at(-1)?.entry.id ?? s.metadata.newestMid;
        const state = stateFor(s);
        const pass: HostRunnerPass = {
            state: { ...state },
            replace_retired_rollback: s.replaceRecord,
            elided,
            truncate_after: s.pendingDescent,
            uningested_from: gap,
            entries: admissions.map(({ entry: e }) => ({
                ordinal: e.ordinal,
                message_id: e.id,
                ingest_json: e.ingest,
                hook_json: JSON.stringify(e.hook),
                op_version: e.op_version,
                ingested: e.ingested ? 1 : 0,
                race: e.race ? 1 : 0,
                created_at: now(),
            })),
        };
        write(() => commitHostRunnerPass(deps.db, key(id), pass));
        s.replaceRecord = undefined;
        s.state = state;
        s.pendingDescent = undefined;
    }
    function client(id: string, s: Session): ProviderClient {
        return new ProviderClient({
            moduleClient,
            sessionId: s.metadata.fullRequestNamespace ?? id,
            projectRoot,
            harness,
            wire: codec?.wire,
            now,
            bootstrapBudgetMs: OPENCODE_PROVIDER_BOOTSTRAP_BUDGET_MS,
            consumePreparedPolicy: () => deps.rustProviderPreparation === true,
            persistFence: async (fence) => {
                write(() =>
                    commitHostRunnerFence(deps.db, key(id), fence.request_id, fence.newest),
                );
                s.state.issued_request_id = fence.request_id;
                s.state.issued_newest = fence.newest;
            },
        });
    }
    function hydrate(id: string): Session | undefined {
        const warm = sessions.get(id);
        if (warm) return warm;
        const stored = loadHostRunnerRecord(deps.db, key(id));
        if (!stored?.state.plan_json || !stored.state.setup_json) return undefined;
        const metadata: Metadata = JSON.parse(stored.state.setup_json);
        const record = createRecord<MessageLike, FrozenProviderPlan>({
            lineage_id: stored.state.lineage_id,
            first_ordinal: metadata.first,
            plan: JSON.parse(stored.state.plan_json),
            initial: metadata.initial,
        });
        Object.assign(record, {
            next_ordinal: stored.state.next_ordinal,
            after_ordinal: stored.state.cursor,
            served_through_ordinal: stored.state.served_through_ordinal,
            ordinal_divergence: stored.state.ordinal_divergence,
            ancestry: JSON.parse(stored.state.ancestry_json),
            ids: stored.ids,
            source_digests: new Map(metadata.sourceDigests ?? []),
            measured_usage: metadata.measuredUsage,
            elided: stored.elided,
            unserved_subjects: JSON.parse(stored.state.unserved_json),
            pipeline_exit: stored.state.pipeline_exit_json
                ? JSON.parse(stored.state.pipeline_exit_json)
                : undefined,
            history_gap_from: metadata.gap,
            last_not_applied: stored.state.last_not_applied_json
                ? JSON.parse(stored.state.last_not_applied_json)
                : undefined,
        });
        if (options.deferServed)
            record.served_through_ordinal = options.servedThrough?.(id, record.lineage_id) ?? 0;
        record.descends_from = record.ancestry.at(-1);
        if (stored.views[0]) {
            const v = stored.views[0];
            record.view = {
                compaction_id: v.compaction_id,
                version: v.version,
                range: { from: v.range_from, to: v.range_to },
                replacement: JSON.parse(v.replacement_json),
                coverage: v.coverage_json ? JSON.parse(v.coverage_json) : undefined,
                state: v.state,
            };
        }
        record.entries = stored.entries.map((e) => {
            // Old stores retain JSON for uncompressed messages. Deleted source bodies
            // cannot reconstruct the hashes needed to validate a compacted range.
            if (!record.source_digests.has(e.message_id))
                record.source_digests.set(e.message_id, sourceDigest(e.ingest_json));
            const result = hydrateEntry(
                {
                    id: e.message_id,
                    ordinal: e.ordinal,
                    ingest: e.ingest_json,
                    op_version: e.op_version,
                    hook: JSON.parse(e.hook_json),
                    ingested: e.ingested === 1,
                    race: e.race === 1,
                },
                ops,
            );
            if (result.event) {
                record.counters.prefix_events++;
                log(id, `host-side prefix event ${result.event}`);
            }
            return result.entry;
        });
        const s = {
            record,
            state: stored.state,
            metadata,
            sync: legacy.getState(id),
            client: undefined as unknown as ProviderClient,
        } as Session;
        s.client = client(id, s);
        sessions.set(id, s);
        registerProjection(id);
        return s;
    }
    async function sync(
        id: string,
        s: Session,
        passComplete: boolean,
        force = false,
    ): Promise<void> {
        checkpoint();
        if (options.sync) return stage(options.sync(id, s.sync, passComplete));
        const chain = deps.resolveHistorianRun?.();
        const models = [
            chain?.model ?? deps.historianModel,
            ...(chain?.fallbackModels ?? deps.fallbackModels ?? []),
        ]
            .map((m) => (typeof m === "string" ? m : m?.model))
            .filter((m): m is string => !!m);
        const meta = getOrCreateSessionMeta(deps.db, id);
        const signature = JSON.stringify([
            models,
            flush(id),
            meta.lastTodoState,
            meta.systemPromptHash,
        ]);
        const syncResult = await stage(
            syncModuleState({
                client: {
                    ...moduleClient,
                    call: async (args) => {
                        const body = args.body as Record<string, unknown>;
                        return moduleClient.call({
                            ...args,
                            body:
                                args.method === "state_sync"
                                    ? {
                                          ...body,
                                          pass_complete: passComplete,
                                          historian_model_chain: [...new Set(models)],
                                      }
                                    : body,
                        });
                    },
                },
                state: s.sync,
                pass: {
                    db: deps.db,
                    sessionId: id,
                    projectPath: deps.projectPath ?? projectRoot,
                    nowMs: now(),
                },
                projectRoot,
                force: force || !s.metadata.active,
                options: {
                    authority: true,
                    knownWatermarksUnchanged:
                        s.syncSignature === signature &&
                        !deps.rustMemorySyncRequestedSessions?.has(id),
                },
            }),
        );
        if (syncResult.status === "retry_busy")
            throw new EmergencyFailClosedError("Provider state sync is still applying");
        s.syncSignature = signature;
        if (syncResult.status === "no_change" && passComplete) {
            try {
                await moduleClient.call({
                    sessionId: id,
                    projectRoot,
                    method: "state_sync",
                    body: {
                        method: "state_sync",
                        session_id: id,
                        shadow_generation: s.sync.moduleGeneration,
                        expected_shadow_seq: s.sync.lastAckedSeq,
                        pass_complete: true,
                        historian_model_chain: [...new Set(models)],
                    },
                });
            } catch (error) {
                // Tools can increment Rust's durable state sequence between passes.
                // Resynchronize with the module's returned sequence before retrying pass_complete.
                if (!force && readAuthoritySeqMismatch(error) !== null)
                    return sync(id, s, passComplete, true);
                throw error;
            }
        }
        checkpoint();
        // Rebuilding search embeddings can change data for other sessions. Keep that
        // maintenance outside cancellable bridge requests, because those writes cannot
        // roll back with this pass's queued history and view records.
        if (!passContext.getStore()) await drainSingleStoreEmbeddingWatermarks(deps.db);
    }
    function checkFailure(result: ProviderResult<unknown>): void {
        if (result.status === "unavailable") {
            const error = part(result.error ?? {});
            // A relay refusal does not prove the module did no work; never serve a raw hook fallback.
            if (error.source === "relay") {
                throw new EmergencyFailClosedError(`Bridge relay transport refused: ${error.code}`);
            }
            const ahead = storeAheadOfBinaryFailure(result.error);
            if (ahead) throw ahead;
        } else {
            const ahead = storeAheadOfBinaryFailure(result.answer);
            if (ahead) throw ahead;
        }
    }
    function ordinalConflict(result: ProviderResult<unknown>): boolean {
        let value: unknown = result.status === "answered" ? result.answer : result.error;
        const seen = new Set<unknown>();
        while (value && typeof value === "object" && !seen.has(value)) {
            seen.add(value);
            const error = part(value);
            if (
                error.code === "invalid_params" &&
                ["subject_mid", "subject_ordinal"].includes(String(part(error.detail ?? {}).field))
            )
                return true;
            value = error.cause;
        }
        return false;
    }
    function viewRow(s: Session): HostRunnerView {
        const v = s.record.view;
        return {
            lineage_id: s.record.lineage_id,
            compaction_id: v.compaction_id,
            version: v.version,
            range_from: v.range.from,
            range_to: v.range.to,
            replacement_json: JSON.stringify(v.replacement),
            coverage_json: v.coverage ? JSON.stringify(v.coverage) : null,
            state: v.state,
            applied_at: now(),
        };
    }
    function exit(id: string, s: Session, reason: ExitReason): void {
        if (s.record.pipeline_exit) return;
        const value = { reason, reseed_full_request: s.record.ordinal_divergence > 0 };
        write(() => commitHostRunnerExit(deps.db, key(id), JSON.stringify(value)));
        commitExit(s.record, reason);
        s.state.pipeline_exit_json = JSON.stringify(value);
        log(
            id,
            `exit ${reason}${value.reseed_full_request ? " declared prefix rebuild into fresh full-request namespace" : ""}`,
        );
    }
    async function fallback(
        id: string,
        s: Session | undefined,
        messages: MessageLike[],
        output: { messages: unknown[] },
        meta: SessionMeta,
    ): Promise<void> {
        const meters = currentProviderMeters();
        if (meters) {
            meters.fallback_count++;
            meters.pass_kind = "exit";
            meters.pipeline = "full_request";
        }
        const namespace =
            s?.metadata.fullRequestNamespace ??
            (s?.record.pipeline_exit?.reseed_full_request
                ? `${id}:full-request:${s.record.lineage_id}`
                : undefined);
        if (options.fullRequest)
            return options.fullRequest(
                id,
                messages,
                output,
                meta,
                namespace,
                s?.record.pipeline_exit?.reason ??
                    (deps.rustPipeline !== "provider" ? "provider_disabled" : "bootstrap_declined"),
            );
        if (!namespace) return legacy.run(id, messages, output, meta);
        // A race's runner ordinals cannot enter the canonical full-request namespace.
        // Re-route all module calls, not host storage or the real OpenCode session id.
        let fresh = reseeded.get(id);
        if (!fresh) {
            const { createRustModeTransform } = await import("../rust-mode-transform");
            fresh = createRustModeTransform(deps, {
                moduleClient: {
                    ...moduleClient,
                    call: (args) => {
                        let body = args.body;
                        if (!(body instanceof Uint8Array))
                            body = {
                                ...part(body),
                                params: { ...part(part(body).params), session_id: namespace },
                            };
                        else {
                            const wire = JSON.parse(new TextDecoder().decode(body));
                            wire.params.session_id = namespace;
                            body = new TextEncoder().encode(JSON.stringify(wire));
                        }
                        return moduleClient.call({ ...args, sessionId: namespace, body });
                    },
                },
                projectRoot,
                hostClient: deps.client,
                onEngineReconnectRefusal: deps.onRustEngineReconnectRefusal,
            });
            reseeded.set(id, fresh);
        }
        await fresh.run(id, messages, output, meta);
    }
    const reseeded = new Map<string, Legacy>();
    function recover(id: string, messages: MessageLike[]): void {
        const meters = currentProviderMeters();
        if (meters) meters.recovery_count++;
        deps.onRustEngineReconnectRefusal?.({
            sessionId: id,
            projectRoot,
            refusedUserMessageId:
                [...messages].reverse().find((m) => m.info.role === "user")?.info.id ?? "",
            providerProvenEmergency: false,
            compactionOff: false,
        });
    }
    async function answer(
        id: string,
        s: Session,
        result: PageResult,
        inputs: StepInputs,
        messages: MessageLike[],
    ): Promise<boolean> {
        checkpoint();
        checkFailure(result);
        if (result.status === "unavailable") {
            if (s.metadata.active && ["timeout", "late", "aborted"].includes(result.reason)) {
                throw new EmergencyFailClosedError(
                    `Provider step did not complete before its fence: ${result.reason}`,
                );
            }
            const error = part(result.error ?? {});
            if (error.code === "invalid_params" && part(error.detail ?? {}).field === "messages") {
                throw new StepOrdinalConflict("Status conflicts with module-ahead ingest");
            }
            if (result.exit_reason) exit(id, s, result.exit_reason);
            return false;
        }
        const a = result.answer;
        if (a.answer === "refuse") {
            commitNonViewAnswer(s.record, result.request_id, result.arrived_ms, "refuse");
            const gap = a.detail?.history_gap_from;
            if (a.code === "history_unreadable" && gap !== undefined) {
                if (gap < s.record.view.range.to || s.record.history_gap_from === gap) {
                    exit(id, s, "provider_history_lost");
                } else {
                    commitHistoryGap(s.record, gap);
                    save(id, s, [], [], gap);
                }
            } else if (a.code === "setup_missing") {
                s.metadata.active = false;
                s.metadata.setup = undefined;
                save(id, s);
            } else if (a.code === "invalid_params" && a.detail?.field === "messages") {
                throw new StepOrdinalConflict("Status conflicts with module-ahead ingest");
            }
            recover(id, messages);
            if (["window_too_small", "misconfigured"].includes(a.code)) {
                throw new EmergencyFailClosedError(`Provider step refused: ${a.code}`);
            }
            return false;
        }
        let applied = false;
        let coverage: RecordState["view"]["coverage"];
        if (a.answer === "compaction_message") {
            const appliedResult = applyCompaction(
                s.record,
                {
                    request_id: result.request_id,
                    arrived_ms: result.arrived_ms,
                    compaction: a.compaction as unknown as RecordState["view"],
                    coverage: a.coverage,
                },
                (all) => all.every((m) => providerReplacementValid(m, harness, incoming)),
            );
            applied = appliedResult.applied;
            if (appliedResult.applied) coverage = appliedResult.coverage;
        } else commitNonViewAnswer(s.record, result.request_id, result.arrived_ms, a.answer);
        if (a.answer !== "compaction_message" || applied) {
            acknowledgeStatus(s.record, new Set(result.page.messages.map((e) => e.id)));
            acknowledgeUnserved(s.record, [...s.record.unserved_subjects]);
            s.state.bootstrap_cursor =
                result.page.messages.at(-1)?.ordinal ?? s.state.bootstrap_cursor;
        }
        let hardMaterializedAt: number | undefined;
        if (applied) {
            const meters = currentProviderMeters();
            if (meters) {
                meters.rebuild_count++;
                meters.pass_kind = "rebuild";
            }
            s.metadata.active = true;
            // SOFT flush/pressure views do not consume the idle HARD trigger.
            const decision =
                a.answer === "compaction_message"
                    ? (a.decision ?? a.compaction.decision)
                    : undefined;
            if (
                decision === "HARD" ||
                (decision === undefined &&
                    ["cold", "model_switch", "manifest_change"].includes(
                        inputs.prefix_rebuilding?.reason ?? "",
                    ))
            ) {
                hardMaterializedAt = now();
                s.metadata.materializedAt = hardMaterializedAt;
            }
            // Once the final view is durable, its row owns all replacement bytes.
            // Ordinary metadata writes retain Setup controls, not duplicate heads.
            s.metadata.initial = { ...s.metadata.initial, replacement: [] };
            if (s.metadata.setup?.answer === "ready")
                s.metadata.setup = {
                    ...s.metadata.setup,
                    initial: { ...s.metadata.setup.initial, replacement: [] },
                };
            s.metadata.model = inputs.model;
            s.metadata.manifest = manifest(messages, id);
            s.metadata.flush = flush(id);
        }
        const state = stateFor(s);
        const accepted = {
            request_id: result.request_id,
            issued_newest: s.state.issued_newest ?? -1,
            state: { ...state },
            ingested_through:
                a.answer !== "compaction_message" || applied
                    ? result.page.messages.at(-1)?.ordinal
                    : undefined,
            view: applied ? viewRow(s) : undefined,
            hard_materialized_at: hardMaterializedAt,
        };
        write(() => commitHostRunnerAnswer(deps.db, key(id), accepted));
        s.state = state;
        if (applied) {
            afterCommit(() => {
                registerProjection(id);
                deps.historyRefreshSessions.delete(id);
                deps.pendingMaterializationSessions.delete(id);
                deps.rustMemorySyncRequestedSessions?.delete(id);
            });
            log(
                id,
                `applied view ${s.record.view.version} reason=${inputs.prefix_rebuilding?.reason ?? "pressure"}`,
            );
            if (coverage) {
                // Native markers commit a second database, which cannot roll back with
                // a cancelled bridge view. The bridge records coverage but leaves raw
                // host-history trimming to a separate post-publication integration step.
                if (passContext.getStore()) return applied;
                if (options.marker) await options.marker(id, coverage);
                else {
                    const { defaultCompactionMarkerStrategy } = await import(
                        "../transform-postprocess-phase"
                    );
                    const strategy =
                        deps.compactionMarkerStrategy ?? defaultCompactionMarkerStrategy;
                    strategy.applyDeferred(
                        deps.db,
                        id,
                        {
                            ordinal: coverage.ordinal,
                            endMessageId: coverage.end_mid,
                            publishedAt: now(),
                        },
                        projectRoot,
                        {
                            rowVersion: s.record.view.version,
                            ordinal: coverage.ordinal,
                            endMessageId: coverage.end_mid,
                        },
                    );
                }
            }
        }
        return applied;
    }
    function model(id: string, messages: MessageLike[]): string {
        const live = deps.liveModelBySession?.get(id);
        // Newest message first, stopping at the first one naming a model, instead
        // of copying and mapping the whole transcript on every pass.
        let m: unknown = live;
        for (let index = messages.length - 1; m == null && index >= 0; index--) {
            const info = part(messages[index]!.info);
            const found =
                info.model ??
                (info.providerID && info.modelID
                    ? { providerID: info.providerID, modelID: info.modelID }
                    : undefined);
            if (found) m = found;
        }
        const value = part(m ?? {});
        return `${value.providerID ?? "unknown"}/${value.modelID ?? "unknown"}`;
    }
    function manifest(messages: MessageLike[], sessionId = ""): string {
        const id = sessionId || messages.at(-1)?.info.sessionID || "";
        if (codec) return codec.manifest(id);
        const row = deps.db
            .prepare("SELECT system_prompt_hash FROM session_meta WHERE session_id=?")
            .get(id) as { system_prompt_hash: string | null } | null;
        return `${row?.system_prompt_hash ?? ""}:${deps.getToolSetHash?.(id) ?? ""}`;
    }
    function flush(id: string): string {
        // Publications and queued drops deliberately do not arm a rebuild. Structural
        // mutations, epoch/upgrade edits and explicit refresh signals do.
        const row = deps.db
            .prepare(`SELECT COALESCE((SELECT MAX(id) FROM m0_mutation_log
            WHERE session_id=?),0) AS mutation,
            COALESCE((SELECT project_memory_epoch FROM project_state WHERE project_path=?),0) AS epoch,
            (SELECT COUNT(*) FROM compartments WHERE session_id=? AND legacy=1) AS legacy`)
            .get(id, deps.projectPath ?? projectRoot, id) as {
            mutation: number;
            epoch: number;
            legacy: number;
        };
        return `${row.mutation}:${row.epoch}:${row.legacy > 0 ? "legacy" : "ready"}`;
    }
    function inputs(id: string, messages: MessageLike[], meta: SessionMeta): StepInputs {
        return openCodeStepInputs({
            model: model(id, messages),
            stepId: messages.at(-1)?.info.id ?? randomUUID(),
            meta,
            entry: deps.contextUsageMap.get(id),
            now: now(),
        });
    }
    function rebuildReason(
        id: string,
        s: Session,
        messages: MessageLike[],
        meta: SessionMeta,
        reverted = false,
    ): string | undefined {
        return reverted || s.record.view.state === "invalidated"
            ? "revert"
            : model(id, messages) !== s.metadata.model
              ? "model_switch"
              : manifest(messages, id) !== s.metadata.manifest
                ? "manifest_change"
                : deps.historyRefreshSessions.has(id) ||
                    deps.rustMemorySyncRequestedSessions?.has(id) ||
                    flush(id) !== s.metadata.flush
                  ? "flush"
                  : providerCold(meta, now())
                    ? "cold"
                    : undefined;
    }
    function classifyStep(id: string, messages: MessageLike[], meta: SessionMeta): BridgeStepKind {
        const s = hydrate(id);
        if (!s?.metadata.active || String(s.record.pipeline_exit?.reason) === "rollback")
            return "bootstrap";
        const scan = scanWindow(
            s.record,
            messages.filter((m) => !isMagicContextHead(m)).map(incoming),
        );
        return rebuildReason(id, s, messages, meta, scan.revert_through !== undefined)
            ? "rebuild"
            : "ordinary";
    }
    async function bootstrap(
        id: string,
        s: Session | undefined,
        messages: MessageLike[],
        meta: SessionMeta,
        reentry?: Session,
    ): Promise<Session | undefined> {
        checkpoint();
        const visible = messages.filter(
            (m) => !isMagicContextHead(m) && incoming(m).classify() !== "marker",
        );
        if (!s || reentry) {
            const memo = legacy.getState(id);
            const resolved = codec
                ? {
                      ok: true as const,
                      annotatedInput: codec
                          .ordinals(id, visible)
                          .map((absolute_ordinal) => ({ absolute_ordinal })),
                  }
                : await stage(
                      (options.resolveOrdinals ?? resolveOrdinalsForModule)({
                          sessionId: id,
                          messages: visible,
                          generation: memo.moduleGeneration,
                          memoGeneration: memo.idOrdinalMemoGeneration,
                          memo: memo.idOrdinalMemo,
                          memoAnchor: memo.ordinalMemoAnchor,
                          memoStoredCount: memo.ordinalMemoStoredCount,
                          memoCanonicalCount: memo.ordinalMemoCanonicalCount,
                          memoCheckpoints: memo.ordinalMemoCheckpoints,
                          provisionalBase: memo.ordinalContinuationBase ?? undefined,
                      }),
                  );
            // The full-request resolver deliberately lends ordinals to wire-only
            // synthetics. Bootstrap admits only distinct, persisted identities.
            const persisted = options.persisted ?? hasRawSessionMessageById;
            const ordinals = resolved.ok
                ? resolved.annotatedInput.map((m) => Number(part(m).absolute_ordinal))
                : [];
            if (
                !resolved.ok ||
                visible.some(
                    (m) =>
                        !mid(m) ||
                        !persisted(id, mid(m) ?? "") ||
                        incoming(m).classify() !== "terminal",
                ) ||
                ordinals.some(
                    (o, i) =>
                        !Number.isSafeInteger(o) ||
                        o < 1 ||
                        (i > 0 && o !== (ordinals[i - 1] ?? -1) + 1),
                )
            ) {
                log(
                    id,
                    "bootstrap declined: message lacks its own canonical ordinal; decline counter +1",
                );
                declines++;
                return reentry;
            }
            const first = ordinals[0] ?? 1;
            const initial = {
                compaction_id: "bootstrap",
                version: 0,
                range: { from: 0, to: 0 },
                replacement: [],
                state: "applied" as const,
            };
            const r = createRecord<MessageLike, FrozenProviderPlan>({
                lineage_id: randomUUID(),
                first_ordinal: first,
                plan: freezeProviderPlan(
                    { subscriptions: [] },
                    {
                        preset: meta.isSubagent ? "worker" : "head",
                        params: {
                            serializer_profile: codec?.serializerProfile ?? "opencode-aisdk",
                            observation: "answer",
                        },
                    },
                ),
                initial,
            });
            if (options.deferServed) r.served_through_ordinal = 0;
            if (reentry && !reentry.record.pipeline_exit?.reseed_full_request) {
                // Setup re-entry does not authorize a new lineage by itself. Share
                // only the covered prefix before this canonical bootstrap window;
                // its pages explicitly re-admit the window on the descended lane.
                const ancestor = {
                    lineage_id: reentry.record.lineage_id,
                    through_ordinal: Math.min(first - 1, reentry.record.next_ordinal - 1),
                };
                r.ancestry = [...reentry.record.ancestry, ancestor];
                r.descends_from = ancestor;
            }
            s = {
                record: r,
                state: createHostRunnerState(r.lineage_id, first),
                sync: memo,
                metadata: {
                    first,
                    initial,
                    active: false,
                    model: model(id, messages),
                    manifest: manifest(messages, id),
                    flush: flush(id),
                    materializedAt: meta.cachedM0MaterializedAt ?? 0,
                    switchGeneration: reentry
                        ? Number(
                              JSON.parse(reentry.state.pipeline_exit_json ?? "{}")
                                  .switch_generation ?? 2,
                          ) + 1
                        : 1,
                    reentry: !!reentry,
                    fullRequestNamespace:
                        reentry?.metadata.fullRequestNamespace ??
                        (reentry?.record.pipeline_exit?.reseed_full_request
                            ? `${id}:full-request:${reentry.record.lineage_id}`
                            : undefined),
                },
                client: undefined as unknown as ProviderClient,
                replaceRecord: reentry?.state.pipeline_exit_json ?? undefined,
            };
            s.client = client(id, s);
            const declaration = await stage(
                s.client.declare({
                    preset: r.plan.preset,
                    params: r.plan.params,
                }),
            );
            checkFailure(declaration);
            if (declaration.status !== "answered") return reentry;
            r.plan = freezeProviderPlan(declaration.answer, {
                preset: r.plan.preset,
                params: { ...r.plan.params },
            });
            s.state.plan_json = JSON.stringify(r.plan);
            const appends = scanWindow(r, visible.map(incoming)).appends;
            const admissions: Admitted[] = [];
            for (const candidate of appends) {
                const admitted = admit(r, candidate, {
                    request_id: randomUUID(),
                    ...inputs(id, messages, meta),
                    session: id,
                    harness,
                    now: now(),
                    params: r.plan.params,
                    preset: r.plan.preset,
                });
                if ("exit" in admitted) {
                    save(id, s);
                    exit(id, s, admitted.exit);
                    sessions.set(id, s);
                    registerProjection(id);
                    return s;
                }
                admissions.push(finishEntry(candidate, admitted, [], ops) as Admitted);
            }
            commitProviderEntries(r, admissions);
            save(id, s, admissions);
            sessions.set(id, s);
            registerProjection(id);
        } else {
            // Bootstrap can span host passes while the current pipeline still serves.
            // Admit new persisted tail rows before completing, rather than dropping
            // appends that arrived after a timed-out page.
            const scan = scanWindow(s.record, visible.map(incoming));
            if (
                scan.exit ||
                scan.revert_through !== undefined ||
                scan.appends.some(
                    (c) => c.race || !(options.persisted ?? hasRawSessionMessageById)(id, c.id),
                )
            ) {
                declines++;
                log(
                    id,
                    "bootstrap declined: staged window changed before completion; decline counter +1",
                );
                return s;
            }
            if (scan.appends.length) {
                const staged: Admitted[] = [];
                for (const candidate of scan.appends) {
                    const admitted = admit(s.record, candidate, {
                        request_id: randomUUID(),
                        ...inputs(id, messages, meta),
                        session: id,
                        harness,
                        now: now(),
                        params: s.record.plan.params,
                    });
                    if ("exit" in admitted) {
                        exit(id, s, admitted.exit);
                        return s;
                    }
                    staged.push(finishEntry(candidate, admitted, [], ops) as Admitted);
                }
                commitProviderEntries(s.record, staged);
                save(id, s, staged);
            }
        }
        if (s.state.bootstrap_refused_json) {
            const refused = JSON.parse(s.state.bootstrap_refused_json);
            if (refused.config?.model === model(id, messages)) return s;
            s.state.bootstrap_refused_json = null;
            save(id, s);
        }
        if ((s.metadata.retryAt ?? 0) > now()) return s;
        if (!s.metadata.setup) {
            const setup = await stage(
                s.client.setup(s.record, {
                    ...inputs(id, messages, meta),
                    composition: {},
                }),
            );
            checkFailure(setup);
            if (setup.status !== "answered") return s;
            if (setup.answer.answer === "refuse") {
                if (
                    !["history_unreadable", "transient", "busy", "unavailable"].includes(
                        setup.answer.code,
                    )
                ) {
                    s.state.bootstrap_refused_json = JSON.stringify({
                        ...setup.answer,
                        config: { model: model(id, messages) },
                    });
                    log(id, `bootstrap stopped: ${setup.answer.code}`);
                } else s.metadata.retryAt = now() + 1000;
                save(id, s);
                return s;
            }
            if (
                setup.answer.initial.range.from < setup.answer.initial.range.to &&
                !s.metadata.reentry
            ) {
                exit(id, s, "provider_record_lost");
                return s;
            }
            s.metadata.setup = setup.answer;
            s.record.view = {
                ...setup.answer.initial,
                // A retained conversation is expected on an explicit switch back.
                // Its prior view is only a version fence, never a staged serve.
                ...(s.metadata.reentry ? { range: { from: 0, to: 0 }, replacement: [] } : {}),
                state: "applied",
            } as RecordState["view"];
            s.metadata.initial = s.record.view;
            s.sync.lastAckedWatermarks = null;
            save(id, s);
        }
        await sync(id, s, true);
        const controls: StepInputs = {
            ...inputs(id, messages, meta),
            newest: { ordinal: s.record.next_ordinal - 1, mid: s.metadata.newestMid ?? "empty" },
            prefix_rebuilding: { reason: "pipeline_switch" },
        };
        const pending = s;
        const result = await stage(
            s.client.bootstrap(
                s.record,
                controls,
                async (page) => {
                    await answer(id, pending, page, controls, messages);
                },
                passContext.getStore()?.signal,
            ),
        );
        checkFailure(result);
        return s;
    }
    let declines = 0;
    async function run(
        id: string,
        messages: MessageLike[],
        output: { messages: unknown[] },
        meta: SessionMeta,
        conflictRetry = 0,
    ): Promise<void> {
        return withProviderMeters(
            id,
            harness === "pi" ? "Pi" : harness === "opencode" ? "OpenCode1" : "OpenCode2",
            null,
            () => runPass(id, messages, output, meta, conflictRetry),
            (meters) => {
                sessionLog(
                    id,
                    `rust pass: decision=${meters.pass_kind} reason=provider_pipeline pipeline=${meters.pipeline} pass_id=${meters.pass_id} elapsed=${meters.pass_ms} ms provider_meters=${JSON.stringify(meters)}`,
                );
                options.emitMeters?.(structuredClone(meters));
            },
        );
    }
    async function runPass(
        id: string,
        messages: MessageLike[],
        output: { messages: unknown[] },
        meta: SessionMeta,
        conflictRetry = 0,
    ): Promise<void> {
        checkpoint();
        // A legacy handoff preserves its original exception type. In particular,
        // BUSY must still be eligible for the legacy wrapper's LKG recovery.
        const existing = hydrate(id);
        if (
            deps.rustPipeline !== "provider" ||
            (existing?.record.pipeline_exit &&
                String(existing.record.pipeline_exit.reason) !== "rollback")
        ) {
            if (existing?.metadata.active && !existing.record.pipeline_exit) {
                const value = {
                    reason: "rollback",
                    reseed_full_request: existing.record.ordinal_divergence > 0,
                    switch_generation: (existing.metadata.switchGeneration ?? 1) + 1,
                };
                write(() => commitHostRunnerExit(deps.db, key(id), JSON.stringify(value)));
                existing.state.pipeline_exit_json = JSON.stringify(value);
                existing.record.pipeline_exit = value as unknown as RecordState["pipeline_exit"];
                log(
                    id,
                    `exit rollback${value.reseed_full_request ? " declared prefix rebuild into fresh full-request namespace" : ""}`,
                );
            }
            return fallback(id, existing, messages, output, meta);
        }
        if (busy.has(id)) throw new EmergencyFailClosedError("Provider pass already in flight");
        busy.add(id);
        let committedBeforePass: number | undefined;
        try {
            let s = hydrate(id);
            committedBeforePass = s?.metadata.active
                ? s.record.next_ordinal - 1
                : s
                  ? s.metadata.first - 1
                  : undefined;
            const reentry =
                s?.record.pipeline_exit && String(s.record.pipeline_exit.reason) === "rollback"
                    ? s
                    : undefined;
            if (!s?.metadata.active || reentry) {
                const meters = currentProviderMeters();
                if (meters) meters.pass_kind = "bootstrap";
                s = await meterProviderStage("bootstrap", () =>
                    bootstrap(id, s, messages, meta, reentry),
                );
                if (!s?.metadata.active || s.record.pipeline_exit) {
                    return fallback(id, s, messages, output, meta);
                }
                const bootstrapped = s;
                await meterProviderStage("publish", () =>
                    publishMessages(output, assemble(bootstrapped.record)),
                );
                afterCommit(() => {
                    if (meters) meters.historian_pump_count += historian ? 1 : 0;
                    void withoutProviderMeters(() => historian?.pump(id));
                });
                return;
            }
            const incomingWindow = messages.filter((m) => !isMagicContextHead(m)).map(incoming);
            const previousViewVersion = s.record.view.version;
            let scan = scanWindow(s.record, incomingWindow);
            if (scan.exit) {
                exit(id, s, scan.exit);
                return fallback(id, s, messages, output, meta);
            }
            const reverted = scan.revert_through !== undefined;
            commitScan(s.record, scan, reverted ? randomUUID() : undefined);
            if (reverted) {
                s.metadata.newestMid = [...s.record.ids].find(
                    ([, ordinal]) => ordinal === scan.revert_through,
                )?.[0];
                s.pendingDescent = scan.revert_through;
                save(id, s, [], scan.elided);
                scan = { ...scan, elided: [] };
            }
            committedBeforePass = s.record.next_ordinal - 1;
            // Id classification precedes sync; trigger eligibility is after the
            // synchronized chain and the last hook's pass-complete barrier.
            await meterProviderStage("state_sync", () => sync(id, s, scan.appends.length === 0));
            const controls = inputs(id, messages, meta);
            const admissions: Admitted[] = [];
            let completedHook = false;
            for (let attempt = 0; attempt < 2; attempt++) {
                const meters = currentProviderMeters();
                if (meters && attempt > 0) meters.retry_count++;
                admissions.length = 0;
                completedHook = false;
                let conflict = false;
                for (const [i, candidate] of scan.appends.entries()) {
                    const admitted = admit(s.record, candidate, {
                        request_id: randomUUID(),
                        ...controls,
                        session: id,
                        harness,
                        params: s.record.plan.params,
                        now: now(),
                    });
                    if ("exit" in admitted) {
                        exit(id, s, admitted.exit);
                        await fallback(id, s, messages, output, meta);
                        return;
                    }
                    const subjects = subjectsFor(admitted.message).filter((subject) =>
                        s?.record.plan.subscriptions.some(
                            (sub) =>
                                sub.hook === subject.hook &&
                                (!sub.tools ||
                                    (subject.hook === "post_tool" &&
                                        sub.tools.includes(subject.tool))),
                        ),
                    );
                    const outcomes: HookOutcome[] = [];
                    for (const [j, subject] of subjects.entries()) {
                        const complete = i === scan.appends.length - 1 && j === subjects.length - 1;
                        const result = await meterProviderStage("hook_transport", () =>
                            s.client.hook(
                                s.record,
                                { ...subject, subject_ordinal: candidate.ordinal },
                                admitted.ingest,
                                complete ? true : undefined,
                                passContext.getStore()?.signal,
                            ),
                        );
                        checkpoint();
                        completedHook ||= complete;
                        if (
                            !codec?.freezeUnavailableHooks ||
                            result.status !== "unavailable" ||
                            !["timeout", "late", "aborted"].includes(result.reason)
                        )
                            checkFailure(result);
                        if (result.status === "unavailable") {
                            const error = part(result.error ?? {});
                            if (
                                error.code === "transient" &&
                                typeof error.message === "string" &&
                                error.message.startsWith("resident_not_ready:")
                            ) {
                                throw new EmergencyFailClosedError(error.message);
                            }
                        }
                        // A deadline is not proof that the module did no work. It
                        // may have committed a tag whose answer is still in flight;
                        // serving the raw append would lose that tag on this turn.
                        if (
                            result.status === "unavailable" &&
                            !codec?.freezeUnavailableHooks &&
                            ["timeout", "late", "aborted"].includes(result.reason)
                        ) {
                            throw new EmergencyFailClosedError(
                                `Provider hook did not complete before its fence: ${result.reason}`,
                            );
                        }
                        if (ordinalConflict(result)) {
                            conflict = true;
                            break;
                        }
                        if (
                            result.status === "answered" &&
                            (result.answer.answer === "pass" || result.answer.answer === "ops")
                        ) {
                            acknowledgeUnserved(s.record, [...s.record.unserved_subjects]);
                            outcomes.push({
                                subject,
                                answer: {
                                    subject,
                                    ops: result.answer.answer === "ops" ? result.answer.ops : [],
                                    tags: [],
                                },
                            });
                        } else outcomes.push({ subject, unavailable: true });
                    }
                    if (conflict) break;
                    const finished = finishEntry(candidate, admitted, outcomes, ops) as Admitted;
                    admissions.push(finished);
                    // The next message's hook must burn these answers before deciding
                    // cadence, even though the append transaction is later.
                    s.record.unserved_subjects.push(...finished.unserved_subjects);
                }
                if (!conflict) break;
                if (attempt === 1)
                    throw new EmergencyFailClosedError("Repeated provider ordinal conflict");
                const through = s.record.next_ordinal - 1;
                descendModuleAhead(s.record, randomUUID());
                s.pendingDescent = through;
                save(id, s);
            }
            // Burns are already carried between hooks in this pass. Do not re-add
            // subjects a later successful hook has acknowledged.
            commitProviderEntries(
                s.record,
                admissions.map((a) => ({ ...a, unserved_subjects: [] })),
            );
            save(id, s, admissions, scan.elided);
            if (options.onOutcome) {
                for (const { entry } of admissions) {
                    for (const outcome of entry.hook.outcomes ?? []) {
                        const notification = structuredClone(outcome);
                        const pass = passContext.getStore();
                        if (pass)
                            pass.afterCommit(() => {
                                void options.onOutcome?.(
                                    entry.id,
                                    notification.subject,
                                    notification,
                                );
                            });
                        else await options.onOutcome(entry.id, notification.subject, notification);
                    }
                }
            }
            // A final append without a subscribed hook still ends the pass. Signal
            // completion after every append is recorded, not in the pre-ingest sync.
            if (scan.appends.length && !completedHook)
                await meterProviderStage("state_sync", () => sync(id, s, true));
            controls.newest = {
                ordinal: s.record.next_ordinal - 1,
                mid: s.metadata.newestMid ?? "empty",
            };
            for (const event of scan.events) log(id, `host-side prefix event ${event}`);
            const reason = rebuildReason(id, s, messages, meta);
            const setup = s.metadata.setup;
            const share = setup?.answer === "ready" ? Number(setup.call_when?.share ?? 0.9) : 0.9;
            const usage = controls.previous_usage;
            const appended = admissions.reduce((sum, a) => sum + a.entry.ingest.length / 4, 0);
            if (
                reason ||
                s.record.last_not_applied ||
                s.record.history_gap_from !== undefined ||
                (usage &&
                    Number(usage.input ?? 0) +
                        Number(usage.cache_read ?? 0) +
                        Number(usage.cache_write ?? 0) +
                        appended >=
                        share * (controls.context_window ?? 200_000))
            ) {
                if (reason) controls.prefix_rebuilding = { reason };
                // Continuation pages may not apply views. This same bounded paging
                // lane is also needed when several frozen-raw appends exceed 3 MiB.
                const pending = s;
                await meterProviderStage("rebuild", () =>
                    stage(
                        s.client.bootstrap(
                            s.record,
                            controls,
                            async (page) => {
                                await answer(id, pending, page, controls, messages);
                            },
                            passContext.getStore()?.signal,
                        ),
                    ),
                );
            }
            if (s.record.pipeline_exit) return fallback(id, s, messages, output, meta);
            else {
                const measured = deps.contextUsageMap.get(id);
                if (
                    measured?.hasUsageTokens &&
                    measured.usage.percentage >= 95 &&
                    !s.record.view.coverage &&
                    s.record.view.version === previousViewVersion
                ) {
                    throw new EmergencyFailClosedError(
                        "Provider-proven emergency wall without a fold",
                    );
                }
                checkpoint();
                await meterProviderStage("publish", () =>
                    publishMessages(
                        output,
                        assemble(
                            s.record,
                            scan.passthrough.map((p) => p.read()),
                        ),
                    ),
                );
                afterCommit(() => {
                    const meters = currentProviderMeters();
                    if (meters) meters.historian_pump_count += historian ? 1 : 0;
                    void withoutProviderMeters(() => historian?.pump(id));
                });
            }
        } catch (error) {
            const pass = passContext.getStore();
            if (pass?.signal.aborted) {
                sessions.delete(id);
                throw pass.signal.reason;
            }
            if (error instanceof StepOrdinalConflict && conflictRetry === 0) {
                passContext.getStore()?.reset();
                sessions.delete(id);
                const held = hydrate(id);
                if (held) {
                    const through = committedBeforePass ?? held.metadata.first - 1;
                    // The step follows this pass's durable append, but those bytes
                    // have not gone to the provider yet. Descend through the prior
                    // committed frontier, burn the stranded answers and re-hook the
                    // same appends once; inheriting the new frontier keeps the conflict.
                    const { descend } = await import("./record");
                    descend(held.record, through, randomUUID());
                    held.pendingDescent = through;
                    save(id, held);
                    busy.delete(id);
                    const meters = currentProviderMeters();
                    if (meters) meters.retry_count++;
                    return await run(id, messages, output, meta, conflictRetry + 1);
                }
            }
            // Reload on the next pass: never retain an in-memory transition whose
            // transaction failed. The outer wrapper cannot replay the legacy slot.
            sessions.delete(id);
            const ahead = storeAheadOfBinaryFailure(error);
            recover(id, messages);
            throw (
                ahead ??
                (error instanceof EmergencyFailClosedError
                    ? error
                    : new EmergencyFailClosedError(
                          "Provider record cannot safely serve this turn",
                          { cause: error },
                      ))
            );
        } finally {
            busy.delete(id);
        }
    }
    return {
        run,
        classifyStep,
        receipt(id: string) {
            const s = hydrate(id);
            if (!s?.metadata.active || s.record.pipeline_exit)
                throw new Error("No published bridge record for this session");
            return bridgeReceipt(s.record);
        },
        acknowledgeDelivery(id: string, receipt: import("./bridge-receipt").BridgeReceipt) {
            const s = hydrate(id);
            if (!s || s.record.lineage_id !== receipt.lineage_id || receipt.delivery !== "clean")
                return;
            s.record.served_through_ordinal = Math.max(
                s.record.served_through_ordinal,
                receipt.served_through_ordinal,
            );
            save(id, s);
        },
        throughOrdinal(id: string): number {
            return (hydrate(id)?.record.next_ordinal ?? 1) - 1;
        },
        async runBudgeted(
            id: string,
            messages: MessageLike[],
            output: { messages: unknown[] },
            meta: SessionMeta,
            pass: BridgeStep,
        ): Promise<void> {
            await passContext.run(pass, async () => {
                try {
                    await run(id, messages, output, meta);
                    pass.check();
                    pass.commit(deps.db);
                } catch (error) {
                    sessions.delete(id);
                    throw error;
                }
            });
            // Observer work starts only after durable publication and must not inherit
            // the finished model request's cancellation signal or staged-write queue.
            pass.publish();
        },
        isProviderSession(id: string): boolean {
            const s = hydrate(id);
            return (
                deps.rustPipeline === "provider" &&
                s?.metadata.active === true &&
                !s.record.pipeline_exit
            );
        },
        /** Reload saved messages after restart, without checking a new request's sources or model fit. */
        recoverOutput(id: string, output: { messages: unknown[] }): boolean {
            try {
                sessions.delete(id);
                const s = hydrate(id);
                if (!s?.metadata.active || s.record.pipeline_exit) return false;
                publishMessages(output, assemble(s.record));
                return true;
            } catch {
                return false;
            }
        },
        ordinals(id: string): ReadonlyMap<string, number> | undefined {
            const s = hydrate(id);
            return s?.metadata.active && !s.record.pipeline_exit ? s.record.ids : undefined;
        },
        isFallbackAdmissible(
            id: string,
            input: FallbackInputs,
            nativeCut?: import("./bridge-marker").BridgeNativeCut,
        ): FallbackAdmissibility {
            const s = hydrate(id);
            if (deps.rustPipeline !== "provider" || !s?.metadata.active || s.record.pipeline_exit) {
                return {
                    admissible: false,
                    reason: "covered_range_changed",
                    detail: "No active provider record for this session",
                };
            }
            return isFallbackAdmissible(s.record, input, nativeCut);
        },
        /** Save input-token usage for the caller's exact served request without exposing the internal record. */
        recordProviderUsage(id: string, usage: ProviderUsageInput): void {
            if (busy.has(id)) throw new Error("Provider pass already in flight");
            const s = hydrate(id);
            if (deps.rustPipeline !== "provider" || !s?.metadata.active || s.record.pipeline_exit)
                throw new Error("No active provider record for this session");
            const previous = s.record.measured_usage;
            try {
                recordProviderUsage(s.record, usage);
                save(id, s);
            } catch (error) {
                s.record.measured_usage = previous;
                sessions.delete(id);
                throw error;
            }
        },
        /** Latest provider usage attributed to this session's served request, if any. */
        measuredUsage(id: string): RecordState["measured_usage"] {
            const s = hydrate(id);
            return s?.record.measured_usage && structuredClone(s.record.measured_usage);
        },
        /** Give native-history writers the saved request and coverage record, not caller-supplied summary coordinates alone. */
        record(id: string): RecordState | undefined {
            const s = hydrate(id);
            return s?.metadata.active && !s.record.pipeline_exit ? s.record : undefined;
        },
        bootstrapDeclines: () => declines,
        hasRecord: (id: string) => hydrate(id) !== undefined,
        dispose() {
            for (const [id, projection] of providerProjections) {
                if (projection.owner === projectionOwner) providerProjections.delete(id);
            }
            const stopped = historian?.stop();
            for (const fresh of reseeded.values()) fresh.dispose();
            sessions.clear();
            projectionTokens.clear();
            return stopped ?? Promise.resolve();
        },
    };
}
