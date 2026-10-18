/**
 * Throwaway OpenCode hosts for the BEAM harness.
 *
 * Every state root the host or Magic Context could touch (HOME, all XDG roots, OPENCODE_DB,
 * MAGIC_CONTEXT_STORAGE_DIR, TMPDIR) lives under one root below the harness data directory, and
 * `lsof -p <host pid>` must list only database files inside that root. Secrets never land in a
 * config file: `opencode.json` and `magic-context.jsonc` reference them as `{env:NAME}`, and the
 * values travel only in the child's environment.
 *
 * Each BEAM conversation gets its own work directory, a fresh git repository with one empty commit
 * whose metadata is derived from the conversation id. OpenCode and Magic Context both derive the
 * project from the repository's root commit, so conversations never share a project or a store.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_HOST_VERSION = "1.18.30";
export const REPO_ROOT = resolve(import.meta.dir, "../../../..");
export const PLUGIN_ENTRY = join(REPO_ROOT, "packages/plugin/dist/index.js");

/** The harness's data directory: `BEAM_DATA_DIR`, or `.runs/` beside this file (git-ignored). */
export function dataDir(): string {
    return resolve(process.env.BEAM_DATA_DIR ?? join(import.meta.dir, ".runs"));
}

/** Refuse any root outside the data directory, so a bad argument can never point at a live store. */
export function assertInsideDataDir(path: string): void {
    const base = dataDir();
    if (!resolve(path).startsWith(`${base}${sep}`)) throw new Error(`refusing a root outside ${base}: ${path}`);
}

export const ROOT_DIRS = ["home", "config", "data", "cache", "state", "runtime", "work", "tmp"] as const;
export type RootDir = (typeof ROOT_DIRS)[number];

export interface RootLayout {
    root: string;
    dirs: Record<RootDir, string>;
    opencodeDb: string;
    storageDir: string;
    contextDb: string;
    mcLog: string;
}

export function layout(root: string): RootLayout {
    const dirs = Object.fromEntries(ROOT_DIRS.map((key) => [key, join(root, key)])) as Record<RootDir, string>;
    const storageDir = join(dirs.data, "cortexkit", "magic-context");
    return {
        root,
        dirs,
        opencodeDb: join(dirs.data, "opencode", "opencode.db"),
        storageDir,
        contextDb: join(storageDir, "context.db"),
        mcLog: join(root, "mc.log"),
    };
}

/** The environment every process touching a root runs with; nothing inherits the operator's HOME. */
export function rootEnv(paths: RootLayout, extra: Record<string, string> = {}): Record<string, string> {
    return {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: paths.dirs.home,
        XDG_CONFIG_HOME: paths.dirs.config,
        XDG_DATA_HOME: paths.dirs.data,
        XDG_CACHE_HOME: paths.dirs.cache,
        XDG_STATE_HOME: paths.dirs.state,
        XDG_RUNTIME_DIR: paths.dirs.runtime,
        OPENCODE_CONFIG_DIR: paths.dirs.config,
        OPENCODE_DB: paths.opencodeDb,
        MAGIC_CONTEXT_STORAGE_DIR: paths.storageDir,
        MAGIC_CONTEXT_LOG_PATH: paths.mcLog,
        TMPDIR: paths.dirs.tmp,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        // The vault's local bus must stay out of reach of the host and the plugin.
        CLAUSTRUM_SUBC_CONNECTION: "/nonexistent/beam-harness.json",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...extra,
    };
}

