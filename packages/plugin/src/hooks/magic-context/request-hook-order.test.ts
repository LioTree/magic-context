/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { createRequestHookOrder } from "./request-hook-order";

const history = [
    { info: { id: "msg_0001", role: "user" } },
    { info: { id: "msg_0002", role: "assistant" } },
    { info: { id: "msg_0003", role: "user" } },
];

describe("request hook order", () => {
    it("reports messages-first when the system hook follows its own messages pass", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("s", history);
        expect(order.consumeMessagesPrepared("s")).toBe(true);
        // Consumed: a second system call for the same request does not see it again.
        expect(order.consumeMessagesPrepared("s")).toBe(false);
    });

    it("clears the marker when a newer reply completes between the messages pass and the system hook", () => {
        const order = createRequestHookOrder();
        expect(order.consumeMessagesPrepared("s")).toBe(false);
        order.messagesPrepared("s", history);
        // The reply to the prepared request is newer than every assistant it saw.
        order.assistantCompleted("s", "msg_0004");
        expect(order.consumeMessagesPrepared("s")).toBe(false);
    });

    it("ignores a late completion event for a reply the messages pass already saw", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("s", history);
        order.assistantCompleted("s", "msg_0002");
        expect(order.consumeMessagesPrepared("s")).toBe(true);
    });

    it("treats a completion without a comparable id as a reply", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("s", history);
        order.assistantCompleted("s", undefined);
        expect(order.consumeMessagesPrepared("s")).toBe(false);
    });

    it("does not mistake an unfinished previous request for messages-final on a system-first host", () => {
        const order = createRequestHookOrder();
        // system(A) on a system-first host: no messages pass yet.
        expect(order.consumeMessagesPrepared("s")).toBe(false);
        // messages(A) runs; A then ends with no completion event observed.
        order.messagesPrepared("s", [{ info: { id: "msg_0002", role: "assistant" } }]);
        // system(B) still precedes messages(B), regardless of A's completion.
        expect(order.consumeMessagesPrepared("s")).toBe(false);
        order.messagesPrepared("s", history);
        expect(order.consumeMessagesPrepared("s")).toBe(false);
    });

    it("retains messages-first order across an aborted request and late completion", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("s", history);
        expect(order.consumeMessagesPrepared("s")).toBe(true);
        order.messagesPrepared("s", history);
        order.assistantCompleted("s", "msg_0002");
        expect(order.consumeMessagesPrepared("s")).toBe(true);
    });

    it("relearns hook order after session cleanup", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("s", history);
        expect(order.consumeMessagesPrepared("s")).toBe(true);
        order.clearSession("s");
        expect(order.consumeMessagesPrepared("s")).toBe(false);
        order.messagesPrepared("s", history);
        expect(order.consumeMessagesPrepared("s")).toBe(false);
    });

    it("keeps sessions apart and forgets cleared sessions", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("a", history);
        order.messagesPrepared("b", history);
        order.assistantCompleted("a", "msg_0009");
        order.clearSession("b");
        expect(order.consumeMessagesPrepared("a")).toBe(false);
        expect(order.consumeMessagesPrepared("b")).toBe(false);
    });
});
