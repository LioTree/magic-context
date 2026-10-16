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
