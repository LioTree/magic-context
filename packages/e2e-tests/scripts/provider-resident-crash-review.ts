import assert from "node:assert/strict";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildDriver, Driver } from "./provider-pipeline-differential";

const root = join(tmpdir(), "magic-context", "resident-all-lanes-review");
mkdirSync(root, { recursive: true });
const work = mkdtempSync(join(root, "crash-"));
const build = join(work, "build");
process.env.MC_PROVIDER_DRIVER_OPT_LEVEL = "0";
process.env.MC_PROVIDER_DRIVER_BUILD_DIR = build;
buildDriver(build);

// Park after the engine has committed but before the provider has published its
// answer and acknowledgement state. Instrument only the generated test overlay.
const overlay = join(build, "workspace");
const providers = join(overlay, "crates/mc-module/src/providers");
assert.ok(lstatSync(providers).isSymbolicLink());
rmSync(providers);
cpSync(resolve("crates/mc-module/src/providers"), providers, { recursive: true });
const source = join(providers, "compaction.rs");
let text = readFileSync(source, "utf8");
for (const [seam, result] of [
    ["record.finish_fold(store, &work.key, status, &template)?;", "result"],
    ["let engine_ms = engine_started.elapsed().as_secs_f64() * 1000.0;", "output"],
] as const) {
    assert.equal(text.split(seam).length, 2, `unique in-fold crash seam: ${seam}`);
    text = text.replace(seam, `if std::env::var("MC_PROVIDER_FAULT_POINT").as_deref() == Ok("ReviewFoldAfterEngine") {
        assert!(matches!(&${result}.answer, transform::compaction::Answer::Replacement(_)), "crash must interrupt a real replacement fold");
    }
    fault("ReviewFoldAfterEngine");\n    ${seam}`);
}
writeFileSync(source, text);
const moduleSource = join(providers, "mod.rs");
const moduleText = readFileSync(moduleSource, "utf8");
assert.equal(moduleText.split("debug_assert!(FAULT_POINTS.contains(&point));").length, 2);
writeFileSync(moduleSource, moduleText.replace("debug_assert!(FAULT_POINTS.contains(&point));",
    'debug_assert!(point == "ReviewFoldAfterEngine" || FAULT_POINTS.contains(&point));'));
const compiled = spawnSync("cargo", ["test", "--locked", "-p", "mc-module", "--lib", "--no-run", "--features", "drive-fault", "--message-format=json"], {
    cwd: overlay, env: { ...process.env, CARGO_PROFILE_TEST_OPT_LEVEL: "0" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout);
const binary = compiled.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line))
    .find(row => row.reason === "compiler-artifact" && row.target.name === "mc_module" && row.executable)?.executable;
assert.ok(binary, "Cargo must identify the instrumented test executable");

async function lane(harness: string, seed: number, resident: boolean) {
    const directory = join(work, `${harness}-${seed}-${resident}`);
    mkdirSync(directory);
    const claude = harness === "claude-code";
    const plan = { serializer_profile: claude ? "claude-code-anthropic" : "owned-broca", ...(claude ? { observation: "answer" } : {}) };
    let driver = new Driver(binary, directory);
    const call = async (method: string, params: any) => {
        const answer = await driver.send({ op: "call", rig: "r", raw_response: true, body: { method, params } });
        assert.ok(!answer.error, JSON.stringify(answer.error));
        return answer;
    };
    const create = async () => {
        await driver.send({ op: "create", rig: "r", harness: claude ? harness : "runner", attest_claude_code: claude,
            resident_enabled: resident, directory, project_root: join(work, `project-${harness}-${seed}`) });
        if (claude) await call("transform.declare", { session: "session", harness, params: plan, preset: "head" });
    };
    const status = { session: "session", harness, lineage_id: "L", model: "fixture", context_window: 100_000,
        step_id: "fold", step_kind: "user_turn", estimate: { request_tokens: 1000 }, newest: { ordinal: 100, mid: "synthetic-99" },
        ...(claude ? { served_through_ordinal: 100 } : {}) };
    try {
        await create();
        await call("compaction.setup", { session: "session", harness, lineage_id: "L", model: "fixture", context_window: 100_000,
            request_id: "setup", params: plan, preset: "head", composition: {}, now: 1 });
        const messages = Array.from({ length: 100 }, (_, i) => {
            const message = { role: "user", content: [{ type: "text", text: `Seed ${seed} source ${i}: café 🦀` }] };
            return { ordinal: i + 1, mid: `synthetic-${i}`, message, ...(claude ? { raw_message: JSON.stringify(message) } : {}) };
        });
        await call("compaction.step", { ...status, request_id: "bootstrap", messages, now: 2 });
        const namespace = (await driver.send({ op: "sql", rig: "r", sql: "SELECT engine_namespace FROM mc_provider_conversations_v2" }))[0][0];
        const event = async (event: string, extra = {}) => driver.send({ op: "event", rig: "r", namespace, event, ...extra });
        await event("realistic_seed", { covered: 80, compartments: 12, memories: 0 });
        await event("flush");
        const head = await call("compaction.step", { ...status, request_id: "head", messages: [], now: 3 });
        assert.equal(head.ok.answer, "compaction_message");
        const applied = { compaction_id: head.ok.compaction.compaction_id, version: head.ok.compaction.version };
        await event("realistic_visible_delta", { sample: seed % 7 });
        await event("flush");
        await driver.arm("ReviewFoldAfterEngine");
        await assert.rejects(call("compaction.step", { ...status, request_id: "killed", messages: [], now: 4, last_applied: applied }));
        assert.equal(driver.wasKilled, true, "must SIGKILL inside the fold, not accept an ordinary refusal");
        await driver.close();
        driver = new Driver(binary, directory);
        await create();
        const recovered = await call("compaction.step", { ...status, request_id: "recovery", messages: [], now: 5, last_applied: applied });
        const state = await driver.send({ op: "sql", rig: "r", sql: "SELECT lineage_id,version_high_water,last_answer_json FROM mc_provider_conversations_v2" });
        console.log(`CRASH_RECOVERY_LANE=${JSON.stringify({ harness, seed, resident, answer: recovered.ok.answer, version: recovered.ok.compaction?.version })}`);
        return { raw: recovered.raw, state };
    } finally { await driver.close(); }
}

let checks = 0;
for (const harness of ["broca", "claude-code"]) {
    for (const seed of [0x13a5, 0x72c0ffee, 0xdeadbeef]) {
        assert.deepEqual(await lane(harness, seed, true), await lane(harness, seed, false), `${harness} seed=${seed}: recovered bytes, receipts, acknowledgements`);
        checks++;
    }
}
console.log(`CRASH_REVIEW_RESULT=${JSON.stringify({ bun: Bun.version, checks, kills: checks * 2, work, point: "engine committed; provider answer unpublished" })}`);
