import { afterEach, expect, it, spyOn } from "bun:test";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    measuredLkgPrefix,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import { buildLkgPrefix, captureLkgSlot } from "./lkg-replay";
import { getSlot, resetLkgSlotsForTest } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

const sessionId = "capture-array-count";
const modelKey = "openai/gpt-4.1";
const message = (id: string): MessageLike =>
    ({ info: { id, role: "user" }, parts: [{ type: "text", text: id }] }) as MessageLike;

afterEach(() => {
    clearLkgMeasuredRequest(sessionId);
    resetLkgSlotsForTest();
});

it("counts prepared output without reparsing it and refreshes the count on changed captures", () => {
    // The output deliberately differs from the input frontier: a synthetic head
    // and a dropped message must not shift where measured replay's tail begins.
    const input = [message("input"), message("dropped")];
    for (const output of [
        [message("head"), message("input"), message("extra")],
        [message("input")],
    ]) {
        beginV2LkgRequest(sessionId, modelKey, "previous");
        const json = JSON.stringify(output);
        const parse = spyOn(JSON, "parse");
        try {
            expect(
                captureLkgSlot({
                    sessionId,
                    input,
                    output,
                    modelKey,
                    providerKey: "openai",
                    completeOutput: true,
                }),
            ).toBe(true);
            expect(parse.mock.calls.filter(([value]) => value === json)).toHaveLength(0);
        } finally {
            parse.mockRestore();
        }
        noteLkgProviderResponse({
            sessionId,
            modelKey,
            responseId: "reply",
            inputTokens: 123,
            finish: "stop",
            v2: true,
            createdAt: Date.now() + 1,
        });
        const reply = {
            info: { id: "reply", role: "assistant" },
            parts: [{ type: "text", text: "reply" }],
        } as MessageLike;
        const slot = getSlot(sessionId);
        expect(slot?.jsonPrefix).toBe(json);
        expect(
            measuredLkgPrefix({
                sessionId,
                slot,
                messages: [...output, reply],
                modelKey,
                systemPromptTokens: 0,
            }),
        ).toEqual({ inputTokens: 123, appendedMessages: [reply] });
    }
});

it("does not infer the serialized count when an array has a custom serializer", () => {
    const prototype = Array.prototype;
    const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
    Object.defineProperty(prototype, "toJSON", {
        configurable: true,
        value(this: unknown[]) {
            return this.slice(0, 1);
        },
    });
    let built: ReturnType<typeof buildLkgPrefix>;
    try {
        built = buildLkgPrefix([message("input")], [message("head"), message("input")], true);
    } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
    }
    expect(built?.prefixMessageCount).toBeUndefined();
    expect(JSON.parse(built!.jsonPrefix)).toHaveLength(1);
});
