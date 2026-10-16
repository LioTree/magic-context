import { expect, test } from "bun:test";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { applyDashboardMemoryEdit, applyMemoryRestore, memoryHistoryJson } from "./history-applier";
import type { MemoryEditRequest, MemoryRestoreRequest } from "./history-contract";
import { applyCurateMemoryMutation } from "./lifecycle-applier";
import { insertMemory } from "./storage-memory";

const binary = process.env.MC_MEMORY_HISTORY_PARITY_BIN;
const parityTest = binary ? test : test.skip;
const tables = [
    ["rows", "memories", "id"],
    ["history", "memory_history", "id"],
    ["journal", "memory_journal", "id"],
    ["receipts", "memory_decision_receipts", "decision_key"],
    ["links", "memory_successor_links", "source_id,successor_id"],
    ["epochs", "project_state", "project_path"],
] as const;
function setup(directory: string) {
    const path = join(directory, "ts.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode=DELETE");
    const projectPath = "git:parity";
    const first = insertMemory(db, {
        projectPath,
        category: "CONFIG_VALUES",
        content: "config.ts sets cache_ttl=5m.",
    });
    const second = insertMemory(db, {
        projectPath,
        category: "CONFIG_VALUES",
        content: "config.ts sets timeout=5s.",
    });
    return { db, path, projectPath, first, second };
}
function dump(db: Database, receipt: unknown) {
    const result: Record<string, unknown> = { receipt };
    for (const [key, table, order] of tables)
        result[key] = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    return memoryHistoryJson(result);
}
parityTest(
    "memory history TS/Rust canonical parity for restore and every dashboard edit kind",
    () => {
        for (const kind of [
            "pin",
            "unpin",
            "category",
            "content",
            "archive",
            "bulk-status",
            "bulk-delete",
            "restore",
        ]) {
            const { dir: directory, cleanup } = createTestTempDir("memory-history-parity-");
            const f = setup(directory);
            try {
                if (kind === "unpin")
                    f.db
                        .prepare("UPDATE memories SET status='permanent' WHERE id=?")
                        .run(f.first.id);
                let request: MemoryEditRequest | MemoryRestoreRequest = {
                    projectPath: f.projectPath,
                    operationId: kind,
                    expectedRevisions: [{ memoryId: f.first.id, revision: 1 }],
                    changes: [
                        {
                            memoryId: f.first.id,
                            ...(kind === "category"
                                ? { category: "CONSTRAINTS" }
                                : kind === "content"
                                  ? { content: "config.ts sets CACHE_TTL = 10m." }
                                  : {
                                        status:
                                            kind === "pin" || kind === "bulk-status"
                                                ? ("permanent" as const)
                                                : kind === "unpin"
                                                  ? ("active" as const)
                                                  : ("archived" as const),
                                    }),
                        },
                    ],
                };
                if (kind.startsWith("bulk")) {
                    request.expectedRevisions.push({ memoryId: f.second.id, revision: 1 });
                    request.changes.push({ ...request.changes[0]!, memoryId: f.second.id });
                }
                if (kind === "restore") {
                    const edit = applyDashboardMemoryEdit(
                        f.db,
                        {
                            projectPath: f.projectPath,
                            operationId: "before-restore",
                            expectedRevisions: [{ memoryId: f.first.id, revision: 1 }],
                            changes: [
                                { memoryId: f.first.id, content: "config.ts sets cache_ttl=10m." },
                            ],
                        },
                        1000,
                    );
                    request = {
                        projectPath: f.projectPath,
                        operationId: "restore",
                        decisionKey: edit.decisionKey!,
                        expectedRevisions: [{ memoryId: f.first.id, revision: 2 }],
                    };
                }
                const rustPath = join(directory, "rust.db");
                copyFileSync(f.path, rustPath);
                const tsReceipt =
                    "decisionKey" in request
                        ? applyMemoryRestore(f.db, request, 2000)
                        : applyDashboardMemoryEdit(f.db, request, 2000);
                expect(tsReceipt.state).toBe("applied");
                const run = Bun.spawnSync([binary!], {
                    windowsHide: true,
                    stdin: Buffer.from(JSON.stringify({ database: rustPath, request, now: 2000 })),
                });
                expect(run.exitCode, run.stderr.toString()).toBe(0);
                // Compare actual storage bytes, including embedded JSON strings, not two recomputed expectations.
                expect(run.stdout.toString().trim()).toBe(dump(f.db, tsReceipt));
            } finally {
                f.db.close();
                cleanup();
            }
        }
    },
);
parityTest(
    "memory history two real connections race through CAS without a lost plugin update",
    async () => {
        const { dir: directory, cleanup } = createTestTempDir("memory-history-race-");
        const f = setup(directory);
        try {
            const barrier = join(directory, "release");
            const request: MemoryEditRequest = {
                projectPath: f.projectPath,
                operationId: "dashboard",
                expectedRevisions: [{ memoryId: f.first.id, revision: 1 }],
                changes: [{ memoryId: f.first.id, content: "dashboard later content" }],
            };
            f.db.exec("BEGIN IMMEDIATE");
            const child = Bun.spawn([binary!], {
                windowsHide: true,
                stdin: new Blob([
                    JSON.stringify({ database: f.path, request, now: 2000, barrier }),
                ]),
                stdout: "pipe",
                stderr: "pipe",
            });
            const started = Date.now();
            while (!existsSync(`${barrier}.ready`)) {
                if (Date.now() - started > 10_000)
                    throw new Error("Rust writer did not reach its barrier");
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            writeFileSync(barrier, "release");
            const plugin = applyCurateMemoryMutation(f.db, {
                key: "plugin",
                projectPath: f.projectPath,
                sourceSessionId: "",
                operation: "update",
                targets: [{ id: f.first.id, revision: 1 }],
                content: "plugin winning content",
            });
            f.db.exec("COMMIT");
            const output = await new Response(child.stdout).text();
            const stderr = await new Response(child.stderr).text();
            expect(await child.exited, stderr).toBe(0);
            const helper = JSON.parse(output) as { receipt: { state: string; reason: string } };
            expect(plugin.state).toBe("applied");
            expect(helper.receipt.state).toBe("conflict");
            expect(helper.receipt.reason).toBe("stale_revision");
            expect(
                f.db.prepare("SELECT content,revision FROM memories WHERE id=?").get(f.first.id),
            ).toEqual({ content: "plugin winning content", revision: 2 });
            expect(f.db.prepare("SELECT COUNT(*) n FROM memory_history").get()).toEqual({ n: 1 });
        } finally {
            if (f.db.inTransaction) f.db.exec("ROLLBACK");
            f.db.close();
            cleanup();
        }
    },
);
test("memory history canonical serialization recursively sorts keys", () => {
    expect(memoryHistoryJson({ z: [{ z: 2, a: 1 }], a: null })).toBe(
        '{"a":null,"z":[{"a":1,"z":2}]}',
    );
});
