import { For, Show } from "solid-js";
import { formatDateTime, formatRelativeTime } from "../../lib/api";
import type { MemoryHistoryDecision } from "../../lib/types";
import { type DiffPart, decisionView, type RowView } from "./memory-history";

/** Inline word diff: removed text struck through, added text highlighted. */
export function ContentDiff(props: { parts: DiffPart[] }) {
  return (
    <div class="history-content">
      <For each={props.parts}>
        {(part) => (
          <Show when={part.kind !== "same"} fallback={<span>{part.text}</span>}>
            <Show when={part.kind === "add"} fallback={<del class="history-del">{part.text}</del>}>
              <ins class="history-add">{part.text}</ins>
            </Show>
          </Show>
        )}
      </For>
    </div>
  );
}

/** One memory's part of a decision: what happened, field changes, text. */
export function RowChange(props: {
  row: RowView;
  beforeLabel?: string;
  afterLabel?: string;
  highlight?: boolean;
}) {
  return (
    <div class="history-row" classList={{ focus: props.highlight === true }}>
      <div class="history-row-summary">{props.row.summary}</div>
      <Show when={props.row.fields.length > 0}>
        <table class="history-fields">
          <Show when={props.beforeLabel || props.afterLabel}>
            <thead>
              <tr>
                <th />
                <th>{props.beforeLabel}</th>
                <th />
                <th>{props.afterLabel}</th>
              </tr>
            </thead>
          </Show>
          <tbody>
            <For each={props.row.fields}>
              {(f) => (
                <tr>
                  <td class="history-field-label">{f.label}</td>
                  <td class="history-field-before">{f.before}</td>
                  <td class="history-field-arrow" aria-hidden="true">
                    →
                  </td>
                  <td class="history-field-after">{f.after}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <Show when={props.row.contentDiff}>{(parts) => <ContentDiff parts={parts()} />}</Show>
      <Show when={!props.row.contentDiff && props.row.content}>
        {(text) => <div class="history-content muted">{text()}</div>}
      </Show>
      <Show when={props.row.limitation}>{(note) => <div class="history-note">{note()}</div>}</Show>
    </div>
  );
}

/** One decision in a timeline: who, why, when, the before/after of every
 *  memory it touched, and the undo entry point. */
export function DecisionCard(props: {
  decision: MemoryHistoryDecision;
  focusMemoryId?: number;
  onUndo?: (decision: MemoryHistoryDecision) => void;
}) {
  const view = () => decisionView(props.decision);
  return (
    <article class="history-item" data-decision={props.decision.decisionKey}>
      <span class="history-dot" aria-hidden="true" />
      <div class="history-head">
        <span class={`pill ${view().tone}`}>{view().who}</span>
        <span class="history-headline">{view().headline}</span>
        <span class="history-when" title={formatDateTime(view().when)}>
          {formatRelativeTime(view().when)}
        </span>
      </div>
      <div class="history-why">{view().why}</div>

      <Show
        when={view().isMerge}
        fallback={
          <For each={view().rows}>
            {(row) => <RowChange row={row} highlight={row.memoryId === props.focusMemoryId} />}
          </For>
        }
      >
        <div class="history-merge">
          <div class="history-merge-label">Combined</div>
          <For each={view().sources}>
            {(row) => <RowChange row={row} highlight={row.memoryId === props.focusMemoryId} />}
          </For>
          <Show when={view().survivor}>
            {(survivor) => (
              <>
                <div class="history-merge-label">Into</div>
                <RowChange
                  row={survivor()}
                  highlight={survivor().memoryId === props.focusMemoryId}
                />
              </>
            )}
          </Show>
          <For each={view().rows}>
            {(row) => <RowChange row={row} highlight={row.memoryId === props.focusMemoryId} />}
          </For>
        </div>
      </Show>

      <div class="history-actions">
        <Show
          when={view().restorable}
          fallback={<span class="history-limit">{view().restoreLimit}</span>}
        >
          <Show when={props.onUndo}>
            {(undo) => (
              <button type="button" class="btn sm" onClick={() => undo()(props.decision)}>
                Undo this change
              </button>
            )}
          </Show>
        </Show>
      </div>
    </article>
  );
}
