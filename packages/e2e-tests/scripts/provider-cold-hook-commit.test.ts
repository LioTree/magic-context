import { test, expect } from "bun:test";
import { historianHookTiming } from "./provider-historian-hook-timing";

// Opt in because reproducing a realistic rebuild needs 17,000 messages and an
// optimized Rust driver build, rather than a cheap unit-test fixture.
const regression = process.env.MC_RUN_COLD_COMMIT_REGRESSION === "1" ? test : test.skip;
regression("restarted WAL sync delay is paid at startup, not by the first hook", async () => {
    process.env.MC_COLD_HOOK_ONLY = "1";
    process.env.MC_COLD_HOOK_PAIR = "1";
    process.env.MC_COLD_HOOK_SYNC_DELAY_MS = "1700";
    try {
        const result = await historianHookTiming(2, 0);
        for (const batch of result.batches as any[]) {
            for (let index = 0; index < batch.rows.length; index++) {
                const row = batch.rows[index];
                const startup = batch.startup[index];
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
        for (const batch of result.batches as any[]) {
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
