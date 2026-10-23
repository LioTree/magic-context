// Real SIGKILL of ck-mc's provider during a resident Claude Code fold, then
// restart and continue. A release-profile, fault-enabled test executable
// serves each lane; the non-resident oracle (test builds only) replays the same
// sequence, including the same kill, and every served byte must match it.
//
// Session classes: two transcripts taken from THALAMUS's committed G8 call
// traces (crates/mc-module/testdata/cc-g8) and one synthetic class whose
// queued agent drop rides the killed fold. The traces cannot be replayed
// call-for-call here: every recorded call carries a `claude_code` capability
// bundle pinned to a newer commons revision, which this build refuses. Only
// their recorded Claude Code messages are reused; folds are driven by seeded
// compartments, as in provider-resident-crash-review.ts.
//
// Kill points, all inside the resident fold of one compaction.step:
//   FoldDropsQueued  - queued drops reconciled, engine not yet run;
//   FoldAfterEngine  - engine ran and committed, view not yet built;
//   FoldBeforePublish - view built, resident lease not yet published.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDriver, Driver } from "./provider-pipeline-differential";

const ROOT = resolve(import.meta.dir, "../../..");
const root = join(tmpdir(), "magic-context", "resident-cc-kill-review");
mkdirSync(root, { recursive: true });
const work = mkdtempSync(join(root, "kill-"));
const build = join(work, "build");
// The first, unoptimized build only lays out the overlay workspace; the
// lanes run the release-profile executable compiled below.
process.env.MC_PROVIDER_DRIVER_OPT_LEVEL = "0";
process.env.MC_PROVIDER_DRIVER_BUILD_DIR = build;
buildDriver(build);

const overlay = join(build, "workspace");
const providers = join(overlay, "crates/mc-module/src/providers");
assert.ok(lstatSync(providers).isSymbolicLink());
rmSync(providers);
cpSync(join(ROOT, "crates/mc-module/src/providers"), providers, { recursive: true });
const compactionPath = join(providers, "compaction.rs");
let compaction = readFileSync(compactionPath, "utf8");
const KILL_POINTS = ["FoldDropsQueued", "FoldAfterEngine", "FoldBeforePublish"] as const;
for (const [point, seam] of [
    ["FoldDropsQueued", "let prepare_ms = started.elapsed().as_secs_f64() * 1000.0 - replay_ms;"],
    ["FoldAfterEngine", "let engine_ms = engine_started.elapsed().as_secs_f64() * 1000.0;"],
    ["FoldBeforePublish", "let publish_started = Instant::now();"],
] as const) {
    assert.equal(compaction.split(seam).length, 2, `unique in-fold kill seam: ${seam}`);
    // A resident lane may only be killed while it holds the session's resident
    // lease; otherwise the kill would not be "during a resident fold".
    compaction = compaction.replace(seam, `if std::env::var("MC_PROVIDER_FAULT_POINT").as_deref() == Ok(${JSON.stringify(point)}) {
        assert!(!work.resident_folds || resident.is_some(), "kill must interrupt a resident fold holding its lease");
        eprintln!("MC_KILL_REVIEW_LEASE resident_folds={} lease={}", work.resident_folds, resident.is_some());
    }
    fault(${JSON.stringify(point)});\n    ${seam}`);
}
writeFileSync(compactionPath, compaction);
const modPath = join(providers, "mod.rs");
const modText = readFileSync(modPath, "utf8");
const assertion = "debug_assert!(FAULT_POINTS.contains(&point));";
assert.equal(modText.split(assertion).length, 2);
writeFileSync(modPath, modText.replace(assertion,
    `debug_assert!(${KILL_POINTS.map(p => `point == ${JSON.stringify(p)}`).join(" || ")} || FAULT_POINTS.contains(&point));`));
// Let the driver queue an agent drop on the engine namespace, as ctx_reduce does.
const driverPath = join(overlay, "crates/mc-module/src/provider_pipeline_driver.rs");
const driverText = readFileSync(driverPath, "utf8");
const unknownEvent = 'other => panic!("unknown event {other}"),';
assert.equal(driverText.split(unknownEvent).length, 2);
writeFileSync(driverPath, driverText.replace(unknownEvent,
    `"queue_drop" => { rig.store.append_pending_agent_drops(namespace, &[cmd["target"].as_str().unwrap().to_string()], cmd["at"].as_i64().unwrap()).unwrap(); },\n                        ${unknownEvent}`));
const compiled = spawnSync("cargo", ["test", "--release", "--locked", "-p", "mc-module", "--lib", "--no-run",
    "--features", "drive-fault", "--message-format=json"], {
    cwd: overlay, env: { ...process.env, CARGO_TARGET_DIR: join(ROOT, "target", "cc-kill-review") },
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout.slice(-20000));
const binary = compiled.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line))
    .find(row => row.reason === "compiler-artifact" && row.target.name === "mc_module" && row.executable
        && row.profile?.opt_level === "3")?.executable;
