import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import parity from "../../../../../../test-vectors/project-identity-parity.json";
import enumerateVectors from "../../../../../../test-vectors/project-resolve-v1/enumerate.json";
import resolveVectors from "../../../../../../test-vectors/project-resolve-v1/resolve.json";
import projectIdVectors from "../../../../../../test-vectors/project-resolve-v1/resolve-project-id.json";

const upstreamCommit = "abf7a13fe941e6fbde3a561a12f6e1e7fb5b70a7";
const vectorDirectory = new URL(
    "../../../../../../test-vectors/project-resolve-v1/",
    import.meta.url,
);
const projectIdPattern = /^pj-[A-Za-z0-9_-]+$/;

// These digests pin the original bytes independently of the vendored checksum file.
const upstreamHashes = {
    "README.md": "a9afb8b4cc535cce9725383d1b6c8c746604a0973970cb105bd93ad48d613d42",
    SHA256SUMS: "bb865c8244192455cf5b4547c618edf740e7d649d3caf3ffc1b7920c28a27c94",
    "enumerate.json": "89afedb88fa4ddec219f4932df22f26ca8395022c5c1dd399e3e50c9d50b94dd",
    "resolve-project-id.json": "4af3d3d6dd6b279146da2e50dd48dd507674f2806f6ac35e8f04b380bc5e901e",
    "resolve.json": "a15d8e09bf4e5ee852097ee423c33e5feca8bff205797c01394d8667a9596bce",
};

interface Sidecar {
    directory: string;
    identity: string;
    gitCommonDir?: string;
}

interface ParityCase {
    name: string;
    fixture: string;
    directory: string;
    answer:
        | string
        | {
              file: string;
              caseIndex: number;
              replaceStrings: Record<string, string>;
              mutations?: { path: string[]; value: string | number | boolean | null }[];
          };
    sidecars: Sidecar[];
    expected: {
        identity: string | null;
        gitCommonDir: string | null;
        canonicalRoot?: string;
        errorClass?: string;
        sidecarWrites: Sidecar[];
        resolveCalls?: number;
        resolveLogs?: number;
        gitProbeCalls?: number;
        sidecarBytesUnchanged?: boolean;
        ignoredImplicitSidecarLogs?: number;
        commonDirConflictLogs?: number;
    };
}

const cases: ParityCase[] = parity.cases;

function object(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Expected a JSON object");
    }
    return value as Record<string, unknown>;
}

function visit(value: unknown, field: (key: string, value: unknown) => void): void {
    if (Array.isArray(value)) {
        for (const item of value) visit(item, field);
    } else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            field(key, child);
            visit(child, field);
        }
    }
}

function replaceStrings(value: unknown, replacements: Record<string, string>): unknown {
    if (typeof value === "string") return replacements[value] ?? value;
    if (Array.isArray(value)) return value.map((item) => replaceStrings(item, replacements));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, replaceStrings(child, replacements)]),
        );
    }
    return value;
}

function vectorFor(row: ParityCase): unknown {
    if (typeof row.answer === "string") return undefined;
    expect(row.answer.file).toBe("resolve.json");
    const source = resolveVectors[row.answer.caseIndex];
    expect(source).toBeDefined();
    const vector = replaceStrings(source, row.answer.replaceStrings);
    for (const mutation of row.answer.mutations ?? []) {
        expect(mutation.path.length).toBeGreaterThanOrEqual(2);
        let target = object(vector);
        for (const key of mutation.path.slice(0, -1)) target = object(target[key]);
        const lastKey = mutation.path.at(-1);
        if (!lastKey) throw new Error("Mutation path must name a field");
        target[lastKey] = mutation.value;
    }
    return vector;
}

function namedCase(name: string): ParityCase {
    const row = cases.find((candidate) => candidate.name === name);
    if (!row) throw new Error(`Missing parity case: ${name}`);
    return row;
}