export function createRoot(root: string): RootLayout {
    assertInsideDataDir(root);
    if (existsSync(root)) throw new Error(`root already exists: ${root}`);
    const paths = layout(root);
    for (const dir of Object.values(paths.dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    return paths;
}

export function removeRoot(root: string): void {
    assertInsideDataDir(root);
    rmSync(root, { recursive: true, force: true });
}

/**
 * Make the work directory a git repository with one empty commit. The commit's author, committer
 * and dates are fixed from the conversation id, so the project id is stable across restores and
 * distinct between conversations.
 */
export function initProjectRepo(paths: RootLayout, conversationId: string): string {
    const env = {
        ...rootEnv(paths),
        GIT_AUTHOR_NAME: "BEAM harness",
        GIT_AUTHOR_EMAIL: `beam-${conversationId}@invalid`,
        GIT_COMMITTER_NAME: "BEAM harness",
        GIT_COMMITTER_EMAIL: `beam-${conversationId}@invalid`,
        GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
    };
    const git = (args: string[]) => {
        const result = spawnSync("git", args, { cwd: paths.dirs.work, env, encoding: "utf8", windowsHide: true });
        if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
        return result.stdout.trim();
    };
    git(["init", "-q", "-b", "main"]);
    git(["commit", "-q", "--allow-empty", "-m", `BEAM conversation ${conversationId}`]);
    return git(["rev-list", "--max-parents=0", "HEAD"]);
}

export interface HostModels {
    /** Answer model id on the Codex backend, e.g. `gpt-6-luna`. */
    answerModel: string;
    answerContextLimit: number;
    answerOutputLimit: number;
    /** Responses `reasoning.effort`; omitted when undefined. */
    answerReasoningEffort?: string;
    /** Historian model id on Cloud Code Assist, e.g. `gemini-3.8-flash`. */
    historianModel: string;
    historianContextLimit: number;
    historianOutputLimit: number;
}

export interface HostWiring {
    /** Codex base URL the host posts `/responses` under. */
    codexBaseURL: string;
    /** Gemini base URL the host posts `/models/...` under (the relay). */
    geminiBaseURL: string;
    /** Voyage-compatible embeddings endpoint. */
    embeddingEndpoint: string;
    embeddingModel: string;
}

/** Names of the environment variables the configs reference; values are set only on the child. */
export const SECRET_ENV = {
    codexToken: "BEAM_CODEX_TOKEN",
    codexAccount: "BEAM_CODEX_ACCOUNT_ID",
    relayKey: "BEAM_RELAY_KEY",
    voyageKey: "BEAM_VOYAGE_KEY",
} as const;

export const ANSWER_PROVIDER = "openai";
export const HISTORIAN_PROVIDER = "google";

/**
 * The host's configuration. The answer model is OpenCode's own `openai` provider pointed at the
 * Codex backend with a static Bearer key and `chatgpt-account-id` header, and no stored login, so
 * OpenCode's ChatGPT login plugin stays inactive. The historian is OpenCode's `google` provider
 * pointed at the loopback relay.
 */
export function writeHostConfig(paths: RootLayout, models: HostModels, wiring: HostWiring, options: { dreamer: boolean }): void {
    const answer = `${ANSWER_PROVIDER}/${models.answerModel}`;
    const historian = `${HISTORIAN_PROVIDER}/${models.historianModel}`;
    const answerOptions: Record<string, unknown> = {};
    if (models.answerReasoningEffort) answerOptions.reasoningEffort = models.answerReasoningEffort;
    const config = {
        $schema: "https://opencode.ai/config.json",
        plugin: [pathToFileURL(PLUGIN_ENTRY).href],
        provider: {
            [ANSWER_PROVIDER]: {
                options: {
                    baseURL: wiring.codexBaseURL,
                    apiKey: `{env:${SECRET_ENV.codexToken}}`,
                    headers: { "chatgpt-account-id": `{env:${SECRET_ENV.codexAccount}}` },
                },
                models: {
                    [models.answerModel]: {
                        name: models.answerModel,
                        reasoning: true,
                        tool_call: true,
                        attachment: false,
                        temperature: true,
                        limit: { context: models.answerContextLimit, output: models.answerOutputLimit },
                        options: answerOptions,
                    },
                },
            },
            [HISTORIAN_PROVIDER]: {
                options: { baseURL: wiring.geminiBaseURL, apiKey: `{env:${SECRET_ENV.relayKey}}` },
                models: {
                    [models.historianModel]: {
                        name: models.historianModel,
                        reasoning: true,
                        tool_call: true,
                        attachment: false,
                        temperature: true,
                        limit: { context: models.historianContextLimit, output: models.historianOutputLimit },
                    },
                },
            },
        },
        enabled_providers: [ANSWER_PROVIDER, HISTORIAN_PROVIDER],
        model: answer,
        small_model: answer,
        autoupdate: false,
        share: "disabled",
        snapshot: false,
        compaction: { auto: false, prune: false },
        // The answer agent may use only Magic Context's two history tools.
        tools: { "*": false, ctx_search: true, ctx_expand: true },
        agent: { title: { disable: true }, summary: { disable: true } },
        permission: { bash: "deny", edit: "deny", webfetch: "deny", external_directory: "deny" },
    };
    writeFileSync(join(paths.dirs.config, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const magicContext = {
        historian: { opencode: { model: historian } },
        dreamer: { disable: !options.dreamer },
        embedding: {
            provider: "openai-compatible",
            endpoint: wiring.embeddingEndpoint,
            model: wiring.embeddingModel,
            api_key: `{env:${SECRET_ENV.voyageKey}}`,
            input_type: "document",
            query_input_type: "query",
            max_input_tokens: 8192,
        },
    };
    mkdirSync(join(paths.dirs.config, "cortexkit"), { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.dirs.config, "cortexkit", "magic-context.jsonc"), `${JSON.stringify(magicContext, null, 2)}\n`, {
        mode: 0o600,
    });
}

/** Database files `lsof` reports open for a process, each checked to be inside the root. */
export function databaseFilesFromLsof(out: string, root: string): string[] {
    const canonical = realpathSync(root);
    const rows = out.split("\n").filter((line) => /\sREG\s/.test(line) && /\.db(?:-wal|-shm|-journal)?\s*$/.test(line));
    const paths = rows.map((line) => line.split(/\s+/).slice(8).join(" "));
    if (paths.length === 0) throw new Error("isolation unproven: lsof showed no open database");
    const outside = paths.filter((path) => !path.startsWith(`${canonical}/`) && !path.startsWith(`${root}/`));
    if (outside.length > 0) throw new Error(`isolation failed: database open outside the root: ${outside.join(", ")}`);
    return [...new Set(paths.map((path) => path.replace(canonical, "<root>").replace(root, "<root>")))].sort();
}

export interface Host {
    url: string;
    pid: number;
    paths: RootLayout;
    log(): string;
    api(path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; value: unknown }>;
    /** Sample `lsof` for the host and its children; throws unless every open database is inside the root. */
    checkIsolation(): string[];
    stop(): Promise<void>;
}

function childPids(pid: number): number[] {
    const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", windowsHide: true });
    const direct = result.stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
    return direct.flatMap((child) => [child, ...childPids(child)]);
}

export async function startHost(paths: RootLayout, binary: string, secrets: Record<string, string>): Promise<Host> {
    const version = spawnSync(binary, ["--version"], { env: rootEnv(paths), encoding: "utf8", windowsHide: true }).stdout.trim();
    if (version !== EXPECTED_HOST_VERSION) throw new Error(`expected OpenCode ${EXPECTED_HOST_VERSION}, got ${version || "nothing"}`);
    const port = 24000 + Math.floor(Math.random() * 20000);
    const child: ChildProcess = spawn("nice", ["-n", "10", binary, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
        cwd: paths.dirs.work,
        env: rootEnv(paths, secrets),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    let logs = "";
    child.stdout?.on("data", (chunk) => (logs += chunk));
    child.stderr?.on("data", (chunk) => (logs += chunk));
    const url = `http://127.0.0.1:${port}`;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));

    const api = async (path: string, body?: unknown, timeoutMs = 120_000) => {
        const separator = path.includes("?") ? "&" : "?";
        const response = await fetch(`${url}${path}${separator}directory=${encodeURIComponent(paths.dirs.work)}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        let value: unknown = text;
        try {
            value = JSON.parse(text);
        } catch {
            // Plain text reply.
        }
        return { status: response.status, value };
    };

    const checkIsolation = () => {
        const pids = [child.pid as number, ...childPids(child.pid as number)];
        const sample = spawnSync("lsof", ["-p", pids.join(",")], { encoding: "utf8", windowsHide: true });
        if (sample.status !== 0 && !sample.stdout) throw new Error("lsof failed; isolation unproven");
        return databaseFilesFromLsof(sample.stdout, paths.root);
    };

    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            const done = await Promise.race([exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
            if (!done) {
                child.kill("SIGKILL");
                await exited;
            }
        }
    };

    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt++) {
        if (child.exitCode !== null) break;
        try {
            ready = (await fetch(`${url}/session?directory=${encodeURIComponent(paths.dirs.work)}`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
            // Not listening yet.
        }
        if (!ready) await Bun.sleep(250);
    }
    if (!ready) {
        await stop();
        throw new Error(`host did not start: ${logs.slice(-2000)}`);
    }
    return { url, pid: child.pid as number, paths, log: () => logs, api, checkIsolation, stop };
}

/** The parts of a root that hold state: the OpenCode and Magic Context stores and the project repo. */
const SNAPSHOT_DIRS: RootDir[] = ["data", "work"];

/** Copy a stopped root's state into `target` (which must not exist). */
export function snapshotRoot(paths: RootLayout, target: string): void {
    assertInsideDataDir(target);
    if (existsSync(target)) throw new Error(`snapshot already exists: ${target}`);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const dir of SNAPSHOT_DIRS) cpSync(paths.dirs[dir], join(target, dir), { recursive: true });
}

/** Recreate a root from a snapshot at exactly `root`, so stored absolute paths stay valid. */
export function restoreRoot(snapshot: string, root: string): RootLayout {
    removeRoot(root);
    const paths = createRoot(root);
    for (const dir of SNAPSHOT_DIRS) {
        rmSync(paths.dirs[dir], { recursive: true, force: true });
        cpSync(join(snapshot, dir), paths.dirs[dir], { recursive: true });
    }
    return paths;
}

export function readIfExists(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}
