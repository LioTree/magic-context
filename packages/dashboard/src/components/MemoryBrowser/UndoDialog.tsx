import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { newOperationId, previewMemoryRestore, restoreMemoryHistory } from "../../lib/api";
import type { MemoryRestorePreview, MemoryRestoreReceipt } from "../../lib/types";
import { RowChange } from "./HistoryParts";
import {
  ADOPTION_NOTE,
  confirmUndo,
  loadUndoPreview,
  previewChanges,
  previewProblems,
  receiptView,
  type UndoApi,
  type UndoState,
} from "./memory-history";

const liveApi: UndoApi = { previewMemoryRestore, restoreMemoryHistory, newOperationId };

interface Props {
  projectPath: string;
  decisionKey: string;
  /** Short description of the change being undone, for the dialog title. */
  title?: string;
  api?: UndoApi;
  onClose: () => void;
  /** Called once an undo is applied, so the caller can reload its views. */
  onApplied: (receipt: MemoryRestoreReceipt) => void;
}

/** Narrows the flow state to one phase, or null, for Solid's keyed <Match>. */
function phaseOf<P extends UndoState["phase"]>(state: UndoState, ...phases: P[]) {
  return (phases as string[]).includes(state.phase)
    ? (state as Extract<UndoState, { phase: P }>)
    : null;
}

/** What the dialog shows for each step of the flow. */
export function UndoBody(props: { state: UndoState }) {
  const state = () => props.state;
  const previewState = () => phaseOf(props.state, "preview", "restoring");
  const resultState = () => phaseOf(props.state, "result");
  const errorState = () => phaseOf(props.state, "error");
  return (
    <Switch>
      <Match when={state().phase === "loading"}>
        <div class="history-empty">Checking what undoing would change…</div>
      </Match>

      <Match when={previewState()}>
        {(s) => (
          <>
            <Show
              when={s().preview.state === "ready"}
              fallback={
                <div
                  class="history-banner"
                  classList={{
                    warning: s().preview.state === "conflict",
                    error: s().preview.state === "refused",
                  }}
                >
                  <div>
                    <strong>
                      {s().preview.state === "conflict"
                        ? "This can't be undone right now."
                        : "This change can't be undone."}
                    </strong>
                    <For each={previewProblems(s().preview)}>{(line) => <p>{line}</p>}</For>
                  </div>
                </div>
              }
            >
              <p class="undo-lead">
                {s().preview.changes.length === 1
                  ? "One memory will go back to how it was before this change:"
                  : `${s().preview.changes.length} memories will go back to how they were before this change:`}
              </p>
            </Show>
            <For each={previewChanges(s().preview)}>
              {(change) => <RowChange row={change.row} beforeLabel="Now" afterLabel="After undo" />}
            </For>
            <Show when={s().preview.state === "ready"}>
              <p class="history-note">{ADOPTION_NOTE}</p>
            </Show>
          </>
        )}
      </Match>

      <Match when={resultState()}>
        {(s) => {
          const view = () => receiptView(s().receipt);
          return (
            <div
              class="history-banner"
              classList={{
                success: view().tone === "success",
                warning: view().tone === "warning",
                error: view().tone === "error",
              }}
              data-undo-result={s().receipt.state}
            >
              <div>
                <strong>{view().title}</strong>
                <For each={view().details}>{(line) => <p>{line}</p>}</For>
              </div>
            </div>
          );
        }}
      </Match>

      <Match when={errorState()}>
        {(s) => (
          <div class="history-banner error">
            <div>
              <strong>{s().message}</strong>
              <p>
                {s().retry
                  ? "If the undo did go through, trying again shows its result instead of applying it twice."
                  : "Nothing was changed. You can try again."}
              </p>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  );
}

/** The dialog's buttons for each step of the flow. */
export function UndoFooter(props: {
  state: UndoState;
  onClose: () => void;
  onRecheck: () => void;
  onConfirm: (preview: MemoryRestorePreview, operationId: string) => void;
}) {
  const previewState = () => phaseOf(props.state, "preview", "restoring");
  const errorState = () => phaseOf(props.state, "error");
  return (
    <Switch>
      <Match when={previewState()}>
        {(s) => (
          <>
            <button type="button" class="btn sm" onClick={props.onClose}>
              Cancel
            </button>
            <Show
              when={s().preview.state === "ready"}
              fallback={
                <Show when={s().preview.state === "conflict"}>
                  <button type="button" class="btn sm" onClick={props.onRecheck}>
                    Check again
                  </button>
                </Show>
              }
            >
              <button
                type="button"
                class="btn sm primary"
                disabled={s().phase === "restoring"}
                onClick={() => props.onConfirm(s().preview, s().operationId)}
              >
                {s().phase === "restoring" ? "Undoing…" : "Undo this change"}
              </button>
            </Show>
          </>
        )}
      </Match>
      <Match when={errorState()}>
        {(err) => {
          return (
            <>
              <button type="button" class="btn sm" onClick={props.onClose}>
                Close
              </button>
              <button
                type="button"
                class="btn sm primary"
                onClick={() => {
                  const retry = err().retry;
                  if (retry) props.onConfirm(retry.preview, retry.operationId);
                  else props.onRecheck();
                }}
              >
                Try again
              </button>
            </>
          );
        }}
      </Match>
      <Match when={true}>
        <button type="button" class="btn sm" onClick={props.onClose}>
          Close
        </button>
      </Match>
    </Switch>
  );
}

/** Preview → confirm → result flow for undoing one history decision. */
export default function UndoDialog(props: Props) {
  const api = () => props.api ?? liveApi;
  const [state, setState] = createSignal<UndoState>({ phase: "loading" });

  const loadPreview = async () => {
    setState({ phase: "loading" });
    setState(await loadUndoPreview(api(), props.projectPath, props.decisionKey));
  };

  const confirm = async (preview: MemoryRestorePreview, operationId: string) => {
    setState({ phase: "restoring", preview, operationId });
    const next = await confirmUndo(api(), preview, operationId);
    setState(next);
    if (next.phase === "result" && next.receipt.state === "applied") props.onApplied(next.receipt);
  };

  onMount(() => void loadPreview());

  return (
    <div class="modal-overlay undo-dialog">
      <button type="button" class="modal-backdrop" aria-label="Close" onClick={props.onClose} />
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-header-text">
            <div class="modal-title">Undo this change</div>
            <Show when={props.title}>
              <div class="card-meta">{props.title}</div>
            </Show>
          </div>
          <button type="button" class="btn sm" onClick={props.onClose}>
            Close
          </button>
        </div>
        <div class="modal-body">
          <UndoBody state={state()} />
        </div>
        <div class="modal-footer undo-footer">
          <UndoFooter
            state={state()}
            onClose={props.onClose}
            onRecheck={loadPreview}
            onConfirm={confirm}
          />
        </div>
      </div>
    </div>
  );
}
