/**
 * Captures the Magic Context guidance that the standalone OpenCode and Pi
 * plugins put into a session's system prompt, over a matrix of configurations,
 * for the Rust module's mode-3 parity test.
 *
 * Run from the repository root:
 *
 *   bun crates/mc-module/gen/gen-standalone-guidance.ts          # write the fixture
 *   bun crates/mc-module/gen/gen-standalone-guidance.ts --check  # fail if it differs
 *
 * The fixture is `crates/mc-module/testdata/standalone-guidance-parity.json`.
 * `crates/mc-module/src/tests/standalone_guidance_parity.rs` asks ck-mc's
 * `tool.catalog` for the same configurations and compares `system_text.text`
 * with these bytes.
 *
 * Every text here comes from the hosts' real composition entry points, not from
 * a reimplementation:
 *
 * - OpenCode: the `experimental.chat.system.transform` handler from
 *   `createSystemPromptHashHandler` (`packages/plugin/src/hooks/magic-context/
 *   system-prompt-hash.ts`), wired the way `hook.ts` wires it from config;
 * - Pi: `composePiSystemPrompt` (`packages/pi-plugin/src/compose-system-prompt-pi.ts`),
 *   called the way the `before_agent_start` handler in `packages/pi-plugin/src/index.ts`
 *   calls it.
 *
 * Each host gets the same host prompt, which ends with a `Today's date:` line.
 * The generator checks that the host keeps that prompt byte for byte, followed
 * by the separator and the guidance block, and records only the block. A
 * session for which the host adds no guidance records the empty string.
 *
 * Both hosts store per-session state in Magic Context's database and log to a
 * temporary directory. The generator points `XDG_DATA_HOME`, `XDG_CONFIG_HOME`
 * and `MAGIC_CONTEXT_LOG_PATH` at a fresh temporary directory before it loads
 * any plugin module, so it never opens a user's real stores or config.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "crates/mc-module/testdata/standalone-guidance-parity.json");
const FORMAT = "magic-context/standalone-guidance-parity/1";

/** The host's own system prompt, as a host would build it, date line last. */
const HOST_PROMPT = "You are the host's coding agent.\nToday's date: Fri Oct 02 2026";

/** Both hosts join the host prompt and the guidance block with a blank line. */
const SEPARATOR = "\n\n";

/**
 * A user's guidance override file. It has the one `## Magic Context` marker
 * line the hosts require, braces that must stay as typed, and smart-note
 * wording in three forms: the exact sentence the built-in guidance uses
 * (twice, on separate lines), a line naming smart notes, and a heading whose
 * section is about smart notes. With smart notes off, the hosts remove the
 * first occurrence of the sentence, every line that mentions smart notes, and
 * the whole smart-note section.
 */
const OVERRIDE_SAMPLE = [
    "## Magic Context",
    "",
    "My own guidance, with {{braces}} kept as typed.",
    "Write notes with ctx_note. A note with a `surface_condition` is left with an outside checker that looks the condition up periodically and returns the note only when it holds.",
    "Second copy, still kept. A note with a `surface_condition` is left with an outside checker that looks the condition up periodically and returns the note only when it holds.",
    "Smart notes wait for their condition.",
    "### Smart notes",
    "Everything in this section is about them.",
    "#### Still smart notes",
    "Nested under the smart-note section.",
    "### Back to work",
    "This section stays.",
].join("\n");

/** Languages crossed with every other input: none, and one with a directive. */
const MATRIX_LANGUAGES: (string | null)[] = [null, "fr"];
/**
 * Languages checked once at the default configuration: a name with non-ASCII
 * letters, spacing and case the hosts normalise, an unknown code, and a value
 * that is not a two-letter code at all.
 */
const EXTRA_LANGUAGES = ["tr", " FR ", "zz", "english"];

type Harness = "opencode" | "pi";
type Session = "primary" | "subagent";
type Surface = "full" | "light";

interface Row {
    harness: Harness;
    session: Session;
    ctx_reduce: boolean;
    memory: boolean;
    smart_notes: boolean;
    dreamer: boolean;
    temporal: boolean;
    caveman: boolean;
    language: string | null;
    surface: Surface;
    override: boolean;
}

