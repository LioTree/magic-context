#!/usr/bin/env bun
/**
 * BEAM long-term-memory benchmark against Magic Context, following the paper's released protocol.
 * See README.md beside this file for the commands, the protocol choices and their sources.
 *
 *   bun packages/plugin/scripts/beam/run.ts <command> [flags]
 *
 * Commands: prepare, verify-prompts (or --verify-prompts), list-credentials, smoke-transport,
 * vanilla, mc, summary.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildConversation, type Conversation, loadRows, type Question } from "./dataset";
import {
    ANSWER_PROVIDER,
    createRoot,
    dataDir,
    EXPECTED_HOST_VERSION,
    type Host,
    type HostModels,
    type HostWiring,
    initProjectRepo,
    PLUGIN_ENTRY,
    removeRoot,
    restoreRoot,
    type RootLayout,
    rootEnv,
    SECRET_ENV,
    snapshotRoot,
    startHost,
    writeHostConfig,
    readIfExists,
} from "./host";
import {
    addUsage,
    AuthRejectedError,
    type ChatMessage,
    type CodexSettings,
    codexComplete,
    emptyUsage,
    RateLimitedError,
    type Usage,
} from "./llm";
import { promptHashes, releasedPromptSet, verifyPrompts } from "./prompts";
import { type Relay, type RelayLogEntry, startRelay } from "./relay";
import { type JudgeCall, type QuestionScore, scoreQuestion, summarize } from "./scoring";
import { credentialRowCounts, writeSessionTurns } from "./store-writer";
import { type Stub, startStub } from "./stub";
import { CredentialError, type Credentials, listGranted, scrub, STUB_CREDENTIALS, stubCredentials, vaultCredentials } from "./credentials";
import type { BoundaryProbeResult } from "./boundary-probe";

/** The dataset revision every result is pinned to (Hugging Face `Mohammadta/BEAM`). */
export const DATASET = "Mohammadta/BEAM";
export const DATASET_REVISION = "3205395e897e7318c7b094ef4e6047b9b82dbb03";
const UPSTREAMS = {
    codex: "https://chatgpt.com/backend-api/codex",
    cloudCode: "https://cloudcode-pa.googleapis.com",
    voyage: "https://api.voyageai.com/v1",
};

/** Raised for conditions that end the run cleanly with a reason (budget, rejection, isolation). */
class StopRun extends Error {}

interface Settings {
    run: string;
    mode: "vault" | "stub";
    split: string;
    datasetRevision: string;
    conversations: string[];
    answerModel: string;
    historianModel: string;
    reasoningEffort?: string;
    temperature?: number;
    answerContextLimit: number;
    answerOutputLimit: number;
    historianContextLimit: number;
    historianOutputLimit: number;
    executeThresholdPercentage: number;
    dreamer: boolean;
    embeddingModel: string;
    promptSet: string;
    promptHashes: Record<string, string>;
    opencodeVersion: string;
    pluginDistSha256: string;
    maxInputTokensPerArm: number;
}

interface QuestionState {
    id: string;
    conversationId: string;
    category: string;
    question: string;
    /** The exact text of turn |T|+1. */
    questionTurn: string;
    answer?: string;
    toolCalls?: ToolCallRecord[];
    answerUsage?: Usage;
    historianUsage?: { calls: number; input: number; output: number };
    requestInputTokens?: number;
    isolation?: string[];
    score?: number;
    scoring?: QuestionScore;
    judgeUsage?: Usage;
    judgeCalls?: number;
    error?: string;
}

interface ToolCallRecord {
    tool: string;
    input: unknown;
    status: string;
    outputChars: number;
    outputTokensApprox: number;
}

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

