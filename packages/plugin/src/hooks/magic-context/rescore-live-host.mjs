// Opt-in OpenCode host check: /ctx-rescore changes stored scores without changing
// the cached history prefix sent to the model. The harness uses private HOME/XDG,
// OpenCode, storage and config roots with a deterministic local provider.
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { TestHarness } from "../../../../e2e-tests/src/harness.ts";

if (process.env.MC_RESCORE_LIVE !== "1") throw new Error("Run with MC_RESCORE_LIVE=1 on a machine with OpenCode and lsof");
const h = await TestHarness.create({
    historianMockModel: { id: "score-model", contextLimit: 200000 },
    magicContextConfig: { protected_tokens: 1, execute_threshold_percentage: 95, memory: { enabled: false }, history_budget_percentage: 0.4, cache_ttl: "30m" },
});
let seededDb;
const hashes = [];
function isolation() {
    const output = Bun.spawnSync(["lsof", "-Fn", "-p", String(h.opencode.pid)]);
    assert.equal(output.exitCode, 0, "lsof must sample the real host");
    const files = output.stdout.toString().split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1)).filter((path) => /\.(?:db|sqlite)(?:-wal|-shm)?$/.test(path));
    assert(files.length > 0, "lsof must see database handles");
    const root = resolve(dirname(h.dataDir));
    assert(files.every((path) => resolve(path).startsWith(`${root}/`)), `external DB: ${files.join(",")}`);
    return files.map((path) => path.slice(root.length + 1));
}
async function command(sessionId, args, name = "ctx-rescore") {
    const response = await fetch(`${h.serverUrl}/session/${sessionId}/command?directory=${encodeURIComponent(h.workdir)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: name, arguments: args, model: "mock-anthropic/mock-sonnet" }),
    });
    assert(response.ok, `command ${name} ${args}: ${response.status} ${await response.text()}`);
}
function mainRequests() { return h.mock.requests().filter((request) => JSON.stringify(request.body.system).includes("## Magic Context")); }
function wirePrefix() {
    const request = mainRequests().at(-1);
    assert(request, "a main-provider request must be captured");
    const messages = request.body.messages;
    assert(messages?.[0] && messages?.[1], "both frozen head messages must reach the wire");
    const bytes = JSON.stringify(messages.slice(0,2));
    hashes.push(createHash("sha256").update(bytes).digest("hex"));
    return bytes;
}
let session;
try {
    session = await h.createSession();
    for (let i=0;i<24;i++) await h.sendPrompt(session, `seed ${i}`);
    const beforeIsolation = isolation();
    const messages = await (await fetch(`${h.serverUrl}/session/${session}/message?directory=${encodeURIComponent(h.workdir)}`)).json();
    const transcript = messages.filter((message) => message.info?.role === "user" || message.info?.role === "assistant");
    assert(transcript.length >= 48);
    const db = seededDb = new Database(h.contextDbPath());
    const cutoff = db.query("SELECT activated_at FROM rescore_activation WHERE id=1").get().activated_at;
    const insert = db.prepare("INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,p2,p3,p4,importance,episode_type,created_at,legacy) VALUES (?,'opencode',?,?,?,?,?,?,'',?,?,?,?,100,'feature',?,0)");
    for (let i=0;i<20;i++) insert.run(session,i+1,i*2+1,i*2+2,transcript[i*2].info.id,transcript[i*2+1].info.id,`history-${i}`,`VERBOSE-${i}`,`SUMMARY-${i}`,`FACT-${i}`,`ANCHOR-${i}`,i === 0 ? 1 : cutoff+1);
    // Switching models rebuilds the cached history prefix because the new model
    // cannot reuse the old prompt cache. /ctx-rescore does not request a rebuild.
    await h.sendPrompt(session,"freeze seeded history",{ modelID: "score-model" });
    const before = wirePrefix();
    assert(before.includes("VERBOSE-0"), "independently expected base tier P1 for age 19, importance 100, pressure floor 0.1");
    const cacheBefore = db.query("SELECT cached_m0_bytes,cached_m0_materialized_at,cached_m0_score_selection_watermark FROM session_meta WHERE session_id=?").get(session);
    h.mock.addMatcher((body) => {
        const text = (body.messages ?? []).flatMap((message) => typeof message.content === "string" ? [message.content] : (message.content ?? []).map((part) => part.text ?? "")).join("\n");
        const match = text.match(/<candidates>\s*(\[[\s\S]*?\])\s*<\/candidates>/);
        return match ? { usage: { input_tokens: 100, output_tokens: 30 }, text: JSON.stringify(JSON.parse(match[1]).map(({handle}) => ({handle, importance: 1, reason: "Short recall horizon"}))) } : null;
    });
    await command(session, "");
    const preview = db.query("SELECT id FROM rescore_snapshots ORDER BY created_at DESC LIMIT 1").get();
    assert(preview);
    await command(session,`confirm ${preview.id}`);
    await h.waitFor(() => db.query("SELECT state FROM rescore_jobs ORDER BY created_at DESC LIMIT 1").get()?.state === "complete", { timeoutMs: 30000, label: "score job publication" });
    assert.equal(db.query("SELECT COUNT(*) AS n FROM compartment_score_revisions WHERE session_id=?").get(session).n,1);
    assert.deepEqual(db.query("SELECT cached_m0_bytes,cached_m0_materialized_at,cached_m0_score_selection_watermark FROM session_meta WHERE session_id=?").get(session),cacheBefore);
    for (let i=0;i<2;i++) {
        await h.sendPrompt(session,`pending score pass ${i}`,{ modelID: "score-model" });
        assert.equal(wirePrefix(),before, "published scores must leave actual m[0]/m[1] wire bytes identical");
    }
    await command(session,"", "ctx-status");
    const reports = await (await fetch(`${h.serverUrl}/session/${session}/message?directory=${encodeURIComponent(h.workdir)}`)).json();
    assert(JSON.stringify(reports).includes("pending next natural rebuild"), "host status must report pending adoption");
    await h.sendPrompt(session,"naturally cold model-change fold");
    const adopted = wirePrefix();
    assert.notEqual(adopted,before);
    assert(adopted.includes("SUMMARY-0") && !adopted.includes("VERBOSE-0"), "independently expected P2: at age19 the score1 half-life is 24 * 2^(-49/25); the generous 40%-window budget keeps pressure in the P2 band");
    assert.equal(db.query("SELECT cached_m0_score_selection_watermark AS w FROM session_meta WHERE session_id=?").get(session).w,1);
    console.log(JSON.stringify({ checks: 9, host: Bun.spawnSync(["opencode","--version"]).stdout.toString().trim(), pid: h.opencode.pid, beforeIsolation, afterIsolation: isolation(), wireHashes: hashes, published: 1, pendingPassesByteIdentical: 2, tiers: ["P1","P2"], appliedWatermark: 1 }));
} catch (error) {
    console.error("live rescore state", seededDb?.query("SELECT state,pause_reason,last_error,consecutive_failed_batches FROM rescore_jobs").all());
    console.error("adoption markers", { markers: JSON.stringify(mainRequests().at(-1)?.body.messages?.slice(0,2)).match(/(?:VERBOSE|SUMMARY|FACT|ANCHOR)-0/g), watermark: seededDb?.query("SELECT cached_m0_score_selection_watermark FROM session_meta WHERE session_id=?").get(session) });
    console.error("live attempts", seededDb?.query("SELECT state,outcome,carrier_run_id FROM rescore_attempts").all());
    console.error("provider requests", h.mock.requests().map((r) => ({ model: r.body.model, candidates: JSON.stringify(r.body.messages).includes("<candidates>") })));
    throw error;
} finally { seededDb?.close(); await h.dispose(); }
