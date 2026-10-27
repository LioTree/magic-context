/// <reference types="bun-types" />

/**
 * Regression tests for the rewind leak: a host that keeps abandoned branch
 * entries (Pi and OMP keep every entry in the session JSONL) leaves their
 * raw-message index rows in `context.db`, and those rows stayed searchable after
 * a `/tree` jump. `excludedMessageIds` is the lane's deny-list.
 *
 * A deny-list rather than an allow-list is the whole point: compaction moves a
 * message off the live branch while keeping it searchable on purpose, so scoping
 * the lane to "ids on the current branch" would hide the archive it exists for.
 * `pi-abandoned-message-ids.test.ts` covers how Pi derives this set from its
 * session entries.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { appendCompartments } from "./compartment-storage";
import { ensureMessagesIndexed } from "./message-index";
import { runMigrations } from "./migrations";
import {
    createUnifiedSearchDiagnostics,
    searchMessageHistory,
    type UnifiedSearchOptions,
    unifiedSearch,
} from "./search";
import { initializeDatabase } from "./storage-db";

const rawMessagesBySession = new Map<
    string,
    Array<{
        ordinal: number;
        id: string;
        role: string;
        parts: unknown[];
        createdAt?: number;
    }>
>();
const readMessages = (sessionId: string) => rawMessagesBySession.get(sessionId) ?? [];

const QUERY = "quokka telemetry";

/** Both messages mention the query term; `rewound` is the one a rewind abandoned. */
function seedTwoBranchMessages(db: Database, sessionId: string): void {
    rawMessagesBySession.set(sessionId, [
        {
            ordinal: 1,
            id: "kept",
            role: "assistant",
            parts: [{ type: "text", text: "quokka telemetry lives in collector.ts" }],
        },
        {
            ordinal: 2,
            id: "rewound",
            role: "assistant",
            parts: [{ type: "text", text: "quokka telemetry was moved to legacy.ts" }],
        },
    ]);
    ensureMessagesIndexed(db, sessionId, readMessages);
}

/**
 * A published compartment raises the ordinal cutoff above both messages, which is
 * what makes the stale row reachable: before any compartment exists the cutoff is
 * 0 and nothing in the tail is searchable (issue #131).
 */
function publishBoundary(db: Database, sessionId: string): void {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "kept",
            endMessageId: "rewound",
            title: "telemetry placement",
            content: "P1 content",
            p1: "P1 content",
        },
    ]);
}

function options(overrides: Partial<UnifiedSearchOptions> = {}): UnifiedSearchOptions {
    return {
        sources: ["message"],
        limit: 10,
        embeddingEnabled: false,
        explicitSearch: true,
        isEmbeddingRuntimeEnabled: () => false,
        countRetrievals: false,
        measurementDisabled: true,
        ...overrides,
    };
}

function messageIds(results: Awaited<ReturnType<typeof unifiedSearch>>): string[] {
    return results
        .filter((result) => result.source === "message")
        .map((result) => (result as { messageId: string }).messageId)
        .sort();
}

