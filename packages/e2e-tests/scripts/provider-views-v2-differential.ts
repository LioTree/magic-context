/**
 * Served-byte comparison of Broca runner and Claude Code views stored as whole
 * copies (mc_provider_views_v1, the base revision) and as v2 recipes (this
 * revision), plus store size per lane on the paired 17,000-message fixture.
 *
 * Each revision builds its own Rust driver from its own sources through
 * provider-pipeline-differential.ts, then replays one command script. Every
 * module response is recorded as the literal UTF-8 bytes the handler returned
 * (`raw_response`), so the oracle is what a host would receive, not a
 * serialization of stored views. Rust never starts Bun; this outer Bun
 * process starts both Rust drivers.
 *
 * Run: bun packages/e2e-tests/scripts/provider-views-v2-differential.ts <base-root>
 * Environment: MC_VIEWS_V2_OUT (result JSON path), MC_VIEWS_V2_SIZE_HISTORY
 * (paired-fixture history length, default 17000), MC_VIEWS_V2_SIZE_FOLDS
 * (default 52), MC_VIEWS_V2_SKIP_SIZE=1 to compare bytes only,
 * MC_VIEWS_V2_ONLY=<lane name> to run one flow lane.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as tip from "./provider-pipeline-differential";

type Revision = "base" | "tip";
type Library = typeof tip;
type Entry = { label: string; raw: string };

const CLAUDE_PLAN = { serializer_profile: "claude-code-anthropic", observation: "answer" };

/**
 * Lexically unusual raw JSON: spacing, key order, escapes and non-ASCII text.
 * Whitespace between tokens avoids a literal newline: the driver protocol is
 * one JSON reply per line, and served raw bytes are forwarded verbatim.
 */
function claudeRaw(i: number, covered: number): string {
    // Messages after the covered boundary stay in the native tail of a hook
    // cut, which must be representable unchanged; the engine edits tool
    // exchanges there, so they appear only in the covered history.
    const kind = i < covered ? i % 6 : [0, 1, 2, 5][i % 4];
    switch (kind) {
        case 0:
            return `{ "content" : "Fixture ${i}: caf\\u00e9 \\"quoted\\" 🦀", "role":"user" }`;
        case 1:
            return `{"role":"assistant",\t "content":[{"text":"Answer ${i}: 雪\\n","type":"text"}]}`;
        case 2:
            return `{"content":[{"type":"text","text":"look ${i}"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}],"role":"user"}`;
        case 3:
            return `{"role":"assistant","content":[{"type":"tool_use","id":"call_${i}","name":"read","input":{"z":1,"path":"a\\tb","a":[true,null]}}]}`;
        case 4:
            return `{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_${i - 1}","content":[{"type":"text","text":"tool \\ud83e\\udd80 output ${i}"}]}]}`;
        default:
            return `{"role":"assistant","content":"Done ${i} \\/ ok"}`;
    }
}

/** Broca native messages: reasoning with signatures, redacted reasoning, tool exchanges. */
function brocaMessage(i: number): any {
    switch (i % 6) {
        case 0:
            return { role: "user", content: [{ type: "text", text: `Fixture ${i}: café "quoted" 🦀 \\ tab\t` }] };
        case 1:
            return { role: "assistant", content: [{ type: "reasoning", text: `think ${i}`, signature: `sig-${i}` }, { type: "text", text: `Answer ${i}: 雪\n` }] };
        case 2:
            return { role: "assistant", content: [{ type: "redacted_reasoning", data: `b3BhcXVl${i}` }, { type: "tool_call", tool_call_id: `call_${i}`, tool_name: "read", input: { z: 1, path: "a\tb", a: [true, null] } }] };
        case 3:
            return { role: "tool", content: [{ type: "tool_result", tool_call_id: `call_${i - 1}`, output: { kind: "text", text: `tool 🦀 output ${i}` }, is_error: false }] };
        case 4:
            return { role: "user", content: [{ type: "text", text: `Follow-up ${i}` }] };
        default:
            return { role: "assistant", content: [{ type: "text", text: `Done ${i}` }] };
    }
}

