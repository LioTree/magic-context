import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { mergeProjectIdentities } from "@magic-context/core/features/magic-context/storage-identity-merge";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import * as databaseAccess from "../lib/database-access";
import { buildProjectIdPlan, type ProjectIdPlan, runProjectIdsCli } from "./doctor-project-ids";
import {
    type ProjectIdsApplyDeps,
    parseProjectIdsApplyArgs,
    preflightProjectIdApply,
} from "./doctor-project-ids-apply";

let root: string;
let dbPath: string;
let db: Database;
const from = "git:old";
const to = "pj-11111111-1111-4111-8111-111111111111";
const deps: ProjectIdsApplyDeps = {
    inspectHolders: () => ({ safe: true, blockers: [] }),
    probe: () => ({ status: "free" }),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
};

beforeEach(() => {
    root = realpathSync(createTestTempDirFromPath(join(tmpdir(), "mc-project-ids-apply-")));
    dbPath = join(root, "context.db");
    db = new Database(dbPath);
    initializeDatabase(db);
    runMigrations(db);
});
afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
});

function folder(name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
}
function sidecar(directory: string, identity = from): string {
    const path = join(
        folder("project-identities"),
        `${createHash("sha256").update(directory).digest("hex")}.json`,
    );
    writeFileSync(path, JSON.stringify({ directory, identity }));
    return path;
}
function hostDatabase(): string {
    const path = join(root, "planned-host.db");
    const host = new Database(path);
    host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
    host.prepare("INSERT INTO session VALUES ('host-session', ?)").run(folder("host-folder"));
    host.close();
    db.prepare(
        "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES ('host-session', 'opencode', ?, 1)",
    ).run(from);
    return path;
}
async function makePlan(hostDbPath: string | null = null): Promise<ProjectIdPlan> {
    db.prepare("INSERT INTO project_state(project_path) VALUES (?)").run(from);
    sidecar(folder("checkout"));
    return buildProjectIdPlan(db, dbPath, hostDbPath, {
        now: () => new Date("2026-10-15T10:11:12Z"),
        resolve: async () => ({
            status: "resolved",
            via: "root",
            projectId: to,
            canonicalRoot: null,
        }),
    });
}
function check(plan: ProjectIdPlan, overrides: Partial<ProjectIdsApplyDeps> = {}) {
    return preflightProjectIdApply(plan, { dbPath }, { ...deps, ...overrides });
}
function planFile(plan: ProjectIdPlan): string {
    const path = join(root, "plan.json");
    writeFileSync(path, JSON.stringify(plan));
    return path;
}
function bytes(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("doctor project-ids apply preflight", () => {
    it("checks offline using the planned host by default, with read-only handles and identical database bytes", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const pin = sidecar(folder("checkout"));
        const paths = [dbPath, hostPath, pin];
        const before = paths.map(bytes);
        const open = databaseAccess.openExistingDatabase;
        const opens: string[] = [];
        const probe = spyOn(databaseAccess, "openExistingDatabase").mockImplementation(
            (path, options) => {
                expect(options.readonly).toBe(true);
                opens.push(path);
                return open(path, options);
            },
        );
        let resolves = 0;
        try {
            expect(
                await runProjectIdsCli(["apply", "--check", planFile(plan), "--db", dbPath], {
                    ...deps,
                    resolve: async () => {
                        resolves++;
                        throw new Error("offline");
                    },
                }),
            ).toBe(0);
        } finally {
            probe.mockRestore();
        }
        expect(resolves).toBe(0);
        expect(opens).toContain(hostPath);
        expect(opens).toContain(dbPath);
        expect(paths.map(bytes)).toEqual(before);
        expect(
            db.prepare("SELECT 1 FROM project_state WHERE project_path = ?").get(from),
        ).toBeTruthy();
        expect(db.prepare("SELECT * FROM v22_identity_rekey_map").all()).toEqual([]);
    });

    it("bare apply refuses without reading databases or writing anything", async () => {
        const host = hostDatabase();
        const plan = await makePlan(host);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const paths = [dbPath, host, sidecar(folder("checkout"))];
        const before = paths.map(bytes);
        await expect(
            runProjectIdsCli(["apply", planFile(plan), "--db", dbPath], deps),
        ).rejects.toThrow("Nothing was changed. Use doctor project-ids apply --check");
        expect(paths.map(bytes)).toEqual(before);
    });

    it("refuses another store before opening it", async () => {
        const plan = await makePlan();
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const other = join(root, "other.db");
        copyFileSync(dbPath, other);
        const before = bytes(other);
        const result = preflightProjectIdApply(plan, { dbPath: other }, deps);
        expect(result.refusals.map((r) => r.code)).toEqual(["store_mismatch"]);
        expect(bytes(other)).toBe(before);
    });

    it("refuses a changed schemaVersion", async () => {
        const plan = await makePlan();
        plan.schemaVersion--;
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["schema_mismatch"]);
    });

    it("accepts canonical aliases for the planned store and host", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        const hostAlias = join(root, "host-alias.db");
        const dbAlias = join(root, "context-alias.db");
        symlinkSync(hostPath, hostAlias);
        symlinkSync(dbPath, dbAlias);
        expect(
            preflightProjectIdApply(plan, { dbPath: dbAlias, hostPath: hostAlias }, deps).refusals,
        ).toEqual([]);
    });

    it("refuses host B even when it has identical bytes to planned host A", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        const other = join(root, "other-host.db");
        copyFileSync(hostPath, other);
        expect(
            preflightProjectIdApply(plan, { dbPath, hostPath: other }, deps).refusals.map(
                (r) => r.code,
            ),
        ).toEqual(["host_mismatch"]);
    });

    it("refuses a missing planned host instead of dropping its inventory", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        rmSync(hostPath);
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["database_unreadable"]);
    });

    it("refuses an unreadable planned host", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        writeFileSync(hostPath, "not a SQLite database");
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["database_unreadable"]);
    });

    it("refuses an explicit host on a null-host plan", async () => {
        const plan = await makePlan();
        const hostPath = hostDatabase();
        expect(
            preflightProjectIdApply(plan, { dbPath, hostPath }, deps).refusals.map((r) => r.code),
        ).toEqual(["host_mismatch"]);
    });

    for (const empty of [false, true])
        it(`refuses a conflicting rekey target for a ${empty ? "zero-row" : "populated"} source`, async () => {
            const plan = await makePlan();
            if (empty) db.prepare("DELETE FROM project_state WHERE project_path = ?").run(from);
            db.prepare("INSERT INTO v22_identity_rekey_map VALUES (?, 'pj-OTHER', 1)").run(from);
            expect(check(plan).refusals.map((r) => r.code)).toEqual(["rekey_conflict"]);
        });

    for (const completed of [false, true])
        it(`refuses a gained folder for a ${completed ? "completed source that regained rows" : "not-yet-merged source"}`, async () => {
            const plan = await makePlan();
            if (completed) {
                mergeProjectIdentities(db, from, to);
                db.prepare("INSERT INTO project_state(project_path) VALUES (?)").run(from);
            }
            sidecar(folder("new-folder"));
            expect(check(plan).refusals.map((r) => r.code)).toEqual(["new_folder"]);
        });

    it("recomputes host and workspace observations, not only sidecars", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        const host = new Database(hostPath);
        host.prepare("UPDATE session SET directory = ?").run(folder("new-host-folder"));
        host.close();
        db.exec("INSERT INTO workspaces VALUES (1, 'space', 1, 1, '[]')");
        db.prepare("INSERT INTO workspace_members VALUES (1, ?, 'alias', ?, 1)").run(
            from,
            folder("new-workspace-folder"),
        );
        expect(check(plan).refusals.filter((r) => r.code === "new_folder")).toHaveLength(2);
    });

    for (const completed of [false, true])
        it(`does not check gained folders of a zero-row ${completed ? "completed" : "unstarted"} source`, async () => {
            const plan = await makePlan();
            if (completed) mergeProjectIdentities(db, from, to);
            else db.prepare("DELETE FROM project_state WHERE project_path = ?").run(from);
            sidecar(folder("new-folder"));
            const result = check(plan);
            expect(result.pairs[0].liveRows).toBe(0);
            expect(result.refusals).toEqual([]);
        });

    it("ignores folders no longer attributed to a source with remaining rows", async () => {
        const plan = await makePlan();
        sidecar(folder("unrelated-folder"), "git:other");
        rmSync(join(root, "checkout"), { recursive: true });
        expect(check(plan).refusals).toEqual([]);
    });

    it("reports planned and live counts without refusing count drift", async () => {
        const plan = await makePlan();
        db.prepare(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES ('new-session', 'pi', ?, 1)",
        ).run(from);
        const result = check(plan);
        expect(result.refusals).toEqual([]);
        expect(result.pairs[0].pair.rowsByTable.session_projects).toBe(0);
        expect(result.pairs[0].liveRowsByTable.session_projects).toBe(1);
        const output = spyOn(console, "log").mockImplementation(() => {});
        try {
            expect(
                await runProjectIdsCli(["apply", "--check", planFile(plan), "--db", dbPath], deps),
            ).toBe(0);
            expect(output.mock.calls.flat().join("\n")).toContain(
                "session_projects: planned 0; live 1",
            );
            expect(output.mock.calls.flat().join("\n")).toContain("Nothing was changed");
        } finally {
            output.mockRestore();
        }
    });

    it("enforces the injected free-space threshold for the whole bundle plus ten percent", async () => {
        const plan = await makePlan();
        const nested = join(folder("project-identities/nested"), "extra.bin");
        writeFileSync(nested, Buffer.alloc(1234));
        const pinPath = sidecar(folder("checkout"));
        const bundle = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, nested, pinPath].reduce(
            (sum, path) => sum + statSync(path).size,
            0,
        );
        const required = Math.ceil((bundle * 11) / 10);
        const result = check(plan, {
            freeBytes: (path) => {
                expect(path).toBe(root);
                return required - 1;
            },
        });
        expect(result.space).toEqual({
            bundleBytes: bundle,
            requiredBytes: required,
            freeBytes: required - 1,
        });
        expect(result.refusals.map((r) => r.code)).toEqual(["insufficient_space"]);
        expect(check(plan, { freeBytes: () => required }).refusals).toEqual([]);
    });

    it.each([
        "holder",
        "in_use",
        "unknown",
    ])("refuses offline holder uncertainty (%s)", async (kind) => {
        const plan = await makePlan();
        const result = check(
            plan,
            kind === "holder"
                ? {
                      inspectHolders: () => ({ safe: false, blockers: ["ck-mc"] }),
                  }
                : {
                      probe: () =>
                          kind === "in_use"
                              ? { status: "in_use", pids: [123] }
                              : { status: "unknown", reason: "probe failed" },
                  },
        );
        expect(result.refusals.map((r) => r.code)).toEqual(["holders"]);
        expect(result.pairs).toEqual([]);
    });

    it("retains the shared authority-managed and workspace merge fences", async () => {
        const plan = await makePlan();
        db.prepare("INSERT INTO authority_managed VALUES (?, 'fixture-store', 1)").run(from);
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["merge_not_allowed"]);
        db.exec(
            "DELETE FROM authority_managed; INSERT INTO workspaces VALUES (1,'a',1,1,'[]'), (2,'b',1,1,'[]')",
        );
        db.prepare("INSERT INTO workspace_members VALUES (1, ?, 'a', ?, 1), (2, ?, 'b', ?, 1)").run(
            from,
            folder("checkout"),
            to,
            folder("target"),
        );
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["merge_not_allowed"]);
    });

    it("rejects malformed plans and wrong-way pairs without writing", async () => {
        const plan = await makePlan();
        expect(() => check({ ...plan, version: 2 } as unknown as ProjectIdPlan)).toThrow(
            "Invalid version",
        );
        expect(() => check({ ...plan, pairs: [{ ...plan.pairs[0], to: "dir:wrong" }] })).toThrow(
            "Invalid project identity plan pair",
        );
        expect(() =>
            check({ ...plan, pairs: [{ ...plan.pairs[0], to: "pj-implicit1-abc" }] }),
        ).toThrow("Invalid project identity plan pair");
    });

    it("parses only an explicit read-only check with one plan path", () => {
        expect(
            parseProjectIdsApplyArgs([
                "apply",
                "--check",
                "plan.json",
                "--db",
                "context.db",
                "--host-db",
                "host.db",
            ]),
        ).toEqual({ planPath: "plan.json", dbPath: "context.db", hostPath: "host.db" });
        for (const args of [
            ["apply"],
            ["apply", "--check"],
            ["apply", "--check", "a", "b"],
            ["apply", "--check", "a", "--force"],
            ["apply", "--check", "--check", "a"],
            ["apply", "--check", "a", "--db"],
        ])
            expect(() => parseProjectIdsApplyArgs(args)).toThrow();
    });

    it("refuses the whole check when a later pair gained a folder, without changing earlier pairs", async () => {
        db.prepare("INSERT INTO project_state(project_path) VALUES ('dir:later')").run();
        sidecar(folder("later"), "dir:later");
        const plan = await makePlan();
        expect(plan.pairs).toHaveLength(2);
        const later = plan.pairs[1];
        sidecar(folder("later-new-folder"), later.from);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const before = bytes(dbPath);
        expect(check(plan).refusals).toEqual([
            expect.objectContaining({ code: "new_folder", from: later.from }),
        ]);
        const log = spyOn(console, "log").mockImplementation(() => {});
        const error = spyOn(console, "error").mockImplementation(() => {});
        try {
            expect(
                await runProjectIdsCli(["apply", "--check", planFile(plan), "--db", dbPath], deps),
            ).toBe(1);
            expect(log.mock.calls.flat().join("\n")).toContain("Nothing was changed");
        } finally {
            log.mockRestore();
            error.mockRestore();
        }
        expect(bytes(dbPath)).toBe(before);
        expect(db.prepare("SELECT * FROM v22_identity_rekey_map").all()).toEqual([]);
    });
});
