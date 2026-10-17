import type { loadPluginConfigDetailed } from "../../../config";
import { createScheduler } from "../../../features/magic-context/scheduler";
import { createTagger } from "../../../features/magic-context/tagger";
import { resolveHistorianModel } from "../../../shared/model-resolution";
import type { TransformDeps } from "../transform";

/** Explicit bridge construction selects Rust transforms even when the standalone plugin is configured to render in TypeScript. */
export function createBridgeDeps(
    config: ReturnType<typeof loadPluginConfigDetailed>["config"],
    base: Pick<
        TransformDeps,
        "db" | "directory" | "rustModeModuleClient" | "client" | "storeGeneration"
    >,
    harness: "opencode" | "pi",
): TransformDeps {
    const historian = resolveHistorianModel(config, harness);
    return {
        ...base,
        rustModeProjectRoot: base.directory,
        allowHomeProject: config.allow_home_project,
        transformMode: "rust",
        rustPipeline: "provider",
        tagger: createTagger(),
        scheduler: createScheduler({
            executeThresholdPercentage: config.execute_threshold_percentage,
        }),
        contextUsageMap: new Map(),
        liveModelBySession: new Map(),
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
}
