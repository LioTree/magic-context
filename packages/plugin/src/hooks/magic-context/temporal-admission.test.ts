import { describe, expect, it } from "bun:test";
import { createEditAdmission, thinkingAnchor } from "./edit-admission";
import { admitTemporalCandidates } from "./temporal-admission";
import { injectTemporalMarkers } from "./temporal-awareness";

describe("temporal admission", () => {
    const marker = "<!-- +12m -->\n";
    const messages = () => [
        { info: { id: "before", role: "user" }, parts: [{ type: "text", text: "before" }] },
        {
            info: { id: "boundary", role: "assistant" },
            parts: [{ type: "reasoning", signature: "kept", text: "thinking" }],
        },
        { info: { id: "tail", role: "user" }, parts: [{ type: "text", text: "tail" }] },
    ];
    const frame = (input: ReturnType<typeof messages>, prefixBound = true) =>
        createEditAdmission({
            messages: input,
            stableId: (m) => m.info.id,
            partsOf: (m) => m.parts,
            // Treat the message named "tail" like a tool-result carrier: it does not start a user turn.
            isRealUser: (m) => m.info.id === "before",
            prefixBound,
            isRetainedThinking: (_m, p) => (p as { type?: string }).type === "reasoning",
            anchorOf: thinkingAnchor,
        });

    it("holds new prefix decisions, admits the tail and replays frozen choices without admission", () => {
        const input = messages();
        const frozen = new Map([["before", "<!-- +10m -->\n"]]);
        const candidates = new Map([
            ["before", marker],
            ["boundary", marker],
            ["tail", marker],
        ]);
        const held: string[] = [];
        const admitted = admitTemporalCandidates({
            candidates,
            frozen,
            admission: frame(input),
            locations: input.map((m) => ({ id: m.info.id, block: 0 })),
            onHeld: (ids) => held.push(...ids),
        });
        expect([...admitted]).toEqual([["tail", marker]]);
        expect(held).toEqual(["boundary"]);
        const applied: string[] = [];
        const decisions = new Map([...frozen, ...admitted]);
        injectTemporalMarkers(input, decisions, (m) =>
            applied.push((m as { info: { id: string } }).info.id),
        );
        expect(input[0].parts[0].text).toBe("<!-- +10m -->\nbefore");
        expect(input[2].parts[0].text).toBe(`${marker}tail`);
        expect(applied).toEqual(["before", "tail"]);
        expect(
            admitTemporalCandidates({
                candidates,
                frozen: decisions,
                admission: frame(input),
                locations: [],
            }).size,
        ).toBe(0);
        expect(injectTemporalMarkers(input, decisions)).toBe(0);
    });

    it("leaves a held candidate undecided and admits it once the boundary is gone", () => {
        const input = messages();
        const candidates = new Map([["before", marker]]);
        const locations = [{ id: "before", block: 0 }];
        const held = admitTemporalCandidates({
            candidates,
            frozen: new Map(),
            locations,
            admission: frame(input),
        });
        expect(held.size).toBe(0);
        expect(injectTemporalMarkers(input, held)).toBe(0);
        expect(input[0].parts[0].text).toBe("before");
        const released = admitTemporalCandidates({
            candidates,
            frozen: new Map(),
            locations,
            admission: frame(input, false),
        });
        expect([...released]).toEqual([["before", marker]]);
    });

    it("holds unresolved, positional and textless coordinates even without a boundary", () => {
        const candidates = new Map([
            ["missing", marker],
            ["pi-msg-2-user", marker],
            ["synth-user-1", marker],
            ["textless", marker],
        ]);
        const admitted = admitTemporalCandidates({
            candidates,
            frozen: new Map(),
            admission: frame(messages(), false),
            locations: [
                { id: undefined, block: 0 },
                { id: "pi-msg-2-user", block: 0 },
                { id: "synth-user-1", block: 0 },
                { id: "textless", block: -1 },
            ],
        });
        expect(admitted.size).toBe(0);
    });
});