function log(message: string): void {
    console.log(`[beam ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        "verify-prompts": { type: "boolean" },
        split: { type: "string", default: "100K" },
        conversations: { type: "string", default: "1,2,3,4,5" },
        run: { type: "string" },
        stub: { type: "boolean" },
        opencode: { type: "string" },
        "answer-model": { type: "string", default: "gpt-6-luna" },
        "historian-model": { type: "string", default: "gemini-3.8-flash" },
        "reasoning-effort": { type: "string", default: "none" },
        temperature: { type: "string", default: "0" },
        "answer-context-limit": { type: "string", default: "272000" },
        "answer-output-limit": { type: "string", default: "32000" },
        "historian-context-limit": { type: "string", default: "1048576" },
        "historian-output-limit": { type: "string", default: "65536" },
        "execute-threshold": { type: "string", default: "65" },
        "max-input-tokens": { type: "string", default: "30000000" },
        "chatgpt-credential": { type: "string" },
        "antigravity-credential": { type: "string", default: "antigravity:google" },
        "voyage-key-file": { type: "string", default: join(process.env.HOME ?? "", ".config", "voyage.key") },
        questions: { type: "string" },
        "stop-after": { type: "string" },
        "reject-codex-after": { type: "string" },
    },
});

function numberFlag(name: keyof typeof flags): number {
    const value = Number(flags[name]);
    if (!Number.isFinite(value)) throw new Error(`--${String(name)} must be a number`);
    return value;
}

function opencodeBinary(): string {
    const binary = (flags.opencode as string | undefined) ?? join(dataDir(), "host", `opencode-${EXPECTED_HOST_VERSION}`);
    if (!existsSync(binary)) {
        throw new Error(`OpenCode ${EXPECTED_HOST_VERSION} not found at ${binary}; copy the stock binary there or pass --opencode`);
    }
    return binary;
}

function datasetFile(split: string): string {
    return join(dataDir(), "dataset", `${split}-${DATASET_REVISION}.jsonl`);
}

async function loadConversations(split: string, ids: string[]): Promise<Conversation[]> {
    const file = datasetFile(split);
    if (!existsSync(file)) throw new Error(`dataset not prepared: ${file}; run the prepare command`);
    const rows = await loadRows(file);
    return ids.map((id) => {
        const row = rows.find((candidate) => candidate.conversation_id === id);
        if (!row) throw new Error(`conversation ${id} is not in the ${split} split`);
        return buildConversation(row);
    });
}

// --- Run setup -----------------------------------------------------------------------------

function runDir(settings: { run: string }): string {
    return join(dataDir(), "runs", settings.run);
}

async function buildSettings(): Promise<Settings> {
    const run = flags.run as string | undefined;
    if (!run || !/^[\w.-]+$/.test(run)) throw new Error("--run <name> is required (letters, digits, . _ -)");
    const temperatureText = flags.temperature as string;
    return {
        run,
        mode: flags.stub ? "stub" : "vault",
        split: flags.split as string,
        datasetRevision: DATASET_REVISION,
        conversations: (flags.conversations as string).split(",").map((id) => id.trim()).filter(Boolean),
        answerModel: flags["answer-model"] as string,
        historianModel: flags["historian-model"] as string,
        reasoningEffort: (flags["reasoning-effort"] as string) || undefined,
        temperature: temperatureText === "omit" ? undefined : Number(temperatureText),
        answerContextLimit: numberFlag("answer-context-limit"),
        answerOutputLimit: numberFlag("answer-output-limit"),
        historianContextLimit: numberFlag("historian-context-limit"),
        historianOutputLimit: numberFlag("historian-output-limit"),
        executeThresholdPercentage: numberFlag("execute-threshold"),
        dreamer: false,
        embeddingModel: "voyage-4",
        promptSet: releasedPromptSet.id,
        promptHashes: await promptHashes(),
        opencodeVersion: EXPECTED_HOST_VERSION,
        pluginDistSha256: sha256File(PLUGIN_ENTRY),
        maxInputTokensPerArm: numberFlag("max-input-tokens"),
    };
}

/** Pin the run's settings on first use; a resumed run must use the same ones. */
function pinSettings(settings: Settings): void {
    const path = join(runDir(settings), "settings.json");
    const saved = readJson<Settings>(path);
    if (!saved) {
        writeJsonAtomic(path, settings);
        return;
    }
    const differing = (Object.keys(settings) as (keyof Settings)[]).filter(
        (key) => JSON.stringify(saved[key]) !== JSON.stringify(settings[key]),
    );
    if (differing.length > 0) {
        throw new Error(`run ${settings.run} was started with different settings (${differing.join(", ")}); use a new --run`);
    }
}

interface Upstreams {
    credentials: Credentials;
    stub: Stub | null;
    relay: Relay;
    wiring: HostWiring;
    codex(settings: Settings): CodexSettings;
    stop(): void;
}

async function openUpstreams(settings: Settings): Promise<Upstreams> {
    const credentials =
        settings.mode === "stub"
            ? stubCredentials()
            : await vaultCredentials({
                  chatgptCredential: flags["chatgpt-credential"] as string | undefined,
                  antigravityCredential: flags["antigravity-credential"] as string,
                  voyageKeyFile: flags["voyage-key-file"] as string,
                  minTtlMs: 3_600_000,
              });
    const stub =
        settings.mode === "stub"
            ? startStub({
                  codexToken: STUB_CREDENTIALS.codexToken,
                  codexAccountId: STUB_CREDENTIALS.codexAccountId,
                  cloudCodeToken: STUB_CREDENTIALS.cloudCodeToken,
                  cloudCodeProject: STUB_CREDENTIALS.cloudCodeProject,
                  voyageKey: STUB_CREDENTIALS.voyageKey,
              })
            : null;
    const codexBase = stub ? `${stub.origin}/backend-api/codex` : UPSTREAMS.codex;
    const relay = startRelay({
        routes: [
            {
                kind: "cloud-code",
                prefix: "/gemini/v1beta",
                upstream: stub ? stub.origin : UPSTREAMS.cloudCode,
                token: () => credentials.cloudCode.token,
                project: credentials.cloudCode.project,
            },
        ],
    });
    return {
        credentials,
        stub,
        relay,
        wiring: {
            codexBaseURL: codexBase,
            geminiBaseURL: `${relay.origin}/gemini/v1beta`,
            embeddingEndpoint: stub ? `${stub.origin}/v1` : UPSTREAMS.voyage,
            embeddingModel: settings.embeddingModel,
        },
        codex: (s) => ({
            baseURL: codexBase,
            token: credentials.codex.token,
            accountId: credentials.codex.accountId,
            model: s.answerModel,
            reasoningEffort: s.reasoningEffort,
            temperature: s.temperature,
        }),
        stop() {
            relay.stop();
            stub?.stop();
        },
    };
}

/** The child environment that carries the secrets the host configs reference by name. */
function hostSecrets(upstreams: Upstreams): Record<string, string> {
    return {
        [SECRET_ENV.codexToken]: upstreams.credentials.codex.token,
        [SECRET_ENV.codexAccount]: upstreams.credentials.codex.accountId,
        [SECRET_ENV.relayKey]: upstreams.relay.hostKey,
        [SECRET_ENV.voyageKey]: upstreams.credentials.voyageKey,
    };
}

function hostModels(settings: Settings): HostModels {
    return {
        answerModel: settings.answerModel,
        answerContextLimit: settings.answerContextLimit,
        answerOutputLimit: settings.answerOutputLimit,
        answerReasoningEffort: settings.reasoningEffort,
        answerTemperature: settings.temperature,
        historianModel: settings.historianModel,
        historianContextLimit: settings.historianContextLimit,
        historianOutputLimit: settings.historianOutputLimit,
    };
}

/** Stop conditions shared by both arms: a rejected credential ends the run without retrying. */
function checkUpstreams(upstreams: Upstreams): void {
    if (upstreams.relay.authRejected) {
        throw new StopRun(`Cloud Code Assist rejected the credential (HTTP ${upstreams.relay.authRejected.status}); stopping without retry`);
    }
}

function judgeFor(upstreams: Upstreams, settings: Settings, usage: Usage, counter: { calls: number }): JudgeCall {
    return async (messages) => {
        const result = await codexComplete(upstreams.codex(settings), messages as ChatMessage[]);
        addUsage(usage, result.usage);
        counter.calls++;
        return result.text;
    };
}

/** Answer and judge input tokens already spent by an arm, and the projection for the whole arm. */
function armInputTokens(states: QuestionState[], extra = 0): number {
    return (
        extra +
        states.reduce(
            (sum, state) => sum + (state.answerUsage?.input ?? 0) + (state.judgeUsage?.input ?? 0) + (state.historianUsage?.input ?? 0),
            0,
        )
    );
}

function enforceBudget(settings: Settings, arm: string, states: QuestionState[], total: number, extra = 0): void {
    const spent = armInputTokens(states, extra);
    const done = states.filter((state) => state.scoring).length;
    if (spent > settings.maxInputTokensPerArm) {
        throw new StopRun(`${arm}: ${spent} input tokens spent, over the ${settings.maxInputTokensPerArm} limit`);
    }
    if (done >= 3) {
        const projected = extra + ((spent - extra) / done) * total;
        if (projected > settings.maxInputTokensPerArm) {
            throw new StopRun(`${arm}: projected ${Math.round(projected)} input tokens for ${total} questions, over the ${settings.maxInputTokensPerArm} limit`);
        }
    }
}

function questionFile(settings: Settings, arm: string, id: string): string {
    return join(runDir(settings), arm, "questions", `${id}.json`);
}

function loadStates(settings: Settings, arm: string): QuestionState[] {
    const dir = join(runDir(settings), arm, "questions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readJson<QuestionState>(join(dir, name)) as QuestionState);
}

function selectedQuestions(conversation: Conversation): Question[] {
    const only = (flags.questions as string | undefined)?.split(",").map((id) => id.trim());
    return only ? conversation.questions.filter((question) => only.includes(question.id)) : conversation.questions;
}

let processedThisInvocation = 0;
/** `--stop-after N` ends the process abruptly after N questions, to prove resumability. */
function maybeStopAfter(): void {
    processedThisInvocation++;
    const limit = flags["stop-after"] ? Number(flags["stop-after"]) : Number.POSITIVE_INFINITY;
    if (processedThisInvocation >= limit) {
        log(`--stop-after ${limit}: killing this process now (SIGKILL) to leave a half-finished run`);
        process.kill(process.pid, "SIGKILL");
    }
}

/** `--reject-codex-after N` makes the stub answer 401 after N questions, to prove stop-on-rejection. */
function maybeRejectCodex(upstreams: Upstreams): void {
    const after = flags["reject-codex-after"] ? Number(flags["reject-codex-after"]) : Number.POSITIVE_INFINITY;
    if (upstreams.stub && processedThisInvocation >= after) upstreams.stub.rejectCodex = true;
}

async function scoreState(state: QuestionState, question: Question, judge: JudgeCall, judgeUsage: Usage, counter: { calls: number }): Promise<void> {
    const scoring = await scoreQuestion(question, state.answer ?? "", judge, releasedPromptSet);
    state.scoring = scoring;
    state.score = scoring.score;
    state.judgeUsage = judgeUsage;
    state.judgeCalls = counter.calls;
}

// --- Vanilla arm ---------------------------------------------------------------------------

/**
 * The released code's long-context baseline: every turn as a chat message with its role and
 * content, then the question wrapper as one more user message, and no system message.
 */
async function runVanilla(settings: Settings, upstreams: Upstreams, conversations: Conversation[]): Promise<void> {
    const arm = "vanilla";
    const total = conversations.reduce((sum, conversation) => sum + selectedQuestions(conversation).length, 0);
    for (const conversation of conversations) {
        const history: ChatMessage[] = conversation.turns.map((turn) => ({ role: turn.role, content: turn.content }));
        for (const question of selectedQuestions(conversation)) {
            const path = questionFile(settings, arm, question.id);
            const state: QuestionState = readJson<QuestionState>(path) ?? {
                id: question.id,
                conversationId: conversation.id,
                category: question.category,
                question: question.text,
                questionTurn: await releasedPromptSet.questionTurn(question.text),
            };
            if (state.scoring) continue;
            enforceBudget(settings, arm, loadStates(settings, arm), total);
            maybeRejectCodex(upstreams);
            if (state.answer === undefined) {
                const result = await codexComplete(upstreams.codex(settings), [...history, { role: "user", content: state.questionTurn }]);
                state.answer = result.text;
                state.answerUsage = result.usage;
                state.toolCalls = [];
                writeJsonAtomic(path, state);
            }
            const judgeUsage = emptyUsage();
            const counter = { calls: 0 };
            await scoreState(state, question, judgeFor(upstreams, settings, judgeUsage, counter), judgeUsage, counter);
            writeJsonAtomic(path, state);
            log(`vanilla ${question.id}: score ${state.score?.toFixed(3)}`);
            maybeStopAfter();
        }
    }
}

// --- Magic Context arm ---------------------------------------------------------------------

interface IngestRecord {
    done: boolean;
    conversationId: string;
    sessionId: string;
    projectId: string;
    turns: number;
    lastTurnMessageId: string;
    probe: BoundaryProbeResult;
    ingestCommand: string;
    wrapupHttpStatus: number;
    stats: IngestStats;
    historian: { calls: number; input: number; output: number; failedCalls: number };
    isolation: string[][];
    credentialRows: Record<string, number>;
}

interface IngestStats {
    compartments: number;
    compartmentP1Chars: number;
    coveredThroughOrdinal: number;
    memories: number;
    userMemories: number;
    sessionFacts: number;
    memoryEmbeddings: number;
    opencodeMessages: number;
}

function pidFile(settings: Settings): string {
    return join(runDir(settings), "mc", "live-host.pid");
}

/** A killed harness can leave its host running; stop it before touching its root again. */
function killStaleHost(settings: Settings): void {
    const pid = Number(readIfExists(pidFile(settings)).trim());
    if (!pid) return;
    const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", windowsHide: true }).stdout;
    if (command.includes("opencode") && command.includes("serve")) {
        log(`stopping a host left by an earlier run (pid ${pid})`);
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
    rmSync(pidFile(settings), { force: true });
}

function appendIsolation(settings: Settings, label: string, files: string[]): void {
    const path = join(runDir(settings), "mc", "isolation.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), label, databases: files })}\n`, { flag: "a" });
}

