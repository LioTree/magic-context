import { describe, expect, test } from "bun:test";
import type { MessageLike } from "../transform-operations";
import { isFallbackAdmissible, recordProviderUsage } from "./fallback-admissibility";
import {
    applyCompaction,
    assemble,
    commitEntries,
    createRecord,
    descend,
    issueRequest,
} from "./record";

const message = (id: string, text = id): MessageLike => ({
    info: { id, role: "user" },
    parts: [{ type: "text", text }],
});
const defaults = {
    model: "unknown/model",
    envelope: "system-and-tools-v1",
    contextWindow: 1000,
    systemPromptTokens: 10,
    toolDefinitionTokens: 20,
};
function fixture(compact = true) {
    const messages = [message("source-1"), message("source-2"), message("tail-3")];
    const record = createRecord<MessageLike, undefined>({
        lineage_id: "lineage-1",
        plan: undefined,
        initial: {
            compaction_id: "identity",
            version: 0,
            range: { from: 0, to: 0 },
            replacement: [],
        },
    });
    commitEntries(
        record,
        messages.map((served, index) => ({
            entry: {
                id: served.info.id!,
                ordinal: index + 1,
                ingest: JSON.stringify(served),
                served,
                op_version: 1,
                hook: { answers: [] },
                ingested: true,
                race: false,
            },
            unserved_subjects: [],
        })),
    );
    if (compact) {
        issueRequest(record, "request-1", 100);
        expect(
            applyCompaction(
                record,
                {
                    request_id: "request-1",
                    arrived_ms: 1,
                    compaction: {
                        compaction_id: "compaction-1",
                        version: 1,
                        range: { from: 0, to: 3 },
                        replacement: [message("summary", "short summary")],
                    },
                    coverage: { end_mid: "source-2", ordinal: 2 },
                },
                () => true,
            ).applied,
        ).toBe(true);
    }
    return { record, messages };
}
function measuredFixture() {
    const f = fixture();
    recordProviderUsage(f.record, { ...defaults, inputTokens: 100, messages: assemble(f.record) });
    return f;
}