assert.ok(binary, "Cargo must identify the release-profile instrumented test executable");

type Entry = { ordinal: number; mid: string; message: unknown; raw_message: string };
const mid = (ordinal: number) => `synthetic-${ordinal - 1}`;
// Recorded messages of one lineage keep their exact Claude Code bytes; only
// ordinals and MIDs are renumbered so the seeded compartments can name their
// boundaries. Mixing lineages would repeat forked tool exchanges.
function traceMessages(file: string, lineage: string): Entry[] {
    const trace = JSON.parse(readFileSync(join(ROOT, "crates/mc-module/testdata/cc-g8", file), "utf8"));
    const seen = new Map<string, Entry>();
    for (const call of trace.calls) {
        if (call.method !== "compaction.step" || call.params.lineage_id !== lineage) continue;
        for (const message of call.params.messages ?? [])
            seen.set(String(message.ordinal), message);
    }
    return [...seen.values()].sort((a, b) => a.ordinal - b.ordinal).map((message, index) => ({
        ordinal: index + 1, mid: mid(index + 1), message: message.message, raw_message: message.raw_message,
    }));
}
function userMessage(ordinal: number, text: string): Entry {
    const message = { role: "user", content: [{ type: "text", text }] };
    return { ordinal, mid: mid(ordinal), message, raw_message: JSON.stringify(message) };
}
function toolExchange(ordinal: number, label: string): Entry[] {
    const call = { role: "assistant", content: [{ type: "tool_use", id: `toolu_${label}`, name: "read", input: { path: label } }] };
    const result = { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${label}`,
        content: `${label} output: café 🦀` }] };
    return [
        { ordinal, mid: mid(ordinal), message: call, raw_message: JSON.stringify(call) },
        { ordinal: ordinal + 1, mid: mid(ordinal + 1), message: result, raw_message: JSON.stringify(result) },
    ];
}
function pad(entries: Entry[], total: number, label: string): Entry[] {
    const out = entries.map((entry, index) => ({ ...entry, ordinal: index + 1, mid: mid(index + 1) }));
    while (out.length < total) out.push(userMessage(out.length + 1, `${label} padding ${out.length + 1}: café 🦀`));
    // End on a user turn so every fold step is a user_turn step.
    out.push(userMessage(out.length + 1, `${label} final user turn`));
    return out;
}
const CLASSES = [
    { name: "g8-live", messages: pad(traceMessages("live-hooks.json", "L"), 80, "live"), drop: false },
    { name: "g8-synthetic", messages: pad(traceMessages("synthetic-hooks.json", "L3"), 80, "synthetic"), drop: false },
    // The queued drop names the tool result at ordinal 41, inside the summarized
    // range, and is queued after the first fold, so the killed fold is the pass
    // that consumes it. (On this lane a drop inside the retained tail makes both
    // paths serve the same refusal: a native cut must keep the original tail
    // bytes unchanged.)
    { name: "drop-rides-fold", messages: pad([...pad([], 39, "drop").slice(0, 39), ...toolExchange(40, "dropped")], 100, "drop"), drop: true },
];

async function lane(cls: (typeof CLASSES)[number], point: string, resident: boolean) {
    const directory = join(work, `${cls.name}-${point}-${resident}`);
    mkdirSync(directory);
    const harness = "claude-code";
    const plan = { serializer_profile: "claude-code-anthropic", observation: "answer" };
    let driver = new Driver(binary, directory);
    const call = async (method: string, params: Record<string, unknown>) => {
        const answer = await driver.send({ op: "call", rig: "r", raw_response: true, body: { method, params } });
        assert.ok(!answer.error, `${cls.name}/${point}/${resident} ${method}: ${JSON.stringify(answer.error)}`);
        return answer;
    };
    const sql = (statement: string) => driver.send({ op: "sql", rig: "r", sql: statement });
    const create = async () => {
        await driver.send({ op: "create", rig: "r", harness, attest_claude_code: true, resident_enabled: resident,
            directory, project_root: join(work, `project-${cls.name}`) });
        await call("transform.declare", { session: "session", harness, params: plan, preset: "head" });
    };
    let newest = cls.messages.length;
    const step = (id: string, now: number, messages: Entry[] = [], applied?: unknown) => ({
        session: "session", harness, lineage_id: "L", model: "fixture", context_window: 100_000,
        step_id: id, request_id: id, step_kind: "user_turn", estimate: { request_tokens: 1000 },
        newest: { ordinal: newest, mid: mid(newest) }, served_through_ordinal: newest, messages, now,
        ...(applied ? { last_applied: applied } : {}),
    });
    const appliedOf = (answer: any, fallback: unknown) => answer.ok.answer === "compaction_message"
        ? { compaction_id: answer.ok.compaction.compaction_id, version: answer.ok.compaction.version } : fallback;
    const dropTarget = `${mid(41)}#0`;
    try {
        await create();
        await call("compaction.setup", { session: "session", harness, lineage_id: "L", model: "fixture",
            context_window: 100_000, request_id: "setup", params: plan, preset: "head", composition: {}, now: 1 });
        await call("compaction.step", step("bootstrap", 2, cls.messages));
        const namespace = (await sql("SELECT engine_namespace FROM mc_provider_conversations_v2"))[0][0];
        const event = (name: string, extra = {}) => driver.send({ op: "event", rig: "r", namespace, event: name, ...extra });
        await event("realistic_seed", { covered: newest - 20, compartments: 12, memories: 0 });
        await event("flush");
        const head = await call("compaction.step", step("head", 3));
        assert.equal(head.ok.answer, "compaction_message", `${cls.name}: the first fold must replace: ${head.raw}`);
        let applied = appliedOf(head, null);
        if (cls.drop) await event("queue_drop", { target: dropTarget, at: 3 });
        const pendingBefore = (await sql(`SELECT count(*) FROM pending_agent_drops WHERE session_id='${namespace}'`))[0][0];
        await event("realistic_visible_delta", { sample: 3 });
        await event("flush");
        await driver.arm(point);
        await assert.rejects(call("compaction.step", step("killed", 4, [], applied)));
        assert.equal(driver.wasKilled, true, `${cls.name}/${point}: must SIGKILL inside the fold`);
        assert.ok(driver.faults.includes(point));
        await driver.close();
        driver = new Driver(binary, directory);
        await create();
        const served: string[] = [];
        const recovery = await call("compaction.step", step("recovery", 5, [], applied));
        served.push(recovery.raw);
        applied = appliedOf(recovery, applied);
        const pendingAfterRecovery = (await sql(`SELECT count(*) FROM pending_agent_drops WHERE session_id='${namespace}'`))[0][0];
        const appended = [userMessage(newest + 1, `${cls.name} continues 1`), userMessage(newest + 2, `${cls.name} continues 2`)];
        newest += 2;
        const append = await call("compaction.step", step("append", 6, appended, applied));
        served.push(append.raw);
        applied = appliedOf(append, applied);
        await event("realistic_visible_delta", { sample: 4 });
        await event("flush");
        const fold = await call("compaction.step", step("fold-after-restart", 7, [], applied));
        served.push(fold.raw);
        const state = {
            conversation: await sql("SELECT lineage_id,version_high_water,last_answer_json FROM mc_provider_conversations_v2"),
            pending: await sql(`SELECT target_id FROM pending_agent_drops WHERE session_id='${namespace}' ORDER BY target_id`),
            core: await sql(`SELECT core_state FROM mc_cache_state WHERE session_id='${namespace}'`),
        };
        const answers = served.map(raw => JSON.parse(raw).answer);
        assert.ok(answers.includes("compaction_message"), `${cls.name}/${point}: the continued session must fold: ${served.join("\n")}`);
        const dropMarkers = served.map(raw => raw.split("[dropped").length - 1);
        console.log(`CC_KILL_LANE=${JSON.stringify({ class: cls.name, point, resident, answers, pendingBefore,
            pendingAfterRecovery, dropMarkers, servedBytes: served.map(raw => raw.length),
            refusals: served.filter(raw => JSON.parse(raw).answer === "refuse") })}`);
        return { served, state, pendingBefore, pendingAfterRecovery, dropMarkers };
    } finally {
        await driver.close();
    }
}

let checks = 0;
// MC_KILL_REVIEW_CLASS narrows a rerun to one class; the full review runs all.
for (const cls of CLASSES.filter(c => !process.env.MC_KILL_REVIEW_CLASS || c.name === process.env.MC_KILL_REVIEW_CLASS)) {
    for (const point of KILL_POINTS) {
        const resident = await lane(cls, point, true);
        const oracle = await lane(cls, point, false);
        assert.deepEqual(resident, oracle, `${cls.name} ${point}: resident bytes and state must equal the non-resident oracle`);
        if (cls.drop) {
            assert.equal(resident.pendingBefore, 1, `${cls.name} ${point}: the drop must be queued before the killed fold`);
            assert.equal(resident.pendingAfterRecovery, 0, `${cls.name} ${point}: the recovered fold must consume the drop`);
        }
        // A drop applied twice would serve its marker more than once.
        for (const markers of resident.dropMarkers) assert.ok(markers <= 1, `${cls.name} ${point}: drop marker repeated`);
        assert.deepEqual(resident.state.pending, [], `${cls.name} ${point}: no drop may stay queued or be re-queued`);
        checks++;
    }
}
console.log(`CC_KILL_REVIEW_RESULT=${JSON.stringify({ bun: Bun.version, binary, checks, kills: checks * 2,
    classes: CLASSES.map(c => ({ name: c.name, messages: c.messages.length, drop: c.drop })), points: KILL_POINTS, work })}`);
