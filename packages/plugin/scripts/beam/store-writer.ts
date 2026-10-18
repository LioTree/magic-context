/**
 * Writes a BEAM conversation into a real OpenCode 1.18 store while no server is running.
 *
 * The project, project directory and session rows are created by the real host (the harness asks a
 * live host to create an empty session and stops it first), so only the turn rows are written here,
 * in the exact shapes OpenCode 1.18.30 writes for a user text message and an assistant text reply
 * (captured from a real host run; see README.md):
 *
 *   message.data (user)      {"role":"user","time":{"created"},"agent","model":{"providerID","modelID"}}
 *   message.data (assistant) {"parentID","role":"assistant","mode","agent","path":{"cwd","root"},
 *                             "cost","tokens":{...},"modelID","providerID","time":{"created","completed"},"finish":"stop"}
 *   part.data (text)         {"type":"text","text"[, "time":{"start","end"}]}
 *
 * The `id` of each row uses OpenCode's ascending identifier layout (six bytes of
 * `milliseconds * 0x1000 + counter`, then 14 random base-62 characters) taken from the write-time
 * clock, so ids sort in turn order and before anything the host creates later. `time_created`
 * carries the turn's BEAM timestamp, which is what Magic Context reads for dates.
 *
 * OpenCode's `event` table is an append-only change log; replaying the conversation into it is not
 * needed for the host to load the session (the message and part tables are what it reads), so no
 * event rows are written.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { Turn } from "./dataset";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** OpenCode's ascending id for one moment and a per-moment counter. */
export function ascendingId(prefix: "msg" | "prt", milliseconds: number, counter: number): string {
    const value = BigInt(milliseconds) * 0x1000n + BigInt(counter);
    const head = Array.from({ length: 6 }, (_, index) =>
        Number((value >> BigInt(40 - 8 * index)) & 0xffn)
            .toString(16)
            .padStart(2, "0"),
    ).join("");
    const tail = Array.from(randomBytes(14), (byte) => BASE62[byte % 62]).join("");
    return `${prefix}_${head}${tail}`;
}

export interface WriteSessionOptions {
    dbPath: string;
    sessionId: string;
    directory: string;
    providerID: string;
    modelID: string;
    turns: Turn[];
    /** Write-time clock in milliseconds; ids are allocated from here, one millisecond per turn. */
    clock?: number;
}

export interface WrittenSession {
    messageIds: string[];
    lastMessageId: string;
}

export function writeSessionTurns(options: WriteSessionOptions): WrittenSession {
    const db = new Database(options.dbPath);
    try {
        const session = db.query("SELECT id FROM session WHERE id = ?").get(options.sessionId);
        if (!session) throw new Error(`session ${options.sessionId} is not in ${options.dbPath}`);
        const existing = db.query("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(options.sessionId) as {
            count: number;
        };
        if (existing.count > 0) throw new Error(`session ${options.sessionId} already has ${existing.count} messages`);

        // Leave a margin below "now" so every id here sorts before ids the host mints later.
        const base = (options.clock ?? Date.now()) - options.turns.length - 10_000;
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        );
        const messageIds: string[] = [];
        let lastUserId: string | null = null;
        db.transaction(() => {
            options.turns.forEach((turn, index) => {
                const messageId = ascendingId("msg", base + index, 1);
                const partId = ascendingId("prt", base + index, 2);
                const created = turn.timestampMs;
                const data =
                    turn.role === "user"
                        ? {
                              role: "user",
                              time: { created },
                              agent: "build",
                              model: { providerID: options.providerID, modelID: options.modelID },
                          }
                        : {
                              ...(lastUserId ? { parentID: lastUserId } : {}),
                              role: "assistant",
                              mode: "build",
                              agent: "build",
                              path: { cwd: options.directory, root: options.directory },
                              cost: 0,
                              tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
                              modelID: options.modelID,
                              providerID: options.providerID,
                              time: { created, completed: created },
                              finish: "stop",
                          };
                insertMessage.run(messageId, options.sessionId, created, created, JSON.stringify(data));
                const part =
                    turn.role === "user"
                        ? { type: "text", text: turn.content }
                        : { type: "text", text: turn.content, time: { start: created, end: created } };
                insertPart.run(partId, messageId, options.sessionId, created, created, JSON.stringify(part));
                if (turn.role === "user") lastUserId = messageId;
                messageIds.push(messageId);
            });
            const last = options.turns.at(-1)?.timestampMs ?? 0;
            db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(Math.max(last, Date.now()), options.sessionId);
        })();
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        return { messageIds, lastMessageId: messageIds.at(-1) ?? "" };
    } finally {
        db.close();
    }
}

/** Rows that would mean a stored login or credential reached the throwaway store. */
export function credentialRowCounts(dbPath: string): Record<string, number> {
    const db = new Database(dbPath, { readonly: true });
    try {
        const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
            (row) => row.name,
        );
        const counts: Record<string, number> = {};
        for (const table of ["credential", "account", "account_state", "control_account"]) {
            if (!tables.includes(table)) continue;
            counts[table] = (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
        }
        return counts;
    } finally {
        db.close();
    }
}
