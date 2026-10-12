/**
 * Cross-commit differential for the historian turn-one publication on the dormant
 * lane, the only one production runs (no transport makes the provider enforce a JSON
 * response schema yet, so turn one keeps its existing prompt and promotion). It runs
 * one scripted session on two source trees, each in its own process, and compares the
 * served memory pair (m[0] bytes and m[1] text) pass by pass: a HARD fold, SOFT passes
 * (passes that may rewrite m[1] and so break the provider's prompt cache) and defer
 * passes (which replay the stored bytes), a real historian publish through the
 * production runner, more defer and SOFT passes, then a HARD forced by provider cache
 * expiry (a real fold trigger, not a test-forced rebuild) and a few passes after it.
 *
 * Usage (from a checkout whose node_modules are installed):
 *   git archive <base-commit> packages/plugin packages/pi-plugin packages/retina-local-fs | tar -x -C <base>
 *   ln -s "$PWD/node_modules" <base>/node_modules  (and the same for each package's node_modules)
 *   bun packages/plugin/src/hooks/magic-context/turn-one-base-differential.probe.ts <base> <current>
 *
 * Each scenario (OpenCode or Pi; memory owned by TypeScript or by the Rust module)
 * prints one line per pass and fails when any pass differs. It also checks that the
 * fact promoted at the publish stays out of every SOFT and defer pass and appears at
 * the cache-expiry HARD.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Step = "hard" | "soft" | "defer" | "publish" | "genuine-hard";
type Host = "opencode" | "pi";
type Authority = "ts" | "module";

interface ServedPass {
    step: Step;
    m0: string;
    m1: string;
    materialized: boolean;
}

interface Emitted {
    passes: ServedPass[];
    memories: string[];
    pendingFacts: number;
    publications: number;
}

const STEPS: Step[] = [
    "hard",
    "soft",
    "defer",
    "soft",
    "defer",
    "publish",
    "defer",
    "defer",
    "defer",
    "defer",
    "defer",
    "defer",
    "soft",
    "defer",
    "defer",
    "defer",
    "soft",
    "defer",
    "genuine-hard",
    "defer",
    "soft",
    "defer",
    "defer",
];
const PROMOTED = "Uploads are capped at 64 KiB.";
const DIRECTORY = "/tmp/mc-turn-one-differential-project";
const SESSION = "ses-turn-one-differential";

// biome-ignore lint/suspicious/noExplicitAny: modules are loaded from a tree chosen at run time.
type AnyModule = any;

async function emitOpenCode(root: string, authority: Authority): Promise<Emitted> {
    const load = (rel: string): Promise<AnyModule> =>
        import(join(root, "packages/plugin/src", rel));
    const xdg = mkdtempSync(join(tmpdir(), "mc-turn-one-diff-oc-"));
    process.env.XDG_DATA_HOME = xdg;
    const { Database } = await load("shared/sqlite.ts");
    const storage = await load("features/magic-context/storage.ts");
    const { insertMemory, getMemoriesByProject } = await load(
        "features/magic-context/memory/storage-memory.ts",
    );
    const { resolveProjectIdentity } = await load(
        "features/magic-context/memory/project-identity.ts",
    );
    const lease = await load("features/magic-context/compartment-lease.ts");
    const { runCompartmentAgent } = await load("hooks/magic-context/compartment-runner.ts");
    const producer = await load("hooks/magic-context/producer-window-test-support.ts");
    const { __ignoredNotificationTest } = await load(
        "hooks/magic-context/send-session-notification.ts",
    );
    const { injectM0M1, materializeM0 } = await load("hooks/magic-context/inject-compartments.ts");

    const opencodePath = join(xdg, "opencode", "opencode.db");
    mkdirSync(dirname(opencodePath), { recursive: true });
    const raw = new Database(opencodePath);
    raw.exec(`
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    const texts = [
        "Cap the upload at 64 KiB.",
        "Done, the cap is in place.",
        "Also route uploads through the gateway.",
        "Routed.",
        "protected 1",
        "protected 2",
        "protected 3",
        "protected 4",
        "protected 5",
    ];
    texts.forEach((text, index) => {
        const id = `m-${index + 1}`;
        const role = index < 4 && index % 2 === 1 ? "assistant" : "user";
        raw.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(id, SESSION, index + 1, index + 1, JSON.stringify({ id, role, sessionID: SESSION }));
        raw.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(id, SESSION, index + 1, index + 1, JSON.stringify({ type: "text", text }));
    });
    raw.close();

    const db = storage.openDatabase();
    const projectPath = resolveProjectIdentity(DIRECTORY);
    // The baseline memory exists before the module takes memory authority.
    insertMemory(db, {
        projectPath,
        category: "NAMING",
        content: "Baseline memory served by the HARD fold.",
        sourceType: "historian",
    });
    if (authority === "module") {
        db.prepare(
            "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, 'module-store', 1)",
        ).run(projectPath);
    }
    const renderOptions = (cacheExpired: boolean) => ({
        db,
        state: storage.getOrCreateSessionMeta(db, SESSION),
        sessionId: SESSION,
        projectPath,
        projectDirectory: DIRECTORY,
        injectDocs: false,
        hardSignals: {
            systemHash: "system",
            modelKey: "anthropic/claude",
            cacheExpired,
            lastResponseTime: cacheExpired ? Date.now() + 60_000 : 1,
        },
    });
    const reply = `<output><compartments>
<compartment start="1" end="4" title="Upload cap and gateway"><p1>Capped uploads and routed them through the gateway.</p1></compartment>
</compartments>
<facts>
<CONSTRAINTS>
* ${PROMOTED}
</CONSTRAINTS>
</facts>
</output>`;
    const client = {
        session: {
            get: async () => ({ data: { directory: DIRECTORY } }),
            create: async () => ({ data: { id: "ses-historian-child" } }),
            prompt: async () => ({}),
            messages: async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [{ type: "text", text: reply }],
                    },
                ],
            }),
            delete: async () => ({}),
        },
    };
    await producer.observeProducerModelsForTest(["test/fixture-historian"]);
    __ignoredNotificationTest.setHoldDetector(() => false);

    const passes: ServedPass[] = [];
    for (const step of STEPS) {
        if (step === "publish") {
            const holder = "differential-holder";
            lease.acquireCompartmentLease(db, SESSION, holder);
            await runCompartmentAgent(
                await producer.prepareProducerFixture({
                    client,
                    db,
                    sessionId: SESSION,
                    historianChunkTokens: 10_000,
                    directory: DIRECTORY,
                    compartmentLeaseHolderId: holder,
                }),
            );
            lease.releaseCompartmentLease(db, SESSION, holder);
            continue;
        }
        if (step === "hard") {
            materializeM0(renderOptions(false));
        }
        const result = injectM0M1({
            ...renderOptions(step === "genuine-hard"),
            isCacheBustingPass: step !== "defer",
        });
        passes.push({
            step,
            m0: result.m0Bytes?.toString("utf8") ?? "",
            m1: result.m1Text ?? "",
            materialized: result.m0RematerializedThisPass,
        });
    }
    const count = (table: string) =>
        db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name=?`).get(table)
            ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
            : 0;
    const emitted: Emitted = {
        passes,
        memories: getMemoriesByProject(db, projectPath).map(
            (memory: { content: string }) => memory.content,
        ),
        pendingFacts: count("memory_pending_facts"),
        publications: count("memory_publications"),
    };
    storage.closeDatabase();
    rmSync(xdg, { recursive: true, force: true });
    return emitted;
}

async function emitPi(root: string, authority: Authority): Promise<Emitted> {
    const core = (rel: string): Promise<AnyModule> =>
        import(join(root, "packages/plugin/src", rel));
    const pi = (rel: string): Promise<AnyModule> =>
        import(join(root, "packages/pi-plugin/src", rel));
    const { createTestDb } = await pi("test-utils.test.ts");
    const { runPiHistorian } = await pi("pi-historian-runner.ts");
    const { injectM0M1Pi, materializeM0Pi } = await pi("inject-compartments-pi.ts");
    const lease = await core("features/magic-context/compartment-lease.ts");
    const { insertMemory, getMemoriesByProject } = await core(
        "features/magic-context/memory/storage-memory.ts",
    );
    const { resolveProjectIdentityForSession } = await core(
        "features/magic-context/memory/project-identity.ts",
    );
    const db = createTestDb();
    const projectPath = resolveProjectIdentityForSession(DIRECTORY, true);
    // The baseline memory exists before the module takes memory authority.
    insertMemory(db, {
        projectPath,
        category: "NAMING",
        content: "Baseline memory served by the HARD fold.",
        sourceType: "historian",
    });
    if (authority === "module") {
        db.prepare(
            "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, 'module-store', 1)",
        ).run(projectPath);
    }
    const rawMessages = Array.from({ length: 12 }, (_, index) => {
        const ordinal = index + 1;
        const user = ordinal % 2 === 1;
        return {
            ordinal,
            id: `m${ordinal}`,
            role: user ? "user" : "assistant",
            parts: [
                {
                    type: "text",
                    text: user ? `User request ${ordinal}` : `Assistant response ${ordinal}`,
                },
            ],
        };
    });
    const reply = `<compartment start="1" end="2" title="Initial Pi slice"><p1>Summarized the first Pi turn.</p1></compartment>
<CONSTRAINTS>
* ${PROMOTED}
</CONSTRAINTS>`;
    const state = (cacheExpired: boolean) => ({
        sessionId: SESSION,
        projectIdentity: projectPath,
        projectDirectory: DIRECTORY,
        injectDocs: false,
        hardSignals: {
            systemHash: "system",
            modelKey: "anthropic/claude",
            cacheExpired,
            lastResponseTime: cacheExpired ? Date.now() + 60_000 : 1,
        },
    });
    const textOf = (message: AnyModule): string => {
        const content = message?.content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
            .flatMap((part: { type?: string; text?: string }) =>
                part.type === "text" && typeof part.text === "string" ? [part.text] : [],
            )
            .join("");
    };
    const passes: ServedPass[] = [];
    for (const step of STEPS) {
        if (step === "publish") {
            const holder = "differential-holder";
            lease.acquireCompartmentLease(db, SESSION, holder);
            await runPiHistorian({
                db,
                sessionId: SESSION,
                directory: DIRECTORY,
                allowHomeProject: true,
                provider: { readMessages: () => rawMessages },
                runner: {
                    harness: "pi",
                    run: async () => ({ ok: true, assistantText: reply, durationMs: 1 }),
                },
                historianModel: "test/model",
                historianChunkTokens: 20_000,
                historianContextLimit: 200_000,
                producerContextLimits: new Map([["test/model", 200_000]]),
                compartmentLeaseHolderId: holder,
                ensureProjectRegistered: () => undefined,
            });
            lease.releaseCompartmentLease(db, SESSION, holder);
            continue;
        }
        if (step === "hard") materializeM0Pi(state(false), db);
        const messages: unknown[] = [];
        const result = injectM0M1Pi(
            state(step === "genuine-hard"),
            db,
            messages,
            undefined,
            step !== "defer",
        );
        passes.push({
            step,
            m0: textOf(messages[0]),
            m1: textOf(messages[1]),
            materialized: result.m0Materialized,
        });
    }
    const count = (table: string) =>
        db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name=?`).get(table)
            ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
            : 0;
    const emitted: Emitted = {
        passes,
        memories: getMemoriesByProject(db, projectPath).map(
            (memory: { content: string }) => memory.content,
        ),
        pendingFacts: count("memory_pending_facts"),
        publications: count("memory_publications"),
    };
    db.close();
    return emitted;
}

function emitIn(root: string, host: Host, authority: Authority): Emitted {
    const run = spawnSync(process.execPath, [import.meta.path, "--emit", root, host, authority], {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
        maxBuffer: 256 * 1024 * 1024,
    });
    const marker = run.stdout.lastIndexOf("\nEMITTED ");
    if (run.status !== 0 || marker < 0) {
        throw new Error(
            `emit failed for ${root} ${host} ${authority} (status ${run.status}):\n${run.stderr.slice(-4000)}`,
        );
    }
    return JSON.parse(run.stdout.slice(marker + "\nEMITTED ".length)) as Emitted;
}

async function main(): Promise<void> {
    if (process.argv[2] === "--emit") {
        const [, , , root, host, authority] = process.argv;
        const emitted =
            host === "pi"
                ? await emitPi(root, authority as Authority)
                : await emitOpenCode(root, authority as Authority);
        process.stdout.write(`\nEMITTED ${JSON.stringify(emitted)}\n`);
        process.exit(0);
    }
    const [, , base, current] = process.argv;
    let failures = 0;
    for (const host of ["opencode", "pi"] as const) {
        for (const authority of ["ts", "module"] as const) {
            const before = emitIn(base, host, authority);
            const after = emitIn(current, host, authority);
            const label = `${host}/${authority}-owned`;
            if (before.passes.length !== after.passes.length) {
                failures += 1;
                console.log(`${label}: pass count differs`);
                continue;
            }
            const publishAt = STEPS.indexOf("publish");
            const afterPublish = STEPS.flatMap((step, position) =>
                step === "publish" ? [] : [position > publishAt],
            );
            let hard = false;
            let identical = 0;
            after.passes.forEach((a, index) => {
                const b = before.passes[index];
                const same = a.m0 === b.m0 && a.m1 === b.m1 && a.materialized === b.materialized;
                if (same) identical += 1;
                else failures += 1;
                if (afterPublish[index] && a.step === "genuine-hard") hard = true;
                const shown = `${a.m0}${a.m1}`.includes(PROMOTED);
                // Only a TypeScript-owned project promotes the fact; it may show only
                // from the genuine HARD on.
                const expectShown = authority === "ts" && hard;
                const visibility =
                    afterPublish[index] && shown !== expectShown
                        ? ` VISIBILITY-MISMATCH(shown=${shown})`
                        : "";
                if (visibility) failures += 1;
                console.log(
                    `${label} pass ${String(index + 1).padStart(2)} ${a.step.padEnd(12)} ${same ? "identical" : "DIFFERS"} m0=${a.m0.length}B m1=${a.m1.length}B materialized=${a.materialized} promoted-shown=${shown}${visibility}`,
                );
            });
            console.log(
                `${label}: ${identical}/${after.passes.length} passes byte-identical; memories base=${JSON.stringify(before.memories)} current=${JSON.stringify(after.memories)}; candidates base=${before.pendingFacts} current=${after.pendingFacts}; publications base=${before.publications} current=${after.publications}`,
            );
        }
    }
    console.log(failures === 0 ? "DIFFERENTIAL PASSED" : `DIFFERENTIAL FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
}

await main();
