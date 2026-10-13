import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { providerSubjects } from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import { percentile } from "../../plugin/scripts/perf-audit/provider-pipeline-gate";
import { buildDriver, Driver, fixture, message, tools } from "./provider-pipeline-differential";
import { psiDelta, systemSample } from "./provider-post-rebuild-profile";
import { postRebuildProfile, type StageProfile } from "./provider-post-rebuild-profile";
import { encodeOpenCodeMessagesToCk } from "../../plugin/src/hooks/magic-context/module-wire";

/** Directly awaiting the real handler records misses; it does not enlarge the production host fence. */
export async function preparationTiming(samples = 100, diagnostic?: { driver: Driver; output: string; stores: string }) {
    assert.ok(samples >= 5);
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
    const root = join(tmpdir(), "magic-context", "provider-preparation-timing");
    mkdirSync(root, { recursive: true });
    const work = diagnostic ? join(diagnostic.stores, "..") : mkdtempSync(join(root, "run-"));
    if (!diagnostic) mkdirSync(join(work, "stores"));
    const driver = diagnostic?.driver ?? new Driver(buildDriver(join(work, "build")), join(work, "stores"));
    const fullRows: {host: string; sample: number; module_ms: number; wall_ms: number; before: ReturnType<typeof systemSample>; after: ReturnType<typeof systemSample>; psi: ReturnType<typeof psiDelta>}[] = [];
    const rows: { host: string; setting: boolean; sample: number; request_id: string; rebuild_id: string; rebuild_before: ReturnType<typeof systemSample>; before: ReturnType<typeof systemSample>; after: ReturnType<typeof systemSample>; rebuild_psi: ReturnType<typeof psiDelta>; psi: ReturnType<typeof psiDelta>; wall_ms: number; rebuild_wall_ms: number }[] = [];
    try {
        for (const host of ["OpenCode1", "OpenCode2"] as const) {
            const directory = join(work, "stores", host);
            const f = await fixture(driver, host, directory);
            try {
                updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4_000_000 });
                const history = Array.from({ length: 17_000 }, (_, i) => i % 5 === 0 ? message(`synthetic-${i}`, "user", `Inspect fixture ${i}: café 🦀`)
                    : i % 5 === 4 ? message(`synthetic-${i}`, "assistant", `Fixture ${i} complete`) : tools(`synthetic-${i}`));
                for (let warm = 0; warm < 3; warm++) await f.full(history);
                await f.pass(history);
                assert.equal(f.fallbacks.length, 0);
                const state = f.stored()!;
                const plan = JSON.parse(state.state.plan_json!);
                const base = f.wires.filter(w => w.method === "compaction.step").at(-1)!.params;
                const applied = { compaction_id: state.views.at(-1)!.compaction_id, version: state.views.at(-1)!.version };
                const newest = { ordinal: state.state.next_ordinal - 1, mid: history.at(-1)!.info.id };
                for (let sample = 0; sample < samples; sample++) {
                    await f.event("publish", { start: sample * 5 + 1, end: (sample + 1) * 5, mid: `synthetic-${(sample + 1) * 5 - 1}` });
                    await f.event("flush");
                    await driver.send({ op: "settle", rig: f.rig });
                    const model = `openai/gpt-5.6-preparation-timing-${sample}`;
                    const rebuildId = `rebuild-${host}-${sample}-${randomUUID()}`;
                    const status: Record<string, unknown> = { ...base, request_id: rebuildId, step_id: rebuildId, messages: [],
                        model, now: 2000 + sample * 1000, newest, last_applied: applied, served_through_ordinal: newest.ordinal,
                        prefix_rebuilding: { reason: "model_switch" } };
                    delete status.more; delete status.last_not_applied;
                    const id = `probe-${host}-${sample}-${randomUUID()}`;
                    const entry = message(id, "assistant", `post-rebuild ${sample}: café 🦀`);
                    (entry.info as { model: { modelID: string } }).model.modelID = model.slice("openai/".length);
                    const subject = providerSubjects(entry)[0]!;
                    const pass = { lineage_id: state.state.lineage_id, appended_ids: [id], model_key: model };
                    await f.sql(`UPDATE mc_provider_conversations_v2 SET hook_counters_json=json_set(hook_counters_json,'$.pass_context',json('${JSON.stringify(pass).replaceAll("'", "''")}'))`, true);
                    const request = { ...subject, session: "session",
                        harness: host === "OpenCode1" ? "opencode" : "opencode2", lineage_id: state.state.lineage_id,
                        request_id: id, params: plan.params, preset: plan.preset, message: entry, subject_mid: id,
                        subject_ordinal: newest.ordinal + 1, served_through_ordinal: newest.ordinal,
                        pass_complete: true };
                    // Each pair starts before rebuild from the same durable state.
                    // Alternate preparation off/on so neither always benefits from
                    // the other arm warming the filesystem and allocator caches.
                    const answers: string[][] = [];
                    for (const setting of sample % 2 === 0 ? [false, true, "full"] as const : ["full", true, false] as const) {
                        const branch = join(directory, `sample-${sample}-${setting}`);
                        mkdirSync(branch);
                        await f.sql(`VACUUM INTO '${join(branch, "store.db").replaceAll("'", "''")}'`, true);
                        const context = new Database(join(directory, "context.db"));
                        try { context.exec(`VACUUM INTO '${join(branch, "context.db").replaceAll("'", "''")}'`); }
                        finally { context.close(); }
                        const rig = `${host}-${sample}-${setting}`;
                        await driver.send({ op: "create", rig, directory: branch, project_root: join(directory, "project"), harness: request.harness });
                        try {
                            driver.proveIsolation();
                            if (setting === "full") {
                                const before = systemSample();
                                const start = performance.now();
                                const full = await driver.send({ op: "full", rig, timing: true, messages: history,
                                    ingress: encodeOpenCodeMessagesToCk(history), now: status.now, model, window: 4_000_000,
                                    extra: { request_id: rebuildId } });
                                const wall_ms = performance.now() - start;
                                const after = systemSample();
                                assert.ok(!full.error, JSON.stringify(full.error));
                                assert.equal(full.ok.status, "ok");
                                fullRows.push({host, sample, module_ms: full.module_ms, wall_ms, before, after, psi: psiDelta(before, after)});
                                continue;
                            }
                            const rebuild_before = systemSample();
                            const rebuildStart = performance.now();
                            const rebuilt = await driver.send({ op: "call", rig, raw_response: true, body: { method: "compaction.step", params: { ...status, consume_prepared_policy: setting } } });
                            const rebuild_wall_ms = performance.now() - rebuildStart;
                            assert.ok(!rebuilt.error, JSON.stringify(rebuilt.error));
                            assert.equal(rebuilt.ok.answer, "compaction_message");
                            const before = systemSample();
                            const start = performance.now();
                            const answered = await driver.send({ op: "call", rig, raw_response: true, body: { method: "transform.hook", params: { ...request, consume_prepared_policy: setting } } });
                            const wall_ms = performance.now() - start;
                            const after = systemSample();
                            assert.ok(!answered.error, JSON.stringify(answered.error));
                            assert.equal(answered.ok.answer, "ops");
                            assert.equal(typeof rebuilt.raw, "string");
                            assert.equal(typeof answered.raw, "string");
                            answers.push([rebuilt.raw, answered.raw]);
                            const row = { host, setting, sample, request_id: id, rebuild_id: rebuildId, rebuild_before, before, after, rebuild_psi: psiDelta(rebuild_before, before), psi: psiDelta(before, after), wall_ms, rebuild_wall_ms };
                            rows.push(row);
                            console.log(`PREPARATION_TIMING_SAMPLE=${JSON.stringify(row)}`);
                        } finally {
                            await driver.send({ op: "drop", rig });
                            rmSync(branch, { recursive: true });
                        }
                    }
                    assert.deepEqual(answers[0], answers[1], "setting on/off exact rebuild and hook bytes differ");
                }
                await f.noReads();
            } finally { await f.close(); }
        }
    } finally { if (!diagnostic) await driver.close(); }
    const stageProfiles: StageProfile[] = diagnostic ? readFileSync(diagnostic.output, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    const complete = rows.map(row => {
        const timings = driver.moduleCompletions.filter(value => value.request_id === row.request_id && value.method === "transform.hook");
        const outcomes = driver.preparationOutcomes.filter(value => value.request_id === row.request_id);
        const rebuilds = driver.moduleCompletions.filter(value => value.request_id === row.rebuild_id && value.method === "compaction.step");
        const preparations = driver.preparationCompletions.filter(value => value.request_id === row.rebuild_id);
        assert.equal(timings.length, 2, "each pair needs both module-only hook timings");
        assert.equal(rebuilds.length, 2, "each pair needs both complete rebuild timings");
        assert.equal(outcomes.length, 1, "only the setting-on hook reports consumption");
        assert.equal(preparations.length, 1, "only the setting-on rebuild prepares");
        const at = row.setting === (row.sample % 2 !== 0) ? 0 : 1;
        const full = fullRows.find(value => value.host === row.host && value.sample === row.sample)!;
        const profiles = diagnostic ? {
            rebuild: stageProfiles.filter(value => value.request_id === row.rebuild_id)[at]!,
            hook: stageProfiles.filter(value => value.request_id === row.request_id)[at]!,
        } : undefined;
        if (diagnostic) {
            assert.ok(profiles?.rebuild && profiles?.hook, "both arms must execute diagnostic stages");
            for (const stage of ["engine", "replay", "view_build", "response_value", "response_encode", "view_store"])
                assert.equal(profiles.rebuild.calls[stage], 1, `exactly one measured ${stage}`);
        }
        return { ...row, module_ms: timings[at]!.module_ms, rebuild_module_ms: rebuilds[at]!.module_ms,
            full_module_ms: full.module_ms, full_wall_ms: full.wall_ms, rebuild_ratio: rebuilds[at]!.module_ms / full.module_ms, profiles,
            preparation_ms: row.setting ? preparations[0]!.preparation_ms : 0,
            consumed: row.setting && outcomes[0]!.consumed,
            over_product_fence: row.wall_ms >= 1500 };
    });
    const lanes = ["OpenCode1", "OpenCode2"].flatMap(host => [false, true].map(setting => {
        const values = complete.filter(row => row.host === host && row.setting === setting);
        return { host, setting, samples: values.length, consumed: values.filter(row => row.consumed).length,
            module_p50_ms: percentile(values.map(row => row.module_ms), .5), module_p99_ms: percentile(values.map(row => row.module_ms), .99),
            wall_p50_ms: percentile(values.map(row => row.wall_ms), .5), wall_p99_ms: percentile(values.map(row => row.wall_ms), .99),
            rebuild_module_p50_ms: percentile(values.map(row => row.rebuild_module_ms), .5), rebuild_module_p99_ms: percentile(values.map(row => row.rebuild_module_ms), .99),
            preparation_p50_ms: percentile(values.map(row => row.preparation_ms), .5), preparation_p99_ms: percentile(values.map(row => row.preparation_ms), .99),
            full_module_p50_ms: percentile(values.map(row => row.full_module_ms), .5), full_module_p99_ms: percentile(values.map(row => row.full_module_ms), .99),
            paired_ratio_p50: percentile(values.map(row => row.rebuild_ratio), .5), paired_ratio_p99: percentile(values.map(row => row.rebuild_ratio), .99),
            stage_quantiles: diagnostic ? Object.fromEntries(["rebuild", "hook"].map(kind => [kind,
                Object.fromEntries([...new Set(values.flatMap(row => Object.keys(row.profiles![kind as "rebuild" | "hook"].stages_ms)))].map(stage => [stage, {
                    p50_ms: percentile(values.map(row => row.profiles![kind as "rebuild" | "hook"].stages_ms[stage] ?? 0), .5),
                    p99_ms: percentile(values.map(row => row.profiles![kind as "rebuild" | "hook"].stages_ms[stage] ?? 0), .99),
                }]))])) : undefined,
            over_product_fence: values.filter(row => row.over_product_fence).length };
    }));
    assert.ok(lanes.filter(lane => lane.setting).every(lane => lane.consumed > 0), "timing must reach real consumption, not only cold fallback");
    const result = { schema: 2, samples: complete, full_samples: fullRows, lanes, base_messages: 17_000, cpu_request: "linux,4c", work, bun: Bun.version,
        setting: "rust_provider_preparation=false/true via real request control; same pre-rebuild snapshot", product_hook_fence_ms: 1500,
        measurement_kind: "synthetic_real_handler_first_post_rebuild", quantile: "nearest-rank; report misses, do not exclude them" };
    console.log(`PREPARATION_TIMING_RESULT=${JSON.stringify(result)}`);
    return result;
}
if (import.meta.main) {
    const samples = Number(Bun.argv[2] ?? 100);
    const result = Bun.argv.includes("--profile")
        ? await postRebuildProfile((driver, output, stores) => preparationTiming(samples, {driver, output, stores}))
        : await preparationTiming(samples);
    if (process.env.MC_TIMING_RESULT_OUT) writeFileSync(process.env.MC_TIMING_RESULT_OUT, JSON.stringify(result, null, 2) + "\n");
}
