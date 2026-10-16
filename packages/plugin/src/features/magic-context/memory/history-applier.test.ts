import { expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    applyDashboardMemoryEdit,
    applyMemoryRestore,
    listMemoryHistory,
    memoryHistorySnapshot,
    normalizeMemoryHistorySnapshot,
    previewMemoryRestore,
} from "./history-applier";
import { memoryHistoryRpc } from "./history-rpc";
import { applyCurateMemoryMutation } from "./lifecycle-applier";
import { getMemoryById, insertMemory } from "./storage-memory";

function fixture() {
    const { dir: directory, cleanup } = createTestTempDir("memory-history-undo-");
    const path = join(directory, "context.db");
    let db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    const projectPath = "git:history";
    const add = (content = "config.ts uses cache_ttl=5m.") =>
        insertMemory(db, { projectPath, category: "CONFIG_VALUES", content });
    return {
        get db() {
            return db;
        },
        projectPath,
        add,
        reopen() {
            db.close();
            db = new Database(path);
        },
        close() {
            db.close();
            cleanup();
        },
    };
}
function edit(
    f: ReturnType<typeof fixture>,
    id: number,
    operationId: string,
    content: string,
    revision = memoryHistorySnapshot(f.db, id)!.revision,
) {
    return applyDashboardMemoryEdit(
        f.db,
        {
            projectPath: f.projectPath,
            operationId,
            expectedRevisions: [{ memoryId: id, revision }],
            changes: [{ memoryId: id, content }],
        },
        1000,
    );
}

test("history restore records a new revision and replays the durable receipt after reopen", () => {
    const f = fixture();
    try {
        const row = f.add();
        const changed = edit(f, row.id, "edit", "config.ts uses cache_ttl=10m.");
        expect(changed.state).toBe("applied");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: changed.decisionKey!,
        });
        expect(preview.state).toBe("ready");
        const request = {
            projectPath: f.projectPath,
            decisionKey: changed.decisionKey!,
            operationId: "undo",
            expectedRevisions: preview.expectedRevisions,
        };
        const receipt = applyMemoryRestore(f.db, request, 2000);
        expect(receipt.state).toBe("applied");
        expect(memoryHistorySnapshot(f.db, row.id)?.revision).toBe(3);
        expect(memoryHistorySnapshot(f.db, row.id)?.content).toBe(row.content);
        f.reopen();
        expect(applyMemoryRestore(f.db, request, 3000)).toEqual(receipt);
        expect(listMemoryHistory(f.db, { projectPath: f.projectPath }).decisions).toHaveLength(2);
        expect(
            f.db
                .prepare("SELECT project_memory_epoch n FROM project_state WHERE project_path=?")
                .get(f.projectPath),
        ).toEqual({ n: 2 });
        expect(
            applyMemoryRestore(f.db, {
                ...request,
                expectedRevisions: [{ memoryId: row.id, revision: 3 }],
            }).reason,
        ).toBe("operation_id_reused");
    } finally {
        f.close();
    }
});

test("history restore CAS refuses a stale participant without changing canonical rows", () => {
    const f = fixture();
    try {
        const row = f.add();
        const change = edit(f, row.id, "change", "config.ts uses cache_ttl=10m.");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
        });
        edit(f, row.id, "later", "config.ts uses cache_ttl=20m.");
        const before = memoryHistorySnapshot(f.db, row.id);
        const receipt = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
            operationId: "stale",
            expectedRevisions: preview.expectedRevisions,
        });
        expect(receipt.state).toBe("conflict");
        expect(receipt.reason).toBe("stale_revision");
        expect(memoryHistorySnapshot(f.db, row.id)).toEqual(before);
    } finally {
        f.close();
    }
});

test("history restore detects duplicate hashes including archived nonparticipants", () => {
    const f = fixture();
    try {
        const row = f.add();
        const change = edit(f, row.id, "change", "config.ts uses cache_ttl=10m.");
        const duplicate = f.add(row.content);
        f.db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(duplicate.id);
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
        });
        expect(preview.state).toBe("conflict");
        expect(preview.reason).toBe("duplicate_content");
        const receipt = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
            operationId: "duplicate",
            expectedRevisions: [{ memoryId: row.id, revision: 2 }],
        });
        expect(receipt.state).toBe("conflict");
        expect(receipt.conflicts[0]?.duplicateId).toBe(duplicate.id);
    } finally {
        f.close();
    }
});

