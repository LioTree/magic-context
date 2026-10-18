import { expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    getProjectEmbeddings,
    PROJECT_EMBEDDING_CACHE_EPOCH_SQL,
    resetEmbeddingCacheForTests,
} from "./embedding-cache";
import {
    applyDashboardMemoryEdit,
    applyMemoryRestore,
    previewMemoryRestore,
} from "./history-applier";
import { insertMemory } from "./storage-memory";
import { saveEmbedding } from "./storage-memory-embeddings";

function fixture(projectPath = "git:stamp-project") {
    const { dir, cleanup } = createTestTempDir("embedding-project-stamp-");
    const path = join(dir, "context.db");
    const reader = new Database(path);
    initializeDatabase(reader);
    runMigrations(reader);
    reader.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const first = insertMemory(reader, {
        projectPath,
        category: "CONFIG_VALUES",
        content: "Initial rule.",
    });
    const second = insertMemory(reader, {
        projectPath,
        category: "CONFIG_VALUES",
        content: "Other rule.",
    });
    const foreign = insertMemory(reader, {
        projectPath: "git:foreign-project",
        category: "CONFIG_VALUES",
        content: "Foreign rule.",
    });
    saveEmbedding(reader, first.id, new Float32Array([1, 0]), "stamp:model");
    saveEmbedding(reader, second.id, new Float32Array([0, 1]), "stamp:model");
    const writer = new Database(path);
    return {
        path,
        reader,
        writer,
        projectPath,
        first,
        second,
        foreign,
        close() {
            writer.close();
            reader.close();
            resetEmbeddingCacheForTests();
            cleanup();
        },
    };
}

test("embedding project stamp ignores foreign commits to unrelated tables and projects", () => {
    const f = fixture();
    try {
        const warm = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
        f.writer.exec(
            "CREATE TABLE unrelated_search_stamp_test(value INTEGER); INSERT INTO unrelated_search_stamp_test VALUES(1)",
        );
        expect(getProjectEmbeddings(f.reader, f.projectPath, "stamp:model")).toBe(warm);
        const receipt = applyDashboardMemoryEdit(
            f.writer,
            {
                projectPath: "git:foreign-project",
                operationId: "foreign",
                expectedRevisions: [{ memoryId: f.foreign.id, revision: 1 }],
                changes: [{ memoryId: f.foreign.id, content: "Changed foreign rule." }],
            },
            1000,
        );
        expect(receipt.state).toBe("applied");
        expect(getProjectEmbeddings(f.reader, f.projectPath, "stamp:model")).toBe(warm);
        expect(warm.has(f.first.id)).toBe(true);
        expect(warm.has(f.second.id)).toBe(true);
    } finally {
        f.close();
    }
});

for (const kind of ["edit", "archive", "restore"] as const)
    test(`embedding project stamp reloads exactly once after a cross-connection ${kind}`, () => {
        const f = fixture();
        try {
            let revision = 1;
            let decisionKey: string | null = null;
            if (kind === "restore") {
                const edited = applyDashboardMemoryEdit(
                    f.writer,
                    {
                        projectPath: f.projectPath,
                        operationId: "before-restore",
                        expectedRevisions: [{ memoryId: f.first.id, revision: 1 }],
                        changes: [{ memoryId: f.first.id, content: "Edited rule." }],
                    },
                    1000,
                );
                expect(edited.state).toBe("applied");
                revision = 2;
                decisionKey = edited.decisionKey;
                saveEmbedding(f.writer, f.first.id, new Float32Array([1, 1]), "stamp:model");
            }
            const warm = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
            expect(warm.has(f.first.id)).toBe(true);
            const receipt =
                kind === "restore"
                    ? applyMemoryRestore(
                          f.writer,
                          {
                              projectPath: f.projectPath,
                              decisionKey: decisionKey!,
                              operationId: "restore",
                              expectedRevisions: previewMemoryRestore(f.writer, {
                                  projectPath: f.projectPath,
                                  decisionKey: decisionKey!,
                              }).expectedRevisions,
                          },
                          2000,
                      )
                    : applyDashboardMemoryEdit(
                          f.writer,
                          {
                              projectPath: f.projectPath,
                              operationId: kind,
                              expectedRevisions: [{ memoryId: f.first.id, revision }],
                              changes: [
                                  {
                                      memoryId: f.first.id,
                                      ...(kind === "edit"
                                          ? { content: "Foreign connection edit." }
                                          : { status: "archived" as const }),
                                  },
                              ],
                          },
                          2000,
                      );
            expect(receipt.state).toBe("applied");
            const refreshed = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
            expect(refreshed).not.toBe(warm);
            expect(refreshed.has(f.first.id)).toBe(false);
            expect(refreshed.has(f.second.id)).toBe(true);
            expect(getProjectEmbeddings(f.reader, f.projectPath, "stamp:model")).toBe(refreshed);
            expect(getProjectEmbeddings(f.reader, f.projectPath, "stamp:model")).toBe(refreshed);
        } finally {
            f.close();
        }
    });

