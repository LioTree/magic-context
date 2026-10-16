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
if (import.meta.main) await pairedResidentTiming(Bun.argv[2]!);
