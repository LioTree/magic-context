/**
 * One-time handoff of tag numbers from the retired Rust transform to the
 * TypeScript transform.
 *
 * While a session ran the Rust transform, ck-mc numbered its tags in store.db
 * (`mc_tags`, keyed by `<message id>#<block index>`) and the model saw those
 * numbers as `§N§`. context.db's `tags` table kept whatever the TypeScript
 * transform had numbered before the switch, so the same number often names a
 * different message there. Without this import the first TypeScript pass would
 * renumber every visible tag and reuse numbers the model has already seen, and
 * a later `ctx_reduce` naming an old number would drop the wrong content.
 *
 * On the first TypeScript pass for such a session, inside one context.db write
 * transaction and before the tagger loads:
 *  - every visible block ck-mc tagged gets the same number on its TypeScript
 *    identity (`<message id>:p<part index>` for text, call id + owner message
 *    for tools);
 *  - context.db tag rows whose message is no longer on the wire (history
 *    behind OpenCode's compaction marker) are deleted with their saved source
 *    text, so later passes never load them; any other row holding a number at
 *    or below ck-mc's highest number moves above every number either side
 *    used, with its source_contents row, so numbers the model saw now name
 *    either the block ck-mc showed or nothing;
 *  - the session counter continues above ck-mc's highest number;
 *  - drops ck-mc applied and drops still queued in ck-mc are carried over,
 *    replacing the TypeScript queue left over from before the switch;
 *  - session watermarks stored as tag numbers are translated to the new
 *    numbering so they cover the same messages as before.
 * A marker row in `schema_migrations_meta` makes the import run once per
 * session. store.db is only ever opened read-only.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX,
    WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX,
} from "../../features/magic-context/storage-tags";
import { getHarness } from "../../shared/harness";
import { sessionLog } from "../../shared/logger";
import { Database, getSqliteDatabasePath } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { estimateToolAttachmentImageTokens } from "./image-token-estimate";
import { type ModuleRawBlockMapping, moduleRawBlockMappings } from "./module-wire";
import { byteSize, stripTagPrefix } from "./tag-content-primitives";
import {
    estimateTextTagTokenCount,
    extractToolTagMetadata,
    type MessageLike,
} from "./tag-messages";
import { isTextPart, isToolPartWithOutput } from "./tag-part-guards";

/** `schema_migrations_meta` key prefix recording that a session's import ran. */
export const LEGACY_CK_TAG_IMPORT_MARKER_PREFIX = "legacy_ck_tag_import:";

export function legacyCkTagImportMarkerKey(sessionId: string): string {
    return `${LEGACY_CK_TAG_IMPORT_MARKER_PREFIX}${sessionId}`;
}

type DropMode = "full" | "truncated" | "skeleton_real" | "edit_marker";

interface CkTagRow {
    tagNumber: number;
    blockId: string;
    kind: string;
}

/** Everything the import needs from store.db, read in one snapshot. */
export interface LegacyCkTagSnapshot {
    tags: CkTagRow[];
    /** Highest tag number ck-mc ever handed out for the session. */
    highWater: number;
    /** Latest ck-mc activity for the session, in epoch milliseconds. */
    lastActivityMs: number;
    pendingDrops: Array<{ blockId: string; queuedAt: number }>;
    /** Block kinds per message as ck-mc decoded them, used to prove the block mapping. */
    blockKinds: Map<string, string[]>;
    /** Reductions ck-mc applied, keyed by block id, valued by reduction kind. */
    reductions: Map<string, string>;
}

export type LegacyCkTagImportStatus =
    | "imported"
    | "already-imported"
    | "no-store"
    | "store-unreadable"
    | "no-ck-state"
    | "typescript-newer"
    | "failed";

export interface LegacyCkTagImportResult {
    status: LegacyCkTagImportStatus;
    highWater?: number;
    /** Visible ck-mc tags that now carry the same number in context.db. */
    imported?: number;
    /** Of those, rows newly created because context.db had no row for the part. */
    inserted?: number;
    /** context.db rows moved above the high-water mark to free ck-mc's numbers. */
    relocated?: number;
    /** TypeScript-era rows (and their saved text) deleted because their message is off the wire. */
    deleted?: number;
    /** ck-mc tags whose message is not in this pass's messages (number reserved only). */
    notVisible?: number;
    /** ck-mc tags whose block could not be matched exactly to a part. */
    unmatched?: number;
    droppedImported?: number;
    pendingImported?: number;
    pendingSkipped?: number;
}

