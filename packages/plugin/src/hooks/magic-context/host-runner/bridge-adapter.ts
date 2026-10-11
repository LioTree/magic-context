import { isAbsolute, join } from "node:path";
import { loadPluginConfigDetailed } from "../../../config";
import { createScheduler } from "../../../features/magic-context/scheduler";
import { openBridgeDatabase } from "../../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../../features/magic-context/storage-meta";
import { createTagger } from "../../../features/magic-context/tagger";
import type { PluginContext } from "../../../plugin/types";
import { resolveHistorianModel } from "../../../shared/model-resolution";
import { SubcModuleTransport } from "../module-transport";
import { hasRawMessageProvider } from "../read-session-chunk";
import { createRustModeTransform } from "../rust-mode-transform";
import type { TransformDeps } from "../transform";
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
    const listeners = new Set<BridgeOutcomeListener>();
    try {
        const historian = resolveHistorianModel(config, "opencode");
        const deps: TransformDeps = {
            db,
            client: v2 ? undefined : (options.openCodeClient as PluginContext["client"]),
            directory: options.projectRoot,
            projectPath: options.projectRoot,
            rustModeProjectRoot: options.projectRoot,
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
                for (const listener of [...listeners]) await listener(...args);
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
    function assertOpen() {
        if (disposed) throw new Error("Bridge adapter is disposed");
    }
    return {
        async run({ sessionId: id, messages, kind }: BridgeRunInput): Promise<BridgeView> {
            assertOpen();
            if (kind !== "model")
                throw new Error(
                    "Bridge run kind must be model; rebuild classification is adapter-owned",
                );
            if (v2 && !hasRawMessageProvider(id))
                throw new BridgeRefusalError("raw_history_provider_missing");
            const output = { messages: [] as unknown[] };
            const running = provider.run(
                id,
                messages,
                output,
                getOrCreateSessionMeta(db, id, harness),
            );
            runs.add(running);
            try {
                await running;
                return output.messages as BridgeView;
            } finally {
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
                try {
                    await provider.dispose();
                    legacy?.dispose();
                } finally {
                    listeners.clear();
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
