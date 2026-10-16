import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { buildDriver, Driver, fixture, message, tools } from "./provider-pipeline-differential";

export async function residentFoldDifferential(large = false) {
    process.env.MC_RESIDENT_HOOKS = "1";
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
    const root = join(tmpdir(), "magic-context", "resident-fold-differential");
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, "run-"));
    mkdirSync(join(work, "stores"));
    const driver = new Driver(buildDriver(join(work, "build")), join(work, "stores"));
    let checks = 0;
    try {
        for (const host of ["OpenCode1", "OpenCode2"] as const) {
            const f = await fixture(driver, host, join(work, "stores", host, "on"), false, true, true);
            const control = await fixture(driver, host, join(work, "stores", host, "off"), false, true, false);
            try {
                for (const lane of [f, control]) updateSessionMeta(lane.db, "session", { lastUsageContextLimit: 4_000_000 });
                const count = large ? 17_000 : 100;
                const covered = large ? 16_500 : 80;
                const history = Array.from({ length: count }, (_, i) => i % 5 === 0
                    ? message(`synthetic-${i}`, "user", `Fixture ${i}: café 🦀`)
                    : i % 5 === 4 ? message(`synthetic-${i}`, "assistant", `Fixture ${i} completed`)
                    : tools(`synthetic-${i}`));
                history.forEach((entry, i) => { (entry.info as any).absolute_ordinal = i + 1; });
                for (const lane of [f, control]) {
                    await lane.full(history);
                    await lane.pass(history);
                    await lane.event("realistic_seed", { covered, compartments: large ? 2_300 : 12, memories: large ? 1_000 : 10 });
                    await lane.full(history);
                    await lane.pass(history);
                }
                for (let sample = 0; sample < 4; sample++) {
                    for (const lane of [f, control]) {
                        await lane.event("realistic_visible_delta", { sample });
                        lane.deps.historyRefreshSessions.add("session");
                    }
                    const actual = await f.pass(history);
                    const expected = await control.pass(history);
                    assert.deepEqual(actual, expected, `${host} fold ${sample} model-visible bytes`);
                    const receipt = f.answers.filter(answer => answer.answer === "compaction_message").at(-1)!;
                    const expectedReceipt = structuredClone(control.answers.filter(answer => answer.answer === "compaction_message").at(-1)!);
                    expectedReceipt.request_id = receipt.request_id;
                    expectedReceipt.compaction.compaction_id = receipt.compaction.compaction_id;
                    assert.deepEqual(receipt, expectedReceipt, `${host} fold ${sample} receipt except independent request/conversation IDs`);
                    checks++;
                }
                let random = 0x72c0ffee;
                for (let sample = 0; sample < 24; sample++) {
                    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
                    const choice = random % 7;
                    if (choice === 0) {
                        const ordinal = history.length + 1;
                        const entry = message(`append-${sample}`, "user", `Appended tail ${sample}: café 🦀`);
                        (entry.info as any).absolute_ordinal = ordinal;
                        history.push(entry);
                    } else if (choice === 1 || choice === 2) {
                        for (const lane of [f, control]) await lane.event(choice === 1 ? "resident_memory_delta" : "resident_retier", { sample });
                    } else if (choice === 3) {
                        await f.restartModule(); await control.restartModule();
                    } else if (choice === 4) {
                        const entry = message(`model-${sample}`, "user", "Switch model on an appended turn");
                        (entry.info as any).absolute_ordinal = history.length + 1;
                        (entry.info as any).model = { providerID: "openai", modelID: sample % 2 ? "fixture-model-a" : "fixture-model-b" };
                        history.push(entry);
                    } else if (choice === 5) {
                        for (const lane of [f, control]) {
                            const tags = await lane.sql(`SELECT tag_number FROM mc_tags WHERE session_id='session' AND kind='tool_result' AND block_id LIKE 'synthetic-${covered + 1}#%' ORDER BY tag_number LIMIT 1`);
                            assert.ok(tags.length > 0, "drop control must name a live-tail tool tag");
                            await lane.call({ name: "ctx_reduce", arguments: { session_id: "session", command_id: `random-drop-${sample}`, drop: String(tags[0][0]) } });
                        }
                    } else {
                        for (const lane of [f, control]) await lane.event("realistic_visible_delta", { sample: sample % 4 });
                    }
                    for (const lane of [f, control]) lane.deps.historyRefreshSessions.add("session");
                    assert.deepEqual(await f.pass(history), await control.pass(history), `${host} randomized fold ${sample}, choice ${choice}`);
                    checks++;
                }
                await f.noReads(); await control.noReads();
            } finally { await f.close(); await control.close(); }
        }
    } finally { await driver.close(); }
    console.log(`RESIDENT_FOLD_DIFFERENTIAL_RESULT=${JSON.stringify({ bun: Bun.version, checks, large, work })}`);
}

if (import.meta.main) await residentFoldDifferential(Bun.argv.includes("--large"));
