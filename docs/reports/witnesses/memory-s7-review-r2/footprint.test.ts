/// <reference types="bun-types" />
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireCompartmentLease, releaseCompartmentLease } from "../../../../packages/plugin/src/features/magic-context/compartment-lease";
import { getCompartments, replaceAllCompartments } from "../../../../packages/plugin/src/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../../../../packages/plugin/src/features/magic-context/memory/project-identity";
import { closeDatabase, openDatabase } from "../../../../packages/plugin/src/features/magic-context/storage";
import { runCompartmentAgent } from "../../../../packages/plugin/src/hooks/magic-context/compartment-runner";
import { settleHistorianTurnTwoRuns } from "../../../../packages/plugin/src/hooks/magic-context/historian-turn-two-step";
import { clearProducerModelObservations, observeProducerModelsForTest, prepareProducerFixture } from "../../../../packages/plugin/src/hooks/magic-context/producer-window-test-support";
import { __ignoredNotificationTest } from "../../../../packages/plugin/src/hooks/magic-context/send-session-notification";
import type { PluginContext } from "../../../../packages/plugin/src/plugin/types";
import { __resetNotificationStateForTests } from "../../../../packages/plugin/src/shared/rpc-notifications";
import { Database } from "../../../../packages/plugin/src/shared/sqlite";

const oldDataHome = process.env.XDG_DATA_HOME;
let home = "";
beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "s7-r2-ts-"));
    process.env.XDG_DATA_HOME = home;
    await observeProducerModelsForTest(["test/fixture-historian"]);
    __ignoredNotificationTest.setHoldDetector(() => false);
});
afterEach(async () => {
    await settleHistorianTurnTwoRuns();
    clearProducerModelObservations();
    __ignoredNotificationTest.reset();
    __resetNotificationStateForTests();
    closeDatabase();
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    rmSync(home, { recursive: true, force: true });
});

type Rows = Record<string, string[]>;
function inventory(db: Database): Rows {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]));
}
function changes(before: Rows, after: Rows) {
    return Object.fromEntries(Object.keys(after).filter(table => JSON.stringify(before[table]) !== JSON.stringify(after[table])).map(table => [table, {
        before: before[table]!.length, after: after[table]!.length,
        removed: before[table]!.filter(row => !after[table]!.includes(row)).length,
        added: after[table]!.filter(row => !before[table]!.includes(row)).length,
    }]));
}
function seedOpenCode(sessionId: string, appendedCount: number) {
    const path = join(home, "opencode", "opencode.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec("CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id INTEGER PRIMARY KEY, message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)");
    for (let i = 1; i <= (appendedCount === 2 ? 17 : 9); i++) {
        const id = `m-${i}`;
        const role = i % 2 === 0 && i <= (appendedCount === 2 ? 12 : 4) ? "assistant" : "user";
        db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(id, sessionId, i, i, JSON.stringify({ id, role, sessionID: sessionId }));
        db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(i, id, sessionId, i, i, JSON.stringify({ type: "text", text: i === 3 ? "Cap uploads at 64 KiB." : "fixture text" }));
    }
    db.close();
    return path;
}
function reply(appendedCount: number): string {
    const second = appendedCount === 2 ? '<compartment start="5" end="6" title="Gateway"><p1>Added a gateway.</p1></compartment>' : "";
    const suffix = appendedCount === 2 ? "<meta><unprocessed_from>7</unprocessed_from></meta>" : "";
    return `<output><compartments><compartment start="3" end="4" title="Upload cap"><p1>Capped uploads.</p1></compartment>${second}</compartments><facts><CONSTRAINTS>* [at_compartment=1 messages=3] Uploads are capped at 64 KiB.</CONSTRAINTS></facts>${suffix}</output>`;
}

