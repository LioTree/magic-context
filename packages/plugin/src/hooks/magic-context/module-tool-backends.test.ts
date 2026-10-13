import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { createModuleToolBackends } from "./module-tool-backends";
import type { RustModeModuleClient } from "./rust-mode-transform";

for (const wrapped of [false, true]) {
    test(`module curate preserves canonical and superseded ids from ${wrapped ? "wrapped" : "direct"} receipts`, async () => {
        const db = new Database(":memory:");
        const calls: Parameters<RustModeModuleClient["call"]>[0][] = [];
        try {
            const { backends } = createModuleToolBackends({
                db,
                directory: "/repo",
                memorySyncRequestedSessions: new Set(),
                moduleClient: {
                    call: async (args) => {
                        calls.push(args);
                        const result = {
                            structuredContent: {
                                state: "applied",
                                memory_id: 9,
                                superseded_ids: [7, 8],
                                error_code: null,
                            },
                            content: [
                                {
                                    type: "text",
                                    text: "Merged memories [7, 8] into canonical memory [ID: 999] in CONSTRAINTS; superseded [70].",
                                },
                            ],
                        };
                        return wrapped ? { result } : result;
                    },
                },
            })!;
            const receipt = await backends.curateMemory!({
                key: "curate-command",
                projectRoot: "/repo",
                projectPath: "git:repo",
                sourceSessionId: "child",
                operation: "merge",
                targets: [
                    { id: 7, revision: 1 },
                    { id: 8, revision: 2 },
                ],
                content: "Merged rule.",
            });
            expect(receipt).toMatchObject({
                state: "applied",
                adoptionClass: "deferred",
                memoryId: 9,
                supersededIds: [7, 8],
            });
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
                sessionId: "child",
                projectRoot: "/repo",
                method: "memory.curate",
                body: {
                    name: "memory.curate",
                    arguments: {
                        memory_project: "git:repo",
                        command_id: "curate-command",
                        action: "merge",
                        ids: [7, 8],
                        expected_revisions: [
                            { id: 7, revision: 1 },
                            { id: 8, revision: 2 },
                        ],
                    },
                },
            });
        } finally {
            db.close();
        }
    });
}

for (const error of ["refused", "invalid receipt"]) {
    test(`module curate propagates ${error} instead of claiming an applied edit`, async () => {
        const db = new Database(":memory:");
        try {
            const { backends } = createModuleToolBackends({
                db,
                directory: "/repo",
                memorySyncRequestedSessions: new Set(),
                moduleClient: {
                    call: async () =>
                        error === "refused"
                            ? {
                                  isError: false,
                                  structuredContent: {
                                      state: "refused",
                                      memory_id: null,
                                      superseded_ids: [],
                                      error_code: "authority_refused",
                                  },
                                  content: [
                                      {
                                          text: "Archived memory IDs []: refusal (authority_refused).",
                                      },
                                  ],
                              }
                            : {},
                },
            })!;
            await expect(
                backends.curateMemory!({
                    key: "curate-command",
                    projectRoot: "/repo",
                    projectPath: "git:repo",
                    sourceSessionId: "child",
                    operation: "archive",
                    targets: [{ id: 7, revision: 1 }],
                }),
            ).rejects.toThrow(
                error === "refused" ? "authority_refused" : "Invalid module curate response",
            );
        } finally {
            db.close();
        }
    });
}

for (const [name, patch] of [
    ["missing state", { state: undefined }],
    ["unknown state", { state: "completed" }],
    ["missing memory id", { memory_id: undefined }],
    ["zero memory id", { memory_id: 0 }],
    ["negative memory id", { memory_id: -1 }],
    ["fractional memory id", { memory_id: 7.5 }],
    ["unsafe memory id", { memory_id: Number.MAX_SAFE_INTEGER + 1 }],
    ["string memory id", { memory_id: "7" }],
    ["missing superseded ids", { superseded_ids: undefined }],
    ["non-array superseded ids", { superseded_ids: "8" }],
    ["string superseded id", { superseded_ids: ["8"] }],
    ["sparse superseded ids", { superseded_ids: Array(1) }],
    ["duplicate superseded ids", { superseded_ids: [8, 8] }],
    ["self supersession", { superseded_ids: [7] }],
    ["missing error code", { error_code: undefined }],
    ["error code on applied receipt", { error_code: "stale_revision" }],
    ["refused receipt with an id", { state: "refused", error_code: "stale_revision" }],
    ["refused receipt without a code", { state: "refused", memory_id: null, error_code: null }],
] as const) {
    test(`module curate rejects malformed typed receipt: ${name}`, async () => {
        const db = new Database(":memory:");
        try {
            const { backends } = createModuleToolBackends({
                db,
                directory: "/repo",
                memorySyncRequestedSessions: new Set(),
                moduleClient: {
                    call: async () => ({
                        structuredContent: {
                            state: "applied",
                            memory_id: 7,
                            superseded_ids: [],
                            error_code: null,
                            ...patch,
                        },
                        content: [{ text: "Archived memory IDs [7]." }],
                    }),
                },
            })!;
            await expect(
                backends.curateMemory!({
                    key: "curate-command",
                    projectRoot: "/repo",
                    projectPath: "git:repo",
                    sourceSessionId: "child",
                    operation: "archive",
                    targets: [{ id: 7, revision: 1 }],
                }),
            ).rejects.toThrow("Invalid module curate response");
        } finally {
            db.close();
        }
    });
}

for (const isError of [true, "false", null]) {
    test(`module curate rejects inconsistent error flag ${JSON.stringify(isError)}`, async () => {
        const db = new Database(":memory:");
        try {
            const { backends } = createModuleToolBackends({
                db,
                directory: "/repo",
                memorySyncRequestedSessions: new Set(),
                moduleClient: {
                    call: async () => ({
                        isError,
                        structuredContent: {
                            state: "applied",
                            memory_id: 7,
                            superseded_ids: [],
                            error_code: null,
                        },
                    }),
                },
            })!;
            await expect(
                backends.curateMemory!({
                    key: "curate-command",
                    projectRoot: "/repo",
                    projectPath: "git:repo",
                    sourceSessionId: "child",
                    operation: "update",
                    targets: [{ id: 7, revision: 1 }],
                }),
            ).rejects.toThrow("Invalid module curate response");
        } finally {
            db.close();
        }
    });
}
