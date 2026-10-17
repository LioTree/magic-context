/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { getMemoryById, insertMemory } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { archiveExpiredMemories } from "./expire-memories";
import { acquireLeaseWithAcquisition, releaseLease } from "./lease";
import type { DreamerModuleRoute } from "./module-apply";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";
import { runDueTasksForProject } from "./task-scheduler";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("archiveExpiredMemories", () => {
    for (const transformMode of ["ts", "rust"] as const) {
        test(`C5 row 6: scheduled expiry runs with curate and all model tasks disabled (${transformMode})`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            runMigrations(db);
            const project = "/repo/disabled-curate-expiry";
            const expired = insertMemory(db, {
                projectPath: project,
                category: "PROJECT_RULES",
                content: "Expired rule.",
                expiresAt: Date.now() - 1,
            });
            const future = insertMemory(db, {
                projectPath: project,
                category: "PROJECT_RULES",
                content: "Future rule.",
                expiresAt: Date.now() + 60_000,
            });
            const call = mock(async (request: { method: string; body?: unknown }) => {
                expect(request.method).toBe("memory.expire");
                expect(request.body).toMatchObject({
                    name: "memory.expire",
                    arguments: { memory_project: project, ids: [expired.id] },
                });
                db!.prepare("UPDATE memories SET status='archived' WHERE id=?").run(expired.id);
                return { result: { ok: true } };
            });
            const executor = createDreamTaskExecutor({
                sessionDirectory: project,
                openOpenCodeDb: () => null,
                transformMode,
                moduleClient: { call },
            });
            const run = () =>
                runDueTasksForProject({
                    db: db!,
                    projectIdentity: project,
                    tasks: [{ task: "curate", schedule: "", timeoutMinutes: 1 }],
                    executor,
                });
            const leaseKey = leaseKeyFor("curate", project);
            const lease = acquireLeaseWithAcquisition(db, "other-worker", leaseKey);
            expect(lease).not.toBeNull();
            await run();
            expect(getMemoryById(db, expired.id)?.status).toBe("active");
            releaseLease(db, "other-worker", leaseKey);

            expect(await run()).toBe(0);
            expect(getMemoryById(db, expired.id)?.status).toBe("archived");
            expect(getMemoryById(db, future.id)?.status).toBe("active");
            expect(call).toHaveBeenCalledTimes(transformMode === "rust" ? 1 : 0);
            await run();
            expect(call).toHaveBeenCalledTimes(transformMode === "rust" ? 1 : 0);
            expect(db.prepare("SELECT COUNT(*) AS count FROM dream_runs").get()).toEqual({
                count: 0,
            });
            expect(db.prepare("SELECT COUNT(*) AS count FROM memory_mutation_log").get()).toEqual({
                count: 0,
            });
        });
    }

    test("routes expiry using shared context ids without a mirror pull", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const project = "/repo/module-expiry";
        const now = Date.now();
        const memory = insertMemory(db, {
            projectPath: project,
            category: "KNOWN_ISSUES",
            content: "A module-owned TTL memory.",
            expiresAt: now - 1,
        });
        const call = mock(async () => {
            db!
                .prepare("UPDATE memories SET status = 'archived', metadata_json = ? WHERE id = ?")
                .run(JSON.stringify({ archive_reason: "expired" }), memory.id);
            return { result: { ok: true } };
        });
        const moduleRoute: DreamerModuleRoute = {
            moduleClient: { call },
            moduleSessionId: project,
            moduleProjectRoot: project,
            moduleCommandId: "curate-expiry",
        };
        const holderId = "module-expiry-holder";
        const leaseKey = leaseKeyFor("curate", project);
        const leaseAcquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
        expect(leaseAcquisition).not.toBeNull();

        const archived = await archiveExpiredMemories({
            db,
            projectIdentity: project,
            holderId,
            leaseKey,
            leaseAcquisition: leaseAcquisition!,
            now,
            moduleRoute,
        });

        expect(archived).toBe(1);
        expect(call).toHaveBeenCalledWith({
            sessionId: project,
            projectRoot: project,
            // The automated expiry facade, not the agent ctx_memory archive.
            method: "memory.expire",
            body: {
                name: "memory.expire",
                arguments: {
                    memory_project: project,
                    ids: [memory.id],
                    command_id: "curate-expiry:expire:0",
                },
            },
        });
        expect(
            db.prepare("SELECT status, metadata_json FROM memories WHERE id = ?").get(memory.id),
        ).toEqual({
            status: "archived",
            metadata_json: JSON.stringify({ archive_reason: "expired" }),
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM memory_mutation_log").get()).toEqual({
            count: 0,
        });
    });
});