describe("vendored project resolution vectors", () => {
    test("preserves every pinned upstream file byte for byte", () => {
        for (const [name, expectedHash] of Object.entries(upstreamHashes)) {
            const bytes = readFileSync(new URL(name, vectorDirectory));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedHash);
        }
        const upstream = readFileSync(new URL("UPSTREAM", vectorDirectory), "utf8");
        expect(upstream.split("\n")[0]).toBe(`entorhinal ${upstreamCommit}`);
        expect(upstream).toContain("test-vectors/project-resolve-v1/");
    });

    test("every vendored projectId matches the durable id grammar", () => {
        let count = 0;
        for (const vectors of [resolveVectors, projectIdVectors, enumerateVectors]) {
            visit(vectors, (key, value) => {
                if (key !== "projectId") return;
                expect(typeof value).toBe("string");
                expect(value).toMatch(projectIdPattern);
                count++;
            });
        }
        expect(count).toBe(13);
    });

    test("contains the six served resolve cases and exact malformed-request refusal", () => {
        expect(resolveVectors).toHaveLength(6);
        expect(resolveVectors.map((vector) => vector.request.method)).toEqual(
            Array(6).fill("resolve"),
        );
        expect(resolveVectors.slice(0, 5).map((vector) => vector.reply.result?.via)).toEqual([
            "root",
            "walk",
            "worktree",
            "implicit",
            "root",
        ]);
        const worktree = object(resolveVectors[2].reply.result);
        expect(worktree.worktreeOf).toBe("/fixture/root-checkout");
        for (const key of ["rootRecords", "matchedRoot", "sourceRoot", "bindingStatus"]) {
            expect(worktree).not.toHaveProperty(key);
        }
        expect(resolveVectors[4].reply.result?.gone).toBe(true);
        expect(resolveVectors[5].request.params).not.toHaveProperty("canonicalRoot");
        expect(resolveVectors[5].reply.code).toBe("invalid_params");
        expect(resolveVectors[5].reply.message).toBe("missing field `canonicalRoot`");
        expect(resolveVectors[5].reply.detail).toBeNull();
    });

    test("contains current, alias and gone id lookups and two named projects", () => {
        expect(projectIdVectors.map((vector) => vector.reply.result.via)).toEqual([
            "current",
            "alias",
            "gone",
        ]);
        expect(projectIdVectors[2].reply.result.gone).toBe(true);
        expect(enumerateVectors).toHaveLength(1);
        expect(enumerateVectors[0].reply.result.projects.map((project) => project.name)).toEqual([
            "Editor",
            "Terminal",
        ]);
    });
});

