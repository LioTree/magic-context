/**
 * Scoring exactly as the BEAM paper describes it (§2.4) and its released code implements it
 * (github.com/mohammadtavakoli78/BEAM, src/evaluation/compute_metrics.py and report_results.py):
 *
 * - Nine abilities: the judge scores each rubric nugget 0, 0.5 or 1 with the released judge prompt
 *   (the code's version of Listing 20), and the question's score is the mean over its nuggets.
 * - Event ordering: each line of the answer is aligned to the first unused reference item the
 *   equivalence detector (the code's version of Listing 21) calls the same, Kendall tau-b is computed over the ranks of
 *   the union of both aligned lists (an item missing from a list ranks after all of its items),
 *   and the reported score is tau-b scaled to 0..1 as (tau + 1) / 2 (`tau_norm`).
 * - Headline: the mean over questions; per-ability means are reported next to it.
 *
 * The pure parts (averaging, ranking, tau-b, alignment) take the judge as a function so they can be
 * tested on known vectors without a model.
 */
import type { PromptMessage, PromptSet } from "./prompts";

export interface NuggetVerdict {
    nugget: string;
    score: number;
    reason: string;
    /** The judge's raw reply, kept so a verdict can be audited. */
    raw: string;
    /** True when the judge gave a value other than 0, 0.5 or 1. */
    offScale?: boolean;
    /** Set when the reply could not be parsed; the nugget then scores 0, as an unparseable verdict cannot pass. */
    error?: string;
}

export interface EquivalenceCheck {
    reference: string;
    system: string;
    same: boolean;
    raw: string;
}

export interface OrderingDetail {
    reference: string[];
    system: string[];
    aligned: string[];
    tauB: number;
    tauNorm: number;
    precision: number;
    recall: number;
    f1: number;
    checks: EquivalenceCheck[];
}

export interface QuestionScore {
    score: number;
    method: "nuggets" | "event_ordering";
    nuggets?: NuggetVerdict[];
    ordering?: OrderingDetail;
}

/** One text completion from the judge model at temperature 0. */
export type JudgeCall = (messages: PromptMessage[]) => Promise<string>;

export function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The scale Listing 20 asks for. Other values in 0..1 are kept, as the released code adds any float, but flagged. */
export const NUGGET_SCORES = [0, 0.5, 1] as const;

/**
 * Read the judge's JSON reply. Like the released code's `parse_json_response`, a fenced block or
 * the first `{...}` span is accepted.
 */
export function parseJudgeJson(reply: string): { score: number; reason: string; offScale: boolean } {
    let text = reply.trim();
    const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(text);
    if (fenced?.[1]) text = fenced[1];
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        const span = /\{[\s\S]*?\}/.exec(text)?.[0];
        if (!span) throw new Error("no JSON object in judge reply");
        value = JSON.parse(span);
    }
    const record = value as { score?: unknown; reason?: unknown };
    const score = typeof record.score === "string" ? Number(record.score) : record.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
        throw new Error(`judge score ${JSON.stringify(record.score)} is not a number between 0 and 1`);
    }
    return {
        score,
        reason: typeof record.reason === "string" ? record.reason : "",
        offScale: !NUGGET_SCORES.includes(score as 0 | 0.5 | 1),
    };
}

export async function scoreNuggets(
    question: string,
    response: string,
    nuggets: string[],
    judge: JudgeCall,
    prompts: PromptSet,
): Promise<QuestionScore> {
    const verdicts: NuggetVerdict[] = [];
    for (const nugget of nuggets) {
        const raw = await judge(await prompts.nuggetJudge({ question, nugget, response }));
        try {
            const parsed = parseJudgeJson(raw);
            verdicts.push({ nugget, score: parsed.score, reason: parsed.reason, raw, ...(parsed.offScale ? { offScale: true } : {}) });
        } catch (error) {
            verdicts.push({ nugget, score: 0, reason: "", raw, error: String(error) });
        }
    }
    return { method: "nuggets", score: mean(verdicts.map((verdict) => verdict.score)), nuggets: verdicts };
}

/**
 * Align each system item to the first unused reference item judged the same, as `align_with_llm`
 * does: a matched item takes the reference's wording, an unmatched one keeps its own.
 */
export async function alignWithJudge(
    reference: string[],
    system: string[],
    same: (reference: string, system: string) => Promise<boolean>,
): Promise<string[]> {
    const used = new Set<number>();
    const aligned: string[] = [];
    for (const item of system) {
        let match: number | null = null;
        for (let index = 0; index < reference.length; index++) {
            if (used.has(index)) continue;
            if (await same(reference[index] as string, item)) {
                match = index;
                break;
            }
        }
        if (match === null) aligned.push(item);
        else {
            aligned.push(reference[match] as string);
            used.add(match);
        }
    }
    return aligned;
}

/**
 * Ranks over the union of both lists, as the released code computes them: each list ranks its own
 * items by position from 1 (a repeated item keeps its last position), and an item the list does
 * not contain ranks `union.length + 1`.
 */
