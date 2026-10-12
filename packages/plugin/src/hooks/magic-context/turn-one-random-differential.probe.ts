/**
 * Seeded random cross-commit differential for the historian turn-one publication.
 *
 * For each scenario it runs one random session script on two source trees (a base
 * commit and the current tree), each step sequence split over several child
 * processes that share an on-disk store, so a "restart" is a real process restart.
 * A script mixes HARD folds (rebuilds of the memory pair m[0]/m[1], test-forced and
 * provider-cache-expiry), SOFT passes (which may rewrite m[1] and so break the
 * provider's prompt cache), defer passes (which replay stored bytes), `/ctx-flush`, new user turns, historian publishes through
 * the production runner (OpenCode 1 host session, OpenCode 2 hidden completion, Pi
 * subagent) and historian runs whose reply is unusable. The historian reply is built
 * from the prompt it receives: one to three compartments cut at printed-line ends,
 * sometimes consuming the whole chunk (so the runner's discard-last healing drops
 * the last compartment), and up to three
 * facts that each carry a unique token.
 *
 * What is compared, pass by pass, is the whole served message array (m[0], m[1] and
 * the trimmed history after them) plus whether the pass materialized. Per publish
 * the SHA-256 of the historian prompt is compared too. Lanes:
 * - `dormant`: both trees run with the same dependencies; everything must match.
 * - `enabled`: the current tree runs `memoryLifecycleLane: "enabled"` and the base
 *   tree runs with `autoPromote: false`, so the comparison shows that candidate facts
 *   never reach memory rows or the served array.
 * Fact modes: `plain` facts have no prefix; `prefixed` facts carry well-formed,
 * unknown, out-of-range and malformed `[at_compartment=…]` prefixes.
 *
 * Each scenario also picks who owns the project's memory: `ts` (this process
 * promotes facts) or `module` (an `authority_managed` row gives it to the Rust
 * module, so facts become candidates). Invariants checked inside each run (current
 * tree): on the dormant lane with `ts` ownership a promoted fact token is served
 * only from the first materializing pass after it was promoted; no candidate token
 * is ever served; on the enabled lane and under `module` ownership no fact reaches a
 * memory row. Each child process lists the
 * database files it holds open (Linux `/proc/self/fd`) and fails if any lies outside
 * its throwaway root.
 *
 * Usage (Linux, from a checkout with node_modules installed):
 *   git archive <base> packages/plugin packages/pi-plugin packages/retina-local-fs | tar -x -C <base-root>
 *   link node_modules into <base-root> (root and each package), then
 *   bun packages/plugin/src/hooks/magic-context/turn-one-random-differential.probe.ts \
 *     <base-root> <current-root> <throwaway-dir> [seeds=4] [first-seed=1]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

type Host = "oc1" | "oc2" | "pi";
type Authority = "ts" | "module";
type Lane = "dormant" | "enabled";
type FactMode = "plain" | "prefixed";
type Step =
    | "hard"
    | "genuine-hard"
    | "soft"
    | "defer"
    | "flush"
    | "publish"
    | "bad-publish"
    | "user-turn"
    | "restart";

interface Scenario {
    host: Host;
    authority: Authority;
    lane: Lane;
    factMode: FactMode;
    seed: number;
}

interface PassRecord {
    index: number;
    step: Step;
    served: string;
    materialized: boolean;
    promptSha?: string;
    replyFacts?: number;
}

interface SegmentOutput {
    passes: PassRecord[];
    memories: Array<{ content: string; status: string; source: string }>;
    compartments: Array<[number, number, string]>;
    turnOne: Record<string, number>;
    anchoredCandidates: number;
    commitOrders: Array<number | null>;
    openDbFiles: string[];
    violations: string[];
    bindings: {
        validBound: number;
        validUnknown: number;
        validUnknownLast: number;
        otherBound: number;
    };
}

// biome-ignore lint/suspicious/noExplicitAny: modules are loaded from a tree chosen at run time.
type AnyModule = any;

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function weighted<T>(random: () => number, entries: Array<[T, number]>): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let at = random() * total;
    for (const [value, weight] of entries) {
        at -= weight;
        if (at < 0) return value;
    }
    return entries[entries.length - 1]![0];
}

/** The step script of a seed; the first step is always a HARD fold. */
function script(seed: number): Step[] {
    const random = mulberry32(seed * 7919 + 17);
    const steps: Step[] = ["hard"];
    for (let at = 0; at < 34; at += 1) {
        steps.push(
            weighted<Step>(random, [
                ["defer", 7],
                ["soft", 4],
                ["publish", 4],
                ["user-turn", 3],
                ["bad-publish", 1],
                ["flush", 1],
                ["genuine-hard", 1.5],
                ["hard", 0.5],
                ["restart", 1.2],
            ]),
        );
    }
    steps.push("genuine-hard", "defer", "soft", "defer");
    return steps;
}

