import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { setPendingPiCompactionMarkerState } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { killBridgeMarkerOwner } from "@magic-context/core/hooks/magic-context/host-runner/bridge-marker-test-support";
import { bridgeReceipt } from "@magic-context/core/hooks/magic-context/host-runner/bridge-receipt";
import {
	commitScan,
	createRecord,
	scanWindow,
	sourceDigest,
} from "@magic-context/core/hooks/magic-context/host-runner/record";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/transform-operations";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import { createPiBridgeMarkerOwner } from "./bridge-marker-pi";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const message = (id: string): MessageLike =>
	({
		info: { id, role: "user" },
		parts: [{ id: `${id}-part`, type: "text", text: id }],
	}) as MessageLike;

function fixture(complete = true) {
	const scratch = createTestTempDir("pi-bridge-marker-");
	cleanups.push(scratch.cleanup);
	const db = new Database(join(scratch.dir, "context.db"));
	initializeDatabase(db);
	runMigrations(db);
	cleanups.push(() => db.close());
	const session = SessionManager.create(
		scratch.dir,
		join(scratch.dir, "sessions"),
	);
	const first = session.appendMessage({
		role: "user",
		content: "first",
		timestamp: 1,
	});
	const second = session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "second" }],
		timestamp: 2,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.6",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const raw = [message(first), message(second)];
	const record = createRecord({
		lineage_id: "pi-lineage",
		plan: {},
		initial: {
			compaction_id: "initial",
			version: 0,
			range: { from: 0, to: 0 },
			replacement: [] as MessageLike[],
		},
	});
	record.view = {
		compaction_id: "compacted",
		version: 1,
		range: { from: 1, to: 2 },
		replacement: [message("summary")],
		state: "applied",
		coverage: { end_mid: first, ordinal: 1 },
	};
	record.ids = new Map([
		[first, 1],
		[second, 2],
	]);
	record.source_digests = new Map(
		raw.map((m) => [m.info.id!, sourceDigest(JSON.stringify(m))]),
	);
	record.next_ordinal = 3;
	const view = [record.view.replacement[0], raw[1]];
	appendCompartments(db, session.getSessionId(), [
		{
			sequence: 0,
			startMessage: 1,
			endMessage: 1,
			startMessageId: first,
			endMessageId: first,
			title: "summary",
			content: "summary",
		},
	]);
	setPendingPiCompactionMarkerState(db, session.getSessionId(), {
		firstKeptEntryId: second,
		endMessageId: first,
		ordinal: 1,
		tokensBefore: 100,
		summary: "Magic Context compacted prior history.",
		publishedAt: 1,
	});
	const deps = {
		db,
		reloadSession: () => {
			const fresh = SessionManager.open(session.getSessionFile()!);
			return {
				readBranchEntries: () => fresh.getBranch(),
				appendCompaction: fresh.appendCompaction.bind(fresh),
			};
		},
	};
	const owner = createPiBridgeMarkerOwner(deps, session.getSessionId());
	const pending = owner.publish(bridgeReceipt(record), view, 2);
	const receipt = complete
		? owner.complete(pending.request_id, {
				status: 200,
				cleanEnd: true,
			})!
		: pending;
	const inputs = {
		messages: raw,
		model: "openai/gpt-5.6",
		envelope: "system+tools",
		contextWindow: 100_000,
		systemPromptTokens: 100,
		toolDefinitionTokens: 20,
	};
	return { db, session, record, owner, receipt, inputs, deps, scratch };
}

test("Pi bridge native owner appends only after a covering applied receipt and fit", () => {
	const f = fixture();
	expect(
		f.owner.advance(f.receipt, f.record, { ...f.inputs, contextWindow: 1 })
			.kind,
	).toBe("deferred");
	expect(
		f.deps
			.reloadSession()
			.readBranchEntries()
			.filter((e) => (e as any).type === "compaction"),
	).toHaveLength(0);
	expect(f.owner.advance(f.receipt, f.record, f.inputs).kind).toBe("applied");
	expect(
		f.deps
			.reloadSession()
			.readBranchEntries()
			.filter((e) => (e as any).type === "compaction"),
	).toHaveLength(1);
});

