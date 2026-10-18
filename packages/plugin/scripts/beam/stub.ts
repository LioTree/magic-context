/**
 * A local stand-in for every upstream the harness talks to, so the whole pipeline can be proven
 * without a real credential or a billed call:
 *
 * - the ChatGPT Codex backend (`POST /backend-api/codex/responses`, OpenAI Responses SSE);
 * - Cloud Code Assist (`POST /v1internal:streamGenerateContent?alt=sse` and `:generateContent`);
 * - the Voyage embeddings API (`POST /v1/embeddings`).
 *
 * Each request is checked against the credential shape it must carry (a Bearer token, the
 * `chatgpt-account-id` header, the Cloud Code `project` field) and recorded. Header VALUES are never
 * recorded: a header is stored as `present-matches`, `present-differs` or absent, so a saved record
 * cannot leak even a fake token.
 *
 * The scripted answers are just enough to drive the real code paths: the historian gets a valid v2
 * compartment covering exactly the ordinals it was shown plus one fact; the answer model calls
 * `ctx_search` once when that tool is offered and then answers; the judge returns a parseable
 * verdict; the equivalence detector answers YES when the two snippets share a word.
 */
import { createHash } from "node:crypto";

export interface StubExpectations {
    codexToken: string;
    codexAccountId: string;
    cloudCodeToken: string;
    cloudCodeProject: string;
    voyageKey: string;
}

export interface StubRecord {
    route: "codex" | "cloud-code" | "voyage" | "unknown";
    method: string;
    path: string;
    /** Header name -> `present-matches` | `present-differs`; only headers that carry credentials. */
    credentialHeaders: Record<string, "present-matches" | "present-differs">;
    /** Top-level keys of the JSON body, in order. */
    bodyKeys: string[];
    /** Credential-free body fields worth asserting on (model, project, store, instructions length ...). */
    bodyFacts: Record<string, unknown>;
    /** The full request body; it holds only dataset text and fake values. */
    body: unknown;
    status: number;
}

export interface Stub {
    origin: string;
    records: StubRecord[];
    /** When set, the Codex route answers 401 from the next request on, to test stop-on-rejection. */
    rejectCodex: boolean;
    stop(): void;
}

function credentialHeader(
    actual: string | null,
    expected: string,
): "present-matches" | "present-differs" | undefined {
    if (actual === null) return undefined;
    return actual === expected ? "present-matches" : "present-differs";
}

/** Every string anywhere in a JSON value, depth first. */
function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) strings(item, out);
    else if (value && typeof value === "object")
        for (const item of Object.values(value)) strings(item, out);
    return out;
}

const BLOCK_HEADER = /^\[(\d+)(?:-(\d+))?\] [A-Z]+:/gm;

/** The raw ordinal span inside a historian prompt's `<new_messages>` block, if any. */
export function historianRange(texts: string[]): { start: number; end: number } | null {
    for (const text of texts) {
        const opening = text.indexOf("<new_messages>");
        if (opening < 0) continue;
        const closing = text.indexOf("</new_messages>", opening);
        const scope = closing > opening ? text.slice(opening, closing) : text.slice(opening);
        let start = Number.POSITIVE_INFINITY;
        let end = 0;
        for (const header of scope.matchAll(BLOCK_HEADER)) {
            const first = Number(header[1]);
            start = Math.min(start, first);
            end = Math.max(end, header[2] === undefined ? first : Number(header[2]));
        }
        if (end > 0) return { start, end };
    }
    return null;
}

function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** A valid v2 historian output for one range, with one fact so promotion to memory can be observed. */
export function historianPayload(range: { start: number; end: number }): string {
    const summary = `Stub summary of messages ${range.start}-${range.end}.`;
    return [
        "<output>",
        "<compartments>",
        `<compartment start="${range.start}" end="${range.end}" title="Stub ${range.start}-${range.end}" importance="50" episode_type="feature">`,
        `<p1>${escapeXml(summary)}</p1>`,
        `<p2>${escapeXml(summary)}</p2>`,
        `<p3>${escapeXml(summary)}</p3>`,
        "<p4/>",
        "</compartment>",
        "</compartments>",
        "<facts>",
        "<PROJECT_RULES>",
        `* Stub fact recorded for messages ${range.start}-${range.end}.`,
        "</PROJECT_RULES>",
        "</facts>",
        "<events></events>",
        `<unprocessed_from>${range.end + 1}</unprocessed_from>`,
        "</output>",
    ].join("\n");
}