async function withHost<T>(
    settings: Settings,
    upstreams: Upstreams,
    paths: RootLayout,
    label: string,
    work: (host: Host) => Promise<T>,
): Promise<{ value: T; isolation: string[][] }> {
    killStaleHost(settings);
    const host = await startHost(paths, opencodeBinary(), hostSecrets(upstreams));
    writeFileSync(pidFile(settings), String(host.pid));
    const isolation: string[][] = [];
    const sample = (when: string) => {
        const files = host.checkIsolation();
        appendIsolation(settings, `${label} ${when} pid=${host.pid}`, files);
        isolation.push(files);
    };
    try {
        sample("start");
        const value = await work(host);
        sample("end");
        return { value, isolation };
    } finally {
        const hostLog = scrub(host.log(), upstreams.credentials.secrets());
        writeFileSync(join(runDir(settings), "mc", "logs", `${label}.host.log`), hostLog);
        await host.stop();
        rmSync(pidFile(settings), { force: true });
        const mcLog = scrub(readIfExists(paths.mcLog), upstreams.credentials.secrets());
        writeFileSync(join(runDir(settings), "mc", "logs", `${label}.mc.log`), mcLog);
        const credentials = credentialRowCounts(paths.opencodeDb);
        if (Object.values(credentials).some((count) => count > 0)) {
            throw new StopRun(`the throwaway OpenCode store holds credential rows ${JSON.stringify(credentials)}`);
        }
    }
}

