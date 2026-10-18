import { pathToFileURL } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { BEAM_SESSION_HEADER, BEAM_WORKSPACE_HEADER } from "./cloud-code";

/**
 * Identify the memory-building model's child session through loopback HTTP headers, not prompt
 * text. The relay consumes these headers locally and never forwards them to the model service.
 */
export const BeamSessionHeadersPlugin: Plugin = async ({ directory }) => ({
    "chat.headers": async (input, output) => {
        if (input.model.providerID !== "google") return;
        output.headers[BEAM_SESSION_HEADER] = input.sessionID;
        output.headers[BEAM_WORKSPACE_HEADER] = pathToFileURL(directory).href;
    },
});
