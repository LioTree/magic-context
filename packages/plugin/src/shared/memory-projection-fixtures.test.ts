import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    applyAgentMemoryMutation,
    applyMemoryAdmission,
    getMemoryRevision,
    recordAutomatedMemoryEdit,
} from "../features/magic-context/memory/lifecycle-applier";
import { computeNormalizedHash } from "../features/magic-context/memory/normalize-hash";
import {
    getMemoryById,
    insertMemory,
    updateMemoryContent,
} from "../features/magic-context/memory/storage-memory";
import { runMigrations } from "../features/magic-context/migrations";
import { getOrCreateSessionMeta, queueMemoryMutation } from "../features/magic-context/storage";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { bumpProjectMemoryEpoch } from "../features/magic-context/storage-project-state";
import { getVisibleMemoryIds } from "../hooks/magic-context/inject-compartments";
import { Database } from "./sqlite";
import { createTestTempDirFromPath } from "./test-temp-dir";

/**
 * Shared regressions for the memory projection of one session's prompt. OpenCode
 * and Pi register them with their own drivers, so both renderers are held to the
 * same contract:
 *   - a HARD fold is the only pass that reads memory rows or the mutation log;
 *   - a busting SOFT pass replays the fold's memory bytes and appends only this
 *     session's own agent fragments; a defer pass replays stored bytes;
 *   - automated writers and other sessions reach the prompt at its next HARD fold.
 */

/** Thrown when a gated pass tries to load memory rows or mutation-log rows. */
export const MEMORY_LOADER_BLOCKED = "memory loader called on a gated pass";

/**
 * Whether a statement loads rows of memories or of the mutation log. A read whose
 * SELECT only aggregates (a MAX id watermark, a COUNT) is a marker probe, not a load.
 */
