import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./llm";
import { pruneVanillaHistory, releasedTokenTotal } from "./vanilla";

const history: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `message ${i}`,
}));

describe("released Vanilla pruning", () => {
    test("counts +2 once for a history and +4 per message", () => {
        expect(releasedTokenTotal([10, 20])).toBe(40);
        expect(releasedTokenTotal([])).toBe(2);
    });

    test("does not prune at the exact 10000-token trigger margin", () => {
        const messages = history.slice(0, 2);
        expect(pruneVanillaHistory(messages, [9995, 9995], 30000)).toBe(messages);
    });

    test("retains the whole boundary-crossing message even when the suffix exceeds the target", () => {
        expect(pruneVanillaHistory(history, Array(6).fill(3000), 12000)).toEqual(history.slice(2));
        expect(releasedTokenTotal(Array(4).fill(3000))).toBeGreaterThan(12000);
    });

    test("drops the oldest message of an odd suffix, not a user-assistant pair", () => {
        expect(pruneVanillaHistory(history, Array(6).fill(4000), 12000)).toEqual(history.slice(4));
    });

    test("uses singleton +2 charges and a strict greater-than reverse threshold", () => {
        expect(pruneVanillaHistory(history, Array(6).fill(3332), 12014)).toEqual(history.slice(2));
    });

    test("preserves the released empty-history edge between the two margins", () => {
        expect(pruneVanillaHistory(history.slice(0, 2), [9996, 9995], 30000)).toEqual([]);
    });

    test("does not protect a system message or truncate text within messages", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "old system" },
            ...history.slice(1),
        ];
        const trimmed = pruneVanillaHistory(messages, Array(6).fill(3000), 12000);
        expect(trimmed).toEqual(messages.slice(2));
        expect(trimmed[0]).toBe(messages[2]);
    });

    test("rejects a token vector that does not cover the history", () => {
        expect(() => pruneVanillaHistory(history, [1], 272000)).toThrow("one token count");
    });
});
