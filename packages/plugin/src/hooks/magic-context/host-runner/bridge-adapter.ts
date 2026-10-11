import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, join } from "node:path";
import { loadPluginConfigDetailed } from "../../../config";
import { resolveProjectIdentityForSession } from "../../../features/magic-context/memory/project-identity";
import { createScheduler } from "../../../features/magic-context/scheduler";
import { recordSessionProjectIdentity } from "../../../features/magic-context/session-project-storage";
import { openBridgeDatabase } from "../../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../../features/magic-context/storage-meta";
import { createTagger } from "../../../features/magic-context/tagger";
import type { PluginContext } from "../../../plugin/types";
import { sessionLog } from "../../../shared/logger";
import { resolveHistorianModel } from "../../../shared/model-resolution";
import { SubcModuleTransport } from "../module-transport";
import { hasRawMessageProvider } from "../read-session-chunk";
import { createRustModeTransform } from "../rust-mode-transform";
import type { TransformDeps } from "../transform";
import { BridgeStep } from "./bridge-step";
import {
    type BridgeAdapterOptions,
    type BridgeFallbackInputs,
    type BridgeOutcomeListener,
    BridgeRefusalError,
    type BridgeRunInput,
    type BridgeView,
} from "./bridge-types";
import type { ProviderUsageInput } from "./fallback-admissibility";
import {
    createOpenCodeProviderTransform,
    isMagicContextHead,
    providerIncoming,
} from "./opencode-adapter";

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
    const transport = new SubcModuleTransport(
        options.connectionFile,
        undefined,
        undefined,
        "",
        harness,
    );
    let legacy: ReturnType<typeof createRustModeTransform> | undefined;
    let provider: ReturnType<typeof createOpenCodeProviderTransform>;
    let deps: TransformDeps;
    const listeners = new Set<BridgeOutcomeListener>();
    const observerFailures = new Set<string>();
    const observations = new Set<Promise<void>>();
    const observingSession = new AsyncLocalStorage<string>();
    try {
        const historian = resolveHistorianModel(config, "opencode");
        deps = {
            db,
            client: v2 ? undefined : (options.openCodeClient as PluginContext["client"]),
            directory: options.projectRoot,
            rustModeProjectRoot: options.projectRoot,
            allowHomeProject: config.allow_home_project,
            storeGeneration: v2 ? "v2" : "v1",
            // The calling integration owns bridge opt-in; transform_mode/rust_pipeline only select the in-tree plugin renderer.
            transformMode: "rust",
            rustPipeline: "provider",
            rustModeModuleClient: transport,
            tagger: createTagger(),
            scheduler: createScheduler({
                executeThresholdPercentage: config.execute_threshold_percentage,
            }),
            contextUsageMap: new Map(),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            cacheTtlConfig: config.cache_ttl,
            cacheTtlConfigured: config.cacheTtlConfigured,
            protectedTokens: config.protected_tokens,
            protectedTools: config.protected_tools,
            keepReasoningTokens: config.keep_reasoning_tokens,
            historyBudgetPercentage: config.history_budget_percentage,
            executeThresholdPercentage: config.execute_threshold_percentage,
            executeThresholdTokens: config.execute_threshold_tokens,
            historianModel: historian.primary,
            fallbackModels: historian.fallbacks,
            historianMaxOutputTokens: config.historian?.maxTokens,
            historianTimeoutMs: config.historian_timeout_ms,
            historianRunner: config.historian?.runner,
            historianHostRunnerEnabled: config.historian?.host_runner?.enabled,
            historianRunnable: config.historian?.disable !== true,
            promptSurface: config.prompt_surface,
        };
        // Reuse the Rust transform's message-id/ordinal cache for bootstrap, but refuse its full-request execution path.
        legacy = createRustModeTransform(deps, {
            moduleClient: transport,
            hostClient: deps.client,
            projectRoot: options.projectRoot,
        });
        provider = createOpenCodeProviderTransform(deps, legacy, {
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
    let disposal: Promise<void> | undefined;
    const runs = new Set<Promise<void>>();
    const activeSessions = new Set<string>();
    function assertOpen() {
        if (disposed) throw new Error("Bridge adapter is disposed");
    }
    return {
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
                provider.runBudgeted(id, messages, output, meta, pass),
            );
            runs.add(running);
            try {
                await running;
                return { messages: output.messages as BridgeView["messages"], kind: stepKind };
            } catch (error) {
                if (error instanceof Error) Object.assign(error, { kind: stepKind });
                throw error;
            } finally {
                pass.dispose();
                activeSessions.delete(id);
                runs.delete(running);
            }
        },
        isFallbackAdmissible(id: string, inputs: BridgeFallbackInputs) {
            assertOpen();
            return provider.isFallbackAdmissible(id, {
                ...inputs,
                messages: inputs.messages
                    .filter((message) => !isMagicContextHead(message))
                    .map((message) => providerIncoming(message).read()),
            });
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
