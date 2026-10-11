import type { MessageLike } from "./transform-operations";
import { wireContentBytes } from "./wire-content";

/** Four bytes per window token caps oversized raw history and saved-request replays independently of tokenization. */
export const RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN = 4;

export type LkgReplayMeasure = (
    | { fit: "under"; tokens: number }
    | { fit: "over"; tokens: number | null; proxyTokens: number | null }
    | { fit: "unproven"; tokens: number | null }
) & {
    proxy: { bytes: number; aborted: boolean } | null;
    estimatorRan: boolean;
    trusted: boolean;
};

/** Require a trusted token estimate and the independent wire-byte budget to fit the known window. */
export function measureLkgReplay(args: {
    messages: readonly MessageLike[];
    limit: number;
    estimate: () => { tokens: number; trusted: boolean };
    measuredInputTokens?: number;
}): LkgReplayMeasure {
    const baseline = args.measuredInputTokens ?? 0;
    const tailLimit = Math.max(0, args.limit - baseline);
    const proxy = wireContentBytes(
        args.messages,
        tailLimit * RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN,
        RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN,
    );
    const skipped = { proxy, estimatorRan: false, trusted: false };
    if (proxy === null) return { fit: "unproven", tokens: null, ...skipped };
    const proxyTokens = baseline + Math.ceil(proxy.bytes / RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN);
    if (proxy.aborted || proxyTokens > args.limit) {
        return { fit: "over", tokens: null, proxyTokens, ...skipped };
    }
    let estimate: { tokens: number; trusted: boolean };
    try {
        estimate = args.estimate();
    } catch {
        return { fit: "unproven", tokens: null, ...skipped };
    }
    const seen = { proxy, estimatorRan: true, trusted: estimate.trusted };
    const tokens = baseline + estimate.tokens;
    if (!estimate.trusted || !Number.isFinite(tokens) || tokens <= 0 || estimate.tokens < 0) {
        return {
            fit: "unproven",
            tokens: Number.isFinite(estimate.tokens) ? estimate.tokens : null,
            ...seen,
        };
    }
    return tokens > args.limit
        ? { fit: "over", tokens, proxyTokens, ...seen }
        : { fit: "under", tokens, ...seen };
}