describe("host-runner fallback admissibility", () => {
    test("accepts an append as the last replacement and raw tail using measured usage", () => {
        const { record, messages } = measuredFixture();
        const append = message("new-4", "new tail");
        const before = JSON.stringify({
            ...record,
            ids: [...record.ids],
            source_digests: [...record.source_digests],
        });
        const result = isFallbackAdmissible(record, {
            ...defaults,
            messages: [...messages, append],
            systemPromptTokens: undefined,
            toolDefinitionTokens: undefined,
            contextWindow: 116,
        });
        expect(result).toEqual({ admissible: true, view: [...assemble(record), append] });
        expect(
            JSON.stringify({
                ...record,
                ids: [...record.ids],
                source_digests: [...record.source_digests],
            }),
        ).toBe(before);
        expect(record.entries.map((entry) => entry.id)).toEqual(["tail-3"]);
        expect(record.source_digests.size).toBe(3);
    });

    test("rejects an edit inside the covered range even when fit is proven", () => {
        const { record, messages } = measuredFixture();
        const edited = [messages[0]!, message("source-2", "edited source"), messages[2]!];
        expect(isFallbackAdmissible(record, { ...defaults, messages: edited })).toMatchObject({
            admissible: false,
            reason: "covered_range_changed",
        });
    });

    test("excludes synthetic heads and new compaction markers from the ordinal space", () => {
        const { record, messages } = measuredFixture();
        const head: MessageLike = {
            info: { role: "user" },
            parts: [{ type: "text", text: "head", synthetic: true }],
        };
        const marker: MessageLike = {
            info: { id: "new-marker", role: "user" },
            parts: [{ type: "compaction" }],
        };
        expect(
            isFallbackAdmissible(record, { ...defaults, messages: [head, marker, ...messages] }),
        ).toEqual({
            admissible: true,
            view: assemble(record),
        });
    });

    test("rejects a revert that removes the covered suffix", () => {
        const { record, messages } = measuredFixture();
        expect(
            isFallbackAdmissible(record, { ...defaults, messages: messages.slice(0, 1) }),
        ).toMatchObject({
            admissible: false,
            reason: "covered_range_changed",
        });
    });

    test("rejects covered removals, insertions, duplicate ids and reordered ordinals", () => {
        const { record, messages } = measuredFixture();
        for (const changed of [
            messages.slice(1),
            [messages[0]!, message("inserted"), ...messages.slice(1)],
            [messages[0]!, messages[0]!, ...messages.slice(1)],
            [messages[1]!, messages[0]!, messages[2]!],
            [
                { info: { role: "user" }, parts: [{ type: "text", text: "idless insertion" }] },
                ...messages,
            ],
        ]) {
            expect(isFallbackAdmissible(record, { ...defaults, messages: changed })).toMatchObject({
                admissible: false,
                reason: "covered_range_changed",
            });
        }
    });

    test("rejects an invalidated lineage and missing covered digest evidence", () => {
        const { record, messages } = measuredFixture();
        record.source_digests.delete("source-1");
        expect(isFallbackAdmissible(record, { ...defaults, messages })).toMatchObject({
            admissible: false,
            reason: "covered_range_changed",
        });
        descend(record, 1, "lineage-2");
        expect(
            isFallbackAdmissible(record, { ...defaults, messages: messages.slice(0, 1) }),
        ).toMatchObject({
            admissible: false,
            reason: "covered_range_changed",
        });
    });

    test("rejects fit when the model window is unknown, invalid or too small", () => {
        const { record, messages } = measuredFixture();
        for (const contextWindow of [undefined, 0, Number.NaN, Number.POSITIVE_INFINITY, 99]) {
            expect(
                isFallbackAdmissible(record, { ...defaults, messages, contextWindow }),
            ).toMatchObject({
                admissible: false,
                reason: "fit_unproven",
            });
        }
    });

    test("prices the appended tail conservatively with the MC fit margin", () => {
        const { record, messages } = measuredFixture();
        const input = {
            ...defaults,
            messages: [...messages, message("new-4", "new tail")],
            contextWindow: 115,
        };
        expect(isFallbackAdmissible(record, input)).toMatchObject({
            admissible: false,
            reason: "fit_unproven",
        });
        expect(isFallbackAdmissible(record, { ...input, contextWindow: 116 }).admissible).toBe(
            true,
        );
    });

    test("admits a pre-compaction identity only with a complete estimate and margin", () => {
        const { record, messages } = fixture(false);
        expect(isFallbackAdmissible(record, { ...defaults, messages })).toEqual({
            admissible: true,
            view: messages,
        });
        for (const override of [
            { systemPromptTokens: undefined },
            { toolDefinitionTokens: undefined },
            { systemPromptTokens: Number.NaN },
            { contextWindow: 50 },
        ]) {
            expect(
                isFallbackAdmissible(record, { ...defaults, messages, ...override }),
            ).toMatchObject({
                admissible: false,
                reason: "fit_unproven",
            });
        }
        recordProviderUsage(record, { ...defaults, inputTokens: 80, messages });
        expect(
            isFallbackAdmissible(record, {
                ...defaults,
                messages,
                contextWindow: 80,
                systemPromptTokens: undefined,
                toolDefinitionTokens: undefined,
            }).admissible,
        ).toBe(true);
    });

    test("does not borrow measured usage from a changed model, envelope or served prefix", () => {
        const { record, messages } = measuredFixture();
        const input = {
            ...defaults,
            messages,
            systemPromptTokens: undefined,
            toolDefinitionTokens: undefined,
        };
        for (const override of [
            { model: "other/model" },
            { envelope: "new-tools" },
            { messages: [...messages.slice(0, 2), message("tail-3", "changed uncompressed tail")] },
        ]) {
            expect(isFallbackAdmissible(record, { ...input, ...override })).toMatchObject({
                admissible: false,
                reason: "fit_unproven",
            });
        }
    });

    test("allows an estimated compacted fallback but refuses uncountable content", () => {
        const { record, messages } = fixture();
        expect(isFallbackAdmissible(record, { ...defaults, messages }).admissible).toBe(true);
        expect(
            isFallbackAdmissible(record, {
                ...defaults,
                messages: [
                    ...messages,
                    {
                        info: { id: "new-4", role: "user" },
                        parts: [{ type: "unknown-payload", text: "unknown" }],
                    },
                ],
            }),
        ).toMatchObject({ admissible: false, reason: "fit_unproven" });
    });
});
