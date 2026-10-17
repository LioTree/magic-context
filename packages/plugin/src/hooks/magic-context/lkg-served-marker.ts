import { assembleLkgPrefix, layoutLkgPrefix } from "../../features/magic-context/lkg-prefix-chunks";
import { isRustMarkerAdmissionFenced } from "../../features/magic-context/storage-replay-document";
import { sessionLog } from "../../shared/logger";
import { type Database, withSqliteBackgroundWriter } from "../../shared/sqlite";
import {
    boundLkgCertificate,
    lkgCertificateDigest,
    lkgSlotCertificateDigest,
    saveLkgSlotToDb,
} from "./lkg-persist";
import { captureSlot, getInMemorySlot, type LkgSlot } from "./lkg-slot";

export interface ServedMarker {
    servedCaptureId: number;
    fullCoverage: boolean;
    slotState: string;
    /**
     * Certificate digest of the bytes saved under `servedCaptureId`, written in the
     * same transaction as those bytes. Null while the serve that allocated the id
     * has not saved yet, and on rows written before this column existed: an
     * unbound marker never certifies a slot.
     */
    servedDigest: string | null;
}

export function readServedMarker(db: Database, sessionId: string): ServedMarker | undefined {
    const row = db
        .prepare(`SELECT served_capture_id, full_coverage, slot_state, served_digest
        FROM lkg_served_markers WHERE session_id = ?`)
        .get(sessionId) as
        | {
              served_capture_id: number;
              full_coverage: number;
              slot_state: string;
              served_digest: string | null;
          }
        | undefined;
    return row
        ? {
              servedCaptureId: row.served_capture_id,
              fullCoverage: row.full_coverage === 1,
              slotState: row.slot_state,
              servedDigest: typeof row.served_digest === "string" ? row.served_digest : null,
          }
        : undefined;
}

/**
 * Allocate in context.db, not from row_version or a process-local cancel counter.
 * Certification is optional: a short writer acquisition or any marker failure
 * returns no id, so the eventual slot row is durably uncertified without changing
 * whether its request can be served.
 *
 * Call this only for a request the pass is returning to the host. The latest
 * request actually served wins the certificate, even when another connection
 * certified a different request in between; a pass that never returns its bytes
 * must not allocate, because allocation moves the session's certificate.
 *
 * `prior` is the capture this process served before `candidate`. It defaults to
 * the in-memory slot, which a caller that already installed `candidate` must
 * pass explicitly.
 */
