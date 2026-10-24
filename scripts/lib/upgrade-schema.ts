import { Database } from "bun:sqlite";
import { quote } from "./upgrade-audit";

type Column = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number };
type ObjectRow = { type: string; name: string; tbl_name: string; sql: string | null };
type Index = { name: string; unique: number; origin: string; partial: number };
export type SchemaAllowance = { object: string; reason: string; columns: Record<string, string> };

// These are profiles, not name-prefix exemptions: even a known legacy object must
// have exactly the reviewed column/type pairs. Content preservation still audits its rows.
export const LEGACY_TABLES: Record<string, { reason: string; columns: Record<string, string>; sql: string; primaryKey?: string[] }> = {
	recalls: { reason: "Early hosts retained recalled message originals keyed by session and tag.", columns: { tag_id: "INTEGER", session_id: "TEXT", original_content: "TEXT", created_at: "INTEGER" }, sql: "CREATE TABLE recalls(tag_id INTEGER,session_id TEXT,original_content TEXT,created_at INTEGER,PRIMARY KEY(session_id,tag_id))", primaryKey: ["session_id", "tag_id"] },
	session_notes: { reason: "Early hosts persisted session-scoped notes here; upgrades retain their content.", columns: { id: "INTEGER", session_id: "TEXT", content: "TEXT", created_at: "INTEGER" }, sql: "CREATE TABLE session_notes(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL)" },
	session_project_backfill_state: { reason: "The runtime project backfill lazily creates its per-harness lease ledger.", columns: { harness: "TEXT", status: "TEXT", holder_id: "TEXT", started_at: "INTEGER", lease_expires_at: "INTEGER", completed_at: "INTEGER" }, sql: "CREATE TABLE session_project_backfill_state(harness TEXT PRIMARY KEY,status TEXT NOT NULL CHECK (status IN ('running','completed')),started_at INTEGER,lease_expires_at INTEGER,completed_at INTEGER,holder_id TEXT)", primaryKey: ["harness"] },
	mirror_memory_repair_state: { reason: "Older mirror writers persisted a singleton dirty-repair latch.", columns: { id: "INTEGER", dirty: "INTEGER", updated_at: "INTEGER" }, sql: "CREATE TABLE mirror_memory_repair_state(id INTEGER PRIMARY KEY CHECK(id = 1),dirty INTEGER NOT NULL DEFAULT 0 CHECK(dirty IN (0,1)),updated_at INTEGER NOT NULL DEFAULT 0)" },
	sqlite_stat1: { reason: "SQLite ANALYZE owns its untyped planner statistics.", columns: { tbl: "", idx: "", stat: "" }, sql: "CREATE TABLE sqlite_stat1(tbl,idx,stat)" },
	sqlite_stat2: { reason: "Older SQLite ANALYZE versions owned this untyped sample ledger.", columns: { tbl: "", idx: "", sampleno: "", sample: "" }, sql: "CREATE TABLE sqlite_stat2(tbl,idx,sampleno,sample)" },
	sqlite_stat3: { reason: "Older SQLite histogram builds owned these untyped samples.", columns: { tbl: "", idx: "", nEq: "", nLt: "", nDLt: "", sample: "" }, sql: "CREATE TABLE sqlite_stat3(tbl,idx,nEq,nLt,nDLt,sample)" },
	sqlite_stat4: { reason: "STAT4-enabled SQLite ANALYZE owns these untyped histogram samples.", columns: { tbl: "", idx: "", nEq: "", nLt: "", nDLt: "", sample: "" }, sql: "CREATE TABLE sqlite_stat4(tbl,idx,nEq,nLt,nDLt,sample)" },
};
export const LEGACY_COLUMNS: Record<string, { type: string; default: string; reason: string }> = {
	nudge_45: { type: "INTEGER", default: "0", reason: "Retained acknowledgement of the historical 45-percent context nudge." },
	nudge_55: { type: "INTEGER", default: "0", reason: "Retained acknowledgement of the historical 55-percent context nudge." },
	nudge_65: { type: "INTEGER", default: "0", reason: "Retained acknowledgement of the historical 65-percent context nudge." },
	times_65_reached: { type: "INTEGER", default: "0", reason: "Retained count of historical context-threshold encounters." },
	todo_sticky_text: { type: "TEXT", default: "''", reason: "Retained historical sticky to-do reminder text." },
	todo_sticky_message_id: { type: "TEXT", default: "''", reason: "Retained owner message of the historical sticky to-do reminder." },
	last_emergency_drop_through_tag: { type: "INTEGER", default: "0", reason: "Retained tag watermark of the historical emergency context drop." },
};
export const LEGACY_INDEXES: Record<string, { table: string; column: string; reason: string }> = {
	idx_recalls_session: { table: "recalls", column: "session_id", reason: "Historical session-scoped recall lookup index." },
	idx_session_notes_session: { table: "session_notes", column: "session_id", reason: "Historical session-scoped note lookup index." },
	idx_session_meta_session: { table: "session_meta", column: "session_id", reason: "Redundant historical session-id lookup beside the primary key." },
};

