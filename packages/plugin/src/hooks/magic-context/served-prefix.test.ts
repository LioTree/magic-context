import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    clearCachedM0M1,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { addRemovedReasoningIds } from "../../features/magic-context/storage-reasoning-removal";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { servedMessageDigest } from "./__tests__/served-prefix-evidence";
import { DegradedPassRefusalError } from "./degraded-pass-refusal";
import { clearInjectionCache } from "./inject-compartments";
import {
    type PrefixProvenance,
    prefixRecordProblem,
    readServedPrefix,
    replayServedPrefix,
    validateServedPrefix,
    writeServedPrefix,
} from "./served-prefix";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const message = (id: string, role = "user", text = id): MessageLike => ({
    info: { id, role, sessionID: "prefix" },
    parts: [{ type: "text", text }],
});
const reasoning = (signature: string) => ({
    type: "reasoning",
    text: `Thought ${signature}`,
    metadata: { anthropic: { signature } },
});
const provenance: PrefixProvenance = {
    host: "opencode-v1",
    id_space: "opencode-v1-message",
    generation: "v1",
    projection: "messages",
};

function database(path = ":memory:") {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, "prefix");
    cleanups.push(() => {
        try {
            db.close();
        } catch {}
    });
    return db;
}
function fixture(generation: "v1" | "v2", off = false, subagent = false) {
    const temp = createTestTempDir("served-prefix-");
    cleanups.push(temp.cleanup);
    const db = database();
    updateSessionMeta(db, "prefix", { isSubagent: subagent });
    const raw = [message("turn")];
    const pending = new Set<string>();
    const make = () =>
        createTransform({
            db,
            directory: temp.dir,
            storeGeneration: generation,
            signedThinkingHold: "on",
            compactionOff: off,
            tagger: createTagger(),
            historianRunnable: false,
            scheduler: { shouldExecute: () => "defer" } as never,
            liveModelBySession: new Map([["prefix", model]]),
            contextUsageMap: new Map(),
            pendingMaterializationSessions: pending,
            historyRefreshSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
        });
    let transform = make();
    const pass = async () => {
        const messages = structuredClone(raw);
        if (off)
            await createMessagesTransformHandler({
                magicContext: { "experimental.chat.messages.transform": transform },
                compactionOff: true,
            })({}, { messages } as never);
        else await transform({}, { messages });
        return messages;
    };
    const restart = () => {
        clearInjectionCache("prefix");
        transform = make();
    };
    return { db, raw, pass, restart, pending };
}
function checkFirst(db: Database, served: MessageLike[]) {
    const record = readServedPrefix<MessageLike>(db, "prefix");
    expect(record?.first_kept).not.toBeNull();
    const actual = served.find((row) => row.info.id === record?.first_kept?.id);
    expect(actual).toBeDefined();
    expect(record?.first_kept?.digest).toBe(servedMessageDigest(actual));
    return record!;
}