function sha(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** First string anywhere in `value` that contains `needle`. */
function findText(value: unknown, needle: string): string | null {
    if (typeof value === "string") return value.includes(needle) ? value : null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findText(item, needle);
            if (found) return found;
        }
        return null;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) {
            const found = findText(item, needle);
            if (found) return found;
        }
    }
    return null;
}

const CATEGORIES = ["CONSTRAINTS", "NAMING", "PROJECT_RULES", "ARCHITECTURE"];

/** The anchor a generated fact was given, kept to judge how the publisher bound it. */
interface ReplyAnchor {
    token: string;
    kind: "valid" | "unknown" | "out-of-range" | "index-only" | "reversed" | "zero" | "origin-only";
    index: number;
    range: [number, number];
    /**
     * The anchor names the reply's last compartment. The runner drops that
     * compartment (discard-last healing) when the reply consumes the whole chunk with
     * two or more compartments, so such an anchor is expected to stay unknown.
     */
    lastOfReply: boolean;
}

/**
 * Build a historian reply for `prompt`: compartments cut at printed-line ends from
 * the chunk start, and facts with unique tokens. Deterministic in (seed, publish
 * count, prompt's chunk), so the base tree and the current tree receive the same
 * reply for the same chunk and their results can be compared.
 */
function historianReply(
    prompt: string,
    seed: number,
    publishCount: number,
    factMode: FactMode,
    bad: boolean,
): { reply: string; facts: string[]; anchors: ReplyAnchor[] } {
    const random = mulberry32(seed * 104729 + publishCount * 31 + 3);
    if (bad) return { reply: "I could not summarize this slice.", facts: [], anchors: [] };
    const header = prompt.match(/Messages (\d+)-(\d+):/);
    if (!header) return { reply: "no chunk header", facts: [], anchors: [] };
    const start = Number(header[1]);
    const lines = [...prompt.matchAll(/^\[(\d+)(?:-(\d+))?\] /gm)]
        .map((match) => [Number(match[1]), Number(match[2] ?? match[1])] as [number, number])
        .filter(([lineStart]) => lineStart >= start);
    if (lines.length === 0) return { reply: "no printed lines", facts: [], anchors: [] };
    // Consume the whole chunk half the time, otherwise stop at an earlier line end.
    const usable = random() < 0.5 ? lines.length : 1 + Math.floor(random() * lines.length);
    const used = lines.slice(0, usable);
    const parts = Math.min(used.length, 1 + Math.floor(random() * 3));
    const cuts = new Set<number>([used.length - 1]);
    while (cuts.size < parts) cuts.add(Math.floor(random() * (used.length - 1)));
    const ends = [...cuts].sort((a, b) => a - b);
    const compartments: Array<{ start: number; end: number; lines: Array<[number, number]> }> = [];
    let from = 0;
    for (const end of ends) {
        const slice = used.slice(from, end + 1);
        compartments.push({
            start: compartments.length === 0 ? start : slice[0]![0],
            end: slice[slice.length - 1]![1],
            lines: slice,
        });
        from = end + 1;
    }
    const body = compartments
        .map(
            (c, at) =>
                `<compartment start="${c.start}" end="${c.end}" title="Work ${seed}-${publishCount}-${at + 1}"><p1>Summary ${seed}-${publishCount}-${at + 1} of messages ${c.start} to ${c.end}.</p1><p2>Short ${at + 1}.</p2><p3>Gist ${at + 1}.</p3><p4/></compartment>`,
        )
        .join("\n");
    const facts: string[] = [];
    const anchors: ReplyAnchor[] = [];
    const bullets: string[] = [];
    const factCount = Math.floor(random() * 4);
    for (let at = 0; at < factCount; at += 1) {
        const token = `tok${seed}x${publishCount}x${at}`;
        const text = `Fact ${token} holds for this project.`;
        facts.push(token);
        let prefix = "";
        if (factMode === "prefixed") {
            const index = Math.floor(random() * compartments.length);
            const target = compartments[index]!;
            const line = target.lines[Math.floor(random() * target.lines.length)]!;
            const kind = weighted<ReplyAnchor["kind"]>(random, [
                ["valid", 4],
                ["unknown", 1],
                ["out-of-range", 1],
                ["index-only", 1],
                ["reversed", 1],
                ["zero", 0.5],
                ["origin-only", 0.5],
            ]);
            prefix = {
                valid: `[at_compartment=${index + 1} messages=${line[0]}${line[1] === line[0] ? "" : `-${line[1]}`}] `,
                unknown: "[at_compartment=unknown] ",
                "out-of-range": `[at_compartment=${compartments.length + 1} messages=${line[0]}] `,
                "index-only": `[at_compartment=${index + 1}] `,
                reversed: `[at_compartment=${index + 1} messages=${line[1]}-${line[0] - 1}] `,
                zero: "[at_compartment=0 messages=1] ",
                "origin-only": "(origin_compartment=1) ",
            }[kind];
            anchors.push({
                token,
                kind,
                index: index + 1,
                range: line,
                lastOfReply: index === compartments.length - 1,
            });
        }
        bullets.push(
            `<${CATEGORIES[at % CATEGORIES.length]}>\n* ${prefix}${text}\n</${CATEGORIES[at % CATEGORIES.length]}>`,
        );
    }
    const factsBlock = bullets.length > 0 ? `\n<facts>\n${bullets.join("\n")}\n</facts>` : "";
    // A reply that stops before the chunk's last line says where to resume.
    const meta =
        usable < lines.length
            ? `\n<meta><unprocessed_from>${compartments[compartments.length - 1]!.end + 1}</unprocessed_from></meta>`
            : "";
    return {
        reply: `<output><compartments>\n${body}\n</compartments>${factsBlock}${meta}\n</output>`,
        facts,
        anchors,
    };
}