function tokens(sql: string): string[] {
	const result: string[] = [];
	const lex = /\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w$]+|[^\s]/gy;
	let match: RegExpExecArray | null;
	while ((match = lex.exec(sql))) {
		const value = match[0];
		if (/^\s|^--|^\/\*/.test(value)) continue;
		if (value.startsWith("'")) result.push(value);
		else if (/^["`\[]/.test(value)) {
			const end = value.startsWith("[") ? "]" : value[0];
			result.push(value.slice(1, -1).replaceAll(end + end, end).toLowerCase());
		} else result.push(value.toLowerCase());
	}
	if (result.at(-1) === ";") result.pop();
	return result;
}

function declarations(sql: string): { prefix: string; parts: string[][]; suffix: string } {
	const all = tokens(sql);
	const start = all.indexOf("(");
	if (start < 0) return { prefix: all.join(" "), parts: [], suffix: "" };
	let depth = 0;
	let part: string[] = [];
	const parts: string[][] = [];
	for (let i = start + 1; i < all.length; i++) {
		const value = all[i];
		if (value === ")" && depth === 0) {
			parts.push(part);
			return { prefix: all.slice(0, start).join(" "), parts, suffix: all.slice(i + 1).join(" ") };
		}
		if (value === "," && depth === 0) { parts.push(part); part = []; }
		else {
			part.push(value);
			if (value === "(") depth++;
			if (value === ")") depth--;
		}
	}
	throw new Error("Unbalanced schema declaration");
}

const declaredType = (type: string) => type.trim().replace(/\s+/g, " ").toUpperCase();
const columns = (db: Database, name: string) => db.query(`PRAGMA table_xinfo(${quote(name)})`).all() as Column[];
const objects = (db: Database) => db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all() as ObjectRow[];
const signature = (column: Column) => JSON.stringify([declaredType(column.type), column.notnull, column.dflt_value === null ? null : tokens(column.dflt_value), column.pk, column.hidden]);

function legacyColumn(table: string, column: string) {
	return table === "session_meta" ? LEGACY_COLUMNS[column] : undefined;
}

function commonColumnAllowance(table: string, fresh: Column, actual: Column): SchemaAllowance | undefined {
	if (table !== "session_meta") return;
	if (fresh.name === "system_prompt_hash" && fresh.notnull === 0 && fresh.pk === 0 && fresh.hidden === 0 && declaredType(fresh.type) === "TEXT" && fresh.dflt_value === "''" &&
		declaredType(actual.type) === "INTEGER" && actual.dflt_value === "0" &&
		signature({ ...actual, type: fresh.type, dflt_value: fresh.dflt_value }) === signature(fresh))
		return { object: `${table}.${fresh.name}`, reason: "storage-meta-shared accepts string or number hashes; storage-meta-persisted binds the historical numeric sentinel unchanged.", columns: { [fresh.name]: "TEXT DEFAULT '' <- INTEGER DEFAULT 0" } };
	if (fresh.name === "thinking_binding_recovery_target" && declaredType(fresh.type) === "TEXT" && fresh.dflt_value === "''" && fresh.pk === 0 && fresh.hidden === 0 && fresh.notnull === 1 && actual.notnull === 0 &&
		signature({ ...actual, notnull: 1 }) === signature(fresh))
		return { object: `${table}.${fresh.name}`, reason: "storage-meta-shared normalizes absent recovery targets; storage-meta-persisted tolerates nullable historical targets.", columns: { [fresh.name]: `${declaredType(fresh.type)} NOT NULL <- ${declaredType(actual.type)} nullable` } };
}

