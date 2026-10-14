import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import {
    meterProviderCall,
    meterProviderRpc,
    meterProviderStage,
    type ProviderPassMeters,
    withProviderMeters,
} from "./provider-meters";
import { initializeDatabase } from "./storage-db";
import { commitHostRunnerPass, createHostRunnerState } from "./storage-host-runner";

const observe = async (action: () => Promise<void>) => {
    let observed!: ProviderPassMeters;
    await withProviderMeters("session", "OpenCode1", "fixture", action, (row) => {
        observed = structuredClone(row);
    });
    return observed;
};

describe("provider production meters", () => {
    test("malformed request bytes and non-JSON responses retain the transport's original behavior", async () => {
        const response = { bigint: 1n };
        const row = await observe(async () => {
            const actual = await meterProviderRpc(
                "transform.hook",
                new TextEncoder().encode("not JSON"),
                async () => response,
            );
            expect(actual).toBe(response);
        });
        expect(row.rpc_count).toBe(1);
        expect(row.requests[0]!.request_id).toBeNull();
        expect(row.partial_fields.some((field) => field.includes("encoded body is not JSON"))).toBe(
            true,
        );
        expect(
            row.partial_fields.some((field) => field.includes("response cannot be JSON encoded")),
        ).toBe(true);
    });
    test("RPC admission counts a failed call before a response exists", async () => {
        const row = await observe(async () => {
            await expect(
                meterProviderCall("transform.hook", () =>
                    meterProviderRpc(
                        "transform.hook",
                        new TextEncoder().encode('{"params":{"request_id":"hook"}}'),
                        async () => {
                            throw new Error("no reply");
                        },
                    ),
                ),
            ).rejects.toThrow("no reply");
        });
        expect(row.rpc_count).toBe(1);
        expect(row.hook_count).toBe(1);
        expect(row.requests).toHaveLength(1);
        expect(row.requests[0]!.request_id).toBe("hook");
        expect(row.requests[0]!.status).toBe("error");
        expect(row.rpc_response_json_bytes).toBe(0);
    });
    test("RPC byte meters count UTF-8 encoded requests and logical response JSON independently", async () => {
        const row = await observe(async () => {
            await meterProviderRpc(
                "compaction.step",
                new TextEncoder().encode('{"params":{"request_id":"🦀"}}'),
                async () => ({ text: "café 🦀" }),
            );
        });
        expect(row.rpc_request_bytes).toBe(32);
        expect(row.rpc_response_json_bytes).toBe(21);
        expect(row.hook_count).toBe(0);
    });
    test("stage and whole-pass timers include completed awaited work", async () => {
        const row = await observe(async () => {
            await meterProviderStage(
                "state_sync",
                () => new Promise((resolve) => setTimeout(resolve, 15)),
            );
            await meterProviderStage(
                "publish",
                () => new Promise((resolve) => setTimeout(resolve, 15)),
            );
        });
        expect(row.stages.state_sync).toBeGreaterThanOrEqual(10);
        expect(row.stages.publish).toBeGreaterThanOrEqual(10);
        expect(row.pass_ms).toBeGreaterThanOrEqual(row.stages.state_sync! + row.stages.publish!);
    });
    test("concurrent sessions do not share pass counters", async () => {
        let a!: ProviderPassMeters;
        let b!: ProviderPassMeters;
        await Promise.all([
            withProviderMeters(
                "a",
                "OpenCode1",
                null,
                async () => {
                    await meterProviderCall("transform.hook", () =>
                        meterProviderRpc("transform.hook", {}, async () => {
                            await new Promise((resolve) => setTimeout(resolve, 5));
                            return {};
                        }),
                    );
                },
                (row) => {
                    a = row;
                },
            ),
            withProviderMeters(
                "b",
                "OpenCode1",
                null,
                async () => {
                    await meterProviderRpc("compaction.step", {}, async () => ({}));
                },
                (row) => {
                    b = row;
                },
            ),
        ]);
        expect(a.hook_count).toBe(1);
        expect(b.hook_count).toBe(0);
        expect(a.rpc_count).toBe(1);
        expect(b.rpc_count).toBe(1);
        expect(a.pass_id).not.toBe(b.pass_id);
    });
    test("host admission and actual writes count persisted cells and rollback contributes zero", async () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const state = { ...createHostRunnerState("L", 1), next_ordinal: 2 };
            const entry = {
                ordinal: 1,
                message_id: "m",
                ingest_json: '["café 🦀"]',
                hook_json: '[{"op":"replace","value":"large 🦀"}]',
                op_version: 1,
                ingested: 0 as const,
                race: 0 as const,
                created_at: 10,
            };
            const row = await observe(async () =>
                commitHostRunnerPass(
                    db,
                    { session_id: "session", harness: "opencode" },
                    { state, entries: [entry] },
                ),
            );
            const oracle = db
                .prepare(
                    "SELECT length(CAST(ingest_json AS BLOB)) AS ingest, length(CAST(hook_json AS BLOB)) AS ops FROM host_runner_entries",
                )
                .get() as { ingest: number; ops: number };
            expect(row.appended).toBe(1);
            expect(row.ingest_json_bytes).toBe(oracle.ingest);
            expect(row.hook_ops_json_bytes).toBe(oracle.ops);
            let bytes = 0;
            for (const table of ["host_runner_entries", "host_runner_ids", "host_runner_state"]) {
                const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
                    name: string;
                }[];
                const result = db
                    .prepare(
                        `SELECT ${columns.map((column) => `coalesce(length(CAST(${column.name} AS BLOB)),0)`).join("+")} AS bytes FROM ${table}`,
                    )
                    .get() as { bytes: number };
                bytes += result.bytes;
                if (table === "host_runner_state") expect(row.host_state_bytes).toBe(result.bytes);
            }
            expect(row.host_logical_payload_bytes).toBe(bytes);
            const failed = await observe(async () => {
                expect(() =>
                    commitHostRunnerPass(
                        db,
                        { session_id: "session", harness: "opencode" },
                        { state, entries: [entry] },
                    ),
                ).toThrow();
            });
            expect(failed.appended).toBe(0);
            expect(failed.host_logical_payload_bytes).toBe(0);
            expect(failed.ingest_json_bytes).toBe(0);
            expect(failed.hook_ops_json_bytes).toBe(0);
        } finally {
            db.close();
        }
    });
});
