import { afterEach, expect, it, spyOn } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { readServedPrefix } from "@magic-context/core/hooks/magic-context/served-prefix";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import * as tagTranscriptModule from "@magic-context/core/shared/tag-transcript";
import { servedMessageDigest } from "../../plugin/src/hooks/magic-context/__tests__/served-prefix-evidence";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	_resetHarnessForTesting();
	setHarness("pi");
});
const model = {
	provider: "anthropic",
	id: "claude-opus-5-5",
	api: "anthropic-messages",
	contextWindow: 100_000,
};
type Entry = {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
};

async function fixture(host: "pi" | "omp" = "omp", withHistory = true) {
	const db = createTestDb();
	_resetHarnessForTesting();
	setHarness(host);
	const session = `pending-user-${crypto.randomUUID()}`;
	cleanups.push(() => {
		clearContextHandlerSession(session);
		db.close();
	});
	getOrCreateSessionMeta(db, session);
	updateSessionMeta(db, session, {
		cacheTtl: "59m",
		lastResponseTime: Date.now(),
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		signedThinkingHold: "on",
		injection: {
			injectionBudgetTokens: 4000,
			memoryEnabled: false,
			injectDocs: false,
		},
	});
	const handler = fake.handlers.get("context");
	if (!handler) throw new Error("Context handler missing");
	const raw = [
		...(withHistory
			? [userMessage("Earlier task", 1), assistantMessage("Earlier answer", 2)]
			: []),
		userMessage("Pending task", 3),
	];
	let pendingIndex: number | undefined = raw.length - 1;
	let alter: ((entries: Entry[]) => Entry[]) | undefined;
	const pass = async () => {
		const messages = structuredClone(raw);
		let parent = "root";
		const entries: Entry[] = [
			{ type: "model_change", id: parent, parentId: null },
		];
		for (let index = 0; index < messages.length; index++) {
			if (index === pendingIndex) continue;
			const id =
				(withHistory ? ["history", "prior", "native-user"] : ["native-user"])[
					index
				] ?? `entry-${index}`;
			entries.push({
				type: "message",
				id,
				parentId: parent,
				message: messages[index],
			});
			parent = id;
		}
		const branch = alter ? alter(entries) : entries;
		const base = fakeContext(session);
		const ctx = {
			...base,
			model,
			sessionManager: {
				getSessionId: () => session,
				getBranch: () => branch,
				getLeafId: () => branch.at(-1)?.id ?? null,
				getEntry: (id: string) => branch.find((entry) => entry.id === id),
			},
		};
		const output = (await handler({ messages } as never, ctx as never)) as
			| { messages: unknown[] }
			| undefined;
		if (!output) throw new Error("Managed handler fell through to raw input");
		return output.messages;
	};
	const initial = await pass();
	const record = readServedPrefix(db, session);
	if (!record) throw new Error("First request did not publish its record");
	const recordText = () =>
		(
			db
				.prepare("SELECT served_prefix FROM session_meta WHERE session_id = ?")
				.get(session) as { served_prefix: string }
		).served_prefix;
	const saved = recordText();
	const addRound = () => {
		const index = raw.length;
		raw.push(
			assistantMessage("Tool request", index + 1, {
				provider: model.provider,
				model: model.id,
				api: model.api,
				content: [
					{
						type: "thinking",
						thinking: `Thought ${index}`,
						thinkingSignature: `signed-${index}`,
					},
					{
						type: "toolCall",
						id: `call-${index}`,
						name: "read",
						arguments: { path: "file" },
					},
				],
				stopReason: "toolUse",
			}),
		);
		raw.push({
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "read",
			content: [{ type: "text", text: "Result" }],
			isError: false,
			timestamp: index + 2,
		} as never);
	};
	return {
		db,
		session,
		raw,
		initial,
		record,
		saved,
		recordText,
		pass,
		addRound,
		resolve: () => {
			pendingIndex = undefined;
		},
		newUser: () => {
			raw.push(userMessage("Next task", raw.length + 1));
			pendingIndex = raw.length - 1;
		},
		alter: (change: (entries: Entry[]) => Entry[]) => {
			alter = change;
		},
	};
}

