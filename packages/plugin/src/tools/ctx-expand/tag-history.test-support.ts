import { insertTag } from "../../features/magic-context/storage-tags";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import type { Database } from "../../shared/sqlite";

export const SESSION_ID = "ctx-expand-ts-tag-history";
export const TS_TAG_TEXT = "The stored TypeScript tag resolves this parser result.";

/** Keep neighboring rows distinct so a lookup cannot pass by returning the first or latest message. */
export function seedTypeScriptTagHistory(db: Database): () => void {
    const messages = [
        {
            id: "before-tag",
            ordinal: 1,
            role: "user",
            parts: [{ type: "text", text: "An unrelated earlier request." }],
        },
        {
            id: "tagged-result",
            ordinal: 2,
            role: "assistant",
            parts: [{ type: "text", text: TS_TAG_TEXT }],
        },
        {
            id: "after-tag",
            ordinal: 3,
            role: "assistant",
            parts: [{ type: "text", text: "An unrelated later answer." }],
        },
    ];
    insertTag(db, SESSION_ID, "tagged-result:p0", "message", Buffer.byteLength(TS_TAG_TEXT), 75386);
    return setRawMessageProvider(SESSION_ID, {
        readMessages: () => messages,
        getMessageCount: () => messages.length,
    });
}
