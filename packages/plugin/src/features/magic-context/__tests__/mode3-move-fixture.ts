/**
 * Builds the standalone OpenCode 1 session that ck-mc's offline-move tests import
 * (`crates/mc-module/testdata/mode3_move_fixture.json`), using the standalone
 * plugin's own code: the transform's tagger walk (`tagMessages`), drop and queue
 * writers, compartment storage, and the compaction-marker writer.
 *
 * The session: twelve messages. Two compartments cover m001..m006, so the marker
 * sits on the nearest user message at or before m006, which is m005 (the cut).
 * After the cut, standalone has applied a tool drop and a text drop whose part
 * index (3) differs from its text ordinal (1), and has queued drops on a tool, a
 * text part and a file part. A tool drop before the cut is covered by the
 * summaries and must not be carried.
 *
 * `expected` lists the parts the generator itself chose to drop, by OpenCode id,
 * so a test can check the move's address resolution against an answer it did not
 * compute.
 */
import { join } from "node:path";
import { tagMessages } from "../../../hooks/magic-context/transform-operations";
import { Database } from "../../../shared/sqlite";
import {
    closeCompactionMarkerDb,
    injectCompactionMarker,
    prepareCompactionMarkerCandidates,
} from "../compaction-marker";
import { appendCompartments } from "../compartment-storage";
import { closeDatabase, openDatabase, queuePendingOp } from "../storage";
import { setPersistedCompactionMarkerState } from "../storage-meta-persisted";
import { markTagDropped } from "../storage-tags";
import { createTagger } from "../tagger";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "./opencode1-query-fixture";

export const MODE3_MOVE_SESSION = "ses_mode3_move_fixture";
/** Compartment rows get `Date.now()`; the fixture stores this instead. */
const FIXED_CREATED_AT = 1_700_000_000_000;
const QUEUED_AT = 1_700_000_100_000;

type Part = Record<string, unknown> & { id: string; type: string };
interface Message {
    id: string;
    role: "user" | "assistant";
    time: number;
    parts: Part[];
}

const text = (id: string, body: string): Part => ({ id, type: "text", text: body });
const tool = (id: string, callID: string, output: string): Part => ({
    id,
    type: "tool",
    callID,
    tool: "read",
    state: {
        status: "completed",
        input: { filePath: `/repo/${callID}.ts` },
        output,
        title: `${callID}.ts`,
        metadata: {},
        time: { start: 1, end: 2 },
    },
});

function sessionMessages(): Message[] {
    return [
        {
            id: "msg_m001",
            role: "user",
            time: 1_000,
            parts: [text("prt_m001_a", "Set up the parser.")],
        },
        {
            id: "msg_m002",
            role: "assistant",
            time: 2_000,
            parts: [
                { id: "prt_m002_a", type: "reasoning", text: "Look at the grammar first." },
                text("prt_m002_b", "Reading the grammar."),
                tool("prt_m002_c", "call_c1", "grammar contents before the cut"),
            ],
        },
        {
            id: "msg_m003",
            role: "user",
            time: 3_000,
            parts: [text("prt_m003_a", "Now the lexer.")],
        },
        {
            id: "msg_m004",
            role: "assistant",
            time: 4_000,
            parts: [
                tool("prt_m004_a", "call_c2", "lexer contents"),
                text("prt_m004_b", "The lexer is done."),
            ],
        },
        {
            id: "msg_m005",
            role: "user",
            time: 5_000,
            parts: [text("prt_m005_a", "Add error recovery.")],
        },
        {
            id: "msg_m006",
            role: "assistant",
            time: 6_000,
            parts: [
                text("prt_m006_a", "Recovery added."),
                tool("prt_m006_b", "call_c3", "recovery diff"),
            ],
        },
        {
            id: "msg_m007",
            role: "user",
            time: 7_000,
            parts: [text("prt_m007_a", "Run the tests.")],
        },
        {
            id: "msg_m008",
            role: "assistant",
            time: 8_000,
            parts: [
                { id: "prt_m008_a", type: "reasoning", text: "Tests first, then summary." },
                text("prt_m008_b", "Running the suite now."),
                tool("prt_m008_c", "call_c4", "test output: 412 passed ".repeat(20)),
                text("prt_m008_d", "All 412 tests pass; the long log above is no longer needed."),
            ],
        },
        {
            id: "msg_m009",
            role: "user",
            time: 9_000,
            parts: [
                text("prt_m009_a", "Here is the failing input."),
                {
                    id: "prt_m009_b",
                    type: "file",
                    mime: "text/plain",
                    filename: "failing.txt",
                    url: "data:text/plain;base64,ZmFpbGluZyBpbnB1dA==",
                },
            ],
        },
        {
            id: "msg_m010",
            role: "assistant",
            time: 10_000,
            parts: [
                tool("prt_m010_a", "call_c5", "parser trace ".repeat(30)),
                text("prt_m010_b", "The trace shows the recovery loop."),
                tool("prt_m010_c", "call_c6", "fixed recovery loop"),
            ],
        },
        { id: "msg_m011", role: "user", time: 11_000, parts: [text("prt_m011_a", "Ship it.")] },
        {
            id: "msg_m012",
            role: "assistant",
            time: 12_000,
            parts: [text("prt_m012_a", "Shipped.")],
        },
    ];
}

