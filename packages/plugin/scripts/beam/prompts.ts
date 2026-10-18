/**
 * The prompts the harness sends, and the check that they are verbatim.
 *
 * Two sources are vendored under `prompts/`:
 *
 * - `released/`: the exact runtime strings of the BEAM authors' released code at a pinned commit
 *   (judge, equivalence detector, and the long-context question wrapper). These are what the
 *   harness SENDS. Where the released code and the paper's listings differ, the released code
 *   wins, because it is what produced the paper's numbers.
 * - `listing-20.txt`, `listing-21.txt`, `listing-44.txt`: Listings 20, 21 and 44 from the arXiv v2
 *   TeX source, kept for provenance and so the report can list every difference.
 *
 * `verifyPrompts` re-downloads both sources and checks every vendored file byte for byte and
 * against the SHA-256 recorded in `prompts/provenance.json`.
 *
 * A prompt set is the unit a second protocol would replace (see `PromptSet`); only the paper's
 * released protocol is implemented.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/** The BEAM authors' released code, pinned. */
export const RELEASED_REPO = "mohammadtavakoli78/BEAM";
export const RELEASED_COMMIT = "b2da22eac88bb0874c64665f13457eb99835774a";
export const RELEASED_PROMPTS = [
    "judge",
    "equivalence-system",
    "equivalence-user",
    "long-context-question",
] as const;
export type ReleasedPrompt = (typeof RELEASED_PROMPTS)[number];

/** Where each released prompt lives: the source file and how to find the literal in it. */
const RELEASED_SOURCES: Record<ReleasedPrompt, { file: string; anchor: string; literal: RegExp }> =
    {
        judge: {
            file: "src/prompts.py",
            anchor: "unified_llm_judge_base_prompt = ",
            literal: /^unified_llm_judge_base_prompt = """([\s\S]*?)"""/,
        },
        "equivalence-system": {
            file: "src/evaluation/compute_metrics.py",
            anchor: "def llm_equivalence(",
            literal: /"role": "system",\s*"content": """([\s\S]*?)"""/,
        },
        "equivalence-user": {
            file: "src/evaluation/compute_metrics.py",
            anchor: "def llm_equivalence(",
            literal: /"role": "user",\s*"content": f"""([\s\S]*?)"""/,
        },
        "long-context-question": {
            file: "src/answer_probing_questions/long_term_memory_methods.py",
            anchor: 'if evaluation_type == "long-context":',
            literal: /messages\.append\(\{\s*"role": "user",\s*"content": f"""([\s\S]*?)"""/,
        },
    };

export function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

export async function prompt(number: (typeof LISTINGS)[number]): Promise<string> {
    return readFile(new URL(`listing-${number}.txt`, PROMPT_DIR), "utf8");
}

export async function releasedPrompt(name: ReleasedPrompt): Promise<string> {
    return readFile(new URL(`released/${name}.txt`, PROMPT_DIR), "utf8");
}

/**
 * The runtime value of a Python string literal body: backslash escapes are decoded and, for the
 * f-strings used here, `{name}` fields stay as written (none of them contain `{{`).
 */
export function decodePythonLiteral(body: string): string {
    const simple: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        "\\": "\\",
        "'": "'",
        '"': '"',
    };
    let out = "";
    for (let i = 0; i < body.length; i++) {
        const char = body[i] as string;
        if (char !== "\\") {
            out += char;
            continue;
        }
        const next = body[i + 1] ?? "";
        if (next === "\n") {
            i++;
            continue;
        }
        if (next in simple) {
            out += simple[next];
            i++;
            continue;
        }
        out += char;
    }
    return out;
}

export function extractReleasedPrompt(name: ReleasedPrompt, source: string): string {
    const spec = RELEASED_SOURCES[name];
    const start = source.indexOf(spec.anchor);
    if (start < 0) throw new Error(`${name}: anchor not found in ${spec.file}`);
    const match = spec.literal.exec(source.slice(start));
    if (!match?.[1] && match?.[1] !== "")
        throw new Error(`${name}: literal not found in ${spec.file}`);
    return decodePythonLiteral(match[1]);
}

export function extractSourceListing(archive: string, number: number): string {
    const result = spawnSync("tar", ["-xOf", archive, SOURCE_PATHS[number] ?? ""], {
        encoding: "utf8",
        windowsHide: true,
    });
    if (result.status !== 0)
        throw new Error(`Could not extract Listing ${number}: ${result.stderr}`);
    return result.stdout;
}

interface Provenance {
    source: string;
    sha256: Record<string, string>;
    released: { repo: string; commit: string; sha256: Record<string, string> };
}

export async function provenance(): Promise<Provenance> {
    return JSON.parse(await readFile(new URL("provenance.json", PROMPT_DIR), "utf8")) as Provenance;
}

/** Every vendored prompt's SHA-256, as recorded for run results. */
export async function promptHashes(): Promise<Record<string, string>> {
    const record: Record<string, string> = {};
    for (const name of RELEASED_PROMPTS)
        record[`released/${name}`] = sha256(await releasedPrompt(name));
    for (const number of LISTINGS) record[`listing-${number}`] = sha256(await prompt(number));
    return record;
}

/** Re-download both sources and compare every vendored prompt byte for byte. Throws on any drift. */
export async function verifyPrompts(dataDir: string): Promise<string[]> {
    const lines: string[] = [];
    const manifest = await provenance();
    if (manifest.source !== SOURCE_URL)
        throw new Error("Unexpected listing source in provenance.json");
    if (manifest.released.commit !== RELEASED_COMMIT || manifest.released.repo !== RELEASED_REPO) {
        throw new Error("Unexpected released-code pin in provenance.json");
    }

    const referenceDir = join(dataDir, "reference");
    await mkdir(referenceDir, { recursive: true });
    const archive = join(referenceDir, "source.tar");
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`arXiv source: HTTP ${response.status}`);
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
    for (const number of LISTINGS) {
        const extracted = extractSourceListing(archive, number);
        const vendored = await prompt(number);
        if (extracted !== vendored || sha256(vendored) !== manifest.sha256[number]) {
            throw new Error(`Listing ${number} failed verbatim verification`);
        }
        lines.push(`listing-${number}: verified sha256=${sha256(vendored)}`);
    }

    const sources = new Map<string, string>();
    for (const name of RELEASED_PROMPTS) {
        const file = RELEASED_SOURCES[name].file;
        if (!sources.has(file)) {
            const url = `https://raw.githubusercontent.com/${RELEASED_REPO}/${RELEASED_COMMIT}/${file}`;
            const fetched = await fetch(url);
            if (!fetched.ok) throw new Error(`${url}: HTTP ${fetched.status}`);
            sources.set(file, await fetched.text());
        }
        const extracted = extractReleasedPrompt(name, sources.get(file) as string);
        const vendored = await releasedPrompt(name);
        if (extracted !== vendored || sha256(vendored) !== manifest.released.sha256[name]) {
            throw new Error(`released/${name} failed verbatim verification`);
        }
        lines.push(`released/${name}: verified sha256=${sha256(vendored)}`);
    }
    return lines;
}

