import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { plugin } from "bun";
import ts from "typescript";
import type {
  MemoryEditReceipt,
  MemoryHistoryChange,
  MemoryHistoryDecision,
  MemoryHistorySnapshot,
  MemoryRestorePreview,
  MemoryRestoreReceipt,
} from "../../lib/types";
import {
  ADOPTION_NOTE,
  appendHistoryPage,
  confirmUndo,
  decisionReason,
  decisionView,
  diffWords,
  EDIT_CONFLICT_MESSAGE,
  editOutcome,
  explainReason,
  fieldChanges,
  loadUndoPreview,
  previewProblems,
  receiptView,
  restoreLimit,
  rowView,
  type UndoApi,
  type UndoState,
  writerLabel,
} from "./memory-history";

// Solid components need Solid's own JSX compiler. Compile .tsx files for
// server rendering (types stripped by TypeScript, JSX by babel-preset-solid,
// both already installed for the Vite build) so the panels can be rendered to
// HTML and inspected without a browser.
const viteSolid = createRequire(import.meta.url).resolve("vite-plugin-solid");
const fromViteSolid = createRequire(viteSolid);
const babel = fromViteSolid("@babel/core");
const solidPreset = fromViteSolid("babel-preset-solid");
plugin({
  name: "solid-ssr-for-tests",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const js = ts.transpileModule(source, {
        fileName: path,
        compilerOptions: {
          jsx: ts.JsxEmit.Preserve,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const out = await babel.transformAsync(js, {
        filename: path.replace(/\.tsx$/, ".jsx"),
        babelrc: false,
        configFile: false,
        presets: [[solidPreset, { generate: "ssr", hydratable: false }]],
      });
      return { contents: out.code, loader: "js" };
    });
  },
});

const { renderToString } = await import("solid-js/web");
const { DecisionCard } = await import("./HistoryParts");
const { UndoBody, UndoFooter } = await import("./UndoDialog");
const EditNotice = (await import("./EditNotice")).default;
const api = await import("../../lib/api");

// ── Fixtures ───────────────────────────────────────────────────

const T0 = Date.UTC(2026, 4, 14, 12, 0);

function snap(id: number, patch: Partial<MemoryHistorySnapshot> = {}): MemoryHistorySnapshot {
  return {
    id,
    projectPath: "git:fixture",
    revision: 3,
    category: "CONSTRAINTS",
    content: `Memory ${id} text`,
    normalizedHash: `h${id}`,
    importance: 50,
    scope: "project",
    shareable: 0,
    sourceSessionId: null,
    sourceType: "historian",
    seenCount: 1,
    retrievalCount: 0,
    firstSeenAt: T0,
    createdAt: T0,
    updatedAt: T0,
    lastSeenAt: T0,
    lastRetrievedAt: null,
    status: "active",
    expiresAt: null,
    verificationStatus: "unverified",
    verifiedAt: null,
    supersededByMemoryId: null,
    mergedFrom: null,
    metadataJson: null,
    ...patch,
  };
}

function change(
  memoryId: number,
  role: MemoryHistoryChange["role"],
  before: MemoryHistorySnapshot | null,
  after: MemoryHistorySnapshot | null,
  completeness: MemoryHistoryChange["completeness"] = "complete",
): MemoryHistoryChange {
  return {
    memoryId,
    role,
    beforeRevision: before?.revision ?? null,
    afterRevision: after?.revision ?? null,
    before,
    after,
    completeness,
  };
}

function decision(patch: Partial<MemoryHistoryDecision>): MemoryHistoryDecision {
  return {
    version: 1,
    decisionKey: "d-1",
    projectPath: "git:fixture",
    writer: "curate",
    operation: "curate-update",
    reason: "Tightened the wording.",
    appliedAt: T0,
    evidence: null,
    sourceIds: [],
    survivorId: null,
    rows: [],
    restorable: true,
    refusalReason: null,
    ...patch,
  };
}

const editDecision = decision({
  decisionKey: "edit-1",
  writer: "dashboard_edit",
  rows: [
    change(
      7,
      "target",
      snap(7, { content: "Use bun for tests" }),
      snap(7, {
        revision: 4,
        content: "Use bun test for every package",
        category: "WORKFLOW_RULES",
      }),
    ),
  ],
});