test("Pi durable applied receipt advances with delivery pending and survives restart for fallback", () => {
	const f = fixture(false);
	expect(f.receipt.delivery).toBe("pending");
	expect(f.owner.advance(f.receipt, f.record, f.inputs).kind).toBe("applied");
	expect(f.owner.current()).toMatchObject({
		delivery: "pending",
		served_through_ordinal: 0,
	});
	const restarted = createPiBridgeMarkerOwner(f.deps, f.session.getSessionId());
	const append = message("new-tail");
	expect(
		restarted.isFallbackAdmissible(f.record, {
			...f.inputs,
			messages: [f.inputs.messages[1], append],
		}),
	).toEqual({
		admissible: true,
		view: [f.record.view.replacement[0], f.inputs.messages[1], append],
	});
});

for (const state of ["pending-apply", "not-applied"] as const)
	test(`Pi ${state} receipt does not advance`, () => {
		const f = fixture(false);
		if (state === "pending-apply") f.record.view.state = "invalidated";
		else
			f.record.last_not_applied = {
				compaction_id: "rejected",
				version: 2,
				reason: "structural",
			};
		const receipt = f.owner.publish(
			bridgeReceipt(f.record),
			[f.record.view.replacement[0], f.inputs.messages[1]],
			2,
		);
		expect(f.owner.advance(receipt, f.record, f.inputs).kind).toBe("deferred");
		expect(
			f.deps
				.reloadSession()
				.readBranchEntries()
				.filter((e) => (e as any).type === "compaction"),
		).toHaveLength(0);
	});

test("Pi branch below the marker removes it from the active branch and invalidates the covered view", () => {
	const f = fixture(false);
	f.record.view.range.to = 3;
	f.record.view.coverage = {
		end_mid: f.inputs.messages[1].info.id!,
		ordinal: 2,
	};
	const receipt = f.owner.publish(
		bridgeReceipt(f.record),
		[f.record.view.replacement[0]],
		2,
	);
	expect(f.owner.advance(receipt, f.record, f.inputs).kind).toBe("applied");
	const journal = SessionManager.open(f.session.getSessionFile()!);
	expect(journal.getBranch().some((e) => e.type === "compaction")).toBe(true);
	journal.branch(f.inputs.messages[0].info.id!);
	expect(journal.getBranch().some((e) => e.type === "compaction")).toBe(false);
	expect(journal.getEntries().some((e) => e.type === "compaction")).toBe(true);
	journal.appendMessage({ role: "user", content: "new branch", timestamp: 3 });
	expect(
		f.owner.isFallbackAdmissible(f.record, {
			...f.inputs,
			messages: f.inputs.messages.slice(0, 1),
		}),
	).toMatchObject({
		admissible: false,
		reason: "covered_range_changed",
		detail: "native-cut-journal-boundary-changed",
	});
	const scan = scanWindow(f.record, [
		{
			id: f.inputs.messages[0].info.id,
			classify: () => "terminal" as const,
			read: () => f.inputs.messages[0],
		},
	]);
	commitScan(f.record, scan, "reverted-pi-lineage");
	expect(f.record.view.state).toBe("invalidated");
	expect(
		f.owner.isFallbackAdmissible(f.record, {
			...f.inputs,
			messages: f.inputs.messages.slice(0, 1),
		}),
	).toMatchObject({ admissible: false, reason: "covered_range_changed" });
});

test("Pi effective cut rejects a dangling or edited first-kept entry", () => {
	const f = fixture(false);
	expect(f.owner.advance(f.receipt, f.record, f.inputs).kind).toBe("applied");
	const branch = f.deps.reloadSession().readBranchEntries();
	for (const [entries, detail] of [
		[
			branch.filter((e) => (e as any).id !== f.inputs.messages[1].info.id),
			"native-cut-first-kept-dangling",
		],
		[
			branch.map((e) =>
				(e as any).type === "compaction"
					? { ...(e as object), firstKeptEntryId: f.inputs.messages[0].info.id }
					: e,
			),
			"native-cut-journal-boundary-changed",
		],
	] as const) {
		const owner = createPiBridgeMarkerOwner(
			{
				...f.deps,
				reloadSession: () => ({
					...f.deps.reloadSession(),
					readBranchEntries: () => [...entries],
				}),
			},
			f.session.getSessionId(),
		);
		expect(owner.isFallbackAdmissible(f.record, f.inputs)).toMatchObject({
			admissible: false,
			reason: "covered_range_changed",
			detail,
		});
	}
});

