import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "../../packages/plugin/src/shared/sqlite";
import { HOSTS, sampleSessions, assertRendered, assertTagContinuity, type Host, type TagIdentity } from "./upgrade-seats";
import type { MessageLike } from "../../packages/plugin/src/hooks/magic-context/tag-messages";
import type { SessionContext, V2Message } from "../../packages/plugin/src/v2/hooks/types";

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };

export async function sessionMessages(db: Database, session: string): Promise<{ source: string; messages: MessageLike[] }> {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='raw_archive_messages'").get()) {
        const rows = db.prepare("SELECT message_json FROM raw_archive_messages WHERE session_id=? ORDER BY message_ordinal").all(session) as {message_json: string}[];
        if (rows.length) return {source: "native raw archive", messages: rows.map((r) => { const message = JSON.parse(r.message_json); return {info: {id: message.id, role: message.role, sessionID: session, ...MODEL}, parts: message.parts}; })};
    }
    const { loadPersistedLkgSlot } = await import("../../packages/plugin/src/hooks/magic-context/lkg-persist");
    const slot = loadPersistedLkgSlot(db, session);
    if (slot) {
        const messages: unknown = JSON.parse(slot.jsonPrefix);
        if (Array.isArray(messages) && messages.length && messages.every((m) => m?.info?.id && Array.isArray(m.parts)))
            return { source: "persisted native LKG prefix", messages: messages as MessageLike[] };
    }
    const rows = db.prepare("SELECT message_id,role,content FROM message_history_fts WHERE session_id=? ORDER BY message_ordinal").all(session) as { message_id: string; role: string; content: string }[];
    if (!rows.length) throw new Error(`No stored transcript available for ${session}`);
    // The archive is formatted text, not a native tool transcript. Keep that distinction in the evidence.
    return { source: "archived text replay (native wire unavailable)", messages: rows.map((r) => ({ info: { id: r.message_id, role: r.role, sessionID: session, ...MODEL }, parts: [{type: "text", text: r.content}] })) };
}

function v2Payload(session: string, messages: MessageLike[]): SessionContext {
    const wire: V2Message[] = [];
    for (const message of messages) {
        const content: Record<string, unknown>[] = [], results: Record<string, unknown>[] = [];
        for (const item of message.parts) {
            const part = item as Record<string, any>;
            if (part.type === "tool") {
                content.push({ type: "tool-call", id: part.callID, name: part.tool, input: part.state?.input ?? {} });
                results.push({ type: "tool-result", id: part.callID, name: part.tool, result: { type: "text", value: part.state?.output ?? "" } });
            } else if (part.type !== "step-start" && part.type !== "step-finish") content.push({...part});
        }
        wire.push({ id: message.info.id, role: message.info.role ?? "user", content });
        if (results.length) wire.push({role: "tool", content: results});
    }
    return { sessionID: session, model: {providerID: MODEL.providerID, id: MODEL.modelID}, agent: "build", messages: wire, system: [], tools: {}, options: {} };
}

