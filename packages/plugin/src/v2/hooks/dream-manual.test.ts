import { expect, test } from "bun:test";
import { DreamerConfigSchema } from "../../config/schema/magic-context";
import { summarizeManualDream } from "../../features/magic-context/dreamer/manual-summary";
import {
    formatUnsupportedDreamTasks,
    toolLoopDreamTasks,
} from "../../features/magic-context/dreamer/task-registry";
import type { DreamTaskRuntimeConfig } from "../../features/magic-context/dreamer/task-scheduler";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    resolveManualDreamTask,
    runManualDreamNow,
    selectRunnableDreamTasks,
} from "./dream-manual";

test("no argument runs every enabled task", () => {
    expect(resolveManualDreamTask(undefined)).toEqual({});
    expect(resolveManualDreamTask("   ")).toEqual({});
    expect(resolveManualDreamTask(42)).toEqual({});
});

test("accepts a canonical task name", () => {
    expect(resolveManualDreamTask("verify")).toEqual({ task: "verify" });
    expect(resolveManualDreamTask("  map-memories ")).toEqual({ task: "map-memories" });
});

test("rejects an unknown task with the valid list", () => {
    const result = resolveManualDreamTask("nope");
    expect(result.task).toBeUndefined();
    expect(result.error).toContain('Unknown task "nope"');
    expect(result.error).toContain("map-memories");
});

test("summarizes a manual run like the v1 command output", () => {
    const message = summarizeManualDream({
        ran: ["verify"],
        skippedNoWork: ["curate"],
        deferredBusy: ["map-memories"],
        failed: ["retrospective"],
        failureDetails: ["retrospective: model unavailable"],
        details: ["verify: 3 memories checked"],
        backlogBefore: { verify: { pending: 3, total: 3 } },
        backlogAfter: { verify: { pending: 0, total: 3 } },
    });
    expect(message).toContain("Ran: verify");
    expect(message).toContain("Skipped (no work): curate");
    expect(message).toContain("Busy: map-memories");
    expect(message).toContain("Failed: retrospective");
    expect(message).toContain("- retrospective: model unavailable");
    expect(message).toContain("Backlog at run start:");
    expect(message).toContain("- verify: 3 pending / 3 total");
    expect(message).toContain("Backlog at run end:");
});

test("summarizes an idle run", () => {
    const message = summarizeManualDream({
        ran: [],
        skippedNoWork: [],
        deferredBusy: [],
        failed: [],
        failureDetails: [],
        details: [],
        backlogBefore: {},
        backlogAfter: {},
    });
    expect(message).toContain("No enabled dream tasks to run.");
});

test("selectRunnableDreamTasks reports requiresTools tasks as unsupported without a tool loop", () => {
    const tasks = [
        { task: "verify", schedule: "0 3 * * *" },
        { task: "classify-memories", schedule: "0 3 * * *" },
        { task: "curate", schedule: "" },
    ] as DreamTaskRuntimeConfig[];
    const selection = selectRunnableDreamTasks({ tasks, toolsSupported: false });
    expect(selection.unsupported).toEqual(["verify"]);
    // Curate is disabled, so it is omitted from the unsupported report, but it
    // still cannot enter the runnable set without a tool loop.
    expect(selection.runnable.map((config) => config.task)).toEqual(["classify-memories"]);
});

test("selectRunnableDreamTasks keeps every task when the host has a tool loop", () => {
    const tasks = [{ task: "verify", schedule: "0 3 * * *" }] as DreamTaskRuntimeConfig[];
    expect(selectRunnableDreamTasks({ tasks, toolsSupported: true })).toEqual({
        runnable: tasks,
        unsupported: [],
    });
});

test("tool-free tasks stay runnable on a host without a tool loop", () => {
    // These three answer with one self-contained document, or do host-side
    // database work with no model call at all, so a host with no tool loop can
    // still run them.
    const tasks = [
        { task: "evaluate-smart-notes", schedule: "0 3 * * *" },
        { task: "review-user-memories", schedule: "0 3 * * *" },
        { task: "promote-primers", schedule: "0 3 * * *" },
    ] as DreamTaskRuntimeConfig[];
    const selection = selectRunnableDreamTasks({ tasks, toolsSupported: false });
    expect(selection.unsupported).toEqual([]);
    expect(selection.runnable.map((config) => config.task)).toEqual([
        "evaluate-smart-notes",
        "review-user-memories",
        "promote-primers",
    ]);
});

test("only the genuine tool-loop tasks are refused", () => {
    expect(toolLoopDreamTasks()).toEqual([
        "map-memories",
        "verify",
        "verify-broad",
        "curate",
        "retrospective",
        "maintain-docs",
        "refresh-primers",
    ]);
});

test("the refusal names each task and why its tool loop is needed", () => {
    const text = formatUnsupportedDreamTasks(["verify", "maintain-docs"], "MC-D08");
    expect(text).toContain("- verify: unavailable on this host (MC-D08)");
    expect(text).toContain("re-check each memory against the code");
    expect(text).toContain("- maintain-docs: unavailable on this host (MC-D08)");
    expect(text).toContain("read-only file tools to investigate documentation corrections");
});

test("an explicitly requested tool-requiring task is reported unsupported, not run", () => {
    const tasks = [{ task: "verify", schedule: "" }] as DreamTaskRuntimeConfig[];
    expect(
        selectRunnableDreamTasks({ tasks, toolsSupported: false, requestedTask: "verify" }),
    ).toEqual({ runnable: [], unsupported: ["verify"] });
});

// The v2 manual command reads ck-mc's published list only when attached; an
// owned task is reported as run by ck-mc and never executed here.
for (const attached of [true, false]) {
    test(`manual dream ${attached ? "reports a ck-mc task instead of running it" : "without ck-mc runs it"}`, async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const calls: string[] = [];
        const opened: string[] = [];
        const outcome = await runManualDreamNow({
            db: db as never,
            dreamer: DreamerConfigSchema.parse({}),
            projectIdentity: "git:v2-manual-ownership",
            directory: "/tmp/v2-manual-ownership",
            executor: {
                capabilities: { tools: false },
                open: async () => {
                    opened.push("child");
                    throw new Error("no child in this test");
                },
            } as never,
            sessionId: "ses-v2-manual",
            task: "classify-memories",
            rustBackgroundEnabled: true,
            ...(attached
                ? {
                      moduleClient: {
                          call: async (args: { method: string }) => {
                              calls.push(args.method);
                              return {
                                  ok: true,
                                  v: 1,
                                  activated: true,
                                  published: ["classify-memories"],
                              };
                          },
                      },
                  }
                : {}),
        });
        if (attached) {
            expect(calls).toEqual(["dream.ownership"]);
            expect(outcome.summary.skipped).toEqual(["classify-memories: run by ck-mc"]);
            expect(outcome.summary.ran).toEqual([]);
            expect(outcome.summary.failed).toEqual([]);
        } else {
            expect(calls).toEqual([]);
            expect(outcome.summary.skipped ?? []).not.toContain("classify-memories: run by ck-mc");
            // The task reached the scheduler: it ran, failed, or found no work.
            expect([
                ...outcome.summary.ran,
                ...outcome.summary.failed,
                ...outcome.summary.skippedNoWork,
                ...(outcome.summary.skipped ?? []),
            ]).toContain("classify-memories");
        }
        db.close();
    });
}
