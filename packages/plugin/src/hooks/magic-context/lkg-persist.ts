import { createHash } from "node:crypto";

import { assembleLkgPrefix, layoutLkgPrefix } from "../../features/magic-context/lkg-prefix-chunks";
import { isRustMarkerAdmissionFenced } from "../../features/magic-context/storage-replay-document";
import { drainBackgroundBatches } from "../../shared/background-batch-drain";
import { getHarness } from "../../shared/harness";
import { sessionLog } from "../../shared/logger";
import { type Database, withoutSqliteTransformPass } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import { clearLkgRecoveryFence, commitLkgWithRecoveryFence } from "./lkg-recovery-fence";
import {
    ownsServedMarkerAllocation,
    pendingServedDigest,
    readServedMarkerRow,
    recordServedSlotState,
} from "./lkg-served-marker";
import type { LkgPersistenceBackend, LkgSlot } from "./lkg-slot";

/**
 * Durable persistence for last-known-good (LKG) transform snapshots.
 *
 * The in-memory slot map in lkg-slot.ts dies with the process. When the plugin
 * restarts while the Rust module is reconnecting, the recovery ladder used to
 * have nothing to replay and the turn fell all the way down to the raw-fallback
 * size gate. Persisting the slot an applied pass captured lets a fresh process
 * serve the same replay — subject to exactly the same validity fences a live
 * process applies (hydration only restores the slot; replay validation is
 * unchanged).
 *
 * Write discipline follows the single-stringify precedent: `jsonPrefix` is the
 * exact string captured by the applied pass and is stored as-is — never
 * re-serialized here. Only the small metadata arrays are serialized.
 *
 * The prefix lives in `lkg_slot_chunks` as fixed-position slices
 * (lkg-prefix-chunks.ts); `lkg_slots` keeps the metadata plus the slice count,
 * total length and hash that a load checks before anything is replayed.
 */

interface LkgSlotRow {
    session_id?: unknown;
    /** Assembled from `lkg_slot_chunks` by the loader; not a stored column. */
    json_prefix?: unknown;
    input_id_seq?: unknown;
    input_content_digests?: unknown;
    input_content_signatures?: unknown;
    last_input_message_id?: unknown;
    model_key?: unknown;
    provider_key?: unknown;
    captured_at?: unknown;
    row_version?: unknown;
    capture_sequence?: unknown;
    served_capture_id?: unknown;
    input_move_digests?: unknown;
}

function parseStringArray(value: unknown): string[] | null {
    if (typeof value !== "string") return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const result: string[] = [];
    for (const entry of parsed) {
        if (typeof entry !== "string" || entry.length === 0) return null;
        result.push(entry);
    }
    return result;
}

function parseNullableString(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : undefined;
}

