import { writeFileSync } from "node:fs";
import { runMigrations } from "../../../../features/magic-context/migrations";
import { createScheduler } from "../../../../features/magic-context/scheduler";
import { initializeDatabase } from "../../../../features/magic-context/storage-db";
import { loadHostRunnerRecord } from "../../../../features/magic-context/storage-host-runner";
import { getOrCreateSessionMeta } from "../../../../features/magic-context/storage-meta";
import { createTagger } from "../../../../features/magic-context/tagger";
import { Database } from "../../../../shared/sqlite";
import type { createRustModeTransform } from "../../rust-mode-transform";
import type { TransformDeps } from "../../transform";
import type { MessageLike } from "../../transform-operations";
import { createOpenCodeProviderTransform } from "../opencode-adapter";
import type { HookOutcome } from "../record";

const [dbPath, reportPath, host, mode] = process.argv.slice(2);
if (!dbPath || !reportPath || (host !== "v1" && host !== "v2"))
    throw new Error("Invalid fixture args");
const db = new Database(dbPath);
initializeDatabase(db);
runMigrations(db);
const meta = getOrCreateSessionMeta(db, "session");
const message = (id: string, role = "user"): MessageLike =>
    ({
        info: {
            id,
            role,
            sessionID: "session",
            model: { providerID: "openai", modelID: "gpt-5.6" },
        },
        parts: [{ id: `${id}-text`, type: "text", text: id }],
    }) as MessageLike;
const base = message("base");
const ops = message("ops");
const unavailable = message("unavailable", "assistant");
unavailable.parts.push({
    id: "tool-part",
    type: "tool",
    tool: "read",
    callID: "call",
    state: { status: "completed", input: {}, output: "result" },
} as MessageLike["parts"][number]);
const messages = [base, ops, unavailable];
const methods: string[] = [];
const observations: HookOutcome[] = [];
const deps: TransformDeps = {
    db,
    transformMode: "rust",
    rustPipeline: "provider",
    storeGeneration: host,
    tagger: createTagger(),
    scheduler: createScheduler({ executeThresholdPercentage: 90 }),
    contextUsageMap: new Map(),
    historyRefreshSessions: new Set(),
    pendingMaterializationSessions: new Set(),
    lastHeuristicsTurnId: new Map(),
    clearReasoningAge: 50,
    directory: "/fixture-project",
    rustModeModuleClient: {
        async call(args) {
            const wire =
                args.body instanceof Uint8Array
                    ? JSON.parse(new TextDecoder().decode(args.body))
                    : args.body;
            const { method, params: p } = wire as { method: string; params: Record<string, any> };
            methods.push(method);
            if (method === "transform.declare")
                return {
                    subscriptions: ["pre_user", "post_assistant", "post_tool"].map((hook) => ({
                        hook,
                        ops: ["prepend"],
                        budget_ms: 2000,
                        on_unavailable: "pass",
                    })),
                };
            if (method === "compaction.setup")
                return {
                    answer: "ready",
                    request_id: p.request_id,
                    initial: {
                        compaction_id: "initial",
                        version: 1,
                        range: { from: 0, to: 0 },
                        replacement: [],
                    },
                    call_when: { share: 0.9 },
                };
            if (method === "compaction.step")
                return {
                    answer: "compaction_message",
                    request_id: p.request_id,
                    compaction: {
                        compaction_id: "identity",
                        version: 2,
                        range: { from: 0, to: 0 },
                        replacement: [],
                    },
                };
            if (method === "transform.hook") {
                if (mode === "replay") throw new Error("Restart must not re-hook frozen subjects");
                if (p.hook === "post_tool") throw new Error("Fixture provider unavailable");
                return {
                    answer: "ops",
                    ops: p.blocks.map((_: string, block: number) => ({
                        op: "prepend",
                        block,
                        text: "FROZEN ",
                    })),
                };
            }
            throw new Error(`Unexpected method ${method}`);
        },
    },
};
const legacy = {
    getState: () => ({
        moduleGeneration: 0,
        lastAckedSeq: 0,
        lastAckedWatermarks: null,
        idOrdinalMemoGeneration: 0,
        idOrdinalMemo: new Map(),
        ordinalMemoCheckpoints: [],
    }),
} as unknown as ReturnType<typeof createRustModeTransform>;
const key = { session_id: "session", harness: host === "v1" ? "opencode" : "opencode2" };
const adapter = createOpenCodeProviderTransform(deps, legacy, {
    persisted: () => true,
    resolveOrdinals: async (args) => ({
        ok: true,
        annotatedInput: args.messages.map((m, i) => ({ ...m, absolute_ordinal: i + 1 })),
        memoGeneration: 0,
        memoAnchor: null,
        memoStoredCount: args.messages.length,
        memoCanonicalCount: args.messages.length,
        normalizations: [],
        stats: { mode: "memo", pages: 0, rowsRead: 0, rewinds: 0 },
    }),
    sync: async () => {},
    marker: async () => {},
    historian: { pump: async () => {}, stop: async () => {} },
    onOutcome: async (id, _subject, outcome) => {
        const entry = loadHostRunnerRecord(db, key)!.entries.find((e) => e.message_id === id)!;
        if (
            !JSON.parse(entry.hook_json).outcomes.some(
                (o: HookOutcome) => JSON.stringify(o) === JSON.stringify(outcome),
            )
        )
            throw new Error("Observed before commit");
        observations.push(outcome);
    },
});
const output = { messages: [] as unknown[] };
let recovered: unknown[] | undefined;
if (mode === "write") {
    await adapter.run("session", [base], output, meta);
} else {
    if (!adapter.recoverOutput("session", output)) throw new Error("Recovery failed");
    recovered = output.messages;
}
await adapter.run("session", messages, output, meta);
const record = loadHostRunnerRecord(db, key)!;
writeFileSync(
    reportPath,
    JSON.stringify({
        view: output.messages,
        recovered,
        methods,
        observations,
        hooks: record.entries.map((e) => ({ id: e.message_id, hook: JSON.parse(e.hook_json) })),
    }),
);
if (mode === "write") {
    setInterval(() => {}, 60_000);
    console.log("READY_TO_KILL");
} else {
    adapter.dispose();
    db.close();
}
