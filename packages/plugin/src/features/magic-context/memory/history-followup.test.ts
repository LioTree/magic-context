import { expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getProjectEmbeddings, resetEmbeddingCacheForTests } from "./embedding-cache";
import { applyDashboardMemoryEdit, previewMemoryRestore } from "./history-applier";
import { insertMemory } from "./storage-memory";
import { saveEmbedding } from "./storage-memory-embeddings";

const binary = process.env.MC_MEMORY_HISTORY_PARITY_BIN;
const rustTest = binary ? test : test.skip;
function fixture() {
    const { dir, cleanup } = createTestTempDir("history-followup-");
    const path = join(dir, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const projectPath = "git:history-followup";
    const row = insertMemory(db, {
        projectPath,
        category: "CONFIG_VALUES",
        content: "Initial rule.",
    });
    return {
        db,
        path,
        projectPath,
        row,
        close() {
            resetEmbeddingCacheForTests();
            db.close();
            cleanup();
        },
    };
}
for (const method of ["memory.edit", "memory.restore"] as const)
    rustTest(
        `cross-process Rust ${method} invalidates search embeddings without a serving read`,
        () => {
            const f = fixture();
            try {
                const edited =
                    method === "memory.restore"
                        ? applyDashboardMemoryEdit(
                              f.db,
                              {
                                  projectPath: f.projectPath,
                                  operationId: "first",
                                  expectedRevisions: [{ memoryId: f.row.id, revision: 1 }],
                                  changes: [{ memoryId: f.row.id, content: "Edited rule." }],
                              },
                              1000,
                          )
                        : null;
                saveEmbedding(f.db, f.row.id, new Float32Array([1, 0]), "followup:model");
                const warm = getProjectEmbeddings(f.db, f.projectPath, "followup:model");
                expect(warm.has(f.row.id)).toBe(true);
                const request = edited
                    ? {
                          projectPath: f.projectPath,
                          operationId: "undo",
                          decisionKey: edited.decisionKey,
                          expectedRevisions: previewMemoryRestore(f.db, {
                              projectPath: f.projectPath,
                              decisionKey: edited.decisionKey!,
                          }).expectedRevisions,
                      }
                    : {
                          projectPath: f.projectPath,
                          operationId: "external",
                          expectedRevisions: [{ memoryId: f.row.id, revision: 1 }],
                          changes: [{ memoryId: f.row.id, content: "External rule." }],
                      };
                const run = Bun.spawnSync([binary!], {
                    windowsHide: true,
                    stdin: Buffer.from(JSON.stringify({ database: f.path, request, now: 2000 })),
                });
                expect(run.exitCode, run.stderr.toString()).toBe(0);
                expect(JSON.parse(run.stdout.toString()).receipt.state).toBe("applied");
                expect(
                    getProjectEmbeddings(f.db, f.projectPath, "followup:model").has(f.row.id),
                ).toBe(false);
                expect(warm.has(f.row.id)).toBe(false);
            } finally {
                f.close();
            }
        },
    );

rustTest(
    "Rust edit trimming agrees with every JavaScript whitespace code point and excludes NEL",
    () => {
        const whitespace = [
            0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
            0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
            0x205f, 0x3000, 0xfeff,
        ];
        const f = fixture();
        try {
            let revision = 1;
            for (const codePoint of [...whitespace, 0x0085, 0x180e]) {
                const edge = String.fromCodePoint(codePoint);
                const content = `${edge}Rule ${codePoint}.${edge}`;
                const expected = whitespace.includes(codePoint) ? `Rule ${codePoint}.` : content;
                expect(content.trim()).toBe(expected);
                const request = {
                    projectPath: f.projectPath,
                    operationId: `trim-${codePoint}`,
                    expectedRevisions: [{ memoryId: f.row.id, revision }],
                    changes: [{ memoryId: f.row.id, content }],
                };
                const run = Bun.spawnSync([binary!], {
                    windowsHide: true,
                    stdin: Buffer.from(JSON.stringify({ database: f.path, request, now: 2000 })),
                });
                expect(run.exitCode, run.stderr.toString()).toBe(0);
                expect(JSON.parse(run.stdout.toString()).receipt.state).toBe("applied");
                const row = f.db
                    .prepare("SELECT content,revision FROM memories WHERE id=?")
                    .get(f.row.id) as { content: string; revision: number };
                expect(row.content).toBe(expected);
                expect(row.revision).toBe(++revision);
            }
        } finally {
            f.close();
        }
    },
);
