import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overlay = mkdtempSync(join(tmpdir(), "resident-review-rust-"));
for (const file of ["Cargo.toml", "Cargo.lock"]) copyFileSync(join(root, file), join(overlay, file));
for (const name of ["packages", "tests", "docs", "assets", "scripts", "testdata"]) symlinkSync(join(root, name), join(overlay, name));
mkdirSync(join(overlay, "crates"));
for (const crate of ["mc-core", "mc-tokenizer"]) symlinkSync(join(root, "crates", crate), join(overlay, "crates", crate));
function linkTree(source: string, target: string, overrides: Map<string, string>) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
        const from = join(source, entry.name), to = join(target, entry.name);
        if (overrides.has(from)) {
            writeFileSync(to, readFileSync(from, "utf8") + `\ninclude!(${JSON.stringify(overrides.get(from))});\n`);
        } else if (entry.isDirectory() && [...overrides.keys()].some(path => path.startsWith(from + "/"))) {
            linkTree(from, to, overrides);
        } else symlinkSync(from, to);
    }
}
linkTree(join(root, "crates/mc-store"), join(overlay, "crates/mc-store"), new Map([[join(root, "crates/mc-store/src/provider_v2_tests.rs"), join(root, "review-tests/store_stage2.rs")]]));
linkTree(join(root, "crates/mc-module"), join(overlay, "crates/mc-module"), new Map([[join(root, "crates/mc-module/src/providers/resident_policy_tests.rs"), join(root, "review-tests/resident_policy_stage2.rs")]]));
console.log(`Bun ${Bun.version}; ${spawnSync("cargo", ["--version"], { encoding: "utf8" }).stdout.trim()}`);
const selected = Bun.argv[2] ?? "all";
let failed = false;
for (const crate of selected === "all" ? ["mc-store", "mc-module"] : [selected]) {
    const filter = Bun.argv[3] ?? (crate === "mc-store" ? "provider_v2_tests::review_" : "providers::policy_summary::resident_policy::tests::review_");
    const run = spawnSync("cargo", ["test", "--locked", "-p", crate, "--lib", filter, "--", "--nocapture"], {
        cwd: overlay,
        env: { ...process.env, CARGO_TARGET_DIR: join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "resident-review-rust"), CARGO_PROFILE_TEST_OPT_LEVEL: "3" },
        encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    process.stdout.write(run.stdout); process.stderr.write(run.stderr);
    assert.match(run.stdout, /running [1-9]\d* tests/, "Rust review filter must execute tests");
    failed ||= run.status !== 0;
}
if (failed) process.exitCode = 1;
