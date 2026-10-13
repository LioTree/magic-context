/**
 * Measure provider-native storage using the real McHandler and throwaway stores.
 * Run: bun packages/e2e-tests/scripts/provider-native-storage.ts
 * Compare the old whole-native payload with the projected model/policy payload.
 * The before run replaces outgoing messages with their original native JSON;
 * the after run uses the production adapter without interception. Both runs
 * otherwise send the same session through the same module and storage schema.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { MAX_REQUEST_BYTES } from "../../plugin/src/hooks/magic-context/host-runner/record";
import type { MessageLike } from "../../plugin/src/hooks/magic-context/transform-operations";
import { buildDriver, Driver, fixture } from "./provider-pipeline-differential";

const work = resolve("target/provider-pipeline-driver");
mkdirSync(work, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "provider-native-storage-"));
const driver = new Driver(buildDriver(work), root);
// Both forms fit in one page, so restoring larger rows cannot change pagination.
const count = 400;
const display = "display-only-diagnostic:" + "diagnostic ".repeat(560);
const modelText = "model-visible tool output ".repeat(240);
const messages: MessageLike[] = Array.from({ length: count }, (_, index) => {
    const id = `message-${index}`;
    return {
        info: {
            id, sessionID: "session", role: index % 2 ? "assistant" : "user",
            model: { providerID: "openai", modelID: "gpt-5.6" },
        },
        parts: index % 2
            ? [{
                id: `${id}-tool`, type: "tool", tool: "edit", callID: `${id}-call`,
                state: {
                    status: "completed", input: { filePath: `file-${index}.ts` },
                    output: modelText, title: `file-${index}.ts`, time: { start: 1, end: 2 },
                    metadata: {
                        diagnostics: { [`file-${index}.ts`]: [{ message: display }] },
                        ...(index % 20 === 1 ? { userAnswer: true } : {}),
                    },
                },
            }]
            : [{ id: `${id}-text`, type: "text", text: "Please edit the file." }],
    } as MessageLike;
});
const originals = new Map(messages.map((message) => [message.info.id, message]));
const measurements: unknown[] = [];
try {
    console.log(`Bun ${Bun.version}; ${spawnSync("cargo", ["--version"], { encoding: "utf8" }).stdout.trim()}`);
    for (const host of ["OpenCode1", "OpenCode2"] as const) {
        for (const mode of ["before", "after"] as const) {
            const directory = join(root, `${host}-${mode}`);
            const f = await fixture(driver, host, directory);
            try {
                updateSessionMeta(f.db, "session", { lastUsageContextLimit: 10_000_000 });
                if (mode === "before") {
                    const client = f.deps.rustModeModuleClient!;
                    const call = client.call.bind(client);
                    client.call = (args) => {
                        const wire = args.body instanceof Uint8Array
                            ? JSON.parse(new TextDecoder().decode(args.body))
                            : args.body;
                        if (wire.method === "compaction.step") {
                            wire.params.messages = wire.params.messages.map((entry: { mid: string }) => ({
                                ...entry, message: originals.get(entry.mid),
                            }));
                        }
                        assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= MAX_REQUEST_BYTES, "before control fits the wire cap");
                        return call({ ...args, body: wire });
                    };
                }
                const served = await f.pass(messages);
                assert.equal(served.filter((message) => originals.has(message.info.id)).length, count,
                    "the view must retain every source message, apart from synthetic heads");
                assert.equal(f.fallbacks.length, 0, "storage measurement must use the provider path");
                const [[rows, nativeBytes, diagnostics]] = await f.sql(`SELECT count(*), sum(length(message_bytes)),
                    sum(instr(CAST(message_bytes AS TEXT), 'display-only-diagnostic:') > 0)
                    FROM mc_provider_messages_v1`);
                assert.equal(rows, count, "all native rows must be durably stored");
                assert.equal(diagnostics, mode === "before" ? count / 2 : 0);
                const [[answers]] = await f.sql(`SELECT count(*) FROM mc_provider_messages_v1
                    WHERE json_extract(CAST(message_bytes AS TEXT), '$.parts[0].state.metadata.userAnswer') = 1`);
                assert.equal(answers, count / 20, "answer-policy evidence must survive both forms");
                const [[views, viewBytes, viewDiagnostics]] = await f.sql(`SELECT count(*), sum(length(replacement_json)),
                    sum(instr(replacement_json, 'display-only-diagnostic:') > 0)
                    FROM mc_provider_views_v1`);
                assert.ok(views > 0, "at least one view must be durably produced");
                if (mode === "before") assert.ok(viewDiagnostics > 0, "the before view duplicates diagnostics");
                else assert.equal(viewDiagnostics, 0, "no produced view may contain diagnostics");
                await f.noReads();
                await f.sql("PRAGMA wal_checkpoint(TRUNCATE)");
                const storeBytes = statSync(join(directory, "store.db")).size;
                const measurement = {
                    host, mode, messages: count, native_rows: rows, native_bytes: nativeBytes,
                    views, replacement_bytes: viewBytes, store_db_bytes: storeBytes,
                    store_db_bytes_per_message: storeBytes / count,
                };
                measurements.push(measurement);
                console.log(JSON.stringify(measurement));
            } finally {
                await f.close();
            }
        }
    }
    console.log(`PROVIDER_NATIVE_STORAGE_RESULT=${JSON.stringify({ checks: 4, measurements })}`);
} finally {
    await driver.close();
}
