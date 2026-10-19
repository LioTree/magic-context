import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { withTestTempDir } from "./test-temp-dir";

const root = resolve(import.meta.dir, "../../../..");
const generator = resolve(root, "crates/mc-module/gen/gen-standalone-guidance.ts");

// The Rust module's mode-3 guidance must equal what this plugin and the Pi
// plugin put into a standalone session's system prompt. The Rust test reads a
// committed capture of that guidance; this test fails when a plugin change makes
// the capture stale, so the capture is regenerated in the same change.
test("standalone guidance capture for the Rust parity test is current", () => {
    withTestTempDir("standalone-guidance-check-", (scratch) => {
        const result = Bun.spawnSync(["bun", generator, "--check"], {
            cwd: root,
            env: { ...process.env, TMPDIR: scratch },
            stderr: "pipe",
            stdout: "pipe",
            windowsHide: true,
        });
        if (result.exitCode !== 0) {
            throw new Error(`generator --check failed:\n${result.stderr.toString()}`);
        }
        expect(result.stdout.toString()).toContain("standalone guidance fixture is current");
    });
}, 120_000);
