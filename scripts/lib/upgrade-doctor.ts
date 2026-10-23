import { join } from "node:path";
import { openExistingContextDatabase } from "../../packages/cli/src/lib/database-access";
import { readStorageVersions, checkStorageVersionFence } from "../../packages/cli/src/lib/storage-versions";
import { listShadowBackfillStalls } from "../../packages/plugin/src/features/magic-context/shadow-backfill-state";
import { getDreamerTickFailure } from "../../packages/plugin/src/features/magic-context/dreamer/tick-failure";
import { listUnresolvedCompartments } from "../../packages/cli/src/commands/doctor-store-generation";
import { assertDoctor } from "./upgrade-contract";

export function databaseDoctor(path: string): Record<string, boolean> {
    const db = openExistingContextDatabase(path, {readonly: true});
    if (!db) throw new Error("Doctor found no migrated context database");
    try {
        const versions = readStorageVersions(db);
        const integrity = db.prepare("PRAGMA integrity_check").all() as {integrity_check: string}[];
        return {
            schema: !checkStorageVersionFence(versions).alarm && versions.context_db_schema_version === versions.plugin_supported_version,
            integrity: integrity.length === 1 && integrity[0].integrity_check === "ok",
            foreignKeys: db.prepare("PRAGMA foreign_key_check").all().length === 0,
            shadowBackfills: listShadowBackfillStalls(db).length === 0,
            maintenance: !getDreamerTickFailure(db),
            compartments: listUnresolvedCompartments(db).total === 0,
        };
    } finally { db.close(); }
}

if (import.meta.main) {
    const result = JSON.stringify(databaseDoctor(join(process.argv[2], "context.db")));
    console.log(result);
    assertDoctor(result);
}