interface PlannedTag {
    tagNumber: number;
    identity:
        | { type: "message"; messageId: string; text: string }
        | { type: "tool"; callId: string; ownerMessageId: string; part: unknown; output: string };
    reduction: DropMode | null;
}

const checkedSessions = new WeakMap<Database, Set<string>>();

function wasChecked(db: Database, sessionId: string): boolean {
    return checkedSessions.get(db)?.has(sessionId) ?? false;
}

function markChecked(db: Database, sessionId: string): void {
    let set = checkedSessions.get(db);
    if (!set) {
        set = new Set();
        checkedSessions.set(db, set);
    }
    set.add(sessionId);
}

function readMarker(db: Database, sessionId: string): string | null {
    const row = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(legacyCkTagImportMarkerKey(sessionId)) as { value: string } | null | undefined;
    return row?.value ?? null;
}

function writeMarker(db: Database, sessionId: string, value: Record<string, unknown>): void {
    db.prepare(
        "INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    ).run(legacyCkTagImportMarkerKey(sessionId), JSON.stringify(value));
}

/** store.db lives next to context.db in the Magic Context data directory. */
export function resolveLegacyCkStorePath(db: Database): string | null {
    const path = getSqliteDatabasePath(db);
    return path ? join(dirname(path), "store.db") : null;
}

function splitBlockId(blockId: string): { messageId: string; blockIndex: number } | null {
    const at = blockId.lastIndexOf("#");
    if (at <= 0) return null;
    const blockIndex = Number(blockId.slice(at + 1));
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) return null;
    return { messageId: blockId.slice(0, at), blockIndex };
}

function tableExists(store: Database, name: string): boolean {
    const row = store
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) as { present: number } | null | undefined;
    return row?.present === 1;
}

/**
 * Read one session's ck-mc tag state from store.db. Returns null when the
 * session has no ck-mc tags. Throws when store.db cannot be read.
 */
export function readLegacyCkTagSnapshot(
    storePath: string,
    sessionId: string,
    visibleMessageIds: ReadonlySet<string>,
): LegacyCkTagSnapshot | null {
    const store = new Database(storePath, { readonly: true });
    try {
        return store
            .transaction(() => {
                if (!tableExists(store, "mc_tags")) return null;
                const tags = (
                    store
                        .prepare(
                            "SELECT tag_number AS tagNumber, block_id AS blockId, kind FROM mc_tags WHERE session_id = ? ORDER BY tag_number",
                        )
                        .all(sessionId) as CkTagRow[]
                ).filter((row) => Number.isSafeInteger(row.tagNumber) && row.tagNumber > 0);
                if (tags.length === 0) return null;

                let highWater = tags[tags.length - 1]?.tagNumber ?? 0;
                let lastActivityMs = 0;
                const tagTimes = store
                    .prepare("SELECT MAX(created_at_ms) AS last FROM mc_tags WHERE session_id = ?")
                    .get(sessionId) as { last: number | null } | undefined;
                lastActivityMs = Math.max(lastActivityMs, tagTimes?.last ?? 0);
                // The generation table keeps the highest number ever issued even
                // when the row holding it is gone, so it is the safer high-water mark.
                if (tableExists(store, "mc_tag_cache_generations")) {
                    const generation = store
                        .prepare(
                            "SELECT max_tag_number AS maxTag FROM mc_tag_cache_generations WHERE session_id = ?",
                        )
                        .get(sessionId) as { maxTag: number | null } | undefined;
                    highWater = Math.max(highWater, generation?.maxTag ?? 0);
                }
                if (tableExists(store, "mc_cache_state")) {
                    const state = store
                        .prepare(
                            "SELECT last_activity_at AS last FROM mc_cache_state WHERE session_id = ?",
                        )
                        .get(sessionId) as { last: number | null } | undefined;
                    lastActivityMs = Math.max(lastActivityMs, state?.last ?? 0);
                }

                const pendingDrops = tableExists(store, "pending_agent_drops")
                    ? (store
                          .prepare(
                              "SELECT target_id AS blockId, queued_at AS queuedAt FROM pending_agent_drops WHERE session_id = ? ORDER BY queued_at, id",
                          )
                          .all(sessionId) as Array<{ blockId: string; queuedAt: number }>)
                    : [];

                const blockKinds = new Map<string, string[]>();
                if (tableExists(store, "mc_block_identities")) {
                    const statement = store.prepare(
                        "SELECT identities FROM mc_block_identities WHERE session_id = ? AND mid = ?",
                    );
                    for (const messageId of visibleMessageIds) {
                        const row = statement.get(sessionId, messageId) as
                            | { identities: string }
                            | null
                            | undefined;
                        if (!row) continue;
                        const parsed: unknown = JSON.parse(row.identities);
                        if (!Array.isArray(parsed)) continue;
                        blockKinds.set(
                            messageId,
                            parsed.map((entry) =>
                                entry !== null &&
                                typeof entry === "object" &&
                                typeof (entry as { kind_tag?: unknown }).kind_tag === "string"
                                    ? (entry as { kind_tag: string }).kind_tag
                                    : "",
                            ),
                        );
                    }
                }

                // Applied reductions are frozen decisions keyed `red:<block id>`.
                const reductions = new Map<string, string>();
                if (tableExists(store, "mc_cache_frozen_chunks")) {
                    const chunks = store
                        .prepare(
                            "SELECT body FROM mc_cache_frozen_chunks WHERE session_id = ? ORDER BY chunk",
                        )
                        .all(sessionId) as Array<{ body: string }>;
                    for (const chunk of chunks) {
                        const units: unknown = JSON.parse(chunk.body);
                        if (!Array.isArray(units)) continue;
                        for (const unit of units) {
                            if (unit === null || typeof unit !== "object") continue;
                            const { key, kind } = unit as { key?: unknown; kind?: unknown };
                            if (typeof key !== "string" || typeof kind !== "string") continue;
                            if (!key.startsWith("red:")) continue;
                            reductions.set(key.slice(4), kind);
                        }
                    }
                }

                return { tags, highWater, lastActivityMs, pendingDrops, blockKinds, reductions };
            })
            .deferred();
    } finally {
        closeQuietly(store);
    }
}

