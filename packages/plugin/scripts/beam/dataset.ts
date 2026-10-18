/**
 * BEAM rows, shaped the way the harness replays them.
 *
 * Each BEAM row is one long conversation between one user and an assistant, plus 20 probing
 * questions about it (two per memory ability). This module turns a row into the ordered turns a
 * chat host would have stored, each with a timestamp, and into the questions the benchmark asks
 * after the last turn.
 *
 * The parsing follows the dataset map in pastdotdev/benchmarks `beam/dataset.py` (MIT): sessions
 * are lists of turns, a session is dated by the first `time_anchor` any of its turns carries, a
 * turn sits at noon UTC on its session's day plus one microsecond per position, and a session
 * with no date comes an hour after the one before. JavaScript dates hold milliseconds, so the
 * microsecond offset is kept as an integer next to the date (`timestampMicros`).
 *
 * The paper's protocol (§2.1) asks every question as turn |T|+1, after the whole conversation, so
 * unlike past.dev no question is moved back to the moment of a knowledge update.
 *
 * Only `question` reaches the answer model. The rubric is read by the scorer alone, and every other
 * annotation (why a question is unanswerable, the preference being tested, ...) is never read.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const CATEGORIES = [
    "abstention",
    "contradiction_resolution",
    "event_ordering",
    "information_extraction",
    "instruction_following",
    "knowledge_update",
    "multi_session_reasoning",
    "preference_following",
    "summarization",
    "temporal_reasoning",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface BeamTurn {
    content: string;
    id?: number | null;
    index?: string | null;
    question_type?: string | null;
    role: string;
    time_anchor?: string | null;
}

export interface BeamRow {
    conversation_id: string;
    conversation_seed?: { title?: string | null } | null;
    chat: BeamTurn[][];
    probing_questions: string | Record<string, unknown[]>;
}

export interface Turn {
    /** Position in the conversation, from 0. */
    ordinal: number;
    session: number;
    role: "user" | "assistant";
    /** The turn's text exactly as BEAM stores it. */
    content: string;
    /** Milliseconds since the epoch: noon UTC on the session's day plus `ordinal` microseconds, rounded down. */
    timestampMs: number;
    /** The same moment in whole microseconds since the epoch. */
    timestampMicros: number;
}

export interface Question {
    id: string;
    conversationId: string;
    category: Category;
    /** Position within its category, from 0. */
    index: number;
    text: string;
    /** The nuggets the judge scores, or for event ordering, the reference order. */
    rubric: string[];
}

export interface Conversation {
    id: string;
    title: string;
    turns: Turn[];
    questions: Question[];
}

const MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/**
 * A BEAM day ("March-15-2024", "March 15th, 2024", "2024-03-15") at noon UTC, in milliseconds,
 * or null when the text is not a date.
 */
export function parseBeamDate(value: string | null | undefined): number | null {
    const text = String(value ?? "")
        .trim()
        .replace(/(\d)(st|nd|rd|th)\b/g, "$1");
    if (!text) return null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12);
    const named = /^([A-Za-z]+)[-\s](\d{1,2}),?[-\s](\d{4})$/.exec(text);
    if (!named) return null;
    const month = MONTHS.indexOf((named[1] ?? "").toLowerCase());
    if (month < 0) return null;
    return Date.UTC(Number(named[3]), month, Number(named[2]), 12);
}

function sessionDates(chat: BeamTurn[][], conversation: string): number[] {
    const hour = 3_600_000;
    const dates = chat.map((session) =>
        parseBeamDate(session.find((turn) => turn.time_anchor)?.time_anchor),
    );
    return dates.map((date, index) => {
        if (date !== null) return date;
        for (let previous = index - 1; previous >= 0; previous--) {
            const known = dates[previous];
            if (known != null) return known + (index - previous) * hour;
        }
        const following = dates.slice(index + 1).find((value) => value !== null);
        if (following != null) return following - 24 * hour;
        throw new Error(`BEAM conversation ${conversation} has no usable date`);
    });
}

