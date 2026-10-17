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
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { measureLkgReplay } from "./lkg-fit-measure";
import {
    __setLkgMarkerReadingForTests,
    beginV2LkgRequest,
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
import { createSystemPromptHashHandler } from "./system-prompt-hash";
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
    // Even complete-looking JSON definitions cannot prove which tools were sent:
    // MCP tools never reach the hook, so a completed request's usage is required.
    recordToolDefinition("unknown", "model", undefined, "read", "Read file", { type: "object" });
    expect(measureStandaloneMarker(args).fit).toBe("unproven");
    serveCurrent(args.sessionId, args.messages);
    expect(measureStandaloneMarker(args).fit).toBe("unproven");
    complete(args.sessionId, args.model, "first", 800);
    startRequest(args.sessionId, args.model, "second", ["Final system"]);
    expect(measureStandaloneMarker(args).fit).toBe("under");
    // The first request's 800 input tokens bound the envelope, so a 700 window fails.
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
        // Repeated updates of the first response (finish, then completed) keep its reading.
        complete(args.sessionId, args.model, "first", 800);
        expect(measureStandaloneMarker(args).fit).toBe("under");
    });

    test("a later completion without a known served array clears the reading", () => {
        qualified();
        // The second request completes, but its returned array was never captured,
        // so its usage cannot bound anything and the older reading is dropped too.
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

/** Record the message array the Rust transform returned to OpenCode for the current request. */
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

test("standalone marker reads system strings from the current or previous request only", () => {
    const args = {
        sessionId: "marker-envelope-session",
        model: "unknown/model",
        systemHash: "hash",
        messages: [{ info: { id: "m", role: "user" }, parts: [{ type: "text", text: "hello" }] }],
        limit: 10000,
    };
    recordToolDefinition("unknown", "model", undefined, "read", "Read file", { type: "object" });
    // The first request records its final system strings, is served and completes,
    // so its usage is a reading for the same envelope.
    noteLkgProviderResponse({
        sessionId: args.sessionId,
        modelKey: args.model,
        responseId: "first",
        inputTokens: 0,
    });
    recordMarkerSystem(args.sessionId, args.model, args.systemHash, ["Final system"]);
    serveCurrent(args.sessionId, args.messages);
    complete(args.sessionId, args.model, "first", 800);
    noteLkgProviderResponse({
        sessionId: args.sessionId,
        modelKey: args.model,
        responseId: "second",
        inputTokens: 0,
    });
    // OpenCode 1 records a request's final system strings only after its messages
    // transform, so a transform can only measure with the system strings the
    // request directly before it recorded.
    expect(measureStandaloneMarker(args).fit).toBe("under");
    noteLkgProviderResponse({
        sessionId: args.sessionId,
        modelKey: args.model,
        responseId: "third",
        inputTokens: 0,
    });
    expect(measureStandaloneMarker(args).fit).toBe("unproven");
});

function markerHandlerFixture(sessionId: string) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, sessionId);
    resolveCtxReduceAvailabilityFromMessages(sessionId, [
        { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ] as never);
    recordToolDefinition("unknown", "model", undefined, "read", "Read file", { type: "object" });
    const system = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => ({ providerID: "unknown", modelID: "model" }),
        systemPromptRefreshSessions: new Set<string>(),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
    });
    const measure = () =>
        measureStandaloneMarker({
            sessionId,
            model: "unknown/model",
            systemHash: getOrCreateSessionMeta(db, sessionId).systemPromptHash,
            messages: [
                { info: { id: "m", role: "user" }, parts: [{ type: "text", text: "hello" }] },
            ],
            limit: 100_000,
        }).fit;
    return {
        runSystemHook: () =>
            system.handler(
                { sessionID: sessionId, model: { providerID: "unknown", modelID: "model" } },
                { system: ["Host instructions for the marker fixture."] },
            ),
        measure,
        close: () => {
            clearCtxReduceAvailability(sessionId);
            clearLkgMeasuredRequest(sessionId);
            db.close();
        },
    };
}

/** Install a completed-request reading whose envelope identity is the one the
 * current request resolves. Resolving it is the request-identity check under test:
 * without admissible system strings there is no identity, so no reading. */
function installCurrentReading(sessionId: string) {
    const marker = standaloneMarkerIdentity(
        sessionId,
        currentLkgRequestIdentity(sessionId),
        undefined,
    );
    expect(marker).toBeDefined();
    if (!marker) return;
    __setLkgMarkerReadingForTests(sessionId, {
        responseId: "completed",
        inputTokens: 800,
        jsonPrefix: JSON.stringify([
            { info: { id: "m", role: "user" }, parts: [{ type: "text", text: "hello" }] },
        ]),
        marker,
    });
}

test("OpenCode 1 order admits the final system its system hook recorded on the previous request", async () => {
    const sessionId = "marker-envelope-session";
    const fixture = markerHandlerFixture(sessionId);
    try {
        // Request 1: the assistant row exists before either hook runs, and the
        // system hook runs after the messages transform.
        noteLkgProviderResponse({
            sessionId,
            modelKey: "unknown/model",
            responseId: "assistant-1",
            inputTokens: 0,
        });
        await fixture.runSystemHook();
        // Request 2: its messages transform measures before its system hook runs.
        noteLkgProviderResponse({
            sessionId,
            modelKey: "unknown/model",
            responseId: "assistant-2",
            inputTokens: 0,
        });
        installCurrentReading(sessionId);
        expect(fixture.measure()).toBe("under");
    } finally {
        fixture.close();
    }
});

test("OpenCode 2 order admits the system stage's final system after the transform starts its request", async () => {
    const sessionId = "marker-envelope-session";
    const fixture = markerHandlerFixture(sessionId);
    try {
        // The context hook starts a request, runs the system stage, then starts
        // the transform's own request identity for a non-provider session.
        beginV2LkgRequest(sessionId, "unknown/model", undefined, 0);
        await fixture.runSystemHook();
        beginV2LkgRequest(sessionId, "unknown/model");
        installCurrentReading(sessionId);
        expect(fixture.measure()).toBe("under");
        // A further request whose system stage did not record anything must not
        // reuse material from two requests back, even with a reading installed.
        beginV2LkgRequest(sessionId, "unknown/model", undefined, 1);
        beginV2LkgRequest(sessionId, "unknown/model");
        expect(
            standaloneMarkerIdentity(sessionId, currentLkgRequestIdentity(sessionId), undefined),
        ).toBeUndefined();
        expect(fixture.measure()).toBe("unproven");
    } finally {
        fixture.close();
    }
});

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
                // An earlier completed request with this ordinal's system and tools;
                // its usage stands in for the provider's count of that envelope.
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