/** Message texts of a session: an initial history and two more per user turn. */
function messageTexts(
    seed: number,
    turns: number,
): Array<{ role: "user" | "assistant"; text: string }> {
    const out: Array<{ role: "user" | "assistant"; text: string }> = [];
    const total = 14 + turns * 2;
    for (let at = 0; at < total; at += 1) {
        const user = at % 2 === 0;
        out.push({
            role: user ? "user" : "assistant",
            text: user
                ? `Request ${at + 1} for seed ${seed}: adjust component ${(at * 7) % 13}.`
                : `Done with step ${at + 1}; component ${(at * 7) % 13} updated.`,
        });
    }
    return out;
}

function openDbFiles(): string[] {
    const fdDir = "/proc/self/fd";
    if (!existsSync(fdDir)) return ["<no /proc on this platform>"];
    const files: string[] = [];
    for (const fd of readdirSync(fdDir)) {
        try {
            const target = readlinkSync(join(fdDir, fd));
            if (/\.db(-wal|-shm)?$/.test(target)) files.push(target);
        } catch {
            // The directory's own descriptor disappears while it is read.
        }
    }
    return [...new Set(files)].sort();
}

const SESSION = "ses-turn-one-random";
const DIRECTORY = "/tmp/mc-turn-one-random-project";

