import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { MessageLike } from "../transform-operations";
import type { BridgeNativeTarget } from "./bridge-marker";
import type { BridgeReceipt } from "./bridge-receipt";

/** Kill the owner after persisting "unknown" but before the native writer runs.
 * The OS releases its SQLite lease; restart still cannot assume that no cut occurred. */
export function killBridgeMarkerOwner(input: {
    root: string;
    dbPath: string;
    sessionId: string;
    harness: string;
    receipt: BridgeReceipt;
    target: BridgeNativeTarget;
    raw: readonly MessageLike[];
    view: readonly MessageLike[];
}) {
    const script = `
        import { spawnSync } from "node:child_process";
        import { writeFileSync } from "node:fs";
        import { Database } from ${JSON.stringify(new URL("../../../shared/sqlite.ts", import.meta.url).pathname)};
        import { createBridgeReceiptStore } from ${JSON.stringify(new URL("./bridge-marker.ts", import.meta.url).pathname)};
        const p = JSON.parse(process.env.BRIDGE_KILL_PROOF);
        const db = new Database(p.dbPath);
        createBridgeReceiptStore(db, p.sessionId, p.harness).advance({
            receipt: p.receipt, target: p.target, raw: p.raw,
            proveFit: () => ({admissible:true,view:p.view}),
        }, () => {
            const probe = spawnSync("lsof", ["-p", String(process.pid)], {encoding:"utf8",windowsHide:true});
            if (probe.status !== 0) throw new Error(probe.stderr);
            const paths = probe.stdout.split("\\n").filter(l => /\\.db(?:[- ].*)?$/.test(l)).map(l => l.trim().split(/\\s+/).at(-1));
            if (!paths.length || paths.some(path => !path.startsWith(p.root + "/"))) throw new Error("non-isolated database: " + paths);
            writeFileSync(p.root + "/lsof-before-cut.txt", probe.stdout);
            console.log("isolated owner databases: " + paths.join(", "));
            process.kill(process.pid, "SIGKILL");
            return "unknown";
        });
        throw new Error("native writer kill point not reached");
    `;
    return spawnSync(process.execPath, ["--eval", script], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 30_000,
        env: {
            ...process.env,
            BRIDGE_KILL_PROOF: JSON.stringify(input),
            XDG_DATA_HOME: join(input.root, "data"),
            XDG_CONFIG_HOME: join(input.root, "config"),
            XDG_STATE_HOME: join(input.root, "state"),
            XDG_RUNTIME_DIR: join(input.root, "runtime"),
            OPENCODE_DB: join(input.root, "opencode.db"),
            MAGIC_CONTEXT_STORAGE_DIR: input.root,
        },
    });
}
