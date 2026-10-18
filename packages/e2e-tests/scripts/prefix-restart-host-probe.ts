// TMPDIR and MC_PREFIX_PROBE_ROOT must name the same throwaway directory: the harness
// allocates every host store below it, and this probe checks open files against it.
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { TestHarness } from "../src/harness";
import { OpenCode2TestHarness } from "../src/opencode2-harness";
import { PiTestHarness } from "../src/pi-harness";
import { resolvePiPackageJson } from "../src/pi-runner/spawn";
import { CLI as OC2_CLI, waitForPluginLog } from "../src/opencode2-runner/spawn";
import type { CapturedRequest } from "../src/mock-provider/server";

type Harness = TestHarness | OpenCode2TestHarness | PiTestHarness;
const kind = process.argv[2];
const mutation = process.argv[3] === "mutation";
const stock = process.argv[3] === "stock";
if (!["opencode", "opencode2", "pi", "omp"].includes(kind!)) throw new Error("Expected opencode, opencode2, pi or omp");
const root = process.env.MC_PREFIX_PROBE_ROOT;
if (!root || root !== process.env.TMPDIR || !root.includes("/magic-context/"))
    throw new Error("TMPDIR and MC_PREFIX_PROBE_ROOT must name one private magic-context task root");
const MODEL = "claude-opus-5-5";
const usage = { input_tokens: 15_000, output_tokens: 50, cache_creation_input_tokens: 15_000 };
const config = {
    ...(stock ? { enabled: false } : {}),
    signed_thinking_hold: "on", transform_mode: "ts", cache_ttl: "13h",
    protected_tokens: 4000, protected_tags: undefined, execute_threshold_percentage: 65,
    historian: { disable: true }, dreamer: { disable: true },
    memory: { enabled: false, auto_search: { enabled: false }, auto_promote: false }, compressor: { enabled: false },
};
const primary = (body: Record<string, unknown>) => (body.tools as Array<{ name: string }> | undefined)?.some(t => stock ? /^(?:bash|shell)$/.test(t.name.replace(/^_/, "")) : t.name.replace(/^_/, "") === "ctx_reduce") === true;
const options = { modelContextLimit: 100_000, magicContextConfig: config, expectMagicContext: !stock,
    mockModelID: MODEL, prefixBinding: true, thinkingScope: (body: Record<string, unknown>) => primary(body) ? "primary" : undefined };
const report: Record<string, unknown> = { kind, mutation, stock, model: MODEL };
let h: Harness | undefined;
let session = "";
let stage = "warm";
let step = 0;
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const rows = (sql: string) => h!.contextDb().prepare(sql).all(session) as Array<Record<string, unknown>>;
const meta = () => rows("SELECT held_release FROM session_meta WHERE session_id = ?")[0]?.held_release;

function isolation(host: Harness) {
    const pid = host instanceof PiTestHarness ? host.hostPid : host.opencode.pid;
    check(pid, "Host PID unavailable");
    const storeRoot = host instanceof PiTestHarness ? host.env.baseDir : host instanceof OpenCode2TestHarness ? host.opencode.root : host.opencode.env.dataDir;
    const inside = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
    check(inside(realpathSync(storeRoot), realpathSync(root!)), `Store root escaped: ${storeRoot}`);
    const inventory = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" });
    const liveRoots = [".local/share/opencode", ".local/share/cortexkit/magic-context", ".config/opencode", ".config/cortexkit", ".pi/agent"].map(p => join(process.env.MC_PREFIX_LIVE_HOME ?? homedir(), p));
    for (const line of inventory.split("\n")) {
        if (!line.startsWith("n/")) continue;
        const path = line.slice(1);
        const canonical = existsSync(path) ? realpathSync(path) : path;
        check(!liveRoots.some(p => inside(canonical, p) || inside(path, p)), `Live path opened: ${path}`);
        if (/\.(?:db|sqlite)(?:-wal|-shm)?$/.test(path)) check(inside(canonical, realpathSync(root!)), `Database escaped: ${path}`);
    }
    const inventoryPath = join(root!, `${kind}-${mutation ? "mutation" : "clean"}-${pid}-lsof.txt`);
    writeFileSync(inventoryPath, inventory);
    return { pid, root: storeRoot, inventoryPath };
}

async function flush(host: Harness): Promise<void> {
    if (host instanceof PiTestHarness) return host.invokeExtensionCommand("ctx-flush");
    if (host instanceof OpenCode2TestHarness) {
        const client = OpenCode.make({ baseUrl: host.serverUrl, headers: { authorization: `Basic ${btoa(`opencode:${host.opencode.password}`)}` } });
        await client.session.command({ sessionID: session, name: "ctx-flush", text: "" });
    } else {
        const response = await fetch(`${host.serverUrl}/session/${session}/command?directory=${encodeURIComponent(host.workdir)}`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "ctx-flush", arguments: "" }),
        });
        check(response.ok, `Flush failed: ${response.status} ${await response.text()}`);
    }
}

