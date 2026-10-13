import { Show } from "solid-js";
import { type ScoreRow, scoreLabel, scoresPending } from "./compartment-scores";

export { scoreLabel, scoresPending } from "./compartment-scores";

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
