import type { HiddenCompletionExecutor } from "../hooks/magic-context/compartment-runner-types";
import type { DreamChildHost } from "../hooks/magic-context/dream-child-claimant";
import {
    createHiddenDreamChildHost,
    OPENCODE2_DREAM_AGENT_TOOLS,
    openCode2DreamChildCapabilities,
    openCode2Transcript,
} from "../hooks/magic-context/dream-child-hidden-host";
import { isSessionNotFound } from "./hidden-child-native";
import type { HiddenChildRows } from "./hidden-child-record";

/**
 * The OpenCode 2 carrier for a claimed dream child: the native hidden-child
 * executor this instance already runs its historian and dreamer on. Usage and
 * text come from the host's own assistant rows; retirement is the executor's
 * close (which removes the child unless `keep_subagents` keeps it) confirmed
 * by the host no longer finding the session.
 */
export function createOpenCode2DreamChildHost(args: {
    executor: HiddenCompletionExecutor;
    openReader: () => HiddenChildRows & { close?: () => void };
    getSession(input: { sessionID: string }): Promise<unknown>;
    directory: string;
    keepSubagents: boolean;
    log?(message: string): void;
}): DreamChildHost {
    return createHiddenDreamChildHost({
        executor: args.executor,
        capabilities: openCode2DreamChildCapabilities(args.keepSubagents),
        agentTools: OPENCODE2_DREAM_AGENT_TOOLS,
        directory: args.directory,
        ...(args.log ? { log: args.log } : {}),
        async transcript(childId) {
            const reader = args.openReader();
            try {
                const rows = reader.assistantSince
                    ? reader.assistantSince(childId, -1)
                    : [reader.latestAssistant(childId)].filter((row) => row !== undefined);
                return openCode2Transcript(rows);
            } finally {
                reader.close?.();
            }
        },
        async confirmRemoved(childId) {
            try {
                await args.getSession({ sessionID: childId });
                return false;
            } catch (error) {
                return isSessionNotFound(error);
            }
        },
    });
}
