import { expect, spyOn, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../../../../features/magic-context/migrations";
import { initializeDatabase } from "../../../../features/magic-context/storage-db";
import { Database } from "../../../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../../shared/test-temp-dir";
import { setRawMessageProvider } from "../../read-session-chunk";
import type { MessageLike } from "../../transform-operations";
import { createBridgeAdapter } from "../bridge-adapter";
import { ProviderClient } from "../provider-client";
import { oracleCommand } from "./oracle";

const SESSION = "relay-v1";
const ORACLE = "providers::relay_conformance::pending_watermark_oracle";
const base = join(tmpdir(), "magic-context/bridge-tag-reference");

function startOracle(root: string) {
    const child = Bun.spawn(oracleCommand(ORACLE), {
        windowsHide: true,
        cwd: resolve(import.meta.dir, "../../../../../../.."),
        env: {
            ...process.env,
            MC_PENDING_WATERMARK_ROOT: root,
            RUSTC_WRAPPER: "",
            CARGO_BUILD_RUSTC_WRAPPER: "",
            // The policy replay checker compares incremental and fully rebuilt
            // inputs. After a drop is applied, their baseline_generation values
            // disagree. Disable that test-only assertion, not the policy.
            MC_POLICY_SUMMARY_SKIP_FULL_CHECK: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
    });
    const lines = (async function* () {
        let pending = "";
        const decoder = new TextDecoder();
        for await (const chunk of child.stdout) {
            pending += decoder.decode(chunk, { stream: true });
            const parts = pending.split("\n");
            pending = parts.pop() ?? "";
            for (const line of parts)
                if (line.startsWith("PENDING_ORACLE ")) yield JSON.parse(line.slice(15)) as string;
        }
    })();
    return {
        async call(request: unknown): Promise<any> {
            child.stdin.write(`${JSON.stringify(request)}\n`);
            await child.stdin.flush();
            const result = await lines.next();
            if (result.done) throw new Error(`watermark oracle exited ${await child.exited}`);
            return JSON.parse(result.value);
        },
        async close() {
            await child.stdin.end();
            for await (const _ of lines) {
                /* Drain the libtest footer before awaiting exit. */
            }
            expect(await child.exited).toBe(0);
        },
    };
}

function message(turn: number, assistant: boolean, model: string): MessageLike {
    const id = `${assistant ? "a" : "u"}${turn}`;
    return {
        info: {
            id,
            sessionID: SESSION,
            role: assistant ? "assistant" : "user",
            model: { providerID: "openai", modelID: model },
            time: { created: 1_800_000_000_000 + turn * 1000 },
        },
        parts: assistant
            ? [
                  { id: `${id}-text`, type: "text", text: `Finished synthetic turn ${turn}.` },
                  {
                      id: `${id}-tool`,
                      type: "tool",
                      callID: `call-${turn}`,
                      tool: "read",
                      state: {
                          status: "completed",
                          input: { filePath: `synthetic-${turn}.txt` },
                          output: `PAYLOAD-${turn}: ${"synthetic read output ".repeat(20)}`,
                      },
                  },
              ]
            : [
                  {
                      id: `${id}-text`,
                      type: "text",
                      text: `Inspect synthetic file ${turn}; keep the useful facts.`,
                  },
              ],
    } as MessageLike;
}

function snapshot(root: string) {
    const db = new Database(join(root, "oracle.db"), { readonly: true });
    try {
        const tables = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'mc_provider_%' OR name IN ('mc_tags','pending_agent_drops')) ORDER BY name",
            )
            .all() as { name: string }[];
        const counts = Object.fromEntries(
            tables.map(({ name }) => [
                name,
                (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n,
            ]),
        );
        return {
            counts,
            answers: db
                .prepare(
                    "SELECT state, count(*) AS n FROM mc_provider_hook_answers_v1 GROUP BY state",
                )
                .all(),
            queued: db
                .prepare("SELECT tag_number FROM mc_provider_pending_drops_v1 ORDER BY tag_number")
                .all(),
            consumed: db
                .prepare("SELECT tag_number FROM mc_provider_consumed_tags_v1 ORDER BY tag_number")
                .all(),
            conversation: db
                .prepare(
                    "SELECT served_through_ordinal, json_extract(hook_counters_json,'$.reserved_tag_high_water') AS reserved_tag_high_water FROM mc_provider_conversations_v2",
                )
                .get(),
            policy: db
                .prepare(
                    "SELECT json_extract(policy_json,'$.served') AS served, count(*) AS n FROM mc_provider_policy_parts_v1 GROUP BY served",
                )
                .all(),
            tagKinds: db.prepare("SELECT kind,count(*) AS n FROM mc_tags GROUP BY kind").all(),
            targetTreatments: db
                .prepare(
                    "SELECT version,mid,block_id,patch_json FROM mc_provider_view_overrides_v1 WHERE mid IN ('a18','a68','a128') ORDER BY version,mid,block_index",
                )
                .all(),
            pages: db.prepare("PRAGMA page_count").get(),
            freelist: db.prepare("PRAGMA freelist_count").get(),
            files: Object.fromEntries(
                ["oracle.db", "oracle.db-wal", "context.db", "context.db-wal"].map((name) => {
                    try {
                        return [name, statSync(join(root, name)).size];
                    } catch {
                        return [name, 0];
                    }
                }),
            ),
        };
    } finally {
        db.close();
    }
}

async function runSession(clean: boolean, root: string) {
    mkdirSync(root, { recursive: true });
    const configPath = join(root, "selected.jsonc");
    writeFileSync(
        configPath,
        JSON.stringify({
            historian: { disable: true },
            memory: { enabled: false },
            protected_tokens: 0,
            protected_tools: {},
            cache_ttl: "10m",
        }),
    );
    const db = new Database(join(root, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    const oracle = startOracle(root);
    // Start Rust before the bridge runs so compilation is not timed as request work.
    await oracle.call({ method: "session.status", v: 1, session_id: SESSION });
    const rows: MessageLike[] = [];
    const rawRows = () =>
        rows.map((m, i) => ({
            id: m.info.id!,
            role: m.info.role!,
            parts: m.parts,
            createdAt: 1_800_000_000_000 + i * 1000,
            ordinal: i + 1,
        }));
    const unregister = setRawMessageProvider(SESSION, {
        readMessages: rawRows,
        readMessageById: (id) => rawRows().find((row) => row.id === id) ?? null,
        readMessagePartsById: (id) => rawRows().find((row) => row.id === id) ?? null,
        readMessageOrdinalById: (id) => rawRows().find((row) => row.id === id)?.ordinal ?? null,
        getStoredMessageCount: () => rows.length,
        getMessageCount: () => rows.length,
        hasMessageById: (id) => rows.some((m) => m.info.id === id),
        readMessageOrdinalPage: (after, limit) =>
            rows
                .map((m, i) => ({
                    id: m.info.id!,
                    timeCreated: i + 1,
                    contributesOrdinal: true,
                    hasValidInfo: true,
                }))
                .filter((row) => !after || row.timeCreated > after.timeCreated)
                .slice(0, limit),
    });
    const exchanges: any[] = [];
    const slowHooks: any[] = [];
    let pass = 0;
    const adapter = createBridgeAdapter({
        projectRoot: root,
        connectionFile: join(root, "unused.json"),
        storageDir: root,
        configPath,
        openCodeClient: { session: {} } as any,
        transport: {
            async request(method, body, opts) {
                const request = JSON.parse(Buffer.from(body).toString());
                const started = performance.now();
                const answer = await oracle.call(request);
                const hookMs =
                    Date.now() - (opts.deadlineMs - Number(request.params?.budget_ms ?? 0));
                if (method === "transform.hook" && hookMs > 1500)
                    slowHooks.push({
                        pass,
                        hook: request.params?.hook,
                        ms: hookMs,
                        rpcMs: performance.now() - started,
                    });
                if (method === "compaction.step")
                    exchanges.push({
                        pass,
                        method,
                        request: { ...request.params, messages: request.params.messages?.length },
                        answer: {
                            ...answer,
                            compaction: answer.compaction
                                ? {
                                      ...answer.compaction,
                                      replacement: answer.compaction.replacement?.length,
                                  }
                                : undefined,
                        },
                    });
                else if (answer.answer === "error" || answer.answer === "refused")
                    exchanges.push({ pass, method, answer });
                return Buffer.from(JSON.stringify(answer));
            },
        },
    });
    const intervals: any[] = [];
    const drops: any[] = [];
    const receipts: any[] = [];
    const progress: any[] = [];
    const landings: any[] = [];
    let model = "gpt-5.6";
    try {
        for (let turn = 1; turn <= 160; turn++) {
            pass = turn;
            if ([60, 120].includes(turn)) {
                await oracle.call({
                    control: "publish",
                    sequence: turn / 60 - 1,
                    start_ordinal: turn === 60 ? 1 : 81,
                    start_mid: turn === 60 ? "u1" : "u41",
                    ordinal: (turn - 20) * 2,
                    end_mid: `a${turn - 20}`,
                    content: `Synthetic history through turn ${turn - 20}.`,
                });
                model = model === "gpt-5.6" ? "gpt-5.5" : "gpt-5.6";
            }
            if (turn === 150) {
                await oracle.call({ control: "pressure", tokens: 180_000 });
                model = "fixture-force-band";
            }
            rows.push(message(turn, false, model));
            const view = await adapter.run({ sessionId: SESSION, messages: rows, kind: "model" });
            const receipt = adapter.completeRequest(SESSION, view.receipt.request_id, {
                status: 200,
                cleanEnd: clean,
            });
            if (turn === 149)
                adapter.recordProviderUsage(SESSION, {
                    messages: view.messages,
                    inputTokens: 180_000,
                    model: "openai/gpt-5.6",
                    envelope: "synthetic-system-and-tools",
                });
            if ([60, 120, 150].includes(turn))
                landings.push({
                    turn,
                    targets: [18, 68, 128].map((n) => ({
                        id: `a${n}`,
                        message: view.messages.find((m) => m.info.id === `a${n}`) ?? null,
                    })),
                });
            if ([1, 30, 60, 90, 120, 150, 160].includes(turn))
                receipts.push({ turn, kind: view.kind, receipt });
            if ([20, 70, 130].includes(turn)) {
                const moduleDb = new Database(join(root, "oracle.db"), { readonly: true });
                const answer = moduleDb
                    .prepare(
                        "SELECT tags_json FROM mc_provider_hook_answers_v1 WHERE hook='post_tool' AND subject_mid=? ORDER BY answer_seq DESC LIMIT 1",
                    )
                    .get(`a${turn - 2}`) as { tags_json: string };
                moduleDb.close();
                const tags = JSON.parse(answer.tags_json);
                const numbers = tags.map((tag: any) => tag.number);
                const result = await oracle.call({
                    name: "ctx_reduce",
                    arguments: { drop: numbers.join(",") },
                });
                drops.push({ turn, target: `a${turn - 2}`, numbers, result });
            }
            if (turn >= 20) {
                const moduleDb = new Database(join(root, "oracle.db"), { readonly: true });
                const state = {
                    queued: moduleDb
                        .prepare(
                            "SELECT tag_number FROM mc_provider_pending_drops_v1 ORDER BY tag_number",
                        )
                        .all(),
                    consumed: moduleDb
                        .prepare(
                            "SELECT tag_number FROM mc_provider_consumed_tags_v1 ORDER BY tag_number",
                        )
                        .all(),
                    visiblePayloads: [18, 68, 128].filter((n) =>
                        JSON.stringify(view.messages).includes(`PAYLOAD-${n}:`),
                    ),
                };
                moduleDb.close();
                if (JSON.stringify(progress.at(-1)?.state) !== JSON.stringify(state))
                    progress.push({ turn, state });
            }
            if ([1, 30, 60, 90, 120, 150, 160].includes(turn)) {
                intervals.push({
                    turn,
                    snapshot: snapshot(root),
                    status: await oracle.call({
                        method: "session.status",
                        v: 1,
                        session_id: SESSION,
                    }),
                });
            }
            rows.push(message(turn, true, model));
        }
        return {
            clean,
            root,
            fixtureHookBudgetMs: 10_000,
            slowHooks,
            fixturePressure: { turn: 150, request_tokens: 180_000 },
            drops,
            progress,
            landings,
            receipts,
            intervals,
            exchanges,
        };
    } catch (error) {
        console.error(
            "WATERMARK_FAILURE",
            JSON.stringify({ clean, pass, exchanges, drops, progress }),
        );
        throw error;
    } finally {
        await adapter.dispose();
        unregister();
        db.close();
        await oracle.close();
    }
}

test("real bridge pending watermark versus clean control over 160 tool turns", async () => {
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, "probe-"));
    const oldConfig = process.env.MAGIC_CONTEXT_CONFIG_PATH;
    process.env.MAGIC_CONTEXT_CONFIG_PATH = join(root, "empty-user.jsonc");
    writeFileSync(process.env.MAGIC_CONTEXT_CONFIG_PATH, "{}");
    // The Rust test service advertises 10-second hook budgets in both the pending
    // and clean runs so shared-runner stalls do not burn tags. Raise the client's
    // matching cap too; per-pass deadlines and compaction budgets stay unchanged.
    const budget = spyOn(
        ProviderClient.prototype as unknown as { budget(ms: number): number },
        "budget",
    ).mockImplementation((ms) => Math.min(ms, 10_000));
    try {
        const pending = await runSession(false, join(root, "pending"));
        const clean = await runSession(true, join(root, "clean"));
        const output = { schema: "bridge-pending-watermark/v1", turns: 160, pending, clean };
        console.log(`WATERMARK_RESULT ${JSON.stringify(output)}`);
        expect(pending.receipts.every((row) => row.receipt.served_through_ordinal === 0)).toBe(
            true,
        );
        expect(clean.receipts.at(-1).receipt.served_through_ordinal).toBe(319);
        expect(pending.drops).toHaveLength(3);
        expect(clean.drops).toHaveLength(3);
        expect(pending.drops.every((drop) => drop.result.isError === false)).toBe(true);
        expect(clean.drops.every((drop) => drop.result.isError === false)).toBe(true);
        for (const run of [pending, clean]) {
            expect(
                run.exchanges.every(
                    (row) =>
                        row.request.estimate.request_tokens === 0 &&
                        row.request.previous_usage === undefined,
                ),
            ).toBe(true);
            expect(
                run.exchanges
                    .filter((row) => row.method === "compaction.step")
                    .map((row) => row.pass),
            ).toEqual([1, 60, 120, 150]);
            expect(
                run.receipts
                    .filter((row) => row.turn === 60 || row.turn === 120)
                    .map((row) => row.receipt.coverage.ordinal),
            ).toEqual([80, 200]);
            expect(
                run.intervals.at(-1).status.pass_trace.scheduler_history.at(-1).scheduler_decision,
            ).toBe("Force85");
            expect(run.intervals.at(-1).snapshot.counts.mc_provider_hook_answers_v1).toBe(477);
        }
        for (const run of [pending, clean]) {
            expect(run.progress.at(-1).state.queued).toEqual([]);
            expect(run.progress.at(-1).state.consumed).toEqual([
                { tag_number: 53 },
                { tag_number: 203 },
                { tag_number: 383 },
            ]);
            expect(
                run.progress
                    .filter(
                        (row, i) =>
                            row.state.consumed.length >
                            (run.progress[i - 1]?.state.consumed.length ?? 0),
                    )
                    .map((row) => row.turn),
            ).toEqual([60, 120, 150]);
            expect(run.intervals.find((row) => row.turn === 30).status.pending_drop_count).toBe(1);
            expect(run.intervals.at(-1).status.pending_drop_count).toBe(0);
            expect(run.intervals.at(-1).status.provider_applied_drop_count).toBe(3);
        }
        expect(pending.intervals.at(-1).snapshot.answers).toEqual([{ state: "pending", n: 477 }]);
        expect(clean.intervals.at(-1).snapshot.answers).toEqual([
            { state: "live", n: 474 },
            { state: "pending", n: 3 },
        ]);
    } finally {
        budget.mockRestore();
        if (oldConfig === undefined) delete process.env.MAGIC_CONTEXT_CONFIG_PATH;
        else process.env.MAGIC_CONTEXT_CONFIG_PATH = oldConfig;
        cleanupTestTempDir(root);
    }
}, 240_000);
