import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, join } from "node:path";
import { loadPluginConfigDetailed } from "../../../config";
import { resolveProjectIdentityForSession } from "../../../features/magic-context/memory/project-identity";

import { recordSessionProjectIdentity } from "../../../features/magic-context/session-project-storage";
import { openBridgeDatabase } from "../../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../../features/magic-context/storage-meta";
import {
    clearPendingCompactionMarkerStateIf,
    getPendingCompactionMarkerState,
    getPersistedCompactionMarkerState,
} from "../../../features/magic-context/storage-meta-persisted";

import type { PluginContext } from "../../../plugin/types";
import { sessionLog } from "../../../shared/logger";
import {
    boundMarkerEnvelope,
    deriveMarkerEnvelopeReading,
    hasUnobservedTools,
    markerEnvelopeKey,
    qualifyingMarkerEnvelopeUpper,
} from "../marker-envelope";
import { SubcModuleTransport } from "../module-transport";
import { hasRawMessageProvider } from "../read-session-chunk";
import { createRustModeTransform } from "../rust-mode-transform";
import type { TransformDeps } from "../transform";
import type { MessageLike } from "../transform-operations";
import { createBridgeDeps } from "./bridge-deps";
import { createBridgeHostFacts } from "./bridge-host-facts";
import { type BridgeMarkerOutcome, createBridgeReceiptStore } from "./bridge-marker";
import { openCodeCutProblem, openCodeCutSources } from "./bridge-native-cut";
import type { BridgeReceipt, BridgeRequestCompletion } from "./bridge-receipt";
import { BridgeStep } from "./bridge-step";
import {
    type BridgeAdapterOptions,
    type BridgeFallbackInputs,
    type BridgeHostFact,
    type BridgeMarkerInputs,
    type BridgeOutcomeListener,
    BridgeRefusalError,
    type BridgeRunInput,
    type BridgeStepKind,
    type BridgeView,
} from "./bridge-types";
import type { ProviderUsageInput } from "./fallback-admissibility";
import { InjectedBridgeTransport } from "./injected-transport";
import {
    createOpenCodeProviderTransform,
    isMagicContextHead,
    providerIncoming,
    providerRevertsToRaw,
} from "./opencode-adapter";

/** The frozen messages of one returned view: admitted host messages, not heads or
 * still-running passthrough rows, whose bytes the host may already have sent. */
export interface ServedView {
    lineageId: string;
    viewVersion?: number;
    messages: Map<string, { bytes: string; message: MessageLike }>;
}

export function servedView(
    receipt: BridgeReceipt,
    messages: readonly MessageLike[],
    ordinals: ReadonlyMap<string, number> | undefined,
    through: number,
): ServedView {
    const frozen = new Map<string, { bytes: string; message: MessageLike }>();
    for (const message of messages) {
        const id = message.info?.id;
        const ordinal = id ? ordinals?.get(id) : undefined;
        if (!id || ordinal === undefined || ordinal > through) continue;
        frozen.set(id, { bytes: JSON.stringify(message), message: structuredClone(message) });
    }
    return {
        lineageId: receipt.lineage_id,
        viewVersion: receipt.last_applied?.version,
        messages: frozen,
    };
}

/**
 * Fail closed before a view that rewrites already-served bytes reaches the host.
 * Within one lineage, a message the bridge returned before must come back byte for
 * byte, unless this step rebuilds history: the step was classified as a rebuild or
 * the module applied a new view. Even a rebuild may not put a message back to the
 * host's raw text after Magic Context had served it with tags or other hook edits;
 * that would send unmanaged history. Messages a compaction removed are not compared.
 */
export function checkServedBytes(
    previous: ServedView | undefined,
    receipt: BridgeReceipt,
    kind: BridgeStepKind,
    next: readonly MessageLike[],
    host: readonly MessageLike[],
): void {
    if (!previous || previous.lineageId !== receipt.lineage_id) return;
    const rebuilt = kind === "rebuild" || receipt.last_applied?.version !== previous.viewVersion;
    for (const message of next) {
        const id = message.info?.id;
        const before = id ? previous.messages.get(id) : undefined;
        if (!before || before.bytes === JSON.stringify(message)) continue;
        if (!rebuilt) throw new BridgeRefusalError("served_bytes_changed");
        const raw = host.find((candidate) => candidate.info?.id === id);
        if (raw && providerRevertsToRaw(before.message, message, providerIncoming(raw).read()))
            throw new BridgeRefusalError("served_bytes_changed");
    }
}