describe("unifiedSearch message lane rewind exclusion", () => {
    let db: Database;

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
    });

    afterEach(() => {
        rawMessagesBySession.clear();
        closeQuietly(db);
    });

    it("returns the rewound message when the caller excludes nothing", async () => {
        // The baseline the fix changes: an unfiltered lane still surfaces the
        // rewound row, so the other tests fail for the right reason.
        seedTwoBranchMessages(db, "ses-scope");
        publishBoundary(db, "ses-scope");

        const results = await unifiedSearch(db, "ses-scope", "git:test", QUERY, options());

        expect(messageIds(results)).toEqual(["kept", "rewound"]);
    });

    it("drops the rewound hit and reports it in diagnostics", async () => {
        seedTwoBranchMessages(db, "ses-scope");
        publishBoundary(db, "ses-scope");
        const diagnostics = createUnifiedSearchDiagnostics();

        const results = await unifiedSearch(
            db,
            "ses-scope",
            "git:test",
            QUERY,
            options({ excludedMessageIds: new Set(["rewound"]), diagnostics }),
        );

        expect(messageIds(results)).toEqual(["kept"]);
        expect(diagnostics.suppressedRewoundMessageMatches).toBe(1);
        // Live-tail suppression is a different reason with a different fix.
        expect(diagnostics.suppressedLiveMessageMatches).toBe(0);
    });

    it("keeps the live hit when the rewound row would rank better", async () => {
        // Give the abandoned row a denser term match so an unfiltered ordering
        // would put it first; exclusion must promote the kept row without needing
        // it to outrank anything.
        rawMessagesBySession.set("ses-rank", [
            {
                ordinal: 1,
                id: "kept",
                role: "assistant",
                parts: [{ type: "text", text: "quokka telemetry" }],
            },
            {
                ordinal: 2,
                id: "rewound",
                role: "assistant",
                parts: [
                    { type: "text", text: "quokka telemetry quokka telemetry quokka telemetry" },
                ],
            },
        ]);
        ensureMessagesIndexed(db, "ses-rank", readMessages);
        publishBoundary(db, "ses-rank");

        const results = await unifiedSearch(
            db,
            "ses-rank",
            "git:test",
            QUERY,
            options({ excludedMessageIds: new Set(["rewound"]) }),
        );

        expect(messageIds(results)).toEqual(["kept"]);
        expect(results[0]?.source).toBe("message");
    });

    it("applies the exclusion to the probe lists of a multi-probe search", async () => {
        // Explicit searches add literal probes and fuse their rankings; a stale row
        // reachable only through a probe must be dropped like one reached by the
        // full query. Driving `searchMessageHistory` directly pins the lane instead
        // of depending on which probes a query happens to yield.
        rawMessagesBySession.set("ses-probe", [
            {
                ordinal: 1,
                id: "kept",
                role: "assistant",
                parts: [{ type: "text", text: "quokka telemetry notes" }],
            },
            {
                ordinal: 2,
                id: "rewound",
                role: "assistant",
                parts: [{ type: "text", text: "legacy_telemetry_writer is the old path" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-probe", readMessages);
        publishBoundary(db, "ses-probe");
        const request = {
            sessionId: "ses-probe",
            query: "quokka telemetry",
            limit: 10,
            probes: ["legacy_telemetry_writer"],
            relaxedRecall: true,
            collectDiagnostics: true,
            dateRange: null,
        } as const;

        const unfiltered = searchMessageHistory(db, request);
        // The baseline: without an exclusion the probe list reaches the stale row.
        expect(unfiltered.results.map((result) => result.messageId).sort()).toEqual([
            "kept",
            "rewound",
        ]);

        const filtered = searchMessageHistory(db, {
            ...request,
            excludedMessageIds: new Set(["rewound"]),
        });

        expect(filtered.results.map((result) => result.messageId)).toEqual(["kept"]);
        expect(filtered.suppressedRewoundMessageMatches).toBe(1);
    });

    it("filters the date-bounded statement too", async () => {
        // Date bounds select a different prepared statement; both carry the
        // cutoff, so both must carry the exclusion.
        const stamp = Date.UTC(2026, 0, 2);
        rawMessagesBySession.set("ses-dated", [
            {
                ordinal: 1,
                id: "kept",
                role: "assistant",
                parts: [{ type: "text", text: "quokka telemetry lives in collector.ts" }],
                createdAt: stamp,
            },
            {
                ordinal: 2,
                id: "rewound",
                role: "assistant",
                parts: [{ type: "text", text: "quokka telemetry was moved to legacy.ts" }],
                createdAt: stamp,
            },
        ]);
        ensureMessagesIndexed(db, "ses-dated", readMessages);
        publishBoundary(db, "ses-dated");

        const results = await unifiedSearch(
            db,
            "ses-dated",
            "git:test",
            QUERY,
            options({
                excludedMessageIds: new Set(["rewound"]),
                from: Date.UTC(2000, 0, 1),
                to: Date.UTC(2100, 0, 1),
            }),
        );

        expect(messageIds(results)).toEqual(["kept"]);
    });

    it("returns nothing but reports the suppression when every hit was rewound", async () => {
        seedTwoBranchMessages(db, "ses-empty");
        publishBoundary(db, "ses-empty");
        const diagnostics = createUnifiedSearchDiagnostics();

        const results = await unifiedSearch(
            db,
            "ses-empty",
            "git:test",
            QUERY,
            options({ excludedMessageIds: new Set(["kept", "rewound"]), diagnostics }),
        );

        expect(messageIds(results)).toEqual([]);
        expect(diagnostics.suppressedRewoundMessageMatches).toBe(2);
    });

    it("leaves the lane unfiltered for a null exclusion", async () => {
        // OpenCode deletes abandoned records, so its callers pass null and must
        // keep the previous cost and behaviour exactly.
        seedTwoBranchMessages(db, "ses-null");
        publishBoundary(db, "ses-null");
        const diagnostics = createUnifiedSearchDiagnostics();

        const results = await unifiedSearch(
            db,
            "ses-null",
            "git:test",
            QUERY,
            options({ excludedMessageIds: null, diagnostics }),
        );

        expect(messageIds(results)).toEqual(["kept", "rewound"]);
        expect(diagnostics.suppressedRewoundMessageMatches).toBe(0);
    });

    it("keeps compacted-away messages searchable when only abandoned ids are excluded", async () => {
        // The archive case that made an allow-list wrong: three messages, all
        // compacted (off the live branch), none rewound. Excluding the empty
        // abandoned set must still return all three.
        rawMessagesBySession.set("ses-archive", [
            {
                ordinal: 1,
                id: "old-1",
                role: "user",
                parts: [{ type: "text", text: "quokka telemetry question" }],
            },
            {
                ordinal: 2,
                id: "old-2",
                role: "assistant",
                parts: [{ type: "text", text: "quokka telemetry answer" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-archive", readMessages);
        publishBoundary(db, "ses-archive");

        const results = await unifiedSearch(
            db,
            "ses-archive",
            "git:test",
            QUERY,
            options({ excludedMessageIds: new Set() }),
        );

        expect(messageIds(results)).toEqual(["old-1", "old-2"]);
    });
});
