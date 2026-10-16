import { Show } from "solid-js";
import type { EditOutcome } from "./memory-history";

/** Result of a dashboard edit: saved (with Undo), changed elsewhere (with
 *  Reload), or refused. */
export default function EditNotice(props: {
  outcome: EditOutcome;
  onReload: () => void;
  onUndo: (decisionKey: string) => void;
  onDismiss?: () => void;
}) {
  const appliedKey = () => (props.outcome.kind === "applied" ? props.outcome.decisionKey : null);
  return (
    <div
      class="history-banner edit-notice"
      classList={{
        success: props.outcome.kind === "applied",
        warning: props.outcome.kind === "conflict",
        error: props.outcome.kind === "refused",
      }}
      data-edit-notice={props.outcome.kind}
    >
      <span>{props.outcome.message}</span>
      <Show when={props.outcome.kind === "conflict"}>
        <button type="button" class="btn sm" onClick={() => props.onReload()}>
          Reload
        </button>
      </Show>
      <Show when={appliedKey()}>
        {(key) => (
          <button type="button" class="btn sm" onClick={() => props.onUndo(key())}>
            Undo
          </button>
        )}
      </Show>
      <Show when={props.onDismiss}>
        {(dismiss) => (
          <button
            type="button"
            class="btn sm ghost"
            aria-label="Dismiss"
            onClick={() => dismiss()()}
          >
            ✕
          </button>
        )}
      </Show>
    </div>
  );
}
