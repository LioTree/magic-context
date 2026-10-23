import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { calibrationForModelKey } from "./decision-calibration";
import type { MarkerEnvelope } from "./marker-envelope";
import { markerRandom, randomMarkerEnvelope } from "./marker-envelope-test-support";
import { estimateTokens, hasTokenizerForFit } from "./read-session-formatting";
import { UNKNOWN_FIT_RATIO } from "./tokenizer-calibration";

async function fixture() {
    const scratch = createTestTempDir("marker-envelope-loader-");
    try {
        // Expose the real logger's forwarding hook only in this fixture so the
        // once-only diagnostic is observable without writing log files.
        const entry = join(scratch.dir, "entry.ts");
        writeFileSync(
            entry,
            `export { boundMarkerEnvelope } from ${JSON.stringify(join(import.meta.dir, "marker-envelope.ts"))};\nexport { setLogLineForwarder } from ${JSON.stringify(join(import.meta.dir, "../../shared/logger.ts"))};\n`,
        );
        const built = await Bun.build({
            entrypoints: [entry],
            target: "node",
            format: "esm",
            write: false,
            // Bun tests default to test mode, which intentionally suppresses logging.
            define: { "process.env.NODE_ENV": JSON.stringify("production") },
        });
        expect(built.success, JSON.stringify(built.logs)).toBe(true);
        const modulePath = join(scratch.dir, "extension", "marker-envelope.mjs");
        const home = join(scratch.dir, "home");
        const cwd = join(scratch.dir, "neutral");
        mkdirSync(join(scratch.dir, "extension"), { recursive: true });
        mkdirSync(home, { recursive: true });
        mkdirSync(cwd);
        writeFileSync(modulePath, await built.outputs[0]!.text());
        return { ...scratch, home, cwd, modulePath };
    } catch (error) {
        scratch.cleanup();
        throw error;
    }
}

function probe(
    root: Awaited<ReturnType<typeof fixture>>,
    corpus: readonly MarkerEnvelope[],
    models: string[],
) {
    const input = join(root.dir, "corpus.json");
    writeFileSync(input, JSON.stringify({ corpus, models }));
    const script = `
        const { createRequire } = await import('node:module');
        const { readFileSync } = await import('node:fs');
        process.argv[1] = '-p';
        let bareFailed = false;
        try { createRequire(${JSON.stringify(root.modulePath)}).resolve('ai-tokenizer'); }
        catch { bareFailed = true; }
        const mod = await import(${JSON.stringify(pathToFileURL(root.modulePath).href)});
        const logLines = [];
        mod.setLogLineForwarder(line => logLines.push(line));
        const { corpus, models } = JSON.parse(readFileSync(${JSON.stringify(input)}, 'utf8'));
        const bounds = corpus.map(material => models.map(model => mod.boundMarkerEnvelope(material, model)));
        await new Promise(resolve => setImmediate(resolve));
        process.stdout.write(JSON.stringify({ bareFailed, bounds, logLines }));
    `;
    const child = spawnSync(process.execPath, ["--no-install", "-e", script], {
        cwd: root.cwd,
        env: {
            ...process.env,
            NODE_ENV: "production",
            HOME: root.home,
            BUN_INSTALL: root.home,
            XDG_CACHE_HOME: join(root.home, ".cache"),
            XDG_DATA_HOME: join(root.home, ".data"),
            XDG_STATE_HOME: join(root.home, ".state"),
        },
        encoding: "utf8",
        windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as {
        bareFailed: boolean;
        bounds: number[][];
        logLines: string[];
    };
    // A bare resolve must fail here or the non-default-root test would be vacuous.
    expect(result.bareFailed).toBe(true);
    return { ...result, stderr: child.stderr };
}

function plantTokenizer(packageDir: string, marker: number) {
    mkdirSync(join(packageDir, "encoding"), { recursive: true });
    writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
            name: "ai-tokenizer",
            type: "module",
            exports: {
                ".": { import: "./index.js" },
                "./encoding/claude": { import: "./encoding/claude.js" },
            },
        }),
    );
    writeFileSync(
        join(packageDir, "index.js"),
        `export default class Tokenizer { encode(text) { return new Array(text.length + ${marker}).fill(1); } }`,
    );
    writeFileSync(join(packageDir, "encoding", "claude.js"), "export default {};");
}

