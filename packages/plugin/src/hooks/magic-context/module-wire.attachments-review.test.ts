/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import {
    encodeOpenCodeMessagesToCk,
} from "./module-wire";

test("attachment review: attachment-free error/completed and empty-list aliases keep old bytes", () => {
    for (const status of ["completed", "error"]) {
        for (const text of ["", "line\n\u0000§raw§"]) {
            for (const aliases of [
                {},
                { attachments: [] },
                { stateAttachments: [] },
                { attachments: [], stateAttachments: [] },
            ]) {
                const state = {
                    status,
                    input: {},
                    [status === "error" ? "error" : "output"]: text,
                    ...("stateAttachments" in aliases
                        ? { attachments: aliases.stateAttachments }
                        : {}),
                };
                const raw = {
                    info: { id: "m", role: "assistant" },
                    parts: [
                        {
                            type: "tool",
                            tool: "read",
                            callID: "call",
                            state,
                            ...("attachments" in aliases
                                ? { attachments: aliases.attachments }
                                : {}),
                        },
                    ],
                };
                const old = [
                    {
                        mid: "m",
                        ordinal: 1,
                        ck: {
                            role: "assistant",
                            content: [
                                {
                                    kind: {
                                        type: "tool_call",
                                        id: "call",
                                        name: "read",
                                        input: {},
                                    },
                                },
                                {
                                    kind: {
                                        type: "tool_result",
                                        id: "call",
                                        tool_name: "read",
                                        output: {
                                            kind: {
                                                type: status === "error" ? "error_text" : "text",
                                                text,
                                            },
                                        },
                                    },
                                },
                            ],
                            meta: {
                                harness_id: "m",
                                ordinal: 1,
                                synthetic: false,
                                summary: false,
                                errored: false,
                            },
                        },
                    },
                ];
                expect(JSON.stringify(encodeOpenCodeMessagesToCk([raw]))).toBe(JSON.stringify(old));
            }
        }
    }
});

test("attachment review: state list wins over part alias and an absent state list falls back", () => {
    const attachment = { type: "file", mime: "image/png", url: "data:image/png;base64,aW1n" };
    for (const stateAttachments of [undefined, []]) {
        const raw = {
            info: { id: "m", role: "assistant" },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "call",
                    attachments: [attachment],
                    state: {
                        status: "completed",
                        input: {},
                        output: "Read",
                        ...(stateAttachments === undefined
                            ? {}
                            : { attachments: stateAttachments }),
                    },
                },
            ],
        };
        const kind = (
            encodeOpenCodeMessagesToCk([raw])[0]!.ck.content[1] as {
                kind: { output: { kind: { type: string; blocks?: unknown[] } } };
            }
        ).kind.output.kind;
        expect(kind.type).toBe(stateAttachments === undefined ? "content" : "text");
        if (stateAttachments === undefined) expect(kind.blocks).toHaveLength(2);
    }
});
