// Checks that the basal flow in scripts/flows/mc-subagent-failure-sentinel
// raises exactly the alerts this directory's launchd sentinel raises on the
// same rows. Each case of subagent-failure-sentinel.test.ts is replayed through
// both: run by run, `step` compares their alerts, cursor, dedupe state and wake
// text, and the normalisation case compares the two `normalizeError`s directly. The flow runs under a small harness that stands in for basal's
// `ops.call`, `kv` and `sink`; its op answers from the same SQLite rows with the
// queries the script runs itself.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    type Alert,
    evaluateFailures,
    normalizeError,
    recoveredByFallback,
    runFailureSentinel,
} from "./subagent-failure-sentinel";

const FLOW_DIR = join(import.meta.dir, "../../../scripts/flows/mc-subagent-failure-sentinel");
const FLOW_SOURCE = readFileSync(join(FLOW_DIR, "flow.js"), "utf8");
const MAIN_MARKER = "// ---- The run ----";
const FIELDS = "id, session_id, subagent, task, started_at, ended_at, status, error, parent_invocation_id";
const SETTLE = 5 * 60_000;
const DAY = 86_400_000;
const NOW = 2_000_000_000_000;

type Row = Parameters<typeof evaluateFailures>[0][number];
type FlowPure = {
    normalizeError: typeof normalizeError;
    recoveredByFallback: typeof recoveredByFallback;
    evaluateFailures: typeof evaluateFailures;
};
type Digest = { agent: string; item: { title: string; body: string; data: Record<string, unknown> }; action: string; options?: { replace_key?: string } };
type FlowResult = { examined: number; alerts: number; bounded: boolean; history_read: boolean; watermark: { ended_at: number; id: number } };

// basal evaluates the script as the body of an async function.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

function loadFlowPure(): FlowPure {
    const cut = FLOW_SOURCE.indexOf(MAIN_MARKER);
    if (cut < 0) throw new Error("flow.js lost its run marker");
    const body = `${FLOW_SOURCE.slice(0, cut)}\nreturn { normalizeError, recoveredByFallback, evaluateFailures };`;
    return new Function(body)() as FlowPure;
}
const flow = loadFlowPure();

let root: string;
let db: Database;
let serial: number;
let kvStore: Map<string, unknown>;
let opCalls: Record<string, unknown>[];
let digests: Digest[];
let oldWakes: { content: string; id: string }[];

beforeEach(() => {
    mkdirSync(join(tmpdir(), "magic-context"), { recursive: true });
    root = mkdtempSync(join(tmpdir(), "magic-context", "subagent-failure-flow-"));
    db = new Database(join(root, "context.db"));
    db.exec(readFileSync(join(import.meta.dir, "../../../crates/mc-module/tests/fixtures/context-db-schema.sql"), "utf8"));
    serial = 0;
    kvStore = new Map();
    opCalls = [];
    digests = [];
    oldWakes = [];
});
afterEach(() => { db.close(false); rmSync(root, { recursive: true, force: true }); });

