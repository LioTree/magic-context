import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import {
    applyDashboardMemoryEdit,
    applyMemoryRestore,
    previewMemoryRestore,
} from "../../features/magic-context/memory/history-applier";
import { applyAgentMemoryMutation } from "../../features/magic-context/memory/lifecycle-applier";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import type { Database } from "../../shared/sqlite";

export interface DashboardProofPass {
    m0: string;
    m1: string;
    hard: boolean;
}

/** The adapter calls the host's real injector with a fresh copy of the same tail. */
export function dashboardCacheProof(
    db: Database,
    projectPath: string,
    sessionId: string,
    pass: (bust: boolean, hard?: boolean) => DashboardProofPass,
): void {
    if (process.env.MC_DASHBOARD_TRACE) {
        dashboardTrace(db, projectPath, sessionId, pass);
        return;
    }
    const seed = insertMemory(db, {
        projectPath,
        category: "CONSTRAINTS",
        content: "Initial dashboard rule.",
    });
    const agent = insertMemory(db, {
        projectPath,
        category: "CONSTRAINTS",
        content: "Initial agent rule.",
    });
    const initial = pass(true);
    expect(initial.hard).toBe(true);
    const edit = (content: string, operationId: string) => {
        const row = db.prepare("SELECT revision FROM memories WHERE id=?").get(seed.id) as {
            revision: number;
        };
        const receipt = applyDashboardMemoryEdit(db, {
            projectPath,
            operationId,
            expectedRevisions: [{ memoryId: seed.id, revision: row.revision }],
            changes: [{ memoryId: seed.id, content }],
        });
        expect(receipt.state).toBe("applied");
    };
    edit("Dashboard correction & <quoted>.", "dashboard-first");
    const deferred = pass(false);
    expect(deferred.hard).toBe(false);
    expect(deferred.m0).toBe(initial.m0);
    expect(deferred.m1).toBe(initial.m1);
    const admitted = pass(true);
    expect(admitted.hard).toBe(false);
    expect(admitted.m0).toBe(initial.m0);
    expect(admitted.m1).toContain("<memory-updates>");
    expect(admitted.m1).toContain("Dashboard correction &amp; &lt;quoted&gt;.");
    // An automated revision must not rewrite a dashboard delta already served.
    db.prepare(
        "UPDATE memories SET content='Later automated text',revision=revision+1 WHERE id=?",
    ).run(seed.id);
    for (let index = 0; index < 12; index++) {
        const replay = pass(index % 2 === 0);
        expect(replay.hard).toBe(false);
        expect(replay.m0).toBe(admitted.m0);
        expect(replay.m1).toBe(admitted.m1);
    }
    const folded = pass(true, true);
    expect(folded.hard).toBe(true);
    expect(folded.m0).toContain("Later automated text");
    expect(folded.m1).not.toContain("Dashboard correction");

    let previous = folded;
    let rng = 0x49b13cd;
    const counts = { dashboard: 0, agent: 0, normal: 0, held: 0, bust: 0, hard: 0 };
    for (let step = 0; step < 240; step++) {
        rng ^= rng << 13;
        rng ^= rng >>> 17;
        rng ^= rng << 5;
        const kind = (rng >>> 0) % 3;
        if (kind === 0) {
            edit(`Dashboard randomized correction ${step}.`, `dashboard-random:${step}`);
            counts.dashboard++;
        } else if (kind === 1) {
            expect(
                applyAgentMemoryMutation(db, {
                    key: `agent-random:${step}`,
                    operation: "update",
                    projectPath,
                    sourceSessionId: sessionId,
                    targets: [
                        {
                            id: agent.id,
                            revision: (
                                db
                                    .prepare("SELECT revision FROM memories WHERE id=?")
                                    .get(agent.id) as { revision: number }
                            ).revision,
                        },
                    ],
                    content: `Agent correction ${step}.`,
                }).state,
            ).toBe("applied");
            counts.agent++;
        } else counts.normal++;
        const natural = step % 19 === 18;
        const bust = natural || (rng >>> 8) % 3 === 0;
        const current = pass(bust, natural);
        expect(current.hard).toBe(natural);
        if (!bust) {
            expect(current.m0).toBe(previous.m0);
            expect(current.m1).toBe(previous.m1);
            counts.held++;
        } else if (!natural) {
            expect(current.m0).toBe(previous.m0);
            counts.bust++;
        } else counts.hard++;
        previous = current;
    }
    console.log(
        `dashboard cache proof ${sessionId}: 240 randomized passes ${JSON.stringify(counts)}`,
    );
    const beforeArchive = pass(false);
    const revision = (
        db.prepare("SELECT revision FROM memories WHERE id=?").get(seed.id) as { revision: number }
    ).revision;
    const archive = applyDashboardMemoryEdit(db, {
        projectPath,
        operationId: "archive-proof",
        expectedRevisions: [{ memoryId: seed.id, revision }],
        changes: [{ memoryId: seed.id, status: "archived" }],
    });
    expect(archive.state).toBe("applied");
    expect(pass(false)).toEqual({ ...beforeArchive, hard: false });
    const archiveDelta = pass(true);
    expect(archiveDelta.hard).toBe(false);
    expect(archiveDelta.m0).toBe(beforeArchive.m0);
    expect(archiveDelta.m1).toContain(`<removed id="${seed.id}"/>`);
    const archivedHard = pass(true, true);
    expect(archivedHard.m0).not.toContain("Dashboard randomized correction");
    if (!archive.decisionKey) throw new Error("Applied archive has no history decision");
    const preview = previewMemoryRestore(db, { projectPath, decisionKey: archive.decisionKey });
    expect(
        applyMemoryRestore(db, {
            projectPath,
            operationId: "undo-proof",
            decisionKey: archive.decisionKey,
            expectedRevisions: preview.expectedRevisions,
        }).state,
    ).toBe("applied");
    expect(pass(false)).toEqual({ ...archivedHard, hard: false });
    const restoreDelta = pass(true);
    expect(restoreDelta.hard).toBe(false);
    expect(restoreDelta.m1).toContain(`<added id="${seed.id}"`);

    const foreign = insertMemory(db, {
        projectPath: "git:joined-proof",
        category: "CONSTRAINTS",
        content: "Unseen workspace rule.",
    });
    db.prepare("UPDATE memories SET shareable=1,scope='project' WHERE id=?").run(foreign.id);
    db.exec(
        `INSERT INTO workspaces(id,name,share_categories,created_at,updated_at) VALUES (919,'proof','["CONSTRAINTS"]',1,1)`,
    );
    db.prepare(
        "INSERT INTO workspace_members(workspace_id,project_path,display_name,display_path,added_at) VALUES(919,?,'Own','/own',1),(919,'git:joined-proof','Joined','/joined',1)",
    ).run(projectPath);
    const joined = pass(true);
    expect(joined.hard).toBe(false);
    expect(joined.m0).toBe(restoreDelta.m0);
    expect(joined.m1).toBe(restoreDelta.m1);
    // The database edit succeeds, but the next refresh must keep the served
    // bytes unchanged: the foreign id was never part of this session's prefix.
    expect(
        applyDashboardMemoryEdit(db, {
            projectPath: "git:joined-proof",
            operationId: "foreign-unseen",
            expectedRevisions: [{ memoryId: foreign.id, revision: 1 }],
            changes: [{ memoryId: foreign.id, content: "Unseen joined correction." }],
        }).state,
    ).toBe("applied");
    expect(pass(true)).toEqual(joined);
    db.prepare("UPDATE memories SET shareable=1,scope='project' WHERE id=?").run(foreign.id);
    const joinedHard = pass(true, true);
    expect(joinedHard.m0).toContain("Unseen joined correction.");
    db.exec("DELETE FROM workspace_members WHERE project_path='git:joined-proof'");
    const removed = pass(true);
    expect(removed.hard).toBe(false);
    expect(removed.m0).toBe(joinedHard.m0);
    expect(removed.m1).toBe(joinedHard.m1);
    expect(pass(false)).toEqual(removed);
    expect(pass(true, true).m0).not.toContain("Unseen joined correction.");
}