async function runSegment(
    root: string,
    work: string,
    scenario: Scenario,
    isBase: boolean,
    from: number,
    to: number,
): Promise<SegmentOutput> {
    const steps = script(scenario.seed);
    const core = (rel: string): Promise<AnyModule> =>
        import(join(root, "packages/plugin/src", rel));
    const pi = (rel: string): Promise<AnyModule> =>
        import(join(root, "packages/pi-plugin/src", rel));
    const storageMemory = await core("features/magic-context/memory/storage-memory.ts");
    const lease = await core("features/magic-context/compartment-lease.ts");
    const { executeFlush } = await core("hooks/magic-context/execute-flush.ts");
    const producer = await core("hooks/magic-context/producer-window-test-support.ts");
    const notifications = await core("hooks/magic-context/send-session-notification.ts");
    notifications.__ignoredNotificationTest?.setHoldDetector(() => false);
    await producer.observeProducerModelsForTest(["test/fixture-historian"]);

    // Counters a step needs are recomputed from the steps before `from`, so every
    // process segment agrees on them.
    const turnsBefore = (upTo: number) =>
        steps.slice(0, upTo).filter((step) => step === "user-turn").length;
    const publishesBefore = (upTo: number) =>
        steps.slice(0, upTo).filter((step) => step === "publish" || step === "bad-publish").length;
    let lastResponseTime =
        1_000 + steps.slice(0, from).filter((step) => step === "genuine-hard").length;

    const isPi = scenario.host === "pi";
    if (scenario.host === "oc2") (await core("shared/harness.ts")).setHarness("opencode2");
    let db: AnyModule;
    let projectPath: string;
    let closeDb: () => void;
    let storage: AnyModule = null;
    const rawPath = join(work, "data", "opencode", "opencode.db");
    if (isPi) {
        const { createTestDb } = await pi("test-utils.test.ts");
        const piPath = join(work, "pi-context.db");
        mkdirSync(dirname(piPath), { recursive: true });
        db = createTestDb(piPath);
        const { resolveProjectIdentityForSession } = await core(
            "features/magic-context/memory/project-identity.ts",
        );
        projectPath = resolveProjectIdentityForSession(DIRECTORY, true);
        closeDb = () => db.close();
    } else {
        storage = await core("features/magic-context/storage.ts");
        db = storage.openDatabase();
        const { resolveProjectIdentity } = await core(
            "features/magic-context/memory/project-identity.ts",
        );
        projectPath = resolveProjectIdentity(DIRECTORY);
        closeDb = () => storage.closeDatabase();
    }
    const { Database } = await core("shared/sqlite.ts");
    const writeRawMessages = (turns: number) => {
        mkdirSync(dirname(rawPath), { recursive: true });
        const raw = new Database(rawPath);
        raw.exec(`
            CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        `);
        messageTexts(scenario.seed, turns).forEach((message, at) => {
            const id = `m-${String(at + 1).padStart(4, "0")}`;
            if (raw.prepare("SELECT 1 FROM message WHERE id=?").get(id)) return;
            raw.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                id,
                SESSION,
                at + 1,
                at + 1,
                JSON.stringify({ id, role: message.role, sessionID: SESSION }),
            );
            raw.prepare(
                "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                id,
                SESSION,
                at + 1,
                at + 1,
                JSON.stringify({ type: "text", text: message.text }),
            );
        });
        raw.close();
    };
    if (from === 0) {
        if (!isPi) writeRawMessages(0);
        storageMemory.insertMemory(db, {
            projectPath,
            category: "NAMING",
            content: "Baseline memory served by the first HARD fold.",
            sourceType: "historian",
        });
        if (scenario.authority === "module") {
            db.prepare(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, 'module-store', 1)",
            ).run(projectPath);
        }
    }

    const violations: string[] = [];
    const passes: PassRecord[] = [];
    const memoryTokens = (): Set<string> =>
        new Set(
            (
                db.prepare("SELECT content FROM memories").all() as Array<{ content: string }>
            ).flatMap((row) => row.content.match(/tok\d+x\d+x\d+/g) ?? []),
        );
    // Tokens a fold has served: everything promoted before the latest materializing
    // pass.
    // Persisted across process segments so a restart between a promotion and the
    // next fold cannot hide an early showing.
    const foldedPath = join(work, "folded-tokens.json");
    let foldedTokens = new Set<string>(
        existsSync(foldedPath) ? (JSON.parse(readFileSync(foldedPath, "utf8")) as string[]) : [],
    );
    let replyFactsByPublish = new Map<number, string[]>();
    const anchorPath = join(work, "reply-anchors.json");
    const anchorLog: ReplyAnchor[] = existsSync(anchorPath)
        ? (JSON.parse(readFileSync(anchorPath, "utf8")) as ReplyAnchor[])
        : [];

    for (let index = from; index < to; index += 1) {
        const step = steps[index]!;
        if (step === "restart") continue;
        if (step === "user-turn") {
            if (!isPi) writeRawMessages(turnsBefore(index + 1));
            continue;
        }
        if (step === "publish" || step === "bad-publish") {
            const publishCount = publishesBefore(index);
            const bad = step === "bad-publish";
            let promptText = "";
            let replyFacts: string[] = [];
            const respond = (prompt: string) => {
                promptText = prompt;
                const built = historianReply(
                    prompt,
                    scenario.seed,
                    publishCount,
                    scenario.factMode,
                    bad,
                );
                replyFacts = built.facts;
                anchorLog.push(...built.anchors);
                return built.reply;
            };
            const lanes =
                scenario.lane === "enabled"
                    ? isBase
                        ? { autoPromote: false }
                        : { memoryLifecycleLane: "enabled" }
                    : {};
            const holder = `random-holder-${index}`;
            lease.acquireCompartmentLease(db, SESSION, holder);
            try {
                if (isPi) {
                    const { runPiHistorian } = await pi("pi-historian-runner.ts");
                    const rawMessages = messageTexts(scenario.seed, turnsBefore(index)).map(
                        (message, at) => ({
                            ordinal: at + 1,
                            id: `m${at + 1}`,
                            role: message.role,
                            parts: [{ type: "text", text: message.text }],
                        }),
                    );
                    await runPiHistorian({
                        db,
                        sessionId: SESSION,
                        directory: DIRECTORY,
                        allowHomeProject: true,
                        provider: { readMessages: () => rawMessages },
                        runner: {
                            harness: "pi",
                            run: async (options: { userMessage: string }) => ({
                                ok: true,
                                assistantText: respond(options.userMessage),
                                durationMs: 1,
                            }),
                        },
                        historianModel: "test/model",
                        historianChunkTokens: 20_000,
                        historianContextLimit: 200_000,
                        producerContextLimits: new Map([["test/model", 200_000]]),
                        compartmentLeaseHolderId: holder,
                        ensureProjectRegistered: () => undefined,
                        forceDrainQuota: true,
                        ...lanes,
                    });
                } else {
                    const { runCompartmentAgent } = await core(
                        "hooks/magic-context/compartment-runner.ts",
                    );
                    let pending = "";
                    const client =
                        scenario.host === "oc1"
                            ? {
                                  session: {
                                      get: async () => ({ data: { directory: DIRECTORY } }),
                                      create: async () => ({ data: { id: `ses-child-${index}` } }),
                                      prompt: async (input: unknown) => {
                                          const text = findText(input, "<new_messages>");
                                          if (text) pending = respond(text);
                                          return {};
                                      },
                                      messages: async () => ({
                                          data: [
                                              {
                                                  info: { role: "assistant", time: { created: 1 } },
                                                  parts: [{ type: "text", text: pending }],
                                              },
                                          ],
                                      }),
                                      delete: async () => ({}),
                                  },
                              }
                            : undefined;
                    const hiddenCompletionExecutor =
                        scenario.host === "oc2"
                            ? {
                                  capabilities: { tools: false, harness: "opencode2" },
                                  open: async () => ({ id: `hidden-${index}` }),
                                  attempt: async (_handle: unknown, request: unknown) => {
                                      const text = findText(request, "<new_messages>");
                                      if (text) pending = respond(text);
                                  },
                                  collect: async () => ({
                                      text: pending,
                                      reasoning: null,
                                      lengthCapped: false,
                                      usage: {
                                          input: 1,
                                          output: 1,
                                          reasoning: 0,
                                          cacheRead: 0,
                                          cacheWrite: 0,
                                      },
                                  }),
                                  close: async () => {},
                              }
                            : undefined;
                    await runCompartmentAgent(
                        await producer.prepareProducerFixture({
                            client,
                            hiddenCompletionExecutor,
                            db,
                            sessionId: SESSION,
                            historianChunkTokens: 10_000,
                            directory: DIRECTORY,
                            compartmentLeaseHolderId: holder,
                            forceDrainQuota: true,
                            ...lanes,
                        }),
                    );
                }
            } finally {
                lease.releaseCompartmentLease(db, SESSION, holder);
            }
            replyFactsByPublish.set(index, replyFacts);
            passes.push({
                index,
                step,
                served: "",
                materialized: false,
                promptSha: promptText ? sha(promptText) : "<no prompt>",
                replyFacts: replyFacts.length,
            });
            if (scenario.lane === "enabled" || scenario.authority === "module") {
                if (!isBase) {
                    const leaked = replyFacts.filter((token) => memoryTokens().has(token));
                    if (leaked.length > 0) {
                        violations.push(
                            `step ${index}: facts reached memory rows: ${leaked.join(",")}`,
                        );
                    }
                }
            }
            continue;
        }

        // Every other step is a serving pass: optionally flush, inject the memory pair
        // into the session's messages, and keep the served array for comparison.
        if (step === "flush") executeFlush(db, SESSION);
        const busting = step !== "defer";
        let served: string;
        let materialized: boolean;
        if (step === "genuine-hard") lastResponseTime += 1;
        if (isPi) {
            const { injectM0M1Pi, materializeM0Pi } = await pi("inject-compartments-pi.ts");
            const state = {
                sessionId: SESSION,
                projectIdentity: projectPath,
                projectDirectory: DIRECTORY,
                injectDocs: false,
                hardSignals: {
                    systemHash: "system",
                    modelKey: "anthropic/claude",
                    cacheExpired: step === "genuine-hard",
                    lastResponseTime,
                },
            };
            if (step === "hard") materializeM0Pi(state, db);
            const texts = messageTexts(scenario.seed, turnsBefore(index));
            const messages = texts.map((message, at) => ({
                role: message.role,
                content: [{ type: "text", text: message.text }],
                timestamp: at + 1,
            }));
            const entryIds = texts.map((_, at) => `m${at + 1}`);
            const result = injectM0M1Pi(state, db, messages, entryIds, busting);
            served = JSON.stringify(messages);
            materialized = result.m0Materialized === true || step === "hard";
        } else {
            const { injectM0M1, materializeM0 } = await core(
                "hooks/magic-context/inject-compartments.ts",
            );
            const options = () => ({
                db,
                state: storage.getOrCreateSessionMeta(db, SESSION),
                sessionId: SESSION,
                projectPath,
                projectDirectory: DIRECTORY,
                injectDocs: false,
                hardSignals: {
                    systemHash: "system",
                    modelKey: "anthropic/claude",
                    cacheExpired: step === "genuine-hard",
                    lastResponseTime,
                },
            });
            if (step === "hard") materializeM0(options());
            const texts = messageTexts(scenario.seed, turnsBefore(index));
            const messages = texts.map((message, at) => {
                const id = `m-${String(at + 1).padStart(4, "0")}`;
                return {
                    info: { id, role: message.role, sessionID: SESSION },
                    parts: [{ type: "text", text: message.text }],
                };
            });
            const result = injectM0M1({ ...options(), messages, isCacheBustingPass: busting });
            served = JSON.stringify(messages);
            materialized = result.m0RematerializedThisPass === true || step === "hard";
        }
        // When this pass materialized (a "hard" step materializes just before the pass),
        // every token now in memories counts as folded and may be served from here on.
        if (materialized) foldedTokens = memoryTokens();
        const shownTokens = new Set(served.match(/tok\d+x\d+x\d+/g) ?? []);
        if (!isBase) {
            for (const token of shownTokens) {
                if (!foldedTokens.has(token)) {
                    violations.push(
                        `step ${index} (${step}): token ${token} served before a fold included it`,
                    );
                }
            }
        }
        passes.push({ index, step, served, materialized });
    }

    const count = (table: string): number =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)
            ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
            : -1;
    const output: SegmentOutput = {
        passes,
        memories: (
            db
                .prepare("SELECT content, status, source_type FROM memories ORDER BY id")
                .all() as Array<{ content: string; status: string; source_type: string }>
        ).map((row) => ({ content: row.content, status: row.status, source: row.source_type })),
        compartments: (
            db
                .prepare(
                    "SELECT start_message, end_message, title FROM compartments WHERE session_id=? ORDER BY sequence",
                )
                .all(SESSION) as Array<{
                start_message: number;
                end_message: number;
                title: string;
            }>
        ).map((row) => [row.start_message, row.end_message, row.title]),
        turnOne: Object.fromEntries(
            [
                "memory_publications",
                "memory_stage_attempts",
                "memory_pending_facts",
                "memory_fact_blocks",
                "memory_fact_block_links",
                "memory_activity_ledger",
            ].map((table) => [table, count(table)]),
        ),
        anchoredCandidates:
            count("memory_pending_facts") >= 0
                ? (
                      db
                          .prepare(
                              "SELECT COUNT(*) AS n FROM memory_pending_facts WHERE anchor_known=1",
                          )
                          .get() as { n: number }
                  ).n
                : 0,
        commitOrders:
            count("memory_publications") >= 0
                ? (
                      db
                          .prepare("SELECT commit_order FROM memory_publications ORDER BY rowid")
                          .all() as Array<{ commit_order: number | null }>
                  ).map((row) => row.commit_order)
                : [],
        openDbFiles: openDbFiles(),
        violations,
        bindings: { validBound: 0, validUnknown: 0, validUnknownLast: 0, otherBound: 0 },
    };
    replyFactsByPublish = new Map();
    writeFileSync(foldedPath, JSON.stringify([...foldedTokens]));
    writeFileSync(anchorPath, JSON.stringify(anchorLog));
    // How the publisher bound each generated anchor. Only a well-formed anchor may
    // bind, and only to the stored compartment whose range contains the cited lines.
    const bindings = output.bindings;
    if (!isBase && count("memory_pending_facts") > 0) {
        const rows = db
            .prepare(
                `SELECT f.content, f.anchor_known, c.start_message, c.end_message
                 FROM memory_pending_facts f LEFT JOIN compartments c ON c.id = f.compartment_id`,
            )
            .all() as Array<{
            content: string;
            anchor_known: number;
            start_message: number | null;
            end_message: number | null;
        }>;
        for (const row of rows) {
            const token = row.content.match(/tok\d+x\d+x\d+/)?.[0];
            const anchor = anchorLog.find((entry) => entry.token === token);
            if (!anchor) continue;
            if (anchor.kind !== "valid") {
                if (row.anchor_known === 1) {
                    bindings.otherBound += 1;
                    violations.push(`${token}: a ${anchor.kind} anchor was bound`);
                }
                continue;
            }
            if (row.anchor_known !== 1) {
                bindings.validUnknown += 1;
                if (anchor.lastOfReply) bindings.validUnknownLast += 1;
                continue;
            }
            bindings.validBound += 1;
            if (
                row.start_message === null ||
                row.end_message === null ||
                anchor.range[0] < row.start_message ||
                anchor.range[1] > row.end_message
            ) {
                violations.push(
                    `${token}: bound to compartment ${row.start_message}-${row.end_message}, which does not contain ${anchor.range.join("-")}`,
                );
            }
        }
    }
    closeDb();
    return output;
}

