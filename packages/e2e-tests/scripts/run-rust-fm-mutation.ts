#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type MutationCase = {
    name: string;
    source: string;
    oldText: string;
    replacement: string;
};

type CommandResult = {
    exit_status: number;
    output: string;
};

const e2eRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(e2eRoot, "../..");
const pluginRoot = resolve(e2eRoot, "../plugin");
const drillFile = (drill: string) => resolve(e2eRoot, `tests/rust-fm-oc-${drill}.test.ts`);
const commandFor = (drill: string) =>
    `bun run build (packages/plugin) && bun test --timeout 600000 --max-concurrency=1 tests/rust-fm-oc-${drill}.test.ts`;

const mutations: Record<string, MutationCase[]> = {
    "5": [
        {
            name: "FM_OC_5_RUNG_SWAP",
            source: drillFile("5"),
            oldText: "h.subc.stopModule();\n            await h.sendPrompt",
            replacement: "h.subc.continueModule();\n            await h.sendPrompt",
        },
        {
            name: "FM_OC_5_RUNG_DELETION",
            source: drillFile("5"),
            oldText: "assertLoudModuleFailure(h, sessionId);",
            replacement: "",
        },
    ],
};

function runBuildAndDrill(drill: string): CommandResult {
    const build = Bun.spawnSync({
        cmd: ["bun", "run", "build"],
        cwd: pluginRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });
    const decoder = new TextDecoder();
    const buildOutput = `${decoder.decode(build.stdout)}${decoder.decode(build.stderr)}`;
    if (build.exitCode !== 0) {
        return { exit_status: build.exitCode, output: buildOutput };
    }
    const test = Bun.spawnSync({
        cmd: [
            "bun",
            "test",
            "--timeout",
            "600000",
            "--max-concurrency=1",
            `tests/rust-fm-oc-${drill}.test.ts`,
        ],
        cwd: e2eRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });
    return {
        exit_status: test.exitCode,
        output: `${buildOutput}${decoder.decode(test.stdout)}${decoder.decode(test.stderr)}`,
    };
}

function applyCase(mutation: MutationCase): { before: string; after: string } {
    const before = readFileSync(mutation.source, "utf8");
    const occurrences = before.split(mutation.oldText).length - 1;
    if (occurrences !== 1) {
        throw new Error(`${mutation.name}: expected one mutation target, found ${occurrences}`);
    }
    const after = before.replace(mutation.oldText, mutation.replacement);
    writeFileSync(mutation.source, after);
    return { before, after };
}

const drill = Bun.argv[2];
if (!drill || !mutations[drill]) {
    console.error("usage: bun scripts/run-rust-fm-mutation.ts 5");
    process.exit(2);
}

const command = commandFor(drill);
const results: Array<Record<string, unknown>> = [];
for (const mutation of mutations[drill]) {
    const { before, after } = applyCase(mutation);
    let observedFailure: CommandResult;
    try {
        observedFailure = runBuildAndDrill(drill);
    } finally {
        writeFileSync(mutation.source, before);
    }

    const revertedRerun = runBuildAndDrill(drill);
    results.push({
        name: mutation.name,
        applied_diff: {
            path: relative(repoRoot, mutation.source),
            before: mutation.oldText,
            after: mutation.replacement,
            changed: before !== after,
        },
        observed_failure: observedFailure,
        reverted_rerun: {
            ...revertedRerun,
            status: revertedRerun.exit_status === 0 ? "pass" : "fail",
        },
        adequacy_finding:
            observedFailure.exit_status === 0
                ? "mutation did not redden the drill; investigate drill adequacy"
                : null,
    });
    if (revertedRerun.exit_status !== 0) {
        throw new Error(`${mutation.name}: reverted rerun did not pass`);
    }
}

const recordPath = resolve(e2eRoot, `mutations/fm-oc-${drill}.json`);
writeFileSync(
    recordPath,
    `${JSON.stringify({ drill: `FM-OC-${drill}`, command, mutations: results }, null, 2)}\n`,
);
console.log(`wrote ${recordPath}`);
