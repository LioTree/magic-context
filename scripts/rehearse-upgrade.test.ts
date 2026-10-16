import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareServedBodies, firstDifference, snapshotRoot } from "./lib/upgrade-audit";

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

test("upgrade audit compares actual served reasoning and does not normalize changed bytes", () => {
	const before = { system: "Keep 東京", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "signed" }] }], tools: [{ name: "ctx" }] };
	const same = compareServedBodies(before, structuredClone(before));
	expect(Object.values(same).every((part) => part.equal)).toBe(true);
	const after = structuredClone(before);
	after.messages[0].content[0].signature = "changed";
	const changed = compareServedBodies(before, after);
	expect(changed.system.equal).toBe(true);
	expect(changed.tools.equal).toBe(true);
	expect(changed.messages.equal).toBe(false);
	expect(changed.messages.firstDifference).toBeGreaterThan(0);
	expect(changed.messages.sha256Before).not.toBe(changed.messages.sha256After);
	expect(changed.messages.afterExcerpt).toContain("changed");
});

test("upgrade audit distinguishes missing payload fields from served empty arrays", () => {
	const changed = compareServedBodies({}, { system: [], messages: [], tools: [] });
	for (const part of Object.values(changed)) {
		expect(part.equal).toBe(false);
		expect(part.bytesBefore).toBe(4);
		expect(part.bytesAfter).toBe(2);
		expect(part.firstDifference).toBe(0);
	}
});

test("upgrade audit scopes live domain preservation without hiding changed rows or missing tables", () => {
	const [before, after] = pair();
	const db = new Database(after);
	db.exec("UPDATE session_meta SET state='startup-timestamp'");
	expect(firstDifference(before, after, ["memories"])).toBeNull();
	db.exec("DELETE FROM memories");
	expect(firstDifference(before, after, ["memories"])).toContain("memories: lost/changed row");
	db.close();
	expect(() => firstDifference(before, after, ["misspelled_table"])).toThrow("Preservation table not present in baseline");
});
