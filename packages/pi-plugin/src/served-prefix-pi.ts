import { degradedPassError } from "@magic-context/core/hooks/magic-context/degraded-pass-refusal";
import {
	type PrefixProvenance,
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

const provenance: PrefixProvenance = {
	host: "pi",
	id_space: "pi-entry",
	generation: "pi",
	projection: "messages",
};

/** A missing first_kept host message refuses only this pass; retries read history again. */
export class PiPrefixPass {
	readonly turn: string | null;
	readonly record: ServedPrefix<unknown> | null;
	replayed = false;
	compactionOffFallback?: (messages: unknown[], headCount: number) => void;
	constructor(
		private readonly db: Database,
		private readonly sessionId: string,
		messages: readonly unknown[],
		stableId: (message: unknown, index: number) => string | undefined,
		public boundary: boolean,
		private readonly off: boolean,
	) {
		this.turn = prefixTurn(messages, stableId);
		let record: ServedPrefix<unknown> | null = null;
		try {
			record = readServedPrefix(db, sessionId);
		} catch (error) {
			if (!off) throw degradedPassError("served-prefix-read", error);
		}
		this.record = record;
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
		const first = messages
			.slice(headCount)
			.find((message, index) => stableId(message, index + headCount));
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
				turn: this.turn,
				provenance,
				cut: this.replayed
					? this.record?.cut_mode
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
