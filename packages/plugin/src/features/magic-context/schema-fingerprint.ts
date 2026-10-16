import { createHash } from "node:crypto";
import type { Database } from "../../shared/sqlite";
import definition from "./schema-fingerprint-definition.json";

type Cell = string | number | null | Cell[];
const compareText = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export interface TableSnapshot {
    name: string;
    columns: Cell[][];
    indexes: Cell[][];
    foreign_keys: Cell[][];
}
export interface SchemaSnapshot {
    user_version: number;
    migrations: Cell[][];
    master: Cell[][];
    tables: TableSnapshot[];
}

// Keep quoted text opaque while normalizing formatting and sorting only the
// outer CREATE TABLE declarations. Nested commas belong to expressions or keys.
export function canonicalSchemaSql(sql: string, table: boolean): string {
    const parts: string[] = [];
    let out = "";
    let quote = "";
    let space = false;
    let depth = 0;
    let prefix = "";
    let suffix = "";
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (quote) {
            out += ch;
            if (ch === quote) {
                if (quote !== "]" && sql[i + 1] === quote) out += sql[++i];
                else quote = "";
            }
            continue;
        }
        if (ch === "-" && sql[i + 1] === "-") {
            while (i + 1 < sql.length && sql[i + 1] !== "\n") i++;
            space = true;
            continue;
        }
        if (ch === "/" && sql[i + 1] === "*") {
            i += 2;
            while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
            i++;
            space = true;
            continue;
        }
        if (/\s/.test(ch)) {
            space = true;
            continue;
        }
        if (space && out && !out.endsWith("(") && !out.endsWith(",") && !"(),".includes(ch))
            out += " ";
        space = false;
        if ("'\"`[".includes(ch)) quote = ch === "[" ? "]" : ch;
        if (table && ch === "(") {
            if (depth++ === 0) {
                prefix = `${out}(`;
                out = "";
                continue;
            }
        } else if (table && ch === ")") {
            if (--depth === 0) {
                parts.push(out);
                out = "";
                suffix = ")";
                continue;
            }
        } else if (table && ch === "," && depth === 1) {
            parts.push(out);
            out = "";
            continue;
        }
        out += ch;
    }
    return prefix
        ? prefix + parts.sort(compareText).join(",") + suffix + (out ? ` ${out}` : "")
        : out;
}

function rows(db: Database, sql: string, name?: string): Cell[][] {
    const statement = db.prepare(sql);
    const result = name === undefined ? statement.all() : statement.all(name);
    return (result as Record<string, Cell>[]).map((row) => Object.values(row));
}

export function schemaSnapshot(db: Database): SchemaSnapshot {
    const master = rows(db, definition.master);
    const implicitIndexes = new Map<string, string>();
    const tables = master
        .filter((row) => row[0] === "table")
        .map((row) => {
            const name = row[1] as string;
            const indexes = rows(db, definition.indexes, name)
                .map((index) => {
                    const columns = rows(db, definition.index_columns, index[0] as string);
                    if (index[2] !== "c") {
                        const identity = `${index[2]}:${JSON.stringify(columns)}`;
                        implicitIndexes.set(index[0] as string, identity);
                        index[0] = identity;
                    }
                    return [...index, columns];
                })
                .sort((a, b) => compareText(a[0] as string, b[0] as string));
            const foreignKeys = new Map<Cell, Cell[][]>();
            for (const [id, ...key] of rows(db, definition.foreign_keys, name)) {
                const group = foreignKeys.get(id) ?? [];
                group.push(key);
                foreignKeys.set(id, group);
            }
            return {
                name,
                columns: rows(db, definition.columns, name),
                indexes,
                foreign_keys: [...foreignKeys.values()].sort((a, b) =>
                    compareText(JSON.stringify(a), JSON.stringify(b)),
                ),
            };
        });
    for (const row of master) {
        const identity = row[0] === "index" ? implicitIndexes.get(row[1] as string) : undefined;
        if (identity !== undefined) row[1] = identity;
        if (typeof row[3] === "string") row[3] = canonicalSchemaSql(row[3], row[0] === "table");
    }
    master.sort(
        (a, b) =>
            compareText(a[0] as string, b[0] as string) ||
            compareText(a[1] as string, b[1] as string) ||
            compareText(a[2] as string, b[2] as string),
    );
    return {
        user_version: (db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
        migrations: rows(db, definition.migrations),
        master,
        tables,
    };
}

export function schemaFingerprint(snapshot: SchemaSnapshot): string {
    const canonical = (value: unknown): unknown =>
        Array.isArray(value)
            ? value.map(canonical)
            : value !== null && typeof value === "object"
              ? Object.fromEntries(
                    Object.entries(value)
                        .sort(([a], [b]) => compareText(a, b))
                        .map(([k, v]) => [k, canonical(v)]),
                )
              : value;
    return createHash("sha256")
        .update(JSON.stringify(canonical(snapshot)))
        .digest("hex");
}
