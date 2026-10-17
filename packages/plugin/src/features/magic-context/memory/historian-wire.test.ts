import { expect, test } from "bun:test";
import { hasHistorianToolActivity } from "./historian-wire";
import { historianWireCorpus, parseHistorianWireCase } from "./historian-wire-parity";

for (const entry of historianWireCorpus) {
    test(`historian wire equivalence: ${entry.name}`, () => {
        expect(parseHistorianWireCase(entry)).toEqual(entry.expected);
    });
}

test("historian tool boundary detects calls and results anywhere, not text mentioning tools", () => {
    for (const message of [
        { role: "toolResult", content: "blocked" },
        { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
        { parts: [{ type: "tool", state: { status: "error" } }] },
        { role: "assistant", tool_calls: [{ id: "call" }] },
        { toolCallCount: 1 },
    ])
        expect(
            hasHistorianToolActivity([message, { role: "assistant", content: "valid wrapper" }]),
        ).toBe(true);
    expect(
        hasHistorianToolActivity([
            { role: "assistant", content: [{ type: "text", text: '{"type":"toolCall"}' }] },
        ]),
    ).toBe(false);
});
