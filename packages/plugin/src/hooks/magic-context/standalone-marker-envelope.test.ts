import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import {
    getPersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { Database } from "../../shared/sqlite";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { measureLkgReplay } from "./lkg-fit-measure";
import {
    __setLkgMarkerReadingForTests,
    clearLkgMeasuredRequest,
    currentLkgRequestIdentity,
    noteCapturedLkgRequest,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import { boundMarkerEnvelope } from "./marker-envelope";
import { markerRandom, randomMarkerEnvelope } from "./marker-envelope-test-support";
import { estimateTokens } from "./read-session-formatting";
import {
    clearMarkerSystem,
    measureStandaloneMarker,
    recordMarkerSystem,
    standaloneMarkerIdentity,
} from "./standalone-marker-envelope";
import type { MessageLike } from "./transform-operations";
import {
    type CompactionMarkerStrategy,
    reconcileMarkerRepresentation,
    runRustModePostprocess,
} from "./transform-postprocess-phase";

afterEach(() => {
    __resetToolDefinitionMeasurements();
    clearMarkerSystem("marker-envelope-session");
    clearLkgMeasuredRequest("marker-envelope-session");
});

test("standalone marker needs a completed-request reading for the current envelope", () => {
    const args = {
        sessionId: "marker-envelope-session",
        model: "unknown/model",
        systemHash: "hash",
        messages: [{ info: { id: "m", role: "user" }, parts: [{ type: "text", text: "hello" }] }],
        limit: 10000,
    };
    expect(measureStandaloneMarker(args).fit).toBe("unproven");
    startRequest(args.sessionId, args.model, "first", ["Final system"]);
    expect(measureStandaloneMarker(args).fit).toBe("unproven");
    // Even complete-looking JSON definitions cannot prove the set: MCP tools never
    // reach the hook, so a reading is required.
    recordToolDefinition("unknown", "model", undefined, "read", "Read file", { type: "object" });
    expect(measureStandaloneMarker(args).fit).toBe("unproven");
    serveCurrent(args.sessionId, args.messages);
    expect(measureStandaloneMarker(args).fit).toBe("unproven");
    complete(args.sessionId, args.model, "first", 800);
    startRequest(args.sessionId, args.model, "second", ["Final system"]);
    expect(measureStandaloneMarker(args).fit).toBe("under");
    // The reading's usage is enforced: 800 input tokens leave no room in 700.
    expect(measureStandaloneMarker({ ...args, limit: 700 }).fit).toBe("over");
    expect(measureStandaloneMarker({ ...args, model: "different/model" }).fit).toBe("unproven");
    expect(measureStandaloneMarker({ ...args, systemHash: "different" }).fit).toBe("unproven");
});

describe("standalone fresh-reading rule", () => {
    const args = {
        sessionId: "marker-envelope-session",
        model: "unknown/model",
        systemHash: "hash",
        messages: [{ info: { id: "m", role: "user" }, parts: [{ type: "text", text: "hello" }] }],
        limit: 10000,
    };
    function qualified() {
        recordToolDefinition("unknown", "model", undefined, "read", "Read file", {
            type: "object",
        });
        startRequest(args.sessionId, args.model, "first", ["Final system"]);
        serveCurrent(args.sessionId, args.messages);
        complete(args.sessionId, args.model, "first", 800);
        startRequest(args.sessionId, args.model, "second", ["Final system"]);
        expect(measureStandaloneMarker(args).fit).toBe("under");
    }

    test("a change to the hook-visible tool-name set resets the reading", () => {
        qualified();
        recordToolDefinition("unknown", "model", undefined, "bash", "Run", { type: "object" });
        expect(measureStandaloneMarker(args).fit).toBe("unproven");
    });

    test("a change to the system strings resets the reading", () => {
        qualified();
        startRequest(args.sessionId, args.model, "third", ["Changed system"]);
        expect(measureStandaloneMarker(args).fit).toBe("unproven");
    });

    test("a newer captured request that has not completed keeps the last completed reading", () => {
        qualified();
        serveCurrent(args.sessionId, args.messages);
        expect(measureStandaloneMarker(args).fit).toBe("under");
        // Repeated updates of the reading's own response (finish, then completed) keep it.
        complete(args.sessionId, args.model, "first", 800);
        expect(measureStandaloneMarker(args).fit).toBe("under");
    });

    test("a later completion without a known served array clears the reading", () => {
        qualified();
        // The second request completes, but its returned array was never captured.
        complete(args.sessionId, args.model, "second", 900);
        startRequest(args.sessionId, args.model, "third", ["Final system"]);
        expect(measureStandaloneMarker(args).fit).toBe("unproven");
    });

    test("a later completion replaces the reading with its own usage", () => {
        qualified();
        serveCurrent(args.sessionId, args.messages);
        complete(args.sessionId, args.model, "second", 9900);
        startRequest(args.sessionId, args.model, "third", ["Final system"]);
        expect(measureStandaloneMarker(args).fit).toBe("over");
    });

    test("a failed completion is not a reading", () => {
        recordToolDefinition("unknown", "model", undefined, "read", "Read file", {
            type: "object",
        });
        startRequest(args.sessionId, args.model, "first", ["Final system"]);
        serveCurrent(args.sessionId, args.messages);
        complete(args.sessionId, args.model, "first", 800, { name: "APIError" });
        startRequest(args.sessionId, args.model, "second", ["Final system"]);
        expect(measureStandaloneMarker(args).fit).toBe("unproven");
    });
});

function startRequest(sessionId: string, model: string, responseId: string, system: string[]) {
    noteLkgProviderResponse({ sessionId, modelKey: model, responseId, inputTokens: 0 });
    recordMarkerSystem(sessionId, model, "hash", system);
}

/** The rust transform's capture of the array it returned for the current request. */
function serveCurrent(sessionId: string, messages: unknown[]) {
    const request = currentLkgRequestIdentity(sessionId);
    noteCapturedLkgRequest({
        sessionId,
        slot: {
            jsonPrefix: JSON.stringify(messages),
            inputIdSeq: [],
            inputContentDigests: [],
            lastInputMessageId: "m",
            modelKey: request?.modelKey ?? null,
            providerKey: null,
            capturedAt: Date.now(),
        },
        request,
        systemPromptTokens: 0,
        marker: standaloneMarkerIdentity(sessionId, request, undefined),
    });
}

function complete(
    sessionId: string,
    model: string,
    responseId: string,
    inputTokens: number,
    error?: unknown,
) {
    noteLkgProviderResponse({
        sessionId,
        modelKey: model,
        responseId,
        inputTokens,
        finish: "stop",
        completedAt: Date.now(),
        error,
    });
}

test("standalone randomized marker timing preserves full defer bytes and attributes inherited summary differences", () => {
    const next = markerRandom(0x5e12beef);
    const sessionId = "marker-envelope-session";
    const model = "unknown/model";
    const messages: MessageLike[] = [
        {
            info: { role: "user", sessionID: sessionId },
            parts: [
                {
                    type: "text",
                    text: "<session-history>Engine history stays unchanged.</session-history>",
                    synthetic: true,
                },
            ],
        },
        {
            info: { id: "raw-tail", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "Unchanged live tail." }],
        },
    ];
    let pass = 0;
    let bust = false;
    const branch = () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        getOrCreateSessionMeta(db, sessionId);
        const advances = new Map<number, number>();
        const tagger = createTagger();
        const strategy: CompactionMarkerStrategy = {
            // Replace only the host-store write with a deterministic isolated
            // receipt. Admission, pending targets and reconciliation are real.
            applyDeferred: (_db, _id, pending) => {
                const previous = getPersistedCompactionMarkerState(db, sessionId);
                if (previous && previous.boundaryOrdinal >= pending.ordinal)
                    return { kind: "already-current" };
                advances.set(pending.ordinal, pass);
                setPersistedCompactionMarkerState(db, sessionId, {
                    boundaryOrdinal: pending.ordinal,
                    boundaryMessageId: pending.endMessageId,
                    targetEndMessageId: pending.endMessageId,
                    summaryMessageId: `native-summary-${pending.ordinal}`,
                    summaryPartId: `native-text-${pending.ordinal}`,
                    compactionPartId: `native-part-${pending.ordinal}`,
                });
                return { kind: "applied", markerOrdinal: pending.ordinal };
            },
            reconcile: reconcileMarkerRepresentation,
        };
        let previous = JSON.stringify(messages);
        let frozen = 0;
        return {
            db,
            advances,
            get frozen() {
                return frozen;
            },
            serve(ordinal: number, admission: boolean) {
                const output = structuredClone(messages);
                const boundary = {
                    rowVersion: ordinal,
                    ordinal,
                    endMessageId: `covered-${ordinal}`,
                };
                runRustModePostprocess({
                    db,
                    sessionId,
                    messages: output,
                    materializedBoundary: bust ? boundary : undefined,
                    consumedBoundary: boundary,
                    cacheBustingPass: bust,
                    markerAdmissionProven: admission,
                    compactionMarkerStrategy: strategy,
                    fullFeatureMode: true,
                    tagger,
                    ctxReduceAvailability: { callable: false, frozen: true },
                });
                const bytes = JSON.stringify(output);
                if (!bust) {
                    expect(bytes, `full defer-pass identity at pass ${pass}`).toBe(previous);
                    frozen++;
                }
                previous = bytes;
                const summary = output.filter((message) => message.info.summary === true);
                const persisted = getPersistedCompactionMarkerState(db, sessionId);
                expect(summary).toEqual(
                    persisted
                        ? [
                              {
                                  info: {
                                      id: persisted.summaryMessageId,
                                      role: "assistant",
                                      sessionID: sessionId,
                                      summary: true,
                                      finish: "stop",
                                  },
                                  parts: [{ type: "text", text: MARKER_SUMMARY_TEXT }],
                              },
                          ]
                        : [],
                );
                // Full arrays above include the summary. This separate assertion
                // classifies any difference, rather than hiding summary bytes.
                expect(output.filter((message) => message.info.summary !== true)).toEqual(messages);
                return bytes;
            },
        };
    };
    const base = branch();
    const tightened = branch();
    const busts = new Set<number>();
    const origins: { pass: number; ordinal: number; inherited: number[] }[] = [];
    let activeOrigin: (typeof origins)[number] | undefined;
    let bustDifferences = 0;
    let changedDecisions = 0;
    try {
        for (let ordinal = 1; ordinal <= 50; ordinal++) {
            __resetToolDefinitionMeasurements();
            const material = randomMarkerEnvelope(next);
            const system = material.system.length ? [...material.system] : ["Final instructions"];
            const tools = material.tools.length
                ? material.tools
                : [{ name: "read", description: "Read file", inputSchema: { type: "object" } }];
            for (const tool of tools)
                recordToolDefinition(
                    "unknown",
                    "model",
                    undefined,
                    tool.name,
                    tool.description,
                    tool.inputSchema,
                );
            const oldEstimate = () =>
                estimateFinalWireInputTokens({
                    messages,
                    systemPromptTokens: Math.max(1, estimateTokens(system.join("\n"))),
                    toolDefinitionTokens: tools.reduce(
                        (sum, tool) =>
                            sum +
                            estimateTokens(tool.description) +
                            estimateTokens(JSON.stringify(tool.inputSchema)),
                        0,
                    ),
                    providerID: "unknown",
                    modelID: "model",
                    agentName: undefined,
                });
            const delay = 1 + Math.floor(next() * 3);
            const firstLimit =
                next() < 0.7 ? oldEstimate().tokens + Math.floor(next() * 20) : 1_000_000;
            for (let phase = 0; phase < delay + 3; phase++) {
                pass++;
                bust = phase === 0 || phase === delay + 1;
                if (bust) busts.add(pass);
                const limit = phase === 0 ? firstLimit : 1_000_000;
                noteLkgProviderResponse({
                    sessionId,
                    modelKey: model,
                    responseId: `random-${pass}`,
                    inputTokens: 0,
                });
                recordMarkerSystem(sessionId, model, `hash-${ordinal}`, system);
                // A completed earlier request with this envelope; its usage stands
                // in for the provider's count of the same system and tools.
                __setLkgMarkerReadingForTests(sessionId, {
                    responseId: `random-${pass}-completed`,
                    inputTokens: boundMarkerEnvelope({ system, tools }, model)!,
                    jsonPrefix: "[]",
                    marker: standaloneMarkerIdentity(
                        sessionId,
                        currentLkgRequestIdentity(sessionId),
                        undefined,
                    )!,
                });
                const legacy =
                    measureLkgReplay({ messages, limit, estimate: oldEstimate }).fit === "under";
                const admitted =
                    legacy &&
                    measureStandaloneMarker({
                        sessionId,
                        model,
                        systemHash: `hash-${ordinal}`,
                        messages,
                        limit,
                    }).fit === "under";
                if (bust && legacy !== admitted) {
                    expect(legacy).toBe(true);
                    expect(admitted).toBe(false);
                    changedDecisions++;
                }
                // Production defaults admission to true on SOFT+; the bust guard
                // itself, not this estimate, must prohibit draining a pending cut.
                const beforeBase = base.advances.size;
                const beforeNew = tightened.advances.size;
                const oldBytes = base.serve(ordinal, bust ? legacy : true);
                const newBytes = tightened.serve(ordinal, bust ? admitted : true);
                if (!bust) {
                    expect(base.advances.size).toBe(beforeBase);
                    expect(tightened.advances.size).toBe(beforeNew);
                }
                for (const [target, advancedAt] of tightened.advances) {
                    expect(base.advances.get(target)).toBeDefined();
                    expect(advancedAt).toBeGreaterThanOrEqual(base.advances.get(target)!);
                }
                if (oldBytes !== newBytes) {
                    if (bust) {
                        expect(base.advances.get(ordinal)).toBe(pass);
                        expect(tightened.advances.has(ordinal)).toBe(false);
                        activeOrigin = { pass, ordinal, inherited: [] };
                        origins.push(activeOrigin);
                        bustDifferences++;
                    } else {
                        expect(activeOrigin).toBeDefined();
                        expect(busts.has(activeOrigin!.pass)).toBe(true);
                        activeOrigin!.inherited.push(pass);
                    }
                } else activeOrigin = undefined;
            }
        }
        expect(pass).toBeGreaterThanOrEqual(200);
        expect(changedDecisions).toBeGreaterThan(0);
        expect(origins.length).toBeGreaterThan(0);
        expect(base.advances.size).toBe(50);
        expect(tightened.advances.size).toBe(50);
        console.log(
            `standalone-marker-comparison ${JSON.stringify({ passes: pass, baseDeferFrozen: base.frozen, newDeferFrozen: tightened.frozen, changedDecisions, originatingBusts: origins.length, bustDifferences, inheritedDifferences: origins.reduce((sum, origin) => sum + origin.inherited.length, 0), origins })}`,
        );
    } finally {
        base.db.close();
        tightened.db.close();
    }
});