test("embedding project stamp detects a dashboard edit to a lower-revision memory", () => {
    const f = fixture();
    try {
        for (let revision = 1; revision < 5; revision++)
            expect(
                applyDashboardMemoryEdit(
                    f.writer,
                    {
                        projectPath: f.projectPath,
                        operationId: `high-${revision}`,
                        expectedRevisions: [{ memoryId: f.second.id, revision }],
                        changes: [
                            { memoryId: f.second.id, content: `Higher revision ${revision}.` },
                        ],
                    },
                    1000,
                ).state,
            ).toBe("applied");
        saveEmbedding(f.writer, f.second.id, new Float32Array([0, 1]), "stamp:model");
        const warm = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
        expect(
            applyDashboardMemoryEdit(
                f.writer,
                {
                    projectPath: f.projectPath,
                    operationId: "lower",
                    expectedRevisions: [{ memoryId: f.first.id, revision: 1 }],
                    changes: [{ memoryId: f.first.id, content: "Lower revision changed." }],
                },
                1000,
            ).state,
        ).toBe("applied");
        const changed = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
        expect(changed).not.toBe(warm);
        expect(changed.has(f.first.id)).toBe(false);
    } finally {
        f.close();
    }
});

for (const change of ["automation", "re-embedding"] as const)
    test(`embedding project stamp keeps foreign ${change} bounded by the 60-second TTL`, () => {
        const f = fixture();
        const originalNow = Date.now;
        let now = originalNow();
        Date.now = () => now;
        try {
            const warm = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
            if (change === "automation") {
                const run = Bun.spawnSync(
                    [
                        "bun",
                        "-e",
                        `
                const { Database } = await import('./packages/plugin/src/shared/sqlite.ts');
                const { applyCurateMemoryMutation } = await import('./packages/plugin/src/features/magic-context/memory/lifecycle-applier.ts');
                const db = new Database(process.env.STAMP_AUTOMATION_DB);
                const result = applyCurateMemoryMutation(db, JSON.parse(process.env.STAMP_AUTOMATION_REQUEST));
                if (result.state !== 'applied') throw new Error(JSON.stringify(result));
                db.close();
            `,
                    ],
                    {
                        windowsHide: true,
                        cwd: new URL("../../../../../../", import.meta.url).pathname,
                        env: {
                            ...process.env,
                            STAMP_AUTOMATION_DB: f.path,
                            STAMP_AUTOMATION_REQUEST: JSON.stringify({
                                key: "foreign-automation",
                                projectPath: f.projectPath,
                                operation: "update",
                                targets: [{ id: f.first.id, revision: 1 }],
                                sourceSessionId: "",
                                content: "Automated correction.",
                            }),
                        },
                    },
                );
                expect(run.exitCode, run.stderr.toString()).toBe(0);
            } else saveEmbedding(f.writer, f.first.id, new Float32Array([1, 1]), "stamp:model");
            now += 59_999;
            expect(getProjectEmbeddings(f.reader, f.projectPath, "stamp:model")).toBe(warm);
            expect(Array.from(warm.get(f.first.id)!.embedding)).toEqual([1, 0]);
            now += 2;
            const refreshed = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
            expect(refreshed).not.toBe(warm);
            if (change === "automation") expect(refreshed.has(f.first.id)).toBe(false);
            else expect(Array.from(refreshed.get(f.first.id)!.embedding)).toEqual([1, 1]);
            expect(getProjectEmbeddings(f.reader, f.projectPath, "stamp:model")).toBe(refreshed);
        } finally {
            Date.now = originalNow;
            f.close();
        }
    });

