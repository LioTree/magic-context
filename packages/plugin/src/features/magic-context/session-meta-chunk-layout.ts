export const SESSION_META_CHUNK_BYTES = 768;
// Ordinal groups keep tiny scalar arrays compact without moving earlier groups on append.
const ITEMS_PER_GROUP = 64;
// Bound primary-key overhead; deeper subtrees remain lossless opaque byte slices.
const MAX_STRUCTURED_PATH = 64;
type Span = { key: string; start: number; end: number };
const ordinal = (value: number) => value.toString(16).padStart(8, "0");

/**
 * Anchor chunks to JSON members, not their byte offsets in the whole document.
 * Appending to an early namespace must not shift a later multi-megabyte namespace.
 * This is a lossless layout, not a validator: opaque values retain their raw bytes.
 */
export function layoutSessionMetaBytes(bytes: Uint8Array): Map<string, Uint8Array> {
    if (bytes.length === 0) return new Map();
    const spans: Span[] = [];
    const white = (value: number | undefined) =>
        value === 32 || value === 9 || value === 10 || value === 13;
    const ws = (start: number) => {
        let at = start;
        while (white(bytes[at])) at++;
        return at;
    };
    const quoted = (start: number) => {
        let at = start + 1;
        while (at < bytes.length) {
            if (bytes[at] === 34) return at + 1;
            at += bytes[at] === 92 ? 2 : 1;
        }
        throw new Error("unterminated string");
    };
    const atomic = (start: number): number => {
        if (bytes[start] === 34) return quoted(start);
        if (bytes[start] === 123 || bytes[start] === 91) {
            let depth = 0,
                at = start;
            while (at < bytes.length) {
                const char = bytes[at];
                if (char === 34) {
                    at = quoted(at);
                    continue;
                }
                if (char === 123 || char === 91) depth++;
                if (char === 125 || char === 93) {
                    depth--;
                    if (depth === 0) return at + 1;
                }
                at++;
            }
            throw new Error("unterminated container");
        }
        let at = start;
        while (
            at < bytes.length &&
            !white(bytes[at]) &&
            bytes[at] !== 44 &&
            bytes[at] !== 125 &&
            bytes[at] !== 93
        )
            at++;
        if (at === start) throw new Error("missing value");
        return at;
    };
    const node = (start: number, value: number, path: string): number => {
        const opening = bytes[value];
        if ((opening !== 123 && opening !== 91) || path.length > MAX_STRUCTURED_PATH) {
            const end = atomic(value);
            spans.push({ key: `${path}!`, start, end });
            return end;
        }
        spans.push({ key: `${path}!`, start, end: value + 1 });
        const closing = opening === 123 ? 125 : 93;
        let end = value + 1,
            index = 0;
        let group: (Span & { block: number }) | undefined;
        const flush = () => {
            if (group) {
                spans.push(group);
                group = undefined;
            }
        };
        while (true) {
            let at = ws(end);
            if (bytes[at] === closing) {
                flush();
                spans.push({ key: `${path}~`, start: end, end: at + 1 });
                return at + 1;
            }
            const prefix = end;
            if (index > 0) {
                if (bytes[at] !== 44) throw new Error("missing comma");
                at = ws(at + 1);
            }
            if (opening === 123) {
                if (bytes[at] !== 34) throw new Error("missing member name");
                at = ws(quoted(at));
                if (bytes[at] !== 58) throw new Error("missing colon");
                at = ws(at + 1);
            }
            if ((bytes[at] !== 123 && bytes[at] !== 91) || path.length + 9 > MAX_STRUCTURED_PATH) {
                const next = atomic(at),
                    block = Math.floor(index / ITEMS_PER_GROUP);
                if (group && group.block !== block) flush();
                if (!group)
                    group = {
                        key: `${path}.${ordinal(index)}!`,
                        start: prefix,
                        end: next,
                        block,
                    };
                else group.end = next;
                end = next;
            } else {
                flush();
                end = node(prefix, at, `${path}.${ordinal(index)}`);
            }
            index++;
        }
    };
    try {
        const end = node(0, ws(0), "0");
        if (ws(end) !== bytes.length) throw new Error("trailing opaque data");
        const last = spans[spans.length - 1];
        if (!last) throw new Error("empty layout");
        last.end = bytes.length;
        let cursor = 0,
            previous = "";
        for (const span of spans) {
            if (span.start !== cursor || span.end <= span.start || span.key <= previous)
                throw new Error("noncontiguous layout");
            cursor = span.end;
            previous = span.key;
        }
        if (cursor !== bytes.length) throw new Error("incomplete layout");
    } catch {
        spans.length = 0;
        spans.push({ key: "0!", start: 0, end: bytes.length });
    }
    const chunks = new Map<string, Uint8Array>();
    for (const span of spans) {
        let part = 0;
        for (let at = span.start; at < span.end; at += SESSION_META_CHUNK_BYTES) {
            chunks.set(
                `${span.key}${ordinal(part++)}`,
                bytes.subarray(at, Math.min(at + SESSION_META_CHUNK_BYTES, span.end)),
            );
        }
    }
    return chunks;
}
