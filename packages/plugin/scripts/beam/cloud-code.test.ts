import { describe, expect, test } from "bun:test";
import {
    CLOUD_CODE_FIELD_ALLOWLIST,
    cloudCodeUserAgent,
    HISTORIAN_VARIANTS,
    newHistorianSession,
    workspaceSessionId,
    wrapCloudCodeRequest,
} from "./cloud-code";

const session = {
    workspaceUri: "file:///tmp/beam/work",
    conversationUuid: "11111111-1111-4111-8111-111111111111",
    trajectoryUuid: "22222222-2222-4222-8222-222222222222",
};

/** Compare the wire payload itself, allowing only the explicitly named transport fields. */
function assertFidelity(host: Record<string, unknown>, wire: Record<string, unknown>) {
    for (const key of ["contents", "systemInstruction", "tools"]) {
        expect(JSON.stringify(wire[key])).toBe(JSON.stringify(host[key]));
    }
    const changes = (before: unknown, after: unknown, path = ""): string[] => {
        if (JSON.stringify(before) === JSON.stringify(after)) return [];
        if (CLOUD_CODE_FIELD_ALLOWLIST.some((allowed) => allowed === path)) return [path];
        if (
            (before === undefined ||
                (before && typeof before === "object" && !Array.isArray(before))) &&
            after &&
            typeof after === "object" &&
            !Array.isArray(after)
        ) {
            const a = (before ?? {}) as Record<string, unknown>;
            const b = after as Record<string, unknown>;
            return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
                changes(a[key], b[key], path ? `${path}.${key}` : key),
            );
        }
        return [path];
    };
    const changed = changes(host, wire);
    expect(
        changed.filter((path) => !CLOUD_CODE_FIELD_ALLOWLIST.some((allowed) => allowed === path)),
    ).toEqual([]);
    return changed;
}