function relayUsage(entries: RelayLogEntry[]): { calls: number; input: number; output: number; failedCalls: number } {
    return {
        calls: entries.length,
        input: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
        output: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
        failedCalls: entries.filter((entry) => entry.status !== 200).length,
    };
}

function runBoundaryProbe(paths: RootLayout, sessionId: string, settings: Settings): BoundaryProbeResult {
    const scratchRoot = `${paths.root}-probe`;
    const scratch = restoreRoot(paths.root, scratchRoot);
    try {
        const result = spawnSync(
            process.execPath,
            [join(import.meta.dir, "boundary-probe.ts"), sessionId, String(settings.answerContextLimit), String(settings.executeThresholdPercentage)],
            { cwd: scratch.dirs.work, env: rootEnv(scratch), encoding: "utf8", windowsHide: true, timeout: 300_000 },
        );
        const line = result.stdout.trim().split("\n").at(-1) ?? "";
        if (result.status !== 0 || !line.startsWith("{")) {
            throw new Error(`boundary probe failed (${result.status}): ${result.stderr.slice(-1500)}`);
        }
        return JSON.parse(line) as BoundaryProbeResult;
    } finally {
        removeRoot(scratchRoot);
    }
}

function ingestStats(paths: RootLayout, sessionId: string): IngestStats {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const context = new Database(paths.contextDb, { readonly: true });
    const opencode = new Database(paths.opencodeDb, { readonly: true });
    try {
        const one = (db: InstanceType<typeof Database>, sql: string, ...args: string[]) =>
            Number((db.query(sql).get(...args) as { n: number | null } | null)?.n ?? 0);
        return {
            compartments: one(context, "SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?", sessionId),
            compartmentP1Chars: one(context, "SELECT SUM(LENGTH(COALESCE(p1, content))) AS n FROM compartments WHERE session_id = ?", sessionId),
            coveredThroughOrdinal: one(context, "SELECT MAX(end_message) AS n FROM compartments WHERE session_id = ?", sessionId),
            memories: one(context, "SELECT COUNT(*) AS n FROM memories WHERE status = 'active'"),
            userMemories: one(context, "SELECT COUNT(*) AS n FROM user_memories"),
            sessionFacts: one(context, "SELECT COUNT(*) AS n FROM session_facts"),
            memoryEmbeddings: one(context, "SELECT COUNT(*) AS n FROM memory_embeddings"),
            opencodeMessages: one(opencode, "SELECT COUNT(*) AS n FROM message WHERE session_id = ?", sessionId),
        };
    } finally {
        context.close();
        opencode.close();
    }
}