class Lane {
    readonly entries: Entry[] = [];
    namespace = "";
    constructor(readonly driver: any, readonly rig: string, readonly claude: boolean) {}
    get harness() {
        return this.claude ? "claude-code" : "broca";
    }
    async call(label: string, method: string, params: any): Promise<any> {
        const result = await this.driver.send({ op: "call", rig: this.rig, raw_response: true, body: { method, params } });
        const raw = result.raw ?? JSON.stringify(result.error ?? result);
        this.entries.push({ label, raw });
        return result.ok ?? { error: result.error };
    }
    event(event: string, extra: Record<string, unknown> = {}) {
        return this.driver.send({ op: "event", rig: this.rig, event, namespace: this.namespace, ...extra });
    }
    async readView(label: string, view: { view_id: string; version: number; sha256: string }) {
        let cursor = 0;
        for (let page = 0; ; page++) {
            const answer = await this.call(`${label}.page${page}`, "compaction.view.read", {
                request_id: `${label}-${page}`, view_id: view.view_id, version: view.version, sha256: view.sha256, byte_cursor: cursor,
            });
            if (answer.answer !== "page" || answer.next_byte_cursor === undefined) return;
            cursor = answer.next_byte_cursor;
        }
    }
    /** Read the full and cut payloads of a Claude compaction answer. */
    async readViews(label: string, answer: any) {
        const frozen = answer?.compaction?.raw_view;
        if (!this.claude || !frozen) return;
        await this.readView(`${label}.full`, frozen);
        if (frozen.cut_replacement_ref) await this.readView(`${label}.cut`, frozen.cut_replacement_ref);
    }
}

async function createLane(driver: any, rig: string, directory: string, claude: boolean, resident: boolean): Promise<Lane> {
    mkdirSync(directory, { recursive: true });
    await driver.send({ op: "create", rig, harness: claude ? "claude-code" : "runner", attest_claude_code: claude,
        directory, project_root: join(directory, "project"), resident_enabled: resident });
    return new Lane(driver, rig, claude);
}

function status(lane: Lane, through: number, request: string, extra: Record<string, unknown> = {}) {
    return { session: "session", harness: lane.harness, lineage_id: "L", step_id: request, step_kind: "user_turn", model: "fixture",
        context_window: 4_000_000, estimate: { request_tokens: 1000 }, newest: { ordinal: through, mid: `synthetic-${through - 1}` },
        request_id: request, now: 2, messages: [], ...extra };
}

async function bootstrap(lane: Lane, messages: any[], label: string) {
    if (lane.claude) {
        await lane.call(`${label}.declare`, "transform.declare", { session: "session", harness: lane.harness, params: CLAUDE_PLAN, preset: "head" });
    }
    await lane.call(`${label}.setup`, "compaction.setup", { session: "session", harness: lane.harness, request_id: "setup", preset: "head",
        params: lane.claude ? CLAUDE_PLAN : {}, composition: {}, model: "fixture", context_window: 4_000_000, lineage_id: "L", now: 1 });
    lane.namespace = (await lane.driver.send({ op: "sql", rig: lane.rig, sql: "SELECT engine_namespace FROM mc_provider_conversations_v2" }))[0][0];
    const through = messages.length;
    if (lane.claude) {
        for (let from = 0; from < through; from += 100) {
            await lane.call(`${label}.page${from}`, "compaction.step", status(lane, through, `bootstrap-${from}`,
                { messages: messages.slice(from, from + 100), more: from + 100 < through }));
        }
    } else {
        await lane.call(`${label}.bootstrap`, "compaction.step", status(lane, through, "bootstrap", { messages }));
    }
}

function history(claude: boolean, length: number, covered: number) {
    return Array.from({ length }, (_, i) => {
        if (!claude) return { ordinal: i + 1, mid: `synthetic-${i}`, message: brocaMessage(i) };
        const raw = claudeRaw(i, covered);
        return { ordinal: i + 1, mid: `synthetic-${i}`, message: JSON.parse(raw), raw_message: raw };
    });
}

