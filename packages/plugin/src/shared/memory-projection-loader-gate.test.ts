import { expect, test } from "bun:test";
import { loadDashboardFragmentsAfter } from "../features/magic-context/memory/agent-fragments";
import { createProjectionFixture, MEMORY_LOADER_BLOCKED } from "./memory-projection-fixtures.test";

test("memory loader gate permits only scoped dashboard payloads on SOFT", () => {
    const f = createProjectionFixture("dashboard-read-gate");
    try {
        f.gate.blocking = true;
        f.gate.allowDashboardPayloads = true;
        expect(loadDashboardFragmentsAfter(f.db, f.projectPath, 0, [], 0)).toEqual([]);
        f.gate.allowDashboardPayloads = false;
        expect(() => loadDashboardFragmentsAfter(f.db, f.projectPath, 0, [], 0)).toThrow(
            MEMORY_LOADER_BLOCKED,
        );
        f.gate.allowDashboardPayloads = true;
        for (const sql of [
            "SELECT content FROM memories",
            "SELECT MAX(id) FROM memory_mutation_log",
            "SELECT new_content FROM memory_mutation_log WHERE operation_id LIKE 'dashboard:%' OR 1=1",
            "SELECT (SELECT content FROM memories LIMIT 1) FROM memory_mutation_log WHERE operation_id LIKE 'dashboard:%'",
        ]) {
            expect(() => f.db.prepare(sql).all()).toThrow(MEMORY_LOADER_BLOCKED);
        }
        expect(f.gate.blocked).toHaveLength(5);
    } finally {
        f.close();
    }
});
