import { describe, expect, test } from "bun:test";
import type { MessageLike } from "../transform-operations";
import type { BridgeReceipt } from "./bridge-receipt";
import { checkServedBytes, servedView } from "./bridge-served-view";

const receipt = (version: number, lineage = "L"): BridgeReceipt => ({
    request_id: "r",
    delivery: "pending",
    lineage_id: lineage,
    served_through_ordinal: 0,
    unserved_subjects: [],
    last_applied: { compaction_id: "c", version, range: { from: 1, to: 2 } },
});
const text = (id: string, value: string): MessageLike =>
    ({
        info: { id, sessionID: "s", role: id.startsWith("a") ? "assistant" : "user" },
        parts: [{ id: `${id}-text`, type: "text", text: value }],
    }) as MessageLike;
const head = { info: { role: "user" }, parts: [{ type: "text", text: "<h/>", synthetic: true }] };
const ordinals = new Map([
    ["u1", 1],
    ["a2", 2],
    ["u3", 3],
]);
/** The previously returned view: u1 raw, a2 and u3 tagged by hook answers. */
const before = [
    head as unknown as MessageLike,
    text("u1", "first"),
    text("a2", "§1§ done"),
    text("u3", "§2§ next"),
];
const host = [text("u1", "first"), text("a2", "done"), text("u3", "next"), text("u4", "new")];
const previous = servedView(receipt(3), before, ordinals, 3);
const refused = { code: "bridge_served_bytes_changed", reason: "served_bytes_changed" };
const run = (kind: "ordinary" | "rebuild", version: number, next: MessageLike[], lineage = "L") => {
    try {
        checkServedBytes(previous, receipt(version, lineage), kind, next, host);
        return undefined;
    } catch (error) {
        return error;
    }
};

describe("bridge served-bytes guard", () => {
    test("records only admitted messages through the published ordinal", () => {
        expect([...previous.messages.keys()]).toEqual(["u1", "a2", "u3"]);
        expect([...servedView(receipt(3), before, ordinals, 2).messages.keys()]).toEqual([
            "u1",
            "a2",
        ]);
    });

    test("an ordinary step that repeats served bytes and appends is served", () => {
        expect(run("ordinary", 3, [...before, text("u4", "§3§ new")])).toBeUndefined();
    });

    test("an ordinary step may not change any served message", () => {
        const next = [...before];
        next[2] = text("a2", "§1§ done, edited");
        expect(run("ordinary", 3, next)).toMatchObject(refused);
    });

    test("a rebuild may not put a served message back to the host's raw text", () => {
        const stripped = [head as unknown as MessageLike, text("u1", "first"), text("a2", "done")];
        expect(run("rebuild", 7, stripped)).toMatchObject(refused);
        // A newly applied view counts as a rebuild even on an ordinary step.
        expect(run("ordinary", 7, stripped)).toMatchObject(refused);
    });

    test("a rebuild may edit served text differently or compact messages away", () => {
        const dropped = [head as unknown as MessageLike, text("a2", "[dropped §1§]")];
        expect(run("rebuild", 7, dropped)).toBeUndefined();
    });

    test("a new lineage still refuses raw text and undeclared edits", () => {
        expect(run("ordinary", 3, [text("a2", "done")], "L2")).toMatchObject(refused);
        expect(run("ordinary", 3, [text("a2", "§1§ edited")], "L2")).toMatchObject(refused);
        expect(run("rebuild", 9, [text("a2", "done")], "L2")).toMatchObject(refused);
        expect(run("rebuild", 9, [text("a2", "[dropped §1§]")], "L2")).toBeUndefined();
    });

    test("messages absent from host history are not compared", () => {
        expect(() =>
            checkServedBytes(
                previous,
                receipt(3, "L2"),
                "ordinary",
                [text("a2", "done")],
                [host[0]],
            ),
        ).not.toThrow();
    });
});
