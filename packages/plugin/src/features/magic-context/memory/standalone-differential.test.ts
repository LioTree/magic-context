import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    buildFlags,
    buildFrame,
    computeProof,
    decodeHeader,
    encodeFrame,
    FrameType,
    HEADER_LEN,
    Priority,
    SERVER_PROOF_DOMAIN,
} from "@cortexkit/subc-client";

import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";

// Release v0.49.2 supplies the standalone behavior from before registered-project lookup.
const BASE = "cc654a68fd0441d245712be76eb23087e70b7ef0";
const repo = resolve(import.meta.dir, "../../../../../..");
let scratch: string;
let baseline: string;
let host: string;

// Run both revisions through the real OpenCode transform in separate processes. The same
// checkout paths and fixed clock make directory hashes and cached-prefix bytes comparable.
const hostSource = `
const [root, fixture, connectionFile, mode, storage] = process.argv.slice(2);
const { execFileSync } = await import("node:child_process");
const { mkdirSync, readdirSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const load = (file) => import(join(root, "packages/plugin/src", file));
const identity = await load("features/magic-context/memory/project-identity.ts");
const { createTransform } = await load("hooks/magic-context/transform.ts");
const { createTagger } = await load("features/magic-context/tagger.ts");
const { openDatabase, closeDatabase } = await load("features/magic-context/storage.ts");
const { insertMemory } = await load("features/magic-context/memory/storage-memory.ts");
const { getHarness } = await load("shared/harness.ts");
let now = 1800000000000;
Date.now = () => now;
let failing = false;
let failedProbes = 0;
identity.__setProjectIdentityTestHooks({
    nowMs: () => now,
    execFileSync: (...args) => {
        if (failing) { failedProbes++; throw new Error("transient git failure"); }
        return execFileSync(...args);
    },
});
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, windowsHide: true, env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
}, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const db = openDatabase();
if (!db) throw new Error("throwaway host database did not open");
console.log("READY " + process.pid);
// Keep the database open until the parent has inspected the host's file descriptors.
for await (const line of console) { if (line === "continue") break; }
const transcript = [];
const seeded = new Set();
for (const scenario of ["stable", "plain", "unborn", "recovering"]) {
    const directory = join(fixture, scenario);
    const session = "standalone-" + scenario;
    const commit = scenario !== "plain" && scenario !== "unborn"
        ? git(directory, "rev-list", "--max-parents=0", "HEAD") : null;
    const dirIdentity = "dir:" + (await import("node:crypto")).createHash("md5")
        .update(directory).digest("hex").slice(0, 12);
    const expectedGit = scenario === "unborn"
        ? git(directory, "rev-parse", "refs/fixture/first") : commit;
    for (const key of [dirIdentity, expectedGit && "git:" + expectedGit].filter(Boolean)) {
        if (seeded.has(key)) continue;
        seeded.add(key);
        insertMemory(db, { projectPath: key, category: "USER_DIRECTIVES",
            content: "standalone memory for " + key });
    }
    const transform = createTransform({
        db, tagger: createTagger(), scheduler: { shouldExecute: () => "defer" },
        contextUsageMap: new Map(), historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 50, protectedTokens: 0, historianRunnable: false,
        directory, sessionDirectoryBySession: new Map([[session, directory]]),
        subcConnectionFile: connectionFile,
        memoryConfig: { enabled: true, injectionBudgetTokens: 1000, autoPromote: false },
    });
    failing = scenario === "recovering";
    for (let phase = 0; phase < 2; phase++) {
        if (phase === 1) {
            failing = false;
            now += 301000;
            if (scenario === "unborn") git(directory, "update-ref", "refs/heads/main", expectedGit);
        }
        const output = { messages: [{ info: { id: "user-1", role: "user", sessionID: session },
            parts: [{ type: "text", text: "continue" }] }] };
        await transform({}, output);
        const row = db.prepare("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = ?")
            .get(session, getHarness());
        transcript.push({ scenario, phase, identity: row?.project_path ?? null,
            prefix: JSON.stringify(output.messages) });
    }
}
const sidecars = (() => { try { return readdirSync(join(storage, "project-identities"))
    .filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(join(storage, "project-identities", f), "utf8"))); }
    catch { return []; } })();
if (sidecars.length === 0) throw new Error("did not observe the resolver's legacy git records");
if (sidecars.some(record => record.identity.startsWith("pj-"))) throw new Error("standalone wrote a pin");
closeDatabase();
console.log("RESULT " + JSON.stringify({ transcript, failedProbes, mode }));
`;

