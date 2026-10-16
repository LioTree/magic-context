// Display logic for memory history, undo and audited edits. Kept free of
// Solid and of the Tauri bridge so every rule the panels show can be tested
// directly with plain data and mocked backend calls.
import type {
  MemoryEditReceipt,
  MemoryHistoryChange,
  MemoryHistoryDecision,
  MemoryHistoryPage,
  MemoryHistorySnapshot,
  MemoryRestorePreview,
  MemoryRestoreReceipt,
  MemoryRestoreRequest,
  MemoryRevisionConflict,
} from "../../lib/types";

// ── Who made a change ─────────────────────────────────────────

const WRITER_LABELS: Record<string, string> = {
  curate: "Dreamer · curate",
  verify: "Dreamer · verify",
  expire: "Expiry",
  ctx_memory: "Your agent (ctx_memory)",
  dashboard_edit: "You, in the dashboard",
  dashboard_restore: "You, undoing a change",
  historian: "Historian",
};

export function writerLabel(writer: string): string {
  return WRITER_LABELS[writer] ?? "Unknown source";
}

/** Pill colour per writer, reusing the dashboard's existing pill palette. */
export function writerTone(writer: string): string {
  switch (writer) {
    case "curate":
    case "verify":
      return "indigo";
    case "expire":
      return "amber";
    case "ctx_memory":
      return "blue";
    case "dashboard_edit":
    case "dashboard_restore":
      return "green";
    case "historian":
      return "purple";
    default:
      return "gray";
  }
}

// ── Why: reason codes as sentences ────────────────────────────

/** Refusal, conflict and recovery-limit codes shared by preview, restore and
 *  edit replies. Each maps to a sentence a person can act on. */
const REASON_SENTENCES: Record<string, string> = {
  invalid_request: "The request was malformed, so nothing was changed.",
  authority_unavailable:
    "The service that owns this project's memories isn't reachable right now. Start a session for this project and try again.",
  target_not_owned: "This memory belongs to a different project, so it can't be changed from here.",
  history_not_found: "This history entry no longer exists.",
  unsupported_history:
    "This history entry was saved in a format that can't be restored safely. It stays readable.",
  incomplete_decision:
    "This change was recorded by an older version that didn't save every affected memory's earlier state, so it can be viewed but not undone.",
  operation_id_reused: "This request was already used for a different change. Try again.",
  stale_revision:
    "A memory involved here has changed since this was loaded. Reload to see the latest version.",
  successor_changed:
    "The memory this merge produced has been edited since. Undoing now would throw that later edit away.",
  duplicate_content:
    "Restoring would create a memory identical to one that already exists in this project.",
  shareability_refused: "Current sharing rules don't allow this memory to be restored as it was.",
  dashboard_memory_read_only: "Memory edits are turned off for this project right now.",
};

/** Plain sentence for a backend reason code; unknown codes never show raw. */
export function explainReason(code: string | null | undefined): string {
  if (!code) return "The change couldn't be made.";
  return (
    REASON_SENTENCES[code] ??
    "The change couldn't be made for a reason this dashboard doesn't recognise."
  );
}

/** Reason codes the automated writers record for their own decisions. */
const DECISION_REASON_SENTENCES: Record<string, string> = {
  expired: "It reached its expiry date.",
  duplicate: "It duplicated another memory.",
  merged: "It was combined with similar memories.",
  superseded: "A newer memory replaced it.",
  stale: "It no longer matched the project.",
  outdated: "It no longer matched the project.",
  verified: "It was checked against the project and confirmed.",
  unverifiable: "It could not be confirmed against the project.",
  user_edit: "You edited it in the dashboard.",
  user_archive: "You archived it in the dashboard.",
  restore: "You undid an earlier change.",
};

/** The decision's recorded "why". Free text from a writer is shown as is; a
 *  bare code is turned into a sentence rather than shown verbatim. */