export function recordServedCapture(
    db: Database,
    sessionId: string,
    fullCoverage: boolean,
    candidate?: LkgSlot,
    prior: LkgSlot | undefined = candidate ? getInMemorySlot(sessionId) : undefined,
): number | undefined {
    try {
        // A certificate identifies replay bytes and their input frontier, not the
        // time of a repeated serve. Reuse requires both an identical in-memory
        // frontier and its still-current database marker, never a content memo alone.
        const equal = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined) =>
            a !== undefined &&
            b !== undefined &&
            a.length === b.length &&
            a.every((value, index) => value === b[index]);
        if (
            prior?.servedCaptureId !== undefined &&
            candidate &&
            prior.fullCoverage === fullCoverage &&
            prior.jsonPrefix === candidate.jsonPrefix &&
            prior.modelKey === candidate.modelKey &&
            prior.providerKey === candidate.providerKey &&
            prior.rowVersion === candidate.rowVersion &&
            prior.lastInputMessageId === candidate.lastInputMessageId &&
            equal(prior.inputIdSeq, candidate.inputIdSeq) &&
            equal(prior.inputContentDigests, candidate.inputContentDigests) &&
            equal(prior.inputMoveDigests, candidate.inputMoveDigests) &&
            (prior.piOutputEntryIds === candidate.piOutputEntryIds ||
                equal(prior.piOutputEntryIds, candidate.piOutputEntryIds))
        ) {
            const marker = readServedMarker(db, sessionId);
            if (
                marker?.servedCaptureId === prior.servedCaptureId &&
                marker.fullCoverage === fullCoverage &&
                marker.slotState === "captured"
            ) {
                // An unbound marker still names this process's own allocation whose
                // save has not landed; that save binds these same bytes. A bound
                // marker is reusable only for the bytes this connection bound to it.
                if (marker.servedDigest === null) return marker.servedCaptureId;
                const bound = boundLkgCertificate(db, sessionId);
                if (
                    bound?.servedCaptureId === marker.servedCaptureId &&
                    bound.digest === marker.servedDigest &&
                    bound.jsonPrefix === candidate.jsonPrefix
                )
                    return marker.servedCaptureId;
            }
        }
        return withSqliteBackgroundWriter(() =>
            db
                .transaction(() => {
                    const previous = readServedMarker(db, sessionId)?.servedCaptureId ?? 0;
                    const id = previous + 1;
                    if (!Number.isSafeInteger(id))
                        throw new Error("served capture counter exhausted");
                    db.prepare(`INSERT INTO lkg_served_markers
                (session_id, served_capture_id, full_coverage, slot_state, served_digest) VALUES (?, ?, ?, 'captured', NULL)
                ON CONFLICT(session_id) DO UPDATE SET served_capture_id=excluded.served_capture_id,
                full_coverage=excluded.full_coverage, slot_state=excluded.slot_state,
                served_digest=excluded.served_digest`).run(sessionId, id, fullCoverage ? 1 : 0);
                    return id;
                })
                .immediate(),
        );
    } catch (error) {
        sessionLog(sessionId, "LKG capture served without move certification:", error);
        return undefined;
    }
}

/** Best-effort marker update inside the transaction that hides or deletes the slot. */
export function recordServedSlotState(db: Database, sessionId: string, reason: string): void {
    try {
        db.prepare(`INSERT INTO lkg_served_markers
            (session_id, served_capture_id, full_coverage, slot_state) VALUES (?, 1, 0, ?)
            ON CONFLICT(session_id) DO UPDATE SET slot_state=excluded.slot_state`).run(
            sessionId,
            reason,
        );
    } catch (error) {
        // The actual replay invalidation still follows its existing strict/best-
        // effort rules; failure of an optional move marker must not change them.
        sessionLog(sessionId, "LKG slot state lost move certification:", error);
    }
}

/**
 * How a pass that failed after its capture may treat storage when it puts back
 * its previous request. `certify`: the marker still holds one of this pass's ids, so the
 * restore may rewrite the slot and allocate a fresh certificate for it, as it did
 * before certificates were bound to bytes. `uncertified` means another
 * connection has allocated since, but storage still holds this failed pass's own
 * bytes; those must be replaced, without claiming the other writer's id.
 * `leave` means another connection owns both the certificate and the stored
 * bytes, and a pass that served nothing must not touch either.
 */
export function failedPassRestoreMode(
    db: Database,
    sessionId: string,
    ownIds: readonly (number | undefined)[],
    failedJsonPrefix: string | undefined,
): "certify" | "uncertified" | "leave" {
    const marker = readServedMarker(db, sessionId);
    if (!marker || ownIds.includes(marker.servedCaptureId)) return "certify";
    const stored = db
        .prepare("SELECT served_capture_id, json_prefix_hash FROM lkg_slots WHERE session_id = ?")
        .get(sessionId) as
        | { served_capture_id: number | null; json_prefix_hash: string | null }
        | undefined;
    if (!stored) return "leave";
    const ownBytes =
        (stored.served_capture_id !== null && ownIds.includes(stored.served_capture_id)) ||
        (failedJsonPrefix !== undefined &&
            stored.json_prefix_hash === layoutLkgPrefix(failedJsonPrefix).hash);
    return ownBytes ? "uncertified" : "leave";
}