test("Pi bridge never has two appenders even through independent database connections", () => {
	const f = fixture();
	const db2 = new Database(join(f.scratch.dir, "context.db"));
	cleanups.push(() => db2.close());
	db2.exec("PRAGMA busy_timeout=1");
	let contenderAppends = 0;
	const contender = createPiBridgeMarkerOwner(
		{
			...f.deps,
			db: db2,
			reloadSession: () => ({
				...f.deps.reloadSession(),
				appendCompaction: () => {
					contenderAppends++;
					return "forbidden";
				},
			}),
		},
		f.session.getSessionId(),
	);
	let contenderResult: string | undefined;
	const owner = createPiBridgeMarkerOwner(
		{
			...f.deps,
			reloadSession: () => {
				const fresh = f.deps.reloadSession();
				return {
					...fresh,
					appendCompaction: (
						...args: Parameters<typeof fresh.appendCompaction>
					) => {
						contenderResult = contender.advance(
							f.receipt,
							f.record,
							f.inputs,
						).kind;
						return fresh.appendCompaction(...args);
					},
				};
			},
		},
		f.session.getSessionId(),
	);
	expect(owner.advance(f.receipt, f.record, f.inputs).kind).toBe("applied");
	expect(contenderResult).toBe("deferred");
	expect(contenderAppends).toBe(0);
	expect(
		f.deps
			.reloadSession()
			.readBranchEntries()
			.filter((e) => (e as any).type === "compaction"),
	).toHaveLength(1);
});

// The crash probe requires POSIX SIGKILL and lsof; admission tests run on every platform.
test.skipIf(process.platform === "win32")(
	"Pi kill after receipt persistence recovers without a duplicate native append",
	() => {
		const f = fixture();
		const killed = killBridgeMarkerOwner({
			root: f.scratch.dir,
			dbPath: join(f.scratch.dir, "context.db"),
			sessionId: f.session.getSessionId(),
			harness: "pi",
			receipt: f.receipt,
			target: { end_mid: f.record.view.coverage!.end_mid, ordinal: 1 },
			raw: f.inputs.messages,
			view: [f.record.view.replacement[0], f.inputs.messages[1]],
		});
		expect(killed.stderr).toBe("");
		expect(killed.signal).toBe("SIGKILL");
		expect(killed.stdout).toContain("isolated owner databases:");
		console.log(killed.stdout.trim());
		const restarted = createPiBridgeMarkerOwner(
			f.deps,
			f.session.getSessionId(),
		);
		expect(
			restarted.advance(f.receipt, f.record, {
				...f.inputs,
				contextWindow: undefined,
			}).kind,
		).toBe("unknown");
		expect(restarted.advance(f.receipt, f.record, f.inputs).kind).toBe(
			"applied",
		);
		expect(restarted.advance(f.receipt, f.record, f.inputs).kind).toBe(
			"deferred",
		);
		expect(
			SessionManager.open(f.session.getSessionFile()!)
				.getBranch()
				.filter((e) => e.type === "compaction"),
		).toHaveLength(1);
	},
);

test("Pi ambiguous committed append reloads the journal before retrying", () => {
	const f = fixture();
	const uncertain = createPiBridgeMarkerOwner(
		{
			...f.deps,
			reloadSession: () => {
				const fresh = f.deps.reloadSession();
				return {
					...fresh,
					appendCompaction: (
						...args: Parameters<typeof fresh.appendCompaction>
					) => {
						fresh.appendCompaction(...args);
						throw new Error("append committed but caller lost its result");
					},
				};
			},
		},
		f.session.getSessionId(),
	);
	expect(uncertain.advance(f.receipt, f.record, f.inputs).kind).toBe("unknown");
	expect(f.owner.advance(f.receipt, f.record, f.inputs).kind).toBe("applied");
	expect(
		f.deps
			.reloadSession()
			.readBranchEntries()
			.filter((e) => (e as any).type === "compaction"),
	).toHaveLength(1);
});