function throwawayEnv(work: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
    env.HOME = join(work, "home");
    env.XDG_DATA_HOME = join(work, "data");
    env.XDG_CONFIG_HOME = join(work, "config");
    env.XDG_STATE_HOME = join(work, "state");
    env.XDG_RUNTIME_DIR = join(work, "run");
    env.OPENCODE_DB = join(work, "data", "opencode", "opencode.db");
    env.MAGIC_CONTEXT_STORAGE_DIR = join(work, "data", "cortexkit", "magic-context");
    // Under NODE_ENV=test the storage resolver ignores the variables above and uses a
    // per-process temp directory unless this is set; with it, context.db lives in
    // the throwaway root and survives a restart between process segments.
    env.MAGIC_CONTEXT_TEST_DATA_DIR = join(work, "data");
    for (const key of [
        "HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
    ]) {
        mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
    }
    return env;
}

function runTree(root: string, work: string, scenario: Scenario, isBase: boolean): SegmentOutput[] {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const env = throwawayEnv(work);
    const steps = script(scenario.seed);
    const bounds: number[] = [0];
    steps.forEach((step, at) => {
        if (step === "restart") bounds.push(at + 1);
    });
    bounds.push(steps.length);
    const outputs: SegmentOutput[] = [];
    for (let at = 0; at + 1 < bounds.length; at += 1) {
        const run = spawnSync(
            process.execPath,
            [
                import.meta.path,
                "--segment",
                root,
                work,
                JSON.stringify(scenario),
                isBase ? "base" : "current",
                String(bounds[at]),
                String(bounds[at + 1]),
            ],
            { encoding: "utf8", env, maxBuffer: 512 * 1024 * 1024 },
        );
        const marker = run.stdout.lastIndexOf("\nSEGMENT ");
        if (run.status !== 0 || marker < 0) {
            throw new Error(
                `segment ${at} failed for ${JSON.stringify(scenario)} ${isBase ? "base" : "current"} (status ${run.status}):\n${run.stderr.slice(-6000)}`,
            );
        }
        outputs.push(JSON.parse(run.stdout.slice(marker + "\nSEGMENT ".length)) as SegmentOutput);
    }
    return outputs;
}