test("history merge restore refuses a later survivor edit and reconciles a complete unchanged merge", () => {
    const f = fixture();
    try {
        const first = f.add();
        const second = f.add("config.ts sets connect_timeout=5s.");
        const receipt = applyCurateMemoryMutation(f.db, {
            key: "merge",
            projectPath: f.projectPath,
            sourceSessionId: "",
            operation: "merge",
            targets: [
                { id: first.id, revision: 1 },
                { id: second.id, revision: 1 },
            ],
            content: "config.ts sets cache_ttl=5m and connect_timeout=5s.",
        });
        const decision = listMemoryHistory(f.db, {
            projectPath: f.projectPath,
            memoryId: second.id,
        }).decisions[0]!;
        expect(decision.rows).toHaveLength(3);
        const later = edit(
            f,
            receipt.memoryId!,
            "later",
            "config.ts sets cache_ttl=20m and connect_timeout=5s.",
        );
        expect(
            previewMemoryRestore(f.db, { projectPath: f.projectPath, decisionKey: "merge" }).reason,
        ).toBe("successor_changed");
        const laterPreview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: later.decisionKey!,
        });
        expect(
            applyMemoryRestore(f.db, {
                projectPath: f.projectPath,
                decisionKey: later.decisionKey!,
                operationId: "undo-later",
                expectedRevisions: laterPreview.expectedRevisions,
            }).state,
        ).toBe("applied");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: "merge",
        });
        expect(
            applyMemoryRestore(f.db, {
                projectPath: f.projectPath,
                decisionKey: "merge",
                operationId: "undo-merge",
                expectedRevisions: preview.expectedRevisions,
            }).state,
        ).toBe("applied");
        expect(memoryHistorySnapshot(f.db, first.id)?.supersededByMemoryId).toBeNull();
        expect(memoryHistorySnapshot(f.db, second.id)?.status).toBe("active");
        expect(memoryHistorySnapshot(f.db, receipt.memoryId!)?.status).toBe("archived");
        expect(
            f.db
                .prepare("SELECT COUNT(*) n FROM memory_successor_links WHERE decision_key='merge'")
                .get(),
        ).toEqual({ n: 0 });
    } finally {
        f.close();
    }
});

for (const format of ["sql", "memory"] as const)
    test(`history normalizes complete legacy ${format} snapshot pairs`, () => {
        const f = fixture();
        try {
            const row = f.add();
            const before =
                format === "sql"
                    ? f.db.prepare("SELECT * FROM memories WHERE id=?").get(row.id)
                    : getMemoryById(f.db, row.id);
            const receipt = edit(f, row.id, "legacy", "config.ts uses cache_ttl=10m.");
            const after =
                format === "sql"
                    ? f.db.prepare("SELECT * FROM memories WHERE id=?").get(row.id)
                    : getMemoryById(f.db, row.id);
            f.db
                .prepare(
                    "UPDATE memory_history SET before_json=?,after_json=? WHERE decision_key=?",
                )
                .run(JSON.stringify(before), JSON.stringify(after), receipt.decisionKey!);
            f.db
                .prepare(
                    "UPDATE memory_journal SET before_json=NULL,after_json=NULL WHERE decision_key=?",
                )
                .run(receipt.decisionKey!);
            const decision = listMemoryHistory(f.db, { projectPath: f.projectPath }).decisions[0]!;
            expect(decision.restorable).toBe(true);
            expect(decision.rows[0]?.before?.content).toBe(row.content);
            const preview = previewMemoryRestore(f.db, {
                projectPath: f.projectPath,
                decisionKey: receipt.decisionKey!,
            });
            expect(
                applyMemoryRestore(f.db, {
                    projectPath: f.projectPath,
                    decisionKey: receipt.decisionKey!,
                    operationId: "undo",
                    expectedRevisions: preview.expectedRevisions,
                }).state,
            ).toBe("applied");
        } finally {
            f.close();
        }
    });

