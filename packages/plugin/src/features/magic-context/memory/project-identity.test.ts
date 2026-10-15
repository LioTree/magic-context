import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    describeUnresolvedProjectIdentity,
    isLinkedGitWorktree,
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
    resolveProjectIdentityStrict,
} from "./project-identity";
import {
    projectDirectoryKey,
    readRememberedProjectIdentity,
    rememberGitIdentity,
} from "./project-identity-cache";

function tempDir(): string {
    return createTestTempDirFromPath(join(tmpdir(), "mc-identity-"));
}

function returningRootCommit(rootCommit: string): typeof execFileSync {
    return (() => `${rootCommit}\n`) as unknown as typeof execFileSync;
}

const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
let storageDir: string;
let testRoot: string;

beforeEach(() => {
    testRoot = tempDir();
    storageDir = join(testRoot, "cortexkit", "magic-context");
    mkdirSync(storageDir, { recursive: true });
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = testRoot;
    process.env.XDG_DATA_HOME = testRoot;
});

afterEach(() => {
    __resetProjectIdentityForTests();
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    rmSync(testRoot, { recursive: true, force: true });
});

describe("linked Git worktree detection", () => {
    test("reads gitdir and commondir files without running git, including from a subfolder", () => {
        const primary = join(storageDir, "primary");
        const linked = join(storageDir, "linked");
        const gitDir = join(primary, ".git", "worktrees", "linked");
        mkdirSync(gitDir, { recursive: true });
        mkdirSync(join(linked, "sub"), { recursive: true });
        writeFileSync(join(linked, ".git"), `gitdir: ${gitDir}\n`);
        writeFileSync(join(gitDir, "commondir"), "../..\n");
        let gitCalls = 0;
        __setProjectIdentityTestHooks({
            execFileSync: (() => {
                gitCalls++;
                return `${gitDir}\n${join(primary, ".git")}\n`;
            }) as unknown as typeof execFileSync,
        });

        expect(isLinkedGitWorktree(primary)).toBe(false);
        expect(isLinkedGitWorktree(linked)).toBe(true);
        expect(isLinkedGitWorktree(join(linked, "sub"))).toBe(true);
        rmSync(join(gitDir, "commondir"));
        expect(isLinkedGitWorktree(linked)).toBe(true);
        expect(gitCalls).toBe(0);
    });

    test.each([
        "unreadable .git file",
        "malformed .git file",
        "missing gitdir target",
        "unreadable gitdir target",
        "unreadable commondir file",
    ])("fails closed for %s without running git", (shape) => {
        const checkout = join(storageDir, "checkout");
        const dotGit = join(checkout, ".git");
        const gitDir = join(storageDir, "metadata");
        const commonFile = join(gitDir, "commondir");
        mkdirSync(checkout);
        writeFileSync(dotGit, `gitdir: ${gitDir}\n`);
        if (shape !== "missing gitdir target") mkdirSync(gitDir);
        if (shape === "malformed .git file") writeFileSync(dotGit, "not a gitdir pointer\n");
        if (shape === "unreadable commondir file") writeFileSync(commonFile, ".\n");
        const permissionDenied = (): NodeJS.ErrnoException =>
            Object.assign(new Error("permission denied"), { code: "EACCES" });
        const originalRead = fs.readFileSync;
        const originalStat = fs.lstatSync;
        let deniedReads = 0;
        const read = spyOn(fs, "readFileSync").mockImplementation(((...args) => {
            if (
                (shape === "unreadable .git file" && args[0] === dotGit) ||
                (shape === "unreadable commondir file" && args[0] === commonFile)
            ) {
                deniedReads++;
                throw permissionDenied();
            }
            return Reflect.apply(originalRead, fs, args);
        }) as typeof fs.readFileSync);
        const stat = spyOn(fs, "lstatSync").mockImplementation(((...args) => {
            if (shape === "unreadable gitdir target" && args[0] === commonFile) {
                deniedReads++;
                throw permissionDenied();
            }
            return Reflect.apply(originalStat, fs, args);
        }) as typeof fs.lstatSync);
        let gitCalls = 0;
        __setProjectIdentityTestHooks({
            execFileSync: (() => {
                gitCalls++;
                return `${gitDir}\n${gitDir}\n`;
            }) as unknown as typeof execFileSync,
        });
        try {
            expect(isLinkedGitWorktree(checkout)).toBe(true);
            expect(gitCalls).toBe(0);
            if (shape.startsWith("unreadable")) expect(deniedReads).toBe(1);
        } finally {
            read.mockRestore();
            stat.mockRestore();
        }
    });

    test("a folder without git metadata is not treated as linked", () => {
        expect(isLinkedGitWorktree(storageDir)).toBe(false);
    });
});

