import { getSdkOutputLimit, getSdkWindowGeometry } from "../../shared/models-dev-cache";
import { sessionLog } from "../../shared/logger";
import {
    resolveHistorianProducerLimits,
    resolveKnownHistorianContextLimit,
} from "./derive-budgets";
import type { ModuleStateSyncClient, ModuleStateSyncState } from "./module-state-sync";
import type { OrdinalMemoCheckpoint } from "./module-wire";
import type { RawMessageOrdinalAnchor } from "./read-session-raw";
import type { TransformDeps } from "./transform";

export interface ModuleSessionClient extends ModuleStateSyncClient {
    call(
        args: Parameters<ModuleStateSyncClient["call"]>[0] & {
            onTimings?: (timings: import("./module-transport").ModuleCallTimings) => void;
        },
    ): Promise<unknown>;
    deleteSession?(sessionId: string, projectRoot: string): Promise<void>;
    closeSession?(sessionId: string): void;
}

export interface HistorianHostRunnerSeam {
    pump(routeSessionId: string): Promise<void>;
    stop(): Promise<void>;
}

export interface ModuleSessionState extends ModuleStateSyncState {
    ordinalMemoAnchor: RawMessageOrdinalAnchor | null;
    ordinalMemoStoredCount: number | null;
    ordinalMemoCanonicalCount: number;
    /** Checkpoints let a changed host history resume at the newest intact page. */
    ordinalMemoCheckpoints: OrdinalMemoCheckpoint[];
    ordinalMemoVerifyPending: boolean;
    ordinalMemoResetCause: string;
    /** Durable prior-lineage tail; sliced inputs continue after this ordinal. */
    ordinalContinuationBase: number | null;
    recordedSessionDirectory: string | null;
}

function initialState(): ModuleSessionState {
    return {
        seedPassPending: true,
        moduleGeneration: 0,
        lastAckedSeq: 0,
        lastAckedWatermarks: null,
        idOrdinalMemoGeneration: 0,
        idOrdinalMemo: new Map(),
        ordinalMemoAnchor: null,
        ordinalMemoStoredCount: null,
        ordinalMemoCanonicalCount: 0,
        ordinalMemoCheckpoints: [],
        ordinalMemoVerifyPending: false,
        ordinalMemoResetCause: "cold",
        ordinalContinuationBase: null,
        recordedSessionDirectory: null,
    };
}

/** Session bookkeeping shared by the OpenCode and Pi step-contract adapters. No transform route lives here. */
export function createModuleSessionKernel(options: {
    moduleClient: ModuleSessionClient;
    projectRoot?: string;
}) {
    const states = new Map<string, ModuleSessionState>();
    const ensureState = (id: string): ModuleSessionState => {
        let state = states.get(id);
        if (!state) {
            state = initialState();
            states.set(id, state);
        }
        return state;
    };
    return {
        getState(sessionId: string): Readonly<ModuleSessionState> {
            const state = ensureState(sessionId);
            return { ...state, idOrdinalMemo: new Map(state.idOrdinalMemo) };
        },
        invalidateWireState(sessionId: string): void {
            const state = states.get(sessionId);
            if (state) state.ordinalMemoVerifyPending = true;
        },
        async clearSession(sessionId: string): Promise<void> {
            const projectRoot =
                states.get(sessionId)?.recordedSessionDirectory ?? options.projectRoot;
            states.delete(sessionId);
            try {
                if (projectRoot && options.moduleClient.deleteSession)
                    await options.moduleClient.deleteSession(sessionId, projectRoot);
            } catch (error) {
                sessionLog(sessionId, "module session deletion failed:", error);
                throw error;
            } finally {
                // A pending provider pass can request state while deletion waits.
                states.delete(sessionId);
                options.moduleClient.closeSession?.(sessionId);
            }
        },
        dispose(): void {
            states.clear();
        },
    };
}

/** Resolve wrapup controls from current config rather than a previous pass's cached historian settings. */
export function rustWrapupHistorianFields(
    historian: Pick<TransformDeps, "historianModel" | "fallbackModels"> & {
        timeoutMs: number;
        maxOutputTokens?: number;
    },
): Record<string, unknown> {
    const models = [historian.historianModel, ...(historian.fallbackModels ?? [])];
    const chain = [
        ...new Set(
            models
                .map((entry) => (typeof entry === "string" ? entry : entry?.model))
                .filter((model): model is string => typeof model === "string" && model.length > 0),
        ),
    ];
    const variants: Record<string, string> = {};
    const seen = new Set<string>();
    for (const entry of models) {
        const model = typeof entry === "string" ? entry : entry?.model;
        if (typeof model !== "string" || model.length === 0 || seen.has(model)) continue;
        seen.add(model);
        const variant = typeof entry === "string" ? undefined : entry?.qualifier;
        if (variant) variants[model] = variant;
    }
    const limits = Object.fromEntries(
        chain.map((key) => {
            const [provider, ...parts] = key.split("/");
            const output =
                provider && parts.length ? getSdkOutputLimit(provider, parts.join("/")) : undefined;
            const producer = resolveHistorianProducerLimits(key);
            const known =
                producer.input === undefined ? resolveKnownHistorianContextLimit(key) : undefined;
            const learned =
                provider && parts.length
                    ? getSdkWindowGeometry(provider, parts.join("/"))?.derivation.window
                    : undefined;
            const context =
                producer.context ??
                (known === undefined
                    ? learned
                    : learned === undefined
                      ? known
                      : Math.min(known, learned));
            return [
                key,
                {
                    ...(context !== undefined ? { context } : {}),
                    ...(producer.input !== undefined ? { input: producer.input } : {}),
                    ...(output !== undefined ? { output } : {}),
                },
            ];
        }),
    );
    return {
        historian_model_chain: chain,
        historian_model_limits: limits,
        historian_model_variants: variants,
        historian_timeout_ms: historian.timeoutMs,
        ...(historian.maxOutputTokens !== undefined
            ? { historian_max_output_tokens: historian.maxOutputTokens }
            : {}),
    };
}
