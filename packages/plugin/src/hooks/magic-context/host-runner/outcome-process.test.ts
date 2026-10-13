import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import type { HookOutcome } from "./record";

for (const host of ["v1", "v2"]) {
    test(`OpenCode ${host} SIGKILL between steps replays durable per-subject ops and unavailable identically`, async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-outcome-kill-"));
        const fixture = join(import.meta.dir, "fixtures", "outcome-process.ts");
        const args = [
            process.execPath,
            fixture,
            join(root, "context.db"),
            join(root, "before.json"),
            host,
        ];
        const env = {
            ...process.env,
            HOME: root,
            XDG_DATA_HOME: root,
            XDG_CONFIG_HOME: root,
            MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
        };
        const child = Bun.spawn([...args, "write"], {
            env,
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
        });
        const errors = new Response(child.stderr).text();
        try {
            const reader = child.stdout.getReader();
            let text = "";
            while (!text.includes("READY_TO_KILL")) {
                const next = await reader.read();
                if (next.done) throw new Error(`Fixture exited before readiness: ${await errors}`);
                text += new TextDecoder().decode(next.value);
            }
            child.kill("SIGKILL");
            await child.exited;
            expect(child.signalCode).toBe("SIGKILL");
            const before = JSON.parse(readFileSync(join(root, "before.json"), "utf8"));
            expect(before.view[1].parts[0].text).toBe("FROZEN ops");
            expect(before.view[2].parts[0].text).toBe("unavailable");
            const frozen = before.hooks.flatMap(
                (entry: { hook: { outcomes: HookOutcome[] } }) => entry.hook.outcomes,
            );
            expect(frozen).toEqual(before.observations);
            expect(frozen).toHaveLength(3);
            expect(frozen.map((outcome: HookOutcome) => outcome.subject.hook)).toEqual([
                "pre_user",
                "post_assistant",
                "post_tool",
            ]);
            expect(frozen.slice(1).every((outcome: HookOutcome) => "unavailable" in outcome)).toBe(
                true,
            );
            const replay = Bun.spawn(
                [
                    process.execPath,
                    fixture,
                    join(root, "context.db"),
                    join(root, "after.json"),
                    host,
                    "replay",
                ],
                { env, stdout: "pipe", stderr: "pipe", windowsHide: true },
            );
            const replayErrors = new Response(replay.stderr).text();
            expect(await replay.exited, await replayErrors).toBe(0);
            const after = JSON.parse(readFileSync(join(root, "after.json"), "utf8"));
            expect(after.recovered).toEqual(before.view);
            expect(after.view).toEqual(before.view);
            expect(after.hooks).toEqual(before.hooks);
            expect(after.methods).not.toContain("transform.hook");
            expect(after.methods).not.toContain("transform.declare");
            expect(after.observations).toEqual([]);
        } finally {
            if (child.exitCode === null) child.kill("SIGKILL");
            await child.exited;
            await errors;
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
}
