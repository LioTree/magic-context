import type { PrefixProvenance } from "../served-prefix";
import { PREFIX_DIGEST_FORMAT, servedPrefixProjection } from "../served-prefix-projection";

/**
 * Expected first-kept digest for a served message. It covers only what the host
 * converter sends to the provider, never host-only envelope fields such as
 * OpenCode's `info.summary`: the hold protects signed thinking, which the provider
 * checks against the bytes it was sent, so fields it never sees cannot break it.
 * The field selection reuses the production projection, so this oracle does not
 * check the field list itself; the per-field perturbation cases in
 * served-prefix-projection.test.ts do. Only the hashing is independent here.
 */
export function servedMessageDigest(message: unknown, provenance: PrefixProvenance): string {
    return PREFIX_DIGEST_FORMAT + wholeMessageDigest(servedPrefixProjection(message, provenance));
}

/** Pi proves that a newly persisted user is the same transient user it served;
 * that branch-identity certificate intentionally checks the whole message. */
export function wholeMessageDigest(message: unknown): string {
    const bytes = JSON.stringify(message);
    if (bytes === undefined) throw new Error("No returned message to hash");
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
