/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginConfig } from "../../config";
import {
    type ContextDatabase,
    closeDatabase,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    SESSION_ID,
    seedTsEraTagsThenRustHistory,
    TS_ERA_TEXT,
} from "../../tools/ctx-expand/rust-mode-tag.test-support";
import { CTX_EXPAND_RUST_TAG_REFUSAL } from "../../tools/ctx-expand/tools";
import { registerTools } from "./tools";
import type { V2Context } from "./types";

let dir: string;
let db: ContextDatabase;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    dir = createTestTempDirFromPath(join(tmpdir(), "mc-v2-tool-registration-"));
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    const opened = openDatabase();
    if (!opened) throw new Error("test database unavailable");
    db = opened;
});

afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

interface RegisteredTool {
    name: string;
    execute: (input: unknown, call: Record<string, unknown>) => Promise<{ content: string }>;
}

/** Stands in for the host's tool editor: `add` populates the map the host would keep. */
function hostContext(registered: RegisteredTool[]): V2Context {
    return {
        location: { directory: dir },
        tool: {
            async transform(callback: (editor: { add: (tool: RegisteredTool) => void }) => void) {
                callback({ add: (tool) => registered.push(tool) });
            },
        },
    } as unknown as V2Context;
}

test("the registered ctx_note tool reads the host store", async () => {
    const registered: RegisteredTool[] = [];
    await registerTools(
        hostContext(registered),
        db,
        parsePluginConfig({ memory: { enabled: true } }),
    );
    const note = registered.find((tool) => tool.name === "ctx_note");
    expect(note).toBeDefined();
    const result = await note!.execute(
        { action: "read" },
        { sessionID: "ses-1", messageID: "msg-1", agent: "build", progress: () => {} },
    );
    expect(typeof result.content).toBe("string");
});

/**
 * OpenCode 2 runs the Rust transform too, and registers its own tool map, so it
 * must also pass the resolved transform mode to ctx_expand.
 */
async function expandTagOnV2(transformMode: "ts" | "rust"): Promise<string> {
    const cleanup = seedTsEraTagsThenRustHistory(db);
    try {
        const config = parsePluginConfig({ memory: { enabled: true } });
        config.transform_mode = transformMode;
        const registered: RegisteredTool[] = [];
        await registerTools(hostContext(registered), db, config, undefined);
        const expand = registered.find((tool) => tool.name === "ctx_expand");
        expect(expand).toBeDefined();
        const result = await expand!.execute(
            { tag: "[dropped §75386§]" },
            { sessionID: SESSION_ID, messageID: "msg-1", agent: "build", progress: () => {} },
        );
        return result.content;
    } finally {
        cleanup();
    }
}

test("Rust-mode ctx_expand refuses tag lookup instead of serving a TypeScript-era row", async () => {
    expect(await expandTagOnV2("rust")).toBe(CTX_EXPAND_RUST_TAG_REFUSAL);
});

test("TypeScript-mode ctx_expand keeps resolving tags from the host", async () => {
    expect(await expandTagOnV2("ts")).toContain(TS_ERA_TEXT);
});
