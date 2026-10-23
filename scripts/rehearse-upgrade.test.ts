import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareServedBodies, firstDifference, snapshotRoot, hashFile } from "./lib/upgrade-audit";
import { assertEffects, assertCrashCoverage, assertBundles, assertDoctor, assertFullDoctorTarget, assertMigrationMetrics, assertArtifactIdentity, CONTEXT_CRASH_VERSIONS, STORE_CRASH_VERSIONS } from "./lib/upgrade-contract";
import { MOVED_COLUMNS, type PayloadProof } from "./lib/upgrade-payloads";
import { Database as ProductionDatabase } from "../packages/plugin/src/shared/sqlite";
import { initializeDatabase } from "../packages/plugin/src/features/magic-context/storage-db";
import { restorePreV103SessionMetaLayout } from "../packages/plugin/src/features/magic-context/session-meta-pre-v103-test-support";
import { splitSessionMetaPayloads } from "../packages/plugin/src/features/magic-context/migration-v103-session-payloads";
import { runMigrations } from "../packages/plugin/src/features/magic-context/migrations";
import { HOSTS, sampleSessions, assertHostCoverage, assertRendered, assertTagContinuity } from "./lib/upgrade-seats";
import { runSessionPass } from "./lib/upgrade-session-pass";
import { databaseDoctor } from "./lib/upgrade-doctor";

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
test("database hashing reads every buffer and the short final block", () => {
    const [path] = pair();
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x31);
    bytes[1024 * 1024 + 7] = 0xff;
    bytes[bytes.length - 1] = 0x80;
    writeFileSync(path, bytes);
    expect(hashFile(path)).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    bytes[bytes.length - 1] = 0x81;
    writeFileSync(path, bytes);
    expect(hashFile(path)).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
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

function movedPair(): [string, string] {
    const [before, after] = pair();
    const db = new ProductionDatabase(before);
    db.exec("DROP TABLE session_meta; DROP TABLE memories");
    initializeDatabase(db);
    restorePreV103SessionMetaLayout(db);
    db.exec("DROP TABLE IF EXISTS session_render_cache; DROP TABLE IF EXISTS session_meta_chunks; DROP TABLE IF EXISTS session_meta_collection_revisions");
    for (const id of ["text", "blob", "empty", "empty-blob", "invalid-text", "invalid-blob", "null", "default", "integer", "real"])
        db.prepare("INSERT INTO session_meta(session_id) VALUES(?)").run(id);
    const large = ` { \"duplicate\": 1, \"duplicate\": 2, \"text\": \"${"é🙂東京".repeat(400)}\" } `;
    for (const column of MOVED_COLUMNS) {
        for (const [id, value] of [["text", large], ["blob", Buffer.from(large)], ["empty", ""], ["empty-blob", Buffer.alloc(0)], ["invalid-blob", Buffer.from([0x80, 0, 0xff])]] as const)
            db.prepare(`UPDATE session_meta SET ${column}=? WHERE session_id=?`).run(value, id);
        db.exec(`UPDATE session_meta SET ${column}=CAST(x'8000ff' AS TEXT) WHERE session_id='invalid-text'`);
        db.exec(`UPDATE session_meta SET ${column}=9007199254740993 WHERE session_id='integer'; UPDATE session_meta SET ${column}=1.5 WHERE session_id='real'`);
        const info = db.prepare("PRAGMA table_info(session_meta)").all() as { name: string; notnull: number }[];
        if (!info.find((c) => c.name === column)?.notnull)
            db.exec(`UPDATE session_meta SET ${column}=NULL WHERE session_id='null'`);
    }
    db.close();
    copyFileSync(before, after);
    const next = new ProductionDatabase(after);
    splitSessionMetaPayloads(next);
    next.close();
    return [before, after];
}

test("migration 103 audit proves all thirteen payloads through production accessors", () => {
    const [before, after] = movedPair();
    const proof = { payloads: [] as PayloadProof[], tables: [] as {name: string; rows: number; sha256: string}[] };
    expect(firstDifference(before, after, undefined, proof)).toBeNull();
    expect(proof.payloads.map((p) => p.column).sort()).toEqual([...MOVED_COLUMNS].sort());
    expect(MOVED_COLUMNS).toHaveLength(13);
    expect(proof.payloads.every((p) => p.rows === 10 && p.bytes > 1000 && p.sha256.length === 64)).toBe(true);
    expect(proof.tables.some((t) => t.name === "session_meta" && t.rows === 10)).toBe(true);
});

test("migration 103 audit rejects a changed late chunk", () => {
    const [before, after] = movedPair();
    const db = new Database(after);
    db.exec("UPDATE session_meta_chunks SET body=x'636f7272757074' WHERE session_id='text' AND column_name='trailing_blank_decisions' AND chunk=(SELECT MAX(chunk) FROM session_meta_chunks WHERE session_id='text' AND column_name='trailing_blank_decisions' AND chunk!='-1')");
    db.close();
    expect(firstDifference(before, after)).toContain("session_meta.trailing_blank_decisions:");
});

test("migration 103 audit rejects NULL becoming empty cache bytes", () => {
    const [before, after] = movedPair();
    const db = new Database(after);
    db.exec("INSERT OR REPLACE INTO session_render_cache VALUES('null','cached_m0_bytes',x'')");
    db.close();
    expect(firstDifference(before, after)).toContain("session_meta.cached_m0_bytes:");
});

test("migration 103 audit rejects orphan chunks hidden by default reads", () => {
    const [before, after] = movedPair();
    const db = new Database(after);
    db.exec("DELETE FROM session_meta_chunks WHERE session_id='text' AND column_name='trailing_blank_decisions' AND chunk='-1'");
    db.close();
    expect(firstDifference(before, after)).toContain("session_meta.trailing_blank_decisions:");
});
test("migration 103 audit rejects destination rows without an owner", () => {
    const [before, after] = movedPair();
    const db = new Database(after);
    db.exec("INSERT INTO session_render_cache VALUES('missing-owner','cached_m0_bytes',x'01')");
    db.close();
    expect(firstDifference(before, after)).toContain("orphan or unreviewed payload key");
});

test("effects manifest refuses an unreviewed schema head", () => {
    assertEffects(103, 74);
    expect(() => assertEffects(104, 74)).toThrow("manifest needs review");
    expect(() => assertEffects(103, 75)).toThrow("manifest needs review");
});

const crashRecords = () => [
    ...["typescript", "rust"].flatMap((name) => CONTEXT_CRASH_VERSIONS.map((migration) => ({ name, migration, complete: true }))),
    ...STORE_CRASH_VERSIONS.map((migration) => ({ name: "store", migration, complete: true })),
];
test("crash coverage requires context 103 on both implementations", () => {
    assertCrashCoverage(crashRecords());
    expect(() => assertCrashCoverage(crashRecords().filter((r) => r.name !== "typescript" || r.migration !== 103))).toThrow("typescript 103");
    expect(() => assertCrashCoverage(crashRecords().filter((r) => r.name !== "rust" || r.migration !== 103))).toThrow("rust 103");
});
test("crash coverage requires store 74", () => {
    expect(() => assertCrashCoverage(crashRecords().filter((r) => r.name !== "store" || r.migration !== 74))).toThrow("store 74");
});
test("bundle gate requires both load probes", () => {
    assertBundles(["plugin", "pi-plugin"]);
    expect(() => assertBundles(["plugin"])).toThrow("pi-plugin");
});
test("doctor gate rejects warnings and failures", () => {
    const result = {schema:true,integrity:true,foreignKeys:true,shadowBackfills:true,maintenance:true,compartments:true};
    assertDoctor(JSON.stringify(result));
    for (const name of Object.keys(result))
        expect(() => assertDoctor(JSON.stringify({...result,[name]:false}))).toThrow("clean migrated store");
});
test("full doctor target gate rejects test-backstop and missing-store success proxies", () => {
    assertFullDoctorTarget("/isolated/migrated SQLite integrity_check: ok", "/isolated/migrated", "pi");
    expect(() => assertFullDoctorTarget("TEST BACKSTOP /isolated/migrated SQLite integrity_check: ok", "/isolated/migrated", "pi")).toThrow("intended migrated store");
    expect(() => assertFullDoctorTarget("/isolated/migrated Shared context DB not found yet", "/isolated/migrated", "pi")).toThrow("intended migrated store");
});

test("session selection takes largest five and a reproducible disjoint random five", () => {
    const seats = Array.from({length: 20}, (_, i) => ({session: `s${i}`, bytes: i*100}));
    const sample = sampleSessions(seats, "rehearsal-seed");
    expect(sample.largest.map((s) => s.bytes)).toEqual([1900,1800,1700,1600,1500]);
    expect(sample.random).toHaveLength(5);
    expect(new Set([...sample.largest, ...sample.random].map((s) => s.session)).size).toBe(10);
    expect(sample).toEqual(sampleSessions([...seats].reverse(), "rehearsal-seed"));
    expect(() => sampleSessions(seats.slice(0,9))).toThrow("ten distinct");
});
test("real-session coverage requires every selected seat on all three adapters", () => {
    const results = HOSTS.flatMap((host) => ["s1", "s2"].map((session) => ({host, session})));
    assertHostCoverage(["s1", "s2"], results);
    expect(() => assertHostCoverage(["s1", "s2"], results.filter((r) => r.host !== "pi"))).toThrow("pi");
});
test("real-session rendering rejects empty, bypassed and refused adapter results", () => {
    for (const host of HOSTS) {
        assertRendered(host, ["§42§ body"], true, null);
        expect(() => assertRendered(host, [], true, null)).toThrow("non-refused");
        expect(() => assertRendered(host, ["§42§ body"], false, null)).toThrow("non-refused");
        expect(() => assertRendered(host, ["§42§ body"], true, "refused")).toThrow("non-refused");
    }
});
test("tag continuity rejects renumbering, changed identities and an unexecuted importer", () => {
    const before = [{number:42,message:"first:p0",type:"message",owner:null}];
    assertTagContinuity(before, before, "imported");
    expect(() => assertTagContinuity(before, [{...before[0],number:43}], "imported")).toThrow("renumbered");
    expect(() => assertTagContinuity(before, [{...before[0],message:"wrong:p0"}], "imported")).toThrow("identity");
    expect(() => assertTagContinuity(before, before, "missing")).toThrow("first TypeScript pass");
    expect(() => assertTagContinuity([], [], "imported")).toThrow("first TypeScript pass");
});
for (const host of HOSTS) test(`production ${host} adapter executes a stored-session pass`, async () => {
    const [file] = pair();
    const directory = join(file, "..");
    const db = new ProductionDatabase(join(directory, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    const store = new Database(join(directory, "store.db"));
    store.exec("CREATE TABLE mc_tags(session_id TEXT,tag_number INTEGER,block_id TEXT,kind TEXT,created_at_ms INTEGER); INSERT INTO mc_tags VALUES('adapter-session',42,'first#0','message',2000000000000)");
    store.close();
    try {
        const result = await runSessionPass(db, directory, "adapter-session", host, [{info: {id:"first",role:"user",sessionID:"adapter-session"},parts:[{type:"text",text:"Stored session 東京"}]}]);
        expect(JSON.stringify(result.messages)).toMatch(/§\d+§/);
        if (host !== "pi") {
            expect(JSON.stringify(result.messages)).toContain("§42§");
            expect(result.matched).toBe(1);
        }
    } finally { db.close(); }
}, 30000);

test("production database doctor detects a damaged foreign-key relationship", () => {
    const [file] = pair();
    const path = join(file, "..", "context.db");
    const db = new ProductionDatabase(path);
    initializeDatabase(db);
    runMigrations(db);
    expect(() => assertDoctor(JSON.stringify(databaseDoctor(path)))).not.toThrow();
    db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE rehearsal_owner(id INTEGER PRIMARY KEY); CREATE TABLE rehearsal_child(owner INTEGER REFERENCES rehearsal_owner(id)); INSERT INTO rehearsal_child VALUES(99)");
    expect(() => assertDoctor(JSON.stringify(databaseDoctor(path)))).toThrow("clean migrated store");
    db.close();
});

test("migration measurement gate requires each version and a real RSS observation", () => {
    const rows = [["context",96,103],["store",64,74]].flatMap(([database,start,end]) => Array.from({length:Number(end)-Number(start)+1}, (_,i) => ({database:String(database),version:Number(start)+i,seconds:0.1,peakKiB:1000,beforeMainWal:[4096,0],afterMainWal:[8192,0]})));
    assertMigrationMetrics(rows);
    expect(() => assertMigrationMetrics(rows.slice(1))).toThrow("context 96");
    expect(() => assertMigrationMetrics(rows.map((r) => ({...r,peakKiB:0})))).toThrow("measurement");
});
test("prebuilt artifacts reject stale revisions and the wrong architecture", () => {
    const revision = "a".repeat(40);
    const manifest = {candidate: revision, arch: "x64", platform: "linux"};
    assertArtifactIdentity(manifest, revision, "x64");
    expect(() => assertArtifactIdentity(manifest, "b".repeat(40), "x64")).toThrow("mismatch");
    expect(() => assertArtifactIdentity(manifest, revision, "arm64")).toThrow("mismatch");
    expect(() => assertArtifactIdentity({...manifest, platform:"darwin"}, revision, "x64")).toThrow("mismatch");
});