function pin(directory: string, identity = "pj-A"): string {
    const hash = createHash("sha256").update(projectDirectoryKey(directory)).digest("hex");
    const file = join(storageDir, "project-identities", `${hash}.json`);
    mkdirSync(join(storageDir, "project-identities"), { recursive: true });
    writeFileSync(file, JSON.stringify({ directory: projectDirectoryKey(directory), identity }));
    return file;
}

describe("project pin precedence", () => {
    test("pj pin wins over a live git root without a git probe", () => {
        const directory = join(storageDir, "repo");
        mkdirSync(join(directory, ".git"), { recursive: true });
        const file = pin(directory);
        const before = readFileSync(file, "utf8");
        let gitCalls = 0;
        __setProjectIdentityTestHooks({
            execFileSync: (() => {
                gitCalls++;
                return "abc1234\n";
            }) as unknown as typeof execFileSync,
        });
        expect(resolveProjectIdentity(directory)).toBe("pj-A");
        expect(resolveProjectIdentityStrict(directory)).toBe("pj-A");
        expect(resolveProjectIdentityForSession(directory)).toBe("pj-A");
        expect(gitCalls).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(before);
    });

    test("a pj pin wins over process-cached git and directory fallbacks", () => {
        const repo = join(storageDir, "repo");
        const plain = join(storageDir, "plain");
        mkdirSync(join(repo, ".git"), { recursive: true });
        mkdirSync(plain);
        __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
        expect(resolveProjectIdentity(repo)).toBe("git:abc1234");
        expect(resolveProjectIdentity(plain)).toStartWith("dir:");
        pin(repo);
        pin(plain);
        expect(resolveProjectIdentity(repo)).toBe("pj-A");
        expect(resolveProjectIdentity(plain)).toBe("pj-A");
    });

    test("a legacy git sidecar still loses to a live git root", () => {
        const directory = join(storageDir, "repo");
        mkdirSync(join(directory, ".git"), { recursive: true });
        rememberGitIdentity(directory, "git:def5678");
        __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
        expect(resolveProjectIdentity(directory)).toBe("git:abc1234");
    });

    test("a subfolder's legacy git write cannot replace its checkout root's pin", () => {
        const root = join(storageDir, "repo");
        const sub = join(root, "sub");
        mkdirSync(join(root, ".git"), { recursive: true });
        mkdirSync(sub);
        const file = pin(root);
        const before = readFileSync(file, "utf8");
        __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
        expect(resolveProjectIdentity(sub)).toBe("git:abc1234");
        expect(readFileSync(file, "utf8")).toBe(before);
        expect(readRememberedProjectIdentity(sub)?.identity).toBe("git:abc1234");
    });

    test("home and missing-directory eligibility run before a pin can be used", () => {
        const fakeHome = join(storageDir, "home");
        const missing = join(storageDir, "missing");
        mkdirSync(join(fakeHome, ".git"), { recursive: true });
        mkdirSync(join(fakeHome, "sub"));
        pin(fakeHome);
        pin(join(fakeHome, "sub"));
        pin(missing);
        __setProjectIdentityTestHooks({ homeDirectory: () => fakeHome });
        expect(resolveProjectIdentityForSession(fakeHome)).toBeUndefined();
        expect(resolveProjectIdentityForSession(join(fakeHome, "sub"))).toBeUndefined();
        expect(() => resolveProjectIdentityStrict(missing)).toThrow(
            "Unable to access project directory",
        );
        expect(resolveProjectIdentity(missing)).toStartWith("dir:");
        expect(resolveProjectIdentityForSession(missing)).not.toBe("pj-A");
    });
});

