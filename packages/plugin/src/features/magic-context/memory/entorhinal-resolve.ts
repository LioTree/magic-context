import {
    type BindIdentity,
    connectionFileExists,
    SubcCallError,
    SubcClient,
} from "@cortexkit/subc-client";
import { getHarness } from "../../../shared/harness";
import { log } from "../../../shared/logger";
import { getDefaultSubcConnectionFile } from "../../../shared/subc-connection-file";

export const ENTORHINAL_RESOLVE_DEADLINE_MS = 500;

export type EntorhinalRegisteredVia = "root" | "walk" | "containment" | "worktree";

export type EntorhinalResolveResult =
    | {
          status: "resolved";
          projectId: string;
          via: EntorhinalRegisteredVia;
          canonicalRoot: string | null;
      }
    | { status: "implicit" }
    | { status: "absent"; reason: "no_connection_file" | "unknown_module" }
    | {
          status: "not_answering";
          reason:
              | "deadline"
              | "transport"
              | "storage_unavailable"
              | "invalid_params"
              | "unknown_via"
              | "decode";
      };

export interface EntorhinalResolveOptions {
    connectionFile?: string;
    identity?: BindIdentity;
    log?: (message: string) => void;
}

const loggedValues = new Set<string>();
const registeredVias = new Set<string>(["root", "walk", "containment", "worktree"]);
const deadlineResult = { status: "not_answering", reason: "deadline" } as const;

function logOnce(key: string, message: string, options: EntorhinalResolveOptions): void {
    if (loggedValues.has(key)) return;
    loggedValues.add(key);
    try {
        (options.log ?? log)(`[magic-context] Entorhinal resolve: ${message}`);
    } catch {
        // Diagnostics must not prevent a session from using its fallback identity.
    }
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function decodeFailure(value: unknown, options: EntorhinalResolveOptions): EntorhinalResolveResult {
    const diagnostic = JSON.stringify(value);
    logOnce(`decode:${diagnostic}`, `could not decode ${diagnostic}`, options);
    return { status: "not_answering", reason: "decode" };
}

function moduleError(code: unknown, options: EntorhinalResolveOptions): EntorhinalResolveResult {
    if (code === "unknown_module") return { status: "absent", reason: "unknown_module" };
    if (code === "invalid_params") {
        logOnce("invalid_params", "invalid_params (invalid resolve request)", options);
        return { status: "not_answering", reason: code };
    }
    if (code === "storage_unavailable") return { status: "not_answering", reason: code };
    return { status: "not_answering", reason: "transport" };
}

function decodeReply(body: unknown, options: EntorhinalResolveOptions): EntorhinalResolveResult {
    const reply = object(body);
    if (!reply) return decodeFailure(body, options);
    if (typeof reply.code === "string") return moduleError(reply.code, options);
    const result = object(reply.result);
    if (!result) return decodeFailure(reply, options);
    if (typeof result.via !== "string") return decodeFailure({ via: result.via }, options);
    if (result.via !== "implicit" && !registeredVias.has(result.via)) {
        logOnce(`via:${result.via}`, `unknown via ${JSON.stringify(result.via)}`, options);
        return { status: "not_answering", reason: "unknown_via" };
    }
    if (typeof result.projectId !== "string" || !/^pj-[A-Za-z0-9_-]+$/.test(result.projectId)) {
        return decodeFailure({ projectId: result.projectId }, options);
    }
    if (typeof result.gone !== "boolean") return decodeFailure({ gone: result.gone }, options);
    if (!Number.isSafeInteger(result.generation) || (result.generation as number) < 0) {
        return decodeFailure({ generation: result.generation }, options);
    }
    for (const key of ["workspaceId", "workspaceRoot", "projectName", "canonicalRoot"]) {
        if (result[key] !== null && typeof result[key] !== "string") {
            return decodeFailure({ [key]: result[key] }, options);
        }
    }
    if (result.via === "worktree" && typeof result.worktreeOf !== "string") {
        return decodeFailure({ worktreeOf: result.worktreeOf }, options);
    }
    // Implicit IDs describe unregistered directories, not registered projects.
    // Never persist one, even if a malformed reply labels it as a registered root.
    if (result.via === "implicit") return { status: "implicit" };
    if (result.projectId.startsWith("pj-implicit1-")) {
        return decodeFailure({ projectId: result.projectId }, options);
    }
    return {
        status: "resolved",
        projectId: result.projectId,
        via: result.via as EntorhinalRegisteredVia,
        canonicalRoot: result.canonicalRoot as string | null,
    };
}

/** Resolve once without writing pins or retaining a connection beyond the attempt. */
export async function resolveEntorhinalProject(
    canonicalRoot: string,
    options: EntorhinalResolveOptions = {},
): Promise<EntorhinalResolveResult> {
    const deadline = performance.now() + ENTORHINAL_RESOLVE_DEADLINE_MS;
    let expired = false;
    let client: SubcClient | undefined;
    const pastDeadline = () => expired || performance.now() >= deadline;
    const close = () => {
        client?.close();
        client = undefined;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<EntorhinalResolveResult>((resolve) => {
        timer = setTimeout(() => {
            expired = true;
            resolve(deadlineResult);
        }, ENTORHINAL_RESOLVE_DEADLINE_MS);
    });
    const attempt = async (): Promise<EntorhinalResolveResult> => {
        try {
            const connectionFile = options.connectionFile ?? getDefaultSubcConnectionFile();
            const exists = await connectionFileExists(connectionFile);
            if (pastDeadline()) return deadlineResult;
            if (!exists) return { status: "absent", reason: "no_connection_file" };
            client = await SubcClient.connect({
                connectionFile,
                handshakeTimeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
                routeOpenRetryDeadlineMs: 0,
            });
            if (pastDeadline()) {
                close();
                return deadlineResult;
            }
            const body = await client.call(
                "entorhinal",
                "resolve",
                { canonicalRoot },
                {
                    identity: options.identity ?? {
                        project_root: canonicalRoot,
                        harness: getHarness(),
                        session: "magic-context-project-resolve",
                    },
                    targetKind: "management_surface",
                    timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
                },
            );
            if (pastDeadline()) return deadlineResult;
            return decodeReply(body, options);
        } catch (error) {
            if (pastDeadline()) return deadlineResult;
            if (error instanceof SubcCallError && error.code)
                return moduleError(error.code, options);
            let cause: unknown = error;
            while (cause instanceof Error) {
                if (cause instanceof SyntaxError) return decodeFailure(cause.message, options);
                cause = cause.cause;
            }
            return { status: "not_answering", reason: "transport" };
        }
    };
    try {
        const result = await Promise.race([attempt(), timeout]);
        // Check the clock as well as the timer: a busy event loop can dispatch a late reply first.
        return pastDeadline() ? deadlineResult : result;
    } finally {
        expired = true;
        if (timer) clearTimeout(timer);
        close();
    }
}
