import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import {
    clearLkgMeasuredRequest,
    currentLkgRequestIdentity,
    lkgMarkerReading,
    noteCapturedLkgRequest,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import {
    clearMarkerSystem,
    measureStandaloneMarker,
    recordMarkerSystem,
    standaloneMarkerIdentity,
} from "./standalone-marker-envelope";
import type { MessageLike } from "./transform-operations";

type TraceEvent = {
    seq: number;
    at: "messages" | "system" | "params";
    s: string;
    n?: number;
    sys0?: string;
    agent?: string;
    request?: string;
};
const sessions = [
    "stock-S0",
    "stock-S1",
    "system-first",
    "late-row",
    "private-S0",
    "private-S1",
    "private-S2",
];
const model = "unknown/model";
const system = ["Stable host instructions."];
const messages: MessageLike[] = [
    { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "hello" }] },
];

afterEach(() => {
    for (const id of sessions) {
        clearLkgMeasuredRequest(id);
        clearMarkerSystem(id);
    }
    __resetToolDefinitionMeasurements();
});

function begin(sessionId: string, responseId: string) {
    noteLkgProviderResponse({ sessionId, modelKey: model, responseId, inputTokens: 0 });
}

function capture(sessionId: string) {
    const request = currentLkgRequestIdentity(sessionId);
    noteCapturedLkgRequest({
        sessionId,
        request,
        slot: {
            jsonPrefix: JSON.stringify(messages),
            inputIdSeq: ["u"],
            inputContentDigests: [],
            lastInputMessageId: "u",
            modelKey: model,
            providerKey: "unknown",
            capturedAt: Date.now(),
        },
        systemPromptTokens: 0,
        marker: standaloneMarkerIdentity(sessionId, request, undefined),
    });
}

function complete(sessionId: string, responseId: string) {
    noteLkgProviderResponse({
        sessionId,
        modelKey: model,
        responseId,
        inputTokens: 800,
        completedAt: Date.now(),
        finish: "stop",
    });
}

function measure(sessionId: string) {
    return measureStandaloneMarker({
        sessionId,
        model,
        systemHash: "hash",
        messages,
        limit: 10_000,
    }).fit;
}

test("stock OC1 trace keeps messages before system through bootstrap, title, tool steps and child", () => {
    // Session/user IDs are normalized in the fixture; dispatch order, agents and
    // message counts come from the pinned host. Request labels group each main
    // messages/system/params triple; OC1 creates its reply row before any hook.
    // Token material is synthetic.
    const trace: TraceEvent[] = readFileSync(
        new URL("./fixtures/oc1-stock-hook-order.jsonl", import.meta.url),
        "utf8",
    )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    recordToolDefinition("unknown", "model", undefined, "read", "Read", {});
    const pending = new Map<string, string>();
    const fits: string[] = [];
    const counts: number[] = [];
    for (const event of trace) {
        const id = `stock-${event.s}`;
        if (event.request && pending.get(id) !== event.request) {
            begin(id, event.request);
            pending.set(id, event.request);
        }
        if (event.at === "messages") {
            counts.push(event.n!);
            fits.push(measure(id));
            capture(id);
        } else if (event.at === "system") {
            recordMarkerSystem(
                id,
                model,
                "hash",
                event.sys0?.includes("title generator") ? ["Title instructions."] : system,
            );
        } else if (event.agent !== "title") {
            complete(id, pending.get(id)!);
        }
    }
    expect(counts).toEqual([1, 3, 5, 6, 7, 1]);
    // Bootstrap has no recorded system at capture; the second request can be
    // attributed on completion. Later tool steps reuse that completed reading.
    expect(fits).toEqual(["unproven", "unproven", "under", "under", "under", "unproven"]);
});

test("system-first recording rejects a grown current system without relabeling previous usage", () => {
    for (const id of ["system-first", "late-row"]) {
        recordToolDefinition("unknown", "model", undefined, "read", "Read", {});
        begin(id, "first");
        recordMarkerSystem(id, model, "hash", system);
        capture(id);
        complete(id, "first");
        const previous = lkgMarkerReading(id);
        expect(previous).toBeDefined();
        if (id === "late-row") {
            recordMarkerSystem(id, model, "hash", [
                "Grown AGENTS.md instructions. ".repeat(10_000),
            ]);
            begin(id, "second");
        } else {
            begin(id, "second");
            recordMarkerSystem(id, model, "hash", [
                "Grown AGENTS.md instructions. ".repeat(10_000),
            ]);
        }
        // Whether the reply row appears before the system hook or between the
        // system and messages hooks, fit must use the newest system strings.
        // The completed request's saved model/system/tool identity must not change.
        expect(measure(id)).toBe("unproven");
        expect(lkgMarkerReading(id)).toEqual(previous);
    }
});

test("private system-first trace rejects changed systems and keeps readings through refused recovery passes", () => {
    // `recover-start` marks retries after the deadline and abort failures.
    // `main` records the relay's old routing decision, not whether a session is
    // enrolled or whether any request reached the provider.
    const trace = readFileSync(
        new URL("./fixtures/thalamus-hook-order.jsonl", import.meta.url),
        "utf8",
    )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    recordToolDefinition("unknown", "model", undefined, "read", "Read", {});
    const pending = new Map<string, string>();
    const turns = new Map<string, number>();
    const fits: string[] = [];
    for (const event of trace) {
        if (event.probe) continue;
        const id = `private-${event.s}`;
        if (event.at === "system") {
            const turn = (turns.get(id) ?? 0) + 1;
            turns.set(id, turn);
            const reply = `reply-${event.seq}`;
            begin(id, reply);
            pending.set(id, reply);
            recordMarkerSystem(
                id,
                model,
                "hash",
                turn === 1 ? system : [...system, "AGENTS.md grew."],
            );
        } else if (event.at === "messages") {
            fits.push(measure(id));
            capture(id);
        } else {
            // A params event proves only preparation. This replay supplies a
            // synthetic successful response there; refused passes supply none.
            complete(id, pending.get(id)!);
        }
    }
    expect(fits).toEqual([
        "unproven",
        "unproven",
        "under",
        "under",
        "under",
        "under",
        "under",
        "unproven",
        "unproven",
    ]);
});