export type LkgDurability =
    | { durable: true; servedCaptureId: number | null; certified?: true }
    | { durable: true; servedCaptureId: null; certified: false }
    | { durable: false; reason: "no_frontier"; slotState: string };

interface StoredCertifiedSlot {
    served_capture_id: number | null;
    json_prefix_chars: unknown;
    json_prefix_chunks: unknown;
    json_prefix_hash: unknown;
    input_id_seq: unknown;
    input_content_digests: unknown;
    input_content_signatures: unknown;
    input_move_digests: unknown;
    last_input_message_id: unknown;
    model_key: unknown;
    provider_key: unknown;
    row_version: unknown;
}

/**
 * Whether the stored slot is the exact capture the marker's digest names: the
 * digest recomputed from the row's stored identity matches, and every stored
 * prefix slice verifies against that row's recorded hash.
 */
function storedBytesMatch(
    db: Database,
    sessionId: string,
    slot: StoredCertifiedSlot,
    digest: string | null,
): boolean {
    if (digest === null) return false;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    const prefixHash = text(slot.json_prefix_hash);
    const inputIdSeq = text(slot.input_id_seq);
    const inputContentDigests = text(slot.input_content_digests);
    const lastInputMessageId = text(slot.last_input_message_id);
    if (
        prefixHash === null ||
        inputIdSeq === null ||
        inputContentDigests === null ||
        lastInputMessageId === null
    )
        return false;
    const recomputed = lkgCertificateDigest({
        prefixHash,
        inputIdSeq,
        inputContentDigests,
        inputContentSignatures: text(slot.input_content_signatures),
        inputMoveDigests: text(slot.input_move_digests),
        lastInputMessageId,
        modelKey: text(slot.model_key),
        providerKey: text(slot.provider_key),
        rowVersion: typeof slot.row_version === "number" ? slot.row_version : null,
    });
    if (recomputed !== digest) return false;
    const chunks = db
        .prepare(
            "SELECT chunk, hash, body FROM lkg_slot_chunks WHERE session_id = ? ORDER BY chunk",
        )
        .all(sessionId) as Array<{ chunk?: unknown; hash?: unknown; body?: unknown }>;
    return (
        assembleLkgPrefix(
            {
                chars: slot.json_prefix_chars,
                chunks: slot.json_prefix_chunks,
                hash: slot.json_prefix_hash,
            },
            chunks,
        ) !== undefined
    );
}

/** The draining caller checks this before freezing or reading the frontier. */
export function checkLkgDurability(
    db: Database,
    sessionId: string,
    options: { compactionOff?: boolean } = {},
): LkgDurability {
    if (options.compactionOff) return { durable: true, servedCaptureId: null, certified: false };
    return db
        .transaction(() => {
            const marker = readServedMarker(db, sessionId);
            const slot = db
                .prepare(`SELECT served_capture_id, json_prefix_chars, json_prefix_chunks,
                    json_prefix_hash, input_id_seq, input_content_digests,
                    input_content_signatures, input_move_digests, last_input_message_id,
                    model_key, provider_key, row_version
                    FROM lkg_slots WHERE session_id=?`)
                .get(sessionId) as StoredCertifiedSlot | undefined;
            if (!marker && !slot) return { durable: true, servedCaptureId: null } as const;
            // Matching ids are not proof: the marker must also name these exact
            // stored bytes and identity through the digest bound with them.
            const matched =
                marker &&
                slot?.served_capture_id === marker.servedCaptureId &&
                storedBytesMatch(db, sessionId, slot, marker.servedDigest);
            // A previous marker cannot describe a newer uncertified slot, including
            // its coverage or drop reason. Null ids never borrow the old certificate.
            if (slot && !matched)
                return { durable: true, servedCaptureId: null, certified: false } as const;
            if (marker?.slotState !== undefined && marker.slotState !== "captured")
                return {
                    durable: false,
                    reason: "no_frontier",
                    slotState: marker.slotState,
                } as const;
            if (matched && !marker.fullCoverage)
                return {
                    durable: false,
                    reason: "no_frontier",
                    slotState: "partial_capture",
                } as const;
            if (matched) return { durable: true, servedCaptureId: marker.servedCaptureId } as const;
            return { durable: true, servedCaptureId: null, certified: false } as const;
        })
        .deferred();
}