/**
 * TypeScript's raw block mapping and ck-mc's decoder name some part kinds
 * differently (an `image` part is "other" here and "media" in ck-mc; `thinking`
 * parts are "reasoning" here and "opaque" there). Both emit exactly one block
 * for each, so these pairs still describe the same block.
 */
const COMPATIBLE_CK_KINDS: Record<ModuleRawBlockMapping["kind"], readonly string[]> = {
    text: ["text"],
    reasoning: ["reasoning", "redacted_reasoning", "opaque"],
    tool_call: ["tool_call"],
    tool_result: ["tool_result"],
    file: ["media"],
    other: ["opaque", "media"],
};

/**
 * True when ck-mc's recorded block kinds for a message agree with the blocks
 * derived from the message as it is now. ck-mc's record may be shorter, because
 * a message only grows by appending blocks (a running tool gains its result);
 * any disagreement in the shared prefix means the indexes are not comparable.
 */
function blockKindsAgree(mappings: ModuleRawBlockMapping[], ckKinds: readonly string[]): boolean {
    if (ckKinds.length > mappings.length) return false;
    for (let index = 0; index < ckKinds.length; index += 1) {
        const mapping = mappings[index];
        if (!mapping || mapping.blockIndex !== index) return false;
        if (!COMPATIBLE_CK_KINDS[mapping.kind].includes(ckKinds[index] ?? "")) return false;
    }
    return true;
}

const TAG_KIND_TO_BLOCK_KIND: Record<string, ModuleRawBlockMapping["kind"]> = {
    message: "text",
    tool_result: "tool_result",
    tool_call: "tool_call",
};

/** ck-mc reduction kind on a tool's call block → the TypeScript drop mode that renders it. */
const CALL_REDUCTION_TO_DROP_MODE: Record<string, DropMode> = {
    drop: "full",
    skeleton: "truncated",
    skeleton_real: "skeleton_real",
    edit_marker: "edit_marker",
};

interface VisibleMessage {
    message: MessageLike;
    mappings: ModuleRawBlockMapping[];
    /** False when ck-mc's recorded block kinds contradict the current blocks. */
    comparable: boolean;
}

export interface LegacyCkImportPlan {
    tags: PlannedTag[];
    /** Planned tag number for each identity key (see identityKey). */
    numberByIdentity: Map<string, number>;
    pending: Array<{ tagNumber: number; queuedAt: number }>;
    notVisible: number;
    unmatched: number;
    pendingSkipped: number;
    /** Ids of the messages in this pass; tag rows owned by any other message are history. */
    wireMessageIds: Set<string>;
    /** Tool call ids in this pass, for legacy tool rows that never recorded an owner. */
    wireCallIds: Set<string>;
}

function identityKey(identity: PlannedTag["identity"]): string {
    return identity.type === "message"
        ? `m:${identity.messageId}`
        : `t:${identity.ownerMessageId}\u0000${identity.callId}`;
}

