import { expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestTempDir } from "../../../shared/test-temp-dir";

/** Exercise the published package boundary, not a source-file import bypassing exports. */
test("host-runner subpath import in a clean process has no database, logger or global side effects", () => {
    const packageRoot = resolve(import.meta.dir, "../../../..");
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const exported = manifest.exports["./host-runner"];
    expect(exported).toEqual({ types: "./dist/host-runner.d.ts", import: "./dist/host-runner.js" });
    expect(existsSync(join(packageRoot, exported.import))).toBe(true);
    expect(existsSync(join(packageRoot, exported.types))).toBe(true);
    const { dir: scratch, cleanup } = createTestTempDir("mc-host-runner-import-");
    try {
        writeFileSync(join(scratch, "package.json"), JSON.stringify(manifest));
        symlinkSync(join(packageRoot, "dist"), join(scratch, "dist"), "dir");
        writeFileSync(
            join(scratch, "deny-sqlite.mjs"),
            `
            export async function resolve(specifier, context, nextResolve) {
                if (/^(bun|node):sqlite$/.test(specifier) || /better-sqlite3/.test(specifier)) {
                    throw new Error('database module loaded during import: ' + specifier);
                }
                return nextResolve(specifier, context);
            }
        `,
        );
        writeFileSync(
            join(scratch, "probe.mjs"),
            `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import fsp from 'node:fs/promises';
            import timers from 'node:timers';
            import { syncBuiltinESMExports } from 'node:module';
            const deny = () => { throw new Error('filesystem write or timer started during import'); };
            for (const name of ['open', 'openSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
                'mkdir', 'mkdirSync', 'createWriteStream']) fs[name] = deny;
            for (const name of ['open', 'writeFile', 'appendFile', 'mkdir']) fsp[name] = deny;
            for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
                timers[name] = deny;
                globalThis[name] = deny;
            }
            syncBuiltinESMExports();
            const globals = Reflect.ownKeys(globalThis);
            const listeners = process.eventNames().map(name => [name, process.listenerCount(name)]);
            const handles = process._getActiveHandles().length;
            const loaded = await import('@cortexkit/opencode-magic-context/host-runner');
            assert.equal(typeof loaded.isFallbackAdmissible, 'function');
            assert.equal(typeof loaded.recordProviderUsage, 'function');
            assert.equal(typeof loaded.loadOpenCodeProviderAdapter, 'function');
            assert.equal(typeof loaded.record.createRecord, 'function');
            assert.deepEqual(Reflect.ownKeys(globalThis), globals);
            assert.deepEqual(process.eventNames().map(name => [name, process.listenerCount(name)]), listeners);
            assert.equal(process._getActiveHandles().length, handles);
            console.log('HOST_RUNNER_IMPORT_PURE: 7 checks passed');
        `,
        );
        const child = Bun.spawnSync(
            [
                "node",
                "--no-warnings",
                "--experimental-loader",
                join(scratch, "deny-sqlite.mjs"),
                join(scratch, "probe.mjs"),
            ],
            {
                cwd: scratch,
                env: {
                    ...process.env,
                    NODE_ENV: "production",
                    HOME: scratch,
                    XDG_DATA_HOME: scratch,
                    XDG_STATE_HOME: scratch,
                    XDG_CONFIG_HOME: scratch,
                    XDG_CACHE_HOME: scratch,
                },
                stdout: "pipe",
                stderr: "pipe",
                windowsHide: true,
            },
        );
        expect({ exit: child.exitCode, stderr: child.stderr.toString() }).toEqual({
            exit: 0,
            stderr: "",
        });
        expect(child.stdout.toString()).toContain("HOST_RUNNER_IMPORT_PURE: 7 checks passed");
    } finally {
        cleanup();
    }
});