export function buildTurns(row: BeamRow): Turn[] {
    const days = sessionDates(row.chat, row.conversation_id);
    const turns: Turn[] = [];
    row.chat.forEach((session, sessionIndex) => {
        for (const turn of session) {
            const content = String(turn.content ?? "");
            // past.dev drops turns whose text is blank; the 100K split has none.
            if (!content.trim()) continue;
            const role = String(turn.role ?? "user")
                .trim()
                .toLowerCase();
            if (role !== "user" && role !== "assistant") {
                throw new Error(
                    `BEAM conversation ${row.conversation_id} has a turn with role ${role}`,
                );
            }
            const ordinal = turns.length;
            const day = days[sessionIndex] ?? 0;
            turns.push({
                ordinal,
                session: sessionIndex,
                role,
                content,
                timestampMs: day + Math.floor(ordinal / 1000),
                timestampMicros: day * 1000 + ordinal,
            });
        }
    });
    if (turns.length === 0)
        throw new Error(`BEAM conversation ${row.conversation_id} has no turns`);
    return turns;
}

/** BEAM stores a row's questions as a JSON or Python-literal string keyed by category. */
export function parseProbingQuestions(
    value: BeamRow["probing_questions"],
): Record<string, unknown[]> {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value) as Record<string, unknown[]>;
    } catch {
        return JSON.parse(pythonLiteralToJson(value)) as Record<string, unknown[]>;
    }
}

/**
 * Convert the Python `repr` of a dict of lists of dicts of strings into JSON. Only the shapes BEAM
 * uses are handled: single- or double-quoted strings with backslash escapes, numbers, lists, dicts,
 * True, False and None.
 */
export function pythonLiteralToJson(source: string): string {
    let out = "";
    let i = 0;
    while (i < source.length) {
        const char = source[i] as string;
        if (char === "'" || char === '"') {
            const quote = char;
            let text = "";
            i++;
            while (i < source.length && source[i] !== quote) {
                if (source[i] === "\\") {
                    const next = source[i + 1] ?? "";
                    const simple: Record<string, string> = {
                        n: "\n",
                        t: "\t",
                        r: "\r",
                        "\\": "\\",
                        "'": "'",
                        '"': '"',
                    };
                    if (next in simple) {
                        text += simple[next];
                        i += 2;
                    } else if (next === "x") {
                        text += String.fromCharCode(
                            Number.parseInt(source.slice(i + 2, i + 4), 16),
                        );
                        i += 4;
                    } else if (next === "u") {
                        text += String.fromCharCode(
                            Number.parseInt(source.slice(i + 2, i + 6), 16),
                        );
                        i += 6;
                    } else {
                        text += next;
                        i += 2;
                    }
                } else {
                    text += source[i];
                    i++;
                }
            }
            i++;
            out += JSON.stringify(text);
            continue;
        }
        const word = /^(True|False|None)\b/.exec(source.slice(i, i + 5));
        if (word) {
            out += word[1] === "True" ? "true" : word[1] === "False" ? "false" : "null";
            i += (word[1] ?? "").length;
            continue;
        }
        out += char;
        i++;
    }
    return out;
}

export function buildQuestions(row: BeamRow): Question[] {
    const byCategory = parseProbingQuestions(row.probing_questions);
    const questions: Question[] = [];
    for (const category of CATEGORIES) {
        const items = byCategory[category] ?? [];
        items.forEach((raw, index) => {
            const item = raw as { question?: unknown; rubric?: unknown };
            const text = typeof item.question === "string" ? item.question : "";
            if (!text) return;
            const rubric = Array.isArray(item.rubric)
                ? item.rubric.map(String)
                : item.rubric
                  ? [String(item.rubric)]
                  : [];
            questions.push({
                id: `${row.conversation_id}_${category}_${index}`,
                conversationId: row.conversation_id,
                category,
                index,
                text,
                rubric,
            });
        });
    }
    return questions;
}

export function buildConversation(row: BeamRow): Conversation {
    return {
        id: row.conversation_id,
        title: row.conversation_seed?.title ?? `Conversation ${row.conversation_id}`,
        turns: buildTurns(row),
        questions: buildQuestions(row),
    };
}

export async function loadRows(path: string): Promise<BeamRow[]> {
    const text = await readFile(path, "utf8");
    return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as BeamRow);
}

/** A digest of the conversation's turns, so a saved ingest can prove which data it holds. */
export function conversationDigest(conversation: Conversation): string {
    const hash = createHash("sha256");
    for (const turn of conversation.turns)
        hash.update(`${turn.role}\u0000${turn.timestampMicros}\u0000${turn.content}\u0001`);
    return hash.digest("hex");
}
