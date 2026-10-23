import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rejectSessionMetaCollectionWrites } from "../../features/magic-context/__tests__/session-meta-faults";
import {
    editCachedUpgradeFixture,
    patchSessionMeta,
    sessionMetaFixtureRow,
} from "../../features/magic-context/__tests__/session-meta-fixture";
import { applyMemoryAdmission } from "../../features/magic-context/memory/lifecycle-applier";
import {
    archiveMemory,
    insertMemory,
    supersededMemory,
} from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta, queueMemoryMutation } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { encodeCachedM0UpgradeIdentity, withCachedM0MemoryIds } from "./compartment-render-epoch";
import {
    injectM0M1,
    materializeM0,
    mustMaterialize,
    renderMemoryBlockV2,
} from "./inject-compartments";
import { estimateTokens } from "./read-session-formatting";

function fixture() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-visible-manifest-"));
    const db = new Database(join(dir, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "visible-manifest";
    const projectPath = "git:visible-manifest";
    const options = { db, sessionId, projectPath, projectDirectory: dir, injectDocs: false };
    const row = () => sessionMetaFixtureRow(db, sessionId);
    const manifest = () => {
        const value = row() as { memory_block_ids: string; memory_block_count: number };
        return {
            ids: JSON.parse(value.memory_block_ids) as number[],
            count: value.memory_block_count,
        };
    };
    const serve = (refresh = false) =>
        injectM0M1({
            ...options,
            state: getOrCreateSessionMeta(db, sessionId),
            isCacheBustingPass: refresh,
        });
    return {
        db,
        options,
        row,
        manifest,
        serve,
        close: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

describe("OpenCode visible-memory manifest", () => {
    it("replays a previous-code snapshot without a HARD fold or byte change on the first upgraded pass", () => {
        const f = fixture();
        try {
            insertMemory(f.db, {
                projectPath: f.options.projectPath,
                category: "ARCHITECTURE",
                content: "legacy baseline",
            });
            f.serve();
            insertMemory(f.db, {
                projectPath: f.options.projectPath,
                category: "ARCHITECTURE",
                content: "legacy delta",
            });
            const before = f.serve(true);
            const markers = getOrCreateSessionMeta(f.db, f.options.sessionId);
            const legacyIdentity = encodeCachedM0UpgradeIdentity(
                "ready",
                "cre2",
                false,
                "m8000-h60000",
                "mre3",
                "m8000-h60000",
            );
            expect(markers.cachedM0UpgradeState).toBe(withCachedM0MemoryIds(legacyIdentity, [1]));
            patchSessionMeta(f.db, f.options.sessionId, {
                cached_m0_upgrade_state: legacyIdentity,
            });
            const row = f.row();
            expect(
                mustMaterialize({
                    ...f.options,
                    state: getOrCreateSessionMeta(f.db, f.options.sessionId),
                }).value,
            ).toBe(false);
            const upgraded = f.serve();
            expect(upgraded.m0RematerializedThisPass).toBe(false);
            expect(upgraded.preparedMessages).toEqual(before.preparedMessages);
            expect(f.row()).toEqual(row);
        } finally {
            f.close();
        }
    });

    it("ignores adding or changing only frozen ids for HARD decisions and stays SOFT after metadata adoption", () => {
        const f = fixture();
        try {
            const baseline = insertMemory(f.db, {
                projectPath: f.options.projectPath,
                category: "ARCHITECTURE",
                content: "unchanged baseline",
            });
            const before = f.serve();
            const legacyIdentity = encodeCachedM0UpgradeIdentity(
                "ready",
                "cre2",
                false,
                "m8000-h60000",
                "mre3",
                "m8000-h60000",
            );
            for (const identity of [
                legacyIdentity,
                withCachedM0MemoryIds(legacyIdentity, [baseline.id]),
                withCachedM0MemoryIds(legacyIdentity, []),
            ]) {
                patchSessionMeta(f.db, f.options.sessionId, { cached_m0_upgrade_state: identity });
                expect(
                    mustMaterialize({
                        ...f.options,
                        state: getOrCreateSessionMeta(f.db, f.options.sessionId),
                    }).value,
                ).toBe(false);
                const served = f.serve();
                expect(served.m0RematerializedThisPass).toBe(false);
                expect(served.preparedMessages).toEqual(before.preparedMessages);
            }
            patchSessionMeta(f.db, f.options.sessionId, {
                cached_m0_upgrade_state: legacyIdentity,
            });
            // A busting SOFT shows memory only through this session's agent
            // fragments, so the refreshed delta comes from an agent save.
            const delta = {
                id: applyMemoryAdmission(f.db, {
                    key: "metadata-adoption-save",
                    operation: "agent_save",
                    input: {
                        projectPath: f.options.projectPath,
                        category: "ARCHITECTURE",
                        content: "metadata adoption delta",
                        sourceSessionId: f.options.sessionId,
                        sourceType: "agent",
                    },
                }).memoryId!,
            };
            const refreshed = f.serve(true);
            expect(refreshed.m0RematerializedThisPass).toBe(false);
            expect(f.manifest()).toEqual({ ids: [baseline.id, delta.id], count: 2 });
            expect((f.row() as { cached_m0_upgrade_state: string }).cached_m0_upgrade_state).toBe(
                withCachedM0MemoryIds(legacyIdentity, [baseline.id]),
            );
            expect(
                mustMaterialize({
                    ...f.options,
                    state: getOrCreateSessionMeta(f.db, f.options.sessionId),
                }).value,
            ).toBe(false);
            const next = f.serve();
            expect(next.m0RematerializedThisPass).toBe(false);
            expect(next.preparedMessages).toEqual(refreshed.preparedMessages);
        } finally {
            f.close();
        }
    });

    // Busting SOFT passes no longer force successor rows into m[1]: another
    // writer's supersession or archive reaches this session at its next HARD fold.
    it("leaves another writer's supersession below the baseline watermark out of repeated refresh bytes", () => {
        const f = fixture();
        try {
            const original = insertMemory(f.db, {
                projectPath: f.options.projectPath,
                category: "ARCHITECTURE",
                content: "original A ".repeat(40),
                importance: 100,
            });
            const replacement = insertMemory(f.db, {
                projectPath: f.options.projectPath,
                category: "ARCHITECTURE",
                content: "replacement B ".repeat(40),
                importance: 1,
            });
            const options = {
                ...f.options,
                memoryInjectionBudgetTokens: estimateTokens(renderMemoryBlockV2([original])) + 2,
            };
            const fold = materializeM0({
                ...options,
                state: getOrCreateSessionMeta(f.db, options.sessionId),
            });
            expect(fold.renderedMemoryIds).toEqual([original.id]);
            expect(fold.snapshotMarkers.maxMemoryId).toBe(replacement.id);
            // Simulate a cached pair written before baseline selection metadata existed.
            editCachedUpgradeFixture(f.db, options.sessionId, (value) =>
                value === null
                    ? null
                    : value.slice(0, Math.max(0, value.indexOf("|m0-memory-ids:"))),
            );
            const state = getOrCreateSessionMeta(f.db, options.sessionId);
            supersededMemory(f.db, original.id, replacement.id);
            queueMemoryMutation(f.db, {
                projectPath: options.projectPath,
                mutationType: "superseded",
                targetMemoryId: original.id,
                supersededById: replacement.id,
            });
            const refresh = () =>
                injectM0M1({
                    ...options,
                    state,
                    isCacheBustingPass: true,
                });
            const first = refresh();
            expect(first.m0Bytes).toEqual(fold.m0Bytes);
            expect(first.m1Text).not.toContain(`#${replacement.id}:`);
            expect(first.m1Text).not.toContain(`id="${original.id}"`);
            expect(f.manifest()).toEqual({ ids: [original.id], count: 1 });
            const second = refresh();
            expect(second.m1Text).toBe(first.m1Text);
            expect(f.manifest()).toEqual({ ids: [original.id], count: 1 });
            archiveMemory(f.db, replacement.id);
            queueMemoryMutation(f.db, {
                projectPath: options.projectPath,
                mutationType: "archive",
                targetMemoryId: replacement.id,
            });
            const third = refresh();
            expect(third.m1Text).toBe(first.m1Text);
            expect(f.manifest()).toEqual({ ids: [original.id], count: 1 });
        } finally {
            f.close();
        }
    });

    it("rolls back refreshed bytes and their manifest together", () => {
        const f = fixture();
        try {
            f.serve();
            insertMemory(f.db, {
                projectPath: f.options.projectPath,
                category: "ARCHITECTURE",
                content: "new delta",
            });
            const before = f.row();
            rejectSessionMetaCollectionWrites(f.db, "memory_block_ids", "reject_manifest", {
                error: "manifest rejected",
            });
            expect(() => f.serve(true)).toThrow("manifest rejected");
            expect(f.row()).toEqual(before);
        } finally {
            f.close();
        }
    });

    it("keeps fold, refresh and defer prompt bytes identical to the pre-manifest baseline", () => {
        const f = fixture();
        try {
            insertMemory(f.db, {
                projectPath: f.options.projectPath,
                category: "ARCHITECTURE",
                content: "baseline memory",
            });
            const hash = (value: unknown) =>
                createHash("sha256").update(JSON.stringify(value)).digest("hex");
            const capture = (refresh = false) => {
                const served = f.serve(refresh);
                const meta = getOrCreateSessionMeta(f.db, f.options.sessionId);
                if (!meta.cachedM0Bytes || !meta.cachedM1Bytes || !served.preparedMessages) {
                    throw new Error("expected persisted bytes and a served prefix");
                }
                return hash({
                    m0: meta.cachedM0Bytes.toString("utf8"),
                    m1: meta.cachedM1Bytes.toString("utf8"),
                    prefix: served.preparedMessages.map((message) => message.parts),
                });
            };
            const fold = capture();
            insertMemory(f.db, {
                projectPath: f.options.projectPath,
                category: "ARCHITECTURE",
                content: "incremental memory",
            });
            const refresh = capture(true);
            const before = f.row();
            insertMemory(f.db, {
                projectPath: f.options.projectPath,
                category: "ARCHITECTURE",
                content: "not served during defer",
            });
            const defer = capture();
            // The fold hash was captured from the unmodified renderer before the
            // manifest fix, so HARD bytes are unchanged. A busting SOFT no longer
            // admits other writers' new memories, so the refresh and the defer after it
            // serve the fold's bytes.
            expect({ fold, refresh, defer }).toEqual({
                fold: "259a053d3215cdb0d32792144c2bab8c581075a047176d55402405bff76bcac1",
                refresh: "259a053d3215cdb0d32792144c2bab8c581075a047176d55402405bff76bcac1",
                defer: "259a053d3215cdb0d32792144c2bab8c581075a047176d55402405bff76bcac1",
            });
            expect(defer).toBe(refresh);
            expect(f.row()).toEqual(before);
        } finally {
            f.close();
        }
    });
});
