import { expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDir } from "../../../shared/test-temp-dir";

const repo = fileURLToPath(new URL("../../../../../../", import.meta.url));
const driver = `
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
const [entry, root] = process.argv.slice(2);
process.umask(0o022);
const worker = new Worker(pathToFileURL(entry));
try {
  for (const privateStorage of [true, false]) {
    const destination = root + '/' + privateStorage + '/pin.json';
    const record = { directory: root + '/project', identity: 'pj-BUNDLE', gitCommonDir: root + '/repo.git' };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pin worker stalled')), 5000);
      worker.once('error', reject);
      worker.once('message', message => {
        clearTimeout(timer);
        message.ok ? resolve() : reject(new Error(message.error));
      });
      worker.postMessage({destination, record, privateStorage});
    });
    assert.deepEqual(JSON.parse(readFileSync(destination, 'utf8')), record);
    if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, privateStorage ? 0o600 : 0o644);
  }
  console.log('project pin worker: 4 checks passed on ' + process.version);
} finally { await worker.terminate(); }
`;

for (const [runtime, directory] of [
    ["bun", "packages/plugin/dist"],
    ["node", "packages/plugin/dist"],
    ["node", "packages/plugin/dist/v2"],
    ["node", "packages/pi-plugin/dist"],
] as const) {
    test.skipIf(!Bun.which(runtime))(
        `built pin worker uses unchanged atomic writes under ${runtime}: ${directory}`,
        async () => {
            const temp = createTestTempDir("mc-pin-bundle-");
            try {
                const packageDirectory = directory.startsWith("packages/pi-plugin")
                    ? "packages/pi-plugin"
                    : "packages/plugin";
                const manifest = JSON.parse(
                    readFileSync(join(repo, packageDirectory, "package.json"), "utf8"),
                );
                const script = manifest.scripts[
                    directory.endsWith("/v2") ? "build:v2" : "build"
                ] as string;
                // Use the actual split-build entry list in a private output directory,
                // so concurrent tests never lose the build artifacts they are importing.
                const build = script
                    .split(" && ")
                    .find((part) => part.startsWith("bun build ") && part.includes("--splitting"));
                if (!build) throw new Error("Package has no split worker build");
                const args = build
                    .split(" ")
                    .slice(1)
                    .map((arg) => arg.replace(/^'|'$/g, ""));
                args[args.indexOf("--outdir") + 1] = join(temp.dir, "dist");
                const compile = Bun.spawn([process.execPath, ...args], {
                    cwd: join(repo, packageDirectory),
                    windowsHide: true,
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const [buildOut, buildError, buildCode] = await Promise.all([
                    new Response(compile.stdout).text(),
                    new Response(compile.stderr).text(),
                    compile.exited,
                ]);
                expect({
                    code: buildCode,
                    error: buildCode === 0 ? "" : buildOut + buildError,
                }).toEqual({ code: 0, error: "" });
                const driverPath = join(temp.dir, "driver.mjs");
                writeFileSync(driverPath, driver);
                const child = Bun.spawn(
                    [
                        runtime,
                        driverPath,
                        join(temp.dir, "dist", "project-pin-worker.js"),
                        temp.dir,
                    ],
                    {
                        cwd: temp.dir,
                        windowsHide: true,
                        stdin: "ignore",
                        stdout: "pipe",
                        stderr: "pipe",
                        env: { PATH: process.env.PATH, HOME: temp.dir },
                    },
                );
                const [out, error, code] = await Promise.all([
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                    child.exited,
                ]);
                expect({ code, error: code === 0 ? "" : error }).toEqual({ code: 0, error: "" });
                expect(out).toContain("4 checks passed");
            } finally {
                temp.cleanup();
            }
        },
    );
}

test("natural exit best-effort flushes an unreferenced pin worker", async () => {
    const temp = createTestTempDir("mc-pin-exit-");
    try {
        const source = fileURLToPath(new URL("./project-identity-cache.ts", import.meta.url));
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `
            import { rememberPinnedProjectIdentity } from ${JSON.stringify(source)};
            rememberPinnedProjectIdentity(${JSON.stringify(temp.dir)}, "pj-EXIT");
        `,
            ],
            {
                cwd: temp.dir,
                windowsHide: true,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                env: {
                    PATH: process.env.PATH,
                    HOME: temp.dir,
                    MAGIC_CONTEXT_STORAGE_DIR: temp.dir,
                },
            },
        );
        const error = new Response(child.stderr).text();
        expect({ code: await child.exited, error: await error }).toEqual({ code: 0, error: "" });
        const files = readdirSync(join(temp.dir, "project-identities"));
        expect(files).toHaveLength(1);
        expect(
            JSON.parse(readFileSync(join(temp.dir, "project-identities", files[0]), "utf8"))
                .identity,
        ).toBe("pj-EXIT");
    } finally {
        temp.cleanup();
    }
});