test("marker envelope loads the shared tokenizer from the OMP plugin root", async () => {
    const root = await fixture();
    try {
        const marker = 991;
        plantTokenizer(join(root.home, ".omp", "plugins", "node_modules", "ai-tokenizer"), marker);
        const material = {
            system: ["Final system 日本語"],
            tools: [{ name: "read", description: "Read file", inputSchema: { type: "object" } }],
        };
        const result = probe(root, [material], ["unknown/model"]);
        const tokenizedFields =
            material.system.reduce(
                (sum, text) => sum + JSON.stringify(text).length + marker + 32,
                32,
            ) +
            material.tools.reduce(
                (sum, tool) =>
                    sum +
                    [tool.name, tool.description, tool.inputSchema].reduce<number>(
                        (total, value) => total + JSON.stringify(value).length + marker,
                        64,
                    ),
                0,
            );
        // The planted counter identifies a successful probe. A silent switch to
        // byte lengths is deliberately too small to satisfy this equality.
        expect(result.bounds).toEqual([[Math.ceil(tokenizedFields * UNKNOWN_FIT_RATIO)]]);
        expect(result.stderr).toBe("");
        expect(result.logLines).toEqual([]);
    } finally {
        root.cleanup();
    }
});

test("unavailable tokenizer uses a once-logged byte bound above randomized token counts", async () => {
    expect(hasTokenizerForFit()).toBe(true);
    const root = await fixture();
    try {
        const next = markerRandom(0xbeef);
        const corpus: MarkerEnvelope[] = [
            { system: [], tools: [] },
            { system: ['😀日本語\u0000\n"\\'.repeat(50)], tools: [] },
            ...Array.from({ length: 240 }, () => randomMarkerEnvelope(next)),
        ];
        const models = [
            "anthropic/claude-sonnet-4-5",
            "openai/gpt-5",
            "google/gemini-2.5-pro",
            "unknown/model",
        ];
        const result = probe(root, corpus, models);
        for (const [index, material] of corpus.entries()) {
            const fields = [
                ...material.system.map((text) => JSON.stringify(text)),
                ...material.tools.flatMap((tool) =>
                    [tool.name, tool.description, tool.inputSchema].map((value) =>
                        JSON.stringify(value),
                    ),
                ),
            ];
            const allowances = 32 + material.system.length * 32 + material.tools.length * 64;
            const byteBound = fields.reduce(
                (sum, field) => sum + Buffer.byteLength(field, "utf8"),
                allowances,
            );
            const tokenizerBound = fields.reduce(
                (sum, field) => sum + estimateTokens(field),
                allowances,
            );
            const serialized = JSON.stringify({
                system: material.system,
                tools: material.tools.map((tool) => ({ type: "function", ...tool })),
            });
            for (const [modelIndex, model] of models.entries()) {
                const seed = calibrationForModelKey(model);
                const ratio = seed.seeded
                    ? Math.max(seed.systemRatio, seed.toolsRatio, seed.proseRatio)
                    : UNKNOWN_FIT_RATIO;
                const actual = result.bounds[index]![modelIndex]!;
                expect(actual).toBe(Math.ceil(byteBound * ratio));
                expect(actual).toBeGreaterThanOrEqual(Math.ceil(tokenizerBound * ratio));
                expect(actual).toBeGreaterThanOrEqual(
                    Math.ceil(estimateTokens(serialized) * ratio),
                );
            }
        }
        expect(result.stderr).toBe("");
        expect(
            result.logLines.filter((line) =>
                line.includes("using a conservative approximate UTF-8 byte bound"),
            ),
        ).toHaveLength(1);
        console.log(
            `marker-envelope byte fallback: ${corpus.length} envelopes, ${corpus.length * models.length} model comparisons, one warning`,
        );
    } finally {
        root.cleanup();
    }
});