function add(status: string, time = NOW - 1_000, error = "failure code 42", task = "historian", subagent = "historian") {
    serial++;
    db.query("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error) VALUES (?, 'opencode', ?, ?, ?, ?, ?, ?)")
        .run(`session-${serial}`, subagent, task, time - 100, time, status, error);
}
function attempt(fields: { session: string; status: string; time: number; error?: string | null; task?: string | null; parent?: number | null; subagent?: string }): number {
    const row = db.query("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error, parent_invocation_id) VALUES (?, 'opencode', ?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .get(fields.session, fields.subagent ?? "historian", fields.task ?? null, fields.time - 100, fields.time, fields.status, fields.error ?? null, fields.parent ?? null) as { id: number };
    return row.id;
}

// Stands in for ck-mc's `subagent_invocations.read`, with the same arguments,
// limits and `{rows, more}` reply. ck-mc ends a page at a byte budget; here a
// page ends after PAGE_ROWS rows, so the flow's multi-page reads are exercised
// against the script's single queries.
const PAGE_ROWS = 7;
function fakeOp(module: string, op: string, args: Record<string, unknown>) {
    expect([module, op]).toEqual(["magic-context", "subagent_invocations.read"]);
    opCalls.push(args);
    const limit = args.limit as number;
    let rows: Row[];
    if (args.query === "after_cursor") {
        expect(Object.keys(args).sort()).toEqual(["cursor", "limit", "query", "settled_before"]);
        expect(limit >= 1 && limit <= 500).toBe(true);
        const cursor = args.cursor as { ended_at: number; id: number };
        expect(Object.keys(cursor).sort()).toEqual(["ended_at", "id"]);
        rows = db.query(`SELECT ${FIELDS} FROM subagent_invocations WHERE ended_at IS NOT NULL AND ended_at <= ? AND (ended_at > ? OR (ended_at = ? AND id > ?)) ORDER BY ended_at, id LIMIT ?`)
            .all(args.settled_before as number, cursor.ended_at, cursor.ended_at, cursor.id, limit + 1) as Row[];
    } else {
        expect(args.query).toBe("window");
        expect(limit >= 1 && limit <= 5_000).toBe(true);
        const keys = Object.keys(args).sort();
        expect(keys).toEqual(args.before ? ["after", "before", "limit", "query", "until"] : ["after", "limit", "query", "until"]);
        const before = (args.before as { ended_at: number; id: number } | undefined) ?? { ended_at: (args.until as number) + 1, id: Number.MIN_SAFE_INTEGER };
        rows = db.query(`SELECT ${FIELDS} FROM subagent_invocations WHERE ended_at > ? AND ended_at <= ? AND (ended_at < ? OR (ended_at = ? AND id < ?)) ORDER BY ended_at DESC, id DESC LIMIT ?`)
            .all(args.after as number, args.until as number, before.ended_at, before.ended_at, before.id, limit + 1) as Row[];
    }
    const kept = rows.slice(0, Math.min(limit, PAGE_ROWS));
    return { rows: kept, more: rows.length > kept.length };
}

async function runFlow(now: number, options: { replaceKeySupported?: boolean } = {}): Promise<FlowResult> {
    // Values go through JSON, as basal's kv stores them.
    const kv = {
        get: async (key: string) => (kvStore.has(key) ? JSON.parse(JSON.stringify(kvStore.get(key))) : null),
        set: async (key: string, value: unknown) => { kvStore.set(key, JSON.parse(JSON.stringify(value))); },
    };
    const digest = async (agent: string, item: Digest["item"], action: string, opts?: Digest["options"]) => {
        if (opts?.replace_key !== undefined && options.replaceKeySupported === false) {
            throw Object.assign(new Error("unsupported"), { data: { code: "digest_replace_key_unsupported" } });
        }
        digests.push({ agent, item, action, options: opts });
    };
    const ops = { call: async (module: string, op: string, args: Record<string, unknown>) => JSON.parse(JSON.stringify(fakeOp(module, op, args))) };
    const script = new AsyncFunction("ops", "kv", "sink", "Date", FLOW_SOURCE);
    return (await script(ops, kv, { digest }, { now: () => now })) as FlowResult;
}

async function runOld(now: number) {
    return runFailureSentinel({
        db: join(root, "context.db"), stateFile: join(root, "state.json"), connectionFile: join(root, "none"),
        send: true, now: () => now, stdout: () => {}, stderr: () => {},
        wake: async (content, id) => { oldWakes.push({ content, id }); },
    });
}

// The script's first run starts its cursor five minutes before `now`. The
// original cases judged rows the moment they ended, at NOW; here both run five
// minutes later with the real settle window, from that same starting cursor.
function seed(cursorEndedAt = NOW - SETTLE) {
    const state = { version: 1, cursor: { ended_at: cursorEndedAt, id: 0 }, sent: {} };
    writeFileSync(join(root, "state.json"), `${JSON.stringify(state)}\n`);
    kvStore.set("state", state);
}

// Runs both at `now`, requires identical outcomes, and returns the flow's alerts.
async function step(now: number): Promise<Alert[]> {
    const wakesBefore = oldWakes.length;
    const digestsBefore = digests.length;
    const old = await runOld(now);
    const flowed = await runFlow(now);
    const oldState = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    expect(kvStore.get("state")).toEqual(oldState);
    // Without a new failure the flow skips the history read the script made, so
    // only then do the counts that include history agree.
    if (flowed.history_read) {
        expect(flowed.examined).toBe(old.examined);
        expect(flowed.bounded).toBe(old.bounded);
    }
    expect(flowed.alerts).toBe(old.alerts.length);
    expect(flowed.watermark).toEqual(oldState.cursor);
    const newWakes = oldWakes.slice(wakesBefore);
    const newDigests = digests.slice(digestsBefore);
    expect(newDigests).toHaveLength(newWakes.length);
    if (!newWakes.length) return [];
    const [wake] = newWakes;
    const [sent] = newDigests;
    expect(sent.agent).toBe("MC");
    expect(sent.action).toBe("wake");
    expect(sent.options).toEqual({ replace_key: wake.id });
    expect(sent.item.body).toBe(wake.content);
    expect(sent.item.data).toEqual({ delivery_id: wake.id, alerts: old.alerts.length, bounded: old.bounded });
    const alerts = JSON.parse(sent.item.body.slice("Magic Context subagent failure sentinel: ".length)) as Alert[];
    expect(alerts).toEqual(old.alerts);
    return alerts;
}
const at = (now = NOW) => now + SETTLE;
const QUOTA = "Historian host recorded an assistant error: APIError: Antigravity account pool has no account available within the configured wait limit.";

// ---- The script's cases, replayed through both ----

test("a quota failure recovered by a completed fallback raises no alert", async () => {
    seed();
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `s-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: QUOTA });
        attempt({ session: `s-${i}`, status: "completed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: i % 2 === 0 ? primary : null });
    }
    expect(await step(at())).toHaveLength(0);
});

test("a quota failure whose fallback also failed still alerts", async () => {
    seed();
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `s-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: QUOTA });
        attempt({ session: `s-${i}`, status: "failed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: primary, error: "overloaded_error 529" });
    }
    const rules = (await step(at())).map((alert) => `${alert.rule}:${alert.task}`);
    expect(rules).toContain("new_class:(untitled)");
    expect(rules).toContain("failure_share:(untitled)");
});

