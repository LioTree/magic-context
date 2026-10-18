// Run explicitly: bun test ./benchmarks/paired-write-hold.bench.ts
import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measuredPassSchedule } from "../../../scripts/paired-write-hold-protocol";
import { runMigrations } from "../src/features/magic-context/migrations";
import {
    getOrCreateSessionMeta,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../src/features/magic-context/storage";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { createTagger } from "../src/features/magic-context/tagger";
import { Database } from "../src/shared/sqlite";
import * as timing from "../src/shared/write-transaction-timing";
import * as pairing from "../src/hooks/magic-context/paired-thinking-edit";
import { createTransform } from "../src/hooks/magic-context/transform";
import type { MessageLike } from "../src/hooks/magic-context/tag-messages";

const turns = Number(process.env.HOLD_TURNS ?? 1300);
const passes = Number(process.env.HOLD_PASSES ?? 200);
const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };

for (const generation of ["v1", "v2"] as const)
    if (!process.env.HOLD_TS_GENERATION || process.env.HOLD_TS_GENERATION === generation)
        it(`TS ${generation} lane and final representation paired holds`, async () => {
            const dir = mkdtempSync(join(tmpdir(), `ts-${generation}-hold-`));
            const db = new Database(join(dir, "context.db"));
            initializeDatabase(db);
            runMigrations(db);
            const sessionId = `ts-${generation}-hold`;
            getOrCreateSessionMeta(db, sessionId);
            updateSessionMeta(db, sessionId, { cacheTtl: "59m", lastResponseTime: Date.now() });
            const pending = new Set<string>();
            let decision: "execute" | "defer" = "defer";
            let busted: boolean | undefined;
            const transform = createTransform({
                db,
                storeGeneration: generation,
                signedThinkingHold: "on",
                tagger: createTagger(),
                scheduler: { shouldExecute: () => decision } as never,
                liveModelBySession: new Map([[sessionId, model]]),
                contextUsageMap: new Map(),
                protectedTokens: 4000,
                historianRunnable: false,
                directory: dir,
                sessionDirectoryBySession: new Map([[sessionId, dir]]),
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: pending,
                lastHeuristicsTurnId: new Map(),
                smartDrops: true,
                keepReasoningTokens: 1_000_000,
                onPostprocess: (result) => {
                    busted = result.bustedThisPass;
                },
            });
            const raw: MessageLike[] = [];
            let sequence = 0;
            const user = (text: string) =>
                raw.push({
                    info: { id: `u-${++sequence}`, role: "user", sessionID: sessionId, ...model },
                    parts: [{ type: "text", text }],
                });
            const assistant = (tool: boolean) => {
                const id = `a-${++sequence}`;
                raw.push({
                    info: { id, role: "assistant", sessionID: sessionId, ...model },
                    parts: [
                        {
                            type: "reasoning",
                            text: `Reasoning ${id}. ${"detail ".repeat(20)}`,
                            metadata: { anthropic: { signature: `sig-${id}` } },
                        },
                        tool
                            ? {
                                  type: "tool",
                                  callID: `call-${id}`,
                                  tool: "Read",
                                  state: {
                                      status: "completed",
                                      input: { path: `${id}.ts` },
                                      output: `result ${id} ${"line ".repeat(60)}`,
                                      time: { start: 1, end: 2 },
                                  },
                              }
                            : { type: "text", text: `Finished ${id}.` },
                    ],
                });
            };
            for (let t = 0; t < turns; t++) {
                user(`Task ${t}`);
                assistant(true);
                assistant(true);
                assistant(false);
            }
            user("Current task");
            const holds: { site: string; held: number; start: number; end: number }[] = [];
            const activeSites: string[] = [];
            const originalPair = pairing.pairedThinkingEdit;
            const pairSpy = spyOn(pairing, "pairedThinkingEdit").mockImplementation(((args) => {
                // The final representation closure contains the actual finalizer call;
                // observing that closure avoids depending on source line numbers or stacks.
                activeSites.push(
                    args.edit.toString().includes("finalizeMessageRepresentation")
                        ? "ts_final_representation"
                        : "ts_lane_pair",
                );
                try {
                    return originalPair(args);
                } finally {
                    activeSites.pop();
                }
            }) as typeof originalPair);
            const spy = spyOn(timing, "logSlowWriteTransaction").mockImplementation(
                (site, from, _threshold, to) => {
                    if (site === "paired_thinking_edit")
                        site = activeSites[0] ?? "unclassified_pair";
                    const held = (to ?? performance.now()) - from;
                    const end = Date.now();
                    holds.push({ site, held, start: end - held, end });
                },
            );
            const rows: unknown[] = [];
            const pass = async (kind: string) => {
                holds.length = 0;
                busted = undefined;
                const messages = structuredClone(raw);
                const start = Date.now();
                const from = performance.now();
                await transform({}, { messages });
                const wall = performance.now() - from;
                if (busted === undefined)
                    throw new Error("Benchmark pass did not reach postprocess");
                const row = { kind, start, end: Date.now(), wall, busted, holds: [...holds] };
                rows.push(row);
                return row;
            };
            try {
                let turn = 0;
                await measuredPassSchedule({
                    passes,
                    warm: () => pass("warm"),
                    defer: async () => {
                        assistant(true);
                        return pass("defer");
                    },
                    busting: async () => {
                        const i = turn++;
                        assistant(false);
                        user(`Next task ${i}`);
                        const old = getTagsBySession(db, sessionId).find(
                            (tag) => tag.type === "tool" && tag.status === "active",
                        );
                        if (old) queuePendingOp(db, sessionId, old.tagNumber, "drop");
                        pending.add(sessionId);
                        decision = "execute";
                        const row = await pass("busting");
                        assistant(true);
                        decision = "defer";
                        return row;
                    },
                });
            } finally {
                spy.mockRestore();
                pairSpy.mockRestore();
                db.close();
            }
            const out = `${process.env.HOLD_OUT ?? join(dir, "rows")}-${generation}.json`;
            writeFileSync(out, JSON.stringify({ messages: raw.length, rows }));
            console.log(`TS_HOLD_ROWS ${out} messages=${raw.length} rows=${rows.length}`);
            expect(rows.length).toBe(1 + 2 * passes);
        }, 1_800_000);
