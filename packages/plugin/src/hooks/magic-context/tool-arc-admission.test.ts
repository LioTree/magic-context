import { describe, expect, it } from "bun:test";
import { createEditAdmission, isAdmissionUser, thinkingAnchor } from "./edit-admission";
import type { MessageLike, TagTarget } from "./tag-messages";
import { openCodeToolBatchCoordinates, protectToolBatchMutations } from "./tool-arc-admission";

const call = (id: string) => ({ type: "tool_use", id, name: "read", input: {} });
const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "large output" });
const thinking = { type: "reasoning", signature: "boundary", text: "reasoning" };
const message = (id: string, role: string, parts: unknown[]): MessageLike =>
    ({ info: { id, role }, parts }) as MessageLike;

function guarded(
    messages: MessageLike[],
    owner: MessageLike,
    part = owner.parts.find((part) => part !== thinking),
) {
    const admission = createEditAdmission({
        messages,
        stableId: (m) => m.info.id,
        partsOf: (m) => m.parts,
        isRealUser: isAdmissionUser,
        prefixBound: true,
        isRetainedThinking: (_m, p) => p === thinking,
        anchorOf: thinkingAnchor,
    });
    const target: TagTarget = {
        mutationParts: [{ message: owner, part }],
        canDrop: () => true,
        drop: () => "removed",
        setContent: () => true,
    };
    return protectToolBatchMutations(
        new Map([[1, target]]),
        admission,
        openCodeToolBatchCoordinates(messages),
    ).get(1)!;
}

describe("OpenCode compound tool admission", () => {
    it("holds a straddling parallel batch at its earliest call, not its result", () => {
        const owner = message("assistant", "assistant", [call("a"), thinking, call("b")]);
        const tail = message("results", "user", [result("a"), result("b")]);
        expect(guarded([owner, tail], owner).canDrop?.()).toBe(false);
        expect(guarded([owner, tail], tail).drop?.()).toBe("incomplete");
    });
    it("admits a whole parallel batch after the boundary", () => {
        const owner = message("assistant", "assistant", [thinking, call("a"), call("b")]);
        const tail = message("results", "user", [result("a"), result("b")]);
        expect(guarded([owner, tail], owner).canDrop?.()).toBe(true);
    });
    it("holds all siblings when one result is missing or unresolved", () => {
        const owner = message("assistant", "assistant", [thinking, call("a"), call("b")]);
        expect(guarded([owner, message("results", "user", [result("a")])], owner).canDrop?.()).toBe(
            false,
        );
        expect(
            guarded([owner, message("", "user", [result("a"), result("b")])], owner).canDrop?.(),
        ).toBe(false);
    });
    it("pairs reused call ids by occurrence rather than joining earlier turns", () => {
        const old = message("old", "assistant", [call("a")]);
        const owner = message("assistant", "assistant", [thinking, call("a")]);
        const messages = [
            old,
            message("old-result", "user", [result("a")]),
            owner,
            message("result", "user", [result("a")]),
        ];
        expect(guarded(messages, old).canDrop?.()).toBe(false);
        expect(guarded(messages, owner).canDrop?.()).toBe(true);
    });
    it("does not merge independent batches whose results share a carrier", () => {
        const old = message("old", "assistant", [call("old")]);
        const owner = message("assistant", "assistant", [thinking, call("tail")]);
        const results = message("results", "user", [result("old"), result("tail")]);
        const messages = [old, owner, results];
        expect(guarded(messages, results, results.parts[0]).canDrop?.()).toBe(false);
        expect(guarded(messages, results, results.parts[1]).canDrop?.()).toBe(true);
    });
    it("holds an orphan result even beside an admitted result", () => {
        const owner = message("assistant", "assistant", [thinking, call("tail")]);
        const results = message("results", "user", [result("tail"), result("orphan")]);
        expect(guarded([owner, results], results, results.parts[1]).canDrop?.()).toBe(false);
    });
    it("a completed OpenCode part answers its earlier invocation without becoming a new batch", () => {
        const owner = message("assistant", "assistant", [
            thinking,
            { type: "tool-invocation", callID: "a" },
        ]);
        const completed = message("completed", "assistant", [
            {
                type: "tool",
                callID: "a",
                state: { status: "completed", output: "output", input: {} },
            },
        ]);
        expect(guarded([owner, completed], completed).canDrop?.()).toBe(true);
    });
});
