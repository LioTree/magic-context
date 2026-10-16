import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { MemoryHistoryDecision, MemoryHistoryPage } from "../../lib/types";
import { DecisionCard } from "./HistoryParts";
import { appendHistoryPage } from "./memory-history";

interface Props {
  /** Reads one page; `cursor` is absent for the newest page. */
  load: (cursor: string | undefined) => Promise<MemoryHistoryPage>;
  /** Changing this value reloads from the newest page (after an undo or edit). */
  reloadToken?: unknown;
  focusMemoryId?: number;
  emptyText: string;
  onUndo: (decision: MemoryHistoryDecision) => void;
}

/** Newest-first list of memory decisions with cursor pagination. */
export default function MemoryHistoryTimeline(props: Props) {
  const [decisions, setDecisions] = createSignal<MemoryHistoryDecision[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Ignores replies from a load that a newer reload has superseded.
  let generation = 0;

  const fetchPage = async (reset: boolean) => {
    const mine = reset ? ++generation : generation;
    setLoading(true);
    setError(null);
    try {
      const page = await props.load(reset ? undefined : (cursor() ?? undefined));
      if (mine !== generation) return;
      setDecisions((prev) => appendHistoryPage(reset ? [] : prev, page));
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (e: unknown) {
      if (mine !== generation) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === generation) setLoading(false);
    }
  };

  createEffect(
    on(
      () => [props.reloadToken, props.load],
      () => {
        setDecisions([]);
        setCursor(null);
        setLoaded(false);
        void fetchPage(true);
      },
    ),
  );

  return (
    <div class="history-timeline">
      <Show when={error()}>
        {(message) => (
          <div class="history-banner error">
            <span>Couldn't load history: {message()}</span>
            <button type="button" class="btn sm" onClick={() => fetchPage(!loaded())}>
              Try again
            </button>
          </div>
        )}
      </Show>
      <Show when={loaded() && decisions().length === 0 && !error()}>
        <div class="history-empty">{props.emptyText}</div>
      </Show>
      <For each={decisions()}>
        {(decision) => (
          <DecisionCard
            decision={decision}
            focusMemoryId={props.focusMemoryId}
            onUndo={props.onUndo}
          />
        )}
      </For>
      <Show when={loading()}>
        <div class="history-empty">Loading history…</div>
      </Show>
      <Show when={!loading() && loaded() && cursor()}>
        <button type="button" class="btn sm history-more" onClick={() => fetchPage(false)}>
          Show older changes
        </button>
      </Show>
    </div>
  );
}