describe("native Cloud Code envelope", () => {
    test("fidelity allowlist preserves prompt bytes and enumerates every transport change", () => {
        expect([...CLOUD_CODE_FIELD_ALLOWLIST]).toEqual([
            "toolConfig.functionCallingConfig.mode",
            "labels",
            "generationConfig.thinkingConfig",
            "generationConfig.maxOutputTokens",
            "sessionId",
        ]);
        for (const tools of [false, true]) {
            const host = {
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: "Unicode 日 and newlines\n and $&" },
                            { text: "second part" },
                        ],
                    },
                ],
                systemInstruction: { parts: [{ text: "unchanged system" }] },
                ...(tools
                    ? {
                          tools: [
                              {
                                  functionDeclarations: [
                                      { name: "f", parameters: { type: "OBJECT" } },
                                  ],
                              },
                          ],
                          toolConfig: {
                              functionCallingConfig: { mode: "AUTO", allowedFunctionNames: ["f"] },
                          },
                      }
                    : {}),
                generationConfig: {
                    temperature: 0.25,
                    topP: 0.7,
                    maxOutputTokens: 12,
                    thinkingConfig: { thinkingBudget: 5 },
                },
                labels: { old: "value" },
                sessionId: "old",
            };
            const before = JSON.stringify(host);
            const wrapped = wrapCloudCodeRequest("medium", "fake-project", host, session, 1234);
            const wire = wrapped.request as Record<string, unknown>;
            expect(assertFidelity(host, wire).sort()).toEqual(
                CLOUD_CODE_FIELD_ALLOWLIST.filter(
                    (field) => tools || !field.startsWith("toolConfig"),
                ).sort(),
            );
            expect(JSON.stringify(host)).toBe(before);
            expect(Object.keys(wrapped)).toEqual([
                "project",
                "requestId",
                "request",
                "model",
                "userAgent",
                "requestType",
            ]);
            expect(Object.keys(wire)).toEqual([
                "contents",
                "systemInstruction",
                ...(tools ? ["tools", "toolConfig"] : []),
                "labels",
                "generationConfig",
                "sessionId",
            ]);
            expect(wrapped.requestId).toBe(
                `agent/${session.conversationUuid}/1234/${session.trajectoryUuid}/1`,
            );
            expect(wire.labels).toEqual({
                last_step_index: "0",
                model_enum: "MODEL_PLACEHOLDER_M319",
                trajectory_id: session.trajectoryUuid,
                used_claude: "false",
                used_claude_conservative: "false",
                used_non_gemini_model: "false",
            });
            expect(Object.keys(wire.labels as object)).toEqual([
                "last_step_index",
                "model_enum",
                "trajectory_id",
                "used_claude",
                "used_claude_conservative",
                "used_non_gemini_model",
            ]);
        }
    });

    test.each([
        "low",
        "medium",
        "high",
    ] as const)("%s variant sends the matching model enum and thinking controls", (variant) => {
        const wrapped = wrapCloudCodeRequest(
            variant,
            "fake",
            { contents: [{ role: "user", parts: [{ text: "ok" }] }] },
            session,
        );
        expect(wrapped.model).toBe(HISTORIAN_VARIANTS[variant].model);
        const request = wrapped.request as Record<string, unknown>;
        const expected = (
            {
                low: [1000, "MODEL_PLACEHOLDER_M320"],
                medium: [4000, "MODEL_PLACEHOLDER_M319"],
                high: [-1, "MODEL_PLACEHOLDER_M318"],
            } as const
        )[variant];
        expect(request.generationConfig).toEqual({
            thinkingConfig: { thinkingBudget: expected[0], includeThoughts: true },
            maxOutputTokens: 65536,
        });
        expect((request.labels as Record<string, string>).model_enum).toBe(expected[1]);
        expect(request).not.toHaveProperty("tools");
        expect(request).not.toHaveProperty("toolConfig");
    });

    test("history steps count content turns rather than parts", () => {
        const wrapped = wrapCloudCodeRequest(
            "medium",
            "fake",
            {
                contents: [
                    { role: "user", parts: [{ text: "first" }, { text: "second" }] },
                    { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
                    { role: "user", parts: [{ functionResponse: { name: "f", response: {} } }] },
                ],
            },
            session,
            1234,
        );
        expect(
            (wrapped.request as { labels: { last_step_index: string } }).labels.last_step_index,
        ).toBe("2");
        expect(wrapped.requestId).toBe(
            `agent/${session.conversationUuid}/1234/${session.trajectoryUuid}/3`,
        );
    });

    test("refuses to rewrite a trailing model turn or discard an unknown host field", () => {
        expect(() =>
            wrapCloudCodeRequest(
                "medium",
                "fake",
                { contents: [{ role: "model", parts: [{ text: "ok" }] }] },
                session,
            ),
        ).toThrow("user turn");
        expect(() =>
            wrapCloudCodeRequest(
                "medium",
                "fake",
                { contents: [{ role: "user" }], unknown: "must not disappear" },
                session,
            ),
        ).toThrow("refusing to discard");
    });
});

test("workspace FNV-1a hash pins the signed empty-workspace and standard vectors", () => {
    expect(workspaceSessionId("")).toBe("-3750763034362895579");
    expect(workspaceSessionId("a")).toBe("-5808556873153909620");
    expect(workspaceSessionId("foobar")).toBe("-8821353812377114648");
    expect(newHistorianSession(session.workspaceUri).trajectoryUuid).not.toBe(
        newHistorianSession(session.workspaceUri).trajectoryUuid,
    );
});

test("native user-agent maps OS and architecture without client metadata headers", () => {
    expect(cloudCodeUserAgent("darwin", "arm64")).toBe(
        "antigravity/cli/1.3.5 (aidev_client; os_type=darwin; arch=arm64; cl=998863838; auth_method=consumer)",
    );
    expect(cloudCodeUserAgent("linux", "x64")).toContain("os_type=linux; arch=amd64;");
    expect(cloudCodeUserAgent("win32", "x64")).toContain("os_type=windows; arch=amd64;");
});