export function decisionReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) return "No reason was recorded.";
  if (!/^[a-z0-9_.:-]+$/.test(trimmed)) return trimmed;
  const known = DECISION_REASON_SENTENCES[trimmed] ?? REASON_SENTENCES[trimmed];
  if (known) return known;
  const words = trimmed.replace(/[_.:-]+/g, " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

// ── What changed ──────────────────────────────────────────────

export interface FieldChange {
  field: keyof MemoryHistorySnapshot;
  label: string;
  before: string;
  after: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  ARCHITECTURE_DECISIONS: "Architecture decisions",
  CONSTRAINTS: "Constraints",
  CONFIG_DEFAULTS: "Config defaults",
  NAMING: "Naming",
  USER_PREFERENCES: "User preferences",
  USER_DIRECTIVES: "User directives",
  ENVIRONMENT: "Environment",
  WORKFLOW_RULES: "Workflow rules",
  KNOWN_ISSUES: "Known issues",
};

export function categoryLabel(category: string): string {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  const words = category.toLowerCase().replace(/_+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function statusLabel(status: string): string {
  // Same words as the status pills elsewhere in the dashboard; "permanent" is
  // what the Pin action sets.
  return status;
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });
}

/** Fields shown in a before/after comparison. Usage counters and timestamps
 *  move on every read and are not part of what a decision changed. */
const COMPARED_FIELDS: Array<{
  field: keyof MemoryHistorySnapshot;
  label: string;
  format: (snapshot: MemoryHistorySnapshot) => string;
}> = [
  { field: "category", label: "Category", format: (s) => categoryLabel(s.category) },
  { field: "status", label: "Status", format: (s) => statusLabel(s.status) },
  {
    field: "importance",
    label: "Importance",
    format: (s) => (s.importance == null ? "not scored" : String(s.importance)),
  },
  { field: "scope", label: "Scope", format: (s) => s.scope },
  { field: "shareable", label: "Sharing", format: (s) => (s.shareable ? "shareable" : "private") },
  {
    field: "expiresAt",
    label: "Expires",
    format: (s) => (s.expiresAt == null ? "never" : formatDay(s.expiresAt)),
  },
  {
    field: "verificationStatus",
    label: "Verification",
    format: (s) => s.verificationStatus.replace(/_+/g, " "),
  },
  {
    field: "supersededByMemoryId",
    label: "Replaced by",
    format: (s) => (s.supersededByMemoryId == null ? "nothing" : `#${s.supersededByMemoryId}`),
  },
];

/** Non-content fields that differ between two snapshots, formatted for display. */
export function fieldChanges(
  before: MemoryHistorySnapshot,
  after: MemoryHistorySnapshot,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const spec of COMPARED_FIELDS) {
    const a = spec.format(before);
    const b = spec.format(after);
    if (a !== b) out.push({ field: spec.field, label: spec.label, before: a, after: b });
  }
  return out;
}

export interface DiffPart {
  kind: "same" | "add" | "del";
  text: string;
}

/** Above this many token pairs the word diff falls back to a whole
 *  before/after pair instead of building a large comparison table. */
const MAX_DIFF_CELLS = 250_000;

function tokenize(text: string): string[] {
  return text.split(/(\s+|[.,;!?()"])/).filter((t) => t.length > 0);
}

/** Word-level diff of two texts; whitespace is kept so the parts rejoin to
 *  the original strings. */
export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: "same", text: before }] : [];
  // Whitespace and sentence punctuation are their own tokens, so a word that
  // only gained or lost a trailing full stop still matches.
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...(before ? [{ kind: "del" as const, text: before }] : []),
      ...(after ? [{ kind: "add" as const, text: after }] : []),
    ];
  }
  // Longest-common-subsequence table, filled from the end.
  const cols = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      push("del", a[i++]);
    } else {
      push("add", b[j++]);
    }
  }
  while (i < a.length) push("del", a[i++]);
  while (j < b.length) push("add", b[j++]);
  return parts;
}

export type RowKind = "created" | "archived" | "unarchived" | "changed" | "unchanged" | "partial";

export interface RowView {
  memoryId: number;
  role: MemoryHistoryChange["role"];
  kind: RowKind;
  /** One-line description of what happened to this memory. */
  summary: string;
  /** Present when both states are known and the text differs. */
  contentDiff: DiffPart[] | null;
  /** Text shown when only one side is known (creation, or legacy rows). */
  content: string | null;
  fields: FieldChange[];
  /** Plain note for rows whose history is incomplete. */
  limitation: string | null;
}

const PARTIAL_NOTE =
  "An older version recorded this change without the state after it, so only the earlier state is shown.";
const UNSUPPORTED_NOTE = "This entry was saved in a format the dashboard can't compare.";

