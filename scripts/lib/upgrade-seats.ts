import { createHash, randomBytes } from "node:crypto";

export const HOSTS = ["opencode1", "opencode2", "pi"] as const;
export type Host = typeof HOSTS[number];
export type Seat = { session: string; bytes: number };

export function sampleSessions(seats: Seat[], seed = randomBytes(16).toString("hex")): { seed: string; largest: Seat[]; random: Seat[] } {
    const ordered = [...seats].sort((a, b) => b.bytes - a.bytes || a.session.localeCompare(b.session));
    const largest = ordered.slice(0, 5);
    const rank = (s: Seat) => createHash("sha256").update(`${seed}\0${s.session}`).digest("hex");
    const random = ordered.slice(5).sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, 5);
    if (largest.length !== 5 || random.length !== 5) throw new Error("Need ten distinct sessions for largest-five/random-five coverage");
    return { seed, largest, random };
}

export function assertRendered(host: Host, messages: unknown[], transformed: boolean, refusal: unknown): void {
    if (!transformed || messages.length === 0 || refusal || !/§\d+§/.test(JSON.stringify(messages)))
        throw new Error(`${host} did not complete a tagged, non-refused TypeScript rendering`);
}

export function assertHostCoverage(sessions: string[], results: { host: Host; session: string }[]): void {
    for (const host of HOSTS)
        for (const session of sessions)
            if (results.filter((r) => r.host === host && r.session === session).length !== 1)
                throw new Error(`Missing or duplicate real-session pass: ${host} ${session}`);
}

export type TagIdentity = { number: number; message: string; type: string; owner: string | null };
export function assertTagContinuity(expected: TagIdentity[], actual: TagIdentity[], marker: string): void {
    if (expected.length === 0 || marker !== "imported") throw new Error("Rust tag continuity was not exercised on the first TypeScript pass");
    for (const tag of expected)
        if (!actual.some((row) => row.number === tag.number && row.message === tag.message && row.type === tag.type && row.owner === tag.owner))
            throw new Error(`Rust tag ${tag.number} renumbered or changed identity`);
}
