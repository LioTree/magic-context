/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import vector from "../../../hooks/magic-context/host-runner/conformance/vectors/dream-ownership-v1.json";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory } from "../memory/storage-memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import type { ClassifyModuleCallArgs } from "./classify";
import { decodeRustOwnership, readRustOwnedDreamTasks } from "./rust-ownership";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import type { DreamTaskName } from "./task-registry";
import {
    type DreamTaskRuntimeConfig,
    runDueTasksForProject,
    runManualDream,
    type TaskExecOutcome,
} from "./task-scheduler";

const PROJECT = "git:rust-ownership";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    runMigrations(d);
    insertMemory(d, { projectPath: PROJECT, category: "PROJECT_RULES", content: "rule" });
    return d;
}

function client(answer: unknown) {
    const calls: ClassifyModuleCallArgs[] = [];
    return {
        calls,
        call: async (args: ClassifyModuleCallArgs) => {
            calls.push(args);
            if (answer instanceof Error) throw answer;
            return answer;
        },
    };
}

const published = (tasks: string[]) => ({ ok: true, v: 1, activated: true, published: tasks });

describe("rust ownership reader", () => {
    it("decodes the answer the Rust publisher pins in the shared vector", () => {
        expect([...decodeRustOwnership(vector.answer_example)].sort()).toEqual(
            [...vector.expected.fenceless.with_models].sort(),
        );
    });

    it("treats anything but a well-formed active v1 answer as owning nothing", () => {
        for (const answer of [
            null,
            "curate",
            { ...published(["curate"]), ok: false },
            { ...published(["curate"]), v: 2 },
            { ...published(["curate"]), activated: false },
            { ok: true, v: 1, activated: true, published: "curate" },
            { ok: false, refusal: "host_lane_requires_plugin" },
        ]) {
            expect(decodeRustOwnership(answer).size).toBe(0);
        }
        // Unknown names are dropped; known ones survive; a result envelope is unwrapped.
        expect([
            ...decodeRustOwnership({ result: published(["curate", "not-a-task", 7]) }),
        ]).toEqual(["curate"]);
    });

    it("asks only when the switch is on and the host is attached to ck-mc", async () => {
        const attached = client(published(["curate"]));
        for (const rustBackgroundEnabled of [undefined, false]) {
            const owned = await readRustOwnedDreamTasks({
                rustBackgroundEnabled,
                moduleClient: attached,
                projectIdentity: PROJECT,
                projectRoot: "/repo",
            });
            expect(owned.size).toBe(0);
        }
        expect(attached.calls).toEqual([]);
        // A standalone host has no module client: it never skips a task.
        const standalone = await readRustOwnedDreamTasks({
            rustBackgroundEnabled: true,
            moduleClient: undefined,
            projectIdentity: PROJECT,
            projectRoot: "/repo",
        });
        expect(standalone.size).toBe(0);
        const owned = await readRustOwnedDreamTasks({
            rustBackgroundEnabled: true,
            moduleClient: attached,
            projectIdentity: PROJECT,
            projectRoot: "/repo",
        });
        expect([...owned]).toEqual(["curate"]);
        expect(attached.calls).toHaveLength(1);
        expect(attached.calls[0]).toMatchObject({
            sessionId: PROJECT,
            projectRoot: "/repo",
            method: "dream.ownership",
            body: { method: "dream.ownership", v: 1 },
        });
        // The plugin never declares a claimant of its own.
        expect(Object.hasOwn(attached.calls[0]?.body as object, "claimant")).toBe(false);
    });

    it("runs every task here when the module cannot be read", async () => {
        const broken = client(new Error("module down"));
        const owned = await readRustOwnedDreamTasks({
            rustBackgroundEnabled: true,
            moduleClient: broken,
            projectIdentity: PROJECT,
            projectRoot: "/repo",
        });
        expect(owned.size).toBe(0);
    });
});

function cfg(task: DreamTaskName, schedule = "0 3 * * *"): DreamTaskRuntimeConfig {
    return { task, schedule, timeoutMinutes: 20 };
}

function dueRow(d: Database, task: DreamTaskName, nextDueAt: number): void {
    writeTaskScheduleState(d, {
        projectPath: PROJECT,
        task,
        lastRunAt: null,
        nextDueAt,
        schedule: "0 3 * * *",
        lastStatus: null,
        lastError: null,
        retryCount: 0,
    });
}

describe("scheduler skips exactly the tasks Rust published", () => {
    it("a scheduled pass neither runs nor advances an owned task, and runs the rest", async () => {
        db = freshDb();
        const now = Date.now();
        for (const task of ["curate", "classify-memories"] as const) dueRow(db, task, now - 1000);
        const ran: string[] = [];
        const executor = async (task: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
            ran.push(task.task);
            return { status: "completed" };
        };
        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [cfg("curate"), cfg("classify-memories")],
            executor,
            now,
            rustOwnedTasks: new Set(["curate"]),
        });
        expect(ran).toEqual(["classify-memories"]);
        expect(count).toBe(1);
        // The owned task's row is exactly as Rust found it: no seed, no advance.
        expect(getTaskScheduleState(db, PROJECT, "curate")).toMatchObject({
            nextDueAt: now - 1000,
            lastStatus: null,
        });
        expect(getTaskScheduleState(db, PROJECT, "classify-memories")?.lastStatus).toBe(
            "completed",
        );
    });

    it("an empty or absent published list runs every task, as before", async () => {
        for (const rustOwnedTasks of [undefined, new Set<DreamTaskName>()]) {
            db = freshDb();
            const now = Date.now();
            dueRow(db, "curate", now - 1000);
            const ran: string[] = [];
            await runDueTasksForProject({
                db,
                projectIdentity: PROJECT,
                tasks: [cfg("curate")],
                executor: async (task) => {
                    ran.push(task.task);
                    return { status: "completed" };
                },
                now,
                ...(rustOwnedTasks ? { rustOwnedTasks } : {}),
            });
            expect(ran).toEqual(["curate"]);
            closeQuietly(db);
            db = null;
        }
    });

    it("a manual run reports an owned task as run by ck-mc and runs the others", async () => {
        db = freshDb();
        const ran: string[] = [];
        const executor = async (task: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
            ran.push(task.task);
            return { status: "completed" };
        };
        const forced = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks: [cfg("curate"), cfg("classify-memories")],
            executor,
            task: "curate",
            rustOwnedTasks: new Set(["curate"]),
        });
        expect(ran).toEqual([]);
        expect(forced.ran).toEqual([]);
        expect(forced.skipped).toEqual(["curate: run by ck-mc"]);
        const all = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks: [cfg("curate"), cfg("classify-memories")],
            executor,
            rustOwnedTasks: new Set(["curate"]),
        });
        expect(all.skipped).toEqual(["curate: run by ck-mc"]);
        expect(all.ran).not.toContain("curate");
        expect(ran).not.toContain("curate");
    });
});
