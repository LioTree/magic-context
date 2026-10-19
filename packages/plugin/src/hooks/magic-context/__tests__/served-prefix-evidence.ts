import type { PrefixProvenance } from "../served-prefix";
import { PREFIX_DIGEST_FORMAT, servedPrefixProjection } from "../served-prefix-projection";

/** Independent hash over the converter read-set, not host envelopes. Field perturbation
 * tests independently fence the projection; tool argument key order remains significant. */
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