export function rowView(change: MemoryHistoryChange): RowView {
  const base = {
    memoryId: change.memoryId,
    role: change.role,
    contentDiff: null,
    content: null,
    fields: [],
    limitation: null,
  };
  const { before, after } = change;
  if (change.completeness === "unsupported") {
    return {
      ...base,
      kind: "partial",
      summary: `#${change.memoryId}: details unavailable`,
      content: before?.content ?? after?.content ?? null,
      limitation: UNSUPPORTED_NOTE,
    };
  }
  if (before && after) {
    const fields = fieldChanges(before, after);
    const contentChanged = before.content !== after.content;
    let kind: RowKind = "changed";
    let summary: string;
    if (before.status !== "archived" && after.status === "archived") {
      kind = "archived";
      summary = `#${change.memoryId} archived`;
    } else if (before.status === "archived" && after.status !== "archived") {
      kind = "unarchived";
      summary = `#${change.memoryId} brought back`;
    } else if (fields.length === 0 && !contentChanged) {
      kind = "unchanged";
      summary = `#${change.memoryId} unchanged`;
    } else {
      const what = [
        ...(contentChanged ? ["content"] : []),
        ...fields.map((f) => f.label.toLowerCase()),
      ];
      summary = `#${change.memoryId}: ${what.join(", ")} changed`;
    }
    return {
      ...base,
      kind,
      summary,
      contentDiff: contentChanged ? diffWords(before.content, after.content) : null,
      content: contentChanged ? null : after.content,
      fields,
    };
  }
  if (!before && after) {
    return {
      ...base,
      kind: "created",
      summary: `#${change.memoryId} created`,
      content: after.content,
    };
  }
  // Only the earlier state is known: a legacy row, or a row proven absent
  // afterwards. Never present the missing side as an empty diff.
  return {
    ...base,
    kind: "partial",
    summary:
      change.completeness === "legacy-partial"
        ? `#${change.memoryId}: earlier state only`
        : `#${change.memoryId} removed`,
    content: before?.content ?? null,
    limitation: change.completeness === "legacy-partial" ? PARTIAL_NOTE : null,
  };
}

export interface DecisionView {
  key: string;
  writer: string;
  who: string;
  tone: string;
  why: string;
  when: number;
  headline: string;
  isMerge: boolean;
  /** For a merge: the memories that were folded in, in recorded order. */
  sources: RowView[];
  /** For a merge: the memory that holds the combined text. */
  survivor: RowView | null;
  /** Every row of a non-merge decision. */
  rows: RowView[];
  restorable: boolean;
  /** Why this decision can't be undone, in plain words; null when it can. */
  restoreLimit: string | null;
}

function idList(ids: number[]): string {
  return ids.map((id) => `#${id}`).join(", ");
}

/** Groups a decision for display. A merge always shows its sources and its
 *  survivor together, because undo restores them as one unit. */
export function decisionView(decision: MemoryHistoryDecision): DecisionView {
  const views = decision.rows.map(rowView);
  const sources = views.filter((r) => r.role === "source");
  const survivor =
    views.find((r) => r.role === "survivor") ??
    (decision.survivorId != null
      ? (views.find((r) => r.memoryId === decision.survivorId) ?? null)
      : null);
  const isMerge = sources.length > 0 || decision.survivorId != null;
  let headline: string;
  if (isMerge) {
    const sourceIds = sources.length > 0 ? sources.map((s) => s.memoryId) : decision.sourceIds;
    const into = survivor
      ? `#${survivor.memoryId}`
      : decision.survivorId != null
        ? `#${decision.survivorId}`
        : "one memory";
    headline = `Merged ${idList(sourceIds)} into ${into}${survivor?.kind === "created" ? " (new)" : ""}`;
  } else if (views.length === 1) {
    const row = views[0];
    headline =
      row.kind === "archived"
        ? `Archived #${row.memoryId}`
        : row.kind === "unarchived"
          ? `Brought back #${row.memoryId}`
          : row.kind === "created"
            ? `Created #${row.memoryId}`
            : row.kind === "partial"
              ? // The after state is missing, so the recorded operation name
                // (for example "expiry-archive") is the only hint of what happened.
                /archive/.test(decision.operation)
                ? `Archived #${row.memoryId}`
                : `Changed #${row.memoryId}`
              : `Edited #${row.memoryId}`;
  } else {
    const archived = views.filter((r) => r.kind === "archived");
    headline =
      archived.length === views.length
        ? `Archived ${views.length} memories`
        : `Changed ${views.length} memories`;
  }
  if (decision.writer === "dashboard_restore")
    headline = `Undo: ${headline.charAt(0).toLowerCase()}${headline.slice(1)}`;
  return {
    key: decision.decisionKey,
    writer: decision.writer,
    who: writerLabel(decision.writer),
    tone: writerTone(decision.writer),
    why: decisionReason(decision.reason),
    when: decision.appliedAt,
    headline,
    isMerge,
    sources: isMerge ? sources : [],
    survivor: isMerge ? survivor : null,
    rows: isMerge ? views.filter((r) => r.role !== "source" && r !== survivor) : views,
    restorable: decision.restorable,
    restoreLimit: restoreLimit(decision),
  };
}

