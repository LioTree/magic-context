/**
 * The only module that touches real credentials.
 *
 * Vault mode reads the `mc-e2e` enrollment token from its file, asks the claustrum vault (through
 * `@cortexkit/claustrum-client`, imported from packages/e2e-tests where it is already a dependency)
 * for the ChatGPT and Antigravity subscription tokens, and returns them in memory. The Voyage key
 * is read from its key file. Nothing here prints, logs or writes a secret; callers hand the values
 * to child processes through their environment and to the in-process clients.
 *
 * Stub mode returns fixed fake values that the local stub upstream expects, so a whole run can be
 * proven without the vault.
 *
 * Failures that an operator can fix (no enrollment file, vault unreachable, credential not granted)
 * raise `CredentialError` with a one-line message; `report_auth_failure` is never called.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export class CredentialError extends Error {}

export interface ScopedRow {
    id: string;
    state: string;
    categories: readonly string[];
    refreshAdapter?: string;
}

export interface Credentials {
    mode: "vault" | "stub";
    codex: { token: string; accountId: string; credentialId: string; expiresAtMs: number | null };
    cloudCode: { token: string; project: string; credentialId: string; expiresAtMs: number | null };
    voyageKey: string;
    /** Every secret value, for scrubbing captured logs before they are written anywhere. */
    secrets(): string[];
}

export const STUB_CREDENTIALS = {
    codexToken: "stub-codex-token",
    codexAccountId: "stub-account-id",
    cloudCodeToken: "stub-cloud-code-token",
    cloudCodeProject: "stub-project-0001",
    voyageKey: "stub-voyage-key",
} as const;

export function stubCredentials(): Credentials {
    const value: Credentials = {
        mode: "stub",
        codex: {
            token: STUB_CREDENTIALS.codexToken,
            accountId: STUB_CREDENTIALS.codexAccountId,
            credentialId: "stub",
            expiresAtMs: null,
        },
        cloudCode: {
            token: STUB_CREDENTIALS.cloudCodeToken,
            project: STUB_CREDENTIALS.cloudCodeProject,
            credentialId: "stub",
            expiresAtMs: null,
        },
        voyageKey: STUB_CREDENTIALS.voyageKey,
        secrets: () => Object.values(STUB_CREDENTIALS),
    };
    return value;
}

export interface VaultOptions {
    /** Exact ChatGPT credential id; required when more than one `chatgpt:openai*` row is granted. */
    chatgptCredential?: string;
    antigravityCredential: string;
    voyageKeyFile: string;
    /** Minimum remaining lifetime demanded of each served token. */
    minTtlMs: number;
}

export const ENROLLMENT_PATH =
    process.env.MC_E2E_ENROLLMENT_PATH ??
    join(homedir(), ".config", "cortexkit", "mc-e2e", "enrollment.json");

const CLIENT_PATH = resolve(
    import.meta.dir,
    "../../../e2e-tests/node_modules/@cortexkit/claustrum-client/dist/index.js",
);

interface ClaustrumClientLike {
    listScoped(token: string): Promise<{ rows: readonly ScopedRow[] }>;
    getScoped(input: {
        credentialId: string;
        enrollmentToken: string;
        minTtlMs?: number;
    }): Promise<{
        material: string;
        expiresAtMs: number | null;
        accountId?: string;
        projectId?: string;
    }>;
    close(): void;
}

function readEnrollmentToken(): string {
    let text: string;
    try {
        text = readFileSync(ENROLLMENT_PATH, "utf8");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
        throw new CredentialError(
            `cannot read the mc-e2e enrollment file at ${ENROLLMENT_PATH} (${code})`,
        );
    }
    let token: unknown;
    try {
        token = (JSON.parse(text) as { token?: unknown }).token;
    } catch {
        throw new CredentialError(`the enrollment file at ${ENROLLMENT_PATH} is not JSON`);
    }
    if (typeof token !== "string" || !token)
        throw new CredentialError(`the enrollment file at ${ENROLLMENT_PATH} has no token`);
    return token;
}