function summarize(
    scenario: Scenario,
    base: SegmentOutput[],
    current: SegmentOutput[],
    work: string,
) {
    const flat = (outputs: SegmentOutput[]) => outputs.flatMap((output) => output.passes);
    const basePasses = flat(base);
    const currentPasses = flat(current);
    const differences: string[] = [];
    let servingPasses = 0;
    let identicalServing = 0;
    let publishes = 0;
    let identicalPrompts = 0;
    let materialized = 0;
    currentPasses.forEach((pass, at) => {
        const other = basePasses[at];
        if (!other || other.index !== pass.index) {
            differences.push(`pass list diverges at ${at}`);
            return;
        }
        if (pass.step === "publish" || pass.step === "bad-publish") {
            publishes += 1;
            if (pass.promptSha === other.promptSha) identicalPrompts += 1;
            else if (scenario.lane === "dormant") {
                differences.push(`step ${pass.index} ${pass.step}: historian prompt differs`);
            }
            return;
        }
        servingPasses += 1;
        if (pass.materialized) materialized += 1;
        if (pass.served === other.served && pass.materialized === other.materialized) {
            identicalServing += 1;
        } else {
            differences.push(
                `step ${pass.index} ${pass.step}: served ${pass.served === other.served ? "same" : "DIFFERS"}, materialized base=${other.materialized} current=${pass.materialized}`,
            );
        }
    });
    const last = (outputs: SegmentOutput[]) => outputs[outputs.length - 1]!;
    const baseMemories = JSON.stringify(last(base).memories);
    const currentMemories = JSON.stringify(last(current).memories);
    if (baseMemories !== currentMemories) {
        differences.push(`memories differ: base=${baseMemories} current=${currentMemories}`);
    }
    if (JSON.stringify(last(base).compartments) !== JSON.stringify(last(current).compartments)) {
        differences.push("compartments differ");
    }
    const violations = current.flatMap((output) => output.violations);
    const foreignFiles = current
        .concat(base)
        .flatMap((output) => output.openDbFiles)
        .filter((file) => !file.startsWith(resolve(work)) && !file.startsWith("<no /proc"));
    const commitOrders = last(current).commitOrders.filter((order) => order !== null) as number[];
    const exactlyOnce =
        new Set(commitOrders).size === commitOrders.length &&
        last(current).commitOrders.filter((order) => order === null).length <= 1;
    return {
        label: `${scenario.host}/${scenario.authority}/${scenario.lane}/${scenario.factMode}/seed${scenario.seed}`,
        servingPasses,
        identicalServing,
        materialized,
        publishes,
        identicalPrompts,
        restarts: current.length - 1,
        differences,
        violations,
        foreignFiles,
        turnOne: { ...last(current).turnOne, anchored: last(current).anchoredCandidates },
        bindings: last(current).bindings,
        promoted: last(current).memories.filter((memory) => /tok\d+x/.test(memory.content)).length,
        shownTokens: new Set(
            current.flatMap((output) =>
                output.passes.flatMap((pass) => pass.served.match(/tok\d+x\d+x\d+/g) ?? []),
            ),
        ).size,
        commitOrders: last(current).commitOrders,
        exactlyOnce,
        openDbFiles: [...new Set(current.flatMap((output) => output.openDbFiles))],
    };
}