test("history restore clears derived data and never resurrects historical sharing grants", () => {
    const f = fixture();
    try {
        const row = f.add();
        f.db.prepare("UPDATE memories SET shareable=1,classified_at=42 WHERE id=?").run(row.id);
        const change = edit(f, row.id, "edit", "config.ts uses cache_ttl=10m.");
        // A later classifier may grant sharing for the corrected text, not the text being restored.
        f.db.prepare("UPDATE memories SET shareable=1,classified_at=77 WHERE id=?").run(row.id);
        f.db
            .prepare(
                "INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES(?,X'010203','test')",
            )
            .run(row.id);
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
        });
        const restored = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
            operationId: "restore",
            expectedRevisions: preview.expectedRevisions,
        });
        expect(restored.state).toBe("applied");
        expect(memoryHistorySnapshot(f.db, row.id)?.shareable).toBe(0);
        expect(f.db.prepare("SELECT classified_at FROM memories WHERE id=?").get(row.id)).toEqual({
            classified_at: null,
        });
        expect(
            f.db.prepare("SELECT COUNT(*) n FROM memory_embeddings WHERE memory_id=?").get(row.id),
        ).toEqual({ n: 0 });
    } finally {
        f.close();
    }
});

test("history authority refusal does not become a local SQL fallback after module failure", async () => {
    const f = fixture();
    try {
        const row = f.add();
        const change = edit(f, row.id, "edit", "config.ts uses cache_ttl=10m.");
        f.db
            .prepare(
                "INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES(?,'history-test',0)",
            )
            .run(f.projectPath);
        const before = memoryHistorySnapshot(f.db, row.id);
        expect(
            applyMemoryRestore(f.db, {
                projectPath: f.projectPath,
                decisionKey: change.decisionKey!,
                operationId: "restore",
                expectedRevisions: [{ memoryId: row.id, revision: 2 }],
            }).reason,
        ).toBe("authority_unavailable");
        await expect(
            memoryHistoryRpc(
                {
                    db: f.db,
                    directory: f.projectPath,
                    moduleClient: {
                        call: async () => {
                            throw new Error("module unavailable");
                        },
                    },
                },
                "memory.restore",
                {
                    projectPath: f.projectPath,
                    decisionKey: change.decisionKey!,
                    operationId: "module",
                    expectedRevisions: [{ memoryId: row.id, revision: 2 }],
                },
            ),
        ).rejects.toThrow("module unavailable");
        expect(memoryHistorySnapshot(f.db, row.id)).toEqual(before);
    } finally {
        f.close();
    }
});

test("history cursor binds its filter and never splits a multi-row decision", () => {
    const f = fixture();
    try {
        const row = f.add();
        for (let index = 0; index < 3; index++)
            edit(f, row.id, `edit-${index}`, `config.ts uses cache_ttl=${index + 10}m.`);
        const first = listMemoryHistory(f.db, { projectPath: f.projectPath, limit: 1 });
        expect(first.decisions).toHaveLength(1);
        expect(first.nextCursor).not.toBeNull();
        expect(
            listMemoryHistory(f.db, {
                projectPath: f.projectPath,
                limit: 1,
                cursor: first.nextCursor!,
            }).decisions[0]?.decisionKey,
        ).not.toBe(first.decisions[0]?.decisionKey);
        expect(() =>
            listMemoryHistory(f.db, { projectPath: "git:other", cursor: first.nextCursor! }),
        ).toThrow("invalid_request");
        expect(
            normalizeMemoryHistorySnapshot({
                version: 99,
                snapshot: memoryHistorySnapshot(f.db, row.id),
            }),
        ).toBeNull();
    } finally {
        f.close();
    }
});

test("history incomplete decisions remain readable but cannot authorize restoration", () => {
    const f = fixture();
    try {
        const row = f.add();
        const editReceipt = edit(f, row.id, "partial", "config.ts uses cache_ttl=10m.");
        f.db
            .prepare(
                "UPDATE memory_journal SET before_json=NULL,after_json=NULL WHERE decision_key=?",
            )
            .run(editReceipt.decisionKey!);
        f.db
            .prepare("UPDATE memory_history SET after_json=NULL WHERE decision_key=?")
            .run(editReceipt.decisionKey!);
        const page = listMemoryHistory(f.db, { projectPath: f.projectPath });
        expect(page.decisions).toHaveLength(1);
        expect(page.decisions[0]?.restorable).toBe(false);
        const before = memoryHistorySnapshot(f.db, row.id);
        const receipt = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: editReceipt.decisionKey!,
            operationId: "partial-undo",
            expectedRevisions: [{ memoryId: row.id, revision: 2 }],
        });
        expect(receipt.state).toBe("refused");
        expect(receipt.reason).toBe("incomplete_decision");
        expect(memoryHistorySnapshot(f.db, row.id)).toEqual(before);
    } finally {
        f.close();
    }
});

