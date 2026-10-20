import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeTodoStateJson } from "../hooks/magic-context/todo-view";
import {
    isSuccessfulProviderCompletion,
    providerResponseFailed,
} from "./provider-response-completion";

// ck-mc's runner-lane usage and todo policies are ported from the TypeScript
// event handler and host bridge. The Rust tests read these same committed
// fixtures, so a change on either side that is not mirrored fails here or there.
function fixture<T>(name: string): T {
    return JSON.parse(
        readFileSync(
            resolve(import.meta.dir, `../../../../crates/mc-module/testdata/${name}`),
            "utf8",
        ),
    ) as T;
}

describe("runner-lane policy fixtures shared with ck-mc", () => {
    it("classifies provider responses the way the Rust usage policy does", () => {
        const vectors = fixture<{
            response_completion: Array<{
                label: string;
                finish: string | null;
                error: boolean;
                completed_at: number | null;
                failed: boolean;
                successful: boolean;
            }>;
        }>("runner-usage-policy-vectors.json");
        expect(vectors.response_completion.length).toBeGreaterThan(0);
        for (const vector of vectors.response_completion) {
            const input = {
                finish: vector.finish ?? undefined,
                error: vector.error ? { message: "provider error" } : undefined,
                completedAt: vector.completed_at ?? undefined,
            };
            expect(providerResponseFailed(input), vector.label).toBe(vector.failed);
            expect(isSuccessfulProviderCompletion(input), vector.label).toBe(vector.successful);
        }
    });

    it("normalizes the transcript's todowrite and the todo_state.set todos to the same state", () => {
        const todo = fixture<{
            todo_state_set: { todos: unknown };
            expected_state_json: string;
            transcript: Array<{
                message: {
                    content: Array<{
                        type: string;
                        tool_name?: string;
                        input?: { todos?: unknown };
                    }>;
                };
            }>;
        }>("runner-todo-transcript.json");
        expect(normalizeTodoStateJson(todo.todo_state_set.todos)).toBe(todo.expected_state_json);
        const call = todo.transcript
            .flatMap((entry) => entry.message.content)
            .find((block) => block.type === "tool_call" && block.tool_name === "todowrite");
        expect(call).toBeDefined();
        expect(normalizeTodoStateJson(call?.input?.todos)).toBe(todo.expected_state_json);
    });
});
