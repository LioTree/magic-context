import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Database } from "bun:sqlite";
import { CANONICAL_DREAM_TASKS } from "../../../packages/plugin/src/features/magic-context/dreamer/task-registry";
import {
    runDueTasksForProject,
    runManualDream,
} from "../../../packages/plugin/src/features/magic-context/dreamer/task-scheduler";

const root = resolve(import.meta.dir, "../../..");
const referencePath = resolve(
    root,
    "crates/mc-module/testdata/i4-roots-ts-executor-exclusion.json",
);

// The reference records behavior pinned to this source revision. Update the
// hashes only after reviewing a deliberate TypeScript behavior change.
const oracleSources = [
    [
        "packages/plugin/src/features/magic-context/dreamer/task-scheduler.ts",
        "c85a1ac93ca8540e4fae828d8426e15961a629c1e78af2b342e6e216b7ea08b7",
    ],
    [
        "packages/plugin/src/features/magic-context/dreamer/task-registry.ts",
        "cdfb1edb7c1ec685cd81945992f2ea8892cfd0ad4042baf72a3c87e3714b18c2",
    ],
] as const;

interface ReferenceOutput {
    success: boolean;
    stdout: string;
    stderr: string;
}

async function assertOracleSourcesArePinned(): Promise<void> {
    for (const [relativePath, expectedHash] of oracleSources) {
        const content = await readFile(resolve(root, relativePath));
        const actualHash = createHash("sha256").update(content).digest("hex");
        if (actualHash !== expectedHash) {
            throw new Error(
                `pinned i4_roots TypeScript oracle changed: ${relativePath} (expected ${expectedHash}, got ${actualHash})`,
            );
        }
    }
}

async function runOracle(): Promise<ReferenceOutput> {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY); INSERT INTO memories DEFAULT VALUES;");

    let executed = 0;
    const deps = {
        db,
        projectIdentity: "git:identity",
        // Rust owns work only per task, from its published list; with every
        // canonical task published, no TS entry point may reach an executor.
        rustOwnedTasks: new Set(CANONICAL_DREAM_TASKS),
        tasks: CANONICAL_DREAM_TASKS.map((task) => ({ task, schedule: "0 3 * * *" })),
        executor: async () => {
            executed++;
            throw new Error("duplicate TS memory-task writer");
        },
    };

    try {
        const dueTasks = await runDueTasksForProject(deps);
        if (dueTasks !== 0) throw new Error("TS due task ran");
        for (const task of CANONICAL_DREAM_TASKS) {
            const result = await runManualDream({ ...deps, task });
            if (result.ran.length || result.failed.length) throw new Error("TS manual task ran");
        }
        if (executed !== 0) throw new Error("TS executor reached insertMemory/runTurnTwo");

        const memoryRows = db.query("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
        return {
            success: true,
            stdout: `TS_EXECUTORS tasks=${executed} memory_rows=${memoryRows.n}\n`,
            stderr: "",
        };
    } finally {
        db.close();
    }
}

async function main(): Promise<void> {
    await assertOracleSourcesArePinned();
    const rendered = `${JSON.stringify(await runOracle(), null, 2)}\n`;
    if (process.argv.includes("--check")) {
        let committed: string;
        try {
            committed = await readFile(referencePath, "utf8");
        } catch (error) {
            throw new Error(`missing i4_roots TypeScript reference ${referencePath}`, { cause: error });
        }
        if (committed !== rendered) {
            throw new Error(
                "i4_roots TypeScript reference drifted; regenerate with bun crates/mc-module/gen/gen-i4-roots-ts-executor-exclusion.ts",
            );
        }
        console.log("i4_roots TypeScript executor exclusion reference matches the pinned oracle");
        return;
    }
    await mkdir(dirname(referencePath), { recursive: true });
    await writeFile(referencePath, rendered);
    console.log(`wrote ${referencePath}`);
}

await main();
