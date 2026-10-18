import {
	DegradedPassRefusalError,
	degradedPassError,
} from "@magic-context/core/hooks/magic-context/degraded-pass-refusal";
import {
	type PrefixProvenance,
	prefixMessageDigest,
	prefixRecordProblem,
	prefixTurn,
	readServedPrefix,
	refuseServedPrefix,
	replayServedPrefix,
	type ServedPrefix,
	validateServedPrefix,
	writeServedPrefix,
} from "@magic-context/core/hooks/magic-context/served-prefix";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { PiM0M1InjectionResult } from "./inject-compartments-pi";
import {
	type PiPrefixBranch,
	pendingUserAlias,
	pendingUserBranchPath,
} from "./pending-user-prefix-pi";

const provenance: PrefixProvenance = {
	host: "pi",
	id_space: "pi-entry",
	generation: "pi",
	projection: "messages",
};

/** An unproven user identity cannot be repaired by replaying a request from another branch. */
export class PiPendingUserRefusalError extends DegradedPassRefusalError {
	constructor(reason: string, sessionId: string) {
		super("served-prefix-pending-user", { cause: new Error(reason) });
		this.message += ` ${reason}`;
		sessionLog(
			sessionId,
			`edit admission: held lane=served_prefix reason=${reason} held_edits=1`,
		);
	}
}