// Two sources folded into a survivor the merge created.
const mergeDecision = decision({
  decisionKey: "merge-1",
  operation: "curate-merge",
  reason: "duplicate",
  sourceIds: [11, 12],
  survivorId: 20,
  rows: [
    change(
      11,
      "source",
      snap(11),
      snap(11, { revision: 4, status: "archived", supersededByMemoryId: 20 }),
    ),
    change(
      12,
      "source",
      snap(12),
      snap(12, { revision: 4, status: "archived", supersededByMemoryId: 20 }),
    ),
    change(20, "survivor", null, snap(20, { revision: 1, content: "Combined memory text" })),
  ],
});

const legacyDecision = decision({
  decisionKey: "legacy-1",
  writer: "expire",
  operation: "expiry-archive",
  reason: "expired",
  restorable: false,
  refusalReason: "incomplete_decision",
  rows: [change(30, "target", snap(30, { content: "Old fact" }), null, "legacy-partial")],
});

function preview(patch: Partial<MemoryRestorePreview> = {}): MemoryRestorePreview {
  return {
    version: 1,
    state: "ready",
    projectPath: "git:fixture",
    decisionKey: "edit-1",
    reason: null,
    decision: editDecision,
    expectedRevisions: [{ memoryId: 7, revision: 4 }],
    changes: [
      {
        memoryId: 7,
        before: snap(7, {
          revision: 4,
          content: "Use bun test for every package",
          category: "WORKFLOW_RULES",
        }),
        after: snap(7, { revision: 5, content: "Use bun for tests" }),
      },
    ],
    adoption: "next_natural_hard",
    ...patch,
  };
}

function receipt(patch: Partial<MemoryRestoreReceipt> = {}): MemoryRestoreReceipt {
  return {
    version: 1,
    state: "applied",
    projectPath: "git:fixture",
    decisionKey: "edit-1",
    operationId: "op-1",
    reason: null,
    restoredDecisionKey: "restore-1",
    revisions: [{ memoryId: 7, revision: 5 }],
    conflicts: [],
    adoption: "next_natural_hard",
    ...patch,
  };
}

function editReceipt(patch: Partial<MemoryEditReceipt> = {}): MemoryEditReceipt {
  return {
    version: 1,
    state: "applied",
    projectPath: "git:fixture",
    operationId: "op-e",
    reason: null,
    decisionKey: "edit-2",
    revisions: [{ memoryId: 7, revision: 5 }],
    conflicts: [],
    ...patch,
  };
}

const RAW_CODE = /\b[a-z]+_[a-z_]+\b/;

// ── Who and why ────────────────────────────────────────────────

describe("history wording", () => {
  test("names every writer the history records, and never shows an unknown one raw", () => {
    expect(writerLabel("curate")).toBe("Dreamer · curate");
    expect(writerLabel("verify")).toBe("Dreamer · verify");
    expect(writerLabel("expire")).toBe("Expiry");
    expect(writerLabel("ctx_memory")).toBe("Your agent (ctx_memory)");
    expect(writerLabel("dashboard_edit")).toBe("You, in the dashboard");
    expect(writerLabel("dashboard_restore")).toBe("You, undoing a change");
    expect(writerLabel("historian")).toBe("Historian");
    expect(writerLabel("some_future_writer")).toBe("Unknown source");
  });

  test("every refusal and conflict code becomes a sentence without the code in it", () => {
    const codes = [
      "invalid_request",
      "authority_unavailable",
      "target_not_owned",
      "history_not_found",
      "unsupported_history",
      "incomplete_decision",
      "operation_id_reused",
      "stale_revision",
      "successor_changed",
      "duplicate_content",
      "shareability_refused",
      "dashboard_memory_read_only",
      "brand_new_code",
    ];
    const sentences = codes.map(explainReason);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(RAW_CODE);
      expect(sentence.endsWith(".")).toBe(true);
    }
    // Known codes get their own explanation, not the generic fallback.
    expect(new Set(sentences.slice(0, -1)).size).toBe(codes.length - 1);
    expect(sentences.at(-1)).toContain("doesn't recognise");
  });

  test("a decision's reason keeps writer prose and turns bare codes into sentences", () => {
    expect(decisionReason("Tightened the wording.")).toBe("Tightened the wording.");
    expect(decisionReason("expired")).toBe("It reached its expiry date.");
    expect(decisionReason("low_signal_after_review")).toBe("Low signal after review.");
    expect(decisionReason("  ")).toBe("No reason was recorded.");
  });
});