function parseNullableInteger(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Parse a stored row into a slot; returns undefined (and reasons to delete) on any malformation. */
export function parsePersistedLkgSlot(row: unknown): LkgSlot | undefined {
    if (!row || typeof row !== "object") return undefined;
    const record = row as LkgSlotRow;
    const jsonPrefix = record.json_prefix;
    const lastInputMessageId = record.last_input_message_id;
    const capturedAt = record.captured_at;
    // Legacy and OpenCode rows keep the plain ID array. Pi adds versioned
    // output ownership so a hydrated slot can prove a head-contraction splice.
    let inputIdsRaw = record.input_id_seq;
    let piOutputEntryIds: (string | null)[] | undefined;
    if (typeof inputIdsRaw === "string") {
        try {
            const metadata = JSON.parse(inputIdsRaw);
            if (
                metadata &&
                !Array.isArray(metadata) &&
                metadata.version === 1 &&
                Array.isArray(metadata.piOutputEntryIds)
            ) {
                if (
                    !metadata.piOutputEntryIds.every(
                        (id: unknown) => id === null || (typeof id === "string" && id.length > 0),
                    )
                )
                    return undefined;
                piOutputEntryIds = metadata.piOutputEntryIds;
                inputIdsRaw = JSON.stringify(metadata.inputIds);
            }
        } catch {
            return undefined;
        }
    }
    const inputIdSeq = parseStringArray(inputIdsRaw);
    const inputContentDigests = parseStringArray(record.input_content_digests);
    const modelKey = parseNullableString(record.model_key);
    const providerKey = parseNullableString(record.provider_key);
    if (
        typeof jsonPrefix !== "string" ||
        typeof lastInputMessageId !== "string" ||
        lastInputMessageId.length === 0 ||
        typeof capturedAt !== "number" ||
        !Number.isFinite(capturedAt) ||
        inputIdSeq === null ||
        inputContentDigests === null ||
        inputContentDigests.length !== inputIdSeq.length ||
        modelKey === undefined ||
        providerKey === undefined
    ) {
        return undefined;
    }
    if (piOutputEntryIds) {
        try {
            const output = JSON.parse(jsonPrefix);
            const inputs = new Set(inputIdSeq);
            if (
                !Array.isArray(output) ||
                output.length !== piOutputEntryIds.length ||
                piOutputEntryIds.some((id) => id !== null && !inputs.has(id))
            )
                return undefined;
        } catch {
            return undefined;
        }
    }
    let inputContentSignatures: string[] | undefined;
    if (record.input_content_signatures !== null && record.input_content_signatures !== undefined) {
        const parsed = parseStringArray(record.input_content_signatures);
        if (parsed === null || parsed.length !== inputIdSeq.length) return undefined;
        inputContentSignatures = parsed;
    }
    const slot: LkgSlot = {
        jsonPrefix,
        inputIdSeq,
        inputContentDigests,
        lastInputMessageId,
        modelKey,
        providerKey,
        capturedAt,
    };
    if (inputContentSignatures) slot.inputContentSignatures = inputContentSignatures;
    if (piOutputEntryIds) slot.piOutputEntryIds = piOutputEntryIds;
    const rowVersion = parseNullableInteger(record.row_version);
    if (rowVersion !== undefined) slot.rowVersion = rowVersion;
    const captureSequence = parseNullableInteger(record.capture_sequence);
    if (captureSequence !== undefined) slot.captureSequence = captureSequence;
    const servedCaptureId = parseNullableInteger(record.served_capture_id);
    if (servedCaptureId !== undefined) {
        if (servedCaptureId <= 0) return undefined;
        slot.servedCaptureId = servedCaptureId;
    }
    if (record.input_move_digests !== null && record.input_move_digests !== undefined) {
        const digests = parseStringArray(record.input_move_digests);
        if (
            !digests ||
            digests.length !== inputIdSeq.length ||
            digests.some((digest) => !/^[0-9a-f]{64}$/.test(digest))
        )
            return undefined;
        slot.inputMoveDigests = digests;
    }
    return slot;
}

/**
 * Fingerprint of the slot each session last saved through this handle, so an
 * unchanged slot skips the database entirely.
 */
const persistedFingerprints = new WeakMap<Database, Map<string, string>>();
const PERSISTED_FINGERPRINT_MAX_SESSIONS = 1000;

function rememberFingerprint(db: Database, sessionId: string, fingerprint: string): void {
    let saved = persistedFingerprints.get(db);
    if (!saved) {
        saved = new Map();
        persistedFingerprints.set(db, saved);
    }
    saved.delete(sessionId);
    if (saved.size >= PERSISTED_FINGERPRINT_MAX_SESSIONS) {
        const oldest = saved.keys().next().value;
        if (oldest !== undefined) saved.delete(oldest);
    }
    saved.set(sessionId, fingerprint);
}

/**
 * The identity a served-capture certificate binds, in exactly the text form the
 * `lkg_slots` row stores, so a reader can recompute the digest from the row alone.
 * `prefixHash` is the row's `json_prefix_hash`; loads verify it against every
 * stored slice. Capture time and the process-local capture ordinal are excluded:
 * a repeated serve of identical bytes keeps its certificate.
 */
export interface LkgCertifiedIdentity {
    prefixHash: string;
    inputIdSeq: string;
    inputContentDigests: string;
    inputContentSignatures: string | null;
    inputMoveDigests: string | null;
    lastInputMessageId: string;
    modelKey: string | null;
    providerKey: string | null;
    rowVersion: number | null;
}

export function lkgCertificateDigest(identity: LkgCertifiedIdentity): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                "lkg-served-certificate-v1",
                identity.prefixHash,
                identity.inputIdSeq,
                identity.inputContentDigests,
                identity.inputContentSignatures,
                identity.inputMoveDigests,
                identity.lastInputMessageId,
                identity.modelKey,
                identity.providerKey,
                identity.rowVersion,
            ]),
        )
        .digest("hex");
}

