import type { Database } from "bun:sqlite";

export type OpenInterval = { startedAtMs: number; finishedAtMs: number };
export type RootExpiryProof = OpenInterval & { deleted: number; retained: number; boundary: number; compatibleAtMs?: number };
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function openInterval(output: string): OpenInterval {
	const records = [...output.matchAll(/^REHEARSAL_OPEN (\{[^\n]+\})$/gm)];
	if (records.length !== 1) throw new Error("Expected exactly one McStore opener clock interval");
	const interval = JSON.parse(records[0][1]) as OpenInterval;
	validateInterval(interval);
	return interval;
}

function validateInterval(interval: OpenInterval): void {
	if (!Number.isSafeInteger(interval.startedAtMs) || !Number.isSafeInteger(interval.finishedAtMs) ||
		interval.startedAtMs < 0 || interval.finishedAtMs < interval.startedAtMs)
		throw new Error("Invalid McStore opener clock interval");
}

// Use baseline activity and fence rows, falling back to migrated fences when the
// baseline predates that table. The content audit checks baseline-present dependencies.
// This is the production opener's strict 30-day predicate.
function eligible(cutoff: number, fences: string): string {
	return `roots.observed_at < ${cutoff}
		AND NOT EXISTS (SELECT 1 FROM ${fences}.mc_move_fences AS fence WHERE fence.session_id = roots.session_id)
		AND NOT EXISTS (SELECT 1 FROM baseline.mc_cache_state AS cache WHERE cache.session_id = roots.session_id AND cache.last_activity_at >= ${cutoff})`;
}

/** The pruning clock is inside this interval; rows crossing the boundary may go either way. */
export function rootExpiryDifference(db: Database, interval: OpenInterval): { difference: string | null; proof: RootExpiryProof } {
	validateInterval(interval);
	// Migration 64 introduces the fence table, so released-63 snapshots have none.
	const fences = db.query("SELECT 1 FROM baseline.sqlite_master WHERE type='table' AND name='mc_move_fences'").get() ? "baseline" : "main";
	const atStart = eligible(interval.startedAtMs - THIRTY_DAYS_MS, fences);
	const atEnd = eligible(interval.finishedAtMs - THIRTY_DAYS_MS, fences);
	const retained = "EXISTS (SELECT 1 FROM main.mc_transform_session_roots AS next WHERE next.rowid = roots.rowid)";
	const count = (condition: string) => Number((db.query(`SELECT COUNT(*) AS n FROM baseline.mc_transform_session_roots AS roots WHERE ${condition}`).get() as { n: number }).n);
	const proof = { ...interval, deleted: count(`NOT ${retained}`), retained: count(retained), boundary: count(`(${atEnd}) AND NOT (${atStart})`) };
	for (const [condition, message] of [
		[`NOT ${retained} AND NOT (${atEnd})`, "deleted non-expired root"],
		[`${retained} AND (${atStart})`, "eligible root survived"],
	]) {
		const row = db.query(`SELECT roots.rowid, roots.session_id FROM baseline.mc_transform_session_roots AS roots WHERE ${condition} LIMIT 1`).get();
		if (row) return { difference: `mc_transform_session_roots: ${message} ${JSON.stringify(row)}`, proof };
	}
	// A single DELETE uses a single clock, not an independent time for each row.
	// Find the earliest time explaining all deletions, then require every survivor
	// to be protected at that same time. This rejects contradictory boundary outcomes.
	let low = interval.startedAtMs, high = interval.finishedAtMs;
	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		if (count(`NOT ${retained} AND NOT (${eligible(mid - THIRTY_DAYS_MS, fences)})`) > 0) low = mid + 1;
		else high = mid;
	}
	if (count(`${retained} AND (${eligible(low - THIRTY_DAYS_MS, fences)})`) > 0)
		return { difference: "mc_transform_session_roots: no single opener clock explains deleted and retained roots", proof };
	return { difference: null, proof: { ...proof, compatibleAtMs: low } };
}
