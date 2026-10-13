import { Show } from "solid-js";

interface ScoreRow {
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

export function CompartmentScores(props: { row: ScoreRow }) {
  return (
    <span
      style={{
        display: "inline-flex",
        "flex-wrap": "wrap",
        gap: "4px",
        "margin-left": "8px",
        "max-width": "100%",
        "font-size": "12px",
        color: "var(--text-secondary)",
      }}
    >
      <span>{scoreLabel(props.row)}</span>
      <Show when={scoresPending(props.row)}>
        <span class="pill amber" style={{ "white-space": "normal" }}>
          pending next natural rebuild
        </span>
      </Show>
    </span>
  );
}