describe("shared project identity parity table", () => {
    test("pins a reproducible git root commit and distinct case names", () => {
        expect(parity.version).toBe(1);
        const content = Buffer.from(parity.gitCommit, "utf8");
        const hash = createHash("sha1")
            .update(`commit ${content.length}\0`)
            .update(content)
            .digest("hex");
        expect(hash).toBe(parity.gitRootCommit);
        expect(cases.length).toBeGreaterThanOrEqual(30);
        expect(new Set(cases.map((row) => row.name)).size).toBe(cases.length);
    });

    for (const row of cases) {
        test(`${row.name}: has a relocatable fixture, vector answer and explicit expectations`, () => {
            expect(parity.fixtures).toHaveProperty(row.fixture);
            expect(row.directory).toStartWith("<fixture>/");
            if (row.expected.errorClass) {
                expect(row.expected.identity).toBeNull();
                expect(row.expected.gitCommonDir).toBeNull();
                expect(row.expected.resolveCalls).toBe(0);
                expect(row.expected.sidecarWrites).toEqual([]);
            } else {
                expect(row.expected.gitCommonDir).toStartWith("<fixture>/");
                expect(row.expected.identity).toMatch(/^(pj-[A-Za-z0-9_-]+|git:[a-f0-9]{40})$/);
                expect(row.expected.identity).not.toStartWith("pj-implicit1-");
            }
            expect(Array.isArray(row.sidecars)).toBe(true);
            expect(Array.isArray(row.expected.sidecarWrites)).toBe(true);
            for (const sidecar of [...row.sidecars, ...row.expected.sidecarWrites]) {
                expect(sidecar.directory).toStartWith("<fixture>/");
                if (sidecar.gitCommonDir) {
                    expect(sidecar.gitCommonDir).toStartWith("<fixture>/");
                }
            }
            for (const write of row.expected.sidecarWrites) {
                expect(write.identity).not.toStartWith("pj-implicit1-");
                expect(write.identity).toBe(row.expected.identity);
            }
            if (typeof row.answer === "string") {
                expect(["absent", "not_answering"]).toContain(row.answer);
            } else {
                const vector = object(vectorFor(row));
                const request = object(vector.request);
                const reply = object(vector.reply);
                if (reply.result) {
                    const result = object(reply.result);
                    expect(object(request.params).canonicalRoot).toBe(row.directory);
                    expect(result.canonicalRoot).toBe(row.expected.canonicalRoot ?? row.directory);
                } else {
                    expect(reply.code).toMatch(/^(invalid_params|storage_unavailable)$/);
                }
                visit(vector, (_key, value) => {
                    if (typeof value === "string" && value.startsWith("/")) {
                        expect(value).toStartWith("<fixture>/");
                    }
                });
            }
        });
    }

    test("root, subfolder and linked worktree share a project without pinning the worktree", () => {
        const rows = ["registered-root", "registered-subfolder", "registered-linked-worktree"].map(
            namedCase,
        );
        expect(rows.map((row) => row.expected.identity)).toEqual(Array(3).fill("pj-resolve-root"));
        expect(rows[0].expected.sidecarWrites.map((write) => write.directory)).toEqual([
            "<fixture>/repo",
        ]);
        expect(rows[1].expected.sidecarWrites.map((write) => write.directory)).toEqual([
            "<fixture>/repo/sub",
        ]);
        expect(rows[2].expected.sidecarWrites).toEqual([]);
    });

    test("nested registrations pin only the subfolder with or without a parent pin", () => {
        for (const name of [
            "nested-registration-without-parent-pin",
            "nested-registration-with-parent-pin",
        ]) {
            const row = namedCase(name);
            expect(row.expected.identity).toBe("pj-B");
            expect(row.expected.sidecarWrites.map((write) => write.directory)).toEqual([
                "<fixture>/repo/sub",
            ]);
            expect(object(object(object(vectorFor(row)).reply).result).canonicalRoot).toBe(
                "<fixture>/repo/sub",
            );
        }
        expect(namedCase("nested-registration-without-parent-pin").sidecars).toEqual([]);
        const parentPin = namedCase("nested-registration-with-parent-pin").sidecars;
        expect(parentPin).toHaveLength(1);
        expect(parentPin[0].directory).toBe("<fixture>/repo");
        expect(parentPin[0].identity).toBe("pj-A");
    });

    test("common-dir layouts distinguish separate git dirs, worktrees and submodules", () => {
        const expectedDirs = [
            ["common-dir-main", "<fixture>/repo/.git"],
            ["common-dir-separate-main", "<fixture>/metadata/repo.git"],
            ["common-dir-separate-linked-worktree", "<fixture>/metadata/repo.git"],
            ["common-dir-submodule", "<fixture>/repo/.git/modules/sub"],
        ];
        for (const [name, commonDir] of expectedDirs) {
            expect(namedCase(name).expected.gitCommonDir).toBe(commonDir);
        }
        visit(parity.fixtures, (key, value) => {
            if (["root", "mainRoot", "gitDir", "commonDir"].includes(key)) {
                expect(value).toStartWith("<fixture>/");
            }
        });
    });

    test("common-dir matches write nothing and conflicting project pins fall back", () => {
        for (const name of [
            "single-common-dir-pin-not-answering",
            "single-common-dir-pin-implicit-worktree",
            "single-common-dir-pin-implicit-subfolder",
            "single-common-dir-pin-not-answering-subfolder",
            "duplicate-common-dir-pins-same-identity",
        ]) {
            const row = namedCase(name);
            expect(row.expected.identity).toBe("pj-A");
            expect(row.expected.sidecarWrites).toEqual([]);
            for (const pin of row.sidecars) {
                expect(pin.gitCommonDir).toBe(row.expected.gitCommonDir);
            }
        }
        const conflict = namedCase("conflicting-common-dir-pins");
        expect(conflict.sidecars).toHaveLength(2);
        expect(new Set(conflict.sidecars.map((pin) => pin.identity)).size).toBe(2);
        for (const pin of conflict.sidecars) {
            expect(pin.gitCommonDir).toBe(conflict.expected.gitCommonDir);
        }
        expect(conflict.expected.identity).toBe(`git:${parity.gitRootCommit}`);
        expect(conflict.expected.commonDirConflictLogs).toBe(1);
    });

    test("implicit ids are ignored and exact pins prevent resolve calls", () => {
        const implicit = namedCase("implicit-sidecar-is-ignored");
        expect(implicit.sidecars[0].identity).toStartWith("pj-implicit1-");
        expect(implicit.expected.identity).toBe(`git:${parity.gitRootCommit}`);
        expect(implicit.expected.ignoredImplicitSidecarLogs).toBe(1);
        for (const name of [
            "pin-is-total-over-registered-answer",
            "pin-is-total-over-implicit-answer",
        ]) {
            const row = namedCase(name);
            expect(row.expected.identity).toBe("pj-A");
            expect(row.expected.resolveCalls).toBe(0);
            expect(row.expected.sidecarWrites).toEqual([]);
        }
    });

    test("includes every tolerant-reader, error, pin-writing and eligibility row by name", () => {
        const names = cases.map((row) => row.name);
        for (const name of [
            "tolerant-reader-unknown-via",
            "tolerant-reader-extra-field",
            "tolerant-reader-decode-failure",
            "error-invalid-params",
            "error-storage-unavailable",
            "legacy-git-record-replaced-by-live-project-pin",
            "pj-pin-preserves-sidecar-bytes",
            "walk-subfolder-canonical-root-equals-checkout",
            "walk-subfolder-canonical-root-differs-from-checkout",
            "home-directory-refused-before-resolve",
        ]) {
            expect(names).toContain(name);
            expect(namedCase(name).expected.resolveCalls).toBeDefined();
        }
    });

    test("tolerant-reader rows isolate unknown values from harmless extra fields", () => {
        for (const name of ["tolerant-reader-unknown-via", "tolerant-reader-decode-failure"]) {
            const row = namedCase(name);
            expect(row.expected.identity).toBe(`git:${parity.gitRootCommit}`);
            expect(row.expected.resolveCalls).toBe(1);
            expect(row.expected.resolveLogs).toBe(1);
            expect(row.expected.sidecarWrites).toHaveLength(1);
            expect(row.expected.sidecarWrites[0].identity).toBe(`git:${parity.gitRootCommit}`);
        }
        const unknownVia = object(
            object(object(vectorFor(namedCase("tolerant-reader-unknown-via"))).reply).result,
        );
        expect(unknownVia.via).toBe("orbit");
        expect(unknownVia.futureField).toBe(true);
        const undecodable = object(
            object(object(vectorFor(namedCase("tolerant-reader-decode-failure"))).reply).result,
        );
        expect(undecodable.projectId).toBe(42);

        const extra = namedCase("tolerant-reader-extra-field");
        const result = object(object(object(vectorFor(extra)).reply).result);
        expect(result.via).toBe("root");
        expect(result.futureField).toBe(true);
        expect(extra.expected.identity).toBe("pj-resolve-root");
        expect(extra.expected.resolveCalls).toBe(1);
        expect(extra.expected.resolveLogs).toBe(0);
        expect(extra.expected.sidecarWrites).toHaveLength(1);
        expect(extra.expected.sidecarWrites[0].identity).toBe("pj-resolve-root");
    });

    test("error rows reuse the vendored refusal and fall back without a project pin", () => {
        for (const [name, code] of [
            ["error-invalid-params", "invalid_params"],
            ["error-storage-unavailable", "storage_unavailable"],
        ]) {
            const row = namedCase(name);
            expect(typeof row.answer).not.toBe("string");
            if (typeof row.answer === "string") throw new Error("Expected a vector answer");
            expect(row.answer.caseIndex).toBe(5);
            const reply = object(object(vectorFor(row)).reply);
            expect(reply).not.toHaveProperty("result");
            expect(reply.code).toBe(code);
            expect(reply.message).toBe(resolveVectors[5].reply.message);
            expect(reply.detail).toBe(resolveVectors[5].reply.detail);
            expect(row.expected.identity).toBe(`git:${parity.gitRootCommit}`);
            expect(row.expected.resolveCalls).toBe(1);
            expect(row.expected.sidecarWrites).toHaveLength(1);
            expect(row.expected.sidecarWrites[0].identity).toBe(`git:${parity.gitRootCommit}`);
        }
        expect(namedCase("error-invalid-params").expected.resolveLogs).toBe(1);
    });

    test("a legacy git record is replaced by the live project pin", () => {
        const row = namedCase("legacy-git-record-replaced-by-live-project-pin");
        expect(row.sidecars).toHaveLength(1);
        expect(row.sidecars[0].directory).toBe(row.directory);
        expect(row.sidecars[0].identity).toBe(`git:${parity.gitRootCommit}`);
        expect(object(object(object(vectorFor(row)).reply).result).via).toBe("root");
        expect(row.expected.identity).toBe("pj-resolve-root");
        expect(row.expected.resolveCalls).toBe(1);
        expect(row.expected.sidecarWrites).toHaveLength(1);
        expect(row.expected.sidecarWrites[0].directory).toBe(row.directory);
        expect(row.expected.sidecarWrites[0].identity).toBe("pj-resolve-root");
    });

    test("pj pins preserve sidecar bytes without a git probe or resolve", () => {
        const row = namedCase("pj-pin-preserves-sidecar-bytes");
        expect(row.sidecars).toHaveLength(1);
        expect(row.sidecars[0].directory).toBe(row.directory);
        expect(row.sidecars[0].identity).toBe("pj-A");
        expect(row.expected.identity).toBe("pj-A");
        expect(row.expected.resolveCalls).toBe(0);
        expect(row.expected.gitProbeCalls).toBe(0);
        expect(row.expected.sidecarWrites).toEqual([]);
        expect(row.expected.sidecarBytesUnchanged).toBe(true);
    });

    test("a walk answer pins the checkout root only for an equal canonicalRoot spelling", () => {
        // A registered subfolder must not pin its parent merely because via is walk:
        // pinning requires canonicalRoot to equal the checkout root.
        for (const name of [
            "walk-subfolder-canonical-root-equals-checkout",
            "walk-subfolder-canonical-root-differs-from-checkout",
        ]) {
            const row = namedCase(name);
            const result = object(object(object(vectorFor(row)).reply).result);
            expect(row.directory).toBe("<fixture>/repo/sub");
            expect(result.via).toBe("walk");
            expect(row.expected.identity).toBe("pj-resolve-root");
            expect(row.expected.resolveCalls).toBe(1);
            const expectedDirectories =
                result.canonicalRoot === "<fixture>/repo"
                    ? ["<fixture>/repo/sub", "<fixture>/repo"]
                    : ["<fixture>/repo/sub"];
            expect(row.expected.sidecarWrites.map((write) => write.directory)).toEqual(
                expectedDirectories,
            );
        }
        expect(
            namedCase("walk-subfolder-canonical-root-equals-checkout").expected.canonicalRoot,
        ).toBe("<fixture>/repo");
        expect(
            namedCase("walk-subfolder-canonical-root-differs-from-checkout").expected.canonicalRoot,
        ).toBe("<fixture>/repo/sub");
    });

    test("a disallowed home directory is refused before identity resolution", () => {
        const row = namedCase("home-directory-refused-before-resolve");
        const fixture = object(object(parity.fixtures)[row.fixture]);
        expect(fixture.home).toBe(row.directory);
        expect(row.expected.identity).toBeNull();
        expect(row.expected.gitCommonDir).toBeNull();
        expect(row.expected.errorClass).toBe("home_project_disabled");
        expect(row.expected.resolveCalls).toBe(0);
        expect(row.expected.gitProbeCalls).toBe(0);
        expect(row.expected.sidecarWrites).toEqual([]);
    });

    test("record mutations never change the vendored source", () => {
        const original = structuredClone(resolveVectors);
        for (const row of cases) vectorFor(row);
        expect(resolveVectors).toEqual(original);
    });
});
