import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { providerSubjects } from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import { buildDriver, Driver, fixture, message, tools } from "./provider-pipeline-differential";
import { systemSample, psiDelta } from "./provider-post-rebuild-profile";
import { percentile } from "../../plugin/scripts/perf-audit/provider-pipeline-gate";

export async function residentFleetTiming(sessions = 75, historianHeld = false) {
    // The optional held mode disables background historian scheduling to measure
    // resident caches alone. The default measures serving with historians active.
    if (historianHeld) process.env.MC_TEST_HISTORIAN_HOLD = "1";
    else delete process.env.MC_TEST_HISTORIAN_HOLD;
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
    const root = join(tmpdir(), "magic-context", "resident-fleet-timing");
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, "run-"));
    mkdirSync(join(work, "stores"));
    const binary = buildDriver(join(work, "build"));
    let driver = new Driver(binary, join(work, "stores"));
    const rss = () => Number(readFileSync(`/proc/${driver.pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
    const peakRss = () => Number(readFileSync(`/proc/${driver.pid}/status`, "utf8").match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024;
    const activityHooks: number[] = [], activityFolds: number[] = [];
    try {
        const seedDirectory = join(work, "stores", "seed");
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
        let applied = { compaction_id: record.views.at(-1)!.compaction_id, version: record.views.at(-1)!.version };
        for (let sample = 0; sample < 2; sample++) {
            await f.event("realistic_visible_delta", { sample }); await f.event("flush");
            const reply = await f.call({ method: "compaction.step", params: { ...base, messages: [], request_id: `seed-${sample}`, step_id: `seed-${sample}`, last_applied: applied } });
            assert.equal(reply.answer, "compaction_message");
            applied = { compaction_id: reply.compaction.compaction_id, version: reply.compaction.version };
        }
        await f.call({ method: "compaction.step", params: { ...base, messages: [], request_id: "seed-ack", step_id: "seed-ack", last_applied: applied } });
        const plan = JSON.parse(record.state.plan_json!);
        const lineage = record.state.lineage_id;
        await f.call({ method: "transform.hook", params: { ...providerSubjects(history.at(-1)!)[0], session: "session", harness: "opencode",
            lineage_id: lineage, request_id: "seed-policy-summary", params: plan.params, preset: plan.preset, message: history.at(-1),
            subject_ordinal: 17_000, served_through_ordinal: 17_000, pass_complete: true } });
        await f.sql("VACUUM", true);
        await f.close();
        await driver.close();
        for (const name of ["store.db", "context.db"]) {
            const db = new Database(join(seedDirectory, name));
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            db.close();
        }
        driver = new Driver(binary, join(work, "stores"));
        await driver.send({ op: "create", rig: "baseline", harness: "opencode", resident_enabled: false });
        await driver.send({ op: "drop", rig: "baseline" });
        const baseline = rss();
        const seedBytes = Object.fromEntries(["store.db", "context.db"].map(name => [name, statSync(join(seedDirectory, name)).size]));
        console.log(`RESIDENT_FLEET_SEED=${JSON.stringify({ baseline_rss_bytes: baseline, seed_bytes: seedBytes })}`);
        const rows: unknown[] = [];
        const seedApplied = { ...applied };
        const makeRig = async (index: number, pool: string, cap: number) => {
            const directory = join(work, "stores", `${pool}-${index}`);
            mkdirSync(directory);
            // The seed is closed before copying. Each store owns real native
            // bodies, frozen facts, compartments, memories and view recipes.
            for (const name of ["store.db", "context.db"]) {
                const source = join(seedDirectory, name);
                assert.ok(existsSync(source), source);
                copyFileSync(source, join(directory, name));
            }
            const rig = `${pool}-${index}`;
            await driver.send({ op: "create", rig, harness: "opencode", directory, project_root: join(seedDirectory, "project"),
                memory_enabled: true, resident_enabled: true, resident_pool: pool, resident_process_cap_mb: cap });
            return rig;
        };
        const exercise = async (rig: string, index: number) => {
            const hook = { ...providerSubjects(history.at(-1)!)[0], session: "session", harness: "opencode", lineage_id: lineage,
                request_id: `fleet-hook-${index}`, params: plan.params, preset: plan.preset, message: history.at(-1),
                subject_ordinal: 17_000, served_through_ordinal: 17_000, pass_complete: true };
            const before = systemSample();
            const first = await driver.send({ op: "call", rig, timing: true, body: { method: "transform.hook", params: hook } });
            const slowRetry = first.error?.code === "transient" && first.error.message.startsWith("resident_not_ready: rebuild completed;");
            const accepted = slowRetry ? await driver.send({ op: "call", rig, timing: true, body: { method: "transform.hook", params: hook } }) : first;
            assert.ok(!accepted.error, JSON.stringify(accepted.error));
            const after = systemSample();
            await driver.send({ op: "event", rig, event: "flush" });
            const fold = await driver.send({ op: "call", rig, timing: true, body: { method: "compaction.step", params: {
                ...base, messages: [], request_id: `fleet-fold-${index}`, step_id: `fleet-fold-${index}`, last_applied: seedApplied } } });
            assert.ok(!fold.error, JSON.stringify(fold.error));
            if (accepted.historian_during) activityHooks.push(accepted.module_ms);
            if (fold.historian_during) activityFolds.push(fold.module_ms);
            return { first_hook_ms: first.module_ms, cold_slow_refusal: slowRetry, accepted_hook_ms: accepted.module_ms,
                fold_ms: fold.module_ms, cpu_ms: fold.cpu_ms, psi: psiDelta(before, after) };
        };
        let last = "";
        for (let index = 0; index < sessions; index++) {
            last = await makeRig(index, "fleet", 1024);
            rows.push({ index, ...await exercise(last, index), rss_bytes: rss() });
            if ((index + 1) % 10 === 0) console.log(`RESIDENT_FLEET_PROGRESS=${JSON.stringify({ sessions: index + 1, rss_bytes: rss() })}`);
        }
        const fleet = await driver.send({ op: "resident_stats", rig: last });
        assert.equal(fleet.sessions, sessions, "the shared pool must keep the fleet resident");
        const fleetRss = rss();
        const steadyHooks: number[] = [], steadyFolds: number[] = [];
        const steadyBefore = systemSample();
        for (let index=0;index<100;index++) {
            const hook = { ...providerSubjects(history.at(-1)!)[0], session:"session",harness:"opencode",lineage_id:lineage,
                request_id:`steady-hook-${index}`,params:plan.params,preset:plan.preset,message:history.at(-1),
                subject_ordinal:17_000,served_through_ordinal:17_000,pass_complete:true };
            const result = await driver.send({op:"call",rig:last,timing:true,body:{method:"transform.hook",params:hook}});
            assert.ok(!result.error,JSON.stringify(result.error));steadyHooks.push(result.module_ms);
            if (result.historian_during) activityHooks.push(result.module_ms);
        }
        for (let index=0;index<50;index++) {
            await driver.send({op:"event",rig:last,event:"realistic_visible_delta",sample:index});
            await driver.send({op:"event",rig:last,event:"flush"});
            const result = await driver.send({op:"call",rig:last,timing:true,body:{method:"compaction.step",params:{
                ...base,messages:[],request_id:`steady-fold-${index}`,step_id:`steady-fold-${index}`,last_applied:applied}}});
            assert.ok(!result.error,JSON.stringify(result.error));
            assert.equal(result.ok.answer,"compaction_message");
            applied={compaction_id:result.ok.compaction.compaction_id,version:result.ok.compaction.version};
            steadyFolds.push(result.module_ms);
            if (result.historian_during) activityFolds.push(result.module_ms);
        }
        const steadyAfter=systemSample();
        const steadyResident=await driver.send({op:"resident_stats",rig:last});
        assert.equal(steadyResident.sessions,sessions,"steady serving must retain all fleet sessions");
        const steady={hook_samples:steadyHooks.length,fold_samples:steadyFolds.length,
            hook_p50_ms:percentile(steadyHooks,.5),hook_p99_ms:percentile(steadyHooks,.99),
            fold_p50_ms:percentile(steadyFolds,.5),fold_p99_ms:percentile(steadyFolds,.99),
            rss_bytes:rss(),resident_sessions:steadyResident.sessions,charged_bytes:steadyResident.charged_bytes,
            evictions:sessions-steadyResident.sessions,before:steadyBefore,after:steadyAfter,psi:psiDelta(steadyBefore,steadyAfter)};
        const lowered: unknown[] = [];
        for (let index = 0; index < 3; index++) {
            const rig = await makeRig(index, "lowered", 64);
            lowered.push({ index, ...await exercise(rig, index + sessions), resident: await driver.send({ op: "resident_stats", rig }) });
        }
        const historian = await driver.send({ op: "historian_drain", rig: last });
        assert.equal(historian.active, 0);
        assert.equal(historian.queued, 0);
        assert.ok(historian.peak_active <= historian.concurrency);
        assert.ok(historian.peak_charged_mb <= historian.memory_mb);
        const historianActivity = { hook_samples: activityHooks.length, fold_samples: activityFolds.length,
            hook_p99_ms: activityHooks.length ? percentile(activityHooks, .99) : null,
            fold_p99_ms: activityFolds.length ? percentile(activityFolds, .99) : null };
        const result = { bun: Bun.version, cpus: availableParallelism(), sessions, historian_held: historianHeld, work, seed_bytes: seedBytes, baseline_rss_bytes: baseline,
            peak_rss_bytes: peakRss(), historian, historian_activity: historianActivity,
            fleet_rss_bytes: fleetRss, rss_growth_bytes: fleetRss - baseline, resident: fleet, steady, rows, lowered };
        console.log(`RESIDENT_FLEET_RESULT=${JSON.stringify(result)}`);
        return result;
    } finally { await driver.close(); }
}
if (import.meta.main) await residentFleetTiming(Number(Bun.argv[2] ?? 75), Bun.argv[3] === "held");
