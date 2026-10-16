import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOW } from "./upgrade-audit";
import type { M0M1RenderOptions } from "../../packages/plugin/src/hooks/magic-context/inject-compartments";
import type { Database } from "../../packages/plugin/src/shared/sqlite";

const [mode, tree, root, output] = process.argv.slice(2);
process.env.HOME = join(root, "home");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "host.log");
process.env.OPENCODE_DB = join(root, "unused-opencode.db");
process.env.NODE_ENV = mode === "refuse" ? "production" : "test";
Date.now = () => NOW;
const feature = (file: string) =>
	join(tree, "packages/plugin/src/features/magic-context", file);
const storage = (await import(
	feature("storage-db.ts")
)) as typeof import("../../packages/plugin/src/features/magic-context/storage-db");

if (process.env.REHEARSAL_CRASH_VERSION) {
	const { MIGRATIONS } = (await import(
		feature("migrations.ts")
	)) as typeof import("../../packages/plugin/src/features/magic-context/migrations");
	const migration = MIGRATIONS.find(
		(m) => m.version === Number(process.env.REHEARSAL_CRASH_VERSION),
	);
	if (!migration) throw new Error("Crash migration not found");
	const up = migration.up;
	migration.up = (db: Database) => {
		up(db);
		writeFileSync(
			join(root, "crash-ready"),
			`context.db migration ${migration.version} body applied, transaction uncommitted`,
		);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	};
}

