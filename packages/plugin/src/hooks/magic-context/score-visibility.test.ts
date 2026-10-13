import { afterEach, expect, test } from "bun:test";
import { RescoreService } from "../../features/magic-context/rescore-service";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { compartmentScoreStatusRows } from "../../shared/score-visibility";
import { Database } from "../../shared/sqlite";
import { readCompartmentScoreVisibility } from "./score-visibility";

let db: Database | undefined;
afterEach(() => {
    db?.close();
    db = undefined;
});
test("score visibility separates base/effective/applied including pending undo without writes", () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    db.exec(
        "INSERT INTO session_projects VALUES ('session','opencode','git:rescore',1); INSERT INTO session_meta(session_id,harness) VALUES ('session','opencode'); INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,title,content,p1,p2,p3,p4,importance,episode_type,created_at,legacy) VALUES ('session','opencode',1,1,2,'title','','P1','P2','P3','P4',73,'feature',1,0)",
    );
    const service = new RescoreService({
        db,
        projectPath: "git:rescore",
        sessionId: "session",
        harness: "opencode",
        profile: { model: "mock/score", temperature: 0, maxOutputTokens: 1000 },
        admissionFailure: () => null,
    });
    const authority = service.confirm(service.preview().snapshotId);
    const admission = service.admit(authority)!;
    const handle = Object.keys(JSON.parse(admission.attempt.handle_map))[0];
    service.persistPayload(
        authority,
        admission.attempt.id,
        JSON.stringify([{ handle, importance: 10, reason: "recall" }]),
    );
    service.publish(authority, admission.attempt.id);
    const before = db.prepare("SELECT total_changes() AS n").get();
    const view = readCompartmentScoreVisibility(db, "session");
    expect(view.scores[0]).toMatchObject({ base: 73, effective: 10, applied: 73, pending: true });
    expect(compartmentScoreStatusRows(view)[0][1]).toBe(
        "base 73 · effective 10 · applied 73 — pending next natural rebuild",
    );
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    db.exec(
        "UPDATE session_meta SET cached_m0_score_selection_watermark=1 WHERE session_id='session'",
    );
    expect(readCompartmentScoreVisibility(db, "session").scores[0]).toMatchObject({
        base: 73,
        effective: 10,
        applied: 10,
        pending: false,
    });
    service.undoJob(authority.jobId, true);
    expect(readCompartmentScoreVisibility(db, "session").scores[0]).toMatchObject({
        base: 73,
        effective: 73,
        applied: 10,
        pending: true,
    });
    expect(readCompartmentScoreVisibility(db, "session", 2).scores[0]).toMatchObject({
        base: 73,
        effective: 73,
        applied: 73,
        pending: false,
    });
    expect(db.prepare("SELECT importance FROM compartments").get()).toEqual({ importance: 73 });
});