/** Serialize a slot's certified identity the same way `persistLkgSlot` stores it. */
function certifiedIdentity(slot: LkgSlot, prefixHash: string): LkgCertifiedIdentity {
    return {
        prefixHash,
        inputIdSeq: JSON.stringify(
            slot.piOutputEntryIds
                ? { version: 1, inputIds: slot.inputIdSeq, piOutputEntryIds: slot.piOutputEntryIds }
                : slot.inputIdSeq,
        ),
        inputContentDigests: JSON.stringify(slot.inputContentDigests),
        inputContentSignatures: slot.inputContentSignatures
            ? JSON.stringify(slot.inputContentSignatures)
            : null,
        inputMoveDigests: slot.inputMoveDigests ? JSON.stringify(slot.inputMoveDigests) : null,
        lastInputMessageId: slot.lastInputMessageId,
        modelKey: slot.modelKey,
        providerKey: slot.providerKey,
        rowVersion: slot.rowVersion ?? null,
    };
}

/**
 * The certificate digest of a slot's exact bytes. Hashes the whole prefix, so
 * callers on the serve path use `boundLkgCertificate` instead.
 */
export function lkgSlotCertificateDigest(slot: LkgSlot): string {
    return lkgCertificateDigest(certifiedIdentity(slot, layoutLkgPrefix(slot.jsonPrefix).hash));
}

/**
 * The certificate this connection last bound for a session: its id, digest and
 * prefix. A repeated serve compares its prefix with this record instead of
 * hashing the request again.
 */
export interface BoundLkgCertificate {
    servedCaptureId: number;
    digest: string;
    jsonPrefix: string;
}
const boundCertificates = new WeakMap<Database, Map<string, BoundLkgCertificate>>();

export function boundLkgCertificate(
    db: Database,
    sessionId: string,
): BoundLkgCertificate | undefined {
    return boundCertificates.get(db)?.get(sessionId);
}

function rememberBoundCertificate(
    db: Database,
    sessionId: string,
    certificate: BoundLkgCertificate,
): void {
    let bound = boundCertificates.get(db);
    if (!bound) {
        bound = new Map();
        boundCertificates.set(db, bound);
    }
    bound.delete(sessionId);
    if (bound.size >= PERSISTED_FINGERPRINT_MAX_SESSIONS) {
        const oldest = bound.keys().next().value;
        if (oldest !== undefined) bound.delete(oldest);
    }
    bound.set(sessionId, certificate);
}

/**
 * A slot saved with its certificate deferred: the bytes are durable under the
 * id, but the marker stays unbound until the request is dispatched. Kept per
 * connection so only the writer that saved the bytes can bind them.
 */
interface PreparedLkgCertificate extends BoundLkgCertificate {
    prefixHash: string;
    /** The marker's stored value while the id is unbound (its pending token, or legacy NULL). */
    unboundValue: string | null;
}
const preparedCertificates = new WeakMap<Database, Map<string, PreparedLkgCertificate>>();
/** Marker slot state of a request saved before dispatch whose pass was then refused. */
const UNDISPATCHED_SLOT_STATE = "undispatched";

function rememberPreparedCertificate(
    db: Database,
    sessionId: string,
    certificate: PreparedLkgCertificate,
): void {
    let prepared = preparedCertificates.get(db);
    if (!prepared) {
        prepared = new Map();
        preparedCertificates.set(db, prepared);
    }
    prepared.delete(sessionId);
    if (prepared.size >= PERSISTED_FINGERPRINT_MAX_SESSIONS) {
        const oldest = prepared.keys().next().value;
        if (oldest !== undefined) prepared.delete(oldest);
    }
    prepared.set(sessionId, certificate);
}

/**
 * Record that a request saved with `deferCertificate` will never be dispatched:
 * its pass was refused after the save committed. The bytes stay durable, but the
 * marker's slot state becomes `undispatched`, so the id never certifies and a
 * restarted process does not hydrate them. Only the writer that saved them can
 * mark them. Never throws.
 */