function tableSql(sql: string, name: string, extras: Set<string>, allowances: Set<string>): string {
	const parsed = declarations(sql);
	parsed.parts = parsed.parts.filter((part) => !extras.has(part[0]));
	for (const part of parsed.parts) {
		if (name !== "session_meta" || !allowances.has(part[0])) continue;
		if (part[0] === "system_prompt_hash" && part[1] === "integer") {
			part[1] = "text";
			const at = part.indexOf("default");
			if (part[at + 1] === "0") part[at + 1] = "''";
		}
		if (part[0] === "thinking_binding_recovery_target") {
			const at = part.indexOf("not");
			if (at >= 0 && part[at + 1] === "null") part.splice(at, 2);
		}
	}
	return JSON.stringify([parsed.prefix, parsed.parts.map((part) => part.join(" ")).sort(), parsed.suffix]);
}

function indexShape(db: Database, index: Index): string {
	// Column ordinals and SQLite's autoindex sequence numbers can change after a
	// table rebuild. Compare key roles, sort order and collation here; the later
	// sqlite_master comparison also checks expression text and partial-index predicates.
	const fields = db.query(`PRAGMA index_xinfo(${quote(index.name)})`).all() as { seqno: number; name: string | null; desc: number; coll: string; key: number }[];
	return JSON.stringify([index.unique, index.origin, index.partial, fields.map((field) => [field.seqno, field.name, field.desc, field.coll, field.key])]);
}

