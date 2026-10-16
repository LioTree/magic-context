import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestTempDir } from "../packages/plugin/src/shared/test-temp-dir";

const root = resolve(import.meta.dir, "..");
const base = "676d0e1f9e9fd2cbdd5e5d9777b605258c0ffa37";
test("memory history follow-up matches independent base serving records for OC1 OC2 and Pi", () => {
    const { dir, cleanup } = createTestTempDir("memory-history-base-followup-");
    try {
        const archive = join(dir, "base.tar");
        const baseRoot = join(dir, "base"); mkdirSync(baseRoot);
        execFileSync("git", ["archive", base, "-o", archive], { cwd: root, windowsHide: true });
        execFileSync("tar", ["-xf", archive, "-C", baseRoot], { windowsHide: true });
        for (const relative of ["node_modules", "packages/plugin/node_modules", "packages/pi-plugin/node_modules", "packages/retina-local-fs/node_modules"]) {
            const source = join(root, relative);
            if (existsSync(source)) symlinkSync(source, join(baseRoot, relative), "dir");
        }
        for (const host of ["OC1", "OC2", "Pi"]) {
            const outputs = [baseRoot, root].map((sourceRoot, index) => {
                const output = join(dir, `${host}-${index}.json`);
                const run = Bun.spawnSync(["bun", join(root, "scripts/memory-history-base-review.test.ts"), sourceRoot, host, output], { cwd: root, windowsHide: true, env: { ...process.env, BUN_JSC_useOMGJIT: "0" } });
                expect(run.exitCode, run.stderr.toString()).toBe(0);
                return JSON.parse(readFileSync(output, "utf8")) as { records: unknown[]; attemptedReads: string[]; schema: unknown; schemaVersion: unknown };
            });
            expect(outputs[0]!.records).toHaveLength(242);
            expect(outputs[1]!.records).toEqual(outputs[0]!.records);
            expect(outputs[1]!.attemptedReads).toEqual([]);
            expect(outputs[1]!.schema).toEqual(outputs[0]!.schema);
            expect(outputs[1]!.schemaVersion).toEqual(outputs[0]!.schemaVersion);
        }
    } finally { cleanup(); }
}, 180_000);
