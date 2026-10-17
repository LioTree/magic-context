import { resolve } from "node:path";

import { expect, test } from "bun:test";

const root = resolve(import.meta.dir, "../../../..");
const generator = resolve(root, "crates/mc-module/gen/gen-i4-roots-ts-executor-exclusion.ts");

test("i4_roots TypeScript executor reference matches the pinned oracle", () => {
  const result = Bun.spawnSync(["bun", generator, "--check"], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(
    "i4_roots TypeScript executor exclusion reference matches the pinned oracle",
  );
});