test("a non-quota failure is not excused by its fallback", async () => {
    seed();
    const primary = attempt({ session: "s", status: "failed", time: NOW - 60_000, error: "missing complete root element" });
    attempt({ session: "s", status: "completed", time: NOW - 30_000, task: "fallback", parent: primary });
    expect((await step(at())).map((alert) => alert.rule)).toContain("new_class");
});

test("an unlinked fallback in another session or outside the start window recovers nothing", async () => {
    seed();
    attempt({ session: "a", status: "failed", time: NOW - 250_000, error: QUOTA });
    attempt({ session: "b", status: "completed", time: NOW - 240_000, task: "fallback" });
    attempt({ session: "c", status: "failed", time: NOW - 200_000, error: QUOTA });
    attempt({ session: "c", status: "completed", time: NOW - 50_000, task: "fallback" });
    const alerts = (await step(at())).filter((alert) => alert.rule === "new_class");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.count).toBe(2);
});

test("a failure is judged only after the settle window, once its fallback has finished", async () => {
    seed();
    const primary = attempt({ session: "s", status: "failed", time: NOW - 1_000, error: QUOTA });
    // Inside the window nothing is examined and the cursor stays before the failure.
    expect(await step(NOW)).toHaveLength(0);
    expect(kvStore.get("state")).toMatchObject({ cursor: { ended_at: NOW - SETTLE, id: 0 } });
    attempt({ session: "s", status: "completed", time: NOW + 30_000, task: "fallback", parent: primary });
    expect(await step(NOW + 6 * 60_000)).toHaveLength(0);
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 2 } });
});

test("new class alerts once and a seven-day prior class prevents a new-class wake", async () => {
    seed();
    add("failed", NOW - 6 * DAY, "failure code 9");
    add("failed", NOW - 1_000, "failure code 42");
    expect((await step(at())).some((a) => a.rule === "new_class")).toBe(false);
    add("timed_out", NOW - 500, "different failure 7");
    const alerts = await step(at());
    expect(alerts.map((a) => a.rule)).toContain("new_class");
    expect(alerts[0]?.newest_session_id).toBe("session-3");
});

test("failure share crosses at eight runs and reports empty and aborted separately", async () => {
    seed();
    for (let i = 0; i < 5; i++) add("completed");
    add("empty"); add("aborted"); add("failed");
    expect((await step(at())).some((a) => a.rule === "failure_share")).toBe(false);
    add("timed_out", NOW - 500);
    expect((await step(at())).some((a) => a.rule === "failure_share")).toBe(false);
    add("failed", NOW - 250);
    const alert = (await step(at())).find((a) => a.rule === "failure_share");
    expect(alert).toMatchObject({ count: 3, empty: 1, aborted: 1 });
    expect(alert?.share).toBeCloseTo(3 / 10);
});

