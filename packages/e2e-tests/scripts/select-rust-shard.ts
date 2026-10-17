#!/usr/bin/env bun

import {
    emptyRustSelectionAllowed,
    filesForMode,
    RUST_LANE_RETIRED_MESSAGE,
    type ValidationResult,
    validateModeManifest,
} from "./validate-mode-manifest";
import durations from "./shard-durations.json";
import { selectWeightedShard } from "./select-weighted-shard";

/** The validated manifest owns membership; historical timings only affect assignment. */
export function selectRustShard(files: string[], spec: string): string[] {
    return selectWeightedShard(files, spec, durations.seconds.rust);
}

/**
 * Select one shard of the manifest's Rust list. A retired Rust lane has no
 * files, so every shard is empty and `retired` is true; an empty list without
 * the retired marker still throws through `selectRustShard`.
 */
export function selectManifestRustShard(
    validation: ValidationResult,
    spec: string,
): { files: string[]; retired: boolean } {
    const files = filesForMode(validation, "rust");
    if (emptyRustSelectionAllowed(validation, files)) return { files: [], retired: true };
    return { files: selectRustShard(files, spec), retired: false };
}

if (import.meta.main) {
    try {
        const spec = process.argv[2];
        if (!spec || process.argv.length !== 3) throw new Error("usage: select-rust-shard.ts i/n");
        const shard = selectManifestRustShard(validateModeManifest(), spec);
        // stdout carries only file paths; the hermetic runner reads it as the selection.
        if (shard.retired) console.error(RUST_LANE_RETIRED_MESSAGE);
        for (const path of shard.files) console.log(path);
    } catch (error) {
        console.error(String(error));
        process.exit(1);
    }
}