it("OMP pending-user certificate replays a native-id tool loop byte-identically without rekeying", async () => {
	const f = await fixture();
	expect(f.record.turn).toStartWith("pi-msg-");
	expect(f.record.pending_user).toEqual({
		id: f.record.turn,
		digest: servedMessageDigest(f.initial.at(-1)),
		branch_cursor: "prior",
		branch_path: ["root", "history", "prior"],
	});
	f.resolve();
	f.addRound();
	const held = await f.pass();
	expect(held.slice(0, f.initial.length)).toEqual(f.initial);
	expect(await f.pass()).toEqual(held);
	clearContextHandlerSession(f.session);
	expect(await f.pass()).toEqual(held);
	f.addRound();
	expect((await f.pass()).slice(0, held.length)).toEqual(held);
	expect(f.recordText()).toBe(f.saved);
});

it("OMP pending-user certificate refuses a different user at the same position", async () => {
	const f = await fixture();
	f.resolve();
	f.addRound();
	f.raw[2].content = "A different user at the same position";
	await expectRefusal(f, "pending-user whole-message digest mismatch");
	expect(f.recordText()).toBe(f.saved);
});

it("OMP writable next user adopts the native first-kept id without rewriting a held record", async () => {
	const f = await fixture("omp", false);
	expect(f.record.first_kept?.id).toBe(f.record.turn);
	f.resolve();
	f.addRound();
	const held = await f.pass();
	expect(f.recordText()).toBe(f.saved);
	f.newUser();
	const next = await f.pass();
	expect(next.slice(0, held.length)).toEqual(held);
	const nextRecord = readServedPrefix(f.db, f.session);
	expect(nextRecord?.first_kept?.id).toBe("native-user");
	expect(nextRecord?.pending_user?.id).toBe(nextRecord?.turn ?? "absent");
	f.resolve();
	f.addRound();
	expect((await f.pass()).slice(0, next.length)).toEqual(next);
});

it("OMP pending-user certificate refuses an identical user outside the saved cursor lineage", async () => {
	const f = await fixture("omp", false);
	f.resolve();
	f.addRound();
	f.alter((entries) =>
		entries.map((entry) => ({
			...entry,
			id: entry.id === "root" ? "other-root" : entry.id,
			parentId: entry.parentId === "root" ? "other-root" : entry.parentId,
		})),
	);
	await expectRefusal(f, "pending-user saved cursor is not on this branch");
	expect(f.recordText()).toBe(f.saved);
});