test("a share alert is per task: a new failure class in the same burst does not re-fire it", async () => {
    seed();
    for (let i = 0; i < 6; i++) add("completed");
    for (let i = 0; i < 4; i++) add("timed_out", NOW - 900 + i, "prompt timed out after 120000ms");
    expect((await step(at())).find((a) => a.rule === "failure_share")).toMatchObject({ class: "*", count: 4 });
    add("failed", NOW - 500, "TimeoutError message=\"The operation timed out.\" code=23");
    expect((await step(at())).some((a) => a.rule === "failure_share")).toBe(false);
});

test("failure share alerts at exactly two of eight runs", async () => {
    seed();
    for (let i = 0; i < 6; i++) add("completed");
    add("failed"); add("timed_out");
    const alert = (await step(at())).find((a) => a.rule === "failure_share");
    expect(alert?.share).toBe(0.25);
    expect(alert?.count).toBe(2);
});

test("class doubling compares the preceding 24 hours", async () => {
    seed();
    add("failed", NOW - DAY - 1_000);
    add("failed", NOW - 1_000);
    expect((await step(at())).some((a) => a.rule === "class_doubled")).toBe(false);
    add("timed_out", NOW - 500);
    expect((await step(at())).some((a) => a.rule === "class_doubled")).toBe(true);
});

test("normalisation folds ids numbers durations and paths but preserves the failure class", () => {
    const pairs: [string, string][] = [
        ["job_abcdef failed /tmp/one/file after 20ms code 42", "job_xyz123 failed /var/two/file after 7.5 seconds code 99"],
        ["timeout 4ms", "permission denied 4ms"],
        ["APIError: Insufficient Balance (request_id: 6ccd58a4-fd7d-4695-ae30-b3cbd8c5b633)", "APIError: Insufficient Balance (request_id: 3f5266e0-127a-42d4-9a78-8f5c32e6bc8c)"],
        ["Insufficient Balance (request_id: 1a52d1e8-50cb…", "Insufficient Balance (request_id: 885b3a6a-e982-40a3…"],
        ["Account pool empty. Quota resets in 34h 34m 9s. (status=412)", "Account pool empty. Quota resets in 35h 45m 22s. (status=412)"],
        ["Quota resets in 2h", "Quota resets in 59m 3s"],
    ];
    for (const [left, right] of pairs) {
        expect(flow.normalizeError(left)).toBe(normalizeError(left));
        expect(flow.normalizeError(right)).toBe(normalizeError(right));
        expect(flow.normalizeError(left) === flow.normalizeError(right)).toBe(normalizeError(left) === normalizeError(right));
    }
    expect(flow.normalizeError(null)).toBe(normalizeError(null));
});

test("dedupe suppresses a wake for six hours unless class count grows by half", async () => {
    seed();
    for (let i = 0; i < 5; i++) add("completed");
    for (let i = 0; i < 3; i++) add("failed");
    expect((await step(at())).some((a) => a.rule === "failure_share")).toBe(true);
    add("failed", NOW + 1_000);
    expect(await step(at(NOW + 2_000))).toHaveLength(0);
    add("failed", NOW + 3_000);
    expect((await step(at(NOW + 4_000))).map((a) => a.rule)).toContain("failure_share");
    expect(await step(at(NOW + 5_000))).toHaveLength(0);
    // Six hours on, the held keys expire in both.
    add("failed", NOW + 6 * 3_600_000);
    await step(at(NOW + 6 * 3_600_000 + 1_000));
});

test("one wake contains all alerting classes and uses the persisted watermark", async () => {
    seed();
    add("failed", NOW - 1_000, "permission denied 17");
    add("timed_out", NOW - 500, "network timeout 2 seconds");
    const alerts = await step(at());
    expect(alerts.map((alert) => alert.rule)).toEqual(["new_class", "new_class"]);
    expect(digests).toHaveLength(1);
    expect(digests[0]?.item.body).toContain("network timeout");
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 2 } });
});

test("watermark resumes equal timestamps by id and bounds a backlog", async () => {
    seed();
    for (let i = 0; i < 503; i++) add("completed");
    const first = await runFlow(at());
    await runOld(at());
    expect(first.bounded).toBe(true);
    expect(kvStore.get("state")).toEqual(JSON.parse(readFileSync(join(root, "state.json"), "utf8")));
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 500 } });
    await step(at());
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 503 } });
});

// ---- Cases the script's suite does not cover ----