function liveRoot(settings: Settings, conversation: Conversation): string {
    return join(dataDir(), "roots", settings.run, `c${conversation.id}`);
}

function snapshotDir(settings: Settings, conversation: Conversation): string {
    return join(runDir(settings), "mc", "snapshots", `c${conversation.id}`);
}

/**
 * Ingest one conversation: the real host creates the project and an empty session, the turns are
 * written while it is stopped, the production protected-tail boundary sizes the raw tail, and the
 * real host runs `/ctx-wrapup N` (the incremental historian with fact extraction) over the rest.
 */
async function ingestConversation(settings: Settings, upstreams: Upstreams, conversation: Conversation): Promise<IngestRecord> {
    const path = join(runDir(settings), "mc", "ingest", `c${conversation.id}.json`);
    const saved = readJson<IngestRecord>(path);
    if (saved?.done && existsSync(snapshotDir(settings, conversation))) return saved;

    killStaleHost(settings);
    removeRoot(liveRoot(settings, conversation));
    rmSync(snapshotDir(settings, conversation), { recursive: true, force: true });
    const paths = createRoot(liveRoot(settings, conversation));
    const projectId = initProjectRepo(paths, `${settings.split}-${conversation.id}`);
    writeHostConfig(paths, hostModels(settings), upstreams.wiring, { dreamer: settings.dreamer });
    const isolation: string[][] = [];

    const created = await withHost(settings, upstreams, paths, `c${conversation.id}-create`, async (host) => {
        const response = await host.api("/session", { title: `BEAM ${settings.split} conversation ${conversation.id}` });
        if (response.status !== 200) throw new Error(`session create failed: HTTP ${response.status}`);
        return response.value as { id: string; projectID: string };
    });
    isolation.push(...created.isolation);
    if (created.value.projectID !== projectId) throw new Error(`host project ${created.value.projectID} is not the repo root commit ${projectId}`);
    const sessionId = created.value.id;

    const written = writeSessionTurns({
        dbPath: paths.opencodeDb,
        sessionId,
        directory: paths.dirs.work,
        providerID: ANSWER_PROVIDER,
        modelID: settings.answerModel,
        turns: conversation.turns,
    });
    const probe = runBoundaryProbe(paths, sessionId, settings);
    log(`c${conversation.id}: ${conversation.turns.length} turns, ${probe.sessionTokens} tokens; protected tail keeps ${probe.messagesToKeep} messages (${probe.tailTokens} tokens)`);

    const ingestCommand = `/ctx-wrapup ${probe.messagesToKeep}`;
    const relayStart = upstreams.relay.log.length;
    const wrapup = await withHost(settings, upstreams, paths, `c${conversation.id}-wrapup`, async (host) => {
        const response = await host.api(
            `/session/${sessionId}/command`,
            { command: "ctx-wrapup", arguments: String(probe.messagesToKeep) },
            4 * 60 * 60_000,
        );
        return response.status;
    });
    isolation.push(...wrapup.isolation);
    checkUpstreams(upstreams);
    const stats = ingestStats(paths, sessionId);
    if (stats.compartments === 0) {
        throw new StopRun(`c${conversation.id}: ${ingestCommand} produced no compartments (HTTP ${wrapup.value}); see mc/logs/c${conversation.id}-wrapup.mc.log`);
    }
    snapshotRoot(paths, snapshotDir(settings, conversation));
    const record: IngestRecord = {
        done: true,
        conversationId: conversation.id,
        sessionId,
        projectId,
        turns: conversation.turns.length,
        lastTurnMessageId: written.lastMessageId,
        probe,
        ingestCommand,
        wrapupHttpStatus: wrapup.value,
        stats,
        historian: relayUsage(upstreams.relay.log.slice(relayStart)),
        isolation,
        credentialRows: credentialRowCounts(paths.opencodeDb),
    };
    writeJsonAtomic(path, record);
    log(`c${conversation.id}: ${stats.compartments} compartments, ${stats.memories} memories, historian ${record.historian.calls} calls`);
    return record;
}

