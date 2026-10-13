import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { providerSubjects } from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import { buildDriver, Driver, fixture, message, tools } from "./provider-pipeline-differential";

function rng(seed: number) {
    let state = seed >>> 0;
    return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}
const quote = (value: string) => value.replaceAll("'", "''");

/** Both arms branch before rebuilding, not after either has adopted a new baseline. */
export async function preparationDifferential(samples = 48) {
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "0";
    const root = join(tmpdir(), "magic-context", "provider-preparation-differential");
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, "run-"));
    mkdirSync(join(work, "stores"));
    const driver = new Driver(buildDriver(join(work, "build")), join(work, "stores"));
    const results: { host: string; sample: number; request_id: string; answers_identical: boolean; measurements_identical: boolean; summary_identical: boolean; append_bytes: number }[] = [];
    const call = async (rig: string, body: unknown) => {
        const reply = await driver.send({ op: "call", rig, body, raw_response: true, settle_tasks: true });
        assert.ok(!reply.error, `handler refusal: ${JSON.stringify(reply.error)}`);
        assert.equal(typeof reply.raw, "string", "exact handler response bytes must be captured");
        return { answer: reply.ok, raw: reply.raw as string };
    };
    const sql = (rig: string, statement: string, write = false) => driver.send({ op: "sql", rig, sql: statement, write });
    try {
        for (const host of ["OpenCode1", "OpenCode2"] as const) {
            for (let sample = 0; sample < samples; sample++) {
                const random = rng(0x93750 + sample * 17 + (host === "OpenCode2" ? 0x73000 : 0));
                const directory = join(work, "stores", `${host}-${sample}`);
                const f = await fixture(driver, host, directory, sample % 3 === 0);
                const arms: string[] = [];
                try {
                    updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4_000_000 });
                    const count = 25 + random() % 30;
                    const history = Array.from({ length: count }, (_, i) => {
                        if (i % 5 === 0) return message(`m-${i}`, "user", `source ${i}: café 🦀 <opaque>`);
                        if (i % 5 === 4) return message(`m-${i}`, "assistant", `reply ${i}: §fake§`);
                        const value = tools(`m-${i}`);
                        for (const part of value.parts as { type: string; state?: { output: string } }[]) {
                            if (part.type === "tool" && part.state) part.state.output = `spent ${i}: `.repeat(1000 + random() % 2000);
                        }
                        return value;
                    });
                    await f.full(history);
                    await f.pass(history);
                    assert.equal(f.fallbacks.length, 0);
                    await f.event("publish", { start: 1, end: 5, mid: "m-4" });
                    await f.event("flush");
                    await driver.send({ op: "settle", rig: f.rig });
                    const state = f.stored()!;
                    const plan = JSON.parse(state.state.plan_json!);
                    const base = f.wires.filter(w => w.method === "compaction.step").at(-1)!.params;
                    const nextId = `probe-${host}-${sample}-${randomUUID()}`;
                    const model = `openai/gpt-5.6-prepared-${sample}`;
                    // This recording fixture declares the pass control before the
                    // fork; preparation does not consume or predict carrier ops.
                    const pass = { lineage_id: state.state.lineage_id, appended_ids: [nextId], model_key: model };
                    await f.sql(`UPDATE mc_provider_conversations_v2 SET hook_counters_json=json_set(hook_counters_json,'$.pass_context',json('${quote(JSON.stringify(pass))}'))`, true);
                    const project = join(directory, "project");
                    for (const variant of ["cold", "warm"] as const) {
                        const branch = join(directory, variant);
                        mkdirSync(branch);
                        await f.sql(`VACUUM INTO '${quote(join(branch, "store.db"))}'`, true);
                        const context = new Database(join(directory, "context.db"));
                        try { context.exec(`VACUUM INTO '${quote(join(branch, "context.db"))}'`); }
                        finally { context.close(); }
                        const rig = `${host}-${sample}-${variant}`;
                        await driver.send({ op: "create", rig, directory: branch, project_root: project, harness: host === "OpenCode1" ? "opencode" : "opencode2", protect_bash: sample % 3 === 0 });
                        arms.push(rig);
                    }
                    driver.proveIsolation();
                    const rebuildId = `rebuild-${host}-${sample}-${randomUUID()}`;
                    const status: Record<string, unknown> = { ...base, messages: [], request_id: rebuildId, step_id: rebuildId,
                        model, now: 2000, prefix_rebuilding: { reason: "model_switch" },
                        newest: { ordinal: state.state.next_ordinal - 1, mid: history.at(-1)!.info.id },
                        served_through_ordinal: state.state.next_ordinal - 1,
                        last_applied: { compaction_id: state.views.at(-1)!.compaction_id, version: state.views.at(-1)!.version } };
                    delete status.more; delete status.last_not_applied;
                    const coldView = await call(arms[0]!, { method: "compaction.step", params: status });
                    const warmView = await call(arms[1]!, { method: "compaction.step", params: { ...status, consume_prepared_policy: true } });
                    assert.equal(warmView.raw, coldView.raw, "preparation must not change exact rebuilt answer bytes");
                    assert.equal(warmView.answer.answer, "compaction_message");
                    assert.deepEqual(await sql(arms[0]!, "SELECT count(*) FROM mc_provider_policy_preparations_v1"), [[0]], "setting off must not write preparation");
                    assert.deepEqual(await sql(arms[1]!, "SELECT count(*) FROM mc_provider_policy_preparations_v1"), [[1]], "setting on must reach preparation before admission");
                    for (const statement of ["SELECT policy_json FROM mc_provider_policy_parts_v1 ORDER BY ordinal,block_id", "SELECT summary_json FROM mc_provider_policy_summaries_v1"]) {
                        assert.deepEqual(await sql(arms[1]!, statement), await sql(arms[0]!, statement), "preparation must not publish policy before real admission");
                    }
                    const probe = tools(nextId);
                    // Use one result as the actual post_tool subject. Other parts
                    // still join the admitted message and its newest cut.
                    (probe.info as { model: { modelID: string } }).model.modelID = model.slice("openai/".length);
                    const subject = providerSubjects(probe).filter(item => item.hook === "post_tool").at(-1)!;
                    const request = { ...subject, session: "session", harness: host === "OpenCode1" ? "opencode" : "opencode2",
                        request_id: nextId, lineage_id: state.state.lineage_id, params: plan.params, preset: plan.preset,
                        message: probe, subject_mid: nextId, subject_ordinal: state.state.next_ordinal,
                        served_through_ordinal: state.state.next_ordinal - 1, pass_complete: true };
                    const cold = await call(arms[0]!, { method: "transform.hook", params: request });
                    const warm = await call(arms[1]!, { method: "transform.hook", params: { ...request, consume_prepared_policy: true } });
                    assert.equal(warm.raw, cold.raw, "prepared and cold hook answers differ lexically");
                    const appends = (answer: { ops?: { op: string; text?: string }[] }) => JSON.stringify(answer.ops?.filter(op => op.op === "append") ?? []);
                    assert.equal(appends(warm.answer), appends(cold.answer));
                    const measurements = "SELECT ordinal,block_id,policy_json FROM mc_provider_policy_parts_v1 ORDER BY ordinal,block_id";
                    assert.deepEqual(await sql(arms[1]!, measurements), await sql(arms[0]!, measurements), "durable measurements/policy parts differ");
                    assert.deepEqual(await sql(arms[1]!, "SELECT summary_json FROM mc_provider_policy_summaries_v1"), await sql(arms[0]!, "SELECT summary_json FROM mc_provider_policy_summaries_v1"), "bounded summary differs");
                    // Historian scheduling can complete at different times after
                    // the same hook. Compare all policy counters, not that normal
                    // asynchronous worker's bookkeeping; preparation purity has
                    // its separate transaction-level unchanged-state test.
                    const policyCounters = (rows: string[][]) => rows.map(([encoded]) =>
                        Object.fromEntries(Object.entries(JSON.parse(encoded!)).filter(([name]) => !name.startsWith("historian_"))));
                    assert.deepEqual(policyCounters(await sql(arms[1]!, "SELECT hook_counters_json FROM mc_provider_conversations_v2")), policyCounters(await sql(arms[0]!, "SELECT hook_counters_json FROM mc_provider_conversations_v2")), "durable baseline/settings/grace differ");
                    const applied = { compaction_id: warmView.answer.compaction.compaction_id, version: warmView.answer.compaction.version };
                    const ack = { ...status, request_id: `ack-${nextId}`, step_id: `ack-${nextId}`, prefix_rebuilding: undefined,
                        newest: { ordinal: state.state.next_ordinal, mid: nextId }, served_through_ordinal: state.state.next_ordinal, last_applied: applied };
                    const coldAck = await call(arms[0]!, { method: "compaction.step", params: ack });
                    const warmAck = await call(arms[1]!, { method: "compaction.step", params: { ...ack, consume_prepared_policy: true } });
                    assert.equal(warmAck.raw, coldAck.raw, "acknowledgement and next step bytes differ");
                    for (const statement of ["SELECT answer_seq,lineage_id,subject_mid,hook,subject_part,ops_json,state FROM mc_provider_hook_answers_v1 ORDER BY answer_seq", "SELECT last_answer_json FROM mc_provider_conversations_v2"]) {
                        assert.deepEqual(await sql(arms[1]!, statement), await sql(arms[0]!, statement), "durable answers and receipts differ after acknowledgement");
                    }
                    // Tag allocation uses each arm's wall clock. Compare every
                    // functional field while excluding only that timestamp.
                    const tags = (rows: string[][]) => rows.map(([encoded]) => JSON.parse(encoded!).map(({ created_at_ms: _clock, ...fields }: Record<string, unknown>) => fields));
                    assert.deepEqual(tags(await sql(arms[1]!, "SELECT tags_json FROM mc_provider_hook_answers_v1 ORDER BY answer_seq")), tags(await sql(arms[0]!, "SELECT tags_json FROM mc_provider_hook_answers_v1 ORDER BY answer_seq")));
                    const row = { host, sample, request_id: nextId, answers_identical: true, measurements_identical: true, summary_identical: true, append_bytes: Buffer.byteLength(appends(warm.answer)) };
                    results.push(row);
                    console.log(`PREPARATION_DIFFERENTIAL_SAMPLE=${JSON.stringify(row)}`);
                } finally {
                    for (const rig of arms) await driver.send({ op: "drop", rig });
                    await f.close();
                }
            }
        }
    } finally { await driver.close(); }
    const requests = new Set(results.map(row => row.request_id));
    const outcomes = driver.preparationOutcomes.filter(row => requests.has(row.request_id));
    const consumed = outcomes.filter(row => row.consumed);
    assert.ok(consumed.length > 0, "differential must execute consumption, not only cold fallbacks");
    const result = { schema: 1, samples: results.length, consumed: consumed.length, outcomes, results, measurement_kind: "offline_pre_rebuild_snapshot_differential", bun: Bun.version, work };
    console.log(`PREPARATION_DIFFERENTIAL_RESULT=${JSON.stringify(result)}`);
    return result;
}
if (import.meta.main) await preparationDifferential(Number(Bun.argv[2] ?? 48));