function rowId(row: Row): string {
    const flag = (name: string, on: boolean) => `${name}=${on ? 1 : 0}`;
    return [
        row.harness,
        row.session,
        flag("reduce", row.ctx_reduce),
        flag("memory", row.memory),
        flag("smart_notes", row.smart_notes),
        flag("dreamer", row.dreamer),
        flag("temporal", row.temporal),
        flag("caveman", row.caveman),
        `language=${JSON.stringify(row.language)}`,
        `surface=${row.surface}`,
        flag("override", row.override),
    ].join(" ");
}

/** The hosts and session kinds: Pi has no subagent sessions. */
const SESSIONS: [Harness, Session][] = [
    ["opencode", "primary"],
    ["opencode", "subagent"],
    ["pi", "primary"],
];

function* matrixRows(): Generator<Row> {
    for (const [harness, session] of SESSIONS) {
        for (const surface of ["full", "light"] as Surface[]) {
            for (const language of MATRIX_LANGUAGES) {
                for (let bits = 0; bits < 128; bits++) {
                    yield {
                        harness,
                        session,
                        ctx_reduce: (bits & 1) !== 0,
                        memory: (bits & 2) !== 0,
                        smart_notes: (bits & 4) !== 0,
                        dreamer: (bits & 8) !== 0,
                        temporal: (bits & 16) !== 0,
                        caveman: (bits & 32) !== 0,
                        language,
                        surface,
                        override: (bits & 64) !== 0,
                    };
                }
            }
        }
        for (const language of EXTRA_LANGUAGES) {
            yield {
                harness,
                session,
                ctx_reduce: true,
                memory: true,
                smart_notes: true,
                dreamer: true,
                temporal: true,
                caveman: false,
                language,
                surface: "full",
                override: false,
            };
        }
    }
}

function sha256Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The guidance block a host appended to `HOST_PROMPT`, or "" when it added none. */
function guidanceBlock(id: string, composed: string): string {
    if (composed === HOST_PROMPT) return "";
    const prefix = `${HOST_PROMPT}${SEPARATOR}`;
    if (!composed.startsWith(prefix)) {
        throw new Error(`${id}: the host changed its own prompt or the separator: ${JSON.stringify(composed.slice(0, 200))}`);
    }
    return composed.slice(prefix.length);
}