interface ApiMessage {
    info: { id: string; role: string; error?: unknown; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number } } };
    parts: { type: string; text?: string; tool?: string; synthetic?: boolean; ignored?: boolean; state?: { status?: string; input?: unknown; output?: unknown } }[];
}

/** What the host did after the question: the final answer, every tool call and the usage. */
export function readAnswer(
    messages: ApiMessage[],
    questionTurn: string,
): { answer: string; toolCalls: ToolCallRecord[]; usage: Usage; requestInputTokens: number; error?: string } {
    let start = -1;
    messages.forEach((message, index) => {
        if (message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.text === questionTurn)) start = index;
    });
    if (start < 0) throw new Error("the question message is not in the session");
    const after = messages.slice(start + 1).filter((message) => message.info.role === "assistant");
    const toolCalls: ToolCallRecord[] = [];
    const usage = emptyUsage();
    for (const message of after) {
        const tokens = message.info.tokens ?? {};
        addUsage(usage, { input: (tokens.input ?? 0) + (tokens.cache?.read ?? 0), cachedInput: tokens.cache?.read ?? 0, output: tokens.output ?? 0, reasoning: tokens.reasoning ?? 0 });
        for (const part of message.parts) {
            if (part.type !== "tool") continue;
            const output = typeof part.state?.output === "string" ? part.state.output : JSON.stringify(part.state?.output ?? "");
            toolCalls.push({ tool: part.tool ?? "", input: part.state?.input, status: part.state?.status ?? "", outputChars: output.length, outputTokensApprox: Math.ceil(output.length / 4) });
        }
    }
    const final = [...after].reverse().find((message) => message.parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored));
    const answer = (final?.parts ?? [])
        .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text ?? "")
        .join("");
    const first = after[0]?.info.tokens;
    const failed = after.find((message) => message.info.error);
    return {
        answer,
        toolCalls,
        usage,
        requestInputTokens: (first?.input ?? 0) + (first?.cache?.read ?? 0),
        ...(failed ? { error: JSON.stringify(failed.info.error) } : {}),
    };
}

async function runMagicContext(settings: Settings, upstreams: Upstreams, conversations: Conversation[]): Promise<void> {
    const arm = "mc";
    mkdirSync(join(runDir(settings), "mc", "logs"), { recursive: true });
    const total = conversations.reduce((sum, conversation) => sum + selectedQuestions(conversation).length, 0);
    const ingests: IngestRecord[] = [];
    const ingestTokens = () => ingests.reduce((sum, record) => sum + record.historian.input, 0);
    for (const conversation of conversations) {
        const ingest = await ingestConversation(settings, upstreams, conversation);
        ingests.push(ingest);
        enforceBudget(settings, arm, loadStates(settings, arm), total, ingestTokens());
        for (const question of selectedQuestions(conversation)) {
            const path = questionFile(settings, arm, question.id);
            const state: QuestionState = readJson<QuestionState>(path) ?? {
                id: question.id,
                conversationId: conversation.id,
                category: question.category,
                question: question.text,
                questionTurn: await releasedPromptSet.questionTurn(question.text),
            };
            if (state.scoring) continue;
            enforceBudget(settings, arm, loadStates(settings, arm), total, ingestTokens());
            maybeRejectCodex(upstreams);
            if (state.answer === undefined) {
                killStaleHost(settings);
                // Every question starts from its own fresh copy of the post-ingest stores.
                const paths = restoreRoot(snapshotDir(settings, conversation), liveRoot(settings, conversation));
                writeHostConfig(paths, hostModels(settings), upstreams.wiring, { dreamer: settings.dreamer });
                const relayStart = upstreams.relay.log.length;
                const asked = await withHost(settings, upstreams, paths, `c${conversation.id}-${question.id}`, async (host) => {
                    const response = await host.api(
                        `/session/${ingest.sessionId}/message`,
                        { model: { providerID: ANSWER_PROVIDER, modelID: settings.answerModel }, agent: "build", parts: [{ type: "text", text: state.questionTurn }] },
                        30 * 60_000,
                    );
                    if (response.status !== 200) {
                        throw new Error(`question failed: HTTP ${response.status} ${scrub(JSON.stringify(response.value), upstreams.credentials.secrets()).slice(0, 500)}`);
                    }
                    const messages = await host.api(`/session/${ingest.sessionId}/message`);
                    return readAnswer(messages.value as ApiMessage[], state.questionTurn);
                });
                checkUpstreams(upstreams);
                const info = asked.value;
                if (info.error) {
                    if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(info.error)) {
                        throw new StopRun(`Codex backend rejected the credential during ${question.id}; stopping without retry`);
                    }
                    throw new Error(`the host's answer model failed on ${question.id}: ${scrub(info.error, upstreams.credentials.secrets()).slice(0, 500)}`);
                }
                state.answer = info.answer;
                state.toolCalls = info.toolCalls;
                state.answerUsage = info.usage;
                state.requestInputTokens = info.requestInputTokens;
                state.historianUsage = relayUsage(upstreams.relay.log.slice(relayStart));
                state.isolation = asked.isolation.flat();
                writeJsonAtomic(path, state);
            }
            const judgeUsage = emptyUsage();
            const counter = { calls: 0 };
            await scoreState(state, question, judgeFor(upstreams, settings, judgeUsage, counter), judgeUsage, counter);
            writeJsonAtomic(path, state);
            log(`mc ${question.id}: score ${state.score?.toFixed(3)}, ${state.toolCalls?.length ?? 0} tool calls`);
            maybeStopAfter();
        }
    }
    for (const conversation of conversations) removeRoot(liveRoot(settings, conversation));
}

