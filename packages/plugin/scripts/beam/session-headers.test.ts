import { expect, test } from "bun:test";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { BEAM_SESSION_HEADER, BEAM_WORKSPACE_HEADER } from "./cloud-code";
import { BeamSessionHeadersPlugin } from "./session-headers";

test("the host header hook forwards the actual child session and workspace only to the loopback historian route", async () => {
    const hooks = await BeamSessionHeadersPlugin({
        directory: "/tmp/beam/work with spaces",
    } as PluginInput);
    const input = { sessionID: "ses_child_a", model: { providerID: "google" } } as Parameters<
        NonNullable<Hooks["chat.headers"]>
    >[0];
    const output: { headers: Record<string, string> } = {
        headers: { "existing-header": "unchanged" },
    };
    await hooks["chat.headers"]?.(input, output);
    expect(output.headers).toEqual({
        "existing-header": "unchanged",
        [BEAM_SESSION_HEADER]: "ses_child_a",
        [BEAM_WORKSPACE_HEADER]: "file:///tmp/beam/work%20with%20spaces",
    });
    const answerHeaders = { headers: {} };
    await hooks["chat.headers"]?.(
        { ...input, model: { ...input.model, providerID: "openai" } },
        answerHeaders,
    );
    expect(answerHeaders.headers).toEqual({});
});