async function capture(): Promise<string> {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-standalone-guidance-"));
    process.env.XDG_DATA_HOME = join(scratch, "data");
    process.env.XDG_CONFIG_HOME = join(scratch, "config");
    process.env.MAGIC_CONTEXT_LOG_PATH = join(scratch, "magic-context.log");
    try {
        // Loaded only now, after the environment points at the scratch directory.
        const storage = await import("../../../packages/plugin/src/features/magic-context/storage");
        const opencodeHash = await import(
            "../../../packages/plugin/src/hooks/magic-context/system-prompt-hash"
        );
        const availability = await import(
            "../../../packages/plugin/src/hooks/magic-context/ctx-reduce-availability"
        );
        const runtimeModule = await import("../../../packages/plugin/src/shared/prompt-surface-runtime");
        const pi = await import("../../../packages/pi-plugin/src/compose-system-prompt-pi");

        const db = storage.openDatabase(join(scratch, "context.db"));
        if (!db) throw new Error("could not open the scratch database");
        const overridePath = join(scratch, "guidance.md");
        writeFileSync(overridePath, OVERRIDE_SAMPLE);
        const warnings: string[] = [];
        const runtime = runtimeModule.createPromptSurfaceRuntime({
            userConfigDirectory: scratch,
            warn: (message: string) => warnings.push(message),
        });

        const texts = new Map<string, string>();
        const rows: string[] = [];
        let index = 0;
        for (const row of matrixRows()) {
            const id = rowId(row);
            const sessionId = `ses-guidance-${index++}`;
            const promptSurface = {
                default: row.surface,
                ...(row.override ? { guidance_override_path: overridePath } : {}),
            };
            let composed: string;
            if (row.harness === "opencode") {
                // `hook.ts` builds the handler from config; a session whose first
                // user message's tools map denies ctx_reduce is the per-session
                // way OpenCode makes ctx_reduce uncallable.
                availability.resolveCtxReduceAvailabilityFromMessages(sessionId, [
                    { info: { role: "user", tools: row.ctx_reduce ? {} : { ctx_reduce: false } } },
                ]);
                storage.getOrCreateSessionMeta(db, sessionId);
                if (row.session === "subagent") {
                    storage.updateSessionMeta(db, sessionId, { isSubagent: true });
                }
                const { handler } = opencodeHash.createSystemPromptHashHandler({
                    db,
                    dreamerEnabled: row.dreamer,
                    smartNotesEnabled: row.smart_notes,
                    memoryEnabled: row.memory,
                    language: row.language ?? undefined,
                    promptSurface,
                    promptSurfaceRuntime: runtime,
                    resolveModel: () => ({ providerID: "provider", modelID: "model" }),
                    historyRefreshSessions: new Set<string>(),
                    systemPromptRefreshSessions: new Set<string>(),
                    pendingMaterializationSessions: new Set<string>(),
                    lastHeuristicsTurnId: new Map<string, string>(),
                    injectionEnabled: true,
                    injectionSkipSignatures: ["<!-- magic-context: skip -->"],
                    experimentalTemporalAwareness: row.temporal,
                    experimentalCavemanTextCompression: row.caveman,
                });
                const output = { system: [HOST_PROMPT] };
                await handler({ sessionID: sessionId }, output);
                if (output.system.length !== 1) throw new Error(`${id}: OpenCode split the system prompt`);
                composed = output.system[0] ?? "";
                availability.clearCtxReduceAvailability(sessionId);
            } else {
                // `index.ts` passes `ctxReduceCallable: !compactionOff`.
                const result = pi.composePiSystemPrompt({
                    db,
                    cwd: scratch,
                    sessionId,
                    systemPrompt: HOST_PROMPT,
                    config: {
                        memory: { enabled: row.memory },
                        protected_tags: 20,
                        temporal_awareness: row.temporal,
                        caveman_text_compression: { enabled: row.caveman },
                        language: row.language ?? undefined,
                        prompt_surface: promptSurface,
                        system_prompt_injection: {
                            enabled: true,
                            skip_signatures: ["<!-- magic-context: skip -->"],
                        },
                    } as never,
                    model: { provider: "provider", id: "model" },
                    runtime,
                    ctxReduceCallable: row.ctx_reduce,
                    dreamerEnabled: row.dreamer,
                    smartNotesEnabled: row.smart_notes,
                    hasSystemPromptRefresh: () => false,
                    clearSystemPromptRefresh: () => {},
                    signalHashChange: () => {},
                    stickyDates: new Map<string, string>(),
                });
                if (result.skipped) throw new Error(`${id}: Pi skipped the prompt`);
                composed = result.systemPrompt;
            }
            const text = guidanceBlock(id, composed);
            const sha256 = sha256Hex(text);
            texts.set(sha256, text);
            // The row's inputs identify it; `rowId` names it only in errors.
            rows.push(JSON.stringify({ ...row, bytes: Buffer.byteLength(text, "utf8"), sha256 }));
        }
        if (warnings.length > 0) throw new Error(`prompt-surface warnings: ${warnings.join("; ")}`);
        storage.closeDatabase();

        // One row per line keeps the file reviewable; texts are keyed by digest
        // so each distinct text is stored once.
        const sortedTexts = [...texts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const lines = [
            "{",
            `  "format": ${JSON.stringify(FORMAT)},`,
            `  "generator": "crates/mc-module/gen/gen-standalone-guidance.ts",`,
            `  "host_prompt": ${JSON.stringify(HOST_PROMPT)},`,
            `  "separator": ${JSON.stringify(SEPARATOR)},`,
            `  "override_sample": ${JSON.stringify(OVERRIDE_SAMPLE)},`,
            `  "rows": [`,
            rows.map((row) => `    ${row}`).join(",\n"),
            "  ],",
            `  "texts": {`,
            sortedTexts.map(([sha, text]) => `    ${JSON.stringify(sha)}: ${JSON.stringify(text)}`).join(",\n"),
            "  }",
            "}",
            "",
        ];
        return lines.join("\n");
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const check = process.argv.includes("--check");
    const generated = await capture();
    if (check) {
        let current: string | undefined;
        try {
            current = readFileSync(FIXTURE_PATH, "utf8");
        } catch {
            current = undefined;
        }
        if (current !== generated) {
            console.error(
                `out of date: ${FIXTURE_PATH}; run bun crates/mc-module/gen/gen-standalone-guidance.ts`,
            );
            process.exit(1);
        }
        console.log(`standalone guidance fixture is current`);
    } else {
        writeFileSync(FIXTURE_PATH, generated);
        console.log(`wrote ${FIXTURE_PATH}`);
    }
}

if (import.meta.main) await main();