function changePrefix(body: Record<string, unknown>): Record<string, unknown> {
    if (!primary(body)) return body;
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    if (!messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "thinking"))) return body;
    const copy = structuredClone(body);
    for (const message of copy.messages as typeof messages) {
        if (typeof message.content === "string") { message.content = `X${message.content.slice(1)}`; break; }
        if (Array.isArray(message.content)) {
            const text = message.content.find(b => b.type === "text" && typeof b.text === "string" && b.text.length);
            if (text) { text.text = `X${text.text.slice(1)}`; break; }
        }
    }
    return copy;
}

function thinkingBlocks(body: Record<string, unknown>) {
    return (body.messages as Array<{ content: unknown }>).flatMap(message =>
        Array.isArray(message.content) ? message.content.filter(block => block.type === "thinking" || block.type === "redacted_thinking") : [],
    );
}

try {
    process.env.MC_E2E_PRIVATE_TMPDIR = join(root, "host-tmp");
    mkdirSync(process.env.MC_E2E_PRIVATE_TMPDIR, { recursive: true });
    process.env.MAGIC_CONTEXT_LOG_PATH = join(root, `${kind}-${mutation ? "mutation" : "clean"}.log`);
    report.version = kind === "opencode" ? execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim()
        : kind === "opencode2" ? JSON.parse(readFileSync(join(realpathSync(OC2_CLI), "..", "..", "package.json"), "utf8")).version
        : JSON.parse(readFileSync(resolvePiPackageJson(kind === "omp" ? "omp" : "pi"), "utf8")).version;
    if (kind === "opencode") check(/^1\.18\./.test(String(report.version)), "OpenCode 1.18.x required");
    if (kind === "omp") check(/^18\.8\./.test(String(report.version)), "OMP 18.8.x required");
    h = kind === "opencode" ? await TestHarness.create({ ...options, ...(stock ? { expectedMagicContextState: "configured-disabled" as const } : {}), mockProviderID: "anthropic", prepareContextDatabase: true })
        : kind === "opencode2" ? await OpenCode2TestHarness.create(options)
        : await PiTestHarness.create({ ...options, host: kind === "omp" ? "omp" : "pi", reasoning: true });
    report.isolation = [isolation(h)];
    session = await h.createSession();
    report.session = session;
    if (mutation) h.mock.setRequestTransform(changePrefix);
    h.mock.addMatcher(body => {
        if (!primary(body)) return { text: "auxiliary", usage };
        step++;
        const thinking = { type: "thinking", thinking: `Inspect the next result in full, step ${stage}-${step}.`, signature: "mint-me" };
        if (stage === "release" || (stage === "warm" && step > 5) || (stage === "loop" && step > 5))
            return { content: [thinking, { type: "text", text: "Turn complete." }], usage };
        const tools = body.tools as Array<{ name: string }>;
        const tool = tools.find(t => /^(?:bash|shell)$/.test(t.name.replace(/^_/, "")));
        check(tool, "Host has no shell tool");
        return { content: [thinking, { type: "tool_use", id: `${stage}-${step}`, name: tool!.name,
            input: { command: `python3 -c "print('\\n'.join('${stage}-${step} line %04d abcdefghijklmnopqrstuvwxyz0123456789' % i for i in range(160)))"`, ...(kind === "omp" ? {} : { description: "Produce a deterministic tool result" }) } }],
            stop_reason: "tool_use", usage, ...(stage === "loop" && step === 2 ? { delayMs: 1500 } : {}) };
    });
    let promptError: unknown;
    try { await h.sendPrompt(session, "PREFIX-RESTART warm tool history", { timeoutMs: 60_000 }); }
    catch (error) { promptError = String(error); }
    if (stock) {
        check(!promptError, `Stock control failed: ${promptError}`);
        check(h.mock.requests().filter(r => primary(r.body)).every(r => !r.thinkingViolation && r.responseStatus === 200), "Stock host changed thinking prefix");
        report.violations = [];
    } else if (mutation) {
        const rejected = h.mock.requests().filter(r => r.thinkingViolation);
        check(rejected.length >= 1 && rejected.every(r => r.responseStatus === 400), "Transport mutation did not record a provider violation with status 400");
        report.violations = rejected.map(r => ({ error: r.thinkingViolation, status: r.responseStatus }));
        report.promptError = promptError;
    } else {
        check(!promptError, `Warm prompt failed: ${promptError}`);
        const tag = rows("SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number LIMIT 1")[0];
        check(tag, "Warm turn produced no tagged tool arc");
        stage = "loop"; step = 0;
        const loopRequestOffset = h.mock.requests().length;
        const turn = h.sendPrompt(session, "PREFIX-RESTART primary tool loop", { timeoutMs: 60_000 });
        void turn.catch(() => {});
        await h.waitFor(() => step >= 2, { timeoutMs: 20_000, label: "second signed tool-loop request" });
        const writer = new Database(h.contextDbPath());
        try {
            writer.prepare("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, ?)")
                .run(session, tag!.tag_number as number, Date.now(), h.harnessId);
        } finally { writer.close(); }
        await flush(h);
        await turn;
        const loopRequests = h.mock.requests().slice(loopRequestOffset).filter(r => primary(r.body));
        check(loopRequests.length >= 6, "Unengaged strip probe: missing loop requests");
        const olderThinking = thinkingBlocks(loopRequests[0]!.body);
        check(olderThinking.length > 0, "Unengaged strip probe: no completed-turn thinking");
        for (const request of loopRequests) {
            const kept = thinkingBlocks(request.body);
            check(olderThinking.every(block => kept.some(candidate =>
                candidate.type === block.type && candidate.signature === block.signature &&
                candidate.thinking === block.thinking && candidate.data === block.data,
            )), "Held pass stripped or changed completed-turn thinking");
        }
        report.heldThinking = { blocks: olderThinking.length, requests: loopRequests.length };
        check(meta(), "Held flush has no durable obligation");
        check(rows("SELECT tag_id FROM pending_ops WHERE session_id = ?").length > 0, "Queued drop was not held");
        report.heldRelease = meta();
        await h.restart();
        (report.isolation as unknown[]).push(isolation(h));
        stage = "release"; step = 0;
        await h.sendPrompt(session, "PREFIX-RESTART next real user after restart", { timeoutMs: 180_000 });
        report.releaseTags = rows("SELECT tag_number, type, status, byte_size, input_byte_size, tool_name FROM tags WHERE session_id = ? ORDER BY tag_number");
        report.releaseProtection = Object.fromEntries(Object.entries(rows("SELECT * FROM session_meta WHERE session_id = ?")[0] ?? {}).filter(([key]) => /protect|floor|tokens|pending|held_release|is_subagent/.test(key)));
        check(meta() === null, "Restart release did not drain its obligation");
        check(rows("SELECT tag_id FROM pending_ops WHERE session_id = ?").length === 0, "Restart release did not land the queued drop");
        const logEnv = h instanceof OpenCode2TestHarness ? h.opencode.env : { MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH };
        const log = await waitForPluginLog(logEnv, "edit admission: release reason=user_flush");
        const held = log.split("\n").filter(line => /held lane=.*coords=.*boundary=.*held_edits=[1-9]/.test(line));
        check(held.length > 0, "Unengaged probe: no held-edit line");
        check(log.includes("edit admission: release reason=user_flush"), "Release lost its original flush reason");
        report.heldEdits = held;
        const requests = h.mock.requests().filter(r => primary(r.body));
        check(requests.length >= 6, "Unengaged probe: missing tool-loop requests");
        check(requests.every(r => r.thinkingChecked === "prefix-binding"), "Unengaged probe: an unchecked primary request");
        check(requests.every(r => r.body.model === MODEL && r.body.thinking !== undefined), "Unengaged probe: prefix-bound model or reasoning disabled");
        check(requests.every(r => !r.thinkingViolation && r.responseStatus === 200), "Provider rejected a clean run");
        report.checkedRequests = requests.length;
        report.violations = [];
    }
    report.passed = true;
} catch (error) {
    report.error = String(error);
    report.diagnostics = h?.diagnostics();
    throw error;
} finally {
    if (h instanceof TestHarness) {
        const db = new Database(join(h.opencode.env.dataDir, "opencode", "opencode.db"), { readonly: true });
        try { report.storedParts = db.prepare("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id").all(session); }
        finally { db.close(); }
        if (!stock) {
            const row = rows("SELECT * FROM session_meta WHERE session_id = ?")[0] ?? {};
            report.frozenDecisions = Object.fromEntries(Object.entries(row).filter(([key]) => /trailing_blank_decisions|merged_reasoning/.test(key)));
        }
    }
    report.requests = h?.mock.requests().map((r: CapturedRequest) => ({ body: r.body, checked: r.thinkingChecked, violation: r.thinkingViolation, status: r.responseStatus }));
    writeFileSync(join(root, `${kind}-${mutation ? "mutation" : "clean"}.json`), JSON.stringify(report, null, 2));
    await h?.dispose();
}
console.log(JSON.stringify({ kind, mutation, version: report.version, checked: report.checkedRequests, violations: report.violations, passed: true }));
