import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { dataDir } from "./host";
import type { ChatMessage } from "./llm";

export const VANILLA_TRIMMING = "beam-released-cl100k-v1";

/** Use the released baseline's actual BPE, not the production historian's tokenizer. */
export function textTokenCounts(texts: string[], encoding = "cl100k_base"): number[] {
    const result = spawnSync(
        join(dataDir(), "venv", "bin", "python"),
        [join(import.meta.dir, "token_counts.py")],
        {
            input: JSON.stringify({ encoding, texts }),
            encoding: "utf8",
            env: { ...process.env, TIKTOKEN_CACHE_DIR: join(dataDir(), "tiktoken-cache") },
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    if (result.status !== 0)
        throw new Error(
            `offline tokenizer failed; run prepare first: ${result.error ?? result.stderr}`,
        );
    return JSON.parse(result.stdout) as number[];
}

export function releasedTokenTotal(contentTokens: number[]): number {
    return 2 + contentTokens.reduce((sum, tokens) => sum + 4 + tokens, 0);
}

/**
 * Literal port of long_term_memory_methods.py:245-265 at the pinned BEAM release.
 * The crossing message, singleton +2 charges, parity adjustment and empty-history edge case
 * are intentional: replacing them with a hard token cap changes the published baseline.
 * The caller appends the question only after this history-only operation.
 */
export function pruneVanillaHistory(
    messages: ChatMessage[],
    contentTokens: number[],
    contextLimit: number,
): ChatMessage[] {
    if (messages.length !== contentTokens.length)
        throw new Error("one token count is required per history message");
    if (releasedTokenTotal(contentTokens) <= contextLimit - 10000) return messages;
    let count = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        count += 6 + (contentTokens[index] as number);
        if (count > contextLimit - 2000) {
            const suffix = messages.slice(index);
            return suffix.length % 2 === 1 ? suffix.slice(1) : suffix;
        }
    }
    return [];
}
