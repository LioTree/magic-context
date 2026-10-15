import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import parity from "../../../../../../test-vectors/project-identity-parity.json";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { getGitCommonDir, readGitCheckoutMetadata } from "./git-common-dir";
import { isLinkedGitWorktree } from "./project-identity";

let fixture: string;

beforeEach(() => {
    fixture = createTestTempDirFromPath(join(tmpdir(), "mc-common-dir-"));
});

afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
});

function expand(value: string): string {
    return value.replaceAll("<fixture>", fixture);
}

function materialize(name: keyof typeof parity.fixtures): void {
    const layout = parity.fixtures[name];
    for (const repo of layout.repositories) {
        const root = expand(repo.root);
        const gitDir = expand(repo.gitDir);
        mkdirSync(root, { recursive: true });
        mkdirSync(gitDir, { recursive: true });
        if (repo.kind !== "main") {
            writeFileSync(join(root, ".git"), `gitdir: ${relative(root, gitDir)}\n`);
        }
        if (repo.kind === "worktree") {
            writeFileSync(
                join(gitDir, "commondir"),
                `${relative(gitDir, expand(repo.commonDir))}\n`,
            );
        }
    }
    for (const directory of layout.directories) mkdirSync(expand(directory), { recursive: true });
}

describe("file-only canonical git common dir", () => {
    const rows = parity.cases.filter((row) => row.name.startsWith("common-dir-"));
    test.each(rows)("parity: $name", (row) => {
        materialize(row.fixture as keyof typeof parity.fixtures);
        const probe = spyOn(childProcess, "execFileSync");
        try {
            expect(getGitCommonDir(expand(row.directory))).toBe(
                expand(row.expected.gitCommonDir as string),
            );
            const expectedWorktree = row.fixture === "linked-separate";
            expect(readGitCheckoutMetadata(expand(row.directory))?.linkedWorktree).toBe(
                expectedWorktree,
            );
            expect(isLinkedGitWorktree(expand(row.directory))).toBe(expectedWorktree);
            expect(probe).not.toHaveBeenCalled();
        } finally {
            probe.mockRestore();
        }
    });

    test("a separate-git-dir main and its linked worktree have the same common dir", () => {
        materialize("linked-separate");
        const main = getGitCommonDir(join(fixture, "repo"));
        expect(main).toBe(join(fixture, "metadata", "repo.git"));
        expect(getGitCommonDir(join(fixture, "worktree"))).toBe(main);
        expect(isLinkedGitWorktree(join(fixture, "repo"))).toBe(false);
        expect(isLinkedGitWorktree(join(fixture, "worktree"))).toBe(true);
    });

    test("a subfolder finds its checkout root and a submodule does not inherit the parent's common dir", () => {
        materialize("main");
        expect(getGitCommonDir(join(fixture, "repo", "sub"))).toBe(join(fixture, "repo", ".git"));
        materialize("submodule");
        expect(getGitCommonDir(join(fixture, "repo", "sub"))).toBe(
            join(fixture, "repo", ".git", "modules", "sub"),
        );
        expect(isLinkedGitWorktree(join(fixture, "repo", "sub"))).toBe(false);
    });

    test("native realpath resolves symlinks in gitdir and in the queried directory", () => {
        const root = join(fixture, "repo");
        const metadata = join(fixture, "metadata");
        mkdirSync(root);
        mkdirSync(metadata);
        symlinkSync(metadata, join(fixture, "metadata-alias"), "dir");
        symlinkSync(root, join(fixture, "checkout-alias"), "dir");
        writeFileSync(join(root, ".git"), "gitdir: ../metadata-alias\n");
        expect(getGitCommonDir(join(fixture, "checkout-alias"))).toBe(metadata);
        expect(readGitCheckoutMetadata(root)?.checkoutRoot).toBe(root);
    });

    test("absolute gitdir and commondir targets are supported", () => {
        const root = join(fixture, "repo");
        const gitDir = join(fixture, "per-worktree");
        const commonDir = join(fixture, "common");
        mkdirSync(root);
        mkdirSync(gitDir);
        mkdirSync(commonDir);
        writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\r\n`);
        writeFileSync(join(gitDir, "commondir"), `${commonDir}\r\n`);
        expect(getGitCommonDir(root)).toBe(commonDir);
        expect(readGitCheckoutMetadata(root)?.linkedWorktree).toBe(true);
    });

    test("only a regular .git file with commondir marks a linked worktree", () => {
        const root = join(fixture, "repo");
        mkdirSync(join(root, ".git"), { recursive: true });
        writeFileSync(join(root, ".git", "commondir"), "../elsewhere\n");
        expect(readGitCheckoutMetadata(root)?.linkedWorktree).toBe(false);
        rmSync(join(root, ".git"), { recursive: true });
        mkdirSync(join(fixture, "gitdir"));
        writeFileSync(join(root, ".git"), "gitdir: ../gitdir\n");
        expect(readGitCheckoutMetadata(root)?.linkedWorktree).toBe(false);
        writeFileSync(join(fixture, "gitdir", "commondir"), "../missing\n");
        expect(readGitCheckoutMetadata(root)?.linkedWorktree).toBe(true);
        expect(getGitCommonDir(root)).toBeUndefined();
    });

    test("missing, malformed and dangling metadata yield no canonical common dir", () => {
        expect(getGitCommonDir(join(fixture, "missing"))).toBeUndefined();
        expect(getGitCommonDir(fixture)).toBeUndefined();
        writeFileSync(join(fixture, ".git"), "not a gitdir pointer\n");
        expect(getGitCommonDir(fixture)).toBeUndefined();
        writeFileSync(join(fixture, ".git"), "gitdir: missing\n");
        expect(getGitCommonDir(fixture)).toBeUndefined();
    });
});