/** The TypeScript tag identity of the part behind one block, or null when TypeScript never tags it. */
function identityForBlock(
    messageId: string,
    message: MessageLike,
    mapping: ModuleRawBlockMapping,
): PlannedTag["identity"] | null {
    const part = message.parts[mapping.partIndex];
    if (mapping.kind === "text") {
        if (!isTextPart(part)) return null;
        return {
            type: "message",
            messageId: `${messageId}:p${mapping.partIndex}`,
            text: part.text,
        };
    }
    if (mapping.kind === "tool_call" || mapping.kind === "tool_result") {
        // TypeScript tags a tool only once it has a string output, keyed by its call id.
        if (!isToolPartWithOutput(part)) return null;
        return {
            type: "tool",
            callId: part.callID,
            ownerMessageId: messageId,
            part,
            output: part.state.output,
        };
    }
    return null;
}

/**
 * Match ck-mc's tags, applied reductions and queued drops to the parts of the
 * messages in this pass. Pure: reads nothing but its arguments.
 */
export function planLegacyCkImport(
    messages: readonly MessageLike[],
    snapshot: LegacyCkTagSnapshot,
): LegacyCkImportPlan {
    const visible = new Map<string, VisibleMessage>();
    for (const message of messages) {
        const messageId = message.info.id;
        if (typeof messageId !== "string" || messageId.length === 0) continue;
        const mappings = moduleRawBlockMappings({
            id: messageId,
            role: message.info.role ?? "",
            parts: message.parts,
        });
        const ckKinds = snapshot.blockKinds.get(messageId);
        visible.set(messageId, {
            message,
            mappings,
            comparable: ckKinds === undefined || blockKindsAgree(mappings, ckKinds),
        });
    }

    const resolveBlock = (
        blockId: string,
    ): {
        messageId: string;
        visibleMessage: VisibleMessage;
        mapping: ModuleRawBlockMapping;
    } | null => {
        const split = splitBlockId(blockId);
        if (!split) return null;
        const visibleMessage = visible.get(split.messageId);
        if (!visibleMessage?.comparable) return null;
        const mapping = visibleMessage.mappings.find(
            (candidate) => candidate.blockIndex === split.blockIndex,
        );
        return mapping ? { messageId: split.messageId, visibleMessage, mapping } : null;
    };

    const tags: PlannedTag[] = [];
    const planByIdentity = new Map<string, PlannedTag>();
    let notVisible = 0;
    let unmatched = 0;
    for (const row of snapshot.tags) {
        const split = splitBlockId(row.blockId);
        if (!split || !visible.has(split.messageId)) {
            notVisible += 1;
            continue;
        }
        const resolved = resolveBlock(row.blockId);
        if (!resolved || resolved.mapping.kind !== TAG_KIND_TO_BLOCK_KIND[row.kind]) {
            unmatched += 1;
            continue;
        }
        const identity = identityForBlock(
            resolved.messageId,
            resolved.visibleMessage.message,
            resolved.mapping,
        );
        if (!identity) {
            unmatched += 1;
            continue;
        }
        const key = identityKey(identity);
        // One part can only carry one number. ck-mc tags one block per part, so
        // a second claim means the mapping is not exact; keep the first.
        if (planByIdentity.has(key)) {
            unmatched += 1;
            continue;
        }
        const planned: PlannedTag = { tagNumber: row.tagNumber, identity, reduction: null };
        planByIdentity.set(key, planned);
        tags.push(planned);
    }

    // Applied reductions. A tool's call block carries the mode the model saw
    // (a full drop, a skeleton or an edit marker); a reduction on the result
    // block alone means the call stayed with its real arguments.
    const resultOnly = new Set<string>();
    for (const [blockId, kind] of snapshot.reductions) {
        const resolved = resolveBlock(blockId);
        if (!resolved) continue;
        const identity = identityForBlock(
            resolved.messageId,
            resolved.visibleMessage.message,
            resolved.mapping,
        );
        if (!identity) continue;
        const planned = planByIdentity.get(identityKey(identity));
        if (!planned) continue;
        if (identity.type === "message") {
            if (kind === "drop") planned.reduction = "full";
            continue;
        }
        if (resolved.mapping.kind === "tool_call") {
            const mode = CALL_REDUCTION_TO_DROP_MODE[kind];
            if (mode) planned.reduction = mode;
        } else if (kind === "drop") {
            resultOnly.add(identityKey(identity));
        }
    }
    for (const key of resultOnly) {
        const planned = planByIdentity.get(key);
        if (planned && planned.reduction === null) planned.reduction = "skeleton_real";
    }

    const numberByIdentity = new Map<string, number>();
    for (const [key, planned] of planByIdentity) numberByIdentity.set(key, planned.tagNumber);

    // Queued drops name a block; re-anchor each on the number its part now carries.
    const pending: Array<{ tagNumber: number; queuedAt: number }> = [];
    let pendingSkipped = 0;
    for (const drop of snapshot.pendingDrops) {
        const resolved = resolveBlock(drop.blockId);
        const identity = resolved
            ? identityForBlock(
                  resolved.messageId,
                  resolved.visibleMessage.message,
                  resolved.mapping,
              )
            : null;
        const tagNumber = identity ? numberByIdentity.get(identityKey(identity)) : undefined;
        if (tagNumber === undefined) {
            pendingSkipped += 1;
            continue;
        }
        pending.push({ tagNumber, queuedAt: drop.queuedAt });
    }

    const wireCallIds = new Set<string>();
    for (const message of messages) {
        for (const part of message.parts) {
            if (isToolPartWithOutput(part)) wireCallIds.add(part.callID);
            else if (
                part !== null &&
                typeof part === "object" &&
                typeof (part as { callID?: unknown }).callID === "string"
            )
                wireCallIds.add((part as { callID: string }).callID);
        }
    }

    return {
        tags,
        numberByIdentity,
        pending,
        notVisible,
        unmatched,
        pendingSkipped,
        wireMessageIds: new Set(visible.keys()),
        wireCallIds,
    };
}

