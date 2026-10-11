import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { loadPluginConfigDetailed } from "./index";
import { LiveConfigReader } from "./live-snapshot";
import { migrateMagicContextConfigLocations } from "./migrate-config-location";
import { MagicContextConfigSchema } from "./schema/magic-context";

const keys = ["HOME", "XDG_CONFIG_HOME", "MAGIC_CONTEXT_CONFIG_PATH"] as const;
let previous: (string | undefined)[];
let root: string;
let project: string;
let override: string;
let xdgFile: string;
function write(path: string, value: unknown) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
}
const load = () => loadPluginConfigDetailed(project, false).config;
beforeEach(() => {
    previous = keys.map((key) => process.env[key]);
    root = createTestTempDirFromPath(join(tmpdir(), "mc-config-override-"));
    project = join(root, "project");
    override = join(root, "user.settings");
    xdgFile = join(root, "xdg", "cortexkit", "magic-context.jsonc");
    process.env.HOME = root;
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    process.env.MAGIC_CONTEXT_CONFIG_PATH = override;
    write(xdgFile, { cache_ttl: "1h" });
});
afterEach(() => {
    keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
    });
    rmSync(root, { recursive: true, force: true });
});

test("MAGIC_CONTEXT_CONFIG_PATH exact file wins over isolated XDG user config", () => {
    write(override, { cache_ttl: "15m" });
    expect(load().cache_ttl).toBe("15m");
});

test("MAGIC_CONTEXT_CONFIG_PATH refuses relative and blank values", () => {
    for (const value of ["relative.jsonc", "", "   "]) {
        process.env.MAGIC_CONTEXT_CONFIG_PATH = value;
        expect(load).toThrow("MAGIC_CONTEXT_CONFIG_PATH must be an absolute path");
    }
});

test("missing config override gives defaults and one warning without XDG or legacy fallback", () => {
    write(join(root, "xdg", "opencode", "magic-context.jsonc"), { cache_ttl: "20m" });
    expect(migrateMagicContextConfigLocations(project)).toEqual([]);
    const config = load();
    expect(config.cache_ttl).toBe(MagicContextConfigSchema.parse({}).cache_ttl);
    expect(
        config.configWarnings?.filter((warning) => warning.includes("MAGIC_CONTEXT_CONFIG_PATH")),
    ).toEqual([
        `[user config] MAGIC_CONTEXT_CONFIG_PATH file not found: ${override}; continuing without user config (no XDG or legacy fallback).`,
    ]);
});

test("config override leaves project merge and user-only trust boundary intact", () => {
    write(override, { cache_ttl: "15m", compaction: { enabled: false }, language: "en" });
    write(join(project, ".cortexkit", "magic-context.jsonc"), {
        cache_ttl: "30m",
        compaction: { enabled: true },
        language: "tr",
    });
    const config = load();
    expect(config.cache_ttl).toBe("30m");
    expect(config.compaction?.enabled).toBe(false);
    expect(config.language).toBe("en");
    expect(config.configWarnings?.join("\n")).toContain("user-level");
});

test("live reload watches overridden file including creation and ignores XDG edits", () => {
    const reader = new LiveConfigReader(project, load(), load);
    const initial = reader.poll();
    write(xdgFile, { cache_ttl: "40m" });
    expect(reader.poll()).toBe(initial);
    write(override, { cache_ttl: "15m" });
    expect(reader.poll().effective.cache_ttl).toBe("15m");
    write(override, { cache_ttl: "30m" });
    expect(reader.poll().effective.cache_ttl).toBe("30m");
    expect(reader.current().generation).toBe(3);
});