function readKeyFile(path: string, label: string): string {
    try {
        const key = readFileSync(path, "utf8").trim();
        if (!key) throw new Error("empty");
        return key;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
        throw new CredentialError(`cannot read the ${label} key file at ${path} (${code})`);
    }
}

async function connect(): Promise<ClaustrumClientLike> {
    if (!existsSync(CLIENT_PATH)) {
        throw new CredentialError(
            `@cortexkit/claustrum-client is not installed at ${CLIENT_PATH}; run bun install`,
        );
    }
    const module = (await import(CLIENT_PATH)) as {
        ClaustrumClient: {
            connect(options: {
                logger: (errorClass: string) => void;
            }): Promise<ClaustrumClientLike>;
        };
    };
    try {
        // The client reports unknown error classes through this callback; they carry no secret.
        return await module.ClaustrumClient.connect({
            logger: (errorClass) => console.error(`vault error class: ${errorClass}`),
        });
    } catch (error) {
        throw new CredentialError(
            `cannot reach the claustrum vault (${(error as Error).message.slice(0, 200)})`,
        );
    }
}

/** Non-secret inventory, for choosing the ChatGPT account. */
export async function listGranted(): Promise<ScopedRow[]> {
    const token = readEnrollmentToken();
    const client = await connect();
    try {
        const inventory = await client.listScoped(token);
        return inventory.rows.map((row) => ({
            id: row.id,
            state: row.state,
            categories: row.categories,
            refreshAdapter: row.refreshAdapter,
        }));
    } finally {
        client.close();
    }
}

export async function vaultCredentials(options: VaultOptions): Promise<Credentials> {
    const voyageKey = readKeyFile(options.voyageKeyFile, "Voyage");
    const enrollment = readEnrollmentToken();
    const client = await connect();
    try {
        const rows = (await client.listScoped(enrollment)).rows;
        const chatgpt = rows.filter((row) => row.id.startsWith("chatgpt:openai"));
        let chatgptId = options.chatgptCredential;
        if (!chatgptId) {
            if (chatgpt.length !== 1) {
                const ids = chatgpt
                    .map((row) => `${row.id} [${row.state}; ${row.categories.join(",")}]`)
                    .join("; ");
                throw new CredentialError(
                    `choose the ChatGPT credential with --chatgpt-credential; granted: ${ids || "none"}`,
                );
            }
            chatgptId = (chatgpt[0] as ScopedRow).id;
        }
        if (!rows.some((row) => row.id === chatgptId))
            throw new CredentialError(`${chatgptId} is not granted to mc-e2e`);
        if (!rows.some((row) => row.id === options.antigravityCredential)) {
            throw new CredentialError(`${options.antigravityCredential} is not granted to mc-e2e`);
        }
        const fetch = async (credentialId: string) => {
            try {
                return await client.getScoped({
                    credentialId,
                    enrollmentToken: enrollment,
                    minTtlMs: options.minTtlMs,
                });
            } catch (error) {
                throw new CredentialError(
                    `the vault refused ${credentialId} (${(error as Error).message.slice(0, 200)})`,
                );
            }
        };
        const codex = await fetch(chatgptId);
        if (!codex.accountId)
            throw new CredentialError(
                `${chatgptId} was served without an account id; the Codex backend needs it`,
            );
        const cloud = await fetch(options.antigravityCredential);
        if (!cloud.projectId)
            throw new CredentialError(
                `${options.antigravityCredential} was served without a project id`,
            );
        const secrets = [codex.material, cloud.material, voyageKey];
        return {
            mode: "vault",
            codex: {
                token: codex.material,
                accountId: codex.accountId,
                credentialId: chatgptId,
                expiresAtMs: codex.expiresAtMs,
            },
            cloudCode: {
                token: cloud.material,
                project: cloud.projectId,
                credentialId: options.antigravityCredential,
                expiresAtMs: cloud.expiresAtMs,
            },
            voyageKey,
            secrets: () => secrets,
        };
    } finally {
        client.close();
    }
}

/** Replace every secret in captured text before it is saved. */
export function scrub(text: string, secrets: string[]): string {
    let out = text;
    for (const secret of secrets)
        if (secret.length >= 8) out = out.split(secret).join("[REDACTED]");
    return out;
}