/**
 * The flow: no fold, SOFT fold, HARD fold, a repeated unchanged tail, a hook
 * and its retry, not-applied then applied acknowledgements, a cold restart,
 * and Claude full/cut page reads of every served view.
 */
async function flow(lane: Lane) {
    const through = 600;
    const covered = 485;
    const messages = history(lane.claude, through, covered);
    await bootstrap(lane, messages, "bootstrap");
    const noFold = await lane.call("no-fold", "compaction.step", status(lane, through, "no-fold"));
    await lane.readViews("no-fold", noFold);
    // Coverage ends after a complete tool exchange, so the covered boundary
    // sits right after a tool result.
    await lane.event("realistic_seed", { covered, compartments: 40, memories: 0 });
    await lane.event("flush");
    const soft = await lane.call("soft", "compaction.step", status(lane, through, "soft"));
    await lane.readViews("soft", soft);
    const ack = (answer: any) => answer?.compaction ? { compaction_id: answer.compaction.compaction_id, version: answer.compaction.version } : undefined;
    let applied = ack(soft) ?? ack(noFold);
    // HARD: the request estimate sits in the emergency band.
    const hard = await lane.call("hard", "compaction.step", status(lane, through, "hard",
        { estimate: { request_tokens: 3_900_000 }, prefix_rebuilding: { reason: "expired_cache" }, ...(applied ? { last_applied: applied } : {}) }));
    await lane.readViews("hard", hard);
    const produced = ack(hard) ?? ack(soft);
    const repeat = await lane.call("repeat-tail", "compaction.step", status(lane, through, "repeat-tail", applied ? { last_applied: applied } : {}));
    await lane.readViews("repeat-tail", repeat);
    const subject = messages.at(-1)!;
    const hook = lane.claude
        ? { session: "session", harness: lane.harness, lineage_id: "L", step_id: "hook-1", params: CLAUDE_PLAN, hook: "post_assistant",
            subject_mid: subject.mid, subject_ordinal: through, message: subject.message, raw_message: subject.raw_message,
            blocks: ["Done 599 / ok"] }
        : { session: "session", harness: lane.harness, lineage_id: "L", hook: "post_assistant", step_id: "hook-1", blocks: ["§999§ hook café 🦀"] };
    await lane.call("hook", "transform.hook", hook);
    await lane.call("hook-retry", "transform.hook", hook);
    if (produced) {
        const notApplied = await lane.call("not-applied", "compaction.step", status(lane, through, "not-applied",
            { last_not_applied: { ...produced, reason: "host_declined" }, ...(applied ? { last_applied: applied } : {}) }));
        await lane.readViews("not-applied", notApplied);
        applied = ack(notApplied) ?? produced;
    }
    await lane.event("realistic_visible_delta", { sample: 3 });
    await lane.event("flush");
    const appliedStep = await lane.call("applied", "compaction.step", status(lane, through, "applied", applied ? { last_applied: applied } : {}));
    await lane.readViews("applied", appliedStep);
    // Earlier views that are still acknowledged roots remain readable.
    await lane.readViews("soft-again", soft);
    await lane.driver.send({ op: "restart", rig: lane.rig });
    let last = ack(appliedStep) ?? applied;
    if (lane.claude) {
        await lane.call("restart.declare", "transform.declare", { session: "session", harness: lane.harness, params: CLAUDE_PLAN, preset: "head" });
        const ready = await lane.call("restart.setup", "compaction.setup", { session: "session", harness: lane.harness, request_id: "setup-restart", preset: "head",
            params: CLAUDE_PLAN, composition: {}, model: "fixture", context_window: 4_000_000, lineage_id: "L", now: 3 });
        // Setup re-freezes the acknowledged view at a new version.
        if (ready?.initial) last = { compaction_id: ready.initial.compaction_id, version: ready.initial.version };
        await lane.readViews("restart.setup", { compaction: ready?.initial });
    }
    const cold = await lane.call("cold", "compaction.step", status(lane, through, "cold",
        { prefix_rebuilding: { reason: "expired_cache" }, ...(last ? { last_applied: last } : {}) }));
    await lane.readViews("cold", cold);
}