test("a first run without state starts five minutes back, as the script did", async () => {
    add("failed", NOW - 1_000, "permission denied 17");
    expect(await step(NOW)).toHaveLength(0);
    expect(kvStore.get("state")).toMatchObject({ cursor: { ended_at: NOW - SETTLE, id: 0 } });
    expect(await step(at())).toHaveLength(1);
});

test("a backlog of failures pages through both queries and still matches", async () => {
    seed();
    for (let i = 0; i < 520; i++) {
        add(i % 3 === 0 ? "failed" : "completed", NOW - 100_000 + i, `failure code ${i % 4} in /tmp/a/b`, `task-${i % 5}`);
    }
    await step(at());
    await step(at());
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 520 } });
    // Both history and new rows took several pages.
    expect(opCalls.filter((call) => call.query === "window" && call.before).length).toBeGreaterThan(1);
    expect(opCalls.filter((call) => call.query === "after_cursor").length).toBeGreaterThan(70);
});

test("a history over 5,000 rows holds back the window rules in both", async () => {
    seed();
    for (let i = 0; i < 5_001; i++) add("completed", NOW - 2 * DAY + i);
    add("failed", NOW - 1_000, "first failure of its kind");
    const flowed = await runFlow(at());
    const old = await runOld(at());
    expect(flowed.history_read).toBe(true);
    expect(flowed.bounded).toBe(old.bounded);
    expect(flowed.bounded).toBe(true);
    expect(flowed.examined).toBe(old.examined);
    expect(flowed.alerts).toBe(old.alerts.length);
    expect(old.alerts.some((alert) => alert.rule === "new_class")).toBe(false);
});

test("an oversized wake keeps whole alerts within the digest body limit", async () => {
    seed();
    for (let i = 0; i < 30; i++) add("failed", NOW - 1_000 + i, `unique failure ${"x".repeat(400)} kind-${String.fromCharCode(97 + (i % 26))}${i}`, `task-${i}`);
    const result = await runFlow(at());
    expect(result.alerts).toBeGreaterThan(5);
    const [sent] = digests;
    expect(new TextEncoder().encode(sent!.item.body).length).toBeLessThanOrEqual(4096);
    expect(sent!.item.body).toMatch(/\(\d+ more alerts? not shown\)$/);
    expect(sent!.item.data.alerts).toBe(result.alerts);
});

test("a core without replace_key support still gets the wake", async () => {
    seed();
    add("failed", NOW - 1_000, "permission denied 17");
    await runFlow(at(), { replaceKeySupported: false });
    expect(digests).toHaveLength(1);
    expect(digests[0]?.options).toBeUndefined();
    expect(digests[0]?.action).toBe("wake");
});

test("a corrupt stored state stops the run instead of resetting the cursor", async () => {
    kvStore.set("state", { version: 2, cursor: { ended_at: 1, id: 1 }, sent: {} });
    await expect(runFlow(at())).rejects.toThrow("invalid failure sentinel state");
});

// ---- The evaluation alone, on generated rows ----

// A small deterministic generator, so a failure names a reproducible trial.
function generator(seed: number) {
    // Small seeds give small first values, so spread them before use.
    let value = (seed * 2_654_435) % 2_147_483_647;
    return (n: number) => {
        // Park-Miller: every product stays exact in a double.
        value = (value * 48_271) % 2_147_483_647;
        return Math.floor((value / 2_147_483_647) * n);
    };
}

type GeneratedCase = { rows: Row[]; fresh: Row[]; completeSince: number };
const GENERATED_ERRORS = [null, QUOTA, "rate limit hit after 20ms", "missing root at /a/b/c", "HTTP 429 too many requests", "boom code 7", "boom code 8", "Quota resets in 34h 34m 9s (request_id: 1a52d1e8-50cb"];