// --- Summary, smoke test, preparation ------------------------------------------------------

/** The paper's Table 1 row for GPT-4.1-nano at 100K (Vanilla, RAG, LIGHT), for reference only. */
export const PAPER_TABLE1_NANO_100K = { vanilla: 0.239, rag: 0.309, light: 0.345 };

function summarizeRun(settings: Settings): Record<string, unknown> {
    const out: Record<string, unknown> = { run: settings.run, settings };
    for (const arm of ["vanilla", "mc"]) {
        const states = loadStates(settings, arm).filter((state) => state.scoring);
        if (states.length === 0) continue;
        const usage = { answer: emptyUsage(), judge: emptyUsage(), historian: { calls: 0, input: 0, output: 0 } };
        for (const state of states) {
            addUsage(usage.answer, state.answerUsage ?? emptyUsage());
            addUsage(usage.judge, state.judgeUsage ?? emptyUsage());
            usage.historian.calls += state.historianUsage?.calls ?? 0;
            usage.historian.input += state.historianUsage?.input ?? 0;
            usage.historian.output += state.historianUsage?.output ?? 0;
        }
        const ingest =
            arm === "mc"
                ? settings.conversations
                      .map((id) => readJson<IngestRecord>(join(runDir(settings), "mc", "ingest", `c${id}.json`)))
                      .filter((record): record is IngestRecord => record !== null)
                : [];
        for (const record of ingest) {
            usage.historian.calls += record.historian.calls;
            usage.historian.input += record.historian.input;
            usage.historian.output += record.historian.output;
        }
        out[arm] = {
            ...summarize(states.map((state) => ({ category: state.category, score: state.score ?? 0 }))),
            usage,
            totalInputTokens: usage.answer.input + usage.judge.input + usage.historian.input,
            totalOutputTokens: usage.answer.output + usage.judge.output + usage.historian.output,
            toolCalls: states.reduce((sum, state) => sum + (state.toolCalls?.length ?? 0), 0),
            ingest: ingest.map((record) => ({
                conversation: record.conversationId,
                turns: record.turns,
                sessionTokens: record.probe.sessionTokens,
                messagesKeptRaw: record.probe.messagesToKeep,
                tailTokens: record.probe.tailTokens,
                command: record.ingestCommand,
                ...record.stats,
                historian: record.historian,
            })),
        };
    }
    if (upstreamsForSummary?.stub) out.stubRequests = upstreamsForSummary.stub.records.length;
    writeJsonAtomic(join(runDir(settings), "summary.json"), out);
    return out;
}
let upstreamsForSummary: Upstreams | null = null;

function printSummary(summary: Record<string, unknown>): void {
    for (const arm of ["vanilla", "mc"]) {
        const value = summary[arm] as (ReturnType<typeof summarize> & { totalInputTokens: number; totalOutputTokens: number; toolCalls: number }) | undefined;
        if (!value) continue;
        console.log(`\n${arm}: ${value.questions} questions, mean ${value.mean.toFixed(3)}  (paper GPT-4.1-nano 100K: Vanilla ${PAPER_TABLE1_NANO_100K.vanilla}, RAG ${PAPER_TABLE1_NANO_100K.rag}, LIGHT ${PAPER_TABLE1_NANO_100K.light})`);
        for (const [category, row] of Object.entries(value.byCategory)) console.log(`  ${category.padEnd(26)} ${row.mean.toFixed(3)}  (n=${row.questions})`);
        console.log(`  input tokens ${value.totalInputTokens}, output tokens ${value.totalOutputTokens}, tool calls ${value.toolCalls}`);
    }
}

