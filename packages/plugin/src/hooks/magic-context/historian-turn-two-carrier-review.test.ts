/**
 * Independent review of memory slice S6 (historian turn two), commit dafaede1:
 * the OpenCode 2 carrier. Report: docs/reports/memory-s6-review.md.
 *
 * Part of the normal suite. Both tests drive the production OpenCode 2
 * hidden-completion executor and hidden-child context hook over a fake host whose
 * drafts carry the child's whole history, as the real host's do. They failed at
 * dafaede1 (findings P1-1 and P1-2).
 */
import { describe, expect, test } from "bun:test";
import {
    CHECK_SYSTEM_PROMPTS,
    type CheckRequest,
} from "../../features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "../../features/magic-context/memory/lifecycle-text";
import { Database } from "../../shared/sqlite";
import type { HiddenChildRows } from "../../v2/hidden-child-record";
import { createV2HiddenCompletionExecutor, type HiddenChildHost } from "../../v2/hidden-completion";
import { HIDDEN_HISTORIAN_AGENT, HiddenChildHook } from "../../v2/hooks/hidden-child";
import type { SessionContext } from "../../v2/hooks/types";
import type { StoreRow } from "../../v2/store-reader";
import type { HiddenRunHandle, RetainedHistorianChild } from "./compartment-runner-types";
import { createOpenCodeTurnTwoCarrier } from "./historian-turn-two-carrier";

const TURN_ONE_PROMPT = "TURN-ONE-PROMPT: summarize messages 1-40";
const TURN_ONE_REPLY = "<compartments>TURN-ONE-REPLY</compartments>";
const SYSTEM = "historian system prompt";

async function oc2() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hook = new HiddenChildHook();
    let seq = 0;
    const assistants = new Map<string, StoreRow<"assistant">[]>();
    const rows: HiddenChildRows = {
        latestSequence: (id) => assistants.get(id)?.at(-1)?.seq ?? -1,
        latestAssistant: (id) => assistants.get(id)?.at(-1),
        latestIdle: () => undefined,
    };
    // Every child keeps its conversation, and each draft the host builds carries it.
    const history = new Map<string, SessionContext["messages"]>();
    const shaped: SessionContext[] = [];
    let next = 0;
    const host = {
        async create() {
            return { id: `oc2-child-${++next}` };
        },
        async get() {
            return { model: { providerID: "mock", id: "cheap" } };
        },
        async switchModel() {},
        async prompt(input: { sessionID: string; text: string }) {
            const prior = history.get(input.sessionID) ?? [];
            const draft: SessionContext = {
                sessionID: input.sessionID,
                model: { providerID: "mock", id: "cheap" },
                agent: HIDDEN_HISTORIAN_AGENT,
                system: [{ type: "text", text: "host system" }],
                tools: {},
                options: {},
                messages: [
                    ...prior,
                    { role: "user", content: [{ type: "text", text: input.text }] },
                ],
            };
            hook.apply(draft);
            shaped.push(structuredClone(draft));
            const sent = JSON.stringify(draft.messages);
            const text = sent.includes("Operands:")
                ? JSON.stringify({ verdicts: [] })
                : sent.includes("Turn two")
                  ? JSON.stringify({ decisions: [] })
                  : TURN_ONE_REPLY;
            history.set(input.sessionID, [
                ...prior,
                { role: "user", content: [{ type: "text", text: input.text }] },
                { role: "assistant", content: [{ type: "text", text }] },
            ]);
            const row = {
                id: `m-${++seq}`,
                session_id: input.sessionID,
                type: "assistant",
                seq,
                data: {
                    content: [{ type: "text", text }],
                    finish: "stop",
                    model: { providerID: "mock", id: "cheap" },
                    tokens: { input: 1, output: 1 },
                    time: { created: Date.now(), completed: Date.now() },
                },
            } as unknown as StoreRow<"assistant">;
            assistants.set(input.sessionID, [...(assistants.get(input.sessionID) ?? []), row]);
        },
        async wait() {},
        async interrupt() {
            return { interrupted: true };
        },
        async update() {},
        async removeSession() {},
    } as unknown as HiddenChildHost;
    const executor = await createV2HiddenCompletionExecutor(host, {
        db,
        projectIdentity: "/review",
        directory: "/review",
        hook,
        openReader: () => rows,
    });
    // Turn one on a historian child, kept open as the runner does on an enabled lane.
    const handle: HiddenRunHandle = await executor.open({
        parentSessionId: "ses-parent",
        agent: HIDDEN_HISTORIAN_AGENT,
        kind: "historian",
        system: SYSTEM,
        model: "mock/cheap",
        timeoutMs: 2000,
        title: "historian",
        directory: "/review",
    });
    await executor.attempt(handle, {
        path: { id: handle.id },
        body: {
            agent: HIDDEN_HISTORIAN_AGENT,
            system: SYSTEM,
            model: { providerID: "mock", modelID: "cheap" },
            parts: [{ type: "text", text: TURN_ONE_PROMPT, synthetic: true }],
        },
    } as never);
    const turnOne = await executor.collect(handle, 50);
    expect(turnOne.text).toBe(TURN_ONE_REPLY);
    const settle = { promptSettled: true, privacySensitive: false, context: "review", log() {} };
    const child: RetainedHistorianChild = {
        executor,
        handle,
        agent: HIDDEN_HISTORIAN_AGENT,
        system: SYSTEM,
        model: "mock/cheap",
        directory: "/review",
        turnOneText: TURN_ONE_REPLY,
        close: () => executor.close(handle, settle),
    };
    const carrier = createOpenCodeTurnTwoCarrier({
        child,
        parentSessionId: "ses-parent",
        harness: "opencode2",
        carrier: "hidden-completion",
        enforcedJson: true,
        turnOneText: TURN_ONE_REPLY,
        timeoutMs: 2000,
    });
    return { db, child, carrier, shaped };
}

