import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findTestStorageLeaks } from "./test-storage-leak-guard";
import { createTestTempDir, installTestTempDirCleanup } from "./test-temp-dir";

installTestTempDirCleanup(afterAll);

describe("test storage leak guard", () => {
    test("accepts the checked-in retrieval capture", () => {
        const captureDirectory = resolve(
            import.meta.dir,
            "../../../../crates/mc-module/testdata/parity_retrieval",
        );
        expect(findTestStorageLeaks(captureDirectory)).toEqual([]);
    });

    test("rejects generated databases and undefined directories, even beside the capture", () => {
        const { dir } = createTestTempDir("storage-leak-guard-");
        const captureDirectory = join(dir, "crates/mc-module/testdata/parity_retrieval");
        mkdirSync(captureDirectory, { recursive: true });
        const leaked = join(captureDirectory, "context.db");
        writeFileSync(leaked, "generated database");
        const undefinedDirectory = join(dir, "undefined");
        mkdirSync(undefinedDirectory);
        expect(findTestStorageLeaks(dir).sort()).toEqual([leaked, undefinedDirectory].sort());
    });
});
