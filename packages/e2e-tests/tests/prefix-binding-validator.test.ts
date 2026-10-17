import { expect, test } from "bun:test";
import { MockProvider } from "../src/mock-provider/server";
import { BYTES_ERROR, LATEST_ERROR, MIDDLE_ERROR, PAIRING_ERROR, PREFIX_ERROR } from "../src/mock-provider/prefix-binding";

type Message = { role: string; content: unknown };
const user = (text: string): Message => ({ role: "user", content: text });
const assistant = (content: unknown[]): Message => ({ role: "assistant", content });
const call = { type: "tool_use", id: "tool-1", name: "read", input: { path: "a" } };
const result = user("");
result.content = [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }];

async function fixture() {
    const mock = new MockProvider();
    const { baseURL } = await mock.start({ prefixBinding: true, thinkingScope: () => "primary" });
    mock.setDefault({ text: "done", usage: { input_tokens: 10, output_tokens: 10 } });
    const send = async (messages: Message[], content?: unknown[]) => {
        if (content) mock.script([{ content, usage: { input_tokens: 10, output_tokens: 10 } }]);
        return fetch(`${baseURL}/v1/messages`, { method: "POST", body: JSON.stringify({ messages }) });
    };
    const mint = async (messages: Message[], tail: unknown[] = []) => {
        const response = await send(messages, [{ type: "thinking", thinking: "Full original reasoning.", signature: "script-placeholder" }, ...tail]);
        expect(response.status).toBe(200);
        return (await response.json() as { content: unknown[] }).content;
    };
    return { mock, send, mint };
}

test("prefix oracle accepts key-reordered thinking and rejects a one-byte accepted-prefix edit with captured 400", async () => {
    const f = await fixture();
    try {
        f.mock.newUserTurn();
        const request = [user("original")];
        const content = await f.mint(request, [call]);
        const block = content[0] as Record<string, unknown>;
        expect(block.signature).not.toBe("script-placeholder");
        const reordered = { signature: block.signature, thinking: block.thinking, type: block.type };
        expect((await f.send([...request, assistant([reordered, call]), result])).status).toBe(200);
        expect((await f.send([user("Original"), assistant(content), result])).status).toBe(400);
        expect(f.mock.lastRequest()?.thinkingViolation).toBe(PREFIX_ERROR);
        expect(f.mock.lastRequest()?.responseStatus).toBe(400);
        expect(f.mock.requests().every(r => r.thinkingChecked === "prefix-binding")).toBe(true);
    } finally { await f.mock.stop(); }
});

test("harness turn advancement permits a completed-turn strip even when a cut lowers user count", async () => {
    const f = await fixture();
    try {
        f.mock.newUserTurn();
        const old = [user("head"), user("older"), user("current")];
        await f.mint(old);
        f.mock.newUserTurn();
        expect((await f.send([user("new turn after cut")])).status).toBe(200);
        expect(f.mock.lastRequest()?.thinkingChecked).toBe("prefix-binding");
    } finally { await f.mock.stop(); }
});

test("same-turn synthetic user insertion cannot erase current thinking or skip prefix checks on a new turn", async () => {
    const f = await fixture();
    try {
        f.mock.newUserTurn();
        const content = await f.mint([user("prompt")]);
        expect((await f.send([user("prompt"), user("synthetic")])).status).toBe(400);
        expect(f.mock.lastRequest()?.thinkingViolation).toBe(LATEST_ERROR);
        f.mock.newUserTurn();
        expect((await f.send([user("Prompt"), assistant(content), user("real new turn")])).status).toBe(400);
        expect(f.mock.lastRequest()?.thinkingViolation).toBe(PREFIX_ERROR);
    } finally { await f.mock.stop(); }
});

test("prefix oracle enforces thinking bytes, middle removal and tool pairing", async () => {
    const f = await fixture();
    try {
        f.mock.newUserTurn();
        const first = await f.mint([user("prompt")]);
        const secondRequest = [user("prompt"), assistant(first)];
        const second = await f.mint(secondRequest);
        const thirdRequest = [...secondRequest, assistant(second)];
        const third = await f.mint(thirdRequest);
        f.mock.newUserTurn();
        expect((await f.send([user("prompt"), assistant(first), assistant(third)])).status).toBe(400);
        expect(f.mock.lastRequest()?.thinkingViolation).toBe(MIDDLE_ERROR);
        const edited = { ...(first[0] as object), thinking: "changed" };
        expect((await f.send([user("prompt"), assistant([edited])])).status).toBe(400);
        expect(f.mock.lastRequest()?.thinkingViolation).toBe(BYTES_ERROR);
        expect((await f.send([user("prompt"), assistant(first), result])).status).toBe(400);
        expect(f.mock.lastRequest()?.thinkingViolation).toBe(PAIRING_ERROR);
    } finally { await f.mock.stop(); }
});

test("redacted receipts compare data field-wise and bind the accepted request", async () => {
    const f = await fixture();
    try {
        f.mock.newUserTurn();
        expect((await f.send([user("prompt")], [{ type: "redacted_thinking", data: "opaque" }])).status).toBe(200);
        expect((await f.send([user("prompt"), assistant([{ data: "opaque", type: "redacted_thinking" }])])).status).toBe(200);
        expect((await f.send([user("Prompt"), assistant([{ type: "redacted_thinking", data: "opaque" }])])).status).toBe(400);
        expect(f.mock.lastRequest()?.thinkingViolation).toBe(PREFIX_ERROR);
    } finally { await f.mock.stop(); }
});
