import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import type { CompartmentScoreVisibility } from "../../shared/score-visibility";
import { Database } from "../../shared/sqlite";
import { projectCompartmentScores, readAppliedScoreWatermark } from "./score-projection";

/** Rust records the highest score selection included in its frozen prompt-history bytes
 * in store.db's mc_cache_state.meta, separate from the TypeScript cache in session_meta. */
export function readRustAppliedScoreWatermark(db: Database, sessionId: string): number {
    const databases = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
    const file = databases.find((entry) => entry.name === "main")?.file;
    if (!file) return 0;
    const path = join(dirname(file), "store.db");
    if (!existsSync(path)) return 0;
    const store = new Database(path, { readonly: true });
    try {
        const row = store
            .prepare("SELECT meta FROM mc_cache_state WHERE session_id = ?")
            .get(sessionId) as { meta: string } | undefined;
        const watermark: unknown = row ? JSON.parse(row.meta).score_selection_watermark : 0;
        return typeof watermark === "number" && Number.isSafeInteger(watermark) && watermark >= 0
            ? watermark
            : 0;
    } finally {
        store.close();
    }
}

/** Read a display-only snapshot; these copies never enter boundary validation or materialization. */
export function readCompartmentScoreVisibility(
    db: Database,
    sessionId: string,
    appliedWatermark?: number,
): CompartmentScoreVisibility {
    return db
        .transaction(() => {
            const base = getCompartments(db, sessionId);
            const installed =
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('compartment_score_revisions','compartment_score_selections')",
                        )
                        .get() as { n: number }
                ).n === 2;
            if (!installed)
                return {
                    appliedWatermark: 0,
                    effectiveWatermark: 0,
                    scores: base.map((row) => ({
                        compartmentId: row.id,
                        base: row.importance,
                        effective: row.importance,
                        applied: row.importance,
                        pending: false,
                    })),
                };
            const effective = projectCompartmentScores(db, sessionId, base, "latest");
            const applied = projectCompartmentScores(
                db,
                sessionId,
                base,
                appliedWatermark ?? readAppliedScoreWatermark(db, sessionId),
            );
            return {
                appliedWatermark: applied.watermark,
                effectiveWatermark: effective.watermark,
                scores: base.map((row, i) => ({
                    compartmentId: row.id,
                    base: row.importance,
                    effective: effective.compartments[i].importance,
                    applied: applied.compartments[i].importance,
                    pending:
                        effective.compartments[i].importance !== applied.compartments[i].importance,
                })),
            };
        })
        .deferred();
}