/** Why a decision can't be undone, or null when it can. */
export function restoreLimit(decision: MemoryHistoryDecision): string | null {
  if (decision.restorable) return null;
  if (decision.rows.some((r) => r.completeness === "legacy-partial")) {
    return "This change was recorded by an older version that didn't save enough detail to undo it safely. You can still read what it did.";
  }
  if (decision.rows.some((r) => r.completeness === "unsupported")) {
    return explainReason("unsupported_history");
  }
  return explainReason(decision.refusalReason ?? "unsupported_history");
}

// ── Pagination ──────────────────────────────────────────────

/** Default page size the timelines request (the backend allows up to 100). */
export const HISTORY_PAGE_SIZE = 25;

/** Appends an older page, keeping newest-first order. A decision already
 *  shown is skipped, so a page boundary can never list one twice. */
export function appendHistoryPage(
  shown: MemoryHistoryDecision[],
  page: MemoryHistoryPage,
): MemoryHistoryDecision[] {
  const seen = new Set(shown.map((d) => d.decisionKey));
  return [...shown, ...page.decisions.filter((d) => !seen.has(d.decisionKey))];
}

// ── Undo: preview, conflicts and result ───────────────────────

/** One plain sentence per conflicting memory in a preview or restore reply. */
export function conflictSentences(
  reason: string | null,
  conflicts: MemoryRevisionConflict[],
): string[] {
  if (conflicts.length === 0) return [explainReason(reason)];
  return conflicts.map((c) => {
    if (c.duplicateId != null) {
      return `Memory #${c.memoryId} would become identical to memory #${c.duplicateId}, which already exists. Edit or archive one of them first.`;
    }
    if (reason === "successor_changed") {
      return `Memory #${c.memoryId}, which this merge produced, has been edited since. Undoing would throw that later edit away.`;
    }
    if (c.currentRevision == null && c.expectedRevision != null) {
      return `Memory #${c.memoryId} can no longer be found.`;
    }
    return `Memory #${c.memoryId} has changed since this was loaded. Reload and try again.`;
  });
}

/** What blocks a preview that isn't ready, in plain words. A preview names
 *  only the reason, so the merge survivor is taken from the decision. */
export function previewProblems(preview: MemoryRestorePreview): string[] {
  if (preview.state === "ready") return [];
  const survivor = preview.decision?.survivorId ?? null;
  if (preview.reason === "successor_changed" && survivor != null) {
    return conflictSentences(preview.reason, [
      { memoryId: survivor, expectedRevision: null, currentRevision: null },
    ]);
  }
  if (preview.state === "refused" && preview.decision && !preview.decision.restorable) {
    return [restoreLimit(preview.decision) ?? explainReason(preview.reason)];
  }
  return [explainReason(preview.reason)];
}

export const ADOPTION_NOTE =
  "Running sessions pick up this change the next time they rebuild their memory list; nothing is pushed into them right now.";

export interface UndoApi {
  previewMemoryRestore: (request: {
    projectPath: string;
    decisionKey: string;
  }) => Promise<MemoryRestorePreview>;
  restoreMemoryHistory: (request: MemoryRestoreRequest) => Promise<MemoryRestoreReceipt>;
  newOperationId: () => string;
}

export type UndoState =
  | { phase: "loading" }
  | { phase: "preview"; preview: MemoryRestorePreview; operationId: string }
  | { phase: "restoring"; preview: MemoryRestorePreview; operationId: string }
  | { phase: "result"; receipt: MemoryRestoreReceipt }
  | {
      phase: "error";
      message: string;
      /** Set when the error came from the restore call, so a retry can resend
       *  the same request with the same operation id. */
      retry: { preview: MemoryRestorePreview; operationId: string } | null;
    };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loads the preview. A fresh operation id is issued per preview so each
 *  confirmation is a new request, while a retry after a lost reply resends
 *  the same id and the backend replays its stored answer. */
