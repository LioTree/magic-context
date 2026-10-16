import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getPersistedTodoSyntheticAnchor,
    openDatabase,
    setPersistedTodoSyntheticAnchor,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createEditAdmission, isAdmissionUser, thinkingAnchor } from "./edit-admission";
import { buildSyntheticTodoPart } from "./todo-view";
import type { MessageLike } from "./transform-operations";
import { applyTodoSynthesis } from "./transform-postprocess-phase";

const oldState = JSON.stringify([
    { content: "Inspect parser", status: "pending", priority: "high" },
]);
const newState = JSON.stringify([
    { content: "Repair parser", status: "pending", priority: "high" },
]);
const doneState = JSON.stringify([{ content: "Done", status: "completed", priority: "high" }]);
const sessionId = "todo-admission";

const tempDirs: string[] = [];
afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs) cleanupTestTempDir(dir);
    tempDirs.length = 0;
    process.env.XDG_DATA_HOME = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
});

function fixture(anchor = "old") {
    const dir = createTestTempDirFromPath(join(tmpdir(), "todo-admission-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    const part = buildSyntheticTodoPart(oldState)!;
    setPersistedTodoSyntheticAnchor(db, sessionId, part.callID, anchor, oldState);
    const messages = (): MessageLike[] => [
        { info: { id: "old", role: "assistant" }, parts: [{ type: "text", text: "History" }] },
        { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "Continue" }] },
        {
            info: { id: "boundary", role: "assistant" },
            parts: [
                {
                    type: "reasoning",
                    text: "Thinking",
                    metadata: { anthropic: { signature: "signed" } },
                },
            ],
        },
        { info: { id: "tail", role: "assistant" }, parts: [{ type: "text", text: "Tail" }] },
    ];
    const run = async (input: MessageLike[], state: string, bust = true, denied = false) => {
        updateSessionMeta(db, sessionId, { lastTodoState: state });
        const editAdmission = createEditAdmission({
            messages: input,
            stableId: (m) => m.info.id,
            partsOf: (m) => m.parts,
            isRealUser: isAdmissionUser,
            prefixBound: true,
            isRetainedThinking: (_m, p) => thinkingAnchor(p) !== undefined,
            anchorOf: thinkingAnchor,
        });
        await applyTodoSynthesis({
            db,
            sessionId,
            messages: input,
            fullFeatureMode: true,
            isCacheBustingPass: bust,
            editAdmission,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            todowriteAvailability: { frozen: true, callable: !denied },
        });
        return input;
    };
    return { db, messages, run, anchor: () => getPersistedTodoSyntheticAnchor(db, sessionId) };
}

describe("todo compound admission", () => {
    for (const [name, state, denied] of [
        ["replacement", newState, false],
        ["terminal-state clear", doneState, false],
        ["permission clear", oldState, true],
    ] as const) {
        it(`holds ${name} before thinking without changing the persisted pair`, async () => {
            const f = fixture();
            const before = f.anchor();
            const held = await f.run(f.messages(), state, true, denied);
            expect(f.anchor()).toEqual(before);
            expect(JSON.stringify(held)).toContain("Inspect parser");
            expect(await f.run(f.messages(), state, false, denied)).toEqual(held);
            const releasedInput = f.messages();
            releasedInput.push({
                info: { id: "next-user", role: "user" },
                parts: [{ type: "text", text: "Next" }],
            });
            const released = await f.run(releasedInput, state, true, denied);
            if (state === newState) {
                expect(f.anchor()?.messageId).toBe("tail");
                expect(JSON.stringify(released)).toContain("Repair parser");
            } else {
                expect(f.anchor()).toBeNull();
                expect(JSON.stringify(released)).not.toContain("Inspect parser");
            }
        });
    }

    it("holds missing-anchor reattachment and clear while a boundary remains", async () => {
        const f = fixture("missing");
        const before = f.anchor();
        await f.run(f.messages(), newState);
        expect(f.anchor()).toEqual(before);
        await f.run(f.messages(), doneState);
        expect(f.anchor()).toEqual(before);
    });

    it("admits replacement and removal when the old anchor is after thinking", async () => {
        const f = fixture("tail");
        expect(JSON.stringify(await f.run(f.messages(), newState))).toContain("Repair parser");
        expect(f.anchor()?.stateJson).toBe(newState);
        await f.run(f.messages(), doneState);
        expect(f.anchor()).toBeNull();
    });
});
