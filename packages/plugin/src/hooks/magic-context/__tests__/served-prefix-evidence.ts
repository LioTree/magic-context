/** Independent hash oracle over the returned message, including host envelope and key order. */
export function servedMessageDigest(message: unknown): string {
    const bytes = JSON.stringify(message);
    if (bytes === undefined) throw new Error("No returned message to hash");
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
