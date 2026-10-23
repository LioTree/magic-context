import { getHarness } from "../../../shared/harness";
import type { Database } from "../../../shared/sqlite";
import { escapeXmlAttr, escapeXmlContent } from "../compartment-storage";

/**
 * Agent memory fragments: the immutable, pre-rendered m[1] lines one agent
 * `ctx_memory` operation (save, update, merge, archive) produces for the session
 * that made it.
 *
 * The prompt shows memory changes only two ways. A HARD fold reads current
 * memory rows into a new m[0]. Between HARD folds, a busting SOFT pass appends
 * that session's own agent fragments to m[1]. Dashboard operations separately
 * enter through tagged mutation-log payloads on the same authorized refresh.
 * Automated writers (historian, dreamer verify, expiry) write no
 * fragment, so their changes stay out of the prompt until the next natural HARD.
 * Fragments are written in the same transaction as the canonical change, so a
 * fragment exists exactly when its operation committed.
 */

export interface AgentFragmentInput {
    sessionId: string;
    /** Defaults to this process's harness. */
    harness?: string;
    projectPath: string;
    /** The applier decision key; one fragment per operation. */
    operationKey: string;
    memoryIds: readonly number[];
    /** The memory that now holds the current text, when there is one. */
    currentId: number | null;
    lines: readonly string[];
    /** The full texts these lines show, for search visibility. */
    visibleTexts: ReadonlyArray<{ id: number; text: string }>;
}

export interface AgentFragment {
    dashboardLogId?: number;
    id: number;
    operationKey: string;
    memoryIds: number[];
    currentId: number | null;
    lines: string[];
    visibleTexts: Array<{ id: number; text: string }>;
}

function fragmentsTablePresent(db: Database): boolean {
    return Boolean(
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_agent_fragments'",
            )
            .get(),
    );
}