export function refuseUndispatchedLkgSlot(
    db: Database,
    sessionId: string,
    servedCaptureId: number,
): boolean {
    const prepared = preparedCertificates.get(db)?.get(sessionId);
    if (!prepared || prepared.servedCaptureId !== servedCaptureId) return false;
    preparedCertificates.get(db)?.delete(sessionId);
    try {
        // A refused pass is often refused because it ran past its deadline, and a
        // pass's write guard then blocks its writes. Recording that its request was
        // never sent publishes nothing for it, so it runs outside that guard.
        return withoutSqliteTransformPass(
            () =>
                db
                    .prepare(
                        `UPDATE lkg_served_markers SET slot_state = '${UNDISPATCHED_SLOT_STATE}'
                    WHERE session_id = ? AND served_capture_id = ? AND slot_state = 'captured'
                    AND served_digest IS ?`,
                    )
                    .run(sessionId, servedCaptureId, prepared.unboundValue).changes > 0,
        );
    } catch (error) {
        sessionLog(sessionId, "LKG refused request could not be marked undispatched:", error);
        return false;
    }
}

/** Whether this connection saved the slot's bytes with their certificate deferred, not yet dispatched. */
export function isPreparedUndispatchedLkgSlot(
    db: Database,
    sessionId: string,
    servedCaptureId: number | undefined,
): boolean {
    return (
        servedCaptureId !== undefined &&
        preparedCertificates.get(db)?.get(sessionId)?.servedCaptureId === servedCaptureId
    );
}

/**
 * Bind the certificate of a slot saved with `deferCertificate`, once its request
 * was actually dispatched. Binds only while the marker still names that id
 * unbound and storage still holds those bytes under it. Returns whether the id
 * now certifies those bytes. Never throws: a missed bind leaves the slot
 * durable but uncertified, and a restarted process will not replay it.
 */
export function certifyDispatchedLkgSlot(
    db: Database,
    sessionId: string,
    servedCaptureId: number,
): boolean {
    const prepared = preparedCertificates.get(db)?.get(sessionId);
    if (!prepared || prepared.servedCaptureId !== servedCaptureId) return false;
    preparedCertificates.get(db)?.delete(sessionId);
    try {
        const { changes } = db
            .prepare(
                `UPDATE lkg_served_markers SET served_digest = ?
                WHERE session_id = ? AND served_capture_id = ? AND slot_state = 'captured'
                AND served_digest IS ?
                AND EXISTS (SELECT 1 FROM lkg_slots WHERE session_id = ?
                    AND served_capture_id = ? AND json_prefix_hash = ?)`,
            )
            .run(
                prepared.digest,
                sessionId,
                servedCaptureId,
                prepared.unboundValue,
                sessionId,
                servedCaptureId,
                prepared.prefixHash,
            );
        if (changes === 0) return false;
        rememberBoundCertificate(db, sessionId, {
            servedCaptureId,
            digest: prepared.digest,
            jsonPrefix: prepared.jsonPrefix,
        });
        return true;
    } catch (error) {
        sessionLog(sessionId, "LKG dispatched request left uncertified:", error);
        return false;
    }
}

function slotFingerprint(slot: LkgSlot): string {
    // capturedAt is the time of this capture, not part of the served request.
    // Keep all replay fences and metadata in the fingerprint so a changed slot
    // always replaces the durable one. Hash without reading the existing row.
    return createHash("sha256")
        .update(
            JSON.stringify([
                slot.jsonPrefix,
                slot.inputIdSeq,
                slot.inputContentDigests,
                slot.inputContentSignatures,
                slot.piOutputEntryIds,
                slot.lastInputMessageId,
                slot.modelKey,
                slot.providerKey,
                slot.rowVersion,
                slot.captureSequence,
                slot.servedCaptureId,
                slot.inputMoveDigests,
            ]),
        )
        .digest("hex");
}

/**
 * Persist a slot for the session, replacing any prior row. Returns false on
 * failure; callers decide whether memory-only replay is sufficient. Pi requires
 * a successful commit before installing the request and mirroring its identities.
 *
 * Only the prefix slices whose hash differs from the stored slice's hash are
 * written. Comparing against the stored hashes, not a hash this process
 * remembers, keeps the first save after a restart and a save after another
 * connection's save just as small and just as correct. The slices, the removal
 * of slices past the new count, and the metadata row (with the count, length and
 * hash a load verifies) commit in one transaction.
 */
