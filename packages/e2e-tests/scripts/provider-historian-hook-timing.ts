import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { providerSubjects } from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import { buildDriver, Driver, fixture, message, tools } from "./provider-pipeline-differential";
import { systemSample, psiDelta } from "./provider-post-rebuild-profile";
import { percentile } from "../../plugin/scripts/perf-audit/provider-pipeline-gate";

const quantiles = (values: number[]) => values.length ? ({ samples: values.length,
    p50_ms: percentile(values, .5), p95_ms: percentile(values, .95), p99_ms: percentile(values, .99) }) : { samples: 0 };

/** One runner, one closed seed, three startup budgets. Never opens a live store. */
export async function historianHookTiming(sessions = 75, samples = 600) {
    assert.equal(process.platform, "linux");
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
    process.env.MC_PROVIDER_DRIVER_QUIET = "1";
    process.env.MC_TEST_HISTORIAN_HOLD = "1";
    const work = mkdtempSync(join(tmpdir(), "mc-historian-hooks-"));
    const stores = join(work, "stores");
    mkdirSync(stores);
    console.log("HISTORIAN_HOOK_BUILD=begin");
    const binary = buildDriver(join(work, "build"));
    console.log("HISTORIAN_HOOK_BUILD=end");
    const seedDirectory = join(stores, "seed");
    let driver = new Driver(binary, stores);
    const f = await fixture(driver, "OpenCode1", seedDirectory, false, true, true);
    updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4_000_000 });
    const history = Array.from({ length: 17_000 }, (_, i) => i % 5 === 0
        ? message(`synthetic-${i}`, "user", `Fixture ${i}: café 🦀`)
        : i % 5 === 4 ? message(`synthetic-${i}`, "assistant", `Fixture ${i} completed`) : tools(`synthetic-${i}`));
    history.forEach((entry, i) => { (entry.info as any).absolute_ordinal = i + 1; });
    await f.full(history); await f.pass(history);
    await f.event("realistic_seed", { covered: 16_500, compartments: 2_300, memories: 1_000 });
    await f.full(history); await f.pass(history);
    const record = f.stored()!;
    const base = f.wires.filter(wire => wire.method === "compaction.step").at(-1)!.params;
    const applied = { compaction_id: record.views.at(-1)!.compaction_id, version: record.views.at(-1)!.version };
    const plan = JSON.parse(record.state.plan_json!);
    const hook = { ...providerSubjects(history.at(-1)!)[0], session: "session", harness: "opencode",
        lineage_id: record.state.lineage_id, params: plan.params, preset: plan.preset, message: history.at(-1),
        subject_ordinal: 17_000, served_through_ordinal: 17_000, pass_complete: true };
    await f.call({ method: "transform.hook", params: { ...hook, request_id: "seed" } });
    await f.sql("VACUUM", true);
    await f.close(); await driver.close();
    for (const name of ["store.db", "context.db"]) {
        const db = new Database(join(seedDirectory, name));
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
    }
    const batches: unknown[] = [];
    for (const mode of ["held", "budget2", "budget1"] as const) {
        // Each fresh driver starts cold. The second batch uses only the caches
        // populated by the first batch, never a rebuild or an eviction.
        if (mode === "held") process.env.MC_TEST_HISTORIAN_HOLD = "1";
        else delete process.env.MC_TEST_HISTORIAN_HOLD;
        driver = new Driver(binary, stores);
        const cold: any[] = [];
        const coldBefore = systemSample();
        try {
            for (let index = 0; index < sessions; index++) {
                const rig = `fleet-${index}`;
                const directory = join(stores, `${mode}-${index}`);
                mkdirSync(directory);
                for (const name of ["store.db", "context.db"]) copyFileSync(join(seedDirectory, name), join(directory, name));
                await driver.send({ op: "create", rig, harness: "opencode", directory, project_root: join(seedDirectory, "project"),
                    memory_enabled: true, resident_enabled: true, resident_pool: "fleet", historian_concurrency: mode === "budget1" ? 1 : 2 });
                const first = await driver.send({ op: "call", rig, timing: true,
                    body: { method: "transform.hook", params: { ...hook, request_id: `cold-${index}` } } });
                cold.push(first);
                if (first.error) {
                    assert.ok(first.error.message.startsWith("resident_not_ready: rebuild completed;"), JSON.stringify(first));
                    const retry = await driver.send({ op: "call", rig, timing: true,
                        body: { method: "transform.hook", params: { ...hook, request_id: `retry-${index}` } } });
                    assert.ok(!retry.error, JSON.stringify(retry));
                }
            }
            const coldAfter = systemSample();
            const residentBefore = await driver.send({ op: "resident_stats", rig: "fleet-0" });
            assert.equal(residentBefore.sessions, sessions);
            await driver.send({ op: "historian_drain", rig: "fleet-0" });
            // Enable or hold background historian scheduling after residency is
            // established, then request evaluation of each stored completed pass.
            await driver.send({ op: "historian_mode", rig: "fleet-0", held: mode === "held" });
            if (mode !== "held") await driver.send({ op: "historian_requeue", rig: "fleet-0" });
            const warmBefore = systemSample();
            const warm: any[] = [];
            for (let index = 0; index < samples; index++) {
                await driver.send({ op: "settle", rig: "fleet-0" });
                const result = await driver.send({ op: "call", rig: `fleet-${index % sessions}`, timing: true,
                    body: { method: "transform.hook", params: { ...hook, request_id: `warm-${index}` } } });
                assert.ok(!result.error, JSON.stringify(result));
                assert.ok(result.hook_stages.cold_rebuild < 1, "warm hooks must not rebuild");
                warm.push(result);
                if ((index + 1) % 100 === 0) console.log(`HISTORIAN_HOOK_PROGRESS=${JSON.stringify({ mode, samples: index + 1 })}`);
            }
            const warmAfter = systemSample();
            const residentAfter = await driver.send({ op: "resident_stats", rig: "fleet-0" });
            assert.equal(residentAfter.rebuilt_parts, residentBefore.rebuilt_parts, "no warm rebuild");
            assert.equal(residentAfter.sessions, sessions, "no eviction");
            const active = warm.filter(row => row.historian_before.active > 0 || row.historian_after.active > 0);
            if (mode !== "held") assert.ok(active.length >= samples * .9, "warm batch must overlap admitted historians, not just queued work");
            const stageNames = Object.keys(warm[0].hook_stages);
            const stages = Object.fromEntries(stageNames.map(name => [name, quantiles(warm.map(row => row.hook_stages[name]))]));
            const stress: unknown[] = [];
            const foldApplied = new Map<string, typeof applied>();
            for (let index = 0; index < 4; index++) {
                const rig = `fleet-${sessions - 1 - index}`;
                const reply = await driver.send({ op: "call", rig, body: { method: "compaction.step", params: {
                    ...base, messages: [], request_id: `prime-fold-${index}`, step_id: `prime-fold-${index}`, last_applied: applied } } });
                assert.ok(!reply.error, JSON.stringify(reply));
                foldApplied.set(rig, reply.ok.answer === "compaction_message"
                    ? { compaction_id: reply.ok.compaction.compaction_id, version: reply.ok.compaction.version } : { ...applied });
            }
            for (const width of [8, 16]) {
                if (mode !== "held") await driver.send({ op: "historian_requeue", rig: "fleet-0" });
                const before = systemSample();
                const hooks: any[] = [], folds: any[] = [];
                for (let batch = 0; batch < 40; batch++) {
                    // Exercise compaction.step on four sessions separate from
                    // the hooks. Change their generated compartment prose before
                    // admitting the batch, so each fold must publish a new view.
                    for (let index = 0; index < 4; index++) await driver.send({ op: "event", rig: `fleet-${sessions - 1 - index}`,
                        event: "realistic_visible_delta", sample: width * 1000 + batch });
                    if (mode !== "held") await driver.send({ op: "historian_requeue", rig: "fleet-0" });
                    const calls = Array.from({ length: width + 4 }, (_, index) => ({ rig: `fleet-${index < width ? index : sessions - 1 - (index - width)}`,
                        body: index < width ? { method: "transform.hook", params: { ...hook, request_id: `stress-${width}-${batch}-${index}` } }
                            : { method: "compaction.step", params: { ...base, messages: [], request_id: `fold-${width}-${batch}-${index}`,
                                step_id: `fold-${width}-${batch}-${index}`, last_applied: foldApplied.get(`fleet-${sessions - 1 - (index - width)}`) } } }));
                    const result = await driver.send({ op: "concurrent_calls", calls });
                    for (const row of result.rows) {
                        if (row.kind === "transform.hook") assert.ok(row.hook_stages.cold_rebuild < 1, "stress hooks must not rebuild");
                        (row.kind === "transform.hook" ? hooks : folds).push(row);
                    }
                    result.rows.slice(width).forEach((row: any, index: number) => {
                        if (row.ok.answer === "compaction_message") foldApplied.set(`fleet-${sessions - 1 - index}`,
                            { compaction_id: row.ok.compaction.compaction_id, version: row.ok.compaction.version });
                    });
                    if ((batch + 1) % 10 === 0) console.log(`HISTORIAN_HOOK_STRESS_PROGRESS=${JSON.stringify({ mode, width, batches: batch + 1 })}`);
                }
                const after = systemSample();
                const overlap = hooks.filter(row => row.historian_before.active > 0 || row.historian_after.active > 0);
                if (mode !== "held") assert.ok(overlap.length > 0, "stress must include hooks overlapping admitted historians");
                const batch = { width, batches: 40, hook: quantiles(hooks.map(row => row.module_ms)),
                    active_hook: quantiles(overlap.map(row => row.module_ms)), fold: quantiles(folds.map(row => row.module_ms)),
                    submitted_to_response: quantiles(hooks.map(row => row.submitted_to_response_ms)),
                    stages: Object.fromEntries(stageNames.map(name => [name, quantiles(hooks.map(row => row.hook_stages[name]))])),
                    db_acquire: quantiles(hooks.map(row => row.db_acquire_ms)), db_callback: quantiles(hooks.map(row => row.db_callback_ms)),
                    db_finish: quantiles(hooks.map(row => row.db_finish_ms)), scheduler_wait: quantiles(hooks.map(row => row.scheduler_wait_ms)),
                    before, after, psi: psiDelta(before, after) };
                stress.push(batch);
                console.log(`HISTORIAN_HOOK_STRESS=${JSON.stringify({ mode, ...batch })}`);
            }
            const stats = await driver.send({ op: "historian_drain", rig: "fleet-0" });
            const batch = { mode, sessions, cold: quantiles(cold.map(row => row.module_ms)),
                cold_refusals: cold.filter(row => row.error).length, cold_before: coldBefore, cold_after: coldAfter,
                warm: quantiles(warm.map(row => row.module_ms)), active_warm: quantiles(active.map(row => row.module_ms)),
                stages, db_acquire: quantiles(warm.map(row => row.db_acquire_ms)),
                db_callback: quantiles(warm.map(row => row.db_callback_ms)), db_finish: quantiles(warm.map(row => row.db_finish_ms)),
                scheduler_wait: quantiles(warm.map(row => row.scheduler_wait_ms)),
                warm_before: warmBefore, warm_after: warmAfter, psi: psiDelta(warmBefore, warmAfter), historian: stats, stress,
                slowest_warm: [...warm].sort((a, b) => b.module_ms - a.module_ms).slice(0, 3).map(({ ok, raw, ...timing }) => timing),
                cold_stages: Object.fromEntries(stageNames.map(name => [name, quantiles(cold.map(row => row.hook_stages?.[name] ?? 0))])),
                cold_database: Object.fromEntries(["db_acquire_ms", "db_callback_ms", "db_finish_ms", "scheduler_wait_ms"].map(name =>
                    [name, quantiles(cold.filter(row => row[name] !== undefined).map(row => row[name]))])),
                slowest_cold: [...cold].sort((a, b) => b.module_ms - a.module_ms).slice(0, 3).map(({ ok, raw, ...timing }) => timing) };
            batches.push(batch);
            writeFileSync(join(work, `${mode}.json`), JSON.stringify({ batch, cold, warm }, null, 2));
            console.log(`HISTORIAN_HOOK_BATCH=${JSON.stringify(batch)}`);
        } finally { await driver.close(); }
    }
    const result = { bun: Bun.version, cpus: availableParallelism(), work, batches };
    if (process.env.MC_HOOK_TIMING_OUT) writeFileSync(process.env.MC_HOOK_TIMING_OUT, JSON.stringify(result, null, 2));
    console.log(`HISTORIAN_HOOK_RESULT=${JSON.stringify(result)}`);
    return result;
}
if (import.meta.main) await historianHookTiming(Number(Bun.argv[2] ?? 75), Number(Bun.argv[3] ?? 600));