export interface Mode3MoveFixture {
    session: string;
    opencode: {
        schema: string;
        message: Record<string, unknown>[];
        part: Record<string, unknown>[];
    };
    context: Record<string, Record<string, unknown>[]>;
    expected: {
        tag_checkpoint: number;
        cut: string;
        marker_part: string;
        coverage_end: string;
        applied: { mid: string; part: string }[];
        queued: { mid: string; part: string }[];
        behind_cut: { mid: string; part: string }[];
    };
}

function rows(db: Database, sql: string, ...args: unknown[]): Record<string, unknown>[] {
    return db.prepare(sql).all(...(args as never[])) as Record<string, unknown>[];
}

/**
 * Build the fixture under `dir` (a throwaway data home: the caller points
 * `XDG_DATA_HOME` at it before calling) and return its rows.
 */
export async function buildMode3MoveFixture(dir: string): Promise<Mode3MoveFixture> {
    const session = MODE3_MOVE_SESSION;
    const messages = sessionMessages();
    const opencodePath = join(dir, "opencode", "opencode.db");
    const host = new Database(opencodePath);
    host.exec("PRAGMA journal_mode=WAL");
    host.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    for (const message of messages) {
        host.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(
            message.id,
            session,
            message.time,
            message.time,
            JSON.stringify({ role: message.role, time: { created: message.time } }),
        );
        for (const part of message.parts) {
            const { id, ...data } = part;
            host.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(id, message.id, session, message.time, message.time, JSON.stringify(data));
        }
    }

    const db = openDatabase();
    if (!db) throw new Error("context.db did not open");
    const tagger = createTagger();
    // The transform's own walk allocates the tags, in the shape it sees: each
    // message's parts in OpenCode's order, with their ids.
    const transformInput = messages.map((message) => ({
        info: { id: message.id, sessionID: session, role: message.role },
        parts: message.parts.map((part) => structuredClone(part)),
    }));
    tagMessages(session, transformInput as never, tagger, db);

    const textTag = (mid: string, index: number) => {
        const tag = tagger.getTag(session, `${mid}:p${index}`, "message");
        if (tag === undefined) throw new Error(`no tag for ${mid}:p${index}`);
        return tag;
    };
    const fileTag = (mid: string, index: number) => {
        const tag = tagger.getTag(session, `${mid}:file${index}`, "file");
        if (tag === undefined) throw new Error(`no tag for ${mid}:file${index}`);
        return tag;
    };
    const toolTag = (mid: string, callId: string) => {
        const tag = tagger.getToolTag(session, callId, mid);
        if (tag === undefined) throw new Error(`no tool tag for ${callId}`);
        return tag;
    };
    // Applied drops: one before the cut, two after it.
    markTagDropped(db, session, toolTag("msg_m002", "call_c1"), "full");
    markTagDropped(db, session, toolTag("msg_m008", "call_c4"), "full");
    markTagDropped(db, session, textTag("msg_m008", 3), "full");
    // Queued ctx_reduce stamps after the cut.
    queuePendingOp(db, session, toolTag("msg_m010", "call_c5"), "drop", QUEUED_AT);
    queuePendingOp(db, session, textTag("msg_m010", 1), "drop", QUEUED_AT + 1);
    queuePendingOp(db, session, fileTag("msg_m009", 1), "drop", QUEUED_AT + 2);

    appendCompartments(db, session, [
        {
            sequence: 1,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "msg_m001",
            endMessageId: "msg_m002",
            title: "Parser setup",
            content: "The user asked for a parser; the grammar was read.",
            p1: "The user asked for a parser; the grammar was read.",
            p2: "Parser started from the grammar.",
            importance: 60,
            episodeType: "feature",
        },
        {
            sequence: 2,
            startMessage: 3,
            endMessage: 6,
            startMessageId: "msg_m003",
            endMessageId: "msg_m006",
            title: "Lexer and recovery",
            content: "The lexer was written, then error recovery was added.",
            p1: "The lexer was written, then error recovery was added.",
            importance: 55,
        },
    ]);
    // The marker writer prepares its candidate rows first, as the transform does.
    if (!(await prepareCompactionMarkerCandidates(session))) {
        throw new Error("marker candidate preparation failed");
    }
    const marker = injectCompactionMarker({
        sessionId: session,
        endOrdinal: 6,
        endMessageId: "msg_m006",
        summaryText: "[Compacted by Magic Context]",
        directory: "/repo",
    });
    if (!marker) throw new Error("the standalone marker writer refused the fixture");
    setPersistedCompactionMarkerState(db, session, {
        ...marker,
        boundaryOrdinal: 5,
        targetEndMessageId: "msg_m006",
    });
    closeCompactionMarkerDb();

    const counter = rows(db, "SELECT counter FROM session_meta WHERE session_id = ?", session)[0]
        ?.counter as number;
    const fixture: Mode3MoveFixture = {
        session,
        opencode: {
            schema: OPENCODE1_MESSAGE_PART_SCHEMA,
            message: rows(host, "SELECT * FROM message ORDER BY time_created, id"),
            part: rows(host, "SELECT * FROM part ORDER BY message_id, id"),
        },
        context: {
            session_meta: rows(
                db,
                `SELECT session_id, harness, counter, compaction_marker_state,
                        pending_compaction_marker_state, is_subagent
                   FROM session_meta WHERE session_id = ?`,
                session,
            ),
            tags: rows(
                db,
                `SELECT session_id, message_id, type, status, byte_size, tag_number, harness,
                        drop_mode, tool_name, tool_owner_message_id
                   FROM tags WHERE session_id = ? ORDER BY tag_number`,
                session,
            ),
            pending_ops: rows(
                db,
                "SELECT session_id, tag_id, operation, queued_at, harness FROM pending_ops WHERE session_id = ? ORDER BY id",
                session,
            ),
            compartments: rows(
                db,
                `SELECT session_id, sequence, start_message, end_message, start_message_id,
                        end_message_id, start_block_index, end_block_index, title, content,
                        p1, p2, p3, p4, importance, episode_type, legacy, ${FIXED_CREATED_AT} AS created_at,
                        harness
                   FROM compartments WHERE session_id = ? ORDER BY sequence`,
                session,
            ),
        },
        expected: {
            tag_checkpoint: counter,
            cut: marker.boundaryMessageId,
            marker_part: marker.compactionPartId,
            coverage_end: "msg_m006",
            applied: [
                { mid: "msg_m008", part: "prt_m008_c" },
                { mid: "msg_m008", part: "prt_m008_d" },
            ],
            queued: [
                { mid: "msg_m009", part: "prt_m009_b" },
                { mid: "msg_m010", part: "prt_m010_a" },
                { mid: "msg_m010", part: "prt_m010_b" },
            ],
            behind_cut: [{ mid: "msg_m002", part: "prt_m002_c" }],
        },
    };
    host.close();
    closeDatabase();
    return fixture;
}
