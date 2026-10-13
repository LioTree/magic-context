import type { MagicContextConfig } from "../../config/schema/magic-context";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import type { PluginContext } from "../../plugin/types";
import { getHarness } from "../../shared/harness";
import { resolveHistorianModel } from "../../shared/model-resolution";
import type { Database } from "../../shared/sqlite";
import { resolveHiddenCompletionExecutor } from "./compartment-runner-historian";
import type { HiddenCompletionExecutor } from "./compartment-runner-types";
import { createRescoreCommandController } from "./rescore-command";
import { createOpenCodeRescoreCarrier, rescoreAdmissionFailure } from "./rescore-driver";

const controllers = new WeakMap<
    Database,
    Map<string, ReturnType<typeof createRescoreCommandController>>
>();

export function openCodeRescoreCommand(options: {
    db: Database;
    directory: string;
    client: PluginContext["client"];
    executor?: HiddenCompletionExecutor;
    sampleConfig: () => Partial<
        Pick<MagicContextConfig, "historian" | "historian_timeout_ms" | "allow_home_project">
    >;
    notify?: (sessionId: string, text: string) => Promise<void>;
}) {
    let byDirectory = controllers.get(options.db);
    if (!byDirectory) {
        byDirectory = new Map();
        controllers.set(options.db, byDirectory);
    }
    const existing = byDirectory.get(options.directory);
    if (existing) return existing;
    const controller = createRescoreCommandController({
        serviceOptions: (sessionId) => {
            const projectPath = resolveProjectIdentityForSession(
                options.directory,
                options.sampleConfig().allow_home_project,
            );
            if (!projectPath) throw new Error("No canonical project for rescore");
            return {
                db: options.db,
                projectPath,
                sessionId,
                harness: getHarness(),
                admissionFailure: rescoreAdmissionFailure(sessionId),
            };
        },
        resolveProfile: () => {
            const config = options.sampleConfig();
            const model = resolveHistorianModel(config, "opencode").primary;
            return {
                model: model?.model ?? null,
                variant: model?.qualifier,
                temperature: config.historian?.temperature ?? 0,
                maxOutputTokens: config.historian?.maxTokens ?? 4096,
            };
        },
        createCarrier: (sessionId) =>
            createOpenCodeRescoreCarrier({
                db: options.db,
                sessionId,
                harness: getHarness(),
                directory: options.directory,
                executor: resolveHiddenCompletionExecutor(
                    options.executor,
                    options.client,
                    options.db,
                    options.directory,
                    "ctx-rescore",
                ),
                timeoutMs: options.sampleConfig().historian_timeout_ms ?? 600_000,
            }),
        notify: options.notify,
    });
    byDirectory.set(options.directory, controller);
    return controller;
}