interface ExistingRow {
    id: number;
    tagNumber: number;
}

function findExistingRow(
    db: Database,
    sessionId: string,
    identity: PlannedTag["identity"],
): ExistingRow | null {
    const row =
        identity.type === "message"
            ? db
                  .prepare(
                      "SELECT id, tag_number AS tagNumber FROM tags WHERE session_id = ? AND message_id = ? AND type = 'message' ORDER BY id LIMIT 1",
                  )
                  .get(sessionId, identity.messageId)
            : db
                  .prepare(
                      "SELECT id, tag_number AS tagNumber FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = ? AND tool_owner_message_id = ? ORDER BY id LIMIT 1",
                  )
                  .get(sessionId, identity.callId, identity.ownerMessageId);
    return (row as ExistingRow | null | undefined) ?? null;
}

function maxOf(db: Database, sql: string, sessionId: string): number {
    const row = db.prepare(sql).get(sessionId) as { value: number | null } | null | undefined;
    return row?.value ?? 0;
}

/**
 * Translate a watermark stored as a tag number ("everything numbered at or
 * below W") into the imported numbering. The watermark covered the visible
 * parts whose previous number was at or below W; the result covers those same
 * parts and never reaches a part it did not cover. Parts that had no previous
 * row were tagged after the switch and stay uncovered.
 */
function translateWatermark(
    watermark: number,
    planned: ReadonlyArray<{ tagNumber: number; previousNumber: number | null }>,
): number {
    if (watermark <= 0) return 0;
    let coveredMax = 0;
    let uncoveredMin = Number.POSITIVE_INFINITY;
    for (const item of planned) {
        if (item.previousNumber !== null && item.previousNumber <= watermark) {
            coveredMax = Math.max(coveredMax, item.tagNumber);
        } else {
            uncoveredMin = Math.min(uncoveredMin, item.tagNumber);
        }
    }
    return Math.max(0, Math.min(coveredMax, uncoveredMin - 1));
}

const TAG_NUMBER_WATERMARKS = ["cleared_reasoning_through_tag", "tool_reclaim_watermark"] as const;

interface ApplyCounts {
    imported: number;
    inserted: number;
    relocated: number;
    deleted: number;
    droppedImported: number;
    pendingImported: number;
}

interface HistoryCandidateRow {
    id: number;
    tagNumber: number;
    type: string;
    messageId: string;
    owner: string | null;
    fingerprint: string | null;
}

/**
 * The message a tag row belongs to: the owner for tools, the `<message id>`
 * before `:p<n>` / `:file<n>` for text and files, and for a retired whitespace
 * row the message named in its fingerprint. Null when the row names none.
 */
function rowMessageId(row: HistoryCandidateRow): string | null {
    if (row.type === "tool") return row.owner;
    if (row.messageId.startsWith(WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX)) {
        const contentId = row.fingerprint?.startsWith(WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX)
            ? row.fingerprint.slice(WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX.length)
            : null;
        return contentId ? contentId.slice(0, contentId.lastIndexOf(":")) : null;
    }
    const separator = row.messageId.lastIndexOf(":");
    return separator > 0 ? row.messageId.slice(0, separator) : row.messageId;
}

