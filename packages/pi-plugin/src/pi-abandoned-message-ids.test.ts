/// <reference types="bun-types" />

/**
 * Pi keeps every entry of every branch in the session JSONL: a `/tree` jump moves
 * the leaf, it does not delete the abandoned entries. Their raw-message index rows
 * therefore outlive the branch and stay searchable once a compartment moves the
 * ordinal cutoff past them. The lane needs exactly the abandoned ids — not the
 * live ones, because compaction puts every legitimate hit off-branch on purpose —
 * and it must answer "unknown" rather than guess whenever the host cannot tell.
 */

import { describe, expect, it } from "bun:test";
import {
	classifyPiBranchEntryIds,
	clearPiAbandonedMessageIds,
	resolvePiAbandonedMessageIds,
} from "./pi-abandoned-message-ids";
import { SYNTH_USER_ID_PREFIX } from "./read-session-pi";

function entry(id: string, role = "user"): unknown {
	return { type: "message", id, message: { role, content: `text of ${id}` } };
}

describe("classifyPiBranchEntryIds", () => {
	it("separates a rewound entry from the branch that replaced it", () => {
		// u1 → a1 → (rewound) → a1 → u2, with the rewound pair still in the file.
		const branch = [entry("u1"), entry("a1"), entry("u2")];
		const all = [
			entry("u1"),
			entry("a1"),
			entry("rewound-u"),
			entry("rewound-a"),
			entry("u2"),
		];

		const { onBranch, abandoned } = classifyPiBranchEntryIds(branch, all);

		expect([...onBranch].sort()).toEqual(["a1", "u1", "u2"]);
		expect([...abandoned].sort()).toEqual(["rewound-a", "rewound-u"]);
	});

	it("does NOT treat a compacted-away entry as abandoned", () => {
		// Pi appends compaction entries and never truncates the file, so
		// `getBranch()` still walks through pre-compaction ancestors. Those messages
		// stay on the branch, stay searchable, and must NOT land in this set — the
		// archive is the whole point of the message lane.
		const branch = [entry("u1"), entry("a1"), entry("summary"), entry("u9")];
		const all = [entry("u1"), entry("a1"), entry("summary"), entry("u9")];

		expect(classifyPiBranchEntryIds(branch, all).abandoned.size).toBe(0);
	});

	it("includes the synthetic folded tool-result id", () => {
		const branch = [entry("u1"), entry("t1", "toolResult")];
		const all = [...branch, entry("t2", "toolResult")];

		const { abandoned } = classifyPiBranchEntryIds(branch, all);

		expect([...abandoned].sort()).toEqual(
			[`${SYNTH_USER_ID_PREFIX}t2`, "t2"].sort(),
		);
	});

	it("reports nothing abandoned when the file equals the branch", () => {
		const branch = [entry("u1"), entry("a1")];
		expect(classifyPiBranchEntryIds(branch, branch).abandoned.size).toBe(0);
	});

	it("returns no abandoned ids when the file cannot be enumerated", () => {
		// Unknown must never mean "everything is abandoned": that would erase the
		// archive this lane exists to search.
		const { onBranch, abandoned } = classifyPiBranchEntryIds(
			[entry("u1")],
			null,
		);
		expect([...onBranch]).toEqual(["u1"]);
		expect(abandoned.size).toBe(0);
	});

	it("skips entries without a usable id", () => {
		const branch = [entry("u1")];
		const all = [
			...branch,
			{ type: "message" },
			{ type: "message", id: "" },
			null,
			"nope",
		];

		expect(classifyPiBranchEntryIds(branch, all).abandoned.size).toBe(0);
	});
});

describe("resolvePiAbandonedMessageIds", () => {
	function host(options: {
		branch: unknown[] | (() => never);
		all?: unknown[] | (() => never);
		leaf?: string | (() => never);
	}): unknown {
		return {
			sessionManager: {
				getBranch:
					typeof options.branch === "function"
						? options.branch
						: () => options.branch,
				getEntries:
					options.all === undefined
						? undefined
						: typeof options.all === "function"
							? options.all
							: () => options.all,
				getLeafId:
					typeof options.leaf === "function"
						? options.leaf
						: () => options.leaf,
			},
		};
	}

	it("reads both lists and memoizes per leaf", () => {
		clearPiAbandonedMessageIds("ses-memo");
		let reads = 0;
		let leaf = "leaf-1";
		const ctx = {
			sessionManager: {
				getBranch: () => {
					reads += 1;
					return [entry("u1")];
				},
				getEntries: () => [entry("u1"), entry("gone")],
				getLeafId: () => leaf,
			},
		};

		const first = resolvePiAbandonedMessageIds(ctx, "ses-memo");
		const second = resolvePiAbandonedMessageIds(ctx, "ses-memo");
		expect([...(first?.abandoned ?? [])]).toEqual(["gone"]);
		expect(second).toBe(first);
		expect(reads).toBe(1);

		leaf = "leaf-2";
		resolvePiAbandonedMessageIds(ctx, "ses-memo");
		expect(reads).toBe(2);
		clearPiAbandonedMessageIds("ses-memo");
	});

	it("uses preloaded branch entries without a second getBranch call", () => {
		let reads = 0;
		const ctx = {
			sessionManager: {
				getBranch: () => {
					reads += 1;
					return [];
				},
				getEntries: () => [entry("u1"), entry("gone")],
				getLeafId: () => "leaf-x",
			},
		};

		const result = resolvePiAbandonedMessageIds(ctx, "ses-preload", [
			entry("u1"),
		]);

		expect([...(result?.abandoned ?? [])]).toEqual(["gone"]);
		expect(reads).toBe(0);
		clearPiAbandonedMessageIds("ses-preload");
	});

	it("returns null when the host cannot enumerate the file", () => {
		expect(resolvePiAbandonedMessageIds({}, "ses-none")).toBeNull();
		expect(
			resolvePiAbandonedMessageIds(
				host({ branch: [entry("u1")], leaf: "leaf-1" }),
				"ses-none",
			),
		).toBeNull();
	});

	it("returns null when a host call throws instead of claiming nothing is abandoned", () => {
		// "Nothing abandoned" is a real answer; a failing host is not. Conflating
		// them would let a broken branch read re-expose the rewound rows.
		const ctx = host({
			branch: [entry("u1")],
			all: () => {
				throw new Error("session file unreadable");
			},
			leaf: "leaf-1",
		});
		expect(resolvePiAbandonedMessageIds(ctx, "ses-throw")).toBeNull();
	});

	it("answers without a leaf id instead of memoizing across branches", () => {
		let reads = 0;
		const ctx = {
			sessionManager: {
				getBranch: () => {
					reads += 1;
					return [entry("u1")];
				},
				getEntries: () => [entry("u1"), entry("gone")],
			},
		};

		expect([
			...(resolvePiAbandonedMessageIds(ctx, "ses-noleaf")?.abandoned ?? []),
		]).toEqual(["gone"]);
		resolvePiAbandonedMessageIds(ctx, "ses-noleaf");
		expect(reads).toBe(2);
	});
});