function sse(events: Record<string, unknown>[]): Response {
    const body = `${events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A complete Responses stream with one output item (a message or a function call). */
export function responsesStream(
    model: string,
    item: Record<string, unknown>,
    usage: { input: number; output: number },
): Response {
    const response = {
        id: `resp_${createHash("sha1").update(JSON.stringify(item)).digest("hex").slice(0, 12)}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model,
        output: [item],
        usage: {
            input_tokens: usage.input,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: usage.output,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: usage.input + usage.output,
        },
    };
    const events: Record<string, unknown>[] = [
        {
            type: "response.created",
            sequence_number: 0,
            response: { ...response, status: "in_progress", output: [], usage: null },
        },
        {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: {
                ...item,
                ...(item.type === "function_call" ? { arguments: "" } : { content: [] }),
                status: "in_progress",
            },
        },
    ];
    if (item.type === "message") {
        const text = ((item.content as { text: string }[])[0] as { text: string }).text;
        events.push(
            {
                type: "response.content_part.added",
                sequence_number: 2,
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
            },
            {
                type: "response.output_text.delta",
                sequence_number: 3,
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                delta: text,
                logprobs: [],
            },
            {
                type: "response.output_text.done",
                sequence_number: 4,
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                text,
                logprobs: [],
            },
            {
                type: "response.content_part.done",
                sequence_number: 5,
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text, annotations: [] },
            },
        );
    } else {
        events.push(
            {
                type: "response.function_call_arguments.delta",
                sequence_number: 2,
                item_id: item.id,
                output_index: 0,
                delta: item.arguments,
            },
            {
                type: "response.function_call_arguments.done",
                sequence_number: 3,
                item_id: item.id,
                output_index: 0,
                arguments: item.arguments,
            },
        );
    }
    events.push(
        {
            type: "response.output_item.done",
            sequence_number: 6,
            output_index: 0,
            item: { ...item, status: "completed" },
        },
        { type: "response.completed", sequence_number: 7, response },
    );
    return sse(events);
}