describe("S6 review witnesses: OpenCode 2 carrier (failed at dafaede1)", () => {
    test("review witness: on OpenCode 2 a narrow check can start while turn one's child is retained", async () => {
        const { db, child, carrier } = await oc2();
        const system = CHECK_SYSTEM_PROMPTS["kept-clause"];
        const request: CheckRequest = {
            key: "review-check",
            system,
            systemHash: lifecycleTextHash(system),
            kind: "kept-clause",
            operands: [{ id: "[1,1,1]", text: "Keep rule." }],
            pairs: [],
            input: "[42] user: New rule.",
        };
        const pending = carrier.check(request).then(
            () => "settled",
            () => "settled",
        );
        const outcome = await Promise.race([
            pending,
            new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1500)),
        ]);
        // Release the retained child so the queued check can finish and the test exits.
        await child.close();
        await pending;
        db.close();
        // At dafaede1 the check child's open() waits for the executor's "historian"
        // role, which turn one's retained child holds until turn two returns: the
        // first check of an edit never starts.
        expect(outcome).toBe("settled");
    }, 10_000);

    test("review witness: on OpenCode 2 the turn-two request carries turn one's prompt and reply", async () => {
        const { db, child, carrier, shaped } = await oc2();
        try {
            const reply = await carrier.send("Turn two: reconcile each candidate fact.", "stage");
            expect(reply.text).toBe(JSON.stringify({ decisions: [] }));
            const sent = JSON.stringify(shaped.at(-1)?.messages ?? []);
            expect(sent).toContain("Turn two: reconcile");
            // The spec appends turn two to the same conversation, after turn one's
            // prompt and reply. At dafaede1 the hidden-child hook replaces the
            // child's history with the new prompt alone.
            expect(sent).toContain(TURN_ONE_PROMPT);
            expect(sent).toContain("TURN-ONE-REPLY");
        } finally {
            await child.close();
            db.close();
        }
    }, 10_000);
});
