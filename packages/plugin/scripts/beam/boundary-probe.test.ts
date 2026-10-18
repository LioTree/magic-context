import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../src/features/magic-context/__tests__/opencode1-query-fixture";
import { Database } from "../../src/shared/sqlite";
import { createTestTempDirFromPath } from "../../src/shared/test-temp-dir";
import type { BoundaryProbeResult } from "./boundary-probe";
import { createRoot, dataDir, rootEnv } from "./host";

test("boundary probe prepares a cold file-backed session beyond the 512-row ordinal limit", () => {
    mkdirSync(dataDir(), { recursive: true });
    const root = createTestTempDirFromPath(join(dataDir(), "boundary-test-"));
    const paths = createRoot(join(root, "scratch"));
    mkdirSync(join(paths.dirs.data, "opencode"), { recursive: true });
    const db = new Database(paths.opencodeDb);
    try {
        db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
        const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
        db.transaction(() => {
            for (let i = 0; i < 600; i++) {
                const id = `msg_${String(i).padStart(8, "0")}`;
                message.run(
                    id,
                    "ses_probe",
                    i,
                    i,
                    JSON.stringify({ role: i % 2 ? "assistant" : "user" }),
                );
                part.run(
                    `prt_${i}`,
                    id,
                    "ses_probe",
                    i,
                    i,
                    JSON.stringify({ type: "text", text: "historical detail ".repeat(100) }),
                );
            }
        })();
    } finally {
        db.close();
    }
    try {
        const result = spawnSync(
            process.execPath,
            [join(import.meta.dir, "boundary-probe.ts"), "ses_probe", "272000", "65"],
            {
                cwd: paths.dirs.work,
                env: rootEnv(paths),
                encoding: "utf8",
                timeout: 30_000,
            },
        );
        expect(result.stderr).not.toContain("RawOrdinalsNotReady");
        expect(result.status).toBe(0);
        const probe = JSON.parse(
            result.stdout.trim().split("\n").at(-1) ?? "",
        ) as BoundaryProbeResult;
        expect(probe.rawMessageCount).toBe(600);
        expect(probe.protectedTailStart).toBeGreaterThan(1);
        expect(probe.messagesToKeep).toBeGreaterThan(0);
        expect(probe.messagesToKeep).toBe(601 - probe.protectedTailStart);
        expect(probe.sessionTokens).toBeGreaterThan(0);
        expect(probe.tailTokens).toBeGreaterThan(0);
        expect(probe.tailTokens).toBeLessThanOrEqual(probe.sessionTokens);
        expect(probe.usagePercentage).toBeCloseTo((probe.sessionTokens / 272000) * 100);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 40_000);
