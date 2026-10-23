import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as tip from "./provider-pipeline-differential";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { percentile } from "../../plugin/scripts/perf-audit/provider-pipeline-gate";
import { systemSample, psiDelta } from "./provider-post-rebuild-profile";

type Host = "OpenCode1" | "OpenCode2";
type Lane = "base" | "tip";

// Each revision supplies its own driver source and fixtures. Ten-fold blocks
// alternate their order to expose shared-runner pressure without dropping samples.
export async function pairedResidentTiming(baseRoot: string) {
    process.env.MC_RESIDENT_HOOKS = "1";
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
    const base: typeof tip = await import(join(resolve(baseRoot), "packages/e2e-tests/scripts/provider-pipeline-differential.ts"));
    const root = join(tmpdir(), "magic-context", "resident-review-paired");
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, "run-"));
    const libraries = { base, tip };
    const binaries = {} as Record<Lane, string>;
    for (const lane of ["base", "tip"] as const) {
        process.env.MC_PROVIDER_DRIVER_BUILD_DIR = resolve("target", `provider-review-pair-${lane}`);
        binaries[lane] = libraries[lane].buildDriver(join(work, `build-${lane}`));
    }
    const blocks: Array<Record<string, any>> = [];
    const rows: Array<Record<string, any>> = [];
    for (const host of ["OpenCode1", "OpenCode2"] as const) {
        const create = async (lane: Lane) => {
            const library = libraries[lane];
            const directory = join(work, host, lane);
            mkdirSync(directory, { recursive: true });
            const driver = new library.Driver(binaries[lane], directory);
            const f = await library.fixture(driver, host, join(directory, "fixture"), false, true, true);
            updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4_000_000 });
            const history = Array.from({ length: 17_000 }, (_, i) => i % 5 === 0
                ? library.message(`synthetic-${i}`, "user", `Fixture ${i}: café 🦀`)
                : i % 5 === 4 ? library.message(`synthetic-${i}`, "assistant", `Fixture ${i} completed`)
                    : library.tools(`synthetic-${i}`));
            history.forEach((entry, i) => { (entry.info as any).absolute_ordinal = i + 1; });
            await f.full(history); await f.pass(history);
            await f.event("realistic_seed", { covered: 16_500, compartments: 2_300, memories: 1_000 });
            await f.full(history); await f.pass(history);
            const stored = f.stored()!;
            const params = f.wires.filter(wire => wire.method === "compaction.step").at(-1)!.params;
            let applied = { compaction_id: stored.views.at(-1)!.compaction_id, version: stored.views.at(-1)!.version };
            const fold = async (sample: number) => {
                await f.event("realistic_visible_delta", { sample: sample + 2 });
                await f.event("flush");
                const id = `pair-${lane}-${host}-${sample}`;
                const body = { method: "compaction.step", params: { ...params, messages: [], request_id: id, step_id: id,
                    model: params.model, now: 2000 + sample * 1000,
                    newest: { ordinal: stored.state.next_ordinal - 1, mid: history.at(-1)!.info.id },
                    served_through_ordinal: stored.state.next_ordinal - 1, last_applied: applied } };
                delete (body.params as any).more;
                delete (body.params as any).last_not_applied;
                const response = await driver.send({ op: "call", rig: f.rig, timing: true, body });
                assert.ok(!response.error, JSON.stringify(response.error));
                assert.equal(response.ok.answer, "compaction_message");
                applied = { compaction_id: response.ok.compaction.compaction_id, version: response.ok.compaction.version };
                return { sample, module_ms: response.module_ms, cpu_ms: response.cpu_ms,
                    scheduler_wait_ms: response.scheduler_wait_ms, db_acquire_ms: response.db_acquire_ms,
                    db_callback_ms: response.db_callback_ms, db_finish_ms: response.db_finish_ms };
            };
            return { f, driver, fold };
        };
        const sessions = { base: await create("base"), tip: await create("tip") };
        try {
            for (const lane of ["base", "tip"] as const) {
                await sessions[lane].fold(-2); await sessions[lane].fold(-1);
            }
            for (let block = 0; block < 5; block++) {
                const order: Lane[] = block % 2 === 0 ? ["base", "tip"] : ["tip", "base"];
                for (const lane of order) {
                    const before = systemSample();
                    for (let offset = 0; offset < 10; offset++) {
                        rows.push({ host, lane, block, ...await sessions[lane].fold(block * 10 + offset) });
                    }
                    const after = systemSample();
                    const entry = { host, lane, block, before, after, psi: psiDelta(before, after) };
                    blocks.push(entry);
                    console.log(`PAIRED_BLOCK=${JSON.stringify(entry)}`);
                }
            }
        } finally {
            for (const lane of ["base", "tip"] as const) {
                await sessions[lane].f.close();
                await sessions[lane].driver.close();
            }
        }
    }
    const lanes = (["OpenCode1", "OpenCode2"] as Host[]).flatMap(host => (["base", "tip"] as Lane[]).map(lane => {
        const selected = rows.filter(row => row.host === host && row.lane === lane);
        return { host, lane, samples: selected.length, p50_ms: percentile(selected.map(row => row.module_ms), .5),
            p95_ms: percentile(selected.map(row => row.module_ms), .95), p99_ms: percentile(selected.map(row => row.module_ms), .99),
            cpu_p50_ms: percentile(selected.map(row => row.cpu_ms), .5), over_250_ms: selected.filter(row => row.module_ms >= 250).length };
    }));
    const result = { bun: Bun.version, cpus: systemSample().nproc, base_root: baseRoot, work, lanes, blocks, rows };
    if (process.env.MC_PAIR_RESULT_OUT) writeFileSync(process.env.MC_PAIR_RESULT_OUT, JSON.stringify(result, null, 2) + "\n");
    console.log(`PAIRED_TIMING_RESULT=${JSON.stringify({ bun: result.bun, cpus: result.cpus, lanes })}`);
    return result;
}
/** Compare the same runner protocol with the startup switch off and on. */
export async function brocaResidentTiming(samples = 50, claude = false, driverBinary?: string) {
    assert.ok(samples >= 50, "fold p99 needs at least 50 samples");
    const root = join(tmpdir(), "magic-context", "broca-hook");
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, "broca-paired-"));
    const driver = new tip.Driver(driverBinary ?? tip.buildDriver(join(work, "build")), work);
    const rows: Array<{ lane: string; kind: string; sample: number; module_ms: number; cpu_ms: number;
        scheduler_wait_ms: number; db_acquire_ms: number; db_callback_ms: number; db_finish_ms: number; allocation_bytes?: number }> = [];
    const rigs = ["off", "on"] as const;
    const applied: Record<string, any> = {};
    const namespaces: Record<string, string> = {};
    const through = Number(process.env.MC_BROCA_HISTORY ?? 17_000);
    assert.ok(Number.isSafeInteger(through) && through >= 500);
    const hookOnly = process.env.MC_BROCA_HOOK_ONLY === "1";
    const harness = claude ? "claude-code" : "broca";
    const plan = { serializer_profile: claude ? "claude-code-anthropic" : "owned-broca", ...(claude ? { observation: "answer" } : {}) };
    const messages = Array.from({ length: through }, (_, i) => {
        const message = { role: i % 5 === 0 ? "user" : "assistant", content: [{ type: "text", text: `Fixture ${i}: café 🦀 exact source` }] };
        return { ordinal: i + 1, mid: `synthetic-${i}`, message, ...(claude ? { raw_message: JSON.stringify(message) } : {}) };
    });
    const status = { session: "session", harness, lineage_id: "L", step_id: "bench", step_kind: "user_turn", model: "fixture",
        context_window: 4_000_000, estimate: { request_tokens: 1000 }, newest: { ordinal: through, mid: messages.at(-1)!.mid } };
    const call = async (rig: string, method: string, params: any, timing = claude) => {
        const result = await driver.send({ op: "call", rig, timing, body: { method, params } });
        assert.ok(!result.error, JSON.stringify(result.error));
        return result;
    };
    const event = (rig: string, event: string, extra: Record<string, unknown> = {}) =>
        driver.send({ op: "event", rig, event, namespace: namespaces[rig], ...extra });
    const before = systemSample();
    const measurement = (lane: string, kind: string, sample: number, response: any) => ({ lane, kind, sample,
        module_ms: response.module_ms, cpu_ms: response.cpu_ms, scheduler_wait_ms: response.scheduler_wait_ms,
        db_acquire_ms: response.db_acquire_ms, db_callback_ms: response.db_callback_ms, db_finish_ms: response.db_finish_ms,
        allocation_bytes: response.allocation_bytes });
    try {
        for (const rig of rigs) {
            const directory = join(work, rig); mkdirSync(directory);
            await driver.send({ op: "create", rig, harness: claude ? "claude-code" : "runner", attest_claude_code: claude,
                directory, project_root: join(work, "project"), resident_enabled: rig === "on" });
            if (claude) await call(rig, "transform.declare", { session: "session", harness, params: plan, preset: "head" });
            await call(rig, "compaction.setup", { session: "session", harness, request_id: "setup", preset: "head",
                params: plan, composition: {}, model: "fixture", context_window: 4_000_000, lineage_id: "L", now: 1 });
            namespaces[rig] = (await driver.send({ op: "sql", rig, sql: "SELECT engine_namespace FROM mc_provider_conversations_v2" }))[0][0];
            if (claude) {
                // Native status pages must fit the ingress envelope even when the
                // stored transcript used by the benchmark is much larger.
                for (let from = 0; from < messages.length; from += 100) {
                    await call(rig, "compaction.step", { ...status, request_id: `bootstrap-${from}`,
                        messages: messages.slice(from, from + 100), more: from + 100 < messages.length, now: 2 });
                }
            } else await call(rig, "compaction.step", { ...status, request_id: "bootstrap", messages, now: 2 });
            await event(rig, "realistic_seed", { covered: through - 500, compartments: Math.round(through * 2300 / 17000), memories: 0 });
            await event(rig, "flush");
            const response = await call(rig, "compaction.step", { ...status, request_id: "seed", messages: [], now: 3 });
            assert.equal(response.ok.answer, "compaction_message");
            applied[rig] = { compaction_id: response.ok.compaction.compaction_id, version: response.ok.compaction.version };
        }
        for (let sample = -2; sample < samples; sample++) {
            const order = sample % 2 ? [...rigs].reverse() : rigs;
            const answers: string[] = [];
            for (const rig of order) {
                const subject = messages.at(-1)!;
                const hook = await call(rig, "transform.hook", { session: "session", harness, lineage_id: "L", step_id: `hook-${sample}`,
                    ...(claude ? { params: plan, hook: "post_assistant", subject_mid: subject.mid, subject_ordinal: through,
                        message: subject.message, raw_message: subject.raw_message,
                         blocks: [subject.message.content[0]!.text] } : { hook: "post_assistant", blocks: [`§999§ measured hook ${sample}: café 🦀`] }) }, true);
                if (hookOnly) {
                    answers.push(hook.raw);
                    if (sample >= 0) rows.push(measurement(rig, "hook", sample, hook));
                    continue;
                }
                await event(rig, "realistic_visible_delta", { sample: sample + 2 });
                await event(rig, "flush");
                const fold = await call(rig, "compaction.step", { ...status, request_id: `fold-${sample}`, messages: [],
                    now: 2000 + (sample + 2) * 1000, last_applied: applied[rig] }, true);
                assert.equal(fold.ok.answer, "compaction_message");
                applied[rig] = { compaction_id: fold.ok.compaction.compaction_id, version: fold.ok.compaction.version };
                answers.push(fold.raw);
                if (sample >= 0) {
                    rows.push(measurement(rig, "hook", sample, hook));
                    rows.push(measurement(rig, "fold", sample, fold));
                }
            }
            assert.equal(answers[0], answers[1], "paired runner folds must be byte-identical");
        }
        const lanes = rigs.flatMap(lane => (hookOnly ? ["hook"] : ["hook", "fold"]).map(kind => {
            const selected = rows.filter(row => row.lane === lane && row.kind === kind);
            return { lane, kind, samples: selected.length, p50_ms: percentile(selected.map(row => row.module_ms), .5),
                p99_ms: percentile(selected.map(row => row.module_ms), .99),
                cpu_p50_ms: percentile(selected.map(row => row.cpu_ms), .5),
                cpu_p99_ms: percentile(selected.map(row => row.cpu_ms), .99),
                scheduler_wait_p50_ms: percentile(selected.map(row => row.scheduler_wait_ms), .5),
                scheduler_wait_p99_ms: percentile(selected.map(row => row.scheduler_wait_ms), .99) };
        }));
        const resident = await driver.send({ op: "resident_stats", rig: "on" });
        const after = systemSample();
        const result = { bun: Bun.version, cpus: after.nproc, work, harness, history: through, lanes, rows, resident, before, after, psi: psiDelta(before, after) };
        if (process.env.MC_PAIR_RESULT_OUT) writeFileSync(process.env.MC_PAIR_RESULT_OUT, JSON.stringify(result, null, 2) + "\n");
        console.log(`ALL_LANES_PAIRED_TIMING_RESULT=${JSON.stringify({ bun: result.bun, cpus: result.cpus, harness, history: through, lanes })}`);
        console.log(`ALL_LANES_TIMING_DIAGNOSTICS=${JSON.stringify({ resident, psi: result.psi,
            cpu_pressure: { before: before.host_cpu_pressure, after: after.host_cpu_pressure },
            worst_resident_hook: rows.filter(row => row.lane === "on" && row.kind === "hook").sort((a, b) => b.module_ms - a.module_ms)[0],
            worst_resident_fold: rows.filter(row => row.lane === "on" && row.kind === "fold").sort((a, b) => b.module_ms - a.module_ms)[0] })}`);
        if (!hookOnly) assert.ok(lanes.find(row => row.lane === "on" && row.kind === "fold")!.p99_ms < 250, "resident fold p99 must stay below 250 ms");
        if (!hookOnly) assert.ok(lanes.find(row => row.lane === "on" && row.kind === "hook")!.cpu_p99_ms <= 10, "resident hook CPU p99 must stay at or under 10 ms");
        if (claude) assert.ok(lanes.find(row => row.lane === "on" && row.kind === "hook")!.p99_ms <= 10, "resident hook p99 must stay at or under 10 ms");
        return result;
    } finally { await driver.close(); }
}

if (import.meta.main) {
    if (Bun.argv[2] === "--broca" || Bun.argv[2] === "--claude") await brocaResidentTiming(Number(Bun.argv[3] ?? 50), Bun.argv[2] === "--claude");
    else await pairedResidentTiming(Bun.argv[2]!);
}