if (mode === "refuse") {
	const db = storage.openDatabase(join(root, "context.db"));
	if (db) {
		db.close();
		throw new Error("Old plugin accepted upgraded context.db");
	}
	const refusal = storage.getSchemaFenceRejection();
	if (!refusal)
		throw new Error("Plugin returned null without a schema-fence refusal");
	const logger = (await import(
		join(tree, "packages/plugin/src/shared/logger.ts")
	)) as typeof import("../../packages/plugin/src/shared/logger");
	logger.flushLogger();
	console.log(
		JSON.stringify({
			rejection: refusal,
			log: readFileSync(logger.getLogFilePath(), "utf8"),
		}),
	);
} else {
	const db =
		mode === "render"
			? (new (
					await import(join(tree, "packages/plugin/src/shared/sqlite.ts"))
				).Database(join(root, "context.db")) as Database)
			: storage.openDatabase(join(root, "context.db"));
	if (!db)
		throw new Error(
			`context.db opener refused: ${JSON.stringify(storage.getSchemaFenceRejection())}`,
		);
	if (mode === "seed") {
		const { insertTag } = (await import(
			feature("storage-tags.ts")
		)) as typeof import("../../packages/plugin/src/features/magic-context/storage-tags");
		const { indexSourcesAfterOrdinal } = (await import(
			feature("message-index.ts")
		)) as typeof import("../../packages/plugin/src/features/magic-context/message-index");
		const { appendCompartments } = (await import(
			feature("compartment-storage.ts")
		)) as typeof import("../../packages/plugin/src/features/magic-context/compartment-storage");
		const { insertMemory } = (await import(
			feature("memory/storage-memory.ts")
		)) as typeof import("../../packages/plugin/src/features/magic-context/memory/storage-memory");
		const { addNote } = (await import(
			feature("storage-notes.ts")
		)) as typeof import("../../packages/plugin/src/features/magic-context/storage-notes");
		const { ensureSessionMetaRow } = (await import(
			feature("storage-meta-shared.ts")
		)) as typeof import("../../packages/plugin/src/features/magic-context/storage-meta-shared");
		for (let s = 0; s < 20; s++) {
			const session = `session-${String(s).padStart(2, "0")}`;
			ensureSessionMetaRow(db, session);
			const count = s === 0 ? 150_000 : 500;
			for (let start = 1; start <= count; start += 1000) {
				const sources = Array.from(
					{ length: Math.min(1000, count - start + 1) },
					(_, i) => {
						const n = start + i;
						const content = `Session ${s} message ${n}: preserve Unicode 東京 🧠, code, decisions and tool results.\n${"Realistic repeated payload with identifiers and paths. ".repeat(12)} unique-${s}-${n}`;
						return {
							id: `message-${s}-${n}`,
							ordinal: n,
							role: n % 2 ? "user" : "assistant",
							createdAt: NOW - (count - n) * 1000,
							sourceVersion: "1",
							contentHash: new Bun.CryptoHasher("sha256")
								.update(content)
								.digest("hex"),
							content,
						};
					},
				);
				indexSourcesAfterOrdinal(db, session, sources, sources.at(-1)!.ordinal);
				db.transaction(() => {
					for (const source of sources)
						insertTag(db, session, source.id, "message", 750, source.ordinal);
				}).immediate();
			}
			appendCompartments(
				db,
				session,
				Array.from({ length: s === 0 ? 2300 : 6 }, (_, i) => ({
					sequence: i + 1,
					startMessage: i * 65 + 1,
					endMessage: (i + 1) * 65,
					startMessageId: `message-${s}-${i * 65 + 1}`,
					endMessageId: `message-${s}-${(i + 1) * 65}`,
					title: `Design ${s}/${i}`,
					content: `Compartment ${s}/${i}: ${"Exact archival content 東京. ".repeat(60)}`,
					p1: `Full summary ${s}/${i}. ${"Implementation constraints and decisions. ".repeat(16)}`,
					p2: `Concise summary ${s}/${i}`,
					p3: `Decision ${s}/${i}`,
					p4: `Landmark ${s}/${i}`,
					importance: 50 + (i % 50),
					episodeType: "design",
				})),
			);
			for (let i = 0; i < 5; i++) {
				addNote(db, "session", {
					sessionId: session,
					content: `Follow-up ${s}/${i}: 東京`,
					anchorOrdinal: count - i,
				});
				addNote(db, "smart", {
					sessionId: session,
					projectPath: "git:upgrade-rehearsal",
					content: `Check ${s}/${i}`,
					surfaceCondition: "After the build passes",
				});
			}
		}
		db.transaction(() => {
			for (let i = 0; i < 1000; i++) {
				const memory = insertMemory(db, {
					projectPath: "git:upgrade-rehearsal",
					category: "CONSTRAINTS",
					content: `Memory ${i}: preserve exact content 東京 🧠. ${"Architectural constraint. ".repeat(12)}`,
					sourceType: "agent",
					sourceSessionId: `session-${String(i % 20).padStart(2, "0")}`,
				});
				const embedding = new Float32Array(384);
				for (let j = 0; j < embedding.length; j++)
					embedding[j] = ((i + j) % 100) / 100;
				db.prepare(
					"INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES (?,?,'fixture-384')",
				).run(memory.id, Buffer.from(embedding.buffer));
				db.prepare(
					"INSERT INTO git_commits(sha,project_path,short_sha,message,author,committed_at,indexed_at) VALUES (?,?,?,?,?,?,?)",
				).run(
					i.toString(16).padStart(40, "0"),
					"git:upgrade-rehearsal",
					i.toString(16).padStart(7, "0"),
					`Commit ${i}: exact content`,
					"fixture",
					NOW - i * 60000,
					NOW,
				);
			}
		}).immediate();
		console.log(
			"Seeded 20 sessions, 159500 messages, 2414 compartments, 1000 memories/commits/384-d embeddings, 200 notes using v0.49.0 writers",
		);
	} else if (mode === "render") {
		const { materializeM0 } = (await import(
			join(
				tree,
				"packages/plugin/src/hooks/magic-context/inject-compartments.ts",
			)
		)) as typeof import("../../packages/plugin/src/hooks/magic-context/inject-compartments");
		const sessions = db
			.prepare(
				"SELECT session_id FROM session_meta ORDER BY session_id LIMIT 5",
			)
			.all() as { session_id: string }[];
		if (sessions.length === 0)
			throw new Error("No sessions available for prompt comparison");
		mkdirSync(output, { recursive: true });
		for (const { session_id } of sessions) {
			const project = db
				.prepare("SELECT project_path FROM session_projects WHERE session_id=?")
				.get(session_id) as { project_path: string } | undefined;
			const state = { sessionId: session_id } as M0M1RenderOptions["state"];
			const rendered = materializeM0({
				db,
				sessionId: session_id,
				state,
				projectPath: project?.project_path ?? "git:upgrade-rehearsal",
				projectDirectory: join(root, "project"),
			});
			writeFileSync(
				join(output, `${encodeURIComponent(session_id)}.json`),
				JSON.stringify({
					session: session_id,
					m0: rendered.m0Text,
					m1: rendered.m1Text,
				}),
			);
		}
		console.log(
			`Rendered default m[0]/m[1] for ${sessions.length} sessions at frozen clock ${NOW}`,
		);
	} else if (mode !== "migrate")
		throw new Error(`Unknown host operation ${mode}`);
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();
}