beforeAll(() => {
    mkdirSync(join(tmpdir(), "magic-context"), { recursive: true });
    scratch = createTestTempDirFromPath(join(tmpdir(), "magic-context", "standalone-"));
    baseline = join(scratch, "base");
    mkdirSync(baseline);
    const archive = execFileSync(
        "git",
        ["archive", BASE, "packages/plugin", "packages/retina-local-fs"],
        {
            cwd: repo,
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    execFileSync("tar", ["-x", "-C", baseline], { input: archive, windowsHide: true });
    symlinkSync(join(repo, "node_modules"), join(baseline, "node_modules"), "dir");
    for (const pkg of ["plugin", "retina-local-fs"]) {
        symlinkSync(
            join(repo, "packages", pkg, "node_modules"),
            join(baseline, "packages", pkg, "node_modules"),
            "dir",
        );
    }
    host = join(scratch, "host.ts");
    writeFileSync(host, hostSource);
});

afterAll(() => cleanupTestTempDir(scratch));

function git(directory: string, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd: directory,
        windowsHide: true,
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
            GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
            GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
        },
    })
        .toString()
        .trim();
}

function fixtures(directory: string): void {
    rmSync(directory, { recursive: true, force: true });
    for (const name of ["stable", "plain", "unborn", "recovering"]) {
        const folder = join(directory, name);
        mkdirSync(folder, { recursive: true });
        if (name === "plain") continue;
        git(folder, "init", "-b", "main");
        git(folder, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "fixture");
        if (name === "unborn") {
            git(folder, "update-ref", "refs/fixture/first", "HEAD");
            git(folder, "update-ref", "-d", "refs/heads/main");
        }
    }
}