function textItem(text: string): Record<string, unknown> {
    return {
        id: `msg_${createHash("sha1").update(text).digest("hex").slice(0, 12)}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
    };
}

function words(text: string): Set<string> {
    return new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
}

/** The scripted Codex answer for one request body. */
function codexAnswer(body: Record<string, unknown>): Record<string, unknown> {
    const input = (body.input as Record<string, unknown>[] | undefined) ?? [];
    const all = strings(input);
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    if (all.some((text) => text.includes("RUBRIC CRITERION"))) {
        // Deterministic, varied verdicts so averaging is exercised.
        const digest = createHash("sha1").update(all.join("\n")).digest()[0] as number;
        const score = [0, 0.5, 1][digest % 3];
        return textItem(JSON.stringify({ score, reason: "stub verdict" }));
    }
    if ([instructions, ...all].some((text) => text.includes("binary classifier"))) {
        const user = all.find((text) => text.includes("First snippet:")) ?? "";
        const first = /First snippet: ([\s\S]*?) \n/.exec(user)?.[1] ?? "";
        const second = /Second snippet: ([\s\S]*?)\n/.exec(user)?.[1] ?? "";
        const shared = [...words(first)].some((word) => words(second).has(word));
        return textItem(shared ? "YES" : "NO");
    }
    const tools = (body.tools as { name?: string }[] | undefined) ?? [];
    const searched = input.some((item) => item.type === "function_call_output");
    if (tools.some((tool) => tool.name === "ctx_search") && !searched) {
        const question = [...all].reverse().find((text) => text.includes("Question:")) ?? "";
        const query = /Question: ([\s\S]*)$/.exec(question)?.[1]?.trim() ?? "stub";
        return {
            id: `fc_${createHash("sha1").update(query).digest("hex").slice(0, 12)}`,
            type: "function_call",
            call_id: `call_${createHash("sha1").update(`${query}call`).digest("hex").slice(0, 12)}`,
            name: "ctx_search",
            arguments: JSON.stringify({ query }),
        };
    }
    return textItem("1) Stub first item\n2) Stub second item\nStub answer.");
}

export function startStub(expect: StubExpectations): Stub {
    const records: StubRecord[] = [];
    const stub: Stub = { origin: "", records, rejectCodex: false, stop: () => server.stop(true) };
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const text = request.method === "POST" ? await request.text() : "";
            let body: Record<string, unknown> = {};
            try {
                body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
            } catch {
                body = {};
            }
            const record: StubRecord = {
                route: "unknown",
                method: request.method,
                path: url.pathname + url.search,
                credentialHeaders: {},
                bodyKeys: Object.keys(body),
                bodyFacts: {},
                body,
                status: 200,
            };
            records.push(record);
            const auth = request.headers.get("authorization");
            const reply = (response: Response) => {
                record.status = response.status;
                return response;
            };

            if (url.pathname === "/backend-api/codex/responses") {
                record.route = "codex";
                const bearer = credentialHeader(auth, `Bearer ${expect.codexToken}`);
                const account = credentialHeader(
                    request.headers.get("chatgpt-account-id"),
                    expect.codexAccountId,
                );
                if (bearer) record.credentialHeaders.authorization = bearer;
                if (account) record.credentialHeaders["chatgpt-account-id"] = account;
                record.bodyFacts = {
                    model: body.model,
                    stream: body.stream,
                    store: body.store,
                    instructionsType: typeof body.instructions,
                    temperature: body.temperature,
                    reasoning: body.reasoning,
                    maxOutputTokens: body.max_output_tokens,
                    tools: ((body.tools as { name?: string }[] | undefined) ?? []).map(
                        (tool) => tool.name,
                    ),
                };
                if (stub.rejectCodex)
                    return reply(new Response('{"detail":"stub rejection"}', { status: 401 }));
                if (bearer !== "present-matches" || account !== "present-matches") {
                    return reply(
                        new Response('{"detail":"stub: wrong credential shape"}', { status: 401 }),
                    );
                }
                const answer = codexAnswer(body);
                const input =
                    strings(body.input).join("").length + String(body.instructions ?? "").length;
                return reply(
                    responsesStream(String(body.model), answer, {
                        input: Math.ceil(input / 4),
                        output: 20,
                    }),
                );
            }

            const cloud = /^\/v1internal:(streamGenerateContent|generateContent)$/.exec(
                url.pathname,
            );
            if (cloud) {
                record.route = "cloud-code";
                const bearer = credentialHeader(auth, `Bearer ${expect.cloudCodeToken}`);
                if (bearer) record.credentialHeaders.authorization = bearer;
                record.bodyFacts = {
                    model: body.model,
                    projectMatches: body.project === expect.cloudCodeProject,
                    requestKeys: Object.keys(
                        (body.request as Record<string, unknown> | undefined) ?? {},
                    ),
                    alt: url.searchParams.get("alt"),
                };
                if (bearer !== "present-matches" || body.project !== expect.cloudCodeProject) {
                    return reply(
                        new Response(
                            '{"error":{"code":401,"message":"stub: wrong credential shape"}}',
                            { status: 401 },
                        ),
                    );
                }
                const texts = strings(body.request);
                const draft = texts.find((value) => value.includes("<draft>"));
                const range = historianRange(texts);
                const answer = draft
                    ? (/<draft>([\s\S]*?)<\/draft>/.exec(draft)?.[1]?.trim() ?? "")
                    : range
                      ? historianPayload(range)
                      : "ok";
                const inputTokens = Math.ceil(texts.join("").length / 4);
                const response = {
                    candidates: [
                        {
                            content: { role: "model", parts: [{ text: answer }] },
                            finishReason: "STOP",
                            index: 0,
                        },
                    ],
                    usageMetadata: {
                        promptTokenCount: inputTokens,
                        candidatesTokenCount: Math.ceil(answer.length / 4),
                        totalTokenCount: inputTokens + Math.ceil(answer.length / 4),
                    },
                    modelVersion: String(body.model),
                };
                if (cloud[1] === "generateContent") return reply(Response.json({ response }));
                return reply(
                    new Response(`data: ${JSON.stringify({ response })}\r\n\r\n`, {
                        status: 200,
                        headers: { "content-type": "text/event-stream" },
                    }),
                );
            }

            if (url.pathname === "/v1/embeddings") {
                record.route = "voyage";
                const bearer = credentialHeader(auth, `Bearer ${expect.voyageKey}`);
                if (bearer) record.credentialHeaders.authorization = bearer;
                const inputs = Array.isArray(body.input)
                    ? (body.input as string[])
                    : [String(body.input ?? "")];
                record.bodyFacts = {
                    model: body.model,
                    input_type: body.input_type,
                    inputs: inputs.length,
                };
                if (bearer !== "present-matches")
                    return reply(new Response('{"detail":"stub: wrong key"}', { status: 401 }));
                const data = inputs.map((input, index) => {
                    const digest = createHash("sha256").update(input).digest();
                    const vector = Array.from(
                        { length: 64 },
                        (_, i) => ((digest[i % digest.length] as number) - 128) / 128,
                    );
                    return { object: "embedding", index, embedding: vector };
                });
                return reply(
                    Response.json({
                        object: "list",
                        data,
                        model: body.model,
                        usage: { total_tokens: inputs.join(" ").length },
                    }),
                );
            }

            return reply(new Response("stub: no such route", { status: 404 }));
        },
    });
    stub.origin = `http://127.0.0.1:${server.port}`;
    return stub;
}