for (const projectPath of ["dir:stamp-project", "/fixture/stamp-project", "fixtures/stamp-project"])
    test(`embedding project stamp detects cross-connection edits for ${projectPath}`, () => {
        const f = fixture(projectPath);
        try {
            const warm = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
            expect(
                applyDashboardMemoryEdit(
                    f.writer,
                    {
                        projectPath: f.projectPath,
                        operationId: "path-edit",
                        expectedRevisions: [{ memoryId: f.first.id, revision: 1 }],
                        changes: [{ memoryId: f.first.id, content: "Changed directory rule." }],
                    },
                    1000,
                ).state,
            ).toBe("applied");
            const refreshed = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
            expect(refreshed).not.toBe(warm);
            expect(refreshed.has(f.first.id)).toBe(false);
            expect(refreshed.has(f.second.id)).toBe(true);
            expect(getProjectEmbeddings(f.reader, f.projectPath, "stamp:model")).toBe(refreshed);
        } finally {
            f.close();
        }
    });

test("embedding project epoch lookup uses the project primary-key index and reports latency", () => {
    const f = fixture();
    try {
        f.writer.exec(
            "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<10000) INSERT INTO project_state(project_path,project_memory_epoch,project_user_profile_version,updated_at) SELECT 'git:benchmark-'||value,1,0,1 FROM n",
        );
        const plan = f.reader
            .prepare(`EXPLAIN QUERY PLAN ${PROJECT_EMBEDDING_CACHE_EPOCH_SQL}`)
            .all(f.projectPath) as { detail: string }[];
        expect(
            plan.some((row) =>
                /SEARCH project_state USING INDEX .*\(project_path=\?\)/.test(row.detail),
            ),
        ).toBe(true);
        expect(plan.some((row) => /SCAN project_state/.test(row.detail))).toBe(false);
        const query = f.reader.prepare(PROJECT_EMBEDDING_CACHE_EPOCH_SQL);
        const samples: number[] = [];
        for (let index = 0; index < 1000; index++) query.get(f.projectPath);
        for (let index = 0; index < 10000; index++) {
            const start = performance.now();
            query.get(f.projectPath);
            samples.push(performance.now() - start);
        }
        samples.sort((left, right) => left - right);
        const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
        console.log(
            `project epoch lookup: projects=10000 checks=${samples.length} mean_us=${(mean * 1000).toFixed(2)} p50_us=${(samples[5000]! * 1000).toFixed(2)} p95_us=${(samples[9500]! * 1000).toFixed(2)} plan=${plan.map((row) => row.detail).join("; ")}`,
        );
        expect(samples).toHaveLength(10000);
    } finally {
        f.close();
    }
});

test("embedding epoch invalidates after dashboard delta admission without clearing served prefix bytes", () => {
    const f = fixture();
    try {
        f.reader
            .prepare(
                "INSERT INTO session_meta(session_id,cached_m0_bytes,cached_m1_bytes) VALUES ('held-dashboard',?,?)",
            )
            .run(Buffer.from("frozen m0"), Buffer.from("frozen m1"));
        const warm = getProjectEmbeddings(f.reader, f.projectPath, "stamp:model");
        const receipt = applyDashboardMemoryEdit(f.writer, {
            projectPath: f.projectPath,
            operationId: "delta-and-search",
            expectedRevisions: [{ memoryId: f.first.id, revision: 1 }],
            changes: [{ memoryId: f.first.id, content: "Dashboard correction." }],
        });
        expect(receipt.state).toBe("applied");
        expect(
            f.reader
                .prepare(
                    "SELECT new_content FROM memory_mutation_log WHERE operation_id LIKE 'dashboard:%'",
                )
                .all(),
        ).toEqual([{ new_content: "Dashboard correction." }]);
        expect(getProjectEmbeddings(f.reader, f.projectPath, "stamp:model")).not.toBe(warm);
        const cache = f.reader
            .prepare(
                "SELECT cached_m0_bytes,cached_m1_bytes FROM session_meta WHERE session_id='held-dashboard'",
            )
            .get() as { cached_m0_bytes: Uint8Array; cached_m1_bytes: Uint8Array };
        expect(Buffer.from(cache.cached_m0_bytes).toString()).toBe("frozen m0");
        expect(Buffer.from(cache.cached_m1_bytes).toString()).toBe("frozen m1");
    } finally {
        f.close();
    }
});
