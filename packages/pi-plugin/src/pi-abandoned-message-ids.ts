/**
 * Which indexed message ids a Pi/OMP rewind abandoned.
 *
 * Pi never deletes the entries a rewind or `/clone` abandoned: the session JSONL
 * keeps every entry of every branch, and `getBranch()` returns only the path from
 * the current leaf to the root. Magic Context keeps its raw-message search index
 * in `context.db` keyed by `(session_id, message_id)`, so an abandoned entry's
 * index rows survive the rewind. Nothing in the ordinal cutoff can exclude them
 * either — ordinals are positional, and a new branch reuses the ordinals the
 * abandoned one vacated — so a later compartment publish moves the cutoff past
 * them and `ctx_search` starts returning the rewound conversation again.
 *
 * # Why the abandoned set, not the live set
 *
 * The ids on the current branch are the wrong scope for this lane. A compartment
 * exists because its messages scrolled out of the live context, so a legitimate
 * search hit is usually off-branch by construction: the row survives in the index
 * precisely so it stays searchable after compaction. A plain allow-list therefore
 * erased the archive (the ctx-expand archive-prefix test caught it). What the leak
 * needs is the narrower set — ids the session still holds as entries but no longer
 * reaches from the leaf — because those are the only rows whose *presence in the
 * file* proves they were rewound away rather than compacted. Rows whose ids the
 * file no longer holds stay searchable, exactly as before.
 *
 * This mirrors the id scheme `read-session-pi.ts` uses while indexing, so the set
 * matches stored rows:
 *   - a `message` entry is indexed under its own `entry.id`;
 *   - a run of `toolResult` entries is folded into one synthetic user turn whose
 *     id is `synth-user-<first toolResult entry id>`.
 */

import { SYNTH_USER_ID_PREFIX } from "./read-session-pi";

export interface PiBranchEntryIds {
	/** Ids reachable from the current leaf. */
	readonly onBranch: ReadonlySet<string>;
	/** Ids present in the session file but not reachable from the leaf. */
	readonly abandoned: ReadonlySet<string>;
}

interface PiAbandonedMessageIdSource extends PiBranchEntryIds {
	readonly leafId: string;
}

const cachedBySession = new Map<string, PiAbandonedMessageIdSource>();

/** Drop a session's memoized branch ids. Call when the session goes away. */
export function clearPiAbandonedMessageIds(sessionId: string): void {
	cachedBySession.delete(sessionId);
}

/**
 * Ids one entry can be indexed under: its own id, plus the synthetic folded
 * tool-result user id.
 */
function indexedIdsForEntry(entry: unknown): string[] {
	if (!entry || typeof entry !== "object") return [];
	const id = (entry as { id?: unknown }).id;
	if (typeof id !== "string" || id.length === 0) return [];
	const role = (entry as { message?: { role?: unknown } }).message?.role;
	return role === "toolResult" ? [id, `${SYNTH_USER_ID_PREFIX}${id}`] : [id];
}

/**
 * Split the session's entries into reachable and abandoned index ids.
 *
 * `branchEntries` is what `getBranch()` returns; `allEntries` is `getEntries()`,
 * the whole file. A null `allEntries` means the caller cannot enumerate the file,
 * so the abandoned set stays empty and the lane behaves exactly as before instead
 * of guessing.
 */
export function classifyPiBranchEntryIds(
	branchEntries: readonly unknown[],
	allEntries: readonly unknown[] | null,
): PiBranchEntryIds {
	const onBranch = new Set<string>();
	for (const entry of branchEntries) {
		for (const id of indexedIdsForEntry(entry)) onBranch.add(id);
	}
	if (allEntries === null) return { onBranch, abandoned: new Set() };
	const abandoned = new Set<string>();
	for (const entry of allEntries) {
		for (const id of indexedIdsForEntry(entry)) {
			if (!onBranch.has(id)) abandoned.add(id);
		}
	}
	return { onBranch, abandoned };
}

/**
 * The abandoned index ids for `sessionId`, memoized on the leaf.
 *
 * `getEntries()` copies every entry of the session, so the result is cached on
 * `(sessionId, leafId)` and recomputed only when the branch moves — one walk per
 * message, not per transform pass. `preloadedBranchEntries` lets a caller that
 * already read the branch skip the second `getBranch()`.
 *
 * Resolving null means "unknown": the caller must then search unfiltered rather
 * than treat the archive as abandoned, since a wrong set would silently erase real
 * hits.
 */
export function resolvePiAbandonedMessageIds(
	ctx: unknown,
	sessionId: string,
	preloadedBranchEntries?: readonly unknown[] | null,
): PiBranchEntryIds | null {
	const sessionManager = (
		ctx as {
			sessionManager?: {
				getBranch?: (fromId?: string) => unknown[];
				getEntries?: () => unknown[];
				getLeafId?: () => unknown;
			};
		}
	)?.sessionManager;
	if (typeof sessionManager?.getEntries !== "function") return null;
	let leaf: unknown;
	try {
		leaf = sessionManager.getLeafId?.();
	} catch {
		return null;
	}
	const leafKey = typeof leaf === "string" && leaf.length > 0 ? leaf : null;
	if (leafKey !== null) {
		const cached = cachedBySession.get(sessionId);
		if (cached && cached.leafId === leafKey) return cached;
	}
	let branchEntries = preloadedBranchEntries ?? null;
	if (branchEntries === null) {
		if (typeof sessionManager.getBranch !== "function") return null;
		let read: unknown;
		try {
			read = sessionManager.getBranch.call(sessionManager);
		} catch {
			return null;
		}
		if (!Array.isArray(read)) return null;
		branchEntries = read;
	}
	let allEntries: unknown;
	try {
		allEntries = sessionManager.getEntries.call(sessionManager);
	} catch {
		return null;
	}
	if (!Array.isArray(allEntries)) return null;
	const classified = classifyPiBranchEntryIds(branchEntries, allEntries);
	// Without a leaf id there is no memo key that can distinguish branches.
	if (leafKey === null) return classified;
	const source: PiAbandonedMessageIdSource = {
		leafId: leafKey,
		onBranch: classified.onBranch,
		abandoned: classified.abandoned,
	};
	cachedBySession.set(sessionId, source);
	return source;
}
