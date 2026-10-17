/** Disposable-store child of train-warm-pass-overhead.ts, not a user-store replay tool. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { spyOn } from "bun:test";
import { generateSyntheticFixture } from "../packages/pi-plugin/scripts/experiments/perf/fixtures";

const [source, host, mode] = process.argv.slice(2) as [string, string, string];
const root = process.env.TRAIN_OVERHEAD_ROOT;
assert(root && root.includes("/magic-context/oc2-overhead/"));
for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "OPENCODE_DB", "MAGIC_CONTEXT_STORAGE_DIR", "MAGIC_CONTEXT_TEST_DATA_DIR", "PI_CODING_AGENT_DIR"])
    assert(resolve(process.env[key] ?? "").startsWith(root), `${key} escaped disposable root`);
const project = process.env.TRAIN_OVERHEAD_PROJECT!;
mkdirSync(project, { recursive: true });
mkdirSync(join(root, "pi"), { recursive: true });
const load = (path: string) => import(join(source, path));
const core = "packages/plugin/src/";
let stages: Record<string, number> = {};
let spans: Record<string, number> = {};
let decisions: string[] = [];
let logLines: string[] = [];
const globalHooks = globalThis as typeof globalThis & {
    __trainOverheadStage?: (stage: string, elapsed: number) => void;
    __trainOverheadSpan?: (stage: string, elapsed: number) => void;
};
globalHooks.__trainOverheadStage = (name, ms) => { stages[name] = (stages[name] ?? 0) + ms; };
globalHooks.__trainOverheadSpan = (name, ms) => { spans[name] = (spans[name] ?? 0) + ms; };
// Initialize product modules only after HOME, XDG and database paths point to
// the disposable root; some modules resolve storage paths during import.
delete process.env.NODE_ENV;
const logger = await load(`${core}shared/logger.ts`);
process.env.NODE_ENV = "test";
logger.setLogLineForwarder((line: string) => {
    logLines.push(line);
    const decision = /transform(?: scheduler)?:.*decision=(defer|execute)/.exec(line)?.[1];
    if (decision) decisions.push(decision);
});
const { setHarness } = await load(`${core}shared/harness.ts`);
setHarness(host === "pi" ? "pi" : "opencode");
const { Database } = await load(`${core}shared/sqlite.ts`);
const { openDatabase, closeDatabase } = await load(`${core}features/magic-context/storage-db.ts`);
const db = openDatabase();
const { getOrCreateSessionMeta, updateSessionMeta } = await load(`${core}features/magic-context/storage-meta.ts`);
const { resolveProjectIdentityForSession } = await load(`${core}features/magic-context/memory/project-identity.ts`);
const { insertMemory } = await load(`${core}features/magic-context/memory/storage-memory.ts`);
const projectIdentity = resolveProjectIdentityForSession(project);
assert(projectIdentity, "synthetic project identity unavailable");
const sessionId = "train-overhead-synthetic";
const model = host === "opencode2"
    ? { providerID: "anthropic", modelID: "claude-opus-5-5" }
    : { providerID: "openai", modelID: "gpt-4.1" };
const window = 1_000_000;
const epoch = 1_792_000_000_000;
let passNumber = 0;
Date.now = () => epoch + passNumber * 1000;
getOrCreateSessionMeta(db, sessionId);
const fixture = generateSyntheticFixture({ messages: 240, systemEntry: true, toolResultRepeat: 180 });
// Pi uses a model without signed-thinking binding, so random edits are served
// rather than held to preserve a thinking signature. OpenCode 2 uses a model
// requiring the entire request in LKG, since its native payload has no per-message
// creation times with which the legacy partial-prefix capture finds an anchor.
const entries = fixture.entries.filter((e) => e.type === "message" && (e as any).message.role !== "system") as any[];
for (const entry of entries) {
    if (entry.message.role === "assistant") { entry.message.provider = model.providerID; entry.message.model = model.modelID; entry.message.api = "openai-completions"; }
}
const piRaw = entries.map((e) => e.message);
const raw: any[] = [];
for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const m = entry.message;
    if (m.role === "toolResult") continue;
    const id = entry.id;
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const parts = content.filter((p: any) => p.type !== "thinking").map((p: any, j: number) => {
        const base = { id: `${id}-p${j}`, messageID: id, sessionID: sessionId };
        if (p.type === "toolCall") {
            const result = entries[i + 1]?.message;
            assert.equal(result?.role, "toolResult");
            return { ...base, type: "tool", callID: p.id, tool: p.name, state: { status: "completed", input: p.arguments, output: result.content[0].text, title: "Synthetic read", metadata: {}, time: { start: epoch - 2000, end: epoch - 1000 } } };
        }
        return { ...base, ...p };
    });
    raw.push({ info: { id, sessionID: sessionId, role: m.role, time: { created: m.timestamp, completed: m.timestamp + 1 }, ...(m.role === "assistant" ? { ...model, finish: m.stopReason === "toolUse" ? "tool-calls" : "stop", tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } : { model }) }, parts });
}
let runRequest: () => Promise<unknown>;
let dispose: () => Promise<void> = async () => {};
let storeRaw = () => {};
let recoveryProbe: () => unknown = () => "not-probed";
const makeV2Draft = () => ({ sessionID: sessionId, agent: "build", model: { providerID: model.providerID, id: model.modelID, limit: { context: window } }, system: [], options: {}, tools: { read: { description: "Read fixture", input: { type: "object" } } }, messages: raw.map((m) => ({ id: m.info.id, role: m.info.role, content: structuredClone(m.parts) })) });
const usage = new Map();
const settle = () => {
    updateSessionMeta(db, sessionId, { lastResponseTime: Date.now(), lastContextPercentage: 20, lastInputTokens: 200_000 });
    usage.set(sessionId, { usage: { percentage: 20, inputTokens: 200_000 }, updatedAt: Date.now(), lastResponseTime: Date.now(), hasUsageTokens: true });
};
if (host === "pi") {
    const { registerPiContextHandler } = await load("packages/pi-plugin/src/context-handler.ts");
    const { setPiTransformTimingObserver } = await load("packages/pi-plugin/src/context-perf-hooks.ts");
    setPiTransformTimingObserver((sample: { stage: string; elapsedMs: number }) => { stages[sample.stage] = (stages[sample.stage] ?? 0) + sample.elapsedMs; });
    let handler: any;
    registerPiContextHandler({ getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }], on: (name: string, callback: any) => { if (name === "context") handler = callback; } }, {
        db, protectedTags: 10, scheduler: { executeThresholdPercentage: 95 },
        injection: { memoryEnabled: true, injectDocs: false, injectionBudgetTokens: 4000, temporalAwareness: false },
        heuristics: { caveman: { enabled: false, minChars: 2000 } },
    });
    assert(handler);
    runRequest = async () => {
        const event = { messages: structuredClone(piRaw) };
        const branch = entries.map((e, i) => ({ ...e, message: event.messages[i] }));
        const byId = new Map(branch.map((e) => [e.id, e]));
        const context = { cwd: project, hasUI: false, getSystemPrompt: () => "You are a synthetic coding agent.", signal: new AbortController().signal, ui: { notify() {} },
            model: { provider: model.providerID, id: model.modelID, contextWindow: window },
            sessionManager: { getSessionId: () => sessionId, getLeafId: () => branch.at(-1)?.id, getBranch: () => branch, getEntry: (id: string) => byId.get(id) },
            getContextUsage: () => ({ tokens: 200_000, percent: 20, contextWindow: window }),
        };
        // Constructing Pi's input message clone and branch lookup is host work,
        // not work inside the registered context handler being timed.
        const start = performance.now();
        const result = await handler(event, context);
        return { ms: performance.now() - start, wire: result?.messages ?? event.messages };
    };
} else {
    const store = new Database(process.env.OPENCODE_DB);
    if (host === "opencode1") {
        store.exec("CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)");
        storeRaw = () => store.transaction(() => {
            for (const m of raw) {
                store.prepare("INSERT OR REPLACE INTO message VALUES(?,?,?,?,?)").run(m.info.id, sessionId, m.info.time.created, m.info.time.created, JSON.stringify(m.info));
                for (const p of m.parts) store.prepare("INSERT OR REPLACE INTO part VALUES(?,?,?,?,?,?)").run(p.id, m.info.id, sessionId, m.info.time.created, m.info.time.created, JSON.stringify(p));
            }
        })();
        storeRaw();
        const { createTransform } = await load(`${core}hooks/magic-context/transform.ts`);
        const { createTagger } = await load(`${core}features/magic-context/tagger.ts`);
        const { createMessagesTransformHandler } = await load(`${core}plugin/messages-transform.ts`);
        const { refreshModelLimitsFromApi } = await load(`${core}shared/models-dev-cache.ts`);
        await refreshModelLimitsFromApi({ config: { providers: async () => ({ data: { providers: [{ id: model.providerID, models: { [model.modelID]: { limit: { context: window, output: 32000 } } } }] } }) } });
        const transform = createTransform({ db, tagger: createTagger(), storeGeneration: "v1", scheduler: { shouldExecute: () => "defer" }, contextUsageMap: usage,
            historyRefreshSessions: new Set(), pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 50, protectedTokens: 0, historianRunnable: false, channel1StateBySession: new Map(),
            liveModelBySession: new Map([[sessionId, model]]), directory: project, projectPath: projectIdentity,
            memoryConfig: { enabled: true, injectionBudgetTokens: 4000, autoPromote: false },
            autoSearch: { enabled: false, scoreThreshold: 0.6, minPromptChars: 20, directory: project },
        });
        const handler = createMessagesTransformHandler({ magicContext: { "experimental.chat.messages.transform": transform } });
        runRequest = async () => {
            const output = { messages: structuredClone(raw) };
            const start = performance.now();
            await handler({}, output);
            return { ms: performance.now() - start, wire: output.messages };
        };
    } else {
        store.exec("CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT NOT NULL)");
        const { MagicContextConfigSchema } = await load(`${core}config/schema/magic-context.ts`);
        const configModule = await load(`${core}config/index.ts`);
        const gateModule = await load(`${core}v2/hooks/storage-gate.ts`);
        const configSpy = spyOn(configModule, "loadPluginConfigDetailed").mockReturnValue({ config: MagicContextConfigSchema.parse({ historian: { disable: true }, dreamer: { disable: true, inject_docs: false }, memory: { enabled: true, auto_search: { enabled: false } }, temporal_awareness: false, compressor: { enabled: false }, scheduler: { execute_threshold_percentage: 95 } }) });
        const gateSpy = spyOn(gateModule, "createV2StorageGate").mockReturnValue({ current: () => db, probe: async () => db, require: () => db, reason: () => null });
        const { registerContext } = await load(`${core}v2/hooks/context.ts`);
        let handler: any;
        const context = { location: { directory: project }, agent: { transform: async () => {}, reload: async () => {} }, model: { list: () => [] }, storage: { get: async () => undefined, set: async () => {} }, event: { subscribe: async function* () {} }, tool: { hook: async () => {}, transform: async () => {} },
            session: { remove: async () => {}, compact: async () => {}, interrupt: async () => { throw Error("unexpected refusal"); }, wait: async () => {}, get: async () => ({ location: { directory: project } }), hook: async (name: string, callback: any) => { if (name === "context") handler = callback; } },
        };
        const duties = await registerContext(context);
        assert(handler);
        storeRaw = () => store.transaction(() => {
            for (const [i, m] of raw.entries()) store.prepare("INSERT OR REPLACE INTO session_message VALUES(?,?,?,?,?,?)").run(m.info.id, sessionId, m.info.role, i, m.info.time.created, JSON.stringify({ role: m.info.role, content: m.parts }));
        })();
        storeRaw();
        runRequest = async () => {
            const draft = makeV2Draft();
            const start = performance.now();
            await handler(draft);
            return { ms: performance.now() - start, wire: draft };
        };
        dispose = async () => { await duties?.dispose(); configSpy.mockRestore(); gateSpy.mockRestore(); };
    }
}

async function invoke(record: boolean) {
    settle();
    stages = {}; spans = {}; decisions = []; logLines = [];
    const result = await runRequest() as { ms: number; wire: unknown };
    const foregroundStages = { ...stages };
    const foregroundSpans = { ...spans };
    const foregroundDecisions = [...decisions];
    // Drain deferred LKG saves before the next request replaces their in-memory
    // capture. The measured result.ms covers only the host handler, not this
    // drain or the output hashing below.
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setImmediate(done));
    const meta = getOrCreateSessionMeta(db, sessionId);
    assert(!meta.lastTransformError, `failed-open ${host}: ${meta.lastTransformError}`);
    assert.equal(foregroundDecisions.length, 1, `${host} ${source} did not record exactly one decision: ${logLines.join("")}`);
    if (mode === "warm" && record) assert.equal(foregroundDecisions[0], "defer", `${host} measured a non-defer`);
    return { ms: result.ms, stages: foregroundStages, spans: foregroundSpans, wire: createHash("sha256").update(JSON.stringify(result.wire)).digest("hex"), decision: foregroundDecisions[0], recovery: JSON.stringify(recoveryProbe()) };
}
// Seed the history and memories before the first head render, then let the
// handler allocate tags before installing dropped statuses on eight of them.
db.transaction(() => {
    db.prepare("INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,p1,p2,p3,p4,created_at) VALUES(?,0,0,12,'Completed investigation',?,?,?,?,?,?)").run(sessionId, ...Array(5).fill("The earlier investigation established the parser contract and tests. ".repeat(20)), epoch);
    for (let i = 0; i < 8; i++) insertMemory(db, {
        projectPath: projectIdentity, category: "PROJECT_RULES", sourceType: "agent",
        content: `Project convention ${i}: preserve transaction boundaries and include regression coverage.`,
    });
})();
await invoke(false);
db.prepare("UPDATE tags SET status='dropped' WHERE session_id=? AND tag_number BETWEEN 5 AND 12").run(sessionId);
console.error(`${host} ${source}: initial tags installed`);
for (let i = 0; i < 60; i++) {
    await invoke(false);
}
console.error(`${host} ${source}: preheated`);
let rng = 0x49a7;
function random(n: number) { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng % n; }
function mutate() {
    const index = random(35) * 6;
    const entry = entries[index];
    assert(entry && entry.message.role === "user");
    const text = `Revision ${passNumber}: inspect module ${random(10000)} and preserve exact output ${"detail ".repeat(random(30))}`;
    entry.message.content = text;
    piRaw[index] = entry.message;
    const message = raw.find((m) => m.info.id === entry.id);
    assert(message);
    message.parts = [{ id: `${entry.id}-p0`, messageID: entry.id, sessionID: sessionId, type: "text", text }];
    if (passNumber % 11 === 0) db.prepare("UPDATE tags SET status=? WHERE session_id=? AND tag_number=?").run(random(2) ? "dropped" : "active", sessionId, 20 + random(80));
    if (passNumber % 17 === 0) insertMemory(db, {
        projectPath: projectIdentity, category: "PROJECT_RULES", sourceType: "agent",
        content: `Project convention ${random(8)} updated on request ${passNumber}: preserve exact request bytes.`,
    });
    storeRaw();
}
const { getInMemorySlot } = await load(`${core}hooks/magic-context/lkg-slot.ts`);
const warmSlot = getInMemorySlot(sessionId);
assert(warmSlot, `${host} preheat did not capture an LKG request`);
assert(warmSlot.jsonPrefix.includes("earlier investigation established"), `${host} served no persisted history head`);
assert(warmSlot.jsonPrefix.includes("Project convention"), `${host} served no persisted memories`);
const corpus = {
    inputMessages: host === "pi" ? piRaw.length : raw.length,
    inputBytes: Buffer.byteLength(JSON.stringify(host === "pi" ? piRaw : raw)),
    tags: db.prepare("SELECT count(*) AS n FROM tags WHERE session_id=?").get(sessionId).n,
    droppedTags: db.prepare("SELECT count(*) AS n FROM tags WHERE session_id=? AND status='dropped'").get(sessionId).n,
    compartments: db.prepare("SELECT count(*) AS n FROM compartments WHERE session_id=?").get(sessionId).n,
    memories: db.prepare("SELECT count(*) AS n FROM memories WHERE project_path=?").get(projectIdentity).n,
    lkgInputMessages: warmSlot.inputIdSeq.length,
    portableDigestCount: warmSlot.inputMoveDigests?.length ?? 0,
};
assert(corpus.tags > 0 && corpus.droppedTags > 0 && corpus.compartments === 1 && corpus.memories === 8);
console.log("OVERHEAD " + JSON.stringify({ ready: true, corpus }));
if (mode === "random") {
    const { captureSlot, dropSlot } = await load(`${core}hooks/magic-context/lkg-slot.ts`);
    const { replayLkg } = await load(`${core}hooks/magic-context/lkg-replay.ts`);
    const { lkgFenceRequiresRebuild } = await load(`${core}hooks/magic-context/lkg-recovery-fence.ts`);
    const { adaptPayload } = await load(`${core}v2/hooks/payload.ts`);
    const coordinator = host === "pi" ? (await load("packages/pi-plugin/src/pi-lkg.ts")).createPiLkgCoordinator(db) : undefined;
    const probeId = `${sessionId}-recovery-probe`;
    recoveryProbe = () => {
        const slot = getInMemorySlot(sessionId);
        assert(slot, "randomized handler did not retain its served capture");
        const restartRequiresRebuild = lkgFenceRequiresRebuild(sessionId, slot, false);
        const outcomes = ["unchanged", "edited", "model"].map((kind) => {
            assert(captureSlot(probeId, slot), "could not install isolated recovery probe");
            try {
                const messages = host === "pi" ? structuredClone(piRaw) : host === "opencode2" ? adaptPayload(makeV2Draft()).messages : structuredClone(raw);
                if (kind === "edited") {
                    if (host === "pi") messages[0].content = "same id, changed recovery input";
                    else messages[0].parts[0].text = "same id, changed recovery input";
                }
                const modelKey = kind === "model" ? `${model.providerID}/wrong-model` : slot.modelKey;
                const result = coordinator
                    ? coordinator.replay(coordinator.beginPass({ sessionId: probeId, messages, entryIds: entries.map((e) => e.id), modelKey, providerKey: slot.providerKey }))
                    : replayLkg({ sessionId: probeId, messages, modelKey, providerKey: slot.providerKey });
                if (kind === "unchanged") {
                    assert(result.ok || ["lkg_seam_invalid", "lkg_unsafe_seam", "lkg_anthropic_reasoning_run_invalid"].includes(result.reason), `${host} unchanged probe did not reach wire validation: ${result.reason}`);
                } else {
                    assert.equal(result.ok ? "replay" : result.reason, kind === "edited" ? "lkg_content_mismatch" : "lkg_model_mismatch", `${host} ${kind} recovery probe did not reach its intended validation`);
                }
                return result.ok ? { kind, decision: "replay", wire: createHash("sha256").update(JSON.stringify(result.messages)).digest("hex") } : { kind, decision: result.reason };
            } finally {
                // Rejection can drop a slot and its durable row; only the probe
                // session is installed or dropped, never the timed session.
                dropSlot(probeId, "probe-complete");
            }
        });
        return { restartRequiresRebuild, outcomes };
    };
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
    if (line === "quit") break;
    const count = Number(line);
    assert(Number.isSafeInteger(count) && count > 0);
    const results = [];
    for (let i = 0; i < count; i++) {
        passNumber++;
        if (mode === "random") mutate();
        results.push(await invoke(true));
    }
    const batch = join(root, "batch.json");
    writeFileSync(batch, JSON.stringify(results));
    console.log("OVERHEAD " + JSON.stringify({ batch }));
}
await dispose();
logger.flushLogger();
closeDatabase();
process.exit(0);
