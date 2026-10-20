import { expect, test } from "bun:test";
import type { Hooks } from "@opencode-ai/plugin";
import { BRIDGED_SESSIONS_KEY } from "../shared/bridged-sessions";
import { standDownForBridgedSessions } from "./bridged-session-guard";

test("enrolled OC1 messages and system hooks leave served bytes untouched across turns", async () => {
    const session = "oc1-enrolled-stand-down";
    const registry = globalThis as unknown as Record<symbol, unknown>;
    const previous = registry[BRIDGED_SESSIONS_KEY];
    const bridged = new Map([[session, { product: "thalamus", version: "test" }]]);
    registry[BRIDGED_SESSIONS_KEY] = bridged;
    let pluginCalls = 0;
    const plugin = standDownForBridgedSessions({
        "experimental.chat.messages.transform": async () => {
            pluginCalls++;
        },
        "experimental.chat.system.transform": async () => {
            pluginCalls++;
        },
    } as Hooks);
    try {
        for (const phase of ["served", "deadline", "recovered"]) {
            const output = {
                messages: [
                    {
                        info: { id: `message-${phase}`, sessionID: session, role: "user" },
                        parts: [{ type: "text", text: `§1§ ${phase} history` }],
                    },
                ],
            };
            const systemOutput = { system: [`${phase} managed prompt guidance`] };
            const before = JSON.stringify({ output, systemOutput });
            await plugin["experimental.chat.messages.transform"]!({}, output as never);
            await plugin["experimental.chat.system.transform"]!(
                { sessionID: session } as never,
                systemOutput,
            );
            expect(JSON.stringify({ output, systemOutput })).toBe(before);
            expect(pluginCalls).toBe(0);
        }
        bridged.delete(session);
        await plugin["experimental.chat.messages.transform"]!({}, {
            messages: [{ info: { sessionID: session }, parts: [] }],
        } as never);
        await plugin["experimental.chat.system.transform"]!({ sessionID: session } as never, {
            system: [],
        });
        expect(pluginCalls).toBe(2);
    } finally {
        if (previous === undefined) Reflect.deleteProperty(registry, BRIDGED_SESSIONS_KEY);
        else registry[BRIDGED_SESSIONS_KEY] = previous;
    }
});
