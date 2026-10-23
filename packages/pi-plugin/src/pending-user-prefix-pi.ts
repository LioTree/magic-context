import type { ServedPrefix } from "@magic-context/core/hooks/magic-context/served-prefix";

export interface PiPrefixBranch {
	entries: readonly unknown[];
	cursor: string | null;
}

interface NativeEntry {
	id: string;
	parentId: string | null;
	type?: string;
	message?: { role?: string };
}

function entriesOf(branch: PiPrefixBranch): NativeEntry[] | null {
	const entries: NativeEntry[] = [];
	const ids = new Set<string>();
	for (const value of branch.entries) {
		if (!value || typeof value !== "object") return null;
		const entry = value as NativeEntry;
		if (
			typeof entry.id !== "string" ||
			!(entry.parentId === null || typeof entry.parentId === "string") ||
			ids.has(entry.id)
		)
			return null;
		ids.add(entry.id);
		entries.push(entry);
	}
	return entries;
}

function pathTo(
	entries: readonly NativeEntry[],
	cursor: string | null,
): string[] | null {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: string[] = [];
	const seen = new Set<string>();
	while (cursor !== null) {
		const entry = byId.get(cursor);
		if (!entry || seen.has(cursor)) return null;
		seen.add(cursor);
		path.push(cursor);
		cursor = entry.parentId;
	}
	return path.reverse();
}

export function pendingUserBranchPath(branch: PiPrefixBranch): string[] | null {
	const entries = entriesOf(branch);
	return entries ? pathTo(entries, branch.cursor) : null;
}

/**
 * OMP persists a newly submitted user only after its first provider request.
 * Prove its eventual native identity from the saved branch, without modifying
 * the original record or accepting a same-position message on another branch.
 */
export function pendingUserAlias(
	record: ServedPrefix<unknown>,
	branch: PiPrefixBranch | undefined,
): { native: string; pending: string } | string {
	const certificate = record.pending_user;
	if (
		!certificate ||
		typeof certificate.id !== "string" ||
		typeof certificate.digest !== "string" ||
		!Array.isArray(certificate.branch_path) ||
		!(
			certificate.branch_cursor === null ||
			typeof certificate.branch_cursor === "string"
		)
	)
		return "pending-user certificate invalid";
	if (
		certificate.id !== record.turn &&
		certificate.id !== record.first_kept?.id
	)
		return "pending-user anchor moved";
	if (!branch) return "pending-user branch unavailable";
	const entries = entriesOf(branch);
	if (!entries) return "pending-user branch invalid";
	const activePath = pathTo(entries, branch.cursor);
	if (!activePath) return "pending-user active branch invalid";
	const positions = new Map(activePath.map((id, index) => [id, index]));
	const cursorIndex =
		certificate.branch_cursor === null
			? -1
			: positions.get(certificate.branch_cursor);
	const savedPath = pathTo(entries, certificate.branch_cursor);
	if (
		cursorIndex === undefined ||
		!savedPath ||
		JSON.stringify(savedPath) !== JSON.stringify(certificate.branch_path)
	)
		return "pending-user saved cursor is not on this branch";
	const candidates = entries.filter((entry) => {
		if (entry.type !== "message" || entry.message?.role !== "user")
			return false;
		return (positions.get(entry.id) ?? -1) > (cursorIndex ?? -1);
	});
	if (candidates.length !== 1)
		return "pending-user descendant missing or ambiguous";
	return { native: candidates[0].id, pending: certificate.id };
}