// ── Timeline rows ──────────────────────────────────────────────

describe("timeline", () => {
  test("an edit shows who, why, when and a before/after of content and fields", () => {
    const view = decisionView(editDecision);
    expect(view.who).toBe("You, in the dashboard");
    expect(view.why).toBe("Tightened the wording.");
    expect(view.when).toBe(T0);
    expect(view.headline).toBe("Edited #7");
    const [row] = view.rows;
    expect(row.fields).toEqual([
      { field: "category", label: "Category", before: "Constraints", after: "Workflow rules" },
    ]);
    const parts = row.contentDiff ?? [];
    expect(
      parts
        .filter((p) => p.kind !== "add")
        .map((p) => p.text)
        .join(""),
    ).toBe("Use bun for tests");
    expect(
      parts
        .filter((p) => p.kind !== "del")
        .map((p) => p.text)
        .join(""),
    ).toBe("Use bun test for every package");
    expect(parts.some((p) => p.kind === "add")).toBe(true);
    expect(parts.some((p) => p.kind === "del")).toBe(true);

    const html = renderToString(() => DecisionCard({ decision: editDecision, onUndo: () => {} }));
    expect(html).toContain("You, in the dashboard");
    expect(html).toContain("Tightened the wording.");
    expect(html).toContain("Edited #7");
    expect(html).toContain('class="history-add"');
    expect(html).toContain('class="history-del"');
    expect(html).toContain("Workflow rules");
    expect(html).toContain("Undo this change");
  });

  test("usage counters and timestamps are not reported as changes", () => {
    const before = snap(1);
    const after = snap(1, {
      revision: 9,
      seenCount: 40,
      retrievalCount: 8,
      updatedAt: T0 + 1,
      lastSeenAt: T0 + 1,
    });
    expect(fieldChanges(before, after)).toEqual([]);
    expect(rowView(change(1, "target", before, after)).kind).toBe("unchanged");
  });

  test("the word diff keeps a word that only gained text after its full stop", () => {
    expect(diffWords("two value sets.", "two value sets on :root.")).toEqual([
      { kind: "same", text: "two value sets" },
      { kind: "add", text: " on :root" },
      { kind: "same", text: "." },
    ]);
  });

  test("the word diff falls back to whole texts for very long inputs", () => {
    const long = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    const parts = diffWords(long, `${long} extra`);
    expect(parts).toEqual([
      { kind: "del", text: long },
      { kind: "add", text: `${long} extra` },
    ]);
  });

  test("pages append newest first and never list a decision twice", () => {
    const a = decision({ decisionKey: "a" });
    const b = decision({ decisionKey: "b" });
    const c = decision({ decisionKey: "c" });
    const shown = appendHistoryPage([], { version: 1, decisions: [a, b], nextCursor: "x" });
    const next = appendHistoryPage(shown, { version: 1, decisions: [b, c], nextCursor: null });
    expect(next.map((d) => d.decisionKey)).toEqual(["a", "b", "c"]);
  });
});