/**
 * The certificate digest of the in-memory slot. Uses the digest this connection
 * recorded when it last saved those same bytes under that id, and otherwise
 * hashes the slot.
 */
function liveCertificateDigest(db: Database, sessionId: string, slot: LkgSlot): string {
    const bound = boundLkgCertificate(db, sessionId);
    if (
        bound !== undefined &&
        bound.servedCaptureId === slot.servedCaptureId &&
        bound.jsonPrefix === slot.jsonPrefix
    )
        return bound.digest;
    return lkgSlotCertificateDigest(slot);
}

/**
 * After passes and queued captures settle, certify only the owner's final in-memory
 * capture. Never hydrate an older disk slot to manufacture a live certificate.
 * A missing marker may be allocated here; failures simply leave the move uncertified.
 * A poll serves nothing, so it never rewrites a certified pair whose bytes differ
 * from the in-memory capture: they may belong to another writer's later serve.
 */
export function repairLkgDurability(db: Database, sessionId: string): LkgDurability {
    const uncertified = { durable: true, servedCaptureId: null, certified: false } as const;
    const status = checkLkgDurability(db, sessionId);
    const slot = getInMemorySlot(sessionId);
    if (!slot || isRustMarkerAdmissionFenced(db, sessionId)) return status;
    // The pass that captured this slot never returned it to the host, so these
    // bytes were never served and must not be certified.
    if (slot.servedCaptureWithheld) return uncertified;
    if (!status.durable && slot.servedCaptureId !== undefined) return status;
    const marker = readServedMarker(db, sessionId);
    if (status.durable && status.certified !== false && status.servedCaptureId !== null) {
        return marker?.servedDigest === liveCertificateDigest(db, sessionId, slot)
            ? status
            : uncertified;
    }
    if (
        slot.servedCaptureId !== undefined &&
        (marker?.servedCaptureId !== slot.servedCaptureId ||
            marker.slotState !== "captured" ||
            (marker.servedDigest !== null &&
                marker.servedDigest !== liveCertificateDigest(db, sessionId, slot)))
    )
        return uncertified;
    const fullCoverage =
        slot.fullCoverage ??
        (slot.servedCaptureId !== undefined && slot.servedCaptureId === marker?.servedCaptureId
            ? marker.fullCoverage
            : undefined);
    if (fullCoverage === undefined) return uncertified;
    const id = slot.servedCaptureId ?? recordServedCapture(db, sessionId, fullCoverage);
    if (id === undefined) return uncertified;
    const certifiedSlot = { ...slot, servedCaptureId: id, fullCoverage };
    if (!captureSlot(sessionId, certifiedSlot)) return uncertified;
    saveLkgSlotToDb(db, sessionId, certifiedSlot, { force: true });
    return checkLkgDurability(db, sessionId);
}

/**
 * Move-fence ownership stays with the caller: return only its open sessions in
 * draining, never frozen/import-gated sessions, and only after passes and queued
 * capture callbacks settle. Stop on host disposal. Polling can certify an unmarked
 * final capture, but never advances capture_sequence or changes served bytes.
 */
export function startLkgDurabilityPoll(
    db: Database,
    drainingSessionIds: () => readonly string[],
    onError: (error: unknown) => void,
): () => void {
    const timer = setInterval(() => {
        try {
            for (const sessionId of drainingSessionIds()) repairLkgDurability(db, sessionId);
        } catch (error) {
            onError(error);
        }
    }, 1000);
    timer.unref();
    return () => clearInterval(timer);
}
