import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brocaResidentTiming } from "./provider-resident-paired-timing";
import { buildDriver } from "./provider-pipeline-differential";

test("resident Broca assistant hook allocation is bounded across history sizes", async () => {
    const saved = { ...process.env };
    try {
        process.env.MC_BROCA_HOOK_PROFILE = "1";
        process.env.MC_BROCA_HOOK_ONLY = "1";
        const root = join(tmpdir(), "magic-context", "broca-hook");
        mkdirSync(root, { recursive: true });
        const binary = buildDriver(mkdtempSync(join(root, "build-")));
        for (const history of [1_000, 5_000, 17_000]) {
            process.env.MC_BROCA_HISTORY = String(history);
            const result = await brocaResidentTiming(50, false, binary);
            const hooks = result.rows.filter(row => row.lane === "on" && row.kind === "hook");
            assert.equal(hooks.length, 50);
            // Count the actual shipping-transport call with the generated driver's
            // allocator, including SQLite and serialization, not a payload proxy.
            for (const hook of hooks) {
                assert.ok(Number.isFinite(hook.allocation_bytes), "allocator must be installed");
                assert.ok(hook.allocation_bytes! < 128_000,
                    `${history} messages, hook ${hook.sample}: ${hook.allocation_bytes} allocated bytes exceeds bounded-work budget`);
            }
        }
    } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
    }
}, 1_800_000);
