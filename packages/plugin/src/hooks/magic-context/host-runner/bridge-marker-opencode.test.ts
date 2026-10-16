import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { appendCompartments } from "../../../features/magic-context/compartment-storage";
import { runMigrations } from "../../../features/magic-context/migrations";
import { initializeDatabase } from "../../../features/magic-context/storage-db";
import { getPersistedCompactionMarkerState } from "../../../features/magic-context/storage-meta-persisted";
import { _resetHarnessForTesting, setHarness } from "../../../shared/harness";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import {
    applyDeferredCompactionMarker,
    closeCompactionMarkerConnection,
} from "../compaction-marker-manager";
import type { MessageLike } from "../transform-operations";
import { createBridgeReceiptStore } from "./bridge-marker";
import { killBridgeMarkerOwner } from "./bridge-marker-test-support";
import { bridgeReceipt } from "./bridge-receipt";
import { createRecord } from "./record";

const cleanups: (() => void)[] = [];
afterEach(() => {
    closeCompactionMarkerConnection();
    _resetHarnessForTesting();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// The crash probe requires POSIX SIGKILL and lsof; admission tests run on every platform.
test.skipIf(process.platform === "win32")(
    "OpenCode kill after receipt persistence recovers the pending native cut",
    () => {
        const scratch = createTestTempDir("bridge-opencode-kill-");
        cleanups.push(scratch.cleanup);
        const previous = process.env.OPENCODE_DB;
        process.env.OPENCODE_DB = join(scratch.dir, "opencode.db");
        cleanups.push(() => {
            if (previous === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = previous;
        });
        setHarness("opencode");
        const host = new Database(process.env.OPENCODE_DB);
        cleanups.push(() => host.close());
        host.exec(
            "CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)",
        );
        const raw = ["m1", "m2"].map(
            (id) =>
                ({
                    info: { id, role: "user" },
                    parts: [{ id: `${id}-text`, type: "text", text: id }],
                }) as MessageLike,
        );
        for (const [i, m] of raw.entries()) {
            host.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(
                m.info.id!,
                "session",
                i + 1,
                i + 1,
                JSON.stringify(m.info),
            );
            host.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(
                `${m.info.id}-text`,
                m.info.id!,
                "session",
                i + 1,
                i + 1,
                JSON.stringify(m.parts[0]),
            );
        }
        const dbPath = join(scratch.dir, "context.db");
        const db = new Database(dbPath);
        cleanups.push(() => db.close());
        initializeDatabase(db);
        runMigrations(db);
        appendCompartments(db, "session", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "m1",
                endMessageId: "m1",
                title: "covered",
                content: "covered",
            },
        ]);
        const record = createRecord({
            lineage_id: "lineage",
            plan: {},
            initial: {
                compaction_id: "covering",
                version: 1,
                range: { from: 0, to: 1 },
                replacement: raw,
            },
        });
        record.view.coverage = { end_mid: "m1", ordinal: 1 };
        const store = createBridgeReceiptStore(db, "session", "opencode");
        const pending = store.publish(bridgeReceipt(record), raw, 2);
        const receipt = store.complete(pending.request_id, { status: 200, cleanEnd: true })!;
        const target = { end_mid: "m1", ordinal: 1 };
        const killed = killBridgeMarkerOwner({
            root: scratch.dir,
            dbPath,
            sessionId: "session",
            harness: "opencode",
            receipt,
            target,
            raw,
            view: raw,
        });
        expect(killed.stderr).toBe("");
        expect(killed.signal).toBe("SIGKILL");
        expect(killed.stdout).toContain("isolated owner databases:");
        console.log(killed.stdout.trim());
        expect(getPersistedCompactionMarkerState(db, "session")).toBeNull();
        const restarted = createBridgeReceiptStore(db, "session", "opencode");
        expect(
            restarted.advance(
                { receipt, target, raw, proveFit: () => ({ admissible: false }) },
                () => "applied",
            ).kind,
        ).toBe("unknown");
        let loseCommitReply = true;
        const advance = () =>
            restarted.advance(
                { receipt, target, raw, proveFit: () => ({ admissible: true, view: raw }) },
                () => {
                    const result = applyDeferredCompactionMarker(db, "session", {
                        ordinal: 1,
                        endMessageId: "m1",
                        publishedAt: 1,
                    });
                    if (result.kind === "applied" && loseCommitReply) {
                        loseCommitReply = false;
                        throw new Error(
                            "host committed before receipt owner lost its write result",
                        );
                    }
                    return result.kind === "applied" || result.kind === "already-current"
                        ? "applied"
                        : "unknown";
                },
            );
        expect(advance().kind).toBe("unknown");
        expect(getPersistedCompactionMarkerState(db, "session")).toBeNull();
        expect(advance().kind).toBe("applied");
        expect(getPersistedCompactionMarkerState(db, "session")?.targetEndMessageId).toBe("m1");
        expect(
            host
                .prepare("SELECT count(*) AS n FROM message WHERE json_extract(data,'$.summary')=1")
                .get(),
        ).toEqual({ n: 1 });
    },
);
