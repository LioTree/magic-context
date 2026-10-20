import { expect, test } from "bun:test";
import { Database } from "../packages/plugin/src/shared/sqlite";
import { foregroundMeter, summarizeForeground } from "./context-db-foreground-meter";

test("foreground meter observes payload reads, outer writer hold and nested savepoints", () => {
    const db = new Database(":memory:");
    db.exec(
        "CREATE TABLE session_meta(session_id TEXT PRIMARY KEY, trailing_blank_decisions TEXT)",
    );
    const meter = foregroundMeter(db);
    const insert = db.prepare(
        "INSERT INTO session_meta(session_id,trailing_blank_decisions) VALUES (?,?)",
    );
    const select = db.prepare(
        "SELECT trailing_blank_decisions FROM session_meta WHERE session_id=?",
    );
    meter.start(1);
    const timer = meter.handlerStart();
    db.transaction(() => {
        db.transaction(() => insert.run("one", "x".repeat(100_000))).immediate();
        expect(select.get("one")).toEqual({ trailing_blank_decisions: "x".repeat(100_000) });
        const start = performance.now();
        while (performance.now() - start < 20) {}
    }).immediate();
    select.get("one");
    expect(db.prepare("WITH source AS (SELECT 1 AS value) SELECT value FROM source").get()).toEqual(
        { value: 1 },
    );
    meter.handlerEnd(timer);
    meter.stop();
    const record = meter.records[0];
    expect(record.timing.payloadRead.calls).toBe(2);
    expect(record.timing.payloadRead.cpuMs).toBeGreaterThanOrEqual(0);
    expect(record.timing.payloadRead.wallMs).toBeGreaterThan(0);
    expect(record.transactions).toHaveLength(1);
    expect(record.transactions[0].holdMs).toBeGreaterThanOrEqual(20);
    expect(record.transactions[0].payloads).toEqual(["trailing_blank_decisions"]);
    expect(record.transactions[0].writes).toBe(1);
    expect(record.autocommit).toEqual([]);
    expect(record.totalCpuMs).toBeGreaterThan(0);
    expect(summarizeForeground(meter).payloadWriteTransactions.median).toBe(1);
    db.close();
});