describe("merge grouping", () => {
  test("a merge shows all its sources and the survivor together as one decision", () => {
    const view = decisionView(mergeDecision);
    expect(view.isMerge).toBe(true);
    expect(view.headline).toBe("Merged #11, #12 into #20 (new)");
    expect(view.why).toBe("It duplicated another memory.");
    expect(view.sources.map((s) => [s.memoryId, s.kind])).toEqual([
      [11, "archived"],
      [12, "archived"],
    ]);
    expect(view.survivor?.memoryId).toBe(20);
    expect(view.survivor?.kind).toBe("created");
    expect(view.rows).toEqual([]);
    expect(view.sources[0].fields).toContainEqual({
      field: "supersededByMemoryId",
      label: "Replaced by",
      before: "nothing",
      after: "#20",
    });

    const html = renderToString(() =>
      DecisionCard({ decision: mergeDecision, focusMemoryId: 12, onUndo: () => {} }),
    );
    // One card, one undo button, sources before the survivor.
    expect(html.match(/<article/g)?.length).toBe(1);
    expect(html.match(/Undo this change/g)?.length).toBe(1);
    const combined = html.indexOf("Combined");
    const into = html.indexOf("Into");
    expect(combined).toBeGreaterThan(-1);
    expect(html.indexOf("#11 archived")).toBeGreaterThan(combined);
    expect(html.indexOf("#12 archived")).toBeGreaterThan(combined);
    expect(into).toBeGreaterThan(html.indexOf("#12 archived"));
    expect(html.indexOf("#20 created")).toBeGreaterThan(into);
    expect(html).toContain("Combined memory text");
    expect(html).toMatch(
      /class="history-row\s+focus"><div class="history-row-summary">#12 archived/,
    );
  });

  test("a merge into an existing memory groups its before/after with the sources", () => {
    const merge = decision({
      ...mergeDecision,
      rows: [
        mergeDecision.rows[0],
        change(
          20,
          "survivor",
          snap(20, { content: "Short" }),
          snap(20, { revision: 4, content: "Short and complete" }),
        ),
      ],
    });
    const view = decisionView(merge);
    expect(view.headline).toBe("Merged #11 into #20");
    expect(view.survivor?.kind).toBe("changed");
    expect(view.survivor?.contentDiff?.some((p) => p.kind === "add")).toBe(true);
  });
});

describe("legacy history", () => {
  test("legacy-partial history is readable, explains why it can't be undone, and offers no undo", () => {
    const view = decisionView(legacyDecision);
    expect(view.who).toBe("Expiry");
    expect(view.why).toBe("It reached its expiry date.");
    expect(view.rows[0].kind).toBe("partial");
    expect(view.rows[0].contentDiff).toBeNull();
    expect(view.rows[0].content).toBe("Old fact");
    expect(view.rows[0].limitation).toContain("without the state after it");
    expect(restoreLimit(legacyDecision)).toContain("older version");
    expect(restoreLimit(editDecision)).toBeNull();

    const html = renderToString(() => DecisionCard({ decision: legacyDecision, onUndo: () => {} }));
    expect(html).not.toContain("Undo this change");
    expect(html).toContain("didn't save enough detail to undo it safely");
    // With the after state missing, the recorded operation still names what happened.
    expect(view.headline).toBe("Archived #30");
    expect(html).toContain("Old fact");
  });

  test("a non-restorable decision without legacy rows explains its refusal code in words", () => {
    const refused = decision({
      restorable: false,
      refusalReason: "target_not_owned",
      rows: editDecision.rows,
    });
    expect(restoreLimit(refused)).toBe(explainReason("target_not_owned"));
    expect(restoreLimit(refused)).not.toMatch(RAW_CODE);
  });
});

// ── Undo: preview → confirm → result ───────────────────────────

function mockUndoApi(
  previewReply: MemoryRestorePreview | Error,
  restoreReply: MemoryRestoreReceipt | Error = receipt(),
) {
  const calls = { preview: [] as unknown[], restore: [] as unknown[] };
  let ids = 0;
  const api: UndoApi = {
    previewMemoryRestore: async (request) => {
      calls.preview.push(request);
      if (previewReply instanceof Error) throw previewReply;
      return previewReply;
    },
    restoreMemoryHistory: async (request) => {
      calls.restore.push(request);
      if (restoreReply instanceof Error) throw restoreReply;
      return restoreReply;
    },
    newOperationId: () => `op-${++ids}`,
  };
  return { api, calls };
}

const body = (state: UndoState) => renderToString(() => UndoBody({ state }));
const footer = (state: UndoState) =>
  renderToString(() =>
    UndoFooter({ state, onClose: () => {}, onRecheck: () => {}, onConfirm: () => {} }),
  );