/** Require the entire fresh application schema, admitting only reviewed legacy profiles. */
export function assertApplicationSchema(freshPath: string, upgradedPath: string, legacy = true): SchemaAllowance[] {
	const fresh = new Database(freshPath, { readonly: true });
	const actual = new Database(upgradedPath, { readonly: true });
	const used: SchemaAllowance[] = [];
	function fail(message: string): never { throw new Error(`Application schema: ${message}`); }
	try {
		const left = objects(fresh);
		const right = objects(actual);
		for (const table of right.filter((object) => object.type === "table" && !left.some((next) => next.type === "table" && next.name === object.name))) {
			const statistics = ["sqlite_stat1", "sqlite_stat2", "sqlite_stat3", "sqlite_stat4"].includes(table.name);
			const profile = legacy || statistics ? LEGACY_TABLES[table.name] : undefined;
			if (!profile) fail(`unknown extra table ${table.name}`);
			const pairs = columns(actual, table.name).map((column) => [column.name.toLowerCase(), declaredType(column.type)]).sort();
			const reviewed = Object.entries(profile.columns).map(([name, type]) => [name.toLowerCase(), type]).sort();
			if (JSON.stringify(pairs) !== JSON.stringify(reviewed)) fail(`legacy table ${table.name} has unreviewed column/type pairs`);
			if (tableSql(table.sql ?? "", table.name, new Set(), new Set()) !== tableSql(profile.sql, table.name, new Set(), new Set())) fail(`unreviewed legacy table declaration ${table.name}`);
			used.push({ object: table.name, ...profile });
		}
		for (const table of left.filter((object) => object.type === "table")) {
			const next = right.find((object) => object.type === "table" && object.name === table.name);
			if (!next) fail(`missing fresh table ${table.name}`);
			const expected = columns(fresh, table.name);
			const upgraded = columns(actual, table.name);
			const extras = new Set<string>();
			const overrides = new Set<string>();
			for (const column of expected) {
				const other = upgraded.find((candidate) => candidate.name === column.name);
				if (!other) fail(`missing fresh column ${table.name}.${column.name}`);
				if (signature(column) === signature(other)) continue;
				const allowance = legacy ? commonColumnAllowance(table.name, column, other) : undefined;
				if (!allowance) fail(`incompatible column ${table.name}.${column.name}: fresh=${signature(column)} upgraded=${signature(other)}`);
				overrides.add(column.name);
				used.push(allowance);
			}
			for (const column of upgraded.filter((candidate) => !expected.some((old) => old.name === candidate.name))) {
				const profile = legacy ? legacyColumn(table.name, column.name) : undefined;
				if (!profile || signature(column) !== signature({ name: column.name, type: profile.type, notnull: 0, dflt_value: profile.default, pk: 0, hidden: 0 })) fail(`unknown extra column/type ${table.name}.${column.name} ${column.type}`);
				const declaration = declarations(next.sql ?? "").parts.find((part) => part[0] === column.name.toLowerCase());
				if (JSON.stringify(declaration) !== JSON.stringify(tokens(`${column.name} ${profile.type} DEFAULT ${profile.default}`))) fail(`unreviewed legacy column declaration ${table.name}.${column.name}`);
				extras.add(column.name);
				used.push({ object: `${table.name}.${column.name}`, reason: profile.reason, columns: { [column.name]: profile.type } });
			}
			if (tableSql(table.sql ?? "", table.name, new Set(), overrides) !== tableSql(next.sql ?? "", table.name, extras, overrides)) fail(`unreviewed table declaration ${table.name}`);
		}
		for (const table of right.filter((object) => object.type === "table")) {
			const expected = left.some((object) => object.type === "table" && object.name === table.name)
				? fresh.query(`PRAGMA index_list(${quote(table.name)})`).all() as Index[] : [];
			const upgraded = actual.query(`PRAGMA index_list(${quote(table.name)})`).all() as Index[];
			for (const index of expected) {
				const at = upgraded.findIndex((other) => (index.origin === "c" ? other.name === index.name : other.origin === index.origin) && indexShape(fresh, index) === indexShape(actual, other));
				if (at < 0) fail(`missing or incompatible fresh index ${table.name}.${index.name}`);
				upgraded.splice(at, 1);
			}
			for (const index of upgraded) {
				const legacyTable = legacy ? LEGACY_TABLES[table.name] : undefined;
				if (legacyTable?.primaryKey && index.origin === "pk" && index.unique === 1 && index.partial === 0) {
					const fields = actual.query(`PRAGMA index_info(${quote(index.name)})`).all() as { name: string }[];
					if (JSON.stringify(fields.map((field) => field.name)) === JSON.stringify(legacyTable.primaryKey)) continue;
				}
				const profile = legacy ? LEGACY_INDEXES[index.name] : undefined;
				const fields = actual.query(`PRAGMA index_info(${quote(index.name)})`).all() as { name: string }[];
				if (!profile || profile.table !== table.name || index.unique !== 0 || index.partial !== 0 || index.origin !== "c" || fields.length !== 1 || fields[0].name !== profile.column) fail(`unknown extra index ${table.name}.${index.name}`);
				const ddl = right.find((object) => object.type === "index" && object.name === index.name)?.sql ?? "";
				if (JSON.stringify(tokens(ddl)) !== JSON.stringify(tokens(`CREATE INDEX ${index.name} ON ${table.name}(${profile.column})`))) fail(`unreviewed legacy index declaration ${index.name}`);
				used.push({ object: index.name, reason: profile.reason, columns: { [profile.column]: declaredType(columns(actual, table.name).find((column) => column.name === profile.column)!.type) } });
			}
		}
		for (const object of left.filter((row) => row.type !== "table" && row.sql !== null)) {
			const next = right.find((row) => row.type === object.type && row.name === object.name);
			if (!next || tokens(object.sql!).join(" ") !== tokens(next.sql ?? "").join(" ")) fail(`missing or incompatible ${object.type} ${object.name}`);
		}
		for (const object of right.filter((row) => row.type !== "table" && row.sql !== null)) {
			if (left.some((row) => row.type === object.type && row.name === object.name)) continue;
			if (object.type === "index" && used.some((allowance) => allowance.object === object.name)) continue;
			fail(`unknown extra ${object.type} ${object.name}`);
		}
		return used;
	} finally { fresh.close(); actual.close(); }
}