/** One chat message as the released code builds it. */
export interface PromptMessage {
    role: "system" | "user";
    content: string;
}

/**
 * Everything protocol-specific about asking and judging. A second protocol (for example another
 * benchmark harness's prompts) would be another implementation of this interface.
 */
export interface PromptSet {
    id: string;
    /** The text of turn |T|+1, appended after the conversation. */
    questionTurn(question: string): Promise<string>;
    /** The nugget judge's messages for one rubric item. */
    nuggetJudge(input: {
        question: string;
        nugget: string;
        response: string;
    }): Promise<PromptMessage[]>;
    /** The equivalence detector's messages for one reference / answer item pair. */
    equivalence(input: { reference: string; system: string }): Promise<PromptMessage[]>;
}

/**
 * The BEAM authors' released protocol, at `RELEASED_COMMIT`:
 *
 * - question turn: `long_term_memory_methods.py` appends one user message built from an f-string
 *   with `{query}`; that exact text, whitespace included, is turn |T|+1 in both arms;
 * - nugget judge: `compute_metrics.py` sends `unified_llm_judge_base_prompt` with `<rubric_item>`
 *   and `<llm_response>` replaced, as a single user message (the released prompt has no question
 *   slot, unlike Listing 20);
 * - equivalence: `llm_equivalence` sends a system message and a user message with the two snippets.
 *
 * Replacement uses functions so `$` sequences in model text stay literal.
 */
export const releasedPromptSet: PromptSet = {
    id: `beam-released@${RELEASED_COMMIT.slice(0, 7)}`,
    async questionTurn(question) {
        return (await releasedPrompt("long-context-question")).replace("{query}", () => question);
    },
    async nuggetJudge({ nugget, response }) {
        const content = (await releasedPrompt("judge"))
            .replace("<rubric_item>", () => nugget)
            .replace("<llm_response>", () => response);
        return [{ role: "user", content }];
    },
    async equivalence({ reference, system }) {
        // The released code passes the reference item as the first snippet.
        const user = (await releasedPrompt("equivalence-user"))
            .replace("{first_paragraph}", () => reference)
            .replace("{second_paragraph}", () => system);
        return [
            { role: "system", content: await releasedPrompt("equivalence-system") },
            { role: "user", content: user },
        ];
    },
};
