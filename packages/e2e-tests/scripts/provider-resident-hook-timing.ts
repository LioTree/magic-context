import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { providerSubjects } from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import { percentile } from "../../plugin/scripts/perf-audit/provider-pipeline-gate";
import { buildDriver, Driver, fixture, message, tools } from "./provider-pipeline-differential";
import { psiDelta, systemSample } from "./provider-post-rebuild-profile";

/** Normal restarts must serve inline; forced slow rebuilds use the unchanged 1.5 s hook budget. */
export async function residentHookTiming(samples = 100) {
    assert.ok(samples >= 5);
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
    process.env.MC_RESIDENT_HOOKS = "0";
    const root = join(tmpdir(), "magic-context", "resident-hook-timing");
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, "run-"));
    mkdirSync(join(work, "stores"));
    const binary = buildDriver(join(work, "build"));
    let driver = new Driver(binary, join(work, "stores"));
    const rows: Record<string, any>[] = [];
    const restarts: Record<string, any>[] = [];
    const memory: Record<string, any>[] = [];
    const rss = () => {
        const value = readFileSync(`/proc/${driver.pid}/status`, "utf8");
        return Number(value.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
    };
    try {
        for (const host of ["OpenCode1", "OpenCode2"] as const) {
            const directory = join(work, "stores", host);
            const f = await fixture(driver, host, directory, false, true);
            let hostClosed = false;
            const harness = host === "OpenCode1" ? "opencode" : "opencode2";
            try {
                updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4_000_000 });
                const history = Array.from({ length: 17_000 }, (_, i) => i % 5 === 0
                    ? message(`synthetic-${i}`, "user", `Fixture ${i}: café 🦀`)
                    : i % 5 === 4 ? message(`synthetic-${i}`, "assistant", `Fixture ${i} completed`)
                    : tools(`synthetic-${i}`));
                history.forEach((entry, i) => { (entry.info as any).absolute_ordinal = i + 1; });
                await f.full(history);
                await f.pass(history);
                await f.event("realistic_seed", { covered: 16_500, compartments: 2_300, memories: 1_000 });
                await f.full(history);
                await f.pass(history);
                const state = f.stored()!;
                const plan = JSON.parse(state.state.plan_json!);
                const last = history.at(-1)!;
                const ordinal = state.state.next_ordinal - 1;
                const makeHook = (entry: ReturnType<typeof message>, at: number) => ({
                    ...providerSubjects(entry)[0], session: "session", harness, request_id: `hook-${entry.info.id}`,
                    lineage_id: state.state.lineage_id, params: plan.params, preset: plan.preset,
                    message: entry, subject_mid: entry.info.id, subject_ordinal: at,
                    served_through_ordinal: ordinal,
                });
                const warm = await driver.send({ op: "call", rig: f.rig, timing: true, body: { method: "transform.hook", params: makeHook(last, ordinal) } });
                assert.ok(!warm.error, JSON.stringify(warm.error));
                const rigs = ["off", "on"].map(setting => `${host}-${setting}`);
                for (const [i, rig] of rigs.entries()) {
                    const branch = join(directory, i ? "on" : "off");
                    mkdirSync(branch);
                    await f.sql(`VACUUM INTO '${join(branch, "store.db").replaceAll("'", "''")}'`, true);
                    await driver.send({ op: "create", rig, harness, directory: branch, project_root: join(directory, "project"), memory_enabled: true, resident_enabled: i === 1 });
                }
                const beforeRss = rss();
                const firstEntry = message(`${host}-first`, "assistant", "first hook after process start");
                const firstRequest = { method: "transform.hook", params: makeHook(firstEntry, ordinal + 1) };
                const before = systemSample();
                const first = await driver.send({ op: "call", rig: rigs[1], timing: true, body: firstRequest });
                const after = systemSample();
                const refused = first.error?.code === "transient" && first.error.message.startsWith("resident_not_ready:");
                assert.ok(!first.error, `normal first-hook rebuild must serve inline: ${JSON.stringify(first.error)}`);
                const admitted = refused ? await driver.send({ op: "call", rig: rigs[1], timing: true, body: firstRequest }) : first;
                const control = await driver.send({ op: "call", rig: rigs[0], timing: true, body: firstRequest });
                assert.ok(!admitted.error, JSON.stringify(admitted.error));
                assert.equal(admitted.raw, control.raw, "rebuilt hook must equal today's path lexically");
                restarts.push({ host, first_module_ms: first.module_ms, first_cpu_ms: first.cpu_ms, refused,
                    retry_module_ms: admitted.module_ms, before, after, psi: psiDelta(before, after),
                    resident: await driver.send({ op: "resident_stats", rig: rigs[1] }), rss_before_bytes: beforeRss, rss_after_bytes: rss() });
                for (let sample = 0; sample < samples; sample++) {
                    const entry = message(`${host}-${sample}`, "assistant", `ordinary append ${sample}: café 🦀`);
                    const body = { method: "transform.hook", params: makeHook(entry, ordinal + sample + 2) };
                    const answers = [];
                    for (const i of sample % 2 ? [1, 0] : [0, 1]) {
                        const before = systemSample();
                        const answer = await driver.send({ op: "call", rig: rigs[i], timing: true, body });
                        const after = systemSample();
                        assert.ok(!answer.error, JSON.stringify(answer.error));
                        answers.push(answer.raw);
                        rows.push({ host, resident: i === 1, sample, module_ms: answer.module_ms, cpu_ms: answer.cpu_ms,
                            scheduler_wait_ms: answer.scheduler_wait_ms, db_acquire_ms: answer.db_acquire_ms,
                            db_callback_ms: answer.db_callback_ms, db_finish_ms: answer.db_finish_ms,
                            output_bytes: Buffer.byteLength(answer.raw), before, after, psi: psiDelta(before, after) });
                    }
                    assert.equal(answers[0], answers[1], "ordinary resident hook must equal today's raw response");
                }
                for (const sql of ["SELECT ordinal,block_id,policy_json FROM mc_provider_policy_parts_v1 ORDER BY ordinal,block_id", "SELECT answer_seq,ops_json,state FROM mc_provider_hook_answers_v1 ORDER BY answer_seq", "SELECT last_answer_json FROM mc_provider_conversations_v2"]) {
                    assert.deepEqual(await driver.send({ op: "sql", rig: rigs[1], sql }), await driver.send({ op: "sql", rig: rigs[0], sql }));
                }
                // Terminate the handler process, not merely its resident map. Each
                // branch reopens the same private database under a fresh handler.
                await f.close();
                hostClosed = true;
                await driver.close();
                driver = new Driver(binary, join(work, "stores"));
                for (const [i, rig] of rigs.entries()) await driver.send({ op: "create", rig, harness, directory: join(directory, i ? "on" : "off"), project_root: join(directory, "project"), memory_enabled: true, resident_enabled: i === 1 });
                const restartEntry = message(`${host}-restart`, "assistant", "after killing and reopening the module");
                const body = { method: "transform.hook", params: makeHook(restartEntry, ordinal + samples + 2) };
                const cold = await driver.send({ op: "call", rig: rigs[1], timing: true, body });
                assert.ok(!cold.error, `normal kill/reopen must serve first hook: ${JSON.stringify(cold.error)}`);
                const retry = cold.error ? await driver.send({ op: "call", rig: rigs[1], timing: true, body }) : cold;
                const oracle = await driver.send({ op: "call", rig: rigs[0], timing: true, body });
                assert.ok(!retry.error, JSON.stringify(retry.error));
                assert.equal(retry.raw, oracle.raw, "kill/reopen must rebuild the same hook bytes");
                restarts.push({ host, killed_and_reopened: true, first_module_ms: cold.module_ms, first_cpu_ms: cold.cpu_ms, refusal: cold.error, retry_module_ms: retry.module_ms, resident: await driver.send({ op: "resident_stats", rig: rigs[1] }) });
                const slowRig = `${host}-slow`;
                await driver.send({ op: "drop", rig: rigs[1] });
                await driver.send({ op: "create", rig: slowRig, harness, directory: join(directory, "on"), project_root: join(directory, "project"), memory_enabled: true, resident_enabled: true });
                const slowEntry = message(`${host}-slow`, "assistant", "slow rebuild retry");
                const slowBody = { method: "transform.hook", params: makeHook(slowEntry, ordinal + samples + 3) };
                const snapshot = "SELECT count(*) FROM mc_provider_messages_v1 UNION ALL SELECT count(*) FROM mc_provider_hook_answers_v1";
                const held = await driver.send({ op: "sql", rig: slowRig, sql: snapshot });
                await driver.send({ op: "resident_slow_once", rig: slowRig });
                const slow = await driver.send({ op: "call", rig: slowRig, timing: true, body: slowBody });
                assert.equal(slow.error?.code, "transient");
                assert.match(slow.error.message, /^resident_not_ready:/);
                assert.ok(slow.module_ms >= 1500);
                assert.deepEqual(await driver.send({ op: "sql", rig: slowRig, sql: snapshot }), held, "not-ready must not admit native bytes or allocate an answer");
                await driver.send({ op: "resident_clear_slow", rig: slowRig });
                const slowRetry = await driver.send({ op: "call", rig: slowRig, timing: true, body: slowBody });
                const slowControl = await driver.send({ op: "call", rig: rigs[0], timing: true, body: slowBody });
                assert.ok(!slowRetry.error, JSON.stringify(slowRetry.error));
                assert.equal(slowRetry.raw, slowControl.raw);
                restarts.push({ host, forced_slow: true, first_module_ms: slow.module_ms, refusal: slow.error, next_hook_ms: slowRetry.module_ms });
                await driver.send({ op: "drop", rig: slowRig });
                for (const rig of rigs) await driver.send({ op: "drop", rig });
                await driver.close();
                driver = new Driver(binary, join(work, "stores"));
                const lean = `${host}-lean`;
                await driver.send({ op: "create", rig: lean, harness, directory: join(directory, "on"), project_root: join(directory, "project"), resident_enabled: true });
                const baselineRss = rss();
                memory.push({ host, sessions: 0, rss_bytes: baselineRss });
                for (const sessions of [1, 10, 50]) {
                    const state = await driver.send({ op: "resident_lean_load", rig: lean, sessions });
                    memory.push({ host, sessions, rss_bytes: rss(), rss_delta_bytes: rss() - baselineRss, resident: state });
                }
                await driver.send({ op: "drop", rig: lean });
            } finally {
                if (!hostClosed) await f.close();
            }
        }
    } finally { await driver.close(); }
    const lanes = ["OpenCode1", "OpenCode2"].flatMap(host => [false, true].map(resident => {
        const values = rows.filter(row => row.host === host && row.resident === resident);
        return { host, resident, samples: values.length,
            module_p50_ms: percentile(values.map(row => row.module_ms), .5), module_p99_ms: percentile(values.map(row => row.module_ms), .99),
            cpu_p50_ms: percentile(values.map(row => row.cpu_ms), .5), cpu_p99_ms: percentile(values.map(row => row.cpu_ms), .99),
            over_10_ms: values.filter(row => row.module_ms > 10).length, output_bytes: values[0]?.output_bytes };
    }));
    const result = { bun: Bun.version, cpus: availableParallelism(), requested_cpus: "linux,4c", samples, shape: { compartments: 2300, memories: 1000, tail: 500, stored_lineage: 17000 }, lanes, restarts, memory, rows, work };
    console.log(`RESIDENT_HOOK_TIMING_RESULT=${JSON.stringify({ ...result, rows: `${rows.length} samples in output artifact` })}`);
    if (process.env.MC_TIMING_RESULT_OUT) writeFileSync(process.env.MC_TIMING_RESULT_OUT, `${JSON.stringify(result, null, 2)}\n`);
    return result;
}
if (import.meta.main) await residentHookTiming(Number(Bun.argv[2] ?? 100));
