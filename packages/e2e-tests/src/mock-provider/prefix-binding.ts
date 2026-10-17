type Message = { role: string; content: unknown };
type Block = Record<string, unknown> & { type: string };
type Wire = { role: string; content: Block[] }[];
type Receipt = { block: Block; prefix: Wire; turn: number };

export const PREFIX_ERROR = "Invalid signature: thinking block bound to a different conversation";
export const BYTES_ERROR = "Thinking block bytes or signature were modified";
export const MIDDLE_ERROR = "A thinking block was removed from the middle";
export const LATEST_ERROR = "Thinking blocks in the latest assistant turn cannot be modified";
export const PAIRING_ERROR = "tool_use ids require tool_result blocks immediately after";

const signed = (b: Block) => b.type === "thinking" || b.type === "redacted_thinking";
const identity = (b: Block) => b.type === "thinking" ? b.signature : b.data;
const sameBlock = (a: Block, b: Block) => a.type === b.type &&
    (a.type === "thinking" ? a.thinking === b.thinking && a.signature === b.signature : a.data === b.data);

// Cache placement and JSON object key order are transport details, not message edits.
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "cache_control")
            .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
    );
    return value;
}

function normalize(messages: Message[]): Wire {
    return messages.map(m => ({ role: m.role, content: typeof m.content === "string"
        ? [{ type: "text", text: m.content }] : structuredClone(m.content as Block[]) }));
}

function pairing(wire: Wire): string | null {
    const merged: Wire = [];
    for (const m of wire) {
        const last = merged.at(-1);
        if (last?.role === m.role) last.content.push(...m.content);
        else merged.push({ role: m.role, content: [...m.content] });
    }
    const ids = (m: Wire[number] | undefined, type: string, key: string) =>
        new Set((m?.content ?? []).filter(b => b.type === type).map(b => b[key]));
    for (let i = 0; i < merged.length; i++) {
        for (const id of ids(merged[i], "tool_use", "id"))
            if (!ids(merged[i + 1], "tool_result", "tool_use_id").has(id)) return PAIRING_ERROR;
        for (const id of ids(merged[i], "tool_result", "tool_use_id"))
            if (!ids(merged[i - 1], "tool_use", "id").has(id)) return PAIRING_ERROR;
    }
    return null;
}

/** Store each signed response block with the accepted messages that preceded it.
 * A client's later resend must match that independent record, not replace it. */
export class PrefixBindingValidator {
    private receipts = new Map<string, Receipt[]>();
    private turn = 0;
    private serial = 0;

    /** Advance when test code submits a user prompt, never for tool results or synthetic messages. */
    newUserTurn(): void { this.turn++; }

    check(scope: string, messages: Message[]): string | null {
        const request = normalize(messages);
        const orphan = pairing(request);
        if (orphan) return orphan;
        const receipts = this.receipts.get(scope) ?? [];
        const sent = request.flatMap(m => m.content).filter(signed);
        for (const block of sent) {
            const receipt = receipts.find(r => identity(r.block) === identity(block));
            if (!receipt || !sameBlock(block, receipt.block)) return BYTES_ERROR;
        }
        const kept = receipts.map((r, i) => sent.some(b => sameBlock(b, r.block)) ? i : -1).filter(i => i >= 0);
        if (kept.length && kept.at(-1)! - kept[0]! + 1 !== kept.length) return MIDDLE_ERROR;
        if (receipts.some(r => r.turn === this.turn && !sent.some(b => sameBlock(b, r.block)))) return LATEST_ERROR;
        const removed = receipts.filter(r => !sent.some(b => sameBlock(b, r.block)));
        const bytes = (wire: Wire) => JSON.stringify(canonical(wire.flatMap(m => m.content
            .filter(b => !signed(b) || !removed.some(r => sameBlock(b, r.block)))
            .map(b => [m.role, b]))));
        const prefix: Wire = [];
        for (const m of request) {
            const partial = { role: m.role, content: [] as Block[] };
            prefix.push(partial);
            for (const block of m.content) {
                if (signed(block)) {
                    const receipt = receipts.find(r => sameBlock(block, r.block))!;
                    if (bytes(prefix) !== bytes(receipt.prefix)) return PREFIX_ERROR;
                }
                partial.content.push(block);
            }
        }
        return null;
    }

    /** Record the request and earlier response content covered by each new signed block. */
    returned(scope: string, accepted: Message[], content: unknown[]): unknown[] {
        const prefix = normalize(accepted);
        const reply = { role: "assistant", content: [] as Block[] };
        prefix.push(reply);
        const receipts = this.receipts.get(scope) ?? [];
        this.receipts.set(scope, receipts);
        for (const raw of structuredClone(content) as Block[]) {
            if (raw.type === "thinking") raw.signature = `prefix-signature-${++this.serial}`;
            if (signed(raw)) receipts.push({ block: structuredClone(raw), prefix: structuredClone(prefix), turn: this.turn });
            reply.content.push(raw);
        }
        return reply.content;
    }
}
