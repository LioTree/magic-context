import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { providerSubjects } from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import { percentile } from "../../plugin/scripts/perf-audit/provider-pipeline-gate";
import { buildDriver, Driver, fixture, message, tools } from "./provider-pipeline-differential";
import { psiDelta, systemSample } from "./provider-post-rebuild-profile";

/** Directly awaiting the real handler records misses; it does not enlarge the production host fence. */
export async function preparationTiming(samples = 100) {
    assert.ok(samples >= 5);
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
    const root = join(tmpdir(), "magic-context", "provider-preparation-timing");
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, "run-"));
    mkdirSync(join(work, "stores"));
    const driver = new Driver(buildDriver(join(work, "build")), join(work, "stores"));
    const rows: { host: string; sample: number; request_id: string; before: ReturnType<typeof systemSample>; after: ReturnType<typeof systemSample>; psi: ReturnType<typeof psiDelta>; wall_ms: number }[] = [];
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
                let applied = { compaction_id: state.views.at(-1)!.compaction_id, version: state.views.at(-1)!.version };
                let newest = { ordinal: state.state.next_ordinal - 1, mid: history.at(-1)!.info.id };
                for (let sample = 0; sample < samples; sample++) {
                    await f.event("publish", { start: sample * 5 + 1, end: (sample + 1) * 5, mid: `synthetic-${(sample + 1) * 5 - 1}` });
                    await f.event("flush");
                    const model = `openai/gpt-5.6-preparation-timing-${sample}`;
                    const rebuildId = `rebuild-${host}-${sample}-${randomUUID()}`;
                    const status: Record<string, unknown> = { ...base, request_id: rebuildId, step_id: rebuildId, messages: [],
                        model, now: 2000 + sample * 1000, newest, last_applied: applied, served_through_ordinal: newest.ordinal,
                        prefix_rebuilding: { reason: "model_switch" }, consume_prepared_policy: true };
                    delete status.more; delete status.last_not_applied;
                    const rebuilt = await f.call({ method: "compaction.step", params: status });
                    assert.equal(rebuilt.answer, "compaction_message");
                    applied = { compaction_id: rebuilt.compaction.compaction_id, version: rebuilt.compaction.version };
                    const id = `probe-${host}-${sample}-${randomUUID()}`;
                    const entry = message(id, "assistant", `post-rebuild ${sample}: café 🦀`);
                    (entry.info as { model: { modelID: string } }).model.modelID = model.slice("openai/".length);
                    const subject = providerSubjects(entry)[0]!;
                    const before = systemSample();
                    const start = performance.now();
                    const answered = await f.call({ method: "transform.hook", params: { ...subject, session: "session",
                        harness: host === "OpenCode1" ? "opencode" : "opencode2", lineage_id: state.state.lineage_id,
                        request_id: id, params: plan.params, preset: plan.preset, message: entry, subject_mid: id,
                        subject_ordinal: newest.ordinal + 1, served_through_ordinal: newest.ordinal,
                        pass_complete: true, consume_prepared_policy: true } });
                    const wall_ms = performance.now() - start;
                    const after = systemSample();
                    assert.equal(answered.answer, "ops");
                    const row = { host, sample, request_id: id, before, after, psi: psiDelta(before, after), wall_ms };
                    rows.push(row);
                    console.log(`PREPARATION_TIMING_SAMPLE=${JSON.stringify(row)}`);
                    newest = { ordinal: newest.ordinal + 1, mid: id };
                }
                await f.noReads();
            } finally { await f.close(); }
        }
    } finally { await driver.close(); }
    const complete = rows.map(row => {
        const timings = driver.moduleCompletions.filter(value => value.request_id === row.request_id && value.method === "transform.hook");
        const outcomes = driver.preparationOutcomes.filter(value => value.request_id === row.request_id);
        assert.equal(timings.length, 1, "issued hook needs its module-only completion timing");
        assert.equal(outcomes.length, 1, "each measured hook needs a consumption outcome");
        return { ...row, module_ms: timings[0]!.module_ms, consumed: outcomes[0]!.consumed,
            over_product_fence: row.wall_ms >= 1500 };
    });
    const lanes = ["OpenCode1", "OpenCode2"].map(host => {
        const values = complete.filter(row => row.host === host);
        return { host, samples: values.length, consumed: values.filter(row => row.consumed).length,
            module_p50_ms: percentile(values.map(row => row.module_ms), .5), module_p99_ms: percentile(values.map(row => row.module_ms), .99),
            wall_p50_ms: percentile(values.map(row => row.wall_ms), .5), wall_p99_ms: percentile(values.map(row => row.wall_ms), .99),
            over_product_fence: values.filter(row => row.over_product_fence).length };
    });
    assert.ok(lanes.every(lane => lane.consumed > 0), "timing must reach real consumption, not only cold fallback");
    const result = { schema: 1, samples: complete, lanes, base_messages: 17_000, cpu_request: "linux,4c", work, bun: Bun.version,
        setting: "rust_provider_preparation=true via real request control", product_hook_fence_ms: 1500,
        measurement_kind: "synthetic_real_handler_first_post_rebuild", quantile: "nearest-rank; report misses, do not exclude them" };
    console.log(`PREPARATION_TIMING_RESULT=${JSON.stringify(result)}`);
    return result;
}
if (import.meta.main) await preparationTiming(Number(Bun.argv[2] ?? 100));