/** Refuse a context transformation with a missing first-kept message, without blocking later transformations from re-reading host history. */
export class PiPrefixPass {
	readonly turn: string | null;
	private readonly nativeTurn: string | null;
	readonly record: ServedPrefix<unknown> | null;
	replayed = false;
	compactionOffFallback?: (messages: unknown[], headCount: number) => void;
	private alias?: { native: string; pending: string };
	constructor(
		private readonly db: Database,
		private readonly sessionId: string,
		messages: readonly unknown[],
		stableId: (message: unknown, index: number) => string | undefined,
		public boundary: boolean,
		private readonly off: boolean,
		private readonly branch?: PiPrefixBranch,
	) {
		this.nativeTurn = prefixTurn(messages, stableId);
		let record: ServedPrefix<unknown> | null = null;
		try {
			record = readServedPrefix(db, sessionId);
		} catch (error) {
			if (!off) throw degradedPassError("served-prefix-read", error);
		}
		this.record = record;
		if (
			!off &&
			record?.pending_user &&
			!messages.some(
				(message, index) =>
					stableId(message, index) === record.pending_user?.id,
			)
		) {
			const alias = pendingUserAlias(record, branch);
			if (typeof alias === "string") {
				if (boundary) throw new PiPendingUserRefusalError(alias, sessionId);
			} else this.alias = alias;
		}
		this.turn = prefixTurn(messages, this.ids(stableId));
	}
	private ids(
		stableId: (message: unknown, index: number) => string | undefined,
	) {
		return (message: unknown, index: number): string | undefined => {
			const id = stableId(message, index);
			return this.alias && id === this.alias.native ? this.alias.pending : id;
		};
	}
	hasFirstKept(
		messages: readonly unknown[],
		stableId: (message: unknown, index: number) => string | undefined,
	): boolean {
		const ids = this.ids(stableId);
		return (
			!!this.record?.first_kept &&
			messages.some(
				(message, index) => ids(message, index) === this.record?.first_kept?.id,
			)
		);
	}
	unverified(reason: string): void {
		sessionLog(
			this.sessionId,
			`edit admission: served_prefix_unverified reason=${reason} held_edits=1`,
		);
	}
	replay(
		messages: unknown[],
		stableId: (message: unknown, index: number) => string | undefined,
	): PiM0M1InjectionResult | null {
		stableId = this.ids(stableId);
		const problem = prefixRecordProblem(
			this.record,
			provenance,
			this.turn,
			this.boundary,
		);
		if (problem || !this.record) {
			if (this.boundary && !this.off)
				refuseServedPrefix(problem ?? "record missing", this.sessionId);
			if (this.boundary) this.unverified(problem ?? "record missing");
			return null;
		}
		// Pi's native system envelope precedes the injected history/knowledge
		// messages and is stored with them. Remove only the leading system
		// objects, never later system rows.
		const leading = new Set<unknown>();
		for (const message of messages) {
			if ((message as { role?: string }).role !== "system") break;
			leading.add(message);
		}
		const raw = messages.filter((message) => !leading.has(message));
		if (
			this.off &&
			(this.record.summary !== null ||
				!this.record.first_kept ||
				stableId(raw[0], messages.indexOf(raw[0])) !==
					this.record.first_kept.id)
		) {
			this.unverified("off-mode record does not describe the full raw window");
			return null;
		}
		if (this.off && this.boundary) {
			const mismatch = validateServedPrefix(this.record, messages, stableId);
			if (mismatch) {
				this.unverified(mismatch);
				return null;
			}
		}
		const before = messages.length;
		const failure = replayServedPrefix({
			messages,
			record: this.record,
			stableId,
			isHead: (message) => leading.has(message),
		});
		if (failure) {
			if (this.boundary && !this.off)
				refuseServedPrefix(failure, this.sessionId);
			if (this.boundary) this.unverified(failure);
			return null;
		}
		this.replayed = true;
		return {
			injected: true,
			compartmentCount: 0,
			factCount: 0,
			memoryCount: 0,
			skippedVisibleMessages: Math.max(
				0,
				before + this.record.head.length - messages.length,
			),
			m0Materialized: false,
			m0Reason: "cache_hit",
			m0Bytes: 0,
			m1Bytes: 0,
			contentionExhausted: true,
			renderedBoundary: { endMessageId: null, ordinal: null },
			m1RenderedCoverage: null,
			syntheticLeadingCount: this.record.head.length,
		};
	}
	needsRepair(
		messages: unknown[],
		stableId: (message: unknown, index: number) => string | undefined,
	): boolean {
		if (this.boundary || this.off) return false;
		stableId = this.ids(stableId);
		return (
			prefixRecordProblem(this.record, provenance, this.turn, false) !== null ||
			(this.replayed &&
				!!this.record &&
				validateServedPrefix(this.record, messages, stableId) !== null)
		);
	}
	finish(
		messages: unknown[],
		headCount: number,
		stableId: (message: unknown, index: number) => string | undefined,
		cutId?: string | null,
		publish = true,
	): void {
		const nativeStableId = stableId;
		stableId = this.ids(stableId);
		if (this.replayed && this.record && this.alias) {
			const matches = messages.filter(
				(message, index) => stableId(message, index) === this.alias?.pending,
			);
			if (
				matches.length !== 1 ||
				prefixMessageDigest(matches[0]) !== this.record.pending_user?.digest
			)
				throw new PiPendingUserRefusalError(
					"pending-user whole-message digest mismatch",
					this.sessionId,
				);
		}
		if (this.boundary) {
			if (this.replayed && this.record) {
				const problem = validateServedPrefix(this.record, messages, stableId);
				if (problem && !this.off) refuseServedPrefix(problem, this.sessionId);
				if (problem) {
					this.unverified(problem);
					try {
						this.compactionOffFallback?.(messages, headCount);
					} catch (error) {
						this.unverified(`fallback failed: ${String(error)}`);
					}
				}
			}
			return;
		}
		if (!headCount || !publish) return;
		// A writable new record uses current native ids; only held replay uses
		// the read-only alias back to the previous record's transient anchor.
		stableId = nativeStableId;
		const turn = this.nativeTurn;
		const first = messages
			.slice(headCount)
			.find((message, index) => stableId(message, index + headCount));
		let pendingUser: ServedPrefix<unknown>["pending_user"];
		if (!this.off && this.branch && turn?.startsWith("pi-msg-")) {
			const pending = messages.filter(
				(message, index) => stableId(message, index) === turn,
			);
			const path = pendingUserBranchPath(this.branch);
			if (pending.length === 1 && path)
				pendingUser = {
					id: turn,
					digest: prefixMessageDigest(pending[0]),
					branch_cursor: this.branch.cursor,
					branch_path: path,
				};
		}
		try {
			writeServedPrefix({
				db: this.db,
				sessionId: this.sessionId,
				head: messages.slice(0, headCount),
				summary: null,
				firstKept: first,
				firstKeptId:
					first === undefined
						? undefined
						: stableId(first, messages.indexOf(first)),
				turn,
				provenance,
				pendingUser,
				cut:
					this.replayed && this.record
						? {
								...this.record.cut_mode,
								id:
									this.alias && this.record.cut_mode.id === this.alias.pending
										? this.alias.native
										: this.record.cut_mode.id,
							}
						: {
								mode:
									!this.off && cutId
										? stableId(first, messages.indexOf(first)) === cutId
											? "partial"
											: "inclusive"
										: "none",
								id: this.off ? null : (cutId ?? null),
							},
			});
		} catch (error) {
			if (!this.off) throw degradedPassError("served-prefix-write", error);
			this.unverified(`write failed: ${String(error)}`);
		}
	}
}
