import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "resident-independent-review-"));
const base = join(scratch, "base");
mkdirSync(base);
const archive = process.env.REVIEW_BASE_ARCHIVE ?? join(root, "review-tests/base.tar.gz");
const extracted = spawnSync("tar", ["-xf", archive, "-C", base], { encoding: "utf8" });
assert.equal(extracted.status, 0, extracted.stderr);
symlinkSync(join(root, "node_modules"), join(base, "node_modules"));
for (const name of readdirSync(join(base, "packages"))) {
    if (existsSync(join(root, "packages", name, "node_modules"))) symlinkSync(join(root, "packages", name, "node_modules"), join(base, "packages", name, "node_modules"));
}

// Each executable uses its revision's unmodified production sources; only the generated test driver is adjusted.
function build(source: string, name: string): string {
    const script = readFileSync(join(source, "packages/e2e-tests/scripts/provider-pipeline-differential.ts"), "utf8");
    let driver = script.split("const DRIVER = String.raw`")[1]!.split("`;\n")[0]!;
    assert.ok(driver.includes("fn provider_pipeline_driver()"));
    if (name === "base") {
        driver = driver.replace("let binding = SessionBinding {", "let binding = SessionBinding { connection_incarnation: 0, native_generation: None, principal: None,");
        driver = driver.replace("println!(\"PROVIDER_DRIVER={{\\\"ok\\\":{}}}\",String::from_utf8(bytes).unwrap());", "let raw = String::from_utf8(bytes).unwrap(); println!(\"PROVIDER_DRIVER={{\\\"ok\\\":{},\\\"raw\\\":{}}}\",raw,serde_json::to_string(&raw).unwrap());");
    }
    const overlay = join(scratch, name + "-build");
    mkdirSync(join(overlay, "crates/mc-module/src"), { recursive: true });
    const link = (from: string, to: string) => symlinkSync(from, to);
    for (const file of ["Cargo.toml", "Cargo.lock"]) copyFileSync(join(source, file), join(overlay, file));
    for (const folder of ["packages", "tests", "docs", "assets", "scripts", "testdata"]) link(join(source, folder), join(overlay, folder));
    for (const name of ["mc-core", "mc-store", "mc-tokenizer"]) link(join(source, "crates", name), join(overlay, "crates", name));
    for (const entry of readdirSync(join(source, "crates/mc-module"))) if (entry !== "src") link(join(source, "crates/mc-module", entry), join(overlay, "crates/mc-module", entry));
    for (const entry of readdirSync(join(source, "crates/mc-module/src"))) if (entry !== "lib.rs") link(join(source, "crates/mc-module/src", entry), join(overlay, "crates/mc-module/src", entry));
    const lib = readFileSync(join(source, "crates/mc-module/src/lib.rs"), "utf8");
    const driverPath = join(overlay, "crates/mc-module/src/review_driver.rs");
    writeFileSync(driverPath, driver);
    writeFileSync(join(overlay, "crates/mc-module/src/lib.rs"), lib.replace("mod tests {", `mod tests {\ninclude!(${JSON.stringify(driverPath)});`));
    const run = spawnSync("cargo", ["test", "--locked", "-p", "mc-module", "--lib", "--no-run", "--features", "drive-fault", "--message-format=json"], {
        cwd: overlay, env: { ...process.env, CARGO_PROFILE_TEST_OPT_LEVEL: "3", CARGO_TARGET_DIR: join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "resident-review", name) }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    const artifacts = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(run.status, 0, run.stderr + artifacts.filter(a => a.reason === "compiler-message").map(a => a.message.rendered).join("\n"));
    const binary = artifacts.find(a => a.reason === "compiler-artifact" && a.target.name === "mc_module" && a.executable)?.executable;
    assert.ok(binary);
    const saved = join(scratch, name + "-module-tests");
    copyFileSync(binary, saved);
    console.log(`BUILD ${name} ${saved}`);
    return saved;
}

const tipApi = await import("../packages/e2e-tests/scripts/provider-pipeline-differential");
const baseApi = await import(pathToFileURL(join(base, "packages/e2e-tests/scripts/provider-pipeline-differential.ts")).href);
const binaries = { base: build(base, "base"), tip: build(root, "tip") };
const stores = join(scratch, "stores");
mkdirSync(stores);
process.env.MC_RESIDENT_HOOKS = "0";
process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
const drivers = { base: new tipApi.Driver(binaries.base, stores), tip: new tipApi.Driver(binaries.tip, stores) };
const results: { name: string; passed: boolean; detail?: string }[] = [];
async function check(name: string, action: () => Promise<void>) {
    try { await action(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { const detail = String(error instanceof Error ? error.stack : error); results.push({ name, passed: false, detail }); console.error(`FAIL ${name}\n${detail}`); }
}
const bytes = (messages: unknown[]) => messages.map(m => JSON.stringify(m));
console.log(`Bun ${Bun.version}; ${spawnSync("cargo", ["--version"], { encoding: "utf8" }).stdout.trim()}`);
try {
    for (const host of ["OpenCode1", "OpenCode2"] as const) {
        const a = await baseApi.fixture(drivers.base, host);
        const b = await tipApi.fixture(drivers.tip, host);
        try {
            const history = Array.from({ length: 30 }, (_, i) => i % 3 === 0 ? tipApi.tools(`m-${i}`) : tipApi.message(`m-${i}`, i % 2 ? "assistant" : "user", `source ${i}: café 🦀 <opaque>\n`));
            for (const mode of ["provider", "full"] as const) {
                await check(`${host}/default-off-${mode}-bootstrap-and-append`, async () => {
                    for (const cut of [1, 5, 20, 30]) {
                        const old = mode === "provider" ? await a.pass(history.slice(0, cut)) : await a.full(history.slice(0, cut), "full-mode");
                        const current = mode === "provider" ? await b.pass(history.slice(0, cut)) : await b.full(history.slice(0, cut), "full-mode");
                        assert.deepEqual(bytes(current), bytes(old), `cut ${cut}`);
                    }
                });
            }
            await check(`${host}/default-off-publication-fold-delete-restart`, async () => {
                for (const f of [a, b]) { await f.event("publish", { start: 1, end: 5, mid: "m-4" }); f.deps.historyRefreshSessions.add("session"); }
                assert.deepEqual(bytes(await b.pass(history)), bytes(await a.pass(history)), "historian publication");
                for (const f of [a, b]) { await f.event("delete"); f.deps.historyRefreshSessions.add("session"); }
                assert.deepEqual(bytes(await b.pass(history)), bytes(await a.pass(history)), "dashboard deletion");
                await a.restartModule(); await b.restartModule();
                const appended = [...history, tipApi.message("after-restart")];
                assert.deepEqual(bytes(await b.pass(appended)), bytes(await a.pass(appended)), "module restart");
            });
            await check(`${host}/default-off-typescript-bytes`, async () => {
                const outputs: unknown[][] = [];
                for (const [source, f] of [[base, a], [root, b]] as const) {
                    const api = await import(pathToFileURL(join(source, "packages/plugin/src/hooks/magic-context/transform.ts")).href);
                    const transform = api.createTransform({ ...f.deps, transformMode: "ts", historianRunnable: false });
                    const out = { messages: structuredClone(history) };
                    try { await transform({ sessionID: "session" }, out); outputs.push(bytes(out.messages)); }
                    finally { transform.disposeRust(); }
                }
                assert.deepEqual(outputs[1], outputs[0]);
                assert.ok(outputs[0]!.length > 0, "the TypeScript transform must serve messages");
            });
        } finally { await a.close(); await b.close(); }
    }
    await check("Pi/default-off-typescript-bytes", async () => {
        const outputs = [base, root].map(source => {
            const run = spawnSync("bun", ["--tsconfig-override", join(source, "packages/pi-plugin/tsconfig.json"), join(root, "review-tests/pi-probe.ts"), source], { cwd: source, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
            assert.equal(run.status, 0, run.stderr);
            const output = run.stdout.split("\n").find(line => line.startsWith("PI_REVIEW="));
            assert.ok(output, run.stdout);
            return output;
        });
        assert.equal(outputs[1], outputs[0]);
    });
    await residentPairs();
    await check("base-binary/store-ahead-and-compact-tail-refuse-by-name", async () => {
        const directory = join(stores, "paired-OpenCode1/1");
        const database = join(directory, "store.db");
        const before = readFileSync(database);
        const old = spawnSync(binaries.base, ["--exact", "tests::provider_pipeline_driver", "--nocapture"], {
            input: JSON.stringify({ op: "create", rig: "old-reader", directory, harness: "opencode" }) + "\n", encoding: "utf8",
        });
        assert.notEqual(old.status, 0);
        assert.match(old.stderr, /StoreAheadOfBinary/);
        assert.match(old.stderr, /db_version: 72/);
        assert.match(old.stderr, /binary_max: 70/);
        assert.deepEqual(readFileSync(database), before, "older binary must not modify a migrated database");
        const copy = join(stores, "old-tail-reader"); mkdirSync(copy);
        const sql = new Database(database);
        try {
            const meta = sql.query("SELECT meta FROM mc_cache_state WHERE session_id='session'").get() as { meta: string };
            assert.ok(meta.meta.includes("mc_native_tail_v1"), "must test an actual compact tail");
            sql.exec(`VACUUM INTO '${join(copy, "store.db")}'`);
        } finally { sql.close(); }
        const downgraded = new Database(join(copy, "store.db"));
        // Remove newer migration records only in this copy, allowing the version-70 binary to reach its
        // separate rejection of cache metadata that contains the relocated tail_hygiene_baseline field.
        try { downgraded.exec("DELETE FROM cortexkit_schema_version WHERE namespace='mc_cache' AND version>70"); }
        finally { downgraded.close(); }
        const tail = spawnSync(binaries.base, ["--exact", "tests::provider_pipeline_driver", "--nocapture"], {
            input: [JSON.stringify({ op: "create", rig: "old-reader", directory: copy, harness: "opencode" }), JSON.stringify({ op: "inspect", rig: "old-reader" })].join("\n") + "\n", encoding: "utf8",
        });
        assert.notEqual(tail.status, 0);
        assert.match(tail.stderr, /tail_hygiene_baseline/);
        assert.match(tail.stderr, /cache state small blob carries .*tail_hygiene_baseline.*stored in its own rows/);
    });
} finally {
    await drivers.base.close(); await drivers.tip.close();
}
console.log(`RESIDENT_INDEPENDENT_RESULT=${JSON.stringify({ checks: results.length, passed: results.filter(r => r.passed).length, results, scratch })}`);
if (results.some(r => !r.passed)) process.exitCode = 1;

async function residentPairs() {
    const { providerSubjects } = await import("../packages/plugin/src/hooks/magic-context/host-runner/opencode-adapter");
    for (const host of ["OpenCode1", "OpenCode2"] as const) {
        const directory = join(stores, `paired-${host}`);
        const f = await tipApi.fixture(drivers.tip, host, directory, true, true);
        const harness = host === "OpenCode1" ? "opencode" : "opencode2";
        const arms = [`${host}-control`, `${host}-resident`];
        try {
            const history = Array.from({ length: 30 }, (_, i) => i % 3 ? tipApi.tools(`source-${i}`) : tipApi.message(`source-${i}`, "user", `source ${i} café 🦀`));
            await f.full(history);
            await f.pass(history);
            await f.event("publish", { start: 1, end: 5, mid: "source-4" });
            f.deps.historyRefreshSessions.add("session");
            await f.pass(history);
            const state = f.stored()!;
            const plan = JSON.parse(state.state.plan_json!);
            const baseStep = f.wires.filter(w => w.method === "compaction.step").at(-1)!.params;
            for (const [i, rig] of arms.entries()) {
                const branch = join(directory, String(i)); mkdirSync(branch);
                await f.sql(`VACUUM INTO '${join(branch, "store.db")}'`, true);
                const context = new Database(join(directory, "context.db"));
                try { context.exec(`VACUUM INTO '${join(branch, "context.db")}'`); } finally { context.close(); }
                await drivers.tip.send({ op: "create", rig, directory: branch, project_root: join(directory, "project"), harness, protect_bash: true, memory_enabled: true, resident_enabled: i === 1 });
            }
            const call = async (rig: string, body: unknown) => {
                const result = await drivers.tip.send({ op: "call", rig, body, raw_response: true });
                assert.ok(!result.error, JSON.stringify(result.error));
                assert.equal(typeof result.raw, "string", "compare original response bytes");
                return result;
            };
            let ordinal = state.state.next_ordinal;
            const makeHook = (name: string) => {
                const entry = tipApi.tools(name);
                return { method: "transform.hook", params: { ...providerSubjects(entry).filter(s => s.hook === "post_tool").at(-1)!,
                    session: "session", harness, request_id: name, lineage_id: state.state.lineage_id,
                    params: plan.params, preset: plan.preset, message: entry, subject_mid: name,
                    subject_ordinal: ordinal++, served_through_ordinal: ordinal - 2, pass_complete: true } };
            };
            const pair = async (name: string) => {
                const body = makeHook(name);
                assert.equal((await call(arms[1]!, body)).raw, (await call(arms[0]!, body)).raw, name);
                const counters = async (rig: string) => {
                    const rows = await drivers.tip.send({ op: "sql", rig, sql: "SELECT hook_counters_json FROM mc_provider_conversations_v2" });
                    return rows.map(([raw]: [string]) => {
                        const parsed = JSON.parse(raw);
                        // This timestamp uses each arm's wall clock, not served content or policy identity.
                        if (parsed.engine_policy?.baseline) parsed.engine_policy.baseline.computed_at_ms = 0;
                        return Object.fromEntries(Object.entries(parsed).filter(([key]) => !key.startsWith("historian_")));
                    });
                };
                assert.deepEqual(await counters(arms[1]!), await counters(arms[0]!), `${name}: durable hook policy`);
            };
            await check(`${host}/resident-cold-and-appended-hooks`, async () => {
                for (let i = 0; i < 12; i++) await pair(`append-${i}`);
                const stats = await drivers.tip.send({ op: "resident_stats", rig: arms[1] });
                assert.equal(stats.sessions, 1);
                assert.ok(stats.rebuilt_parts > 0, "cold hook must reconstruct real policy rows");
                assert.ok(stats.charged_bytes > 0 && stats.charged_bytes <= stats.session_cap);
            });
            for (const event of ["publish", "delete"] as const) {
                await check(`${host}/resident-after-${event}-writer-and-fold`, async () => {
                    for (const rig of arms) await drivers.tip.send({ op: "event", rig, event, start: 6, end: 10, mid: "source-9" });
                    await pair(`after-${event}`);
                    const body = { method: "compaction.step", params: { ...baseStep, messages: [], request_id: `fold-${event}`, step_id: `fold-${event}`,
                        prefix_rebuilding: { reason: "explicit_refresh" }, newest: { ordinal: ordinal - 1, mid: `after-${event}` }, served_through_ordinal: ordinal - 1 } };
                    delete (body.params as Record<string, unknown>).more;
                    const view = await call(arms[1]!, body);
                    assert.equal(view.ok.answer, "compaction_message", "must execute a fold, not compare no-op answers");
                    assert.equal(view.raw, (await call(arms[0]!, body)).raw);
                });
            }
            await check(`${host}/resident-model-switch-and-module-restart`, async () => {
                for (const rig of arms) await drivers.tip.send({ op: "restart", rig });
                await pair("restart-first");
                const body = { method: "compaction.step", params: { ...baseStep, messages: [], model: "openai/gpt-5.6-review-model", now: 2000,
                    request_id: "model-switch", step_id: "model-switch", prefix_rebuilding: { reason: "model_switch" },
                    newest: { ordinal: ordinal - 1, mid: "restart-first" }, served_through_ordinal: ordinal - 1 } };
                delete (body.params as Record<string, unknown>).more;
                const view = await call(arms[1]!, body);
                assert.equal(view.ok.answer, "compaction_message", "model switch must rebuild a view");
                assert.equal(view.raw, (await call(arms[0]!, body)).raw);
                await pair("after-model-switch");
            });
            await check(`${host}/resident-queued-drop-fold`, async () => {
                const tags = await drivers.tip.send({ op: "sql", rig: arms[0], sql: "SELECT tag_number FROM mc_tags WHERE session_id='session' AND kind='tool_result' ORDER BY tag_number LIMIT 1" });
                assert.equal(tags.length, 1, "queue a real existing tag");
                const drop = { name: "ctx_reduce", arguments: { session_id: "session", command_id: "review-queue", drop: String(tags[0][0]) } };
                for (const rig of arms) {
                    const result = await call(rig, drop);
                    assert.equal(result.ok.isError, false, "ctx_reduce must accept the real tag");
                }
                await pair("after-queued-drop");
                const body = { method: "compaction.step", params: { ...baseStep, messages: [], now: 3000, request_id: "queued-drop-fold", step_id: "queued-drop-fold",
                    prefix_rebuilding: { reason: "explicit_refresh" }, newest: { ordinal: ordinal - 1, mid: "after-queued-drop" }, served_through_ordinal: ordinal - 1 } };
                const view = await call(arms[1]!, body);
                assert.equal(view.ok.answer, "compaction_message");
                assert.equal(view.raw, (await call(arms[0]!, body)).raw);
            });
            await check(`${host}/resident-ctx-memory-writer-and-fold`, async () => {
                for (const rig of arms) {
                    const write = await call(rig, { name: "ctx_memory", arguments: { action: "write", content: "review memory original", category: "PROJECT_RULES", command_id: "memory-write" } });
                    assert.equal(write.ok.isError, false, JSON.stringify(write.ok));
                    const updated = await call(rig, { name: "ctx_memory", arguments: { action: "update", ids: [1], content: "review memory updated", command_id: "memory-update" } });
                    assert.equal(updated.ok.isError, false, JSON.stringify(updated.ok));
                }
                await pair("after-memory-update");
                const body = { method: "compaction.step", params: { ...baseStep, messages: [], now: 4000, request_id: "memory-fold", step_id: "memory-fold",
                    prefix_rebuilding: { reason: "explicit_refresh" }, newest: { ordinal: ordinal - 1, mid: "after-memory-update" }, served_through_ordinal: ordinal - 1 } };
                const view = await call(arms[1]!, body);
                assert.equal(view.ok.answer, "compaction_message");
                assert.equal(view.raw, (await call(arms[0]!, body)).raw);
                assert.ok(view.raw.includes("review memory updated"), "the fold must observe changed memory content");
                await pair("after-memory-fold");
            });
            await check(`${host}/resident-50-session-charge`, async () => {
                const stats = await drivers.tip.send({ op: "resident_lean_load", rig: arms[1], sessions: 50 });
                assert.equal(stats.sessions, 50);
                assert.ok(stats.charged_bytes > stats.sessions * 1000, "load real policy aggregates, not empty resident entries");
                assert.ok(stats.charged_bytes <= stats.process_cap);
                assert.ok(stats.charged_bytes <= stats.session_cap * 50);
                console.log(`RESIDENT_CHARGE ${host} ${JSON.stringify(stats)}`);
            });
        } finally {
            for (const rig of arms) await drivers.tip.send({ op: "drop", rig });
            await f.close();
        }
    }
}
