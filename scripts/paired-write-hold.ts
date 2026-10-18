// Linux: bun scripts/paired-write-hold.ts --before-ref <commit> --passes 200 --block 10 --out <directory>
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const option = (name: string, fallback: string) => {
    const at = process.argv.indexOf(name);
    return at < 0 ? fallback : (process.argv[at + 1] ?? fallback);
};

if (import.meta.main) {
    if (process.argv.includes("--heartbeat")) {
        const gaps: number[][] = [];
        const loads: number[][] = [];
        let previous = Date.now();
        const heartbeat = setInterval(() => {
            const now = Date.now();
            gaps.push([previous, now, now - previous]);
            previous = now;
        }, 5);
        const sampler = setInterval(() => loads.push([Date.now(), ...loadavg()]), 1000);
        process.on("SIGTERM", () => {
            clearInterval(heartbeat);
            clearInterval(sampler);
            writeFileSync(option("--out", "heartbeat.json"), JSON.stringify({ gaps, loads }));
            process.exit(0);
        });
        console.log("CONTROL_READY");
    } else {
        await main();
    }
}

type Hold = { site: string; held: number; start: number; end: number };
type Row = {
    kind: string;
    start: number;
    end: number;
    wall: number;
    paired?: Hold[];
    holds?: Hold[];
    lockMax?: number;
    lockMaxLabel?: string;
    connectionHold?: { start: number; end: number };
};
type Sample = { path: string; arm: string; index: number; row: Row };