describe("undo preview", () => {
  test("a ready preview shows exactly what will change and offers the undo", async () => {
    const { api, calls } = mockUndoApi(preview());
    const state = await loadUndoPreview(api, "git:fixture", "edit-1");
    expect(calls.preview).toEqual([{ projectPath: "git:fixture", decisionKey: "edit-1" }]);
    expect(state.phase).toBe("preview");

    const html = body(state);
    expect(html).toContain("One memory will go back to how it was before this change:");
    expect(html).toContain("Now");
    expect(html).toContain("After undo");
    // Current state on the left, restored state on the right.
    expect(html.indexOf("Workflow rules")).toBeLessThan(html.indexOf("Constraints"));
    expect(html).toContain('class="history-del"');
    expect(html).toContain(ADOPTION_NOTE);
    expect(footer(state)).toContain("Undo this change");
    expect(calls.restore).toEqual([]);
  });

  test("a conflicting preview explains a successor edited since the merge, and offers a recheck instead of undo", async () => {
    const { api } = mockUndoApi(
      preview({
        state: "conflict",
        reason: "successor_changed",
        decision: mergeDecision,
        changes: [],
      }),
    );
    const state = await loadUndoPreview(api, "git:fixture", "merge-1");
    const html = body(state);
    expect(html).toContain("This can't be undone right now.");
    expect(html).toContain("Memory #20, which this merge produced, has been edited since.");
    expect(html).not.toMatch(RAW_CODE);
    const buttons = footer(state);
    expect(buttons).toContain("Check again");
    expect(buttons).not.toContain("Undo this change");
  });

  test("stale and duplicate preview conflicts read as plain sentences", () => {
    expect(previewProblems(preview({ state: "conflict", reason: "stale_revision" }))).toEqual([
      explainReason("stale_revision"),
    ]);
    expect(previewProblems(preview({ state: "conflict", reason: "duplicate_content" }))).toEqual([
      explainReason("duplicate_content"),
    ]);
  });

  test("a refused preview of legacy history says why it can't be restored", async () => {
    const { api } = mockUndoApi(
      preview({
        state: "refused",
        reason: "incomplete_decision",
        decision: legacyDecision,
        changes: [],
      }),
    );
    const state = await loadUndoPreview(api, "git:fixture", "legacy-1");
    const html = body(state);
    expect(html).toContain("This change can't be undone.");
    expect(html).toContain("older version");
    expect(footer(state)).not.toContain("Undo this change");
    expect(footer(state)).not.toContain("Check again");
  });

  test("a preview that fails to load is an error with a retry, never a result", async () => {
    const { api } = mockUndoApi(new Error("socket closed"));
    const state = await loadUndoPreview(api, "git:fixture", "edit-1");
    expect(state).toEqual({
      phase: "error",
      message: "Couldn't prepare the undo: socket closed",
      retry: null,
    });
    expect(body(state)).toContain("Nothing was changed.");
    expect(footer(state)).toContain("Try again");
  });
});

