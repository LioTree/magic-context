export interface ScoreRow {
  importance: number;
  effective_importance?: number | null;
  applied_importance?: number | null;
  rust_applied_importance?: number | null;
}

export function scoreLabel(row: ScoreRow): string | null {
  if (row.effective_importance == null || row.applied_importance == null) return null;
  const applied =
    row.rust_applied_importance == null
      ? `${row.applied_importance}`
      : `TS ${row.applied_importance} / Rust ${row.rust_applied_importance}`;
  return `base ${row.importance} · effective ${row.effective_importance} · applied ${applied}`;
}

export function scoresPending(row: ScoreRow): boolean {
  return (
    row.effective_importance != null &&
    row.applied_importance != null &&
    (row.effective_importance !== row.applied_importance ||
      (row.rust_applied_importance != null &&
        row.effective_importance !== row.rust_applied_importance))
  );
}
