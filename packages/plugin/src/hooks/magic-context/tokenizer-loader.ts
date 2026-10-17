import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type TokenizerLike = {
    encode: (text: string, allowedSpecial: string) => number[];
};
type TokenizerConstructor = new (encoding: unknown) => TokenizerLike;
type EncodingObserver = (path: string) => void;

const TOKENIZER_PACKAGE_DIRS = [
    ["@cortexkit", "opencode-magic-context"],
    ["@cortexkit", "pi-magic-context"],
] as const;

/** Candidate package directories in precedence order. This module does no probing until called. */
export function tokenizerPackageRoots(): string[] {
    const cwd = process.cwd();
    const openCodeCache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode");
    const candidates: string[] = [];
    const probeRoot = (root: string): void => {
        // Prefer dependencies nested under the plugin over host-hoisted copies.
        for (const packageDir of TOKENIZER_PACKAGE_DIRS) {
            candidates.push(
                join(root, "node_modules", ...packageDir, "node_modules", "ai-tokenizer"),
            );
        }
        candidates.push(join(root, "node_modules", "ai-tokenizer"));
    };
    for (const root of [cwd, openCodeCache]) probeRoot(root);

    const pushAncestors = (startDir: string): void => {
        let ancestor = startDir;
        while (true) {
            candidates.push(join(ancestor, "node_modules", "ai-tokenizer"));
            const parent = dirname(ancestor);
            if (parent === ancestor) break;
            ancestor = parent;
        }
    };
    pushAncestors(process.argv[1] ? dirname(resolve(process.argv[1])) : cwd);
    // A compiled host's argv[1] may be a CLI argument, not a module path. Walk
    // the extension's own install tree too; fileURLToPath drops cache-bust queries.
    pushAncestors(dirname(fileURLToPath(new URL(import.meta.url))));
    // Linked OMP plugins can keep their dependencies in this host-wide tree.
    // Probe it last so a stale hoisted version cannot outrank the plugin's own copy.
    probeRoot(join(homedir(), ".omp", "plugins"));
    return [...new Set(candidates)];
}

function packageImportTarget(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return undefined;
    const conditions = value as Record<string, unknown>;
    return packageImportTarget(conditions.import) ?? packageImportTarget(conditions.default);
}

function findTokenizerImportPaths(): { tokenizerPath: string; encodingPath: string } {
    for (const packageRoot of tokenizerPackageRoots()) {
        const packageJsonPath = join(packageRoot, "package.json");
        if (!existsSync(packageJsonPath)) continue;
        try {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
                module?: unknown;
                main?: unknown;
                exports?: Record<string, unknown>;
            };
            const tokenizerTarget =
                packageImportTarget(packageJson.exports?.["."]) ??
                (typeof packageJson.module === "string" ? packageJson.module : undefined) ??
                (typeof packageJson.main === "string" ? packageJson.main : undefined);
            const encodingTarget = packageImportTarget(packageJson.exports?.["./encoding/claude"]);
            if (!tokenizerTarget || !encodingTarget) continue;
            return {
                tokenizerPath: realpathSync(join(packageRoot, tokenizerTarget)),
                encodingPath: realpathSync(join(packageRoot, encodingTarget)),
            };
        } catch {
            // Try the next npm layout; callers own fallback policy and diagnostics.
        }
    }
    throw new Error(
        "ai-tokenizer was not found under the project, runtime, or OpenCode cache node_modules roots",
    );
}

function constructTokenizer(tokenizerModule: unknown, claudeEncoding: unknown): TokenizerLike {
    const typedModule = tokenizerModule as {
        default?: TokenizerConstructor;
        Tokenizer?: TokenizerConstructor;
    };
    const Tokenizer = typedModule.default ?? typedModule.Tokenizer;
    if (!Tokenizer) throw new Error("ai-tokenizer does not expose a Tokenizer constructor");
    return new Tokenizer(claudeEncoding);
}

/** Primary synchronous load, retained separately for the formatter's existing preload policy. */
export function loadPrimaryTokenizer(onEncodingPath?: EncodingObserver): TokenizerLike {
    // Non-literal specifiers prevent Bun from bundling the vocabulary into the
    // eager plugin chunk. Both packages must stay unloaded until counting begins.
    const require = createRequire(import.meta.url);
    const encodingSpecifier = "ai-tokenizer/encoding/" + "claude";
    const encodingPath = require.resolve(encodingSpecifier);
    onEncodingPath?.(encodingPath);
    return constructTokenizer(require("ai-" + "tokenizer"), require(encodingSpecifier));
}

/** Dynamic import supports packages whose exports only expose the import condition. */
export async function loadInstalledTokenizer(
    onEncodingPath?: EncodingObserver,
): Promise<TokenizerLike> {
    const paths = findTokenizerImportPaths();
    const [module, encoding] = await Promise.all([
        import(pathToFileURL(paths.tokenizerPath).href),
        import(pathToFileURL(paths.encodingPath).href),
    ]);
    onEncodingPath?.(paths.encodingPath);
    return constructTokenizer(module, encoding);
}

/** Marker admission is synchronous, so require the same probed absolute entry paths. */
export function loadTokenizerSync(): TokenizerLike {
    try {
        return loadPrimaryTokenizer();
    } catch {
        const paths = findTokenizerImportPaths();
        const require = createRequire(import.meta.url);
        return constructTokenizer(require(paths.tokenizerPath), require(paths.encodingPath));
    }
}