describe("undo confirm", () => {
  test("confirming sends the preview's expected revisions with a fresh operation id per preview", async () => {
    const { api, calls } = mockUndoApi(preview());
    const first = await loadUndoPreview(api, "git:fixture", "edit-1");
    const second = await loadUndoPreview(api, "git:fixture", "edit-1");
    if (first.phase !== "preview" || second.phase !== "preview")
      throw new Error("expected previews");
    expect(first.operationId).not.toBe(second.operationId);

    const result = await confirmUndo(api, second.preview, second.operationId);
    expect(calls.restore).toEqual([
      {
        projectPath: "git:fixture",
        decisionKey: "edit-1",
        operationId: second.operationId,
        expectedRevisions: [{ memoryId: 7, revision: 4 }],
      },
    ]);
    expect(result).toEqual({ phase: "result", receipt: receipt() });
  });

  test("an applied undo says how many memories were restored and when sessions see it", () => {
    const state: UndoState = { phase: "result", receipt: receipt() };
    const html = body(state);
    expect(html).toContain('data-undo-result="applied"');
    expect(html).toContain("Undone. 1 memory restored.");
    expect(html).toContain(ADOPTION_NOTE);
    expect(footer(state)).toContain("Close");
    expect(footer(state)).not.toContain("Undo this change");
  });

  test("a conflict reply lists each conflicting memory in words and claims nothing changed", () => {
    const view = receiptView(
      receipt({
        state: "conflict",
        reason: "duplicate_content",
        restoredDecisionKey: null,
        revisions: [],
        conflicts: [{ memoryId: 7, expectedRevision: 4, currentRevision: 4, duplicateId: 9 }],
      }),
    );
    expect(view.tone).toBe("warning");
    expect(view.title).toContain("Nothing was changed");
    expect(view.details).toEqual([
      "Memory #7 would become identical to memory #9, which already exists. Edit or archive one of them first.",
    ]);

    const stale = receiptView(
      receipt({
        state: "conflict",
        reason: "stale_revision",
        restoredDecisionKey: null,
        revisions: [],
        conflicts: [{ memoryId: 7, expectedRevision: 4, currentRevision: 6 }],
      }),
    );
    expect(stale.details).toEqual([
      "Memory #7 has changed since this was loaded. Reload and try again.",
    ]);

    const html = body({
      phase: "result",
      receipt: receipt({
        state: "conflict",
        reason: "stale_revision",
        restoredDecisionKey: null,
        revisions: [],
        conflicts: [],
      }),
    });
    expect(html).toContain('data-undo-result="conflict"');
    expect(html).not.toMatch(RAW_CODE);
  });

  test("a refused reply explains the refusal without its code", () => {
    const html = body({
      phase: "result",
      receipt: receipt({
        state: "refused",
        reason: "authority_unavailable",
        restoredDecisionKey: null,
        revisions: [],
      }),
    });
    expect(html).toContain('data-undo-result="refused"');
    expect(html).toContain("Nothing was changed: the undo was refused.");
    expect(html).toContain("isn't reachable right now");
    expect(html).not.toMatch(RAW_CODE);
  });

  test("a lost restore reply keeps the same operation id for the retry", async () => {
    const { api, calls } = mockUndoApi(preview(), new Error("connection reset"));
    const ready = await loadUndoPreview(api, "git:fixture", "edit-1");
    if (ready.phase !== "preview") throw new Error("expected preview");
    const failed = await confirmUndo(api, ready.preview, ready.operationId);
    expect(failed).toEqual({
      phase: "error",
      message: "The undo didn't go through: connection reset",
      retry: { preview: ready.preview, operationId: ready.operationId },
    });
    expect(body(failed)).toContain("trying again shows its result instead of applying it twice");
    expect(calls.restore).toHaveLength(1);
  });

  test("only a ready preview can be confirmed", async () => {
    const { api, calls } = mockUndoApi(preview());
    await expect(confirmUndo(api, preview({ state: "conflict" }), "op-x")).rejects.toThrow();
    expect(calls.restore).toEqual([]);
  });
});

// ── Audited edits ──────────────────────────────────────────────

