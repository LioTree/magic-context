import { randomUUID } from "node:crypto";

export const BEAM_SESSION_HEADER = "x-beam-child-session-id";
export const BEAM_WORKSPACE_HEADER = "x-beam-workspace-uri";

export const HISTORIAN_VARIANTS = {
    low: {
        model: "gemini-3.8-flash-low",
        thinkingBudget: 1000,
        modelEnum: "MODEL_PLACEHOLDER_M320",
    },
    medium: {
        model: "gemini-3.8-flash-medium",
        thinkingBudget: 4000,
        modelEnum: "MODEL_PLACEHOLDER_M319",
    },
    high: {
        model: "gemini-3.8-flash-high",
        thinkingBudget: -1,
        modelEnum: "MODEL_PLACEHOLDER_M318",
    },
} as const;
export type HistorianVariant = keyof typeof HISTORIAN_VARIANTS;

/** The only host request fields the Cloud Code transport may add or override. */
export const CLOUD_CODE_FIELD_ALLOWLIST = [
    "toolConfig.functionCallingConfig.mode",
    "labels",
    "generationConfig.thinkingConfig",
    "generationConfig.maxOutputTokens",
    "sessionId",
] as const;

export interface HistorianSession {
    workspaceUri: string;
    conversationUuid: string;
    trajectoryUuid: string;
}

export function newHistorianSession(workspaceUri: string): HistorianSession {
    return { workspaceUri, conversationUuid: randomUUID(), trajectoryUuid: randomUUID() };
}

/** Native CLI session ids are signed-decimal FNV-1a 64 hashes of the workspace URI. */
export function workspaceSessionId(workspaceUri: string): string {
    let hash = 14695981039346656037n;
    for (const byte of Buffer.from(workspaceUri, "utf8")) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
    }
    return BigInt.asIntN(64, hash).toString();
}

export function cloudCodeUserAgent(platform = process.platform, arch = process.arch): string {
    const osType = platform === "win32" ? "windows" : platform;
    const architecture = arch === "x64" ? "amd64" : arch;
    if (
        !["darwin", "linux", "windows"].includes(osType) ||
        !["arm64", "amd64"].includes(architecture)
    ) {
        throw new Error(`Unsupported Cloud Code platform: ${platform}/${arch}`);
    }
    return `antigravity/cli/1.3.5 (aidev_client; os_type=${osType}; arch=${architecture}; cl=998863838; auth_method=consumer)`;
}

export function wrapCloudCodeRequest(
    variant: HistorianVariant,
    project: string,
    hostRequest: Record<string, unknown>,
    session: HistorianSession,
    timestampMs = Date.now(),
): Record<string, unknown> {
    const contents = hostRequest.contents as { role?: string }[] | undefined;
    if (!Array.isArray(contents) || contents.length === 0 || contents.at(-1)?.role !== "user") {
        throw new Error("Cloud Code history must end with an unchanged user turn");
    }
    const known = [
        "contents",
        "systemInstruction",
        "tools",
        "toolConfig",
        "labels",
        "generationConfig",
        "sessionId",
    ];
    if (Object.keys(hostRequest).some((key) => !known.includes(key))) {
        throw new Error("Unsupported Cloud Code request field; refusing to discard host data");
    }
    const model = HISTORIAN_VARIANTS[variant];
    const lastStepIndex = contents.length - 1;
    const tools = hostRequest.tools as unknown[] | undefined;
    const toolConfig = hostRequest.toolConfig as
        | { functionCallingConfig?: Record<string, unknown> }
        | undefined;
    if (!tools?.length && toolConfig) {
        throw new Error("Cloud Code toolConfig without tools cannot be forwarded unchanged");
    }
    return {
        project,
        requestId: `agent/${session.conversationUuid}/${timestampMs}/${session.trajectoryUuid}/${lastStepIndex + 1}`,
        request: {
            contents: hostRequest.contents,
            ...(hostRequest.systemInstruction !== undefined
                ? { systemInstruction: hostRequest.systemInstruction }
                : {}),
            ...(tools !== undefined ? { tools } : {}),
            ...(tools?.length
                ? {
                      toolConfig: {
                          ...toolConfig,
                          functionCallingConfig: {
                              ...toolConfig?.functionCallingConfig,
                              mode: "VALIDATED",
                          },
                      },
                  }
                : {}),
            labels: {
                last_step_index: String(lastStepIndex),
                model_enum: model.modelEnum,
                trajectory_id: session.trajectoryUuid,
                used_claude: "false",
                used_claude_conservative: "false",
                used_non_gemini_model: "false",
            },
            generationConfig: {
                ...(hostRequest.generationConfig as Record<string, unknown> | undefined),
                thinkingConfig: { thinkingBudget: model.thinkingBudget, includeThoughts: true },
                maxOutputTokens: 65536,
            },
            sessionId: workspaceSessionId(session.workspaceUri),
        },
        model: model.model,
        userAgent: "antigravity",
        requestType: "agent",
    };
}
