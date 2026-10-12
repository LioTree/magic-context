/**
 * Neighbour retrieval for turn two: which existing memories each candidate fact is
 * compared with. Two lanes feed one shortlist:
 * - lexical (FTS): its top `LEXICAL_SLOT_COUNT` hits are reserved first, so an exact
 *   wording match is never crowded out by semantic neighbours;
 * - semantic (stored embeddings under the project's current embedding model): fills
 *   the rest of the shortlist up to `NEIGHBOUR_SHORTLIST_CAP`.
 * When the project has no stored embeddings under the current model (none at all, or
 * only ones from another model id), the semantic lane is unavailable and the
 * shortlist is lexical-only; the prompt says so, because an empty semantic lane does
 * not mean the fact has no neighbour.
 */
import type { Database } from "../../../shared/sqlite";
import { cosineSimilarity } from "./cosine-similarity";
import { getProjectEmbeddings } from "./embedding-cache";
import { LEXICAL_SLOT_COUNT, NEIGHBOUR_SHORTLIST_CAP } from "./lifecycle-constants";
import { getMemoryById } from "./storage-memory";
import { searchMemoriesFTS } from "./storage-memory-fts";
import type { TurnTwoPromptNeighbour } from "./turn-two-envelope";

/** Embeds one query text under the project's current embedding model. */
export type TurnTwoQueryEmbedder = (
    text: string,
) => Promise<{ vector: Float32Array; modelId: string } | null>;

function neighbourOf(db: Database, id: number): TurnTwoPromptNeighbour | null {
    const memory = getMemoryById(db, id);
    if (!memory || memory.status === "archived") return null;
    const row = db.prepare("SELECT revision FROM memories WHERE id=?").get(id) as {
        revision: number;
    } | null;
    return {
        id: memory.id,
        revision: row?.revision ?? 1,
        category: memory.category,
        content: memory.content,
    };
}

export interface TurnTwoNeighbourResult {
    neighbours: TurnTwoPromptNeighbour[];
    lexicalOnly: boolean;
}

export async function retrieveTurnTwoNeighbours(
    db: Database,
    projectPath: string,
    factText: string,
    embedQuery: TurnTwoQueryEmbedder | undefined,
): Promise<TurnTwoNeighbourResult> {
    const lexical = searchMemoriesFTS(db, projectPath, factText, NEIGHBOUR_SHORTLIST_CAP)
        .filter((memory) => memory.status !== "archived")
        .map((memory) => memory.id);
    let semantic: number[] | null = null;
    const query = embedQuery ? await embedQuery(factText).catch(() => null) : null;
    if (query) {
        const stored = getProjectEmbeddings(db, projectPath, query.modelId);
        if (stored.size > 0) {
            semantic = [...stored.entries()]
                .filter(([, entry]) => entry.embedding.length === query.vector.length)
                .map(([id, entry]) => ({
                    id,
                    score: cosineSimilarity(query.vector, entry.embedding),
                }))
                .sort((a, b) => b.score - a.score || a.id - b.id)
                .map((entry) => entry.id);
        }
    }
    const ordered: number[] = [];
    const add = (id: number) => {
        if (ordered.length < NEIGHBOUR_SHORTLIST_CAP && !ordered.includes(id)) ordered.push(id);
    };
    for (const id of lexical.slice(0, LEXICAL_SLOT_COUNT)) add(id);
    if (semantic) {
        for (const id of semantic) {
            if (ordered.length >= NEIGHBOUR_SHORTLIST_CAP) break;
            if (neighbourOf(db, id)?.id === id) add(id);
        }
    } else {
        for (const id of lexical.slice(LEXICAL_SLOT_COUNT)) add(id);
    }
    const neighbours = ordered.flatMap((id) => {
        const neighbour = neighbourOf(db, id);
        return neighbour && getMemoryById(db, id)?.projectPath === projectPath ? [neighbour] : [];
    });
    return { neighbours, lexicalOnly: semantic === null };
}