/** Own only the bridge's handles; importing the public subpath never loads this runtime. */
export function createBridgeAdapter(options: BridgeAdapterOptions) {
    for (const name of ["projectRoot", "connectionFile", "storageDir"] as const) {
        if (!isAbsolute(options[name])) throw new Error(`${name} must be an absolute path`);
    }
    const config = loadPluginConfigDetailed(options.projectRoot, false, options.configPath).config;
    const v2 =
        "hook" in options.openCodeClient.session &&
        typeof options.openCodeClient.session.hook === "function";
    const harness = v2 ? "opencode2" : "opencode";
    const db = openBridgeDatabase(
        join(options.storageDir, "context.db"),
        options.allowMigration === true,
    );
    const transport = options.transport
        ? new InjectedBridgeTransport(options.transport)
        : new SubcModuleTransport(options.connectionFile, undefined, undefined, "", harness);
    let legacy: ReturnType<typeof createRustModeTransform> | undefined;
    let provider: ReturnType<typeof createOpenCodeProviderTransform>;
    let deps: TransformDeps;
    const listeners = new Set<BridgeOutcomeListener>();
    const observerFailures = new Set<string>();
    const observations = new Set<Promise<void>>();
    const observingSession = new AsyncLocalStorage<string>();
    try {
        deps = createBridgeDeps(
            config,
            {
                db,
                client: v2 ? undefined : (options.openCodeClient as PluginContext["client"]),
                directory: options.projectRoot,
                storeGeneration: v2 ? "v2" : "v1",
                rustModeModuleClient: transport,
            },
            "opencode",
        );
        // Reuse the Rust transform's message-id/ordinal cache for bootstrap, but refuse its full-request execution path.
        legacy = createRustModeTransform(deps, {
            moduleClient: transport,
            hostClient: deps.client,
            projectRoot: options.projectRoot,
        });
        provider = createOpenCodeProviderTransform(deps, legacy, {
            deferServed: true,
            servedThrough: (id, lineage) => {
                try {
                    const receipt = createBridgeReceiptStore(db, id, harness).current();
                    return receipt?.lineage_id === lineage ? receipt.served_through_ordinal : 0;
                } catch {
                    return 0;
                }
            },
            publishedThrough: (id, lineage) => {
                try {
                    return createBridgeReceiptStore(db, id, harness).publishedThrough(lineage);
                } catch {
                    return 0;
                }
            },
            onOutcome: async (...args) => {
                const observing = Promise.all(
                    [...listeners].map(async (listener) => {
                        try {
                            await listener(...args);
                        } catch (error) {
                            const id = observingSession.getStore();
                            if (id && !observerFailures.has(id)) {
                                observerFailures.add(id);
                                sessionLog(id, "bridge outcome observer failed", error);
                            }
                        }
                    }),
                ).then(() => {});
                observations.add(observing);
                try {
                    await observing;
                } finally {
                    observations.delete(observing);
                }
            },
            fullRequest: async (_id, _messages, _output, _meta, _namespace, reason) => {
                throw new BridgeRefusalError(reason ?? "bootstrap_declined");
            },
        });
    } catch (error) {
        legacy?.dispose();
        transport.close();
        db.close();
        throw error;
    }
    let disposed = false;
    const hostFacts = createBridgeHostFacts(deps, config);
    let disposal: Promise<void> | undefined;
    const runs = new Set<Promise<void>>();
    const activeSessions = new Set<string>();
    const published = new Map<string, { requestId: string; messages: BridgeView["messages"] }>();
    /** Per session: the frozen messages of the last view returned, keyed by message id. */
    const served = new Map<string, ServedView>();
    /** Per session: whether a system_prompt fact was accepted since the last run() attempt,
     * and whether the last published view's request carried Magic Context's system bytes. */
    const systemPrompts = new Map<string, { sinceAttempt: boolean; lastPublished: boolean }>();
    function assertOpen() {
        if (disposed) throw new Error("Bridge adapter is disposed");
    }
    return {
        /** Observe host state without certifying delivery or removing history from the host store. */
        async recordHostFact(fact: BridgeHostFact) {
            assertOpen();
            if (activeSessions.has(fact.sessionId))
                throw new Error("Bridge pass already in flight");
            const receipt = createBridgeReceiptStore(db, fact.sessionId, harness).current();
            if (
                !receipt ||
                receipt.lineage_id !== fact.lineageId ||
                (fact.kind === "provider_response" && receipt.request_id !== fact.requestId)
            )
                return { accepted: false };
            activeSessions.add(fact.sessionId);
            const pending = hostFacts(fact);
            const observing = pending.then(
                () => {},
                () => {},
            );
            observations.add(observing);
            try {
                const result = await pending;
                if (result.accepted && fact.kind === "system_prompt") {
                    const prompt = systemPrompts.get(fact.sessionId);
                    systemPrompts.set(fact.sessionId, {
                        sinceAttempt: true,
                        lastPublished: prompt?.lastPublished ?? false,
                    });
                }
                if (
                    result.accepted &&
                    fact.kind === "provider_response" &&
                    fact.material &&
                    fact.usage
                ) {
                    const sent = published.get(fact.sessionId);
                    const model = `${fact.model.providerID}/${fact.model.modelID}`;
                    const inputTokens =
                        fact.usage.input + fact.usage.cacheRead + fact.usage.cacheWrite;
                    if (
                        sent?.requestId === fact.requestId &&
                        inputTokens > 0 &&
                        boundMarkerEnvelope(fact.material, model) !== undefined
                    ) {
                        provider.recordProviderUsage(fact.sessionId, {
                            messages: sent.messages,
                            model,
                            envelope: markerEnvelopeKey(fact.material),
                            inputTokens,
                            // Only a successful response's usage bounds the envelope: an
                            // aborted or failed request may report partial input usage.
                            envelopeReading:
                                fact.outcome === "success"
                                    ? deriveMarkerEnvelopeReading({
                                          material: fact.material,
                                          messages: sent.messages,
                                          totalInput: inputTokens,
                                          model,
                                      })
                                    : undefined,
                        });
                    }
                }
                return result;
            } finally {
                activeSessions.delete(fact.sessionId);
                observations.delete(observing);
            }
        },
        async run({ sessionId: id, messages, kind }: BridgeRunInput): Promise<BridgeView> {
            const startedAt = performance.now();
            assertOpen();
            if (kind !== "model")
                throw new Error(
                    "Bridge run kind must be model; rebuild classification is adapter-owned",
                );
            if (v2 && !hasRawMessageProvider(id))
                throw new BridgeRefusalError("raw_history_provider_missing");
            if (activeSessions.has(id)) throw new Error("Bridge pass already in flight");
            // Ordering contract: a host that sends Magic Context's system prompt records
            // the system_prompt fact before every run(), recovery runs included, and sends
            // the strings that fact returns. The bridge never sees the system bytes the host
            // sends, so a run with no fresh fact after a request that carried Magic
            // Context's system prompt would go out with the host's raw prompt. Refuse it;
            // recording the fact and calling run() again serves the step.
            const prompt = systemPrompts.get(id);
            if (prompt?.lastPublished && !prompt.sinceAttempt)
                throw new BridgeRefusalError("system_prompt_unmanaged");
            const managedSystem = prompt?.sinceAttempt === true;
            if (prompt) prompt.sinceAttempt = false;
            const nativeStore = createBridgeReceiptStore(db, id, harness);
            const nativeCut = nativeStore.appliedCut();
            if (
                nativeStore.cutState() === "applied" &&
                (nativeCut?.kind !== "opencode" ||
                    openCodeCutProblem(
                        messages.filter((m) => !isMagicContextHead(m)),
                        nativeCut,
                    ))
            )
                throw new BridgeRefusalError("covered_range_changed");
            // Transport follows symlinks to bind a real filesystem directory, but a
            // non-git project's memory key hashes the path string supplied by the host.
            // Save that key in session_projects before the module looks up memories;
            // hashing the transport's resolved path (e.g. /private/var instead of /var)
            // would otherwise select a different memory pool.
            const projectIdentity = resolveProjectIdentityForSession(
                options.projectRoot,
                config.allow_home_project,
            );
            deps.projectPath = projectIdentity;
            recordSessionProjectIdentity(db, id, projectIdentity, harness);
            const meta = getOrCreateSessionMeta(db, id, harness);
            const stepKind = provider.classifyStep(id, messages, meta);
            const pass = new BridgeStep(stepKind, startedAt);
            const output = { messages: [] as unknown[] };
            activeSessions.add(id);
            const running = observingSession.run(id, () =>
                provider.runBudgeted(id, messages, output, meta, pass, () =>
                    checkServedBytes(
                        served.get(id),
                        provider.receipt(id),
                        stepKind,
                        output.messages as BridgeView["messages"],
                        messages,
                    ),
                ),
            );
            runs.add(running);
            try {
                await running;
                let receipt = provider.receipt(id);
                try {
                    receipt = createBridgeReceiptStore(db, id, harness).publish(
                        receipt,
                        output.messages as BridgeView["messages"],
                        provider.throughOrdinal(id),
                    );
                } catch (error) {
                    // The view is already durable and servable. An unpersisted pending
                    // receipt cannot authorize a native cut or acknowledge delivery.
                    sessionLog(id, "bridge receipt persistence deferred", error);
                }
                try {
                    published.set(id, {
                        requestId: receipt.request_id,
                        messages: structuredClone(output.messages as BridgeView["messages"]).map(
                            (m) => providerIncoming(m).read(),
                        ),
                    });
                } catch {
                    // Optional usage attribution must never reject a published view.
                    published.delete(id);
                }
                served.set(
                    id,
                    servedView(
                        receipt,
                        output.messages as BridgeView["messages"],
                        provider.ordinals(id),
                        provider.throughOrdinal(id),
                    ),
                );
                systemPrompts.set(id, { sinceAttempt: false, lastPublished: managedSystem });
                return {
                    messages: output.messages as BridgeView["messages"],
                    kind: stepKind,
                    receipt,
                };
            } catch (error) {
                if (error instanceof Error) Object.assign(error, { kind: stepKind });
                throw error;
            } finally {
                pass.dispose();
                activeSessions.delete(id);
                runs.delete(running);
            }
        },
        /** Report the terminal response, not response headers. A clean refusal counts. */
        completeRequest(
            id: string,
            requestId: string,
            response: BridgeRequestCompletion,
        ): BridgeReceipt | undefined {
            assertOpen();
            if (activeSessions.has(id)) throw new Error("Bridge pass already in flight");
            const receipt = createBridgeReceiptStore(db, id, harness).complete(requestId, response);
            if (receipt) provider.acknowledgeDelivery(id, receipt);
            return receipt;
        },
        receipt(id: string): BridgeReceipt | undefined {
            assertOpen();
            return createBridgeReceiptStore(db, id, harness).current();
        },
        /** Run after publication; missing cut/fit proof leaves the returned messages servable. */
        async advanceNativeMarker(
            id: string,
            receipt: BridgeReceipt,
            inputs: BridgeMarkerInputs,
        ): Promise<BridgeMarkerOutcome> {
            assertOpen();
            if (v2 || activeSessions.has(id))
                return { kind: "deferred", reason: "native-marker-unavailable" };
            try {
                const material = inputs.material && structuredClone(inputs.material);
                if (!material || boundMarkerEnvelope(material, inputs.model) === undefined)
                    return { kind: "deferred", reason: "native-marker-evidence-unavailable" };
                // Unobserved tool schemas are bounded only by a qualifying reading: a
                // served, successful request with the same model, tool names and system.
                if (
                    hasUnobservedTools(material) &&
                    qualifyingMarkerEnvelopeUpper(
                        provider.measuredUsage(id),
                        material,
                        inputs.model,
                    ) === undefined
                )
                    return { kind: "deferred", reason: "native-marker-evidence-unavailable" };
                const envelope = markerEnvelopeKey(material);
                const pending = getPendingCompactionMarkerState(db, id);
                if (!pending) return { kind: "deferred", reason: "no-pending-target" };
                const { applyDeferredCompactionMarker } = await import(
                    "../compaction-marker-manager"
                );
                const { prepareCompactionMarkerCandidates } = await import(
                    "../../../features/magic-context/compaction-marker"
                );
                // Candidate discovery can yield and checkpoint the host WAL, so finish it
                // before the receipt store acquires its writer lease for the native cut.
                if (!(await prepareCompactionMarkerCandidates(id)))
                    return { kind: "deferred", reason: "candidate-preparation" };
                const store = createBridgeReceiptStore(db, id, harness);
                const nativeCut = store.appliedCut();
                let raw = inputs.messages.filter((m) => !isMagicContextHead(m));
                if (store.cutState() === "applied") {
                    if (nativeCut?.kind !== "opencode" || openCodeCutProblem(raw, nativeCut))
                        return { kind: "deferred", reason: "covered_range_changed" };
                    const ordinals = provider.ordinals(id);
                    const ordered = ordinals && openCodeCutSources(raw, nativeCut, ordinals);
                    if (!ordered) return { kind: "deferred", reason: "covered_range_changed" };
                    raw = ordered;
                }
                return store.advance(
                    {
                        receipt,
                        target: { ordinal: pending.ordinal, end_mid: pending.endMessageId },
                        raw,
                        proveFit: () => {
                            if (
                                JSON.stringify(provider.receipt(id).last_applied) !==
                                JSON.stringify(receipt.last_applied)
                            )
                                return { admissible: false };
                            return provider.isFallbackAdmissible(
                                id,
                                {
                                    ...inputs,
                                    material,
                                    envelope,
                                    messages: inputs.messages
                                        .filter((m) => !isMagicContextHead(m))
                                        .map((m) => providerIncoming(m).read()),
                                },
                                nativeCut,
                            );
                        },
                    },
                    () => {
                        if (
                            JSON.stringify(getPendingCompactionMarkerState(db, id)) !==
                            JSON.stringify(pending)
                        )
                            return "deferred";
                        const outcome = applyDeferredCompactionMarker(
                            db,
                            id,
                            pending,
                            options.projectRoot,
                        );
                        if (outcome.kind === "applied" || outcome.kind === "already-current") {
                            const state = getPersistedCompactionMarkerState(db, id);
                            if (!state) return "unknown";
                            const native = {
                                kind: "opencode" as const,
                                boundary_mid: state.boundaryMessageId,
                                summary_mid: state.summaryMessageId,
                                compaction_part_id: state.compactionPartId,
                            };
                            if (
                                outcome.kind === "already-current" &&
                                openCodeCutProblem(
                                    inputs.messages.filter((m) => !isMagicContextHead(m)),
                                    native,
                                )
                            )
                                return "deferred";
                            clearPendingCompactionMarkerStateIf(db, id, pending);
                            return { kind: "applied", native };
                        }
                        return outcome.kind === "retryable-failure" &&
                            outcome.cut !== "definitely-no-cut"
                            ? "unknown"
                            : "deferred";
                    },
                );
            } catch {
                return { kind: "deferred", reason: "native-marker-evidence-unavailable" };
            }
        },
        isFallbackAdmissible(id: string, inputs: BridgeFallbackInputs) {
            assertOpen();
            const store = createBridgeReceiptStore(db, id, harness);
            if (store.cutState() === "unknown")
                return {
                    admissible: false as const,
                    reason: "covered_range_changed" as const,
                    detail: "Native cut outcome is unknown; rebuild or recover the cut before replaying a pre-cut request",
                };
            if (store.cutState() === "applied" && !store.appliedCut())
                return {
                    admissible: false as const,
                    reason: "covered_range_changed" as const,
                    detail: "Native cut identity is unavailable",
                };
            return provider.isFallbackAdmissible(
                id,
                {
                    ...inputs,
                    messages: inputs.messages
                        .filter((message) => !isMagicContextHead(message))
                        .map((message) => providerIncoming(message).read()),
                },
                store.appliedCut(),
            );
        },
        recordProviderUsage(id: string, usage: ProviderUsageInput): void {
            assertOpen();
            if (activeSessions.has(id)) throw new Error("Bridge pass already in flight");
            provider.recordProviderUsage(id, usage);
        },
        onOutcome(listener: BridgeOutcomeListener): () => void {
            assertOpen();
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        /** Wait for active passes before closing the independent store and transport exactly once. */
        dispose(): Promise<void> {
            if (disposal) return disposal;
            disposed = true;
            disposal = (async () => {
                await Promise.allSettled([...runs]);
                await Promise.allSettled([...observations]);
                try {
                    await provider.dispose();
                    legacy?.dispose();
                } finally {
                    listeners.clear();
                    observerFailures.clear();
                    published.clear();
                    served.clear();
                    systemPrompts.clear();
                    try {
                        transport.close();
                    } finally {
                        db.close();
                    }
                }
            })();
            return disposal;
        },
    };
}