function persistLkgSlot(
    db: Database,
    sessionId: string,
    slot: LkgSlot,
    options: LkgSaveOptions | (() => void) = {},
): boolean {
    const { force, publishMetadata, deferCertificate } =
        typeof options === "function"
            ? { publishMetadata: options, force: false, deferCertificate: false }
            : options;
    // Pi saves served tag numbers and the request in one transaction. Even when
    // the request is unchanged, those numbers must commit, so the fingerprint
    // used to skip repeated request-only saves cannot skip this transaction.
    // Avoid computing that unused hash for host-built arrays. Custom serializers
    // can reject preparation before publication; preserve their existing preflight.
    const plainPublication =
        publishMetadata &&
        [
            slot.inputIdSeq,
            slot.inputContentDigests,
            slot.inputContentSignatures,
            slot.piOutputEntryIds,
            slot.inputMoveDigests,
        ].every(
            (values) =>
                values === undefined ||
                (Object.getPrototypeOf(values) === Array.prototype && !("toJSON" in values)),
        );
    const fingerprint = plainPublication ? undefined : slotFingerprint(slot);
    if (
        !force &&
        !publishMetadata &&
        fingerprint !== undefined &&
        persistedFingerprints.get(db)?.get(sessionId) === fingerprint
    ) {
        const durable = loadPersistedLkgSlot(db, sessionId);
        if (durable && slotFingerprint(durable) === fingerprint) return true;
    }
    const layout = layoutLkgPrefix(slot.jsonPrefix);
    try {
        // Ownership arrays grow with the session. Serialize them before BEGIN so
        // preparing a large saved request does not exclude another host's writer.
        const identity = certifiedIdentity(slot, layout.hash);
        const { inputIdSeq, inputContentDigests, inputContentSignatures } = identity;
        const certificateDigest =
            slot.servedCaptureId !== undefined ? lkgCertificateDigest(identity) : undefined;
        // Set when the marker still names this id unbound after a deferred-certificate
        // save; the later dispatch binds it from this value.
        let unboundValue: string | null | undefined;
        db.transaction(() => {
            // Historical migration fixtures also save pre-marker slots. When the
            // columns exist, an uncertified overwrite must clear their old ids.
            const withServedMetadata =
                slot.servedCaptureId !== undefined ||
                (db.prepare("PRAGMA table_info(lkg_slots)").all() as Array<{ name: string }>).some(
                    (column) => column.name === "served_capture_id",
                );
            if (slot.servedCaptureId !== undefined) {
                const marker = readServedMarkerRow(db, sessionId);
                if (
                    marker?.servedCaptureId !== slot.servedCaptureId ||
                    marker.slotState !== "captured"
                )
                    throw new Error("LKG capture was superseded or invalidated");
                // After session cleanup deletes the marker row the counter restarts,
                // so another writer can allocate an id equal to this slot's. Only the
                // connection that made the pending allocation may bind it; a stale
                // save from the older serve must not displace the newer one.
                if (!ownsServedMarkerAllocation(db, sessionId, marker))
                    throw new Error("LKG capture id was allocated by another writer");
                // Once a save has bound an id to bytes, no other bytes may claim that
                // id.
                if (marker.servedDigest !== null && marker.servedDigest !== certificateDigest)
                    throw new Error("LKG capture id is bound to different bytes");
                if (deferCertificate && marker.servedDigest === null)
                    unboundValue = pendingServedDigest(marker);
            }
            const storedHashes = new Map<unknown, unknown>();
            for (const row of db
                .prepare("SELECT chunk, hash FROM lkg_slot_chunks WHERE session_id = ?")
                .all(sessionId) as Array<{ chunk: unknown; hash: unknown }>) {
                storedHashes.set(row.chunk, row.hash);
            }
            const upsertChunk = db.prepare(
                `INSERT INTO lkg_slot_chunks (session_id, chunk, hash, body) VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id, chunk) DO UPDATE SET hash = excluded.hash, body = excluded.body`,
            );
            for (let index = 0; index < layout.chunks.length; index += 1) {
                if (storedHashes.get(index) === layout.chunkHashes[index]) continue;
                upsertChunk.run(sessionId, index, layout.chunkHashes[index], layout.chunks[index]);
            }
            db.prepare("DELETE FROM lkg_slot_chunks WHERE session_id = ? AND chunk >= ?").run(
                sessionId,
                layout.chunks.length,
            );
            db.prepare(
                `INSERT INTO lkg_slots (
                    session_id, json_prefix_chars, json_prefix_chunks, json_prefix_hash,
                    input_id_seq, input_content_digests, input_content_signatures,
                    last_input_message_id, model_key, provider_key,
                    captured_at, row_version, capture_sequence${withServedMetadata ? ", served_capture_id, input_move_digests" : ""}
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${withServedMetadata ? ", ?, ?" : ""})
                ON CONFLICT(session_id) DO UPDATE SET
                    json_prefix_chars = excluded.json_prefix_chars,
                    json_prefix_chunks = excluded.json_prefix_chunks,
                    json_prefix_hash = excluded.json_prefix_hash,
                    input_id_seq = excluded.input_id_seq,
                    input_content_digests = excluded.input_content_digests,
                    input_content_signatures = excluded.input_content_signatures,
                    last_input_message_id = excluded.last_input_message_id,
                    model_key = excluded.model_key,
                    provider_key = excluded.provider_key,
                    captured_at = excluded.captured_at,
                    row_version = excluded.row_version,
                    capture_sequence = excluded.capture_sequence${withServedMetadata ? ", served_capture_id = excluded.served_capture_id, input_move_digests = excluded.input_move_digests" : ""}`,
            ).run(
                sessionId,
                layout.chars,
                layout.chunks.length,
                layout.hash,
                inputIdSeq,
                inputContentDigests,
                inputContentSignatures,
                slot.lastInputMessageId,
                slot.modelKey,
                slot.providerKey,
                slot.capturedAt,
                slot.rowVersion ?? null,
                slot.captureSequence ?? null,
                ...(withServedMetadata
                    ? [slot.servedCaptureId ?? null, identity.inputMoveDigests]
                    : []),
            );
            // Bind the marker to these exact bytes in the same transaction that
            // writes them, so no reader ever sees the id without its bytes. A
            // deferred-certificate save leaves the id unbound until dispatch.
            if (slot.servedCaptureId !== undefined && !deferCertificate)
                db.prepare(
                    "UPDATE lkg_served_markers SET served_digest = ? WHERE session_id = ? AND served_capture_id = ?",
                ).run(certificateDigest ?? null, sessionId, slot.servedCaptureId);
            // Safety metadata must share the request's commit, not a later callback.
            publishMetadata?.();
        }).immediate();
        if (fingerprint !== undefined) rememberFingerprint(db, sessionId, fingerprint);
        if (slot.servedCaptureId !== undefined && certificateDigest !== undefined) {
            const certificate = {
                servedCaptureId: slot.servedCaptureId,
                digest: certificateDigest,
                jsonPrefix: slot.jsonPrefix,
            };
            if (unboundValue !== undefined)
                rememberPreparedCertificate(db, sessionId, {
                    ...certificate,
                    prefixHash: layout.hash,
                    unboundValue,
                });
            // A deferred save onto an id already bound to these same bytes needs no
            // later bind: the certificate already names them.
            else rememberBoundCertificate(db, sessionId, certificate);
        }
        return true;
    } catch (error) {
        // Paired Pi publication reports its optional failure once per session/reason.
        if (!publishMetadata)
            sessionLog(
                sessionId,
                "LKG snapshot persistence failed (in-memory slot retained):",
                error,
            );
        return false;
    }
}