/** Record one operation's fragment. A retried operation keeps its first fragment. */
export function recordAgentFragment(db: Database, input: AgentFragmentInput): void {
    if (!input.sessionId || input.lines.length === 0 || !fragmentsTablePresent(db)) return;
    db.prepare(
        `INSERT OR IGNORE INTO memory_agent_fragments
            (session_id, harness, project_path, operation_key, memory_ids_json, current_id, lines, visible_texts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        input.sessionId,
        input.harness ?? getHarness(),
        input.projectPath,
        input.operationKey,
        JSON.stringify([...input.memoryIds]),
        input.currentId,
        input.lines.join("\n"),
        JSON.stringify(input.visibleTexts),
        Date.now(),
    );
}

interface FragmentRow {
    id: number;
    operation_key: string;
    memory_ids_json: string;
    current_id: number | null;
    lines: string;
    visible_texts_json: string;
}

/** This session's fragments with an id above `afterId`, oldest first. */
export function loadAgentFragmentsAfter(
    db: Database,
    sessionId: string,
    afterId: number,
    harness: string = getHarness(),
): AgentFragment[] {
    if (!fragmentsTablePresent(db)) return [];
    const rows = db
        .prepare(
            "SELECT id, operation_key, memory_ids_json, current_id, lines, visible_texts_json FROM memory_agent_fragments WHERE session_id=? AND harness=? AND id>? ORDER BY id",
        )
        .all(sessionId, harness, afterId) as FragmentRow[];
    return rows.map((row) => ({
        id: row.id,
        operationKey: row.operation_key,
        memoryIds: JSON.parse(row.memory_ids_json) as number[],
        currentId: row.current_id,
        lines: row.lines.split("\n"),
        visibleTexts: JSON.parse(row.visible_texts_json) as Array<{ id: number; text: string }>,
    }));
}

/** The newest fragment id of this session; a HARD fold covers every fragment up to it. */
export function maxAgentFragmentId(
    db: Database,
    sessionId: string,
    harness: string = getHarness(),
): number {
    if (!fragmentsTablePresent(db)) return 0;
    const row = db
        .prepare(
            "SELECT MAX(id) AS id FROM memory_agent_fragments WHERE session_id=? AND harness=?",
        )
        .get(sessionId, harness) as { id: number | null } | null;
    return row?.id ?? 0;
}

function categoryAttribute(category: string | null | undefined): string {
    return category ? ` category="${escapeXmlAttr(category)}"` : "";
}

/** The memory's text was replaced. */
export function renderUpdatedFragmentLine(
    id: number,
    category: string | null,
    text: string,
): string {
    return `  <updated id="${id}"${categoryAttribute(category)}>${escapeXmlContent(text)}</updated>`;
}

/** A new memory, saved or produced as a merge survivor. */
export function renderAddedFragmentLine(id: number, category: string | null, text: string): string {
    return `  <added id="${id}"${categoryAttribute(category)}>${escapeXmlContent(text)}</added>`;
}

export function renderRemovedFragmentLine(id: number): string {
    return `  <removed id="${id}"/>`;
}

export function renderSupersededFragmentLine(id: number, by: number): string {
    return `  <superseded id="${id}" by="${by}"/>`;
}

/**
 * One short line for a fragment whose full lines do not fit m[1]: the shown text
 * of these memories is out of date, and the current text is available through
 * ctx_search. It carries no memory text.
 */
export function renderStaleFragmentMarker(
    fragment: Pick<AgentFragment, "memoryIds" | "currentId">,
): string {
    const current = fragment.currentId === null ? "" : ` current="${fragment.currentId}"`;
    return `  <stale-memory ids="${fragment.memoryIds.join(",")}"${current} read-with="ctx_search"/>`;
}

/** Dashboard operations are admitted only on an authorized refresh, then frozen
 * in the served projection. Read the log payload, never the live memory text. */
export function loadDashboardFragmentsAfter(
    db: Database,
    projectPath: string,
    afterId: number,
    baselineIds: readonly number[],
    maxMemoryId: number,
): AgentFragment[] {
    const ids = new Set(baselineIds);
    const rows = db
        .prepare(`SELECT id, project_path, target_memory_id, mutation_type, superseded_by_id,
            category, new_content, operation_id FROM memory_mutation_log
        WHERE id > ? AND operation_id LIKE 'dashboard:%'
          AND (project_path = ? OR target_memory_id IN (SELECT value FROM json_each(?)))
        ORDER BY id`)
        .all(afterId, projectPath, JSON.stringify(baselineIds)) as Array<{
        id: number;
        project_path: string;
        target_memory_id: number;
        mutation_type: string;
        superseded_by_id: number | null;
        category: string | null;
        new_content: string | null;
        operation_id: string;
    }>;
    const fragments = rows.map((row) => {
        const id = row.target_memory_id;
        const removed =
            row.project_path !== projectPath ||
            row.mutation_type === "archive" ||
            row.mutation_type === "delete";
        const line = removed
            ? renderRemovedFragmentLine(id)
            : row.mutation_type === "superseded" && row.superseded_by_id !== null
              ? renderSupersededFragmentLine(id, row.superseded_by_id)
              : ids.has(id) && id <= maxMemoryId
                ? renderUpdatedFragmentLine(id, row.category, row.new_content ?? "")
                : renderAddedFragmentLine(id, row.category, row.new_content ?? "");
        return {
            id: 0,
            dashboardLogId: row.id,
            operationKey: row.operation_id,
            memoryIds: [id],
            currentId: removed ? null : id,
            lines: [line],
            visibleTexts:
                removed || row.mutation_type === "superseded"
                    ? []
                    : [{ id, text: row.new_content ?? "" }],
        };
    });
    // Keep a multi-row edit or undo indivisible when the correction budget fills.
    const grouped = new Map<string, AgentFragment>();
    for (const fragment of fragments) {
        const prior = grouped.get(fragment.operationKey);
        if (!prior) grouped.set(fragment.operationKey, fragment);
        else {
            prior.dashboardLogId = fragment.dashboardLogId;
            prior.memoryIds.push(...fragment.memoryIds);
            prior.lines.push(...fragment.lines);
            prior.visibleTexts.push(...fragment.visibleTexts);
            prior.currentId = fragment.currentId;
        }
    }
    return [...grouped.values()];
}
