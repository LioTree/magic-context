import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstDifference, snapshotRoot } from "./lib/upgrade-audit";

function pair(): [string, string] {
	const parent = join(tmpdir(), "magic-context", "upgrade-audit-test");
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "case-"));
	const before = join(root, "before.db");
	const after = join(root, "after.db");
	const db = new Database(before);
	db.exec(
		"CREATE TABLE memories(id INTEGER PRIMARY KEY, content TEXT, embedding BLOB); INSERT INTO memories VALUES(1,'東京',x'00ff'); CREATE TABLE session_meta(session_id TEXT PRIMARY KEY, state TEXT); INSERT INTO session_meta VALUES('s','opaque');",
	);
	db.close();
	copyFileSync(before, after);
	return [before, after];
}

test("upgrade audit accepts additive columns without changing old session_meta keys", () => {
	const [before, after] = pair();
	const db = new Database(after);
	db.exec("ALTER TABLE session_meta ADD COLUMN held_release TEXT");
	db.close();
	expect(firstDifference(before, after)).toBeNull();
});

test("upgrade audit names the exact changed memory row including blobs", () => {
	const [before, after] = pair();
	const db = new Database(after);
	db.exec("UPDATE memories SET embedding=x'00fe' WHERE id=1");
	db.close();
	expect(firstDifference(before, after)).toContain(
		'memories: lost/changed row {"__rowid":1,"id":1',
	);
});

test("upgrade audit catches deleted session_meta keys", () => {
	const [before, after] = pair();
	const db = new Database(after);
	db.exec("DELETE FROM session_meta");
	db.close();
	expect(firstDifference(before, after)).toContain(
		"session_meta: lost/changed row",
	);
});

test("upgrade audit refuses the live storage root before opening databases", () => {
	expect(() =>
		snapshotRoot(
			join(process.env.HOME!, ".local/share/cortexkit/magic-context"),
		),
	).toThrow("Refusing live storage root");
});

test("upgrade audit compares WITHOUT ROWID tables and skips views", () => {
	const [before, after] = pair();
	for (const path of [before, after]) {
		const db = new Database(path);
		db.exec(
			"CREATE VIEW memory_view AS SELECT id,content FROM memories; CREATE TABLE durable_keys(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; INSERT INTO durable_keys VALUES('k','original')",
		);
		db.close();
	}
	expect(firstDifference(before, after)).toBeNull();
	const db = new Database(after);
	db.exec("UPDATE durable_keys SET value='changed'");
	db.close();
	expect(firstDifference(before, after)).toContain(
		'durable_keys: lost/changed row {"key":"k","value":"original"}',
	);
});