/** Logical bytes of each view table and the store file, read through SQL. */
async function storeSize(lane: Lane, directory: string) {
    const scalar = async (sql: string) => (await lane.driver.send({ op: "sql", rig: lane.rig, sql }))[0]?.[0] ?? null;
    const exists = async (table: string) => (await scalar(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='${table}'`)) > 0;
    const out: Record<string, unknown> = {};
    if (await exists("mc_provider_views_v1")) {
        out.v1_rows = await scalar("SELECT count(*) FROM mc_provider_views_v1");
        out.v1_replacement_json = await scalar("SELECT coalesce(sum(length(CAST(replacement_json AS BLOB))),0) FROM mc_provider_views_v1");
        out.v1_view_json = await scalar("SELECT coalesce(sum(length(CAST(view_json AS BLOB))),0) FROM mc_provider_views_v1");
    }
    out.v2_rows = await scalar("SELECT count(*) FROM mc_provider_views_v2");
    out.v2_view_meta_json = await scalar("SELECT coalesce(sum(length(CAST(view_meta_json AS BLOB))),0) FROM mc_provider_views_v2");
    out.v2_sequence_json = await scalar("SELECT coalesce(sum(length(CAST(sequence_json AS BLOB))),0) FROM mc_provider_views_v2");
    out.v2_new_head_history_bytes = await scalar("SELECT coalesce(sum(length(new_head_history_bytes)),0) FROM mc_provider_views_v2");
    out.v2_override_rows = await scalar("SELECT count(*) FROM mc_provider_view_overrides_v1");
    out.v2_override_patch_json = await scalar("SELECT coalesce(sum(length(CAST(patch_json AS BLOB))),0) FROM mc_provider_view_overrides_v1");
    out.native_message_bytes = await scalar("SELECT coalesce(sum(length(message_bytes)),0) FROM mc_provider_messages_v1");
    out.record_json = await scalar("SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM mc_provider_conversations_v2");
    await lane.driver.send({ op: "sql", rig: lane.rig, write: true, sql: "PRAGMA wal_checkpoint(TRUNCATE)" });
    out.store_db_bytes = statSync(join(directory, "store.db")).size;
    out.page_count = await scalar("PRAGMA page_count");
    out.freelist_pages = await scalar("PRAGMA freelist_count");
    return out;
}

/**
 * The size fixture of provider-resident-paired-timing.ts's Broca and Claude
 * lanes: 17,000 short text messages, all but the newest 500 covered by
 * compartments, then one fold per changed compartment.
 */
async function pairedSize(lane: Lane, directory: string, through: number, folds: number) {
    const messages = Array.from({ length: through }, (_, i) => {
        const message = { role: i % 5 === 0 ? "user" : "assistant", content: [{ type: "text", text: `Fixture ${i}: café 🦀 exact source` }] };
        return { ordinal: i + 1, mid: `synthetic-${i}`, message, ...(lane.claude ? { raw_message: JSON.stringify(message) } : {}) };
    });
    await bootstrap(lane, messages, "paired");
    await lane.event("realistic_seed", { covered: through - 500, compartments: Math.round(through * 2300 / 17000), memories: 0 });
    await lane.event("flush");
    let answer = await lane.call("paired.seed", "compaction.step", status(lane, through, "seed", { now: 3 }));
    let applied = { compaction_id: answer.compaction.compaction_id, version: answer.compaction.version };
    for (let sample = 0; sample < folds; sample++) {
        await lane.event("realistic_visible_delta", { sample: sample + 2 });
        await lane.event("flush");
        answer = await lane.call(`paired.fold${sample}`, "compaction.step", status(lane, through, `fold-${sample}`,
            { now: 2000 + sample * 1000, last_applied: applied }));
        assert.equal(answer.answer, "compaction_message", JSON.stringify(answer).slice(0, 400));
        applied = { compaction_id: answer.compaction.compaction_id, version: answer.compaction.version };
    }
    return storeSize(lane, directory);
}

/**
 * Claude's provider generation fingerprints records.rs, native_plan.rs,
 * native_view.rs and native_cut.rs, so the two revisions name different
 * generations. The compaction ID and the immutable view IDs are hashed from
 * the generation-keyed session, so they differ with it. Pair those tokens by order of first appearance
 * and substitute the tip's spelling into the base bytes; every other byte is
 * compared literally. The substitutions are reported.
 */
function generationTokens(entries: Entry[]): string[] {
    const tokens: string[] = [];
    for (const entry of entries) {
        for (const match of entry.raw.matchAll(/"provider_generation":"([^"]+)"|mc-native-view:[0-9a-f]{64}|"mc-[0-9a-f]{64}"/g)) {
            const token = match[1] ?? match[0];
            if (!tokens.includes(token)) tokens.push(token);
        }
    }
    return tokens;
}

/**
 * Equal bytes prove nothing if both runs used the same view writer, for
 * example because both drivers were the same executable. Check the stores:
 * the base revision must have written whole-copy v1 views and the tip only
 * v2 recipes.
 */
async function assertWriter(lane: Lane, revision: Revision) {
    const scalar = async (sql: string) => (await lane.driver.send({ op: "sql", rig: lane.rig, sql }))[0]?.[0] ?? null;
    const v1Table = await scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='mc_provider_views_v1'");
    const v1 = v1Table > 0 ? await scalar("SELECT count(*) FROM mc_provider_views_v1") : null;
    const v2 = await scalar("SELECT count(*) FROM mc_provider_views_v2");
    const profiles = await lane.driver.send({ op: "sql", rig: lane.rig, sql: "SELECT DISTINCT serializer_profile FROM mc_provider_views_v2" });
    if (revision === "base") assert.ok(v1 > 0 && v2 === 0, `base must write v1 views: v1=${v1} v2=${v2}`);
    else assert.ok(v1 === null && v2 > 0, `tip must write only recipes: v1=${v1} v2=${v2}`);
    return { v1_rows: v1, v2_rows: v2, v2_profiles: profiles.map((row: any[]) => row[0]) };
}

function compare(name: string, base: Entry[], next: Entry[]) {
    const mismatches: Array<{ index: number; label: string; base_bytes: number; tip_bytes: number }> = [];
    const from = generationTokens(base);
    const to = generationTokens(next);
    const substitutions = from.map((token, at) => [token, to[at] ?? token] as const).filter(([a, b]) => a !== b);
    const normalize = (raw: string) => substitutions.reduce((text, [a, b]) => text.split(a).join(b), raw);
    const length = Math.max(base.length, next.length);
    for (let index = 0; index < length; index++) {
        const a = base[index];
        const b = next[index];
        if (!a || !b || a.label !== b.label || Buffer.compare(Buffer.from(normalize(a.raw), "utf8"), Buffer.from(b.raw, "utf8")) !== 0) {
            mismatches.push({ index, label: a?.label ?? b?.label ?? "?", base_bytes: a ? Buffer.byteLength(a.raw) : -1, tip_bytes: b ? Buffer.byteLength(b.raw) : -1 });
        }
    }
    const bytes = base.reduce((sum, entry) => sum + Buffer.byteLength(entry.raw), 0);
    const outcomes: Record<string, number> = {};
    for (const entry of base) {
        let answer = "unparsed";
        try { answer = JSON.parse(entry.raw).answer ?? "error"; } catch { /* keep the label */ }
        outcomes[answer] = (outcomes[answer] ?? 0) + 1;
    }
    const transcript = process.env.MC_VIEWS_V2_DEBUG === "1"
        ? next.map(entry => ({ label: entry.label, head: entry.raw.slice(0, 240) })) : undefined;
    return { name, responses: base.length, compared_utf8_bytes: bytes, outcomes, transcript,
        generation_tokens_substituted: { distinct: substitutions.length, base_tokens: from.length, tip_tokens: to.length }, mismatches };
}

export async function viewsV2Differential(baseRoot: string) {
    const base: Library = await import(join(resolve(baseRoot), "packages/e2e-tests/scripts/provider-pipeline-differential.ts"));
    const root = join(tmpdir(), "magic-context", "views-v2-broca-cc");
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, "run-"));
    const libraries: Record<Revision, Library> = { base, tip };
    const binaries = {} as Record<Revision, string>;
    for (const revision of ["base", "tip"] as const) {
        process.env.MC_PROVIDER_DRIVER_BUILD_DIR = resolve("target", `views-v2-driver-${revision}`);
        // Separate target directories: Cargo hashes path packages by their
        // workspace-relative path, so both overlays would share one executable.
        process.env.CARGO_TARGET_DIR = resolve("target", `views-v2-cargo-${revision}`);
        binaries[revision] = libraries[revision].buildDriver(join(work, `build-${revision}`));
    }
    assert.notEqual(binaries.base, binaries.tip, "each revision needs its own driver executable");
    const comparisons = [];
    const sizes: Record<string, unknown> = {};
    const writers: Record<string, unknown> = {};
    for (const claude of [false, true]) {
        for (const resident of [false, true]) {
            const name = `${claude ? "claude-code" : "broca-runner"}-resident-${resident ? "on" : "off"}`;
            if (process.env.MC_VIEWS_V2_ONLY && process.env.MC_VIEWS_V2_ONLY !== name) continue;
            // Both revisions run in the same directory: the project path is part
            // of every session key, and so of compaction and view identities.
            const lanes = {} as Record<Revision, Lane>;
            const directory = join(work, name);
            for (const revision of ["base", "tip"] as const) {
                rmSync(directory, { recursive: true, force: true });
                const driver = new libraries[revision].Driver(binaries[revision], directory);
                lanes[revision] = await createLane(driver, "flow", join(directory, "flow"), claude, resident);
                await flow(lanes[revision]);
                writers[`${name}-${revision}`] = await assertWriter(lanes[revision], revision);
                await driver.close();
                if (process.env.MC_VIEWS_V2_KEEP) cpSync(join(directory, "flow"), join(process.env.MC_VIEWS_V2_KEEP, name, revision), { recursive: true });
            }
            comparisons.push(compare(name, lanes.base.entries, lanes.tip.entries));
        }
        if (process.env.MC_VIEWS_V2_SKIP_SIZE === "1") continue;
        const through = Number(process.env.MC_VIEWS_V2_SIZE_HISTORY ?? 17_000);
        const folds = Number(process.env.MC_VIEWS_V2_SIZE_FOLDS ?? 52);
        const name = claude ? "claude-code-paired" : "broca-runner-paired";
        const lanes = {} as Record<Revision, Lane>;
        for (const revision of ["base", "tip"] as const) {
            const directory = join(work, name);
            rmSync(directory, { recursive: true, force: true });
            const driver = new libraries[revision].Driver(binaries[revision], directory);
            lanes[revision] = await createLane(driver, "paired", join(directory, "paired"), claude, false);
            sizes[`${name}-${revision}`] = await pairedSize(lanes[revision], join(directory, "paired"), through, folds);
            writers[`${name}-${revision}`] = await assertWriter(lanes[revision], revision);
            await driver.close();
        }
        comparisons.push(compare(name, lanes.base.entries, lanes.tip.entries));
    }
    const result = { bun: Bun.version, base_root: baseRoot, work, binaries, writers, comparisons, sizes };
    if (process.env.MC_VIEWS_V2_OUT) writeFileSync(process.env.MC_VIEWS_V2_OUT, JSON.stringify(result, null, 2) + "\n");
    console.log(`VIEWS_V2_DIFFERENTIAL=${JSON.stringify(result)}`);
    const failed = comparisons.filter(entry => entry.mismatches.length > 0);
    assert.equal(failed.length, 0, `served bytes differ: ${JSON.stringify(failed)}`);
    return result;
}

if (import.meta.main) await viewsV2Differential(Bun.argv[2]!);