// This peer uses the authenticated subc protocol and reports an unloaded module.
async function absentModule(connectionFile: string) {
    const sockets = new Set<Socket>();
    let calls = 0;
    const key = new Uint8Array(32).fill(9);
    const daemonId = new Uint8Array(16).fill(7);
    const serverNonce = new Uint8Array(32).fill(5);
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        void (async () => {
            const iterator = socket[Symbol.asyncIterator]();
            let buffered = Buffer.alloc(0);
            const bytes = async (length: number) => {
                while (buffered.length < length) {
                    const next = await iterator.next();
                    if (next.done) throw new Error("peer closed");
                    buffered = Buffer.concat([buffered, next.value]);
                }
                const result = buffered.subarray(0, length);
                buffered = buffered.subarray(length);
                return result;
            };
            const auth = async () =>
                JSON.parse((await bytes((await bytes(4)).readUInt32LE())).toString());
            const hello = await auth();
            const proof = Buffer.from(
                JSON.stringify({
                    server_nonce: [...serverNonce],
                    daemon_id: [...daemonId],
                    server_proof: [
                        ...computeProof(
                            key,
                            SERVER_PROOF_DOMAIN,
                            Uint8Array.from(hello.client_nonce),
                            serverNonce,
                            daemonId,
                        ),
                    ],
                }),
            );
            const size = Buffer.alloc(4);
            size.writeUInt32LE(proof.length);
            socket.write(Buffer.concat([size, proof]));
            await auth();
            while (!socket.destroyed) {
                const header = decodeHeader(await bytes(HEADER_LEN));
                const body = JSON.parse((await bytes(header.len)).toString());
                const opening = body.op === "route.open";
                if (!opening) {
                    expect(body.method).toBe("resolve");
                    calls++;
                }
                socket.write(
                    encodeFrame(
                        buildFrame(
                            opening ? FrameType.Response : FrameType.Error,
                            buildFlags(false, Priority.Interactive, false),
                            header.channel,
                            header.epoch,
                            header.corr,
                            Buffer.from(
                                JSON.stringify(
                                    opening
                                        ? { route_channel: 7, route_epoch: 1 }
                                        : {
                                              code: "unknown_module",
                                              message: "Entorhinal is not loaded",
                                              detail: null,
                                          },
                                ),
                            ),
                        ),
                    ),
                );
            }
        })().catch(() => {});
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fake address");
    writeFileSync(
        connectionFile,
        JSON.stringify({
            schema: 1,
            endpoints: [{ host: "127.0.0.1", port: address.port }],
            key: [...key],
            daemon_id: [...daemonId],
            pid: process.pid,
            daemon_ver: "fake",
        }),
    );
    chmodSync(connectionFile, 0o600);
    return {
        calls: () => calls,
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}

interface Sample {
    scenario: string;
    phase: number;
    identity: string | null;
    prefix: string;
}
async function runHost(root: string, fixture: string, connection: string, mode: string) {
    const isolation = join(scratch, `${mode}-${root === repo ? "head" : "base"}`);
    mkdirSync(isolation, { recursive: true });
    const storage = join(isolation, "cortexkit", "magic-context");
    const env = {
        ...process.env,
        XDG_DATA_HOME: isolation,
        XDG_CONFIG_HOME: join(isolation, "config"),
        XDG_STATE_HOME: join(isolation, "state"),
        XDG_RUNTIME_DIR: join(isolation, "run"),
        OPENCODE_DB: join(isolation, "opencode.db"),
        MAGIC_CONTEXT_STORAGE_DIR: storage,
        MAGIC_CONTEXT_TEST_DATA_DIR: isolation,
    };
    const child = Bun.spawn([process.execPath, host, root, fixture, connection, mode, storage], {
        cwd: repo,
        windowsHide: true,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let output = "";
    try {
        while (!output.includes("READY ")) {
            const next = await reader.read();
            if (next.done) throw new Error(`host failed before isolation check: ${await stderr}`);
            output += new TextDecoder().decode(next.value);
        }
        const descriptors = execFileSync("lsof", ["-p", String(child.pid), "-Fn"], {
            encoding: "utf8",
            windowsHide: true,
        });
        const databases = descriptors
            .split("\n")
            .filter((line) => line.startsWith("n") && /\.db(?:-|$)/.test(line));
        expect(databases.length).toBeGreaterThan(0);
        for (const database of databases) expect(database.slice(1)).toStartWith(isolation);
        console.log(`lsof -p ${child.pid}: ${databases.map((line) => line.slice(1)).join(", ")}`);
        child.stdin.write("continue\n");
        child.stdin.end();
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            output += new TextDecoder().decode(next.value);
        }
        expect(await child.exited, await stderr).toBe(0);
        const result = output.split("\n").find((line) => line.startsWith("RESULT "));
        if (!result) throw new Error(`missing host transcript: ${output}`);
        return JSON.parse(result.slice(7)) as { transcript: Sample[]; failedProbes: number };
    } finally {
        child.kill();
        await child.exited;
    }
}

for (const mode of ["no-connection", "daemon-down", "module-absent"]) {
    // lsof observes the open host databases; Windows has no lsof file-descriptor interface.
    test.skipIf(process.platform === "win32")(
        `standalone differential against ${BASE.slice(0, 12)}: ${mode}`,
        async () => {
            const fixture = join(scratch, mode, "fixture");
            mkdirSync(join(scratch, mode), { recursive: true });
            const connection = join(scratch, mode, "connection.json");
            const fake = mode === "module-absent" ? await absentModule(connection) : undefined;
            if (mode === "daemon-down") {
                // A valid connection file whose listener has closed, rather than a malformed file.
                const stopped = await absentModule(connection);
                await stopped.close();
            }
            try {
                fixtures(fixture);
                const base = await runHost(baseline, fixture, connection, mode);
                fixtures(fixture);
                const head = await runHost(repo, fixture, connection, mode);
                expect(head.transcript).toEqual(base.transcript);
                expect(head.transcript).toHaveLength(8);
                expect(head.failedProbes).toBeGreaterThan(0);
                const unborn = head.transcript.filter((sample) => sample.scenario === "unborn");
                expect(unborn[0].identity).toStartWith("dir:");
                expect(unborn[1].identity).toStartWith("git:");
                const recovering = head.transcript.filter(
                    (sample) => sample.scenario === "recovering",
                );
                expect(recovering[0].prefix).not.toContain("standalone memory for");
                expect(recovering[1].identity).toStartWith("git:");
                // Recovery must not rewrite an already materialized m0 prefix.
                expect(recovering[1].prefix).toBe(recovering[0].prefix);
                for (const sample of head.transcript.filter(
                    (sample) => sample.scenario !== "recovering",
                )) {
                    expect(sample.prefix).toContain("standalone memory for");
                }
                if (fake) expect(fake.calls()).toBe(4);
            } finally {
                await fake?.close();
            }
        },
        60000,
    );
}
