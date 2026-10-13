import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import {
    type CorpusManifest,
    type FileRecord,
    GEMINI_MODEL,
    manifestSchema,
    omissionsFailures,
    readCorpusFile,
    requireStart,
    startFailures,
} from "./core";
import { replayBarFailures } from "./grading";
import { recordedAudit, snapshotCase } from "./recorded";

const directory = dirname(import.meta.path);
const repoRoot = resolve(directory, "../../../..");
const manifestPath = resolve(directory, "corpus-manifest.json");
const command = process.argv[2];

function inventory(root: string, dir = root): FileRecord[] {
    return readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => {
            const path = resolve(dir, entry.name);
            if (entry.isDirectory()) return inventory(root, path);
            if (!entry.isFile())
                throw new Error(`Private inventory refuses symlink or special file: ${path}`);
            return [
                {
                    path: relative(root, path),
                    sha256: new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex"),
                },
            ];
        })
        .sort((a, b) => a.path.localeCompare(b.path));
}

if (command === "hydrate") {
    const corpusRoot = ".cortexkit/private/s10-evidence";
    const root = resolve(repoRoot, corpusRoot);
    const evidence = inventory(root);
    const pick = (path: string) => {
        const file = evidence.find((entry) => entry.path === path);
        if (!file) throw new Error(`Missing supplied evidence: ${path}`);
        return file;
    };
    const read = (file: FileRecord) => readCorpusFile(root, file);
    const cases = [2, 12, 27, 35].map((id) => {
        const prefix = `merge-turn-v6-sonnet/case-${id}-run-1`;
        return snapshotCase(
            id,
            pick(`merge-turn-v6-sonnet/case-${id}-frozen.json`),
            pick(`${prefix}-second.json`),
            evidence.filter((file) => file.path.startsWith(prefix)),
            read,
        );
    });
    const manifest: CorpusManifest = {
        version: 1,
        corpusRoot,
        durablePrivateCopyConfirmed: false,
        models: { gemini: GEMINI_MODEL, deepseek: null },
        cases,
        evidence,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
        `Hydrated ${cases.length}/40 cases and ${evidence.length} private file hashes; one source anchor from the recorded 35:3 citation, no model selected or called.`,
    );
} else if (["preflight", "audit-recorded"].includes(command ?? "")) {
    const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const manifest = manifestSchema.parse(raw);
    const root = resolve(repoRoot, manifest.corpusRoot);
    const read = (file: FileRecord) => readCorpusFile(root, file);
    if (command === "preflight") {
        try {
            requireStart(raw, read);
            console.log("Replay start conditions passed. This tool has no live model transport.");
        } catch (error) {
            console.error(String(error));
            process.exitCode = 2;
        }
    } else {
        // This diagnostic never starts a model replay or authorizes a profile for production writes.
        const omissions: unknown = JSON.parse(
            readFileSync(resolve(directory, "omissions-ledger.json"), "utf8"),
        );
        const audit = {
            ...recordedAudit(manifest, read),
            startFailures: startFailures(raw, read),
            omissionsFailures: omissionsFailures(
                omissions,
                lifecycleTextHash(readFileSync(manifestPath, "utf8")),
                [],
            ),
            acceptanceFailures: replayBarFailures([], null),
        };
        writeFileSync(
            resolve(directory, "recorded-audit.json"),
            `${JSON.stringify(audit, null, 2)}\n`,
        );
        console.log(
            `Audited ${audit.controls.length} recorded controls, ${audit.facts} frozen facts; validated profiles: 0; unmet prerequisites: ${audit.startFailures.length}.`,
        );
        for (const control of audit.controls)
            console.log(
                `${control.control}: ${control.gate} (${control.plannedChecks} check calls)`,
            );
    }
} else {
    console.error(
        "Usage: bun packages/plugin/scripts/memory-lifecycle-replay/run.ts hydrate|preflight|audit-recorded",
    );
    process.exitCode = 2;
}
