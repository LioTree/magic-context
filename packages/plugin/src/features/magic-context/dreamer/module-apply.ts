import { SingleStoreMigrationRequiredError } from "../../../hooks/magic-context/single-store-refusal";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";

const loggedNotOwnerProjects = new Set<string>();

export function logDreamerNotOwnerOnce(projectIdentity: string): void {
    if (loggedNotOwnerProjects.has(projectIdentity)) return;
    loggedNotOwnerProjects.add(projectIdentity);
    log(`[dreamer] ${projectIdentity}: ${new SingleStoreMigrationRequiredError().message}`);
}

export class DreamerModuleFailureError extends Error {
    readonly transient = true;
    constructor(operation: string, cause: unknown) {
        super(
            `Rust dreamer ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
        );
        this.name = "DreamerModuleFailureError";
    }
}

/** The module transport a dreamer write route calls. */
export interface DreamerModuleClient {
    call(args: {
        sessionId: string;
        projectRoot: string;
        method: string;
        body: unknown;
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<unknown>;
}

export interface DreamerModuleRoute {
    moduleClient: DreamerModuleClient;
    moduleSessionId: string;
    moduleProjectRoot: string;
    moduleCommandId: string;
}

export interface ModuleMemoryIdentity {
    moduleId: number;
    normalizedHash: string;
}

/** Capture the shared row's hash for the module's compare-before-write check. */
export function getModuleMemoryIdentities(
    db: Database,
    projectIdentity: string,
    contextIds: readonly number[],
): Map<number, ModuleMemoryIdentity> {
    if (contextIds.length === 0) return new Map();
    const placeholders = contextIds.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT id, normalized_hash FROM memories WHERE project_path = ? AND id IN (${placeholders})`,
        )
        .all(projectIdentity, ...contextIds) as Array<{ id: number; normalized_hash: string }>;
    return new Map(
        rows.map((row) => [row.id, { moduleId: row.id, normalizedHash: row.normalized_hash }]),
    );
}
