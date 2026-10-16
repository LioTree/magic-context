import { afterAll, beforeAll, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historianHookTiming } from "./provider-historian-hook-timing";
import { buildDriver } from "./provider-pipeline-differential";

if (process.env.MC_RUN_COLD_COMMIT_REGRESSION === "1" || process.env.MC_RUN_WAL_RESTART_REGRESSION === "1") {
    const priorBuildDirectory = process.env.MC_PROVIDER_DRIVER_BUILD_DIR;
    let buildRoot: string | undefined;
    beforeAll(() => {
        buildRoot = mkdtempSync(join(tmpdir(), "mc-wal-probe-build-"));
        process.env.MC_PROVIDER_DRIVER_BUILD_DIR = join(buildRoot, "build");
        // Compile the complete optimized Rust test binary once before timing
        // either fixture. A fresh overlay per probe recompiles the whole module,
        // consuming the case's runtime budget before it can check WAL behavior.
        const started = performance.now();
        buildDriver(process.env.MC_PROVIDER_DRIVER_BUILD_DIR);
        console.log(`WAL_PROBE_BUILD_MS=${(performance.now() - started).toFixed(1)}`);
    }, 600_000);
    afterAll(() => {
        if (priorBuildDirectory === undefined) delete process.env.MC_PROVIDER_DRIVER_BUILD_DIR;
        else process.env.MC_PROVIDER_DRIVER_BUILD_DIR = priorBuildDirectory;
        if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
    });
}

test.skipIf(process.platform !== "linux")("ordinary timing requires disjoint 16-hook and eight-fold sessions", async () => {
    const cold = process.env.MC_COLD_HOOK_ONLY;
    const warm = process.env.MC_WARM_WAL_PROBE;
    delete process.env.MC_COLD_HOOK_ONLY;
    delete process.env.MC_WARM_WAL_PROBE;
    try {
        await expect(historianHookTiming(23, 0)).rejects.toThrow(
            "16 hook sessions and eight fold sessions must be disjoint",
        );
    } finally {
        if (cold === undefined) delete process.env.MC_COLD_HOOK_ONLY;
        else process.env.MC_COLD_HOOK_ONLY = cold;
        if (warm === undefined) delete process.env.MC_WARM_WAL_PROBE;
        else process.env.MC_WARM_WAL_PROBE = warm;
    }
});

// Opt in because reproducing a realistic rebuild needs 17,000 messages and an
// optimized Rust driver build, rather than a cheap unit-test fixture.
const regression = process.env.MC_RUN_COLD_COMMIT_REGRESSION === "1" ? test : test.skip;
regression("restarted WAL sync delay is paid at startup, not by the first hook", async () => {
    process.env.MC_COLD_HOOK_ONLY = "1";
    process.env.MC_COLD_HOOK_PAIR = "1";
    process.env.MC_COLD_HOOK_SYNC_DELAY_MS = "1700";
    try {
        const result = await historianHookTiming(2, 0);
        expect(result.concurrent_timing_fleet_calls).toBe(0);
        expect(result.measurement_kind).toBe("direct_dispatch_wal_correctness");
        for (const batch of result.batches as any[]) {
            for (let index = 0; index < batch.rows.length; index++) {
                const row = batch.rows[index];
                const startup = batch.startup[index];
                expect(row.correctness_probe).toBe(true);
                expect(row.error).toBeUndefined();
                if (batch.lane.startsWith("after-")) {
                    expect(startup.startup_io.calls.injected_wal_sync_delay).toBe(1);
                    expect(row.commit_probe.calls.injected_wal_sync_delay ?? 0).toBe(0);
                    expect(row.module_ms).toBeLessThan(1500);
                } else {
                    expect(row.commit_probe.calls.injected_wal_sync_delay).toBe(1);
                    expect(row.module_ms).toBeGreaterThanOrEqual(1700);
                }
            }
        }
    } finally {
        delete process.env.MC_COLD_HOOK_ONLY;
        delete process.env.MC_COLD_HOOK_PAIR;
        delete process.env.MC_COLD_HOOK_SYNC_DELAY_MS;
    }
}, 300_000);

const restart = process.env.MC_RUN_WAL_RESTART_REGRESSION === "1" ? test : test.skip;
restart("warm hook after drained maintenance checkpoint does not sync a WAL header", async () => {
    process.env.MC_WARM_WAL_PROBE = "1";
    process.env.MC_WARM_WAL_PAIR = "1";
    try {
        const result = await historianHookTiming(5, 0);
        expect(result.concurrent_timing_fleet_calls).toBe(0);
        expect(result.measurement_kind).toBe("direct_dispatch_wal_correctness");
        for (const batch of result.batches as any[]) {
            expect(batch.drained.correctness_probe).toBe(true);
            expect(batch.checkpoint.checkpoint[1]).toBeGreaterThan(0);
            expect(batch.checkpoint.checkpoint[1]).toBe(batch.checkpoint.checkpoint[2]);
            const syncs = batch.drained.commit_probe.calls.wal_sync_flags_2 ?? 0;
            expect(syncs).toBe(batch.lane.startsWith("before-") ? 1 : 0);
        }
    } finally {
        delete process.env.MC_WARM_WAL_PROBE;
        delete process.env.MC_WARM_WAL_PAIR;
    }
}, 300_000);
