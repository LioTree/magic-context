import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";

// A Pi process killed after its publication committed a request, before the
// handler returned it, leaves that request durable with an unconfirmed dispatch.
// After a restart, a pass that cannot write (busy storage) may replay it only for
// exactly the input it was built from; a pass with a different input must not
// anchor on bytes the provider may never have seen.

const modulePath = (path: string) =>
	JSON.stringify(join(import.meta.dir, path));

for (const restartInput of ["identical", "different"] as const) {
	test.skipIf(process.platform === "win32")(
		`after SIGKILL between Pi publication and dispatch, a busy pass with ${restartInput} input ${restartInput === "identical" ? "may replay" : "does not replay"} the unconfirmed request`,
		() => {
			const { dir: root, cleanup } = createTestTempDir(
				"mc-sigkill-unconfirmed-",
			);
			const common = `
import { writeFileSync } from 'node:fs';
import { createFakePi, createTestDb, fakeContext, userMessage, assistantMessage } from ${modulePath("test-utils.test.ts")};
import { registerPiContextHandler } from ${modulePath("context-handler.ts")};
import { __test as fence } from ${modulePath("../../plugin/src/hooks/magic-context/lkg-recovery-fence.ts")};
import { getSlot } from ${modulePath("../../plugin/src/hooks/magic-context/lkg-slot.ts")};
import { updateSessionMeta } from ${modulePath("../../plugin/src/features/magic-context/storage.ts")};
import { Database } from ${modulePath("../../plugin/src/shared/sqlite.ts")};
const root = ${JSON.stringify(root)};
const id = 'unconfirmed-killed-pi';
const db = createTestDb(root + '/context.db');
db.exec('PRAGMA busy_timeout=0');
const fake = createFakePi();
Object.assign(fake.pi, {getAllTools: () => []});
registerPiContextHandler(fake.pi, {db, protectedTags:0, injection:{injectionBudgetTokens:10000}, scheduler:{executeThresholdPercentage:80}});
const raw = [userMessage('old head', 1), assistantMessage('a reply the model saw', 2), userMessage('next user', 3)];
const pass = (messages) => fake.handlers.get('context')({messages: structuredClone(messages)}, {
 ...fakeContext(id, root, messages.map((_, i) => 'entry-' + i), messages),
 getSystemPrompt: () => 'Fixed system.',
 model: {provider:'openai-codex', id:'gpt-5.6-sol', contextWindow:272000, maxTokens:68000}
});
`;
			const run = (code: string) =>
				spawnSync(process.execPath, ["--eval", common + code], {
					env: {
						...process.env,
						OPENCODE_DB: undefined,
						MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
						MAGIC_CONTEXT_TEST_DATA_DIR: root,
						XDG_DATA_HOME: root,
						XDG_CONFIG_HOME: root,
						BUN_JSC_useOMGJIT: "0",
					},
					encoding: "utf8",
					timeout: 30000,
					windowsHide: true,
				});
			try {
				const killed = run(`
updateSessionMeta(db, id, {piStableIdScheme:1});
await pass(raw.slice(0,2));
await new Promise(resolve => setImmediate(resolve));
// Die once the next pass's publication has committed, before the handler returns.
fence.setObserver(phase => { if (phase === 'committed') process.kill(process.pid, 'SIGKILL'); });
await pass(raw);
throw new Error('Did not reach the committed boundary');
`);
				expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL");
				const restart = run(`
const slot = getSlot(id);
const locker = new Database(root + '/context.db');
locker.exec('BEGIN IMMEDIATE');
let result; let refused = false;
try {
 try { result = await pass(${restartInput === "identical" ? "raw" : "[...raw, assistantMessage('a reply the model never saw', 4), userMessage('a different turn', 5)]"}); } catch { refused = true; }
} finally {
 locker.exec('ROLLBACK');
 locker.close();
}
console.log('RESTART ' + JSON.stringify({unconfirmed: slot?.dispatchUnconfirmed === true, refused, saved: slot?.jsonPrefix, result: result ? JSON.stringify(result.messages) : null}));
`);
				expect(restart.status, restart.stderr).toBe(0);
				const line = restart.stdout
					.split("\n")
					.find((entry) => entry.startsWith("RESTART "));
				if (!line) throw new Error(restart.stdout + restart.stderr);
				const proof = JSON.parse(line.slice(8)) as {
					unconfirmed: boolean;
					refused: boolean;
					saved?: string;
					result: string | null;
				};
				expect(proof.unconfirmed, line).toBe(true);
				expect(proof.saved, line).toContain("next user");
				// A replay serves the saved request's messages first.
				const replayed =
					proof.result !== null &&
					proof.saved !== undefined &&
					proof.result.startsWith(proof.saved.slice(0, -1));
				expect(replayed, line).toBe(restartInput === "identical");
			} finally {
				cleanup();
			}
		},
		90000,
	);
}