/** Send one tiny request through each transport path and print only status, model and token counts. */
async function smokeTransport(settings: Settings, upstreams: Upstreams): Promise<number> {
    let failures = 0;
    try {
        const result = await codexComplete(upstreams.codex(settings), [{ role: "user", content: "Reply with the single word: ok" }], 120_000);
        console.log(`codex direct: ok model=${settings.answerModel} input=${result.usage.input} output=${result.usage.output} reasoning=${result.usage.reasoning}`);
    } catch (error) {
        failures++;
        console.log(`codex direct: FAILED ${scrub(String((error as Error).message), upstreams.credentials.secrets()).slice(0, 400)}`);
    }
    const response = await fetch(`${upstreams.wiring.geminiBaseURL}/models/${settings.historianModel}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": upstreams.relay.hostKey },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }] }),
    });
    const text = await response.text();
    let usage = "";
    try {
        const parsed = JSON.parse(text) as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }; modelVersion?: string };
        usage = `model=${parsed.modelVersion ?? settings.historianModel} input=${parsed.usageMetadata?.promptTokenCount} output=${parsed.usageMetadata?.candidatesTokenCount}`;
    } catch {
        usage = scrub(text, upstreams.credentials.secrets()).slice(0, 400);
    }
    if (!response.ok) failures++;
    console.log(`gemini via relay: ${response.ok ? "ok" : `FAILED HTTP ${response.status}`} ${usage}`);
    const voyage = await fetch(`${upstreams.wiring.embeddingEndpoint}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${upstreams.credentials.voyageKey}` },
        body: JSON.stringify({ model: settings.embeddingModel, input: ["ok"], input_type: "query" }),
    });
    if (!voyage.ok) failures++;
    console.log(`voyage embeddings: ${voyage.ok ? "ok" : `FAILED HTTP ${voyage.status}`}`);
    return failures;
}

async function prepare(split: string): Promise<void> {
    const dir = join(dataDir(), "dataset");
    mkdirSync(dir, { recursive: true });
    const parquet = join(dir, `${split}-${DATASET_REVISION}.parquet`);
    if (!existsSync(parquet)) {
        const url = `https://huggingface.co/datasets/${DATASET}/resolve/${DATASET_REVISION}/data/${split}-00000-of-00001.parquet`;
        log(`downloading ${url}`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        writeFileSync(parquet, new Uint8Array(await response.arrayBuffer()));
    }
    const venv = join(dataDir(), "venv");
    const python = join(venv, "bin", "python");
    const run = (command: string, args: string[]) => {
        const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
        if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
    };
    if (!existsSync(python)) run("python3", ["-m", "venv", venv]);
    if (spawnSync(python, ["-c", "import pyarrow"], { windowsHide: true }).status !== 0) run(python, ["-m", "pip", "install", "-q", "pyarrow"]);
    run(python, [join(import.meta.dir, "parquet_to_jsonl.py"), parquet, datasetFile(split)]);
}

async function main(): Promise<number> {
    if (flags["verify-prompts"] || positionals[0] === "verify-prompts") {
        for (const line of await verifyPrompts(dataDir())) console.log(line);
        return 0;
    }
    const command = positionals[0];
    if (command === "prepare") {
        await prepare(flags.split as string);
        return 0;
    }
    if (command === "list-credentials") {
        for (const row of await listGranted()) console.log(`${row.id}  state=${row.state}  categories=${row.categories.join(",")}  adapter=${row.refreshAdapter ?? "-"}`);
        return 0;
    }
    if (!["smoke-transport", "vanilla", "mc", "summary"].includes(command ?? "")) {
        console.error("usage: run.ts prepare|verify-prompts|list-credentials|smoke-transport|vanilla|mc|summary --run <name> [--stub] [flags]");
        return 2;
    }
    const settings = await buildSettings();
    if (command === "summary") {
        printSummary(summarizeRun(settings));
        return 0;
    }
    if (command !== "smoke-transport") pinSettings(settings);
    const upstreams = await openUpstreams(settings);
    upstreamsForSummary = upstreams;
    const stopSignal = () => {
        upstreams.stop();
        process.exit(130);
    };
    process.once("SIGINT", stopSignal);
    process.once("SIGTERM", stopSignal);
    try {
        if (command === "smoke-transport") return (await smokeTransport(settings, upstreams)) === 0 ? 0 : 1;
        const conversations = await loadConversations(settings.split, settings.conversations);
        if (command === "vanilla") await runVanilla(settings, upstreams, conversations);
        else await runMagicContext(settings, upstreams, conversations);
        const summary = summarizeRun(settings);
        printSummary(summary);
        return 0;
    } catch (error) {
        if (error instanceof StopRun || error instanceof AuthRejectedError || error instanceof RateLimitedError || error instanceof CredentialError) {
            const reason = scrub((error as Error).message, upstreams.credentials.secrets());
            writeJsonAtomic(join(runDir(settings), `stopped-${command}.json`), { at: new Date().toISOString(), reason });
            console.error(`stopped: ${reason}`);
            return 3;
        }
        throw error;
    } finally {
        if (upstreams.stub) {
            // Stub records hold fake credentials only as match flags, never values.
            writeJsonAtomic(join(runDir(settings), `stub-records-${command}-${process.pid}.json`), upstreams.stub.records);
        }
        writeJsonAtomic(join(runDir(settings), `relay-log-${command}-${process.pid}.json`), upstreams.relay.log);
        upstreams.stop();
    }
}

if (import.meta.main) {
    main()
        .then((code) => process.exit(code))
        .catch((error: unknown) => {
            if (error instanceof CredentialError) {
                console.error(`credential problem: ${error.message}`);
                process.exit(4);
            }
            console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
            process.exit(1);
        });
}

