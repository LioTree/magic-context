import { describe, expect, test } from "bun:test";
import { databaseFilesFromLsof } from "./host";

// `lsof -p` rows: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME. The root must exist on
// disk because the check compares canonical paths; the repository's own directory serves.
const root = import.meta.dir;
const row = (path: string) => `opencode 123 user 12u REG 1,16 4096 99 ${path}`;

describe("databaseFilesFromLsof", () => {
    test("accepts databases inside the root and reports them relative to it", () => {
        const out = [
            row(`${root}/data/opencode/opencode.db`),
            row(`${root}/data/opencode/opencode.db-wal`),
            row("/usr/lib/libsqlite3.dylib"),
        ].join("\n");
        expect(databaseFilesFromLsof(out, root)).toEqual([
            "<root>/data/opencode/opencode.db",
            "<root>/data/opencode/opencode.db-wal",
        ]);
    });

    test("fails when any database is open outside the root", () => {
        const out = [
            row(`${root}/data/opencode/opencode.db`),
            row("/Users/someone/.local/share/opencode/opencode.db"),
        ].join("\n");
        expect(() => databaseFilesFromLsof(out, root)).toThrow(/outside the root/);
    });

    test("fails on a lookalike prefix of the root", () => {
        expect(() => databaseFilesFromLsof(row(`${root}-other/context.db`), root)).toThrow(
            /outside the root/,
        );
    });

    test("fails closed when no database is open at all", () => {
        expect(() => databaseFilesFromLsof(row("/usr/lib/libsqlite3.dylib"), root)).toThrow(
            /isolation unproven/,
        );
    });
});
