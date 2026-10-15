import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { log } from "../../../shared/logger";
import { projectDirectoryKey } from "../../../shared/project-directory-key";
import { writeStorageFileAtomicSync } from "../../../shared/storage-permissions";

// Lives in shared/ so the TUI (which ships without features/) can use the same
// normalization; re-exported here for the existing importers.
export { projectDirectoryKey };

export interface ProjectIdentityRecord {
    directory: string;
    identity: string;
    gitCommonDir?: string;
}

const ignoredImplicitRecords = new Set<string>();
const conflictingCommonDirs = new Set<string>();

export function isPinnedProjectIdentity(identity: unknown): identity is string {
    return (
        typeof identity === "string" &&
        /^pj-[A-Za-z0-9_-]+$/.test(identity) &&
        !identity.startsWith("pj-implicit1-")
    );
}

function readIdentityRecord(file: string): ProjectIdentityRecord | undefined {
    try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        if (typeof record?.directory !== "string" || typeof record.identity !== "string")
            return undefined;
        if (record.identity.startsWith("pj-implicit1-")) {
            const key = `${file}\0${record.identity}`;
            if (!ignoredImplicitRecords.has(key)) {
                ignoredImplicitRecords.add(key);
                log(`[magic-context] ignoring implicit project identity sidecar: ${file}`);
            }
            return undefined;
        }
        if (
            !/^git:[0-9a-f]{7,64}$/.test(record.identity) &&
            !isPinnedProjectIdentity(record.identity)
        )
            return undefined;
        return {
            directory: record.directory,
            identity: record.identity,
            ...(typeof record.gitCommonDir === "string"
                ? { gitCommonDir: record.gitCommonDir }
                : {}),
        };
    } catch {
        // Missing or damaged sidecars never prevent a session from starting.
        return undefined;
    }
}

function cachePath(directory: string, storageDir = getMagicContextStorageDir()): string {
    const hash = createHash("sha256").update(projectDirectoryKey(directory)).digest("hex");
    return path.join(storageDir, "project-identities", `${hash}.json`);
}

/** A small atomic sidecar avoids opening or migrating the store during plugin boot. */
export function rememberGitIdentity(directory: string, identity: string): void {
    if (!/^git:[0-9a-f]{7,64}$/.test(identity)) return;
    try {
        if (isPinnedProjectIdentity(readRememberedProjectIdentity(directory)?.identity)) return;
        const destination = cachePath(directory);
        writeStorageFileAtomicSync(
            destination,
            JSON.stringify({ directory: projectDirectoryKey(directory), identity }),
        );
    } catch {
        // Read-only storage must not turn a successful git probe into a failure.
    }
}

/** Persist an accepted live resolution after the caller has checked folder eligibility and topology. */
export function rememberPinnedProjectIdentity(
    directory: string,
    identity: string,
    gitCommonDir?: string,
): void {
    if (!isPinnedProjectIdentity(identity)) return;
    try {
        if (isPinnedProjectIdentity(readRememberedProjectIdentity(directory)?.identity)) return;
        writeStorageFileAtomicSync(
            cachePath(directory),
            JSON.stringify({ directory: projectDirectoryKey(directory), identity, gitCommonDir }),
        );
    } catch {
        // A read-only sidecar store must not prevent use of the live identity for this session.
    }
}

/** Read only the record for this exact directory key, never an ancestor's pin. */
export function readRememberedProjectIdentity(
    directory: string,
    storageDir?: string,
): ProjectIdentityRecord | undefined {
    const record = readIdentityRecord(cachePath(directory, storageDir));
    return record?.directory === projectDirectoryKey(directory) ? record : undefined;
}

/** `storageDir` lets offline tools read the sidecars that sit next to a chosen `context.db`. */
export function readRememberedGitIdentity(
    directory: string,
    storageDir?: string,
): string | undefined {
    const record = readRememberedProjectIdentity(directory, storageDir);
    return record?.identity.startsWith("git:") ? record.identity : undefined;
}

/** Borrow a unique pin for a checkout without writing a pin for the queried folder. */
export function findPinnedIdentityByGitCommonDir(
    gitCommonDir: string,
    storageDir = getMagicContextStorageDir(),
): string | undefined {
    const sidecarDir = path.join(storageDir, "project-identities");
    let files: string[];
    try {
        files = readdirSync(sidecarDir);
    } catch {
        return undefined;
    }
    const identities = new Set<string>();
    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const record = readIdentityRecord(path.join(sidecarDir, file));
        if (record?.gitCommonDir === gitCommonDir && isPinnedProjectIdentity(record.identity))
            identities.add(record.identity);
    }
    if (identities.size === 1) return identities.values().next().value;
    if (identities.size > 1) {
        const key = `${sidecarDir}\0${gitCommonDir}`;
        if (!conflictingCommonDirs.has(key)) {
            conflictingCommonDirs.add(key);
            log(`[magic-context] conflicting project pins for git common dir: ${gitCommonDir}`);
        }
    }
    return undefined;
}
