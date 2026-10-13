import { expect, test } from "bun:test";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { getMemoryById, insertMemory } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { createCtxMemoryTools } from "../../tools/ctx-memory/tools";
import { createModuleToolBackends } from "./module-tool-backends";

const context = {
    sessionID: "review-child",
    agent: DREAMER_AGENT,
    directory: "/repo",
    worktree: "/repo",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
};

if (process.env.MC_NOPROP_REVIEW === "1") {
    test("noprop authority rejects module failure and mixed TS ownership without fallback", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        try {
            const a = insertMemory(db, {
                projectPath: "git:a",
                category: "ARCHITECTURE",
                content: "First source.",
            });
            const b = insertMemory(db, {
                projectPath: "git:b",
                category: "ARCHITECTURE",
                content: "Second source.",
            });
            db.prepare(
                "INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES(?,?,?)",
            ).run("git:b", "review", 1);
            const before = db.prepare("SELECT * FROM memories ORDER BY id").all();
            for (const mode of ["failed-module", "missing-module", "mixed-ts"] as const) {
                let calls = 0;
                const tools = createCtxMemoryTools({
                    db,
                    resolveProjectPath: () => "git:a",
                    memoryEnabled: true,
                    embeddingEnabled: false,
                    memoryAuthority: mode === "mixed-ts" ? "ts" : "module",
                    rustToolBackends:
                        mode === "failed-module"
                            ? {
                                  curateMemory: async () => {
                                      calls++;
                                      throw Error("review module refused");
                                  },
                              }
                            : undefined,
                });
                const result = await tools
                    .ctx_memory!.execute(
                        { action: "merge", ids: [a.id, b.id], content: "Merged source." },
                        context,
                    )
                    .then(
                        (text) => text,
                        (error: unknown) => String(error),
                    );
                expect(result).not.toStartWith("Merged memories");
                if (mode === "failed-module") expect(result).toContain("review module refused");
                expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
                expect(db.prepare("SELECT COUNT(*) AS n FROM memory_history").get()).toEqual({
                    n: 0,
                });
                expect(calls).toBe(mode === "failed-module" ? 1 : 0);
            }
            expect(getMemoryById(db, b.id)!.status).toBe("active");
        } finally {
            db.close();
        }
    });

    test("noprop response parser refuses unflagged success-shaped text without a typed receipt", async () => {
        const db = new Database(":memory:");
        try {
            const request = {
                key: "review",
                projectRoot: "/repo",
                projectPath: "git:repo",
                sourceSessionId: "child",
                operation: "archive" as const,
                targets: [{ id: 7, revision: 1 }],
            };
            const response = (isError: boolean) =>
                createModuleToolBackends({
                    db,
                    directory: "/repo",
                    memorySyncRequestedSessions: new Set(),
                    moduleClient: {
                        call: async () => ({
                            result: {
                                isError,
                                content: [
                                    { text: "Archived memory IDs []: refusal (stale_revision)." },
                                ],
                            },
                        }),
                    },
                })!.backends.curateMemory!(request);
            await expect(response(true)).rejects.toThrow("Invalid module curate response");
            await expect(response(false)).rejects.toThrow("Invalid module curate response");
        } finally {
            db.close();
        }
    });
}