describe("resolveProjectIdentity directory fallback", () => {
    test("refuses the exact canonical home directory unless the user opts in", () => {
        expect(resolveProjectIdentityForSession(homedir())).toBeUndefined();
        expect(resolveProjectIdentityForSession(join(homedir(), "a-project"))).not.toBeUndefined();
    });

    // Agents read this text; it must name the home-directory rule and the opt-in,
    // not leave them to guess "no git repo" (which resolves fine).
    test("explains the home-directory refusal with the opt-in", () => {
        const reason = describeUnresolvedProjectIdentity(homedir());
        expect(reason).toContain("home directory");
        expect(reason).toContain("allow_home_project");
        expect(reason).not.toContain("git");
    });

    test("uses the canonical home directory's stable dir identity when opted in", () => {
        const canonicalHome = realpathSync.native(homedir());
        const expected = `dir:${createHash("md5").update(canonicalHome, "utf8").digest("hex").slice(0, 12)}`;

        expect(resolveProjectIdentityForSession(homedir(), true)).toBe(expected);
    });

    test("resolves a project identity when sandbox policy denies realpath for the home directory", () => {
        const project = tempDir();
        const deniedHome = tempDir();
        const originalNative = realpathSync.native;
        const permissionDenied = (): NodeJS.ErrnoException => {
            const error = new Error("sandbox denied realpath") as NodeJS.ErrnoException;
            error.code = "EPERM";
            return error;
        };
        __setProjectIdentityTestHooks({ homeDirectory: () => deniedHome });
        Object.defineProperty(realpathSync, "native", {
            configurable: true,
            value: (() => {
                throw permissionDenied();
            }) as typeof realpathSync.native,
        });

        try {
            const expected = `dir:${createHash("md5")
                .update(project, "utf8")
                .digest("hex")
                .slice(0, 12)}`;
            expect(resolveProjectIdentityForSession(project)).toBe(expected);
        } finally {
            Object.defineProperty(realpathSync, "native", {
                configurable: true,
                value: originalNative,
            });
            rmSync(project, { recursive: true, force: true });
            rmSync(deniedHome, { recursive: true, force: true });
        }
    });

    test("keeps a contained repository distinct from the home identity", () => {
        const contained = createTestTempDirFromPath(join(homedir(), "mc-home-identity-"));
        try {
            mkdirSync(join(contained, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
            const homeIdentity = resolveProjectIdentityForSession(homedir(), true);
            const containedIdentity = resolveProjectIdentityForSession(contained, true);

            expect(homeIdentity).toBeDefined();
            expect(containedIdentity).toBe("git:abc1234");
            expect(containedIdentity).not.toBe(homeIdentity);
        } finally {
            rmSync(contained, { recursive: true, force: true });
        }
    });

    test("requires home opt-in when a child inherits the home git repository", () => {
        const fakeHome = tempDir();
        const child = join(fakeHome, "nested", "project");
        try {
            mkdirSync(join(fakeHome, ".git"));
            mkdirSync(child, { recursive: true });
            __setProjectIdentityTestHooks({
                execFileSync: returningRootCommit("def5678"),
                homeDirectory: () => fakeHome,
            });
            // Opt-in permits memory, not a second identity for the home repository.
            const expectedHomeIdentity = "git:def5678";

            expect(resolveProjectIdentityForSession(fakeHome)).toBeUndefined();
            expect(resolveProjectIdentityForSession(child)).toBeUndefined();
            expect(resolveProjectIdentityForSession(fakeHome, true)).toBe(expectedHomeIdentity);
            expect(resolveProjectIdentityForSession(child, true)).toBe(expectedHomeIdentity);
        } finally {
            rmSync(fakeHome, { recursive: true, force: true });
        }
    });
    test("flips dir: fallback to git: once a repo gains its first commit (no stale cache)", () => {
        const dir = tempDir();
        try {
            const first = resolveProjectIdentity(dir);
            expect(first).toMatch(/^dir:[0-9a-f]{12}$/);
            expect(resolveProjectIdentity(dir)).toBe(first);

            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });

            const second = resolveProjectIdentity(dir);
            expect(second).toBe("git:abc1234");
            expect(second).not.toBe(first);
            expect(resolveProjectIdentity(dir)).toBe(second);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("keeps the remembered git identity for a leftover worktree folder with no git metadata", () => {
        const dir = tempDir();
        const neverResolved = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("fedcba9") });
            expect(resolveProjectIdentity(dir)).toBe("git:fedcba9");

            // A new process sees only the durable sidecar. Removing the worktree's git
            // metadata leaves an empty folder that git no longer recognizes.
            __resetProjectIdentityForTests();
            rmSync(join(dir, ".git"), { recursive: true, force: true });
            expect(resolveProjectIdentity(dir)).toBe("git:fedcba9");
            expect(resolveProjectIdentityForSession(dir)).toBe("git:fedcba9");

            // A plain folder the plugin never resolved to git keeps its directory identity.
            expect(resolveProjectIdentity(neverResolved)).toBe(
                `dir:${createHash("md5").update(neverResolved, "utf8").digest("hex").slice(0, 12)}`,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(neverResolved, { recursive: true, force: true });
        }
    });

    test("derives a deterministic identity from grafted-history repos (multiple root commits)", () => {
        const dir = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            // Repos merged with --allow-unrelated-histories keep several live root
            // commits, and git's enumeration order varies by traversal. The identity
            // must be the lexicographic minimum of the SET, not the first line.
            __setProjectIdentityTestHooks({
                execFileSync: (() =>
                    "7e96b9e\n1e394c2\n4058752\n") as unknown as typeof execFileSync,
            });
            expect(resolveProjectIdentity(dir)).toBe("git:1e394c2");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("reuses a parent repository identity for subdirectory transient git failures", () => {
        const dir = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("def5678") });
            const parentIdentity = resolveProjectIdentity(dir);
            const subdir = join(dir, "nested", "child");
            mkdirSync(subdir, { recursive: true });

            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    throw new Error("temporary git failure");
                }) as unknown as typeof execFileSync,
            });

            expect(resolveProjectIdentity(subdir)).toBe(parentIdentity);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