/**
 * Delete TypeScript-era tag rows whose message is no longer in this pass's
 * messages, with their saved source text. Those messages sit behind OpenCode's
 * compaction marker, so no pass renders them again. Kept, their numbers sit
 * above the imported window and every later pass would load them through the
 * tagger's live-wire floor. Nothing needs them for correctness: the readers
 * that scan every row of a session only count them for display or return
 * "unknown tag" for a number the model can no longer see.
 */
function deleteHistoryRows(
    db: Database,
    sessionId: string,
    plan: LegacyCkImportPlan,
    identityRowIds: ReadonlySet<number>,
): number {
    const rows = db
        .prepare(
            `SELECT id, tag_number AS tagNumber, type, message_id AS messageId,
                    tool_owner_message_id AS owner, entry_fingerprint AS fingerprint
             FROM tags WHERE session_id = ?`,
        )
        .all(sessionId) as HistoryCandidateRow[];
    const deleteIds: number[] = [];
    const deleteNumbers: number[] = [];
    for (const row of rows) {
        if (identityRowIds.has(row.id)) continue;
        const messageId = rowMessageId(row);
        if (messageId !== null && plan.wireMessageIds.has(messageId)) continue;
        // A tool row from before owners were recorded is claimed by its call id.
        if (row.type === "tool" && row.owner === null && plan.wireCallIds.has(row.messageId))
            continue;
        deleteIds.push(row.id);
        deleteNumbers.push(row.tagNumber);
    }
    if (deleteIds.length === 0) return 0;
    db.prepare(
        "DELETE FROM source_contents WHERE session_id = ? AND tag_id IN (SELECT value FROM json_each(?))",
    ).run(sessionId, JSON.stringify(deleteNumbers));
    db.prepare(
        "DELETE FROM tags WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))",
    ).run(sessionId, JSON.stringify(deleteIds));
    // Saved text whose tag row is already gone can only ever be restored onto
    // the wrong part once its number is reused.
    db.prepare(
        `DELETE FROM source_contents WHERE session_id = ?
         AND tag_id NOT IN (SELECT tag_number FROM tags WHERE session_id = ?)`,
    ).run(sessionId, sessionId);
    return deleteIds.length;
}