for (const appendedCount of [1, 2]) for (const memoryEnabled of [false, true]) for (const moduleAuthority of [false, true]) for (const autoPromote of [false, true]) {
    const label = `append=${appendedCount},memory=${memoryEnabled},module=${moduleAuthority},promote=${autoPromote}`;
    test.skipIf(process.env.MC_S7_REVIEW !== "1")(`s7_r2_ts_dormant_all_tables ${label}`, async () => {
        const sessionId = "s7-r2-ts-session";
        const directory = join(home, "project");
        mkdirSync(directory);
        const opencodePath = seedOpenCode(sessionId, appendedCount);
        const db = openDatabase();
        if (!db) throw new Error("temporary context database could not be opened");
        replaceAllCompartments(db, sessionId, [{ sequence: 0, startMessage: 1, endMessage: 2, startMessageId: "m-1", endMessageId: "m-2", title: "Earlier", content: "Old summary" }]);
        const project = resolveProjectIdentity(directory);
        if (moduleAuthority) db.prepare("INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES(?, 'r2-module', 1)").run(project);
        const client = { session: {
            get: mock(async () => ({ data: { directory } })),
            create: mock(async () => ({ data: { id: "s7-r2-ts-child" } })),
            prompt: mock(async () => ({})),
            messages: mock(async () => ({ data: [{ info: { role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: reply(appendedCount) }] }] })),
            delete: mock(async () => ({})),
        } } as unknown as PluginContext["client"];
        const before = inventory(db);
        const opencode = new Database(opencodePath);
        const beforeOpenCode = inventory(opencode);
        expect(acquireCompartmentLease(db, sessionId, "r2-holder")).not.toBeNull();
        try {
            await runCompartmentAgent(await prepareProducerFixture({ model: "test/fixture-historian", client, db, sessionId, directory, historianChunkTokens: 10_000, compartmentLeaseHolderId: "r2-holder", memoryEnabled, autoPromote }));
        } finally {
            releaseCompartmentLease(db, sessionId, "r2-holder");
        }
        await settleHistorianTurnTwoRuns();
        const after = inventory(db);
        expect(getCompartments(db, sessionId)).toHaveLength(1 + appendedCount);
        expect(after.memory_publications).toHaveLength(1);
        expect(after.memory_stage_attempts).toHaveLength(1);
        expect(after.memory_activity_ledger).toHaveLength(appendedCount);
        const stage = db.prepare("SELECT state, stage FROM memory_stage_attempts").get();
        expect(stage).toEqual({ state: "published", stage: "turn_one" });
        const request = JSON.parse((db.prepare("SELECT request_json FROM memory_stage_attempts").get() as { request_json: string }).request_json) as Record<string, unknown>;
        expect(request.lane).toBe("dormant");
        expect(Object.keys(request).sort()).toEqual(["chunkEnd", "chunkStart", "lane"]);
        expect(after.memory_pending_facts).toHaveLength(memoryEnabled && autoPromote && moduleAuthority ? 1 : 0);
        expect(after.memories).toHaveLength(memoryEnabled && autoPromote && !moduleAuthority ? 1 : 0);
        expect(after.memory_fact_blocks).toHaveLength(0);
        expect(after.memory_fact_block_links).toHaveLength(0);
        expect(after.memory_tool_proposals).toHaveLength(0);
        expect(inventory(opencode)).toEqual(beforeOpenCode);
        opencode.close();
        console.log("S7_R2_TS " + JSON.stringify({ label, tableCount: Object.keys(after).length, changes: changes(before, after), stage, lifecycle: { publications: after.memory_publications, stages: stage, activity: after.memory_activity_ledger, facts: after.memory_pending_facts } }));
    });
}

test.skipIf(process.env.MC_S7_REVIEW !== "1")("s7_r2_ts_enabled_writes_turn_one_stage", async () => {
    const sessionId = "s7-r2-ts-enabled";
    const directory = join(home, "project");
    mkdirSync(directory);
    seedOpenCode(sessionId, 1);
    const db = openDatabase();
    if (!db) throw new Error("temporary context database could not be opened");
    replaceAllCompartments(db, sessionId, [{ sequence: 0, startMessage: 1, endMessage: 2, startMessageId: "m-1", endMessageId: "m-2", title: "Earlier", content: "Old summary" }]);
    const client = { session: {
        get: mock(async () => ({ data: { directory } })),
        create: mock(async () => ({ data: { id: "s7-r2-enabled-child" } })),
        prompt: mock(async () => ({})),
        messages: mock(async () => ({ data: [{ info: { role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: reply(1) }] }] })),
        delete: mock(async () => ({})),
    } } as unknown as PluginContext["client"];
    expect(acquireCompartmentLease(db, sessionId, "r2-enabled-holder")).not.toBeNull();
    try {
        await runCompartmentAgent(await prepareProducerFixture({ model: "test/fixture-historian", client, db, sessionId, directory,
            historianChunkTokens: 10_000, compartmentLeaseHolderId: "r2-enabled-holder", memoryEnabled: false,
            autoPromote: false, memoryLifecycleLane: "enabled" }));
    } finally { releaseCompartmentLease(db, sessionId, "r2-enabled-holder"); }
    await settleHistorianTurnTwoRuns();
    const stages = db.prepare("SELECT stage,state,run_attempt,request_json FROM memory_stage_attempts").all() as Array<{ stage: string; state: string; run_attempt: number; request_json: string }>;
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ stage: "turn_one", state: "published", run_attempt: 1 });
    const request = JSON.parse(stages[0]!.request_json) as Record<string, unknown>;
    expect(request.lane).toBe("enabled");
    expect(Object.keys(request).sort()).toEqual(["chunkEnd", "chunkStart", "lane"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_publications WHERE commit_order IS NOT NULL").get()).toEqual({ n: 1 });
});