for (const generation of ["v1", "v2"] as const)
    describe(`served prefix ${generation}`, () => {
        it("replays after cache clear and restart, and refuses only the missing seam pass", async () => {
            const f = fixture(generation);
            f.raw.unshift(message("older", "assistant", "earlier answer"));
            const first = await f.pass();
            const record = checkFirst(f.db, first);
            const assistant = message("a", "assistant", "answer");
            assistant.parts.unshift(reasoning("sig-a"));
            f.raw.push(assistant);
            const held = await f.pass();
            clearCachedM0M1(f.db, "prefix");
            f.restart();
            expect(await f.pass()).toEqual(held);
            expect(readServedPrefix(f.db, "prefix")).toEqual(record);
            const missing = f.raw.shift()!;
            await expect(f.pass()).rejects.toBeInstanceOf(DegradedPassRefusalError);
            expect(readServedPrefix(f.db, "prefix")).toEqual(record);
            f.raw.unshift(missing);
            expect(await f.pass()).toEqual(held);
        });
        it("first-kept reasoning mutation refuses by digest on a held non-busting pass", async () => {
            const f = fixture(generation);
            // Seed a valid older-turn first-kept assistant, as at a partial history seam.
            // The record contains the actual tagged message, not a reasoning-only proxy.
            f.raw.unshift(message("older", "assistant", "earlier answer"));
            const initial = await f.pass();
            const older = initial.find((row) => row.info.id === "older")!;
            older.parts.unshift(reasoning("old"));
            f.raw[0].parts.unshift(reasoning("old"));
            const oldRecord = readServedPrefix<MessageLike>(f.db, "prefix")!;
            writeServedPrefix({
                db: f.db,
                sessionId: "prefix",
                head: oldRecord.head,
                summary: null,
                firstKept: older,
                firstKeptId: "older",
                turn: "turn",
                provenance: oldRecord.provenance,
            });
            const assistant = message("active", "assistant", "current step");
            assistant.parts.unshift(reasoning("active"));
            f.raw.push(assistant);
            const held = await f.pass();
            const record = checkFirst(f.db, held);
            expect(record.first_kept?.id).toBe("older");
            expect(await f.pass()).toEqual(held);
            // Recording "older" as newly omitted without rebuilding the prefix
            // changes its served message. Its saved digest must refuse the request.
            expect(addRemovedReasoningIds(f.db, "prefix", ["older"])).toBe(true);
            let failure: unknown;
            try {
                await f.pass();
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(DegradedPassRefusalError);
            expect(String((failure as Error).cause)).toContain("first kept digest mismatch");
            expect(readServedPrefix(f.db, "prefix")).toEqual(record);
            f.raw.push(message("next"));
            f.pending.add("prefix");
            const rebuilt = await f.pass();
            expect(checkFirst(f.db, rebuilt).turn).toBe("next");
            expect(await f.pass()).toEqual(rebuilt);
        });
        it("missing, old-turn and empty-cut records refuse per pass; a new user recovers", async () => {
            const f = fixture(generation);
            await f.pass();
            const initial = readServedPrefix(f.db, "prefix")!;
            const assistant = message("a", "assistant");
            assistant.parts.unshift(reasoning("sig"));
            f.raw.push(assistant);
            for (const record of [
                null,
                { ...initial, turn: "other" },
                { ...initial, first_kept: null },
                { ...initial, head: [] },
            ]) {
                f.db
                    .prepare(
                        "UPDATE session_meta SET served_prefix = ? WHERE session_id = 'prefix'",
                    )
                    .run(record && JSON.stringify(record));
                await expect(f.pass()).rejects.toBeInstanceOf(DegradedPassRefusalError);
            }
            f.raw.push(message("next"));
            checkFirst(f.db, await f.pass());
        });
        it("a failed record write never returns the unrecorded managed array", async () => {
            const f = fixture(generation);
            await f.pass();
            const before = readServedPrefix(f.db, "prefix");
            const certificate = f.db
                .prepare("SELECT * FROM lkg_served_markers WHERE session_id = 'prefix'")
                .get();
            f.raw.push(message("next"));
            f.db.exec(
                "CREATE TRIGGER fail_prefix BEFORE UPDATE OF served_prefix ON session_meta BEGIN SELECT RAISE(ABORT, 'record unavailable'); END",
            );
            await expect(f.pass()).rejects.toBeInstanceOf(DegradedPassRefusalError);
            expect(readServedPrefix(f.db, "prefix")).toEqual(before);
            expect(
                f.db.prepare("SELECT * FROM lkg_served_markers WHERE session_id = 'prefix'").get(),
            ).toEqual(certificate);
        });
        for (const subagent of [false, true])
            it(`compaction-off ${subagent ? "subagent" : "primary"} never routes a prefix failure to raw input`, async () => {
                const f = fixture(generation, true, subagent);
                const first = await f.pass();
                expect(first.length).toBeGreaterThan(f.raw.length);
                const head = first.slice(0, 2);
                const assistant = message("a", "assistant");
                assistant.parts.unshift(reasoning("sig"));
                f.raw.push(assistant);
                for (const value of [
                    null,
                    "bad json",
                    JSON.stringify({ ...readServedPrefix(f.db, "prefix"), first_kept: null }),
                ]) {
                    f.db
                        .prepare(
                            "UPDATE session_meta SET served_prefix = ? WHERE session_id = 'prefix'",
                        )
                        .run(value);
                    expect((await f.pass()).slice(0, 2)).toEqual(head);
                }
                f.raw.push(message("next"));
                f.db.exec(
                    "CREATE TRIGGER fail_prefix BEFORE UPDATE OF served_prefix ON session_meta BEGIN SELECT RAISE(ABORT, 'record unavailable'); END",
                );
                const failedWrite = await f.pass();
                expect(failedWrite.slice(0, 2)).toEqual(head);
                const next = message("next-a", "assistant");
                next.parts.unshift(reasoning("next-sig"));
                f.raw.push(next);
                expect((await f.pass()).slice(0, 2)).toEqual(head);
            });
    });

it("records the served mural, summary and first kept occurrence across a database reopen", () => {
    const temp = createTestTempDir("prefix-restart-");
    cleanups.push(temp.cleanup);
    const path = join(temp.dir, "context.db");
    const db = database(path);
    const head: MessageLike[] = [
        {
            info: { role: "user", syntheticHead: true },
            parts: [
                { type: "text", text: "frozen mural hash=abc", synthetic: true },
                {
                    type: "file",
                    url: "data:image/png;base64,AA==",
                    mime: "image/png",
                    synthetic: true,
                },
            ],
        },
    ];
    const summary = message("summary", "assistant", "§23§ compacted");
    summary.info.summary = true;
    const first = message("kept", "assistant");
    first.parts.unshift(reasoning("first"));
    const record = writeServedPrefix({
        db,
        sessionId: "prefix",
        head,
        summary,
        firstKept: first,
        firstKeptId: "kept",
        turn: "turn",
        provenance,
        cut: { mode: "partial", id: "kept" },
    });
    expect(record.first_kept?.digest).toBe(servedMessageDigest(first));
    db.close();
    const reopened = database(path);
    const restored = readServedPrefix<MessageLike>(reopened, "prefix")!;
    expect(restored).toEqual(record);
    const raw = [message("covered"), structuredClone(first), message("tail")];
    expect(prefixRecordProblem(restored, provenance, "turn", true)).toBeNull();
    expect(
        replayServedPrefix({
            messages: raw,
            record: restored,
            stableId: (row) => row.info.id,
            isHead: (row) => row.info.syntheticHead === true,
            isSummary: (row) => row.info.summary === true,
        }),
    ).toBeNull();
    expect(raw).toEqual([...head, summary, first, message("tail")]);
    expect(validateServedPrefix(restored, raw, (row) => row.info.id)).toBeNull();
    clearCachedM0M1(reopened, "prefix");
    expect(readServedPrefix(reopened, "prefix")).toEqual(record);
});

it("an empty first_kept never erases newly arrived raw history on a replay", () => {
    const db = database();
    const record = writeServedPrefix({
        db,
        sessionId: "prefix",
        head: [message("head")],
        summary: null,
        firstKept: undefined,
        firstKeptId: undefined,
        turn: "turn",
        provenance,
    });
    const raw = [message("next")];
    expect(
        replayServedPrefix({
            messages: raw,
            record,
            stableId: (row) => row.info.id,
            isHead: () => false,
        }),
    ).toContain("first kept");
    expect(raw).toEqual([message("next")]);
});

for (const generation of ["v1", "v2"] as const)
    it(`served prefix ${generation}: first-kept tool-input key order is exact`, async () => {
        const f = fixture(generation);
        const older = message("older-tool", "assistant");
        older.parts = [
            {
                id: "old-tool-part",
                type: "tool",
                tool: "bash",
                callID: "old-call",
                state: { status: "completed", input: { z: 1, a: 2 }, output: "result" },
            },
        ];
        f.raw.unshift(older);
        checkFirst(f.db, await f.pass());
        const current = message("current", "assistant", "Current step");
        current.parts.unshift(reasoning("current"));
        f.raw.push(current);
        const held = await f.pass();
        const record = checkFirst(f.db, held);
        expect(record.first_kept?.id).toBe("older-tool");
        expect(await f.pass()).toEqual(held);
        (older.parts[0] as { state: { input: unknown } }).state.input = { a: 2, z: 1 };
        let failure: unknown;
        try {
            await f.pass();
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(DegradedPassRefusalError);
        expect(String((failure as Error).cause)).toContain("first kept digest mismatch");
        expect(readServedPrefix(f.db, "prefix")).toEqual(record);
    });

it("replays a large retained history without a variadic argument limit", () => {
    const db = database();
    const raw = Array.from({ length: 200000 }, (_, index) => message(`raw-${index}`));
    const first = raw[0];
    const last = raw.at(-1);
    const head = [message("head")];
    const record = writeServedPrefix({
        db,
        sessionId: "prefix",
        head,
        summary: null,
        firstKept: first,
        firstKeptId: "raw-0",
        turn: "raw-0",
        provenance,
    });
    expect(
        replayServedPrefix({
            messages: raw,
            record,
            stableId: (row) => row.info.id,
            isHead: () => false,
        }),
    ).toBeNull();
    expect(raw).toHaveLength(200001);
    expect(raw[1]).toBe(first);
    expect(raw.at(-1)).toBe(last);
    expect(validateServedPrefix(record, raw, (row) => row.info.id)).toBeNull();
});
