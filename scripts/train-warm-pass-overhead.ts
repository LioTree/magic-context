#!/usr/bin/env bun
/**
 * Compare repeated OpenCode/Pi transform calls after initialization, never user
 * data. Temporary SQLite databases contain synthetic history, tags and memories.
 * Export revisions with
 * `git archive <ref> | tar -x -C <dir>` first, then pass --master and --train.
 * The current checkout is the candidate. All stores and instrumented source
 * copies live below $TMPDIR/magic-context/oc2-overhead/. Run on Linux only.
 *
 * bun scripts/train-warm-pass-overhead.ts --master <export> --train <export>
 *   --output .cortexkit/internal-docs/investigations/train-overhead-results.json
 * --output writes the measurements and comparisons as JSON to the supplied path.
 * Defaults: three blocks of 120 ordinary DEFER calls (no priced prefix rewrite)
 * per source, alternating master/train/candidate
 * and its reverse per request, then 400 randomized requests against the unmodified
 * train. Preparation and deferred drains are not
 * included in handler wall time. No model, embedding or host network calls run.
 */
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import ts from "../packages/plugin/node_modules/typescript";

const args = process.argv.slice(2);
function option(name: string, fallback?: string): string {
    const index = args.indexOf(`--${name}`);
    const value = index < 0 ? fallback : args[index + 1];
    assert(value, `--${name} is required`);
    return value;
}
assert.equal(process.platform, "linux", "this benchmark must run on Linux");
const checkout = resolve(import.meta.dir, "..");
const output = resolve(option("output"));
const blocks = Number(option("blocks", "3"));
const passes = Number(option("passes", "120"));
const randomPasses = Number(option("random-passes", "400"));
assert(Number.isSafeInteger(blocks) && blocks >= 3);
assert(Number.isSafeInteger(passes) && passes >= 120);
assert(Number.isSafeInteger(randomPasses) && randomPasses >= 400);
const scratchParent = join(tmpdir(), "magic-context/oc2-overhead");
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(join(scratchParent, "paired-"));
const targets: Record<string, string[]> = {
    "hooks/magic-context/move-inputs.ts": ["moveMessageDigestFromFields"],
    "hooks/magic-context/inject-compartments.ts": ["hydrateCachedM0Mural", "mustMaterialize"],
    "hooks/magic-context/lkg-replay.ts": ["projectEntryWithDigests", "captureLkgSlot"],
    "hooks/magic-context/lkg-served-marker.ts": ["recordServedCapture", "readServedMarker"],
    "hooks/magic-context/lkg-measured-request.ts": ["identity", "noteCapturedLkgRequest"],
    "hooks/magic-context/lkg-recovery-prefix.ts": ["noteLkgHealthyPrefix"],
    "hooks/magic-context/transform-postprocess-phase.ts": ["runPostTransformPhase"],
    "hooks/magic-context/lkg-recovery-fence.ts": ["known", "commitLkgWithRecoveryFence"],
    "features/magic-context/store-generation-rebase.ts": ["rebaseSessionCoordinatesAsync"],
    "hooks/magic-context/lkg-slot.ts": ["getSlot", "getInMemorySlot", "exactReusablePrefix", "signatureForFields"],
    "hooks/magic-context/lkg-persist.ts": ["slotFingerprint", "persistLkgSlot"],
};
function instrument(path: string, symbols: string[]): void {
    if (!existsSync(path)) return;
    const source = readFileSync(path, "utf8");
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const edits: Array<{ start: number; text: string }> = [];
    for (const node of tree.statements) {
        if (!ts.isFunctionDeclaration(node) || !node.name || !node.body || !symbols.includes(node.name.text)) continue;
        const name = node.name.text;
        edits.push({ start: node.body.getStart(tree) + 1, text: `\nconst __overheadStart = performance.now(); try {\n` });
        edits.push({ start: node.body.end - 1, text: `\n} finally { globalThis.__trainOverheadSpan?.(${JSON.stringify(name)}, performance.now() - __overheadStart); }\n` });
    }
    let instrumented = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        // Offsets refer to the pristine source, so apply from right to left.
        instrumented = instrumented.slice(0, edit.start) + edit.text + instrumented.slice(edit.start);
    }
    writeFileSync(path, instrumented);
}
// Fine spans exist only in the disposable source copies, never in shipped handlers.
function instrumentSections(path: string, name: string, boundaries: string[]): void {
    const source = readFileSync(path, "utf8");
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const node = tree.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (!node?.body) return;
    const edits: Array<{ start: number; text: string }> = [];
    edits.push({ start: node.body.getStart(tree) + 1, text: `\nlet __fineStart = performance.now(), __fineName = "${name}.entry"; try {\n` });
    for (const statement of node.body.statements) {
        const text = statement.getText(tree);
        const variable = ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.name.getText(tree) : undefined;
        const boundary = boundaries.find((key) => key === variable || text.startsWith(key));
        if (!boundary) continue;
        edits.push({ start: statement.getStart(tree), text: `globalThis.__trainOverheadSpan?.(__fineName, performance.now() - __fineStart); __fineStart = performance.now(); __fineName = ${JSON.stringify(`${name}.${boundary}`)};\n` });
    }
    edits.push({ start: node.body.end - 1, text: `\n} finally { globalThis.__trainOverheadSpan?.(__fineName, performance.now() - __fineStart); }\n` });
    let instrumented = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) instrumented = instrumented.slice(0, edit.start) + edit.text + instrumented.slice(edit.start);
    writeFileSync(path, instrumented);
}
function prepare(label: string, source: string): string {
    const dest = join(scratch, "sources", label);
    mkdirSync(dest, { recursive: true });
    for (const pkg of ["plugin", "pi-plugin", "retina-local-fs"]) {
        const from = join(source, "packages", pkg);
        const to = join(dest, "packages", pkg);
        mkdirSync(to, { recursive: true });
        for (const entry of ["src", "package.json", "tsconfig.json", "tsconfig.build.json"]) {
            if (existsSync(join(from, entry))) cpSync(join(from, entry), join(to, entry), { recursive: true });
        }
        symlinkSync(join(checkout, "packages", pkg, "node_modules"), join(to, "node_modules"));
    }
    symlinkSync(join(checkout, "node_modules"), join(dest, "node_modules"));
    const hooks = join(dest, "packages/plugin/src/hooks/magic-context");
    instrumentSections(join(hooks, "lkg-replay.ts"), "buildLkgPrefix", ["projected", "ids", "inputContentDigests", "inputIndexById", "jsonPrefix"]);
    instrumentSections(join(hooks, "lkg-replay.ts"), "captureLkgSlot", ["built", "modelKeys", "if (args.onPrepared)", "captured", "if (captured)"]);
    instrumentSections(join(hooks, "transform-postprocess-phase.ts"), "runPostTransformPhase", ["tPostprocessSetup", "frozenThinking", "makeEditAdmission", "newTargets", "maxReasoningTag", "foldDueDecision", "preparedPrefix", "completeCachedPrefixAvailable", "firstRenderBust", "servedPrefixBeforeFold", "tPassDecisions", "tReplaySnapshot", "tInjectM0M1", "tPlaceholder", "tNudgeBlock", "tMarker", "tNoteAndTodo", "autoSearchHintsBefore", "materializeReason", "tFrozenDecisions", "finalizeOptions", "dropModeSwitchesThisPass", "prefixEditBesidesReasoningTrim", "settledDroppedReasoning", "tFinalRepresentation", "tTailBaseline", "tTailGuard"]);
    for (const [path, symbols] of Object.entries(targets)) instrument(join(dest, "packages/plugin/src", path), symbols);
    instrument(join(dest, "packages/pi-plugin/src/pi-lkg.ts"), ["snapshotInputs", "sameAcceptedContent", "equalSlotValues", "retainPiLkgMemo"]);
    instrument(join(dest, "packages/plugin/src/hooks/magic-context/tool-arc-admission.ts"), ["openCodeToolBatchCoordinates", "protectToolBatchMutations"]);
    const logger = join(dest, "packages/plugin/src/hooks/magic-context/transform-stage-logger.ts");
    const text = readFileSync(logger, "utf8");
    assert(text.includes("const elapsed ="));
    writeFileSync(logger, text.replace("const elapsed =", "globalThis.__trainOverheadStage?.(stage, performance.now() - startMs); const elapsed ="));
    return dest;
}
const sources = {
    master: prepare("master", resolve(option("master"))),
    train: prepare("train", resolve(option("train"))),
    candidate: prepare("candidate", resolve(option("candidate", checkout))),
};
interface Pass { ms: number; stages: Record<string, number>; spans: Record<string, number>; wire: string; decision: string; recovery: string; }
interface Child {
    corpus: Record<string, number>;
    run(count: number): Promise<Pass[]>;
    close(): Promise<void>;
}
async function start(source: string, host: string, randomized: boolean): Promise<Child> {
    const root = mkdtempSync(join(scratch, `${host}-`));
    const child = spawn(process.execPath, [join(import.meta.dir, "train-warm-pass-worker.ts"), source, host, randomized ? "random" : "warm"], {
        cwd: root,
        env: { ...process.env, HOME: root, CFFIXED_USER_HOME: root, TMPDIR: root,
            XDG_DATA_HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
            XDG_STATE_HOME: join(root, "state"), PI_CODING_AGENT_DIR: join(root, "pi"),
            MAGIC_CONTEXT_TEST_DATA_DIR: root, MAGIC_CONTEXT_STORAGE_DIR: root,
            MAGIC_CONTEXT_LOG_PATH: join(root, "context.log"), OPENCODE_DB: join(root, "opencode.db"),
            NODE_ENV: "test", TRAIN_OVERHEAD_ROOT: root, TRAIN_OVERHEAD_PROJECT: join(scratch, "project") },
        stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: child.stdout });
    const queue: string[] = [];
    let wake: ((line: string) => void) | undefined;
    let failure: Error | undefined;
    lines.on("line", (line) => { if (!line.startsWith("OVERHEAD ")) return; if (wake) { const w = wake; wake = undefined; w(line); } else queue.push(line); });
    const exited = new Promise<void>((resolveExit, reject) => child.on("exit", (code) => {
        if (code === 0) resolveExit(); else { failure = new Error(`${host} child exited ${code}`); wake?.(`OVERHEAD ${JSON.stringify({ error: failure.message })}`); reject(failure); }
    }));
    void exited.catch(() => undefined);
    async function next(): Promise<{ ready?: boolean; corpus?: Record<string, number>; batch?: string; error?: string }> {
        if (failure) throw failure;
        const timer = setTimeout(() => { failure = new Error(`${host} worker protocol timed out`); child.kill("SIGKILL"); }, 120_000);
        const line = queue.shift() ?? await new Promise<string>((resolveLine) => { wake = resolveLine; });
        clearTimeout(timer);
        const data = JSON.parse(line.slice(9));
        if (data.error) throw new Error(data.error);
        return data;
    }
    console.error(`Starting ${host} ${source}`);
    const ready = await next();
    assert(ready.ready && ready.corpus);
    console.error(`Ready ${host} ${source}`);
    return {
        corpus: ready.corpus,
        async run(count) {
            child.stdin.write(`${count}\n`);
            const data = await next();
            assert(data.batch);
            const rows = JSON.parse(readFileSync(data.batch, "utf8")) as Pass[];
            assert.equal(rows.length, count, "worker returned an incomplete batch");
            for (const row of rows) {
                assert(Number.isFinite(row.ms) && row.ms >= 0, "missing handler timing");
                assert(/^[0-9a-f]{64}$/.test(row.wire), "missing served-byte digest");
                assert(["defer", "execute"].includes(row.decision), "missing scheduler decision");
                assert(typeof row.recovery === "string" && row.recovery.length > 0, "missing recovery decisions");
                if (randomized) assert.equal(JSON.parse(row.recovery).outcomes?.length, 3, "missing recovery probes");
            }
            return rows;
        },
        async close() { child.stdin.end("quit\n"); await exited; lines.close(); },
    };
}
function quantile(values: number[], fraction: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = (sorted.length - 1) * fraction;
    return (sorted[Math.floor(index)] ?? 0) + ((sorted[Math.ceil(index)] ?? 0) - (sorted[Math.floor(index)] ?? 0)) * (index % 1);
}
function summarize(rows: Pass[]) {
    const summarizeKeys = (key: "stages" | "spans") => Object.fromEntries([...new Set(rows.flatMap((r) => Object.keys(r[key])))].sort().map((name) => [name, {
        median: quantile(rows.map((r) => r[key][name] ?? 0), 0.5), p95: quantile(rows.map((r) => r[key][name] ?? 0), 0.95),
    }]));
    return { n: rows.length, median: quantile(rows.map((r) => r.ms), 0.5), p95: quantile(rows.map((r) => r.ms), 0.95), stages: summarizeKeys("stages"), spans: summarizeKeys("spans") };
}
const report: Record<string, unknown> = { bun: Bun.version, scratch, blocks, passes, randomPasses, hosts: {} };
function pressure() {
    return { at: new Date().toISOString(), cpu: readFileSync("/proc/pressure/cpu", "utf8").trim(), loadavg: readFileSync("/proc/loadavg", "utf8").trim() };
}
for (const host of ["opencode1", "opencode2", "pi"]) {
    const children = await Promise.all(Object.entries(sources).map(async ([label, source]) => [label, await start(source, host, false)] as const));
    const byLabel = Object.fromEntries(children);
    const results: Record<string, Pass[][]> = { master: [], train: [], candidate: [] };
    const pressureObservations = [];
    try {
        for (let block = 0; block < blocks; block++) {
            const rows: Record<string, Pass[]> = { master: [], train: [], candidate: [] };
            const before = pressure();
            console.error(`${host} paired block ${block + 1}`);
            for (let pass = 0; pass < passes; pass++) {
                const order = (block + pass) % 2 ? ["candidate", "train", "master"] : ["master", "train", "candidate"];
                for (const label of order) rows[label]?.push(...await byLabel[label]!.run(1));
            }
            for (const label of Object.keys(rows)) results[label]?.push(rows[label]!);
            const observation = { block: block + 1, before, after: pressure() };
            pressureObservations.push(observation);
            console.log(`PRESSURE ${host} ${JSON.stringify(observation)}`);
        }
    } finally { for (const [, child] of children) await child.close(); }
    const randomized: Record<string, Pass[]> = {};
    for (const label of ["train", "candidate"]) {
        const child = await start(sources[label as keyof typeof sources], host, true);
        try { randomized[label] = await child.run(randomPasses); } finally { await child.close(); }
    }
    for (let i = 0; i < randomPasses; i++) {
        assert.equal(randomized.train?.[i]?.wire, randomized.candidate?.[i]?.wire, `${host} randomized request ${i + 1} served bytes changed`);
        assert.equal(randomized.train?.[i]?.decision, randomized.candidate?.[i]?.decision, `${host} randomized request ${i + 1} scheduler decision changed`);
        assert.equal(randomized.train?.[i]?.recovery, randomized.candidate?.[i]?.recovery, `${host} randomized request ${i + 1} recovery decision or replay bytes changed`);
    }
    const recoveryDecisions: Record<string, number> = {};
    for (const row of randomized.candidate ?? []) {
        const recovery = JSON.parse(row.recovery);
        const key = JSON.stringify({ restartRequiresRebuild: recovery.restartRequiresRebuild, outcomes: recovery.outcomes.map((outcome: { kind: string; decision: string }) => [outcome.kind, outcome.decision]) });
        recoveryDecisions[key] = (recoveryDecisions[key] ?? 0) + 1;
    }
    const hostReport = { pressureObservations, corpus: Object.fromEntries(children.map(([label, child]) => [label, child.corpus])), timing: Object.fromEntries(Object.entries(results).map(([label, rows]) => [label, { pooled: summarize(rows.flat()), blocks: rows.map(summarize) }])), differential: { requests: randomPasses, identical: true, identicalRecovery: true, replayProbesPerRequest: 3, recoveryDecisions }, raw: results };
    (report.hosts as Record<string, unknown>)[host] = hostReport;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`HOST ${host} corpus ${JSON.stringify(hostReport.corpus)}`);
    for (const [label, rows] of Object.entries(results)) {
        console.log(`TIMING ${host} ${label} pooled ${JSON.stringify({ n: rows.flat().length, median: summarize(rows.flat()).median, p95: summarize(rows.flat()).p95 })}`);
        rows.forEach((block, index) => console.log(`BLOCK ${host} ${label} ${index + 1} ${JSON.stringify({ n: block.length, median: summarize(block).median, p95: summarize(block).p95 })}`));
    }
    for (const kind of ["stages", "spans"] as const) {
        const summaries = Object.fromEntries(Object.entries(results).map(([label, rows]) => [label, summarize(rows.flat())[kind]]));
        for (const name of [...new Set(Object.values(summaries).flatMap((s) => Object.keys(s)))].sort()) {
            console.log(`STAGE ${host} ${kind} ${name} ${JSON.stringify(Object.fromEntries(Object.entries(summaries).map(([label, s]) => [label, s[name]?.median ?? 0])))}`);
        }
    }
    console.log(`DIFFERENTIAL ${host} ${randomPasses} identical requests`);
}
console.log(`Report: ${output}`);