function loadsMemoryRows(sql: string): boolean {
    for (const match of sql.matchAll(/\bFROM\s+(?:memories|memory_mutation_log)\b/gi)) {
        const head = sql.slice(0, match.index);
        const projection = head.slice(head.toUpperCase().lastIndexOf("SELECT"));
        if (!/^SELECT\s+(?:COALESCE\s*\(\s*)?(?:MAX|MIN|COUNT)\s*\(/i.test(projection)) return true;
    }
    return false;
}

export interface ProjectionFixture {
    db: Database;
    directory: string;
    projectPath: string;
    /** Two sessions of the same project. */
    sessions: readonly [string, string];
    /** While `blocking` is true, any memory-row or mutation-log load throws. */
    gate: { blocking: boolean; blocked: string[] };
    close: () => void;
}

/**
 * Every statement that loads memory or mutation-log rows is wrapped when it is
 * prepared, so statements a module caches per database are covered too. The
 * wrapper is installed before any memory code runs on this connection.
 */
function installLoaderGate(db: Database, gate: ProjectionFixture["gate"]): void {
    const prepare = db.prepare.bind(db);
    Object.defineProperty(db, "prepare", {
        configurable: true,
        writable: true,
        value: (sql: string) => {
            const statement = prepare(sql);
            if (!loadsMemoryRows(sql)) return statement;
            for (const method of ["all", "get", "iterate", "values"] as const) {
                const original = (statement as unknown as Record<string, unknown>)[method];
                if (typeof original !== "function") continue;
                const bound = (original as (...args: unknown[]) => unknown).bind(statement);
                Object.defineProperty(statement, method, {
                    configurable: true,
                    value: (...args: unknown[]) => {
                        if (gate.blocking) {
                            gate.blocked.push(sql);
                            throw new Error(`${MEMORY_LOADER_BLOCKED}: ${sql}`);
                        }
                        return bound(...args);
                    },
                });
            }
            return statement;
        },
    });
}

export function createProjectionFixture(
    label: string,
    open?: (path: string) => Database,
): ProjectionFixture {
    const directory = createTestTempDirFromPath(join(tmpdir(), `mc-memory-projection-${label}-`));
    const path = join(directory, "context.db");
    const db = open ? open(path) : new Database(path);
    if (!open) {
        initializeDatabase(db);
        runMigrations(db);
    }
    const gate = { blocking: false, blocked: [] as string[] };
    installLoaderGate(db, gate);
    const sessions = [`${label}-a`, `${label}-b`] as const;
    for (const session of sessions) getOrCreateSessionMeta(db, session);
    return {
        db,
        directory,
        projectPath: "git:memory-projection",
        sessions,
        gate,
        close: () => {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

export interface ProjectionOptions {
    memoryBudget?: number;
    historyBudget?: number;
    /** Report the provider cache TTL as expired: a genuine HARD trigger. */
    cacheExpired?: boolean;
}

export interface ServedPair {
    m0: string;
    m1: string;
    /** Whether this pass folded a new m[0]. */
    materialized: boolean;
}

export interface ProjectionDriver {
    host: string;
    open?: (path: string) => Database;
    /** A forced HARD fold for one session (the first render, or a test-forced rebuild). */
    hard: (f: ProjectionFixture, sessionId: string, options?: ProjectionOptions) => void;
    /** One transform pass: busting (a SOFT unless a HARD trigger fires) or a defer. */
    pass: (
        f: ProjectionFixture,
        sessionId: string,
        busting: boolean,
        options?: ProjectionOptions,
    ) => ServedPair;
}

function memory(f: ProjectionFixture, content: string, importance = 50) {
    return insertMemory(f.db, {
        projectPath: f.projectPath,
        category: "ARCHITECTURE",
        content,
        importance,
    });
}

function agentSave(f: ProjectionFixture, sessionId: string, content: string): number {
    const receipt = applyMemoryAdmission(f.db, {
        key: `save:${sessionId}:${content}`,
        operation: "agent_save",
        input: {
            projectPath: f.projectPath,
            category: "ARCHITECTURE",
            content,
            sourceSessionId: sessionId,
            sourceType: "agent",
        },
    });
    expect(receipt.state).toBe("applied");
    return receipt.memoryId!;
}

function agentUpdate(f: ProjectionFixture, sessionId: string, id: number, content: string): void {
    const receipt = applyAgentMemoryMutation(f.db, {
        key: `update:${sessionId}:${id}:${content.length}:${content.slice(0, 24)}`,
        projectPath: f.projectPath,
        sourceSessionId: sessionId,
        operation: "update",
        targets: [{ id, revision: getMemoryRevision(f.db, id)! }],
        content,
    });
    expect(receipt.state).toBe("applied");
}

/** A gated automated content correction (dreamer verify): row and history, no log row. */
function automatedEdit(f: ProjectionFixture, id: number, content: string): void {
    const before = getMemoryById(f.db, id)!;
    updateMemoryContent(f.db, id, content, computeNormalizedHash(content));
    recordAutomatedMemoryEdit(f.db, { writer: "verify", before, reason: "verify_update" });
}

/** Run `body` with every memory-row and mutation-log load throwing. */
function gated<T>(f: ProjectionFixture, body: () => T): T {
    f.gate.blocking = true;
    try {
        return body();
    } finally {
        f.gate.blocking = false;
    }
}

export function registerMemoryProjectionRegressions(driver: ProjectionDriver): void {
    const create = (label: string) =>
        createProjectionFixture(`${driver.host}-${label}`, driver.open);

    // The acceptance gate: busting SOFT and defer passes never load memory rows or
    // the mutation log. The positive control proves the gate catches a HARD fold.
    test(`${driver.host} SOFT and defer passes load no memory rows and no mutation log`, () => {
        const f = create("gate");
        try {
            const [a] = f.sessions;
            const baseline = memory(f, "Baseline memory served by the HARD fold.");
            driver.hard(f, a);
            const saved = agentSave(f, a, "Agent save shown on the next busting pass.");
            const elsewhere = memory(f, "Another writer's memory waits for HARD.");
            queueMemoryMutation(f.db, {
                projectPath: f.projectPath,
                mutationType: "archive",
                targetMemoryId: baseline.id,
            });
            const soft = gated(f, () => driver.pass(f, a, true));
            expect(soft.materialized).toBe(false);
            expect(soft.m1).toContain(
                `<added id="${saved}" category="ARCHITECTURE">Agent save shown on the next busting pass.</added>`,
            );
            expect(soft.m1).not.toContain(`id="${elsewhere.id}"`);
            expect(soft.m1).not.toContain(`<removed id="${baseline.id}"/>`);
            const defer = gated(f, () => driver.pass(f, a, false));
            expect(defer).toEqual({ ...soft, materialized: false });
            expect(f.gate.blocked).toEqual([]);
            // Positive control: the same gate stops a HARD fold, which must read rows.
            expect(() => gated(f, () => driver.hard(f, a))).toThrow(MEMORY_LOADER_BLOCKED);
            expect(f.gate.blocked.length).toBeGreaterThan(0);
        } finally {
            f.close();
        }
    });

    // Memories are project-wide but prompts are per session: one session's HARD
    // fold and agent edits never change another session's SOFT or defer bytes.
    test(`${driver.host} one session's HARD fold and agent edit leave another session's SOFT bytes unchanged`, () => {
        const f = create("two-session");
        try {
            const [a, b] = f.sessions;
            const shared = memory(f, "Shared rule, revision one.");
            const other = memory(f, "Another shared rule.");
            driver.hard(f, a);
            driver.hard(f, b);
            const bBefore = driver.pass(f, b, false);
            automatedEdit(f, shared.id, "Shared rule, revision two from verify.");
            agentUpdate(f, a, other.id, "Another shared rule, edited by session A.");
            driver.hard(f, a);
            const aAfter = driver.pass(f, a, false);
            expect(aAfter.m0).toContain("Shared rule, revision two from verify.");
            const bSoft = driver.pass(f, b, true);
            expect(bSoft.materialized).toBe(false);
            expect(bSoft.m0).toBe(bBefore.m0);
            expect(bSoft.m1).toBe(bBefore.m1);
            expect(bSoft.m1).not.toContain("edited by session A");
            expect(driver.pass(f, b, false)).toEqual(bSoft);
        } finally {
            f.close();
        }
    });

    // Agent fragments render inside their allowance. A fragment that does not fit
    // appends a short stale marker; fragments already shown never move or shrink,
    // so an over-allowance edit cannot revert an adopted correction.
    test(`${driver.host} an over-allowance agent edit appends a stale marker and keeps the shown correction`, () => {
        const f = create("overflow");
        try {
            const [a] = f.sessions;
            const target = memory(f, "TTL is five minutes.");
            const options = { memoryBudget: 400 };
            driver.hard(f, a, options);
            agentUpdate(f, a, target.id, "TTL is ten minutes.");
            const first = driver.pass(f, a, true, options);
            const shown = `<updated id="${target.id}" category="ARCHITECTURE">TTL is ten minutes.</updated>`;
            expect(first.m1).toContain(shown);
            agentUpdate(f, a, target.id, `TTL is fifteen minutes. ${"Long detail. ".repeat(200)}`);
            const second = driver.pass(f, a, true, options);
            expect(second.materialized).toBe(false);
            expect(second.m0).toBe(first.m0);
            expect(second.m1).toContain(shown);
            expect(second.m1).toContain(
                `<stale-memory ids="${target.id}" current="${target.id}" read-with="ctx_search"/>`,
            );
            expect(second.m1).not.toContain("fifteen minutes");
            expect(second.m1.indexOf(shown)).toBe(first.m1.indexOf(shown));
            expect(driver.pass(f, a, false, options)).toEqual(second);
        } finally {
            f.close();
        }
    });

    // Automated writers apply directly to rows and stay out of the prompt until a
    // HARD fold that would have happened anyway; a genuine trigger still sees them.
    test(`${driver.host} a genuine HARD trigger shows automated memory changes held back on SOFT`, () => {
        const f = create("genuine-hard");
        try {
            const [a] = f.sessions;
            const target = memory(f, "Build uses tool version one.");
            driver.hard(f, a);
            automatedEdit(f, target.id, "Build uses tool version two.");
            const soft = driver.pass(f, a, true);
            expect(soft.materialized).toBe(false);
            expect(soft.m0).toContain("Build uses tool version one.");
            expect(`${soft.m0}${soft.m1}`).not.toContain("version two");
            const expired = driver.pass(f, a, true, { cacheExpired: true });
            expect(expired.materialized).toBe(true);
            expect(expired.m0).toContain("Build uses tool version two.");
        } finally {
            f.close();
        }
    });

    // B1 safety peer: an external content repair still bumps the project epoch
    // and still recuts the head; lifecycle writes cannot borrow that path.
    test(`${driver.host} external_repair_still_recuts`, () => {
        const f = create("external-repair");
        try {
            const [a] = f.sessions;
            const target = memory(f, "Repaired claim before repair.");
            driver.hard(f, a);
            updateMemoryContent(
                f.db,
                target.id,
                "Repaired claim after repair.",
                computeNormalizedHash("Repaired claim after repair."),
            );
            bumpProjectMemoryEpoch(f.db, f.projectPath);
            const repaired = driver.pass(f, a, true);
            expect(repaired.materialized).toBe(true);
            expect(repaired.m0).toContain("Repaired claim after repair.");
        } finally {
            f.close();
        }
    });

    // B2: neither a score, status or content change written without the agent
    // path, nor a higher-priority new row, moves an admitted SOFT prefix, also
    // after the in-process state is rebuilt from storage.
    test(`${driver.host} soft_keeps_admitted_membership_and_revisions`, () => {
        const f = create("soft-keeps");
        try {
            const [a] = f.sessions;
            const kept = memory(f, "Admitted memory keeps its served text.");
            const retired = memory(f, "Admitted memory another writer retires.");
            driver.hard(f, a);
            const before = driver.pass(f, a, false);
            f.db
                .prepare(
                    "UPDATE memories SET importance = 1, content = 'Rewritten without a log row.' WHERE id = ?",
                )
                .run(kept.id);
            f.db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(retired.id);
            memory(f, "A higher-priority newcomer.", 100);
            const soft = driver.pass(f, a, true);
            expect(soft.materialized).toBe(false);
            expect(soft.m0).toBe(before.m0);
            expect(soft.m1).toBe(before.m1);
            expect(driver.pass(f, a, false)).toEqual(soft);
        } finally {
            f.close();
        }
    });

    // B2: neither pending automated edits nor agent fragments past the allowance
    // can push m[1] over a refold bound; corrections never authorize a HARD fold.
    test(`${driver.host} pending_lifecycle_cannot_manufacture_pressure_hard`, () => {
        const f = create("pressure");
        try {
            const [a] = f.sessions;
            const targets = Array.from({ length: 50 }, (_, index) =>
                memory(f, `Pressure rule ${index}.`),
            );
            const options = { historyBudget: 2_000 };
            driver.hard(f, a, options);
            for (const target of targets) {
                automatedEdit(
                    f,
                    target.id,
                    `Pressure rule ${target.id}, corrected. ${"x ".repeat(40)}`,
                );
                agentUpdate(
                    f,
                    a,
                    target.id,
                    `Pressure rule ${target.id}, agent text. ${"y ".repeat(40)}`,
                );
            }
            const soft = driver.pass(f, a, true, options);
            expect(soft.materialized).toBe(false);
            expect(soft.m1).toContain("<stale-memory");
        } finally {
            f.close();
        }
    });

    // B4: search hides a memory only while its CURRENT text is visible in full.
    // An automated edit makes the frozen prompt's text stale, so search returns
    // the current text even though the head still shows revision one.
    test(`${driver.host} current_revision_search_survives_old_prompt_exclusion`, () => {
        const f = create("search");
        try {
            const [a] = f.sessions;
            const target = memory(f, "Searchable claim, revision one.");
            driver.hard(f, a);
            driver.pass(f, a, false);
            expect(getVisibleMemoryIds(f.db, a)?.has(target.id)).toBe(true);
            automatedEdit(f, target.id, "Searchable claim, revision two.");
            expect(getVisibleMemoryIds(f.db, a)?.has(target.id) ?? false).toBe(false);
            const served = driver.pass(f, a, true);
            expect(served.m0).toContain("Searchable claim, revision one.");
            // This session's own agent edit shows the current text, so it hides again.
            agentUpdate(f, a, target.id, "Searchable claim, revision three.");
            driver.pass(f, a, true);
            expect(getVisibleMemoryIds(f.db, a)?.has(target.id)).toBe(true);
        } finally {
            f.close();
        }
    });

    // Upgrade: a cached pair written before projections existed replays its own
    // memory bytes; the first busting pass invents no stale marker and adds only
    // fragments written after it.
    test(`${driver.host} a pre-projection cached pair replays its memory bytes and appends only new fragments`, () => {
        const f = create("legacy");
        try {
            const [a] = f.sessions;
            memory(f, "Legacy baseline memory.");
            driver.hard(f, a);
            const before = driver.pass(f, a, false);
            f.db.prepare("DELETE FROM memory_applied_snapshots").run();
            f.db.prepare("DELETE FROM memory_applied_rows").run();
            const soft = driver.pass(f, a, true);
            expect(soft.materialized).toBe(false);
            expect(soft).toEqual(before);
            const saved = agentSave(f, a, "Saved after the upgrade.");
            const next = driver.pass(f, a, true);
            expect(next.m0).toBe(before.m0);
            expect(next.m1).toContain(`<added id="${saved}"`);
            expect(next.m1).not.toContain("<stale-memory");
        } finally {
            f.close();
        }
    });
}
