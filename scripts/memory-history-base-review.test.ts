import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run each Git revision in a separate process so imports and prepared statements
// cannot accidentally make the candidate serve as its own reference implementation.
if (import.meta.main) {
    const [rootArg, host, output] = process.argv.slice(2);
    assert(rootArg && ["OC1", "OC2", "Pi"].includes(host!) && output);
    const root = resolve(rootArg);
    const load = (path: string) => import(join(root, path));
    const { Database } = await load("packages/plugin/src/shared/sqlite.ts");
    const { initializeDatabase } = await load(
        "packages/plugin/src/features/magic-context/storage-db.ts",
    );
    const { runMigrations } = await load(
        "packages/plugin/src/features/magic-context/migrations.ts",
    );
    const { getOrCreateSessionMeta } = await load(
        "packages/plugin/src/features/magic-context/storage.ts",
    );
    const { insertMemory } = await load(
        "packages/plugin/src/features/magic-context/memory/storage-memory.ts",
    );
    const { computeNormalizedHash } = await load(
        "packages/plugin/src/features/magic-context/memory/normalize-hash.ts",
    );
    const { bumpProjectMemoryEpoch } = await load(
        "packages/plugin/src/features/magic-context/storage-project-state.ts",
    );
    const lifecycle = await load(
        "packages/plugin/src/features/magic-context/memory/lifecycle-applier.ts",
    );
    const injector =
        host === "Pi"
            ? await load("packages/pi-plugin/src/inject-compartments-pi.ts")
            : await load("packages/plugin/src/hooks/magic-context/inject-compartments.ts");
    const history = await load(
        "packages/plugin/src/features/magic-context/memory/history-applier.ts",
    ).catch(() => null);
    const directory = mkdtempSync(join(tmpdir(), "history-base-review-"));
    const db = new Database(join(directory, "context.db"));
    const originalNow = Date.now;
    const now = 1_790_000_000_000;
    Date.now = () => now;
    const projectPath = "git:base-differential";
    const sessions = ["review-a", "review-b"];
    const records: unknown[] = [];
    let blocked = false;
    const attemptedReads: string[] = [];
    try {
        initializeDatabase(db);
        runMigrations(db);
        const schema = db
            .prepare(
                "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
            )
            .all();
        const schemaVersion = db
            .prepare("SELECT MAX(version) version FROM schema_migrations")
            .get();
        // Install before rendering, including before any module caches a statement.
        const prepare = db.prepare.bind(db);
        db.prepare = (sql: string) => {
            const statement = prepare(sql);
            if (
                /\b(?:FROM|JOIN)\s+(?:memories|memory_history|memory_journal|memory_decision_receipts|memory_mutation_log)\b/i.test(
                    sql,
                )
            ) {
                for (const method of ["all", "get", "iterate", "values"]) {
                    if (typeof statement[method] !== "function") continue;
                    const original = statement[method].bind(statement);
                    statement[method] = (...args: unknown[]) => {
                        if (blocked) {
                            attemptedReads.push(sql);
                            throw new Error(`unexpected non-rebuild read: ${sql}`);
                        }
                        return original(...args);
                    };
                }
            }
            return statement;
        };
        const ids = [
            "Agent target.",
            "Automated target.",
            "Dashboard target.",
            "Merge source one.",
            "Merge source two.",
        ].map((content) => insertMemory(db, { projectPath, category: "ARCHITECTURE", content }).id);
        const render = (sessionId: string, soft: boolean, cacheExpired: boolean) => {
            const hardSignals = {
                systemHash: "stable-system",
                modelKey: "anthropic/claude",
                cacheExpired,
                lastResponseTime: cacheExpired ? now + 60_000 : 1,
            };
            if (host === "Pi") {
                const messages: unknown[] = [];
                const result = injector.injectM0M1Pi(
                    {
                        sessionId,
                        projectIdentity: projectPath,
                        projectDirectory: "/review/project",
                        injectDocs: false,
                        injectionBudgetTokens: 8000,
                        historyBudgetTokens: 16000,
                        hardSignals,
                    },
                    db,
                    messages,
                    undefined,
                    soft,
                );
                return { materialized: result.m0Materialized, served: JSON.stringify(messages) };
            }
            // OC1 and OC2 normalize messages before this shared memory injector.
            const messages: unknown[] = [];
            const result = injector.injectM0M1({
                db,
                state: getOrCreateSessionMeta(db, sessionId),
                sessionId,
                projectPath,
                projectDirectory: "/review/project",
                injectDocs: false,
                memoryInjectionBudgetTokens: 8000,
                historyBudgetTokens: 16000,
                hardSignals,
                messages,
                isCacheBustingPass: soft,
            });
            return {
                materialized: result.m0RematerializedThisPass,
                served: JSON.stringify(messages),
                m0: result.m0Bytes?.toString("utf8"),
                m1: result.m1Text,
            };
        };
        for (const session of sessions)
            records.push({ step: "initial", session, ...render(session, true, true) });
        let rng = 0x68291cad;
        const next = () => {
            rng ^= rng << 13;
            rng ^= rng >>> 17;
            rng ^= rng << 5;
            return rng >>> 0;
        };
        const counts = { agent: 0, automatic: 0, dashboard: 0, soft: 0, defer: 0, hard: 0 };
        for (let step = 0; step < 120; step++) {
            const kind = next() % 3;
            const id = ids[kind]!;
            const current = db.prepare("SELECT revision,status FROM memories WHERE id=?").get(id);
            if (kind === 0 || kind === 1) {
                const receipt = (
                    kind === 0
                        ? lifecycle.applyAgentMemoryMutation
                        : lifecycle.applyCurateMemoryMutation
                )(db, {
                    key: `edit:${step}`,
                    projectPath,
                    sourceSessionId: kind === 0 ? sessions[next() % 2] : "",
                    operation: "update",
                    targets: [{ id, revision: current.revision }],
                    content: `Correction ${step} & <quoted> Σ.`,
                    reason: "source correction",
                });
                assert.equal(receipt.state, "applied");
                counts[kind === 0 ? "agent" : "automatic"]++;
            } else {
                const content = `External correction ${step}.`;
                const status = current.status === "permanent" ? "active" : "permanent";
                const change = step % 2 ? { memoryId: id, content } : { memoryId: id, status };
                if (history) {
                    const receipt = history.applyDashboardMemoryEdit(
                        db,
                        {
                            projectPath,
                            operationId: `dashboard:${step}`,
                            expectedRevisions: [{ memoryId: id, revision: current.revision }],
                            changes: [change],
                        },
                        now,
                    );
                    assert.equal(receipt.state, "applied");
                } else {
                    // These are the old dashboard's canonical SQL effects. Its
                    // content/status setters did not increment memory revisions.
                    if ("content" in change)
                        db.prepare(
                            "UPDATE memories SET content=?,normalized_hash=?,updated_at=? WHERE id=?",
                        ).run(content, computeNormalizedHash(content), now, id);
                    else db.prepare("UPDATE memories SET status=? WHERE id=?").run(status, id);
                    bumpProjectMemoryEpoch(db, projectPath, now);
                }
                counts.dashboard++;
            }
            for (const session of sessions) {
                // A dashboard edit increments the project change counter, making
                // the next pass rebuild its saved prompt from current memory rows.
                // Other edits must wait until the simulated provider cache expires.
                const cacheExpired = next() % 7 === 0;
                const soft = next() % 2 === 0;
                blocked = kind !== 2 && !cacheExpired;
                let result;
                try {
                    result = render(session, soft, cacheExpired);
                } finally {
                    blocked = false;
                }
                assert.equal(attemptedReads.length, 0);
                counts[result.materialized ? "hard" : soft ? "soft" : "defer"]++;
                records.push({ step, session, ...result });
            }
        }
        writeFileSync(
            output,
            JSON.stringify({ host, schemaVersion, schema, attemptedReads, counts, records }),
        );
        console.log(
            `${host}: ${records.length} serialized passes; counts=${JSON.stringify(counts)}; gated reads=${attemptedReads.length}`,
        );
    } finally {
        Date.now = originalNow;
        db.close();
        rmSync(directory, { recursive: true, force: true });
    }
}