export interface LkgSaveOptions {
    force?: boolean;
    publishMetadata?: () => void;
    /**
     * Save the bytes durably under their id but leave the marker unbound. The
     * caller binds them with `certifyDispatchedLkgSlot` only after the request
     * was dispatched; until then the slot certifies nothing and a restarted
     * process does not hydrate it as the last request sent.
     */
    deferCertificate?: boolean;
}

export function saveLkgSlotToDb(
    db: Database,
    sessionId: string,
    slot: LkgSlot,
    options: LkgSaveOptions | (() => void) = {},
    fence: {
        rebuild?: boolean;
        retainDirtyRevision?: string;
        ownDirtyRevision?: string;
        requiredRevision?: string;
        cleanDigest?: string;
    } = {},
): boolean {
    return commitLkgWithRecoveryFence({
        sessionId,
        slot,
        ...fence,
        load: () => loadPersistedLkgSlot(db, sessionId, true),
        commit: () => persistLkgSlot(db, sessionId, slot, options),
    });
}

export function clearPersistedLkgSlot(db: Database, sessionId: string, reason?: string): void {
    try {
        clearPersistedLkgSlotStrict(db, sessionId, reason);
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot durable clear failed:", error);
    }
}

/** A cut must not commit when durable old-representation invalidation failed. */
export function clearPersistedLkgSlotStrict(
    db: Database,
    sessionId: string,
    reason?: string,
): void {
    clearLkgRecoveryFence(sessionId, () =>
        db
            .transaction(() => {
                if (reason) recordServedSlotState(db, sessionId, reason);
                db.prepare("DELETE FROM lkg_slot_chunks WHERE session_id = ?").run(sessionId);
                db.prepare("DELETE FROM lkg_slots WHERE session_id = ?").run(sessionId);
            })
            .immediate(),
    );
    persistedFingerprints.get(db)?.delete(sessionId);
    boundCertificates.get(db)?.delete(sessionId);
    preparedCertificates.get(db)?.delete(sessionId);
}

