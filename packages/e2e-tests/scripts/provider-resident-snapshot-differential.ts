import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { providerSubjects } from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import { buildDriver, Driver, fixture, message, tools } from "./provider-pipeline-differential";

/** Offline input/index proofs only. This does not install or consume a serving checkpoint. */
export async function residentSnapshots(large = false) {
    const root = join(tmpdir(), "magic-context", "provider-resident-snapshots");
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, "run-"));
    const stores = join(work, "stores");
    mkdirSync(stores);
    const driver = new Driver(buildDriver(join(work, "build")), stores);
    const results: unknown[] = [];
    try {
        for (const host of ["OpenCode1", "OpenCode2"] as const) {
            const f = await fixture(driver, host, join(stores, host), false, true);
            try {
                updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4_000_000 });
                const count = large ? 17_000 : 40;
                const covered = large ? 16_500 : 30;
                const history = Array.from({ length: count }, (_, i) => i % 5 === 0
                    ? message(`synthetic-${i}`, "user", `Inspect ${i}: café 🦀`)
                    : i % 5 === 4 ? message(`synthetic-${i}`, "assistant", `Finished ${i}`) : tools(`synthetic-${i}`));
                history.forEach((entry, i) => { (entry.info as any).absolute_ordinal = i + 1; });
                await f.full(history);
                await f.pass(history);
                await f.event("realistic_seed", { covered, compartments: large ? 2_300 : 4, memories: large ? 1_000 : 10 });
                await f.full(history);
                await f.pass(history);
                assert.equal(f.fallbacks.length, 0);
                if (!large) {
                    // Admit signed native data through the provider hook itself,
                    // not the legacy full-array CK encoder used for bootstrap.
                    const entry = message("resident-signed", "assistant", "following protected thinking");
                    entry.parts.unshift({id: "kept-thinking", type: "reasoning", text: "protected café 🦀",
                        metadata: {anthropic: {signature: "signed-fixture"}}, future: {opaque: true}} as any);
                    const stored = f.stored()!;
                    const plan = JSON.parse(stored.state.plan_json!);
                    await f.call({method: "transform.hook", params: {...providerSubjects(entry)[0],
                        session: "session", harness: host === "OpenCode1" ? "opencode" : "opencode2",
                        lineage_id: stored.state.lineage_id, request_id: "resident-signed", params: plan.params, preset: plan.preset,
                        message: entry, subject_ordinal: count + 1, served_through_ordinal: count, pass_complete: true}});
                }
                const prove = async (cut: string) => {
                    const before = await f.sql("SELECT hook_counters_json FROM mc_provider_conversations_v2");
                    const viewBefore = await f.sql("SELECT version,state,length(replacement_json) FROM mc_provider_views_v1 ORDER BY version");
                    const snapshot = await driver.send({ op: "resident", rig: f.rig });
                    assert.equal(snapshot.independent_parts_equal, true);
                    assert.equal(snapshot.independent_tail_equal, true);
                    assert.equal(snapshot.domains_equal, true);
                    assert.ok(snapshot.retained_bytes <= 128 * 1024 * 1024);
                    assert.equal(snapshot.tail_blob_rows, count - covered + (large ? 0 : 1));
                    assert.equal(snapshot.compartments, large ? 2_300 : 4);
                    assert.equal(snapshot.memories, large ? 1_000 : 10);
                    assert.deepEqual(await f.sql("SELECT hook_counters_json FROM mc_provider_conversations_v2"), before, "read-only counters");
                    assert.deepEqual(await f.sql("SELECT version,state,length(replacement_json) FROM mc_provider_views_v1 ORDER BY version"), viewBefore, "read-only view eligibility");
                    const result = {host, cut, ...snapshot};
                    results.push(result);
                    console.log(`RESIDENT_SNAPSHOT=${JSON.stringify(result)}`);
                    return snapshot;
                };
                const folded = await prove("after_fold");
                await f.restartModule();
                const restarted = await prove("after_handler_restart");
                assert.equal(restarted.snapshot_sha256, folded.snapshot_sha256, "read-only handler restart snapshot");
                await f.event("realistic_delta", {sample: 0});
                const changed = await prove("after_domain_delta");
                assert.notEqual(changed.snapshot_sha256, restarted.snapshot_sha256, "domain change must change resident input identity");
                assert.equal(changed.policy_revision, restarted.policy_revision, "policy revision alone does not cover compartment text");
                await f.noReads();
            } finally { await f.close(); }
        }
    } finally { await driver.close(); }
    const result = {schema: 1, work, large, snapshots: results.length, results,
        scope: "offline_read_only_builder; full policy hydration is cold-build work; no serving/checkpoint implementation", bun: Bun.version};
    console.log(`RESIDENT_SNAPSHOT_RESULT=${JSON.stringify(result)}`);
    return result;
}
if (import.meta.main) await residentSnapshots(Bun.argv.includes("--large"));