export async function runSessionPass(db: Database, directory: string, session: string, host: Host, input: MessageLike[]): Promise<{ messages: unknown[]; matched: number; marker: string | null }> {
    const messages = structuredClone(input);
    for (const message of messages) message.info = { ...message.info, sessionID: session, ...MODEL };
    messages.push({ info: {id: `rehearsal-followup-${session}`, role: "user", sessionID: session}, parts: [{type: "text", text: "Continue this stored session for the offline upgrade rehearsal."}] });
    let served: unknown[];
    let matched = 0, marker: string | null = null;
    if (host === "pi") {
        const { registerPiContextHandler, clearContextHandlerSession } = await import("../../packages/pi-plugin/src/context-handler");
        let handler: ((event: any, context: any) => Promise<any>) | undefined;
        const api = { on: (event: string, callback: typeof handler) => { if (event === "context") handler = callback; } };
        registerPiContextHandler(api as never, { db, protectedTags: 0, injection: { injectDocs: false, injectionBudgetTokens: 8000 } });
        const wire = v2Payload(session, messages).messages.map((m, i) => ({ role: m.role === "tool" ? "toolResult" : m.role, content: m.content, timestamp: i+1, provider: MODEL.providerID, model: MODEL.modelID, api: "anthropic-messages", stopReason: "stop", usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}} }));
        const ids = messages.map((m) => String(m.info.id));
        const branch = wire.map((message, i) => ({ type: "message", id: ids[i] ?? `rehearsal-tool-${i}`, message }));
        if (!handler) throw new Error("Pi did not register its production context handler");
        try {
            const result = await handler({messages: wire}, {cwd: directory, hasUI: false, signal: new AbortController().signal, ui: {notify() {}}, sessionManager: {getSessionId: () => session, getBranch: () => branch}, model: {provider: MODEL.providerID, id: MODEL.modelID, contextWindow: 200000}, getContextUsage: () => ({tokens: 0, percent: 0, contextWindow: 200000})});
            served = result?.messages ?? wire;
        } finally { clearContextHandlerSession(session); }
    } else {
        const { createTransform } = await import("../../packages/plugin/src/hooks/magic-context/transform");
        const { createTagger } = await import("../../packages/plugin/src/features/magic-context/tagger");
        const { adaptPayload } = await import("../../packages/plugin/src/v2/hooks/payload");
        const { readLegacyCkTagSnapshot, planLegacyCkImport, legacyCkTagImportMarkerKey } = await import("../../packages/plugin/src/hooks/magic-context/legacy-ck-tag-import");
        const draft = host === "opencode2" ? v2Payload(session, messages) : null;
        const adapter = draft ? adaptPayload(draft) : { messages };
        const snapshot = readLegacyCkTagSnapshot(join(directory, "store.db"), session, new Set(adapter.messages.map((m) => String(m.info.id))));
        const plan = snapshot ? planLegacyCkImport(adapter.messages, snapshot) : null;
        const transform = createTransform({ db, tagger: createTagger(), scheduler: {shouldExecute: () => "defer"}, liveModelBySession: new Map([[session, MODEL]]), contextUsageMap: new Map(), historyRefreshSessions: new Set(), pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(), directory, injectDocs: false, clearReasoningAge: 1000, protectedTokens: 4000, historianRunnable: false });
        await transform({}, adapter);
        if (draft) { (adapter as ReturnType<typeof adaptPayload>).commit(); served = draft.messages; } else served = adapter.messages;
        const recorded = db.prepare("SELECT value FROM schema_migrations_meta WHERE key=?").get(legacyCkTagImportMarkerKey(session)) as {value: string} | undefined;
        marker = recorded ? JSON.parse(recorded.value).status : null;
        if (snapshot && marker !== "typescript-newer") {
            const expected: TagIdentity[] = (plan?.tags ?? []).map((tag) => ({ number: tag.tagNumber, message: tag.identity.type === "message" ? tag.identity.messageId : tag.identity.callId, type: tag.identity.type, owner: tag.identity.type === "message" ? null : tag.identity.ownerMessageId }));
            const actual = db.prepare("SELECT tag_number AS number,message_id AS message,type,tool_owner_message_id AS owner FROM tags WHERE session_id=?").all(session) as TagIdentity[];
            assertTagContinuity(expected, actual, marker ?? "missing");
            matched = expected.length;
        }
    }
    const refusal = db.prepare("SELECT last_transform_error AS error FROM session_meta WHERE session_id=?").get(session) as {error: string | null} | undefined;
    assertRendered(host, served, true, refusal?.error);
    return {messages: served, matched, marker};
}

if (import.meta.main) {
    const [rootArg, hostArg, manifestPath, resultPath] = process.argv.slice(2);
    const root = resolve(rootArg);
    if (process.platform !== "linux" || !root.startsWith(join(process.env.TMPDIR!, "magic-context", "rehearsal-early") + "/"))
        throw new Error("Session replay requires an isolated Linux rehearsal root");
    process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
    process.env.OPENCODE_DB = join(root, "unused-opencode.db");
    const { setHarness } = await import("../../packages/plugin/src/shared/harness");
    setHarness(hostArg === "pi" ? "pi" : "opencode");
    const { openDatabase } = await import("../../packages/plugin/src/features/magic-context/storage-db");
    const db = openDatabase(join(root, "context.db"));
    if (!db) throw new Error("Production opener refused migrated session store");
    try {
        if (hostArg === "plan") {
            const seats = db.prepare("SELECT session_id AS session,SUM(length(CAST(content AS BLOB))) AS bytes FROM message_history_fts GROUP BY session_id ORDER BY session_id").all() as {session: string; bytes: number}[];
            const sample = sampleSessions(seats);
            const store = new Database(join(root, "store.db"), {readonly: true});
            const rust = store.prepare("SELECT DISTINCT session_id AS session FROM mc_tags ORDER BY session_id").all() as {session: string}[];
            store.close();
            writeFileSync(manifestPath, JSON.stringify({...sample, rust: rust.map((r) => r.session)}));
            console.log(`Selected ${sample.largest.length} largest + ${sample.random.length} random sessions; ${rust.length} sessions with Rust tags`);
        } else {
            if (!(HOSTS as readonly string[]).includes(hostArg)) throw new Error(`Unknown host ${hostArg}`);
            const host = hostArg as Host;
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReturnType<typeof sampleSessions> & {rust: string[]};
            const sampled = [...manifest.largest, ...manifest.random].map((s) => s.session);
            const sessions = [...new Set([...sampled, ...(host === "opencode1" ? manifest.rust : [])])];
            const results: Record<string, unknown>[] = [];
            for (const session of sessions) {
                try {
                    const {messages, source} = await sessionMessages(db, session);
                    const result = await runSessionPass(db, root, session, host, messages);
                    results.push({session, host, source, inputMessages: messages.length, outputMessages: result.messages.length, matched: result.matched, marker: result.marker, status: "passed"});
                } catch (error) { results.push({session, host, status: "failed", error: String(error)}); }
            }
            writeFileSync(resultPath, JSON.stringify(results, null, 2));
            console.log(`${host}: ${results.filter((r) => r.status === "passed").length}/${sessions.length} session passes; matched Rust tags ${results.reduce((n, r) => n + Number(r.matched ?? 0), 0)}`);
            if (results.some((r) => r.status !== "passed")) throw new Error(`${host}: session replay findings; see ${resultPath}`);
        }
    } finally { db.close(); }
}