test("history project ownership is checked transactionally for every bulk participant", () => {
    const f = fixture();
    try {
        const first = f.add();
        const foreign = insertMemory(f.db, {
            projectPath: "git:foreign",
            category: "CONFIG_VALUES",
            content: "foreign project value",
        });
        const before = memoryHistorySnapshot(f.db, first.id);
        const receipt = applyDashboardMemoryEdit(f.db, {
            projectPath: f.projectPath,
            operationId: "foreign-bulk",
            expectedRevisions: [
                { memoryId: first.id, revision: 1 },
                { memoryId: foreign.id, revision: 1 },
            ],
            changes: [
                { memoryId: first.id, status: "archived" },
                { memoryId: foreign.id, status: "archived" },
            ],
        });
        expect(receipt.state).toBe("refused");
        expect(receipt.reason).toBe("target_not_owned");
        expect(memoryHistorySnapshot(f.db, first.id)).toEqual(before);
        expect(memoryHistorySnapshot(f.db, foreign.id)?.status).toBe("active");
    } finally {
        f.close();
    }
});

test("history restore operation IDs cannot be reused across edit and restore kinds", () => {
    const f = fixture();
    try {
        const row = f.add();
        const changed = edit(f, row.id, "same-operation", "config.ts uses cache_ttl=10m.");
        const receipt = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: changed.decisionKey!,
            operationId: "same-operation",
            expectedRevisions: [{ memoryId: row.id, revision: 2 }],
        });
        expect(receipt.state).toBe("refused");
        expect(receipt.reason).toBe("operation_id_reused");
        expect(memoryHistorySnapshot(f.db, row.id)?.revision).toBe(2);
    } finally {
        f.close();
    }
});

test("history write methods reject mixed edit and restore payloads", () => {
    const f = fixture();
    try {
        const row = f.add();
        const request = {
            projectPath: f.projectPath,
            operationId: "mixed",
            expectedRevisions: [{ memoryId: row.id, revision: 1 }],
            changes: [{ memoryId: row.id, status: "archived" as const }],
            decisionKey: "other",
        };
        expect(() => applyDashboardMemoryEdit(f.db, request)).toThrow("invalid_request");
        expect(memoryHistorySnapshot(f.db, row.id)?.revision).toBe(1);
    } finally {
        f.close();
    }
});

test("history merge link guard rejects relationships changed by another decision", () => {
    const f = fixture();
    try {
        const first = f.add();
        const second = f.add("config.ts sets another timeout.");
        applyCurateMemoryMutation(f.db, {
            key: "link-merge",
            projectPath: f.projectPath,
            sourceSessionId: "",
            operation: "merge",
            targets: [
                { id: first.id, revision: 1 },
                { id: second.id, revision: 1 },
            ],
            content: "config.ts sets cache_ttl=5m and another timeout.",
        });
        f.db
            .prepare("UPDATE memory_successor_links SET decision_key='unrelated' WHERE source_id=?")
            .run(first.id);
        expect(
            previewMemoryRestore(f.db, { projectPath: f.projectPath, decisionKey: "link-merge" })
                .reason,
        ).toBe("successor_changed");
        expect(memoryHistorySnapshot(f.db, first.id)?.status).toBe("archived");
    } finally {
        f.close();
    }
});

test("history module parser refuses incomplete applied receipts without local fallback", async () => {
    const f = fixture();
    try {
        const row = f.add();
        f.db
            .prepare(
                "INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES(?,'history-test',0)",
            )
            .run(f.projectPath);
        let calls = 0;
        await expect(
            memoryHistoryRpc(
                {
                    db: f.db,
                    directory: f.projectPath,
                    moduleClient: {
                        call: async () => {
                            calls++;
                            return {
                                structuredContent: {
                                    version: 1,
                                    state: "applied",
                                    projectPath: f.projectPath,
                                    operationId: "phantom",
                                    reason: null,
                                    revisions: [{ memoryId: row.id, revision: 2 }],
                                    conflicts: [],
                                },
                            };
                        },
                    },
                },
                "memory.edit",
                {
                    projectPath: f.projectPath,
                    operationId: "phantom",
                    expectedRevisions: [{ memoryId: row.id, revision: 1 }],
                    changes: [{ memoryId: row.id, content: "not applied" }],
                },
            ),
        ).rejects.toThrow("invalid_module_receipt");
        expect(calls).toBe(1);
        expect(memoryHistorySnapshot(f.db, row.id)?.content).toBe(row.content);
        expect(memoryHistorySnapshot(f.db, row.id)?.revision).toBe(1);
    } finally {
        f.close();
    }
});
