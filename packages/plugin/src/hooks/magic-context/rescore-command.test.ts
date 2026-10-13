import { afterEach, describe, expect, test } from "bun:test";
import {
    type RescoreModelProfile,
    RescoreService,
} from "../../features/magic-context/rescore-service";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    acceptsMagicContextCommandArguments,
    createMagicContextCommandHandler,
} from "./command-handler";
import { createRescoreCommandController, formatRescoreStatus } from "./rescore-command";
import type { RescoreCarrier } from "./rescore-driver";

const dbs: Database[] = [];
afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
});
const profile: RescoreModelProfile = { model: "mock/score", temperature: 0, maxOutputTokens: 1000 };
function fixture() {
    const db = new Database(":memory:");
    dbs.push(db);
    initializeDatabase(db);
    db.prepare(
        "INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES ('session','opencode','git:rescore',1)",
    ).run();
    db.prepare(
        "INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,title,content,p1,p2,p3,p4,importance,episode_type,created_at,legacy) VALUES ('session','opencode',1,1,2,'title','','P1','P2','P3','P4',73,'feature',1,0)",
    ).run();
    const serviceOptions = () => ({
        db,
        sessionId: "session",
        projectPath: "git:rescore",
        harness: "opencode",
        admissionFailure: () => null,
    });
    const service = new RescoreService({ ...serviceOptions(), profile });
    return { db, service, serviceOptions };
}
describe("rescore command surfaces", () => {
    test("snapshotless confirm after preview never admits a paid call", async () => {
        const f = fixture();
        let paid = 0;
        const execute = createRescoreCommandController({
            serviceOptions: f.serviceOptions,
            resolveProfile: () => profile,
            createCarrier: () => ({
                complete: async () => {
                    paid++;
                    throw new Error("unexpected call");
                },
                recover: async () => ({ state: "unavailable" }),
                interrupt: async () => true,
            }),
        });
        await execute("session", "");
        await expect(execute("session", "confirm")).rejects.toThrow("ctx-rescore");
        expect(paid).toBe(0);
        expect(f.service.listJobs()).toEqual([]);
    });
    test("malformed commands and snapshotless confirm are rejected before store/model/carrier access", async () => {
        let accessed = 0;
        const controller = createRescoreCommandController({
            serviceOptions: () => {
                accessed++;
                throw new Error("store access");
            },
            resolveProfile: () => {
                accessed++;
                return profile;
            },
            createCarrier: () => {
                accessed++;
                throw new Error("carrier access");
            },
        });
        for (const raw of [
            "confirm",
            "confirm id extra",
            "confirm --project",
            "--force",
            "resume now",
            "undo --force base",
            "undo 1 9007199254740992",
            "undo 1 0",
        ]) {
            expect(acceptsMagicContextCommandArguments("ctx-rescore", raw)).toBe(false);
            await expect(controller("session", raw)).rejects.toThrow("ctx-rescore");
        }
        expect(accessed).toBe(0);
    });
    test("OpenCode1 shares parser and handles rescore with compaction disabled", async () => {
        const f = fixture();
        const replies: string[] = [];
        const calls: string[] = [];
        const handler = createMagicContextCommandHandler({
            db: f.db,
            compactionOff: true,
            executeRescore: async (_id, raw) => {
                calls.push(raw);
                return "preview";
            },
            sendNotification: async (_id, text) => {
                replies.push(text);
            },
        })["command.execute.before"];
        await expect(
            handler(
                { command: "ctx-rescore", sessionID: "session", arguments: "confirm" },
                { parts: [] },
                {},
            ),
        ).rejects.toThrow();
        expect(calls).toEqual([]);
        expect(replies[0]).toContain("ctx-rescore");
        await expect(
            handler(
                { command: "ctx-rescore", sessionID: "session", arguments: "--project" },
                { parts: [] },
                {},
            ),
        ).rejects.toThrow();
        expect(calls).toEqual(["--project"]);
    });
    test("previews never confirm, confirmation drives once and status needs no model resolution", async () => {
        const f = fixture();
        let paid = 0;
        let resolved = 0;
        let settled!: () => void;
        const completed = new Promise<void>((resolve) => {
            settled = resolve;
        });
        const carrier: RescoreCarrier = {
            complete: async (request) => {
                paid++;
                return JSON.stringify(
                    Object.keys(JSON.parse(request.attempt.handle_map)).map((handle) => ({
                        handle,
                        importance: 10,
                        reason: "recall",
                    })),
                );
            },
            recover: async () => ({ state: "unavailable" }),
            interrupt: async () => true,
        };
        const execute = createRescoreCommandController({
            serviceOptions: f.serviceOptions,
            resolveProfile: () => {
                resolved++;
                return profile;
            },
            createCarrier: () => carrier,
            notify: async () => {
                settled();
            },
        });
        await execute("session", "");
        const preview = await execute("session", "");
        expect(paid).toBe(0);
        const snapshotId = preview.match(/Snapshot: (\S+)/)?.[1];
        expect(snapshotId).toBeDefined();
        await execute("session", `confirm ${snapshotId}`);
        await completed;
        expect(paid).toBe(1);
        const before = resolved;
        const status = await execute("session", "status");
        expect(resolved).toBe(before);
        expect(status).toContain("completed: 1");
        expect(status).toContain("next natural history rebuild");
    });
    test("status shows cross-harness errors, overlap and lease waits; resume clears all pause kinds", () => {
        const f = fixture();
        const authority = f.service.confirm(f.service.preview().snapshotId);
        for (const state of ["paused", "auto-paused", "interrupted"] as const) {
            for (const reason of [
                "user",
                "failed-items",
                "overlap",
                "recomp-lease",
                "carrier-active",
            ]) {
                f.db
                    .prepare(
                        "UPDATE rescore_jobs SET state = ?, pause_reason = ?, blocking_job_id = 'blocking-job', consecutive_failed_batches = 3, last_error = 'missing-credentials: provider denied'",
                    )
                    .run(state, reason);
                const other = new RescoreService({
                    ...f.serviceOptions(),
                    harness: "pi",
                    profile: { ...profile, model: null },
                });
                const text = formatRescoreStatus(other, authority.jobId);
                expect(text).toContain("missing-credentials: provider denied");
                expect(text).toContain("Blocking job: blocking-job");
                expect(text).toContain(reason);
                expect(f.service.resume(authority)).toBe(true);
                const resumed = f.service.status(authority.jobId).job;
                expect(resumed.state).toBe("running");
                expect(resumed.pause_reason).toBeNull();
                expect(resumed.blocking_job_id).toBeNull();
                expect(resumed.consecutive_failed_batches).toBe(0);
            }
        }
    });
});