export function loadPersistedLkgSlot(
    db: Database,
    sessionId: string,
    forPublication = false,
): LkgSlot | undefined {
    // Publication verifies the row just committed, even while a history cut is
    // fenced. Ordinary readers still cannot hydrate that row for replay.
    const rustHost = getHarness() === "opencode" || getHarness() === "opencode2";
    if (rustHost && !forPublication && isRustMarkerAdmissionFenced(db, sessionId)) return undefined;
    type ChunkRow = { chunk?: unknown; hash?: unknown; body?: unknown };
    let row: Record<string, unknown> | undefined;
    let chunkRows: ChunkRow[];
    try {
        // One read transaction, so the row and its slices come from the same
        // snapshot even while another connection is saving this slot.
        ({ row, chunkRows } = db
            .transaction(() => {
                const slotRow = db
                    .prepare("SELECT * FROM lkg_slots WHERE session_id = ?")
                    .get(sessionId) as Record<string, unknown> | undefined;
                if (!slotRow) return { row: undefined, chunkRows: [] as ChunkRow[] };
                const slices = db
                    .prepare(
                        "SELECT chunk, hash, body FROM lkg_slot_chunks WHERE session_id = ? ORDER BY chunk",
                    )
                    .all(sessionId) as ChunkRow[];
                return { row: slotRow, chunkRows: slices };
            })
            .deferred());
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot durable load failed:", error);
        return undefined;
    }
    if (!row) return undefined;
    const prefix = assembleLkgPrefix(
        {
            chars: row.json_prefix_chars,
            chunks: row.json_prefix_chunks,
            hash: row.json_prefix_hash,
        },
        chunkRows,
    );
    const slot = prefix
        ? parsePersistedLkgSlot({ ...row, json_prefix: prefix.jsonPrefix })
        : undefined;
    if (!prefix || !slot) {
        // A malformed row, or slices that do not add up to the recorded count,
        // length and hash, can never become replayable; remove the slot so later
        // captures start clean instead of tripping the same failure.
        if (!prefix) sessionLog(sessionId, "LKG snapshot slices failed verification; slot cleared");
        clearPersistedLkgSlot(db, sessionId);
        return undefined;
    }
    // Size admission is enforced by the slot store's own bound when the loaded
    // slot is installed; an oversized row simply declines to hydrate.
    return slot;
}