describe("edits", () => {
  test("an applied edit carries the new revision and the decision to undo", () => {
    expect(editOutcome(editReceipt(), 7, "Content saved.")).toEqual({
      kind: "applied",
      decisionKey: "edit-2",
      revision: 5,
      message: "Content saved.",
    });
    const html = renderToString(() =>
      EditNotice({
        outcome: editOutcome(editReceipt(), 7, "Archived."),
        onReload: () => {},
        onUndo: () => {},
      }),
    );
    expect(html).toContain('data-edit-notice="applied"');
    expect(html).toContain("Undo");
    expect(html).not.toContain("Reload");
  });

  test("a stale-revision conflict asks for a reload and offers no undo", () => {
    const outcome = editOutcome(
      editReceipt({
        state: "conflict",
        reason: "stale_revision",
        decisionKey: null,
        revisions: [],
        conflicts: [{ memoryId: 7, expectedRevision: 4, currentRevision: 6 }],
      }),
      7,
      "Content saved.",
    );
    expect(outcome).toEqual({ kind: "conflict", message: EDIT_CONFLICT_MESSAGE });
    expect(EDIT_CONFLICT_MESSAGE).toContain("changed since you opened it");
    const html = renderToString(() =>
      EditNotice({ outcome, onReload: () => {}, onUndo: () => {} }),
    );
    expect(html).toContain('data-edit-notice="conflict"');
    expect(html).toContain("Reload");
    expect(html).not.toContain(">Undo<");
  });

  test("a duplicate-content conflict names the memory that already says it", () => {
    const outcome = editOutcome(
      editReceipt({
        state: "conflict",
        reason: "duplicate_content",
        decisionKey: null,
        revisions: [],
        conflicts: [{ memoryId: 7, expectedRevision: 4, currentRevision: 4, duplicateId: 9 }],
      }),
      7,
      "Content saved.",
    );
    expect(outcome).toEqual({
      kind: "conflict",
      message: "Another memory (#9) already says exactly this. Nothing was changed.",
    });
  });

  test("a refused edit explains the refusal in words", () => {
    const outcome = editOutcome(
      editReceipt({
        state: "refused",
        reason: "dashboard_memory_read_only",
        decisionKey: null,
        revisions: [],
      }),
      7,
      "Saved.",
    );
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).not.toMatch(RAW_CODE);
    expect(outcome.message).toContain("Nothing was changed.");
  });
});

// ── Wire shape (backend mocked at the HTTP bridge) ─────────────

describe("memory API wire shape", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function captureInvokes(reply: unknown) {
    const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    return sent;
  }

  test("history, preview and restore each send one request object under the contract's command names", async () => {
    const sent = captureInvokes({ version: 1, decisions: [], nextCursor: null });
    await api.getMemoryHistory({
      projectPath: "git:fixture",
      memoryId: 7,
      limit: 25,
      cursor: "c1",
    });
    await api.previewMemoryRestore({ projectPath: "git:fixture", decisionKey: "edit-1" });
    await api.restoreMemoryHistory({
      projectPath: "git:fixture",
      decisionKey: "edit-1",
      operationId: "op-1",
      expectedRevisions: [{ memoryId: 7, revision: 4 }],
    });
    expect(sent).toEqual([
      {
        cmd: "get_memory_history",
        args: { request: { projectPath: "git:fixture", memoryId: 7, limit: 25, cursor: "c1" } },
      },
      {
        cmd: "preview_memory_restore",
        args: { request: { projectPath: "git:fixture", decisionKey: "edit-1" } },
      },
      {
        cmd: "restore_memory_history",
        args: {
          request: {
            projectPath: "git:fixture",
            decisionKey: "edit-1",
            operationId: "op-1",
            expectedRevisions: [{ memoryId: 7, revision: 4 }],
          },
        },
      },
    ]);
  });

  test("edits send the displayed revision, project and operation id; delete commands archive", async () => {
    const sent = captureInvokes(editReceipt());
    const target = {
      projectPath: "git:fixture",
      memoryId: 7,
      expectedRevision: 4,
      operationId: "op-9",
    };
    await api.updateMemoryStatus(target, "permanent");
    await api.updateMemoryCategory(target, "NAMING");
    await api.updateMemoryContent(target, "New text");
    await api.archiveMemory(target);
    const bulk = {
      projectPath: "git:fixture",
      memoryIds: [7, 8],
      expectedRevisions: [
        { memoryId: 7, revision: 4 },
        { memoryId: 8, revision: 2 },
      ],
      operationId: "op-10",
    };
    await api.bulkUpdateMemoryStatus(bulk, "archived");
    await api.bulkArchiveMemories(bulk);
    expect(sent).toEqual([
      { cmd: "update_memory_status", args: { ...target, status: "permanent" } },
      { cmd: "update_memory_category", args: { ...target, category: "NAMING" } },
      { cmd: "update_memory_content", args: { ...target, content: "New text" } },
      { cmd: "delete_memory", args: target },
      { cmd: "bulk_update_memory_status", args: { ...bulk, status: "archived" } },
      { cmd: "bulk_delete_memory", args: bulk },
    ]);
  });

  test("operation ids are unique per call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => api.newOperationId()));
    expect(ids.size).toBe(50);
  });
});