async function expectRefusal(
	f: Awaited<ReturnType<typeof fixture>>,
	reason: string,
) {
	let error: unknown;
	try {
		await f.pass();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeDefined();
	const causes: string[] = [];
	for (let current = error; current instanceof Error; current = current.cause)
		causes.push(current.message);
	expect(causes.join("\n")).toContain(reason);
}

it("OMP pending-user certificate refuses two native user candidates", async () => {
	const f = await fixture();
	f.resolve();
	f.addRound();
	f.alter((entries) =>
		entries.flatMap((entry) =>
			entry.id === "native-user"
				? [entry, { ...entry, id: "second-user", parentId: entry.id }]
				: [
						{
							...entry,
							parentId:
								entry.parentId === "native-user"
									? "second-user"
									: entry.parentId,
						},
					],
		),
	);
	await expectRefusal(f, "pending-user descendant missing or ambiguous");
	expect(f.recordText()).toBe(f.saved);
});

it("OMP pending-user certificate refuses a tree switch between passes", async () => {
	const f = await fixture();
	f.resolve();
	f.addRound();
	f.alter((entries) =>
		entries
			.filter((entry) => entry.id !== "prior")
			.map((entry) =>
				entry.id === "native-user" ? { ...entry, parentId: "history" } : entry,
			),
	);
	await expectRefusal(f, "pending-user saved cursor is not on this branch");
	expect(f.recordText()).toBe(f.saved);
});

it("OMP pending-user certificate refuses a moved saved branch boundary", async () => {
	const f = await fixture();
	f.resolve();
	f.addRound();
	f.alter((entries) =>
		entries.map((entry) =>
			entry.id === "prior"
				? { ...entry, id: "moved-prior" }
				: {
						...entry,
						parentId:
							entry.parentId === "prior" ? "moved-prior" : entry.parentId,
					},
		),
	);
	await expectRefusal(f, "pending-user saved cursor is not on this branch");
	expect(f.recordText()).toBe(f.saved);
});

it("OMP pending-user certificate refuses a moved record anchor", async () => {
	const f = await fixture();
	f.resolve();
	f.addRound();
	f.db
		.prepare("UPDATE session_meta SET served_prefix = ? WHERE session_id = ?")
		.run(JSON.stringify({ ...f.record, turn: "another-turn" }), f.session);
	await expectRefusal(f, "pending-user anchor moved");
});

it("plain Pi never writes or uses a pending-user alias", async () => {
	const f = await fixture("pi");
	expect(f.record.pending_user).toBeUndefined();
	f.resolve();
	f.addRound();
	await expect(f.pass()).rejects.toThrow();
	expect(f.recordText()).toBe(f.saved);
});

it("OMP records without a certificate retain the identity-mismatch refusal", async () => {
	const f = await fixture();
	f.resolve();
	f.addRound();
	const { pending_user: _certificate, ...record } = f.record;
	f.db
		.prepare("UPDATE session_meta SET served_prefix = ? WHERE session_id = ?")
		.run(JSON.stringify(record), f.session);
	await expectRefusal(f, "turn mismatch");
});

it("OMP pending-user lineage refusal precedes last-known-good recovery", async () => {
	const f = await fixture();
	f.resolve();
	f.addRound();
	await f.pass();
	f.alter((entries) =>
		entries.map((entry) => {
			const retained = (id: string | null) =>
				id === null || id === "root" || id === "history";
			return {
				...entry,
				id: retained(entry.id) ? entry.id : `switched-${entry.id}`,
				parentId: retained(entry.parentId)
					? entry.parentId
					: `switched-${entry.parentId}`,
			};
		}),
	);
	const failure = spyOn(
		tagTranscriptModule,
		"tagTranscript",
	).mockImplementation(() => {
		throw new Error("Tag writer unavailable");
	});
	try {
		await expectRefusal(f, "pending-user saved cursor is not on this branch");
		expect(failure).not.toHaveBeenCalled();
		expect(f.recordText()).toBe(f.saved);
	} finally {
		failure.mockRestore();
	}
});

it("OMP different pending user cannot escape through last-known-good recovery", async () => {
	const f = await fixture();
	f.resolve();
	f.addRound();
	await f.pass();
	f.raw[2].content = "Replacement pending user";
	const failure = spyOn(
		tagTranscriptModule,
		"tagTranscript",
	).mockImplementation(() => {
		throw new Error("Tag writer unavailable");
	});
	try {
		await expectRefusal(
			f,
			"pending-user recovery cannot prove final message identity",
		);
		expect(f.recordText()).toBe(f.saved);
	} finally {
		failure.mockRestore();
	}
});

it("OMP rejects malformed persisted pending-user certificates", async () => {
	const f = await fixture();
	f.resolve();
	f.addRound();
	for (const certificate of [
		null,
		{},
		{ ...f.record.pending_user, digest: "not-a-digest" },
		{ ...f.record.pending_user, branch_cursor: 42 },
		{ ...f.record.pending_user, branch_path: [42] },
	]) {
		f.db
			.prepare("UPDATE session_meta SET served_prefix = ? WHERE session_id = ?")
			.run(
				JSON.stringify({ ...f.record, pending_user: certificate }),
				f.session,
			);
		expect(readServedPrefix(f.db, f.session)).toBeNull();
		await expect(f.pass()).rejects.toThrow();
	}
});
