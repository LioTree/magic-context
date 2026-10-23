import { describe, expect, test } from "bun:test";

import { filesForMode, type ValidationResult, validateModeManifest } from "./validate-mode-manifest";
import { selectManifestRustShard, selectRustShard } from "./select-rust-shard";
import { selectWeightedShard } from "./select-weighted-shard";

/**
 * The live manifest's Rust lane is retired and selects nothing, so shard
 * coverage is checked on a copy whose first twelve entries run in Rust.
 */
function activeRustManifest(): ValidationResult {
    const live = validateModeManifest();
    const entries = live.manifest.entries.map((entry, index) =>
        index < 12 ? { ...entry, invocation: { ...entry.invocation, rust: true } } : entry,
    );
    return { files: live.files, manifest: { schema: 1, header: live.manifest.header, entries } };
}

describe("rust hermetic shard coverage", () => {
    test("the retired manifest selects no Rust files and every shard reports the retired lane", () => {
        const validation = validateModeManifest();
        expect(filesForMode(validation, "rust")).toEqual([]);
        for (let i = 0; i < 4; i += 1) {
            expect(selectManifestRustShard(validation, `${i}/4`)).toEqual({ files: [], retired: true });
        }
    });

    test("an empty Rust list without the retired marker still fails shard selection", () => {
        const live = validateModeManifest();
        const unmarked: ValidationResult = {
            files: live.files,
            manifest: { schema: 1, header: live.manifest.header, entries: live.manifest.entries },
        };
        expect(() => selectManifestRustShard(unmarked, "0/4")).toThrow(/invalid shard/);
    });

    test("four disjoint shards cover an active manifest's rust list exactly once", () => {
        const validation = activeRustManifest();
        const files = filesForMode(validation, "rust");
        expect(files).toHaveLength(12);
        const shards = Array.from({ length: 4 }, (_, i) => selectManifestRustShard(validation, `${i}/4`));
        expect(shards.every((shard) => !shard.retired)).toBe(true);
        const selected = shards.flatMap((shard) => shard.files);
        expect(selected.length).toBe(files.length);
        expect(new Set(selected).size).toBe(files.length);
        expect([...selected].sort()).toEqual(files);
        expect(shards.every((shard) => shard.files.length > 0)).toBe(true);
        for (const entry of validation.manifest.entries) {
            if (!entry.invocation.rust) expect(selected).not.toContain(entry.path);
        }
    });

    test("rejects invalid and empty shard specifications", () => {
        const files = filesForMode(activeRustManifest(), "rust");
        for (const spec of ["", "1", "4/4", "-1/4", "0/0", "0/999", "1/1/1"]) {
            expect(() => selectRustShard(files, spec)).toThrow();
        }
    });

    test("balances by elapsed seconds rather than file count and is input-order independent", () => {
        const files = ["a", "b", "c", "d", "e"];
        const seconds = { a: 100, b: 30, c: 30, d: 20, e: 20 };
        expect(selectWeightedShard(files, "0/2", seconds)).toEqual(["a"]);
        expect(selectWeightedShard(files, "1/2", seconds)).toEqual(["b", "c", "d", "e"]);
        expect(selectWeightedShard([...files].reverse(), "1/2", seconds)).toEqual(["b", "c", "d", "e"]);
    });

    test("new files get the measured median and stale timing entries never become members", () => {
        expect(selectWeightedShard(["known", "new"], "1/2", { known: 10, stale: 100 })).toEqual(["known"]);
        expect(selectWeightedShard(["known", "new"], "0/2", { known: 10, stale: 100 })).toEqual(["new"]);
    });

    test("rejects duplicate inputs and invalid timing data", () => {
        expect(() => selectWeightedShard(["a", "a"], "0/1", { a: 1 })).toThrow();
        const invalid: Record<string, number>[] = [{}, { a: 0 }, { a: -1 }, { a: Number.NaN }];
        for (const seconds of invalid) {
            expect(() => selectWeightedShard(["a"], "0/1", seconds)).toThrow();
        }
    });
});