function pruneStaleLkgSlotsBatch(db: Database, now: number): { slots: number; chunks: number } {
    const previousTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const stale = `captured_at < ? AND NOT EXISTS (
        SELECT 1 FROM session_projects sp
        WHERE sp.session_id = lkg_slots.session_id AND sp.updated_at >= ?
    )`;
    // Discovery is read-only. Removing the slot first makes its prefix unavailable
    // for replay; remaining orphan slices are reclaimed on later maintenance ticks.
    const slot = db
        .prepare(`SELECT session_id FROM lkg_slots WHERE ${stale} LIMIT 1`)
        .get(cutoff, cutoff) as { session_id: string } | undefined;
    const chunks = db
        .prepare(`SELECT rowid FROM lkg_slot_chunks c WHERE
        session_id = ? OR NOT EXISTS (SELECT 1 FROM lkg_slots s WHERE s.session_id = c.session_id)
        LIMIT 25`)
        .all(slot?.session_id ?? "") as Array<{ rowid: number }>;
    if (!slot && chunks.length === 0) return { slots: 0, chunks: 0 };
    try {
        db.exec("PRAGMA busy_timeout = 0");
        let transactionStartedAt = 0;
        const remove = () =>
            db
                .transaction(() => {
                    transactionStartedAt = performance.now();
                    const removed = slot
                        ? db
                              .prepare(`DELETE FROM lkg_slots WHERE session_id = ? AND ${stale}`)
                              .run(slot.session_id, cutoff, cutoff).changes
                        : 0;
                    const removeChunk =
                        db.prepare(`DELETE FROM lkg_slot_chunks WHERE rowid = ? AND NOT EXISTS (
                SELECT 1 FROM lkg_slots s WHERE s.session_id = lkg_slot_chunks.session_id
            )`);
                    let removedChunks = 0;
                    for (const { rowid } of chunks) removedChunks += removeChunk.run(rowid).changes;
                    return { slots: removed, chunks: removedChunks };
                })
                .immediate();
        const changes = slot
            ? (clearLkgRecoveryFence(slot.session_id, remove, (result) => !!result?.slots) ?? {
                  slots: 0,
                  chunks: 0,
              })
            : remove();
        logSlowWriteTransaction("lkg_stale_gc", transactionStartedAt);
        if (changes.slots && slot) {
            persistedFingerprints.get(db)?.delete(slot.session_id);
            boundCertificates.get(db)?.delete(slot.session_id);
            preparedCertificates.get(db)?.delete(slot.session_id);
        }
        return changes;
    } finally {
        db.exec(`PRAGMA busy_timeout = ${Number(previousTimeout.timeout) || 0}`);
    }
}

export function pruneStaleLkgSlots(db: Database, now = Date.now()): number {
    return pruneStaleLkgSlotsBatch(db, now).slots;
}

export async function drainStaleLkgSlots(
    db: Database,
    now = Date.now(),
    budgetMs = 2000,
): Promise<number> {
    let removed = 0;
    await drainBackgroundBatches(
        () => {
            const batch = pruneStaleLkgSlotsBatch(db, now);
            removed += batch.slots;
            return batch.slots + batch.chunks > 0;
        },
        { budgetMs },
    );
    return removed;
}

/**
 * How a stored slot saved with its certificate deferred relates to dispatch, from
 * its marker: `refused` when its pass was refused after the save (the bytes were
 * never sent), `unconfirmed` when the marker still names it as a pending allocation
 * (the process may have died before or after sending it), else `settled`. An
 * ordinary save binds its id in the same transaction as the bytes, so only a
 * deferred-certificate save leaves the first two states.
 */
function dispatchState(
    db: Database,
    sessionId: string,
    slot: LkgSlot,
): "refused" | "unconfirmed" | "settled" {
    if (slot.servedCaptureId === undefined) return "settled";
    const marker = readServedMarkerRow(db, sessionId);
    if (marker?.servedCaptureId !== slot.servedCaptureId) return "settled";
    if (marker.slotState === UNDISPATCHED_SLOT_STATE) return "refused";
    return marker.pendingToken !== null && marker.slotState === "captured"
        ? "unconfirmed"
        : "settled";
}

/** Backend bound to one database handle, for registration with the slot store. */
export function createDbLkgPersistence(db: Database): LkgPersistenceBackend {
    return {
        load: (sessionId) => {
            const slot = loadPersistedLkgSlot(db, sessionId);
            if (!slot) return undefined;
            try {
                const state = dispatchState(db, sessionId, slot);
                // Replay serves the last request sent. A request whose pass was
                // refused after saving it stays durable, but was never sent.
                if (state === "refused") {
                    sessionLog(
                        sessionId,
                        "LKG durable slot was refused before dispatch; not hydrated",
                    );
                    return undefined;
                }
                // A request saved just before the process died has an unknown
                // outcome, but it was valid for its input: it loads uncertified and
                // may replay only for that exact input.
                if (state === "unconfirmed") return { ...slot, dispatchUnconfirmed: true };
            } catch (error) {
                // Without a readable marker there is no certificate to consult; keep
                // hydrating as before certificates were bound to dispatch.
                sessionLog(sessionId, "LKG durable dispatch check failed:", error);
            }
            return slot;
        },
        clear: (sessionId, reason) => clearPersistedLkgSlot(db, sessionId, reason),
    };
}