async function main(): Promise<void> {
    if (process.argv[2] === "--segment") {
        const [, , , root, work, scenarioJson, which, from, to] = process.argv;
        const output = await runSegment(
            root!,
            work!,
            JSON.parse(scenarioJson!) as Scenario,
            which === "base",
            Number(from),
            Number(to),
        );
        process.stdout.write(`\nSEGMENT ${JSON.stringify(output)}\n`);
        process.exit(0);
    }
    const [, , baseRoot, currentRoot, scratch, seedsArg, firstSeedArg] = process.argv;
    if (!baseRoot || !currentRoot || !scratch) {
        throw new Error("usage: <base-root> <current-root> <throwaway-dir> [seeds] [first-seed]");
    }
    const seeds = Number(seedsArg ?? 4);
    const firstSeed = Number(firstSeedArg ?? 1);
    const scenarios: Scenario[] = [];
    for (let seed = firstSeed; seed < firstSeed + seeds; seed += 1) {
        for (const host of ["oc1", "oc2", "pi"] as const) {
            for (const authority of ["ts", "module"] as const) {
                scenarios.push({ host, authority, lane: "dormant", factMode: "plain", seed });
                scenarios.push({ host, authority, lane: "dormant", factMode: "prefixed", seed });
                scenarios.push({ host, authority, lane: "enabled", factMode: "prefixed", seed });
            }
        }
    }
    const totals = { scenarios: 0, failing: 0, serving: 0, identical: 0, publishes: 0 };
    for (const scenario of scenarios) {
        const work = join(
            scratch,
            `${scenario.host}-${scenario.authority}-${scenario.lane}-${scenario.factMode}-${scenario.seed}`,
        );
        const base = runTree(baseRoot, join(work, "base"), scenario, true);
        const current = runTree(currentRoot, join(work, "current"), scenario, false);
        const summary = summarize(scenario, base, current, work);
        totals.scenarios += 1;
        totals.serving += summary.servingPasses;
        totals.identical += summary.identicalServing;
        totals.publishes += summary.publishes;
        const failing =
            summary.differences.length > 0 ||
            summary.violations.length > 0 ||
            summary.foreignFiles.length > 0 ||
            !summary.exactlyOnce;
        if (failing) totals.failing += 1;
        console.log(
            `${failing ? "FAIL" : "ok  "} ${summary.label}: ${summary.identicalServing}/${summary.servingPasses} serving passes identical (${summary.materialized} materialized), prompts ${summary.identicalPrompts}/${summary.publishes} identical, restarts=${summary.restarts}, promoted=${summary.promoted} shownTokens=${summary.shownTokens} bindings=${JSON.stringify(summary.bindings)} turnOne=${JSON.stringify(summary.turnOne)} commitOrders=${JSON.stringify(summary.commitOrders)}`,
        );
        for (const line of [...summary.differences, ...summary.violations].slice(0, 8)) {
            console.log(`     ${line.slice(0, 600)}`);
        }
        if (summary.foreignFiles.length > 0)
            console.log(`     FOREIGN DB FILES: ${summary.foreignFiles.join(", ")}`);
        if (totals.scenarios === 1)
            console.log(`     open .db files: ${summary.openDbFiles.join(", ")}`);
        rmSync(work, { recursive: true, force: true });
    }
    console.log(
        `TOTAL scenarios=${totals.scenarios} failing=${totals.failing} serving passes identical ${totals.identical}/${totals.serving}, publishes=${totals.publishes}`,
    );
    process.exit(totals.failing === 0 ? 0 : 1);
}

await main();
