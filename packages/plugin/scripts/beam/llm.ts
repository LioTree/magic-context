/**
 * A direct client for the ChatGPT Codex backend (OpenAI Responses API over SSE), used for the
 * Vanilla arm's answers and for every judge call. The Magic Context arm's answers go through the
 * OpenCode host instead.
 *
 * Message mapping follows the released BEAM code's chat messages: a system message becomes the
 * Responses `instructions` field verbatim (the Codex backend takes system text there), user and
 * assistant messages become input messages in order. Nothing else is added to the text.
 *
 * Errors are not retried in a loop: 401/403 raise `AuthRejectedError` (the run stops; the vault is
 * never told), 429 raises `RateLimitedError` (the provider's answer, the run stops and can resume),
 * and only network failures and 5xx get two more attempts.
 */
export class AuthRejectedError extends Error {}
export class RateLimitedError extends Error {}

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface Usage {
    input: number;
    cachedInput: number;
    output: number;
    reasoning: number;
}

export interface CodexSettings {
    baseURL: string;
    credentials(): Promise<{ token: string; accountId: string }>;
    model: string;
    /** `reasoning.effort`; omitted when undefined. */
    reasoningEffort?: string;
    /** Sent as `temperature` when defined. */
    temperature?: number;
}

export function emptyUsage(): Usage {
    return { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
}

export function addUsage(into: Usage, more: Usage): Usage {
    into.input += more.input;
    into.cachedInput += more.cachedInput;
    into.output += more.output;
    into.reasoning += more.reasoning;
    return into;
}

export function codexRequestBody(
    settings: CodexSettings,
    messages: ChatMessage[],
): Record<string, unknown> {
    const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content);
    const body: Record<string, unknown> = {
        model: settings.model,
        ...(system.length > 0 ? { instructions: system.join("\n") } : {}),
        input: messages
            .filter((message) => message.role !== "system")
            .map((message) => ({
                role: message.role,
                content: [
                    {
                        type: message.role === "assistant" ? "output_text" : "input_text",
                        text: message.content,
                    },
                ],
            })),
        store: false,
        stream: true,
    };
    if (settings.reasoningEffort) body.reasoning = { effort: settings.reasoningEffort };
    if (settings.temperature !== undefined) body.temperature = settings.temperature;
    return body;
}

/** Read a Responses SSE stream into the final text and usage. */
export function parseResponsesStream(text: string): { text: string; usage: Usage; status: string } {
    let output = "";
    let usage = emptyUsage();
    let status = "unknown";
    let completedText: string | null = null;
    for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(payload) as Record<string, unknown>;
        } catch {
            continue;
        }
        if (event.type === "response.output_text.delta" && typeof event.delta === "string")
            output += event.delta;
        if (
            event.type === "response.completed" ||
            event.type === "response.incomplete" ||
            event.type === "response.failed"
        ) {
            const response = event.response as Record<string, unknown> | undefined;
            status = String(response?.status ?? event.type);
            const raw = response?.usage as Record<string, unknown> | undefined;
            if (raw) {
                usage = {
                    input: Number(raw.input_tokens ?? 0),
                    cachedInput: Number(
                        (raw.input_tokens_details as Record<string, unknown> | undefined)
                            ?.cached_tokens ?? 0,
                    ),
                    output: Number(raw.output_tokens ?? 0),
                    reasoning: Number(
                        (raw.output_tokens_details as Record<string, unknown> | undefined)
                            ?.reasoning_tokens ?? 0,
                    ),
                };
            }
            const items = (response?.output as Record<string, unknown>[] | undefined) ?? [];
            const texts = items
                .filter((item) => item.type === "message")
                .flatMap((item) => (item.content as Record<string, unknown>[] | undefined) ?? [])
                .filter((part) => part.type === "output_text" && typeof part.text === "string")
                .map((part) => part.text as string);
            if (texts.length > 0) completedText = texts.join("");
        }
        if (event.type === "error") status = "error";
    }
    return { text: completedText ?? output, usage, status };
}

export async function codexComplete(
    settings: CodexSettings,
    messages: ChatMessage[],
    timeoutMs = 600_000,
): Promise<{ text: string; usage: Usage }> {
    const body = JSON.stringify(codexRequestBody(settings, messages));
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
        // Resolve outside the transport retry handler: a vault refusal must stop the run.
        const credential = await settings.credentials();
        let response: Response;
        try {
            response = await fetch(`${settings.baseURL}/responses`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "text/event-stream",
                    authorization: `Bearer ${credential.token}`,
                    "chatgpt-account-id": credential.accountId,
                },
                body,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            lastError = error;
            await Bun.sleep(2000 * attempt);
            continue;
        }
        if (response.status === 401 || response.status === 403) {
            throw new AuthRejectedError(
                `Codex backend rejected the credential (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`,
            );
        }
        if (response.status === 429)
            throw new RateLimitedError(
                `Codex backend: HTTP 429 ${(await response.text()).slice(0, 300)}`,
            );
        if (response.status >= 500) {
            lastError = new Error(`Codex backend: HTTP ${response.status}`);
            await Bun.sleep(2000 * attempt);
            continue;
        }
        const text = await response.text();
        if (!response.ok)
            throw new Error(
                `Codex backend refused the request (HTTP ${response.status}): ${text.slice(0, 500)}`,
            );
        const parsed = parseResponsesStream(text);
        if (parsed.status !== "completed")
            throw new Error(`Codex response ended with status ${parsed.status}`);
        return { text: parsed.text, usage: parsed.usage };
    }
    throw new Error(`Codex backend unreachable after 3 attempts: ${String(lastError)}`);
}