export async function loadUndoPreview(
  api: UndoApi,
  projectPath: string,
  decisionKey: string,
): Promise<UndoState> {
  try {
    const preview = await api.previewMemoryRestore({ projectPath, decisionKey });
    return { phase: "preview", preview, operationId: api.newOperationId() };
  } catch (error) {
    return {
      phase: "error",
      message: `Couldn't prepare the undo: ${errorText(error)}`,
      retry: null,
    };
  }
}

/** Confirms a ready preview: restores exactly the revisions the preview saw. */
export async function confirmUndo(
  api: UndoApi,
  preview: MemoryRestorePreview,
  operationId: string,
): Promise<UndoState> {
  if (preview.state !== "ready") {
    throw new Error("Only a ready preview can be confirmed");
  }
  try {
    const receipt = await api.restoreMemoryHistory({
      projectPath: preview.projectPath,
      decisionKey: preview.decisionKey,
      operationId,
      expectedRevisions: preview.expectedRevisions,
    });
    return { phase: "result", receipt };
  } catch (error) {
    return {
      phase: "error",
      message: `The undo didn't go through: ${errorText(error)}`,
      retry: { preview, operationId },
    };
  }
}

export interface UndoChangeView {
  memoryId: number;
  row: RowView;
}

/** The preview's planned changes as rows: before = current, after = restored. */
export function previewChanges(preview: MemoryRestorePreview): UndoChangeView[] {
  return preview.changes.map((c) => ({
    memoryId: c.memoryId,
    row: rowView({
      memoryId: c.memoryId,
      role: "target",
      beforeRevision: c.before.revision,
      afterRevision: null,
      before: c.before,
      after: c.after,
      completeness: "complete",
    }),
  }));
}

export interface ReceiptView {
  tone: "success" | "warning" | "error";
  title: string;
  details: string[];
}

export function receiptView(receipt: MemoryRestoreReceipt): ReceiptView {
  if (receipt.state === "applied") {
    const n = receipt.revisions.length;
    return {
      tone: "success",
      title: `Undone. ${n} ${n === 1 ? "memory" : "memories"} restored.`,
      details: [ADOPTION_NOTE],
    };
  }
  if (receipt.state === "conflict") {
    return {
      tone: "warning",
      title: "Nothing was changed: undoing now would clash with the memories as they are.",
      details: conflictSentences(receipt.reason, receipt.conflicts),
    };
  }
  return {
    tone: "error",
    title: "Nothing was changed: the undo was refused.",
    details: [explainReason(receipt.reason)],
  };
}

// ── Audited edits ─────────────────────────────────────────────

export const EDIT_CONFLICT_MESSAGE =
  "This memory changed since you opened it. Reload to see the latest version, then make your edit again.";

export type EditOutcome =
  | { kind: "applied"; decisionKey: string | null; revision: number | null; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "refused"; message: string };

/** Turns an edit reply into what the panel shows. `memoryId` picks this
 *  memory's new revision out of the reply. */
export function editOutcome(
  receipt: MemoryEditReceipt,
  memoryId: number | null,
  appliedMessage: string,
): EditOutcome {
  if (receipt.state === "applied") {
    const ref =
      memoryId == null ? undefined : receipt.revisions.find((r) => r.memoryId === memoryId);
    return {
      kind: "applied",
      decisionKey: receipt.decisionKey,
      revision: ref?.revision ?? null,
      message: appliedMessage,
    };
  }
  if (receipt.state === "conflict") {
    if (receipt.reason === "duplicate_content") {
      const dup = receipt.conflicts.find((c) => c.duplicateId != null)?.duplicateId;
      return {
        kind: "conflict",
        message:
          dup != null
            ? `Another memory (#${dup}) already says exactly this. Nothing was changed.`
            : `${explainReason("duplicate_content")} Nothing was changed.`,
      };
    }
    return { kind: "conflict", message: EDIT_CONFLICT_MESSAGE };
  }
  return { kind: "refused", message: `${explainReason(receipt.reason)} Nothing was changed.` };
}

/** Bulk edits need one project; the backend applies them as one decision. */
export function bulkProject(rows: Array<{ project_path: string }>): string | null {
  const projects = new Set(rows.map((r) => r.project_path));
  return projects.size === 1 ? [...projects][0] : null;
}
