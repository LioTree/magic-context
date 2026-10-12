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
                            content: [
                                {
                                    type: "text",
                                    text: "Merged memories [7, 8] into canonical memory [ID: 9] in CONSTRAINTS; superseded [7, 8].",
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
                            ? { isError: true, content: [{ text: "authority refused" }] }
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
                error === "refused" ? "authority refused" : "Invalid module curate response",
            );
        } finally {
            db.close();
        }
    });
}
