import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { canonicalSchemaSql, schemaFingerprint, schemaSnapshot } from "./schema-fingerprint";
import vectors from "./schema-fingerprint-vectors.json";

function snapshot(sql: string) {
    const db = new Database(":memory:");
    try {
        db.exec(sql);
        return schemaSnapshot(db);
    } finally {
        db.close();
    }
}

describe("shared context schema fingerprint vectors", () => {
    for (const vector of vectors.sql_vectors) {
        test(`quoted and nested declarations: ${vector.sql}`, () => {
            expect(canonicalSchemaSql(vector.sql, true)).toBe(vector.canonical);
        });
    }
    test("column order is not schema identity", () => {
        expect(snapshot(vectors.equivalent)).toEqual(snapshot(vectors.sql));
        expect(schemaFingerprint(snapshot(vectors.equivalent))).toBe(
            schemaFingerprint(snapshot(vectors.sql)),
        );
    });
    for (const [index, vector] of vectors.order_vectors.entries()) {
        test(`declaration history does not change identity: ${index}`, () => {
            expect(snapshot(vector.sql)).toEqual(snapshot(vector.equivalent));
        });
    }
    for (const mutation of vectors.mutations) {
        test(`schema difference is rejected: ${mutation.name}`, () => {
            expect(vectors.sql).toContain(mutation.before);
            expect(
                schemaFingerprint(snapshot(vectors.sql.replace(mutation.before, mutation.after))),
            ).not.toBe(schemaFingerprint(snapshot(vectors.sql)));
        });
    }
});