class Worker {
    readonly child: ChildProcessWithoutNullStreams;
    private lines: string[] = [];
    private changed?: () => void;
    private closed = false;
    private transcript = "";
    private errors = "";
    readonly exit: Promise<number | null>;
    constructor(tree: string, path: string, out: string, passes: number, block: number) {
        const pi = path === "pi";
        this.child = spawn(
            process.execPath,
            [
                "test",
                pi
                    ? "./packages/pi-plugin/benchmarks/write-hold-measure.bench.ts"
                    : "./packages/plugin/benchmarks/paired-write-hold.bench.ts",
            ],
            {
                cwd: tree,
                env: {
                    ...process.env,
                    BUN_JSC_useOMGJIT: "0",
                    HOLD_DRIVER: "1",
                    HOLD_PASSES: String(passes),
                    HOLD_TURNS: option("--turns", "1300"),
                    HOLD_BULK_WARM: pi ? "1" : "0",
                    HOLD_OUT: out,
                    HOLD_TS_GENERATION: path.slice(3),
                    HOLD_BLOCK: String(block),
                },
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
        createInterface({ input: this.child.stdout }).on("line", (line) => {
            this.transcript += `${line}\n`;
            if (line === "HOLD_READY" || line.startsWith("HOLD_RESULT ")) {
                this.lines.push(line);
                this.changed?.();
            }
        });
        this.child.stderr.on("data", (chunk) => {
            this.errors += String(chunk);
        });
        this.exit = new Promise((done) =>
            this.child.once("close", (code) => {
                this.closed = true;
                this.changed?.();
                writeFileSync(`${out}.log`, this.transcript + this.errors);
                done(code);
            }),
        );
    }
    async receive(): Promise<string> {
        while (!this.lines.length) {
            if (this.closed)
                throw new Error(`Benchmark worker exited: ${this.errors.slice(-4000)}`);
            await new Promise<void>((done) => {
                this.changed = done;
            });
            this.changed = undefined;
        }
        return this.lines.shift() as string;
    }
    async ready(): Promise<void> {
        if ((await this.receive()) !== "HOLD_READY")
            throw new Error("Worker did not acknowledge initialization");
    }
    async pass(kind: "defer" | "busting"): Promise<Row> {
        this.child.stdin.write(`${kind}\n`);
        const line = await this.receive();
        if (!line.startsWith("HOLD_RESULT "))
            throw new Error(`Unexpected worker response: ${line}`);
        return JSON.parse(line.slice("HOLD_RESULT ".length)) as Row;
    }
    async stop(): Promise<void> {
        this.child.stdin.end("stop\n");
        if ((await this.exit) !== 0)
            throw new Error(`Benchmark failed: ${this.errors.slice(-4000)}`);
    }
}

async function command(args: string[], cwd: string): Promise<void> {
    const child = spawn(args[0] as string, args.slice(1), { cwd, stdio: "inherit" });
    const [code] = await once(child, "close");
    if (code !== 0) throw new Error(`Command failed (${code}): ${args.join(" ")}`);
}

async function main(): Promise<void> {
    const root = process.cwd();
    const out = resolve(
        option("--out", ".cortexkit/internal-docs/investigations/pi-paired-evidence/interleaved"),
    );
    mkdirSync(out, { recursive: true });
    const passes = Number(option("--passes", "200"));
    const block = Number(option("--block", "10"));
    if (passes < 1 || block < 1 || passes % (2 * block))
        throw new Error("passes must be a positive multiple of twice the ABBA block size");
    const reference = option("--before-ref", "0ef813674cb150e59622d43de4816b0218550755");
    const scratch = mkdtempSync(join(tmpdir(), "paired-hold-arms-"));
    const base = join(scratch, "before");
    mkdirSync(base);
    const controlFile = join(out, "control.json");
    const control = spawn(
        process.execPath,
        [resolve("scripts/paired-write-hold.ts"), "--heartbeat", "--out", controlFile],
        { stdio: ["pipe", "pipe", "inherit"] },
    );
    const controlExit = once(control, "close");
    await new Promise<void>((done) =>
        createInterface({ input: control.stdout }).once("line", () => done()),
    );
    const samples: Sample[] = [];
    const workers: Worker[] = [];
    let failure: unknown;
    try {
        // Archives require no writes to .git, including on the read-only build server.
        await command(
            [
                "bash",
                "-c",
                'set -euo pipefail; git archive "$1" | tar -x -C "$2"',
                "archive",
                reference,
                base,
            ],
            root,
        );
        symlinkSync(join(root, "node_modules"), join(base, "node_modules"));
        for (const entry of readdirSync(join(root, "packages"))) {
            try {
                symlinkSync(
                    join(root, "packages", entry, "node_modules"),
                    join(base, "packages", entry, "node_modules"),
                );
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
        for (const file of [
            "scripts/paired-write-hold-protocol.ts",
            "packages/pi-plugin/benchmarks/write-hold-measure.bench.ts",
            "packages/plugin/benchmarks/paired-write-hold.bench.ts",
        ]) {
            mkdirSync(join(base, file, ".."), { recursive: true });
            copyFileSync(join(root, file), join(base, file));
        }
        for (const path of option("--paths", "pi,ts-v1,ts-v2").split(",")) {
            const before = new Worker(base, path, join(out, `${path}-before`), passes, block);
            workers.push(before);
            await before.ready();
            const after = new Worker(root, path, join(out, `${path}-after`), passes, block);
            workers.push(after);
            await after.ready();
            for (const kind of ["defer", "busting"] as const) {
                let beforeIndex = 0;
                let afterIndex = 0;
                for (let cycle = 0; cycle < passes / (2 * block); cycle++) {
                    for (const arm of ["before", "after", "after", "before"]) {
                        const worker = arm === "before" ? before : after;
                        for (let i = 0; i < block; i++) {
                            const row = await worker.pass(kind);
                            const index = arm === "before" ? beforeIndex++ : afterIndex++;
                            samples.push({ path, arm, index, row });
                        }
                    }
                    console.log(
                        `ABBA ${path} ${kind}: ${(cycle + 1) * 2 * block}/${passes} passes per arm`,
                    );
                }
            }
            await before.stop();
            await after.stop();
        }
    } catch (error) {
        failure = error;
    } finally {
        for (const worker of workers)
            if (worker.child.exitCode === null) worker.child.kill("SIGTERM");
        control.kill("SIGTERM");
        await controlExit;
        const controlData = JSON.parse(readFileSync(controlFile, "utf8")) as {
            gaps: number[][];
            loads: number[][];
        };
        const result = summarize(samples, controlData.gaps);
        writeFileSync(
            join(out, "results.json"),
            JSON.stringify({ reference, passes, block, samples, ...result }, null, 2),
        );
        console.log(
            `CONTROL samples=${controlData.gaps.length} load_samples=${controlData.loads.length}`,
        );
        for (const [name, value] of Object.entries(result.summary))
            console.log(`SUMMARY ${name} ${JSON.stringify(value)}`);
        for (const row of result.outliers) console.log(`OUTLIER ${JSON.stringify(row)}`);
        console.log(`ARTIFACTS ${out}`);
    }
    if (failure) throw failure;
}

export function summarize(samples: Sample[], gaps: number[][]) {
    const maxGap = (start: number, end: number): number => {
        let lo = 0;
        let hi = gaps.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if ((gaps[mid]?.[1] ?? 0) < start) lo = mid + 1;
            else hi = mid;
        }
        let result = 0;
        for (let i = lo; i < gaps.length && (gaps[i]?.[0] ?? Infinity) <= end; i++)
            result = Math.max(result, gaps[i]?.[2] ?? 0);
        return result;
    };
    const quantiles = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        if (!sorted.length) return { n: 0 };
        return {
            n: sorted.length,
            p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
            p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
            max: sorted[sorted.length - 1],
            over50: sorted.filter((v) => v > 50).length,
        };
    };
    const outliers: object[] = [];
    const summary: Record<string, object> = {};
    for (const path of new Set(samples.map((sample) => sample.path))) {
        for (const arm of ["before", "after"]) {
            for (const kind of ["defer", "busting"]) {
                const rows = samples.filter(
                    (sample) =>
                        sample.path === path && sample.arm === arm && sample.row.kind === kind,
                );
                const quiet = rows.filter(({ row }) => maxGap(row.start, row.end) <= 20);
                const sites =
                    path === "pi"
                        ? ["paired_thinking_edit", "connection_max"]
                        : ["ts_lane_pair", "ts_final_representation", "unclassified_pair"];
                const values: Record<string, object> = {
                    passes: {
                        all: rows.length,
                        quiet: quiet.length,
                        environmental: rows.length - quiet.length,
                    },
                    wallAll: quantiles(rows.map(({ row }) => row.wall)),
                    wallQuiet: quantiles(quiet.map(({ row }) => row.wall)),
                };
                for (const site of sites) {
                    const holds = (row: Row): Hold[] =>
                        site === "connection_max"
                            ? row.connectionHold
                                ? [{ site, held: row.lockMax ?? 0, ...row.connectionHold }]
                                : []
                            : (row.paired ?? row.holds ?? []).filter((hold) => hold.site === site);
                    values[site] = {
                        all: quantiles(
                            rows.map(({ row }) => Math.max(0, ...holds(row).map((h) => h.held))),
                        ),
                        quiet: quantiles(
                            quiet.map(({ row }) => Math.max(0, ...holds(row).map((h) => h.held))),
                        ),
                        calls: rows.reduce((sum, { row }) => sum + holds(row).length, 0),
                    };
                    for (const sample of rows)
                        for (const hold of holds(sample.row))
                            if (hold.held > 50) {
                                const gap = maxGap(hold.start, hold.end);
                                outliers.push({
                                    path,
                                    arm,
                                    kind,
                                    index: sample.index,
                                    site,
                                    held: hold.held,
                                    start: hold.start,
                                    end: hold.end,
                                    controlGap: gap,
                                    attribution: gap > 20 ? "environmental" : "ours",
                                    ...(site === "connection_max"
                                        ? { label: sample.row.lockMaxLabel }
                                        : {}),
                                });
                            }
                }
                summary[`${path}/${arm}/${kind}`] = values;
            }
        }
    }
    return { summary, outliers };
}