export function unionRanks(reference: string[], system: string[]): { union: string[]; referenceRanks: number[]; systemRanks: number[] } {
    const union = [...new Set([...reference, ...system])];
    const tie = union.length + 1;
    const ranks = (sequence: string[]) => {
        const position = new Map<string, number>();
        sequence.forEach((item, index) => position.set(item, index + 1));
        return union.map((item) => position.get(item) ?? tie);
    };
    return { union, referenceRanks: ranks(reference), systemRanks: ranks(system) };
}

/**
 * Kendall's tau-b with tie correction, the statistic `scipy.stats.kendalltau(variant="b")` returns:
 * (concordant - discordant) / sqrt((n0 - n1) (n0 - n2)), where n0 counts all pairs and n1, n2 the
 * pairs tied in x and in y. NaN when either side is entirely tied, as scipy returns.
 */
export function kendallTauB(x: number[], y: number[]): number {
    if (x.length !== y.length) throw new Error("kendallTauB needs two vectors of the same length");
    let concordant = 0;
    let discordant = 0;
    let tiedX = 0;
    let tiedY = 0;
    let pairs = 0;
    for (let i = 0; i < x.length; i++) {
        for (let j = i + 1; j < x.length; j++) {
            pairs++;
            const dx = Math.sign((x[i] as number) - (x[j] as number));
            const dy = Math.sign((y[i] as number) - (y[j] as number));
            if (dx === 0) tiedX++;
            if (dy === 0) tiedY++;
            if (dx === 0 || dy === 0) continue;
            if (dx === dy) concordant++;
            else discordant++;
        }
    }
    const denominator = Math.sqrt((pairs - tiedX) * (pairs - tiedY));
    if (denominator === 0) return Number.NaN;
    return (concordant - discordant) / denominator;
}

/**
 * The event-ordering score of an already aligned system list. The released code reports
 * `tau_norm = (tau_b + 1) / 2`; it also computes precision, recall and F1, kept here for the
 * record but not part of the reported score. An undefined tau-b (NaN) scores 0.
 */
export function orderingScore(reference: string[], aligned: string[]): Omit<OrderingDetail, "system" | "checks"> {
    const { referenceRanks, systemRanks } = unionRanks(reference, aligned);
    const tauB = kendallTauB(referenceRanks, systemRanks);
    const tauNorm = Number.isNaN(tauB) ? 0 : (tauB + 1) / 2;
    const referenceSet = new Set(reference);
    const alignedSet = new Set(aligned);
    const truePositives = [...referenceSet].filter((item) => alignedSet.has(item)).length;
    const falsePositives = aligned.filter((item) => !referenceSet.has(item)).length;
    const falseNegatives = reference.filter((item) => !alignedSet.has(item)).length;
    const precision = truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : 0;
    const recall = truePositives + falseNegatives ? truePositives / (truePositives + falseNegatives) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { reference, aligned, tauB, tauNorm, precision, recall, f1 };
}

/** The answer's items for event ordering: its lines, split exactly as the released code splits them. */
export function systemItems(response: string): string[] {
    return response.split("\n");
}

export async function scoreEventOrdering(
    reference: string[],
    response: string,
    judge: JudgeCall,
    prompts: PromptSet,
): Promise<QuestionScore> {
    const system = systemItems(response);
    const checks: EquivalenceCheck[] = [];
    const aligned = await alignWithJudge(reference, system, async (referenceItem, systemItem) => {
        const raw = await judge(await prompts.equivalence({ reference: referenceItem, system: systemItem }));
        // The released code lowercases the reply and looks for "yes" anywhere in it.
        const same = raw.toLowerCase().includes("yes");
        checks.push({ reference: referenceItem, system: systemItem, same, raw });
        return same;
    });
    const detail = orderingScore(reference, aligned);
    return { method: "event_ordering", score: detail.tauNorm, ordering: { ...detail, system, checks } };
}

export async function scoreQuestion(
    question: { category: string; text: string; rubric: string[] },
    response: string,
    judge: JudgeCall,
    prompts: PromptSet,
): Promise<QuestionScore> {
    // The released code also runs the nugget judge on event-ordering questions, but its report
    // (report_results.py) reads only `tau_norm` for them, so that extra judging is skipped here.
    if (question.category === "event_ordering") {
        return scoreEventOrdering(question.rubric, response, judge, prompts);
    }
    return scoreNuggets(question.text, response, question.rubric, judge, prompts);
}

export interface Summary {
    questions: number;
    mean: number;
    byCategory: Record<string, { questions: number; mean: number }>;
}

export function summarize(rows: { category: string; score: number }[]): Summary {
    const groups = new Map<string, number[]>();
    for (const row of rows) groups.set(row.category, [...(groups.get(row.category) ?? []), row.score]);
    const byCategory: Summary["byCategory"] = {};
    for (const [category, scores] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        byCategory[category] = { questions: scores.length, mean: mean(scores) };
    }
    return { questions: rows.length, mean: mean(rows.map((row) => row.score)), byCategory };
}