function generatedCases(trials: number): GeneratedCase[] {
    const statuses = ["completed", "completed", "failed", "timed_out", "empty", "aborted"];
    const cases: GeneratedCase[] = [];
    for (let trial = 1; trial <= trials; trial++) {
        const pick = generator(trial);
        const rows: Row[] = [];
        const count = 5 + pick(60);
        for (let id = 1; id <= count; id++) {
            const ended = NOW - pick(3 * DAY);
            const linked = rows.length && pick(4) === 0 ? rows[pick(rows.length)]!.id : null;
            const row: Row = {
                id, session_id: `s-${pick(4)}`, subagent: pick(5) ? "historian" : "dreamer",
                task: [null, "fallback", "historian", "classify"][pick(4)]!,
                started_at: ended - pick(200_000), ended_at: ended,
                status: statuses[pick(statuses.length)]!, error: GENERATED_ERRORS[pick(GENERATED_ERRORS.length)]!,
                parent_invocation_id: linked,
            };
            rows.push(row);
            // Often follow a failure with a fallback attempt: linked or not, finished or
            // failed, starting inside or outside the unlinked fallback's start window.
            if ((row.status === "failed" || row.status === "timed_out") && pick(2) === 0 && id < count) {
                id++;
                const started = row.ended_at - 6_000 + pick(130_000);
                rows.push({
                    id, session_id: pick(5) ? row.session_id : "s-other", subagent: row.subagent, task: "fallback",
                    started_at: started, ended_at: started + pick(60_000),
                    status: pick(3) ? "completed" : "failed", error: null,
                    parent_invocation_id: pick(2) ? row.id : null,
                });
            }
        }
        rows.sort((a, b) => b.ended_at - a.ended_at || b.id - a.id);
        const fresh = rows.filter((row) => row.ended_at > NOW - DAY && pick(2) === 0)
            .sort((a, b) => a.ended_at - b.ended_at || a.id - b.id);
        const completeSince = pick(3) === 0 ? NOW - pick(3 * DAY) : NOW - 7 * DAY;
        cases.push({ rows, fresh, completeSince });
    }
    return cases;
}
const byNumber = (a: number, b: number) => a - b;

test("evaluateFailures and recoveredByFallback agree on generated rows", () => {
    let alerted = 0;
    let recovered = 0;
    for (const { rows, fresh, completeSince } of generatedCases(300)) {
        const expectedRecovered = [...recoveredByFallback(rows)].sort(byNumber);
        expect([...flow.recoveredByFallback(rows)].sort(byNumber)).toEqual(expectedRecovered);
        const expected = evaluateFailures(rows, fresh, NOW, completeSince);
        expect(flow.evaluateFailures(rows, fresh, NOW, completeSince)).toEqual(expected);
        alerted += expected.length ? 1 : 0;
        recovered += expectedRecovered.length ? 1 : 0;
    }
    // The generated rows reach every outcome the comparison is meant to cover.
    expect(alerted).toBeGreaterThan(80);
    expect(alerted).toBeLessThan(280);
    expect(recovered).toBeGreaterThan(100);
});

// basal runs flows in QuickJS, not JavaScriptCore. This checks that the script
// parses as basal's async-function body there, and that its evaluation gives
// the script's results on the generated rows under QuickJS's own regex engine.
test("the flow parses and evaluates identically under QuickJS", async () => {
    const [{ default: variant }, { newQuickJSAsyncWASMModuleFromVariant }] = await Promise.all([
        import("@jitl/quickjs-singlefile-cjs-release-asyncify"),
        import("quickjs-emscripten"),
    ]);
    const quickjs = await newQuickJSAsyncWASMModuleFromVariant(variant);
    const vm = quickjs.newContext();
    try {
        const evaluate = (code: string): unknown => {
            const handle = vm.unwrapResult(vm.evalCode(code));
            try {
                return vm.dump(handle);
            } finally {
                handle.dispose();
            }
        };
        expect(evaluate(`typeof (async function (ops, kv, sink) {\n${FLOW_SOURCE}\n})`)).toBe("function");
        const cases = generatedCases(60);
        const pure = FLOW_SOURCE.slice(0, FLOW_SOURCE.indexOf(MAIN_MARKER));
        const answer = evaluate(`${pure}
            JSON.stringify(${JSON.stringify(cases)}.map((c) => ({
                alerts: evaluateFailures(c.rows, c.fresh, ${NOW}, c.completeSince),
                recovered: Array.from(recoveredByFallback(c.rows)).sort((a, b) => a - b),
            })).concat([${JSON.stringify(GENERATED_ERRORS)}.map(normalizeError)]))`) as string;
        const expected = [
            ...cases.map(({ rows, fresh, completeSince }) => ({
                alerts: evaluateFailures(rows, fresh, NOW, completeSince),
                recovered: [...recoveredByFallback(rows)].sort(byNumber),
            })),
            GENERATED_ERRORS.map(normalizeError),
        ];
        expect(JSON.parse(answer)).toEqual(JSON.parse(JSON.stringify(expected)));
    } finally {
        vm.dispose();
    }
});
