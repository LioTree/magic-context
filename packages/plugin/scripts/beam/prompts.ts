import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PAPER_URL = "https://arxiv.org/html/2510.27246v2";
export const SOURCE_URL = "https://arxiv.org/src/2510.27246v2";
export const LISTINGS = [20, 21, 44] as const;
export const PROMPT_DIR = new URL("./prompts/", import.meta.url);
export const SOURCE_PATHS: Record<number, string> = {
    20: "Prompts/llm_as_a_judge_prompt.tex",
    21: "Prompts/llm_equivalence_detector.tex",
    44: "Prompts/baseline/rag_answer_generation.tex",
};

export function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

export function extractListing(html: string, number: number): string {
    const start = html.indexOf(`<figure id="LST${number}"`);
    if (start < 0) throw new Error(`Missing Listing ${number}`);
    const end = html.indexOf("</figure>", start);
    const block = html.slice(start, end);
    const encoded = /href="data:text\/plain;base64,([A-Za-z0-9+/=]+)"/.exec(block)?.[1];
    if (!encoded) throw new Error(`Missing text payload for Listing ${number}`);
    return Buffer.from(encoded, "base64").toString("utf8");
}

export async function prompt(number: (typeof LISTINGS)[number]): Promise<string> {
    return readFile(new URL(`listing-${number}.txt`, PROMPT_DIR), "utf8");
}

export function extractSourceListing(archive: string, number: number): string {
    const result = spawnSync("tar", ["-xOf", archive, SOURCE_PATHS[number] ?? ""], {
        encoding: "utf8",
        windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Could not extract Listing ${number}: ${result.stderr}`);
    return result.stdout;
}

export async function verifyPrompts(dataDir: string, refresh = true): Promise<void> {
    const archive = join(dataDir, "reference/source.tar");
    if (refresh) {
        const response = await fetch(SOURCE_URL);
        if (!response.ok) throw new Error(`arXiv source: ${response.status}`);
        await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
    }
    const manifest = JSON.parse(
        await readFile(new URL("provenance.json", PROMPT_DIR), "utf8"),
    ) as { source: string; sha256: Record<string, string> };
    if (manifest.source !== SOURCE_URL) throw new Error("Unexpected prompt source");
    for (const number of LISTINGS) {
        const extracted = extractSourceListing(archive, number);
        const vendored = await prompt(number);
        if (extracted !== vendored || sha256(vendored) !== manifest.sha256[number]) {
            throw new Error(`Listing ${number} failed verbatim verification`);
        }
        console.log(`Listing ${number}: verified sha256=${sha256(vendored)}`);
    }
}

export async function answerPrompt(question: string): Promise<string> {
    // The preceding host messages supply the context; no question annotations enter this slot.
    return (await prompt(44))
        .replace("<context>", "[The conversation is supplied in the preceding messages.]")
        .replace("<question>", () => question);
}