/** Write the plan into context.db. Runs inside the caller's write transaction. */
function applyLegacyCkImport(
    db: Database,
    sessionId: string,
    snapshot: LegacyCkTagSnapshot,
    plan: LegacyCkImportPlan,
): ApplyCounts {
    const highWater = snapshot.highWater;
    const harness = getHarness();
    const counter = maxOf(
        db,
        "SELECT counter AS value FROM session_meta WHERE session_id = ?",
        sessionId,
    );

    const existing = plan.tags.map((planned) => findExistingRow(db, sessionId, planned.identity));
    const keepIds: number[] = [];
    const keepNumbers: number[] = [];
    plan.tags.forEach((planned, index) => {
        const row = existing[index];
        if (row && row.tagNumber === planned.tagNumber) {
            keepIds.push(row.id);
            keepNumbers.push(row.tagNumber);
        }
    });

    const deleted = deleteHistoryRows(
        db,
        sessionId,
        plan,
        new Set(existing.flatMap((row) => (row ? [row.id] : []))),
    );

    // Moving rows by a constant larger than every number in use keeps their
    // order and can never land on an occupied number.
    const offset = Math.max(
        highWater,
        counter,
        maxOf(db, "SELECT MAX(tag_number) AS value FROM tags WHERE session_id = ?", sessionId),
        maxOf(
            db,
            "SELECT MAX(tag_id) AS value FROM source_contents WHERE session_id = ?",
            sessionId,
        ),
    );

    // Session meta must exist (with this harness) before tag rows change, the
    // same order the tagger uses when it allocates.
    db.prepare(
        `INSERT INTO session_meta (session_id, counter, harness) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET counter = MAX(session_meta.counter, excluded.counter)`,
    ).run(sessionId, counter, harness);

    // What is left at or below the high-water mark after the history delete
    // belongs to messages still on the wire that ck-mc did not tag (a file part,
    // for example). Counted up front: the statement's change count would
    // include rows the tag triggers touch.
    const relocated = (
        db
            .prepare(
                `SELECT COUNT(*) AS n FROM tags
                 WHERE session_id = ? AND tag_number <= ? AND id NOT IN (SELECT value FROM json_each(?))`,
            )
            .get(sessionId, highWater, JSON.stringify(keepIds)) as { n: number }
    ).n;
    db.prepare(
        `UPDATE tags SET tag_number = tag_number + ?
         WHERE session_id = ? AND tag_number <= ? AND id NOT IN (SELECT value FROM json_each(?))`,
    ).run(offset, sessionId, highWater, JSON.stringify(keepIds));
    // Saved source text is keyed by tag number; it moves with its row so a
    // reused number never restores another part's text.
    db.prepare(
        `UPDATE source_contents SET tag_id = tag_id + ?
         WHERE session_id = ? AND tag_id <= ? AND tag_id NOT IN (SELECT value FROM json_each(?))`,
    ).run(offset, sessionId, highWater, JSON.stringify(keepNumbers));

    const moveRow = db.prepare("UPDATE tags SET tag_number = ? WHERE id = ?");
    const moveSource = db.prepare(
        "UPDATE source_contents SET tag_id = ? WHERE session_id = ? AND tag_id = ?",
    );
    const insertRow = db.prepare(
        `INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, drop_mode,
             tool_name, input_byte_size, harness, tool_owner_message_id, token_count, input_token_count)
         VALUES (?, ?, ?, 'active', ?, ?, 'full', ?, ?, ?, ?, ?, ?)`,
    );
    const setStatus = db.prepare(
        "UPDATE tags SET status = ?, drop_mode = COALESCE(?, drop_mode) WHERE session_id = ? AND tag_number = ?",
    );

    let inserted = 0;
    let droppedImported = 0;
    const watermarkInputs: Array<{ tagNumber: number; previousNumber: number | null }> = [];
    plan.tags.forEach((planned, index) => {
        const row = existing[index] ?? null;
        watermarkInputs.push({
            tagNumber: planned.tagNumber,
            previousNumber: row?.tagNumber ?? null,
        });
        if (row && row.tagNumber !== planned.tagNumber) {
            const current = row.tagNumber <= highWater ? row.tagNumber + offset : row.tagNumber;
            moveRow.run(planned.tagNumber, row.id);
            moveSource.run(planned.tagNumber, sessionId, current);
        } else if (!row) {
            const identity = planned.identity;
            if (identity.type === "message") {
                const text = stripTagPrefix(identity.text);
                insertRow.run(
                    sessionId,
                    identity.messageId,
                    "message",
                    byteSize(text),
                    planned.tagNumber,
                    null,
                    0,
                    harness,
                    null,
                    estimateTextTagTokenCount(text),
                    null,
                );
            } else {
                const output = stripTagPrefix(identity.output);
                const metadata = extractToolTagMetadata(identity.part);
                const state = (identity.part as { state?: unknown }).state;
                insertRow.run(
                    sessionId,
                    identity.callId,
                    "tool",
                    byteSize(identity.output),
                    planned.tagNumber,
                    metadata.toolName,
                    metadata.inputByteSize,
                    harness,
                    identity.ownerMessageId,
                    estimateTextTagTokenCount(output) + estimateToolAttachmentImageTokens(state),
                    metadata.inputTokenCount,
                );
            }
            inserted += 1;
        }
        // Status follows what ck-mc last rendered for this part: dropped if it
        // applied a reduction, otherwise active.
        if (planned.reduction !== null) droppedImported += 1;
        setStatus.run(
            planned.reduction === null ? "active" : "dropped",
            planned.reduction,
            sessionId,
            planned.tagNumber,
        );
    });

    // The TypeScript queue still holds drops from before the Rust transform
    // took over; ck-mc was seeded with them then and its own queue is current.
    db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
    const queue = db.prepare(
        `INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness)
         SELECT ?, ?, 'drop', ?, ? WHERE NOT EXISTS (
             SELECT 1 FROM pending_ops WHERE session_id = ? AND tag_id = ? AND operation = 'drop'
         )`,
    );
    for (const drop of plan.pending) {
        queue.run(sessionId, drop.tagNumber, drop.queuedAt, harness, sessionId, drop.tagNumber);
    }
    const pendingImported = maxOf(
        db,
        "SELECT COUNT(*) AS value FROM pending_ops WHERE session_id = ?",
        sessionId,
    );

    const meta = db
        .prepare(
            `SELECT ${TAG_NUMBER_WATERMARKS.join(", ")} FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId) as Record<(typeof TAG_NUMBER_WATERMARKS)[number], number | null> | null;
    if (meta) {
        for (const column of TAG_NUMBER_WATERMARKS) {
            db.prepare(`UPDATE session_meta SET ${column} = ? WHERE session_id = ?`).run(
                translateWatermark(meta[column] ?? 0, watermarkInputs),
                sessionId,
            );
        }
    }

    // New numbers continue above everything either transform ever used.
    const finalMax = Math.max(
        highWater,
        maxOf(db, "SELECT MAX(tag_number) AS value FROM tags WHERE session_id = ?", sessionId),
    );
    db.prepare("UPDATE session_meta SET counter = MAX(counter, ?) WHERE session_id = ?").run(
        finalMax,
        sessionId,
    );

    return {
        imported: plan.tags.length,
        inserted,
        relocated,
        deleted,
        droppedImported,
        pendingImported,
    };
}

/** Newest TypeScript tagging activity: the transform saves source text whenever it tags new text. */
function latestTypeScriptTaggingMs(db: Database, sessionId: string): number {
    return maxOf(
        db,
        "SELECT MAX(created_at) AS value FROM source_contents WHERE session_id = ?",
        sessionId,
    );
}

/**
 * Run the import for one session if it has not run yet. Call before the
 * tagger loads the session. Never throws; failures are logged and the pass
 * continues with whatever context.db holds.
 */
export function importLegacyCkTagsOnce(args: {
    db: Database;
    sessionId: string;
    messages: readonly MessageLike[];
    /** Override for tests; production derives store.db from context.db's path. */
    storePath?: string | null;
}): LegacyCkTagImportResult {
    const { db, sessionId, messages } = args;
    if (wasChecked(db, sessionId)) return { status: "already-imported" };
    let marker: string | null;
    try {
        marker = readMarker(db, sessionId);
    } catch (error) {
        // context.db itself is failing; the pass reports that on its own read.
        sessionLog(sessionId, "legacy tag import: could not read its marker:", error);
        return { status: "failed" };
    }
    markChecked(db, sessionId);
    if (marker !== null) return { status: "already-imported" };

    const storePath = args.storePath === undefined ? resolveLegacyCkStorePath(db) : args.storePath;
    if (!storePath || !existsSync(storePath)) return { status: "no-store" };

    let snapshot: LegacyCkTagSnapshot | null;
    try {
        const visibleIds = new Set<string>();
        for (const message of messages) {
            if (typeof message.info.id === "string") visibleIds.add(message.info.id);
        }
        snapshot = readLegacyCkTagSnapshot(storePath, sessionId, visibleIds);
    } catch (error) {
        sessionLog(
            sessionId,
            "legacy tag import: store.db unreadable; new tags continue above context.db's highest number:",
            error,
        );
        return { status: "store-unreadable" };
    }
    if (!snapshot) return { status: "no-ck-state" };

    try {
        const plan = planLegacyCkImport(messages, snapshot);
        const result = db
            .transaction((): LegacyCkTagImportResult => {
                // Another process may have finished the import while we read store.db.
                if (readMarker(db, sessionId) !== null) return { status: "already-imported" };
                // The TypeScript transform tagged this session after ck-mc last
                // touched it, so the model has been seeing TypeScript's numbers.
                if (latestTypeScriptTaggingMs(db, sessionId) > snapshot.lastActivityMs) {
                    writeMarker(db, sessionId, {
                        v: 1,
                        status: "typescript-newer",
                        at: Date.now(),
                    });
                    return { status: "typescript-newer", highWater: snapshot.highWater };
                }
                const counts = applyLegacyCkImport(db, sessionId, snapshot, plan);
                const summary: LegacyCkTagImportResult = {
                    status: "imported",
                    highWater: snapshot.highWater,
                    ...counts,
                    notVisible: plan.notVisible,
                    unmatched: plan.unmatched,
                    pendingSkipped: plan.pendingSkipped,
                };
                writeMarker(db, sessionId, { v: 1, ...summary, at: Date.now() });
                return summary;
            })
            .immediate();
        if (result.status === "imported") {
            sessionLog(
                sessionId,
                `legacy tag import: high-water=${result.highWater} imported=${result.imported} inserted=${result.inserted} relocated=${result.relocated} deleted=${result.deleted} dropped=${result.droppedImported} pending=${result.pendingImported} pendingSkipped=${result.pendingSkipped} notVisible=${result.notVisible} unmatched=${result.unmatched}`,
            );
        }
        return result;
    } catch (error) {
        sessionLog(sessionId, "legacy tag import failed; retrying in the next process:", error);
        // Still keep new numbers above every number ck-mc used.
        try {
            db.prepare(
                `INSERT INTO session_meta (session_id, counter, harness) VALUES (?, ?, ?)
                 ON CONFLICT(session_id) DO UPDATE SET counter = MAX(session_meta.counter, excluded.counter)`,
            ).run(sessionId, snapshot.highWater, getHarness());
        } catch {
            // Best effort; the failure is already logged.
        }
        return { status: "failed", highWater: snapshot.highWater };
    }
}