/** An opt-in, assertion-free witness for comparing the base and new renderers. */
function dashboardTrace(
    db: Database,
    projectPath: string,
    sessionId: string,
    pass: (bust: boolean, hard?: boolean) => DashboardProofPass,
): void {
    const originalNow = Date.now;
    Date.now = () => 1780000000000;
    try {
        const dashboard = insertMemory(db, {
            projectPath,
            category: "CONSTRAINTS",
            content: "Dashboard baseline.",
        });
        const agent = insertMemory(db, {
            projectPath,
            category: "CONSTRAINTS",
            content: "Agent baseline.",
        });
        const records: unknown[] = [{ step: -1, ...pass(true) }];
        let rng = 0x49b13cd;
        for (let step = 0; step < 240; step++) {
            rng ^= rng << 13;
            rng ^= rng >>> 17;
            rng ^= rng << 5;
            const kind = (rng >>> 0) % 3;
            const target = kind === 0 ? dashboard : agent;
            const revision = (
                db.prepare("SELECT revision FROM memories WHERE id=?").get(target.id) as {
                    revision: number;
                }
            ).revision;
            if (kind === 0)
                applyDashboardMemoryEdit(db, {
                    projectPath,
                    operationId: `trace:${step}`,
                    expectedRevisions: [{ memoryId: target.id, revision }],
                    changes: [{ memoryId: target.id, content: `Dashboard correction ${step}.` }],
                });
            else if (kind === 1)
                applyAgentMemoryMutation(db, {
                    key: `trace:${step}`,
                    projectPath,
                    sourceSessionId: sessionId,
                    operation: "update",
                    targets: [{ id: target.id, revision }],
                    content: `Agent correction ${step}.`,
                });
            const natural = step % 19 === 18;
            const bust = natural || (rng >>> 8) % 3 === 0;
            records.push({ step, kind, bust, natural, ...pass(bust, natural) });
        }
        writeFileSync(
            `${process.env.MC_DASHBOARD_TRACE}-${sessionId}.json`,
            JSON.stringify(records),
        );
        console.log(`dashboard renderer trace ${sessionId}: ${records.length} requests`);
    } finally {
        Date.now = originalNow;
    }
}
