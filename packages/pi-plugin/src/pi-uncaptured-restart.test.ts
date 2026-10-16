import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "../../plugin/src/shared/test-temp-dir";

const source =
	process.env.MC_UNCAPTURED_SOURCE ?? resolve(import.meta.dir, "../../..");
// Each phase loads the real implementation in a new process over one owned
// store. Failed handler construction must not let its caller dispatch raw input.
const childCode = `
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const root = process.env.MC_UNCAPTURED_SOURCE;
const load = (path) => import(pathToFileURL(join(root, path)).href);
const u = await load('packages/pi-plugin/src/test-utils.test.ts');
const { registerPiContextHandler } = await load('packages/pi-plugin/src/context-handler.ts');
const { createDbLkgPersistence, loadPersistedLkgSlot } = await load('packages/plugin/src/hooks/magic-context/lkg-persist.ts');
const { getInMemorySlot, registerLkgPersistence } = await load('packages/plugin/src/hooks/magic-context/lkg-slot.ts');
const { lkgRecoveryFenceUnclean } = await load('packages/plugin/src/hooks/magic-context/lkg-recovery-fence.ts');
const { createPiLkgCoordinator } = await load('packages/pi-plugin/src/pi-lkg.ts');
const dbPath = join(process.env.MC_UNCAPTURED_ROOT, 'context.db');
const db = u.createTestDb(dbPath);
registerLkgPersistence(createDbLkgPersistence(db));
const fake = u.createFakePi();
registerPiContextHandler(fake.pi, {
  db, signedThinkingHold:'off', protectedTokens:4000,
  injection:{injectionBudgetTokens:4000,memoryEnabled:false,injectDocs:false},
  heuristics:{keepReasoningTokens:1000000},
});
const handler = fake.handlers.get('context');
const session = 'uncaptured-publication';
const raw = [u.userMessage('old request', 1)];
const pass = async (messages, mapped) => {
  const input = structuredClone(messages);
  const ctx = {
    ...u.fakeContext(session, process.cwd(), input.map((_, i) => 'entry-'+i), input),
    model:{provider:'anthropic',id:'claude-opus-5-5',api:'anthropic-messages',contextWindow:100000},
    getContextUsage:()=>({tokens:20000,percent:20,contextWindow:100000}),
  };
  if (!mapped) ctx.sessionManager.getBranch = () => { throw new Error('branch temporarily unavailable'); };
  return handler({messages:input},ctx);
};
const mode = process.env.MC_UNCAPTURED_MODE;
let result;
if (mode === 'restart-replay') {
  const coordinator=createPiLkgCoordinator(db);
  const slot=loadPersistedLkgSlot(db,session);
  const input=[...raw,u.userMessage('new request',3)];
  const snapshot=coordinator.beginPass({sessionId:session,messages:input,
    entryIds:input.map((_,i)=>'entry-'+i),modelKey:slot?.modelKey ?? 'anthropic/claude-opus-5-5',
    providerKey:slot?.providerKey ?? 'anthropic',apiKey:'anthropic-messages'});
  const recovery=coordinator.recoveryFor(snapshot);
  const replay=recovery.rebuildReason ? {ok:false,reason:recovery.rebuildReason} : coordinator.replay(snapshot);
  result={replay:replay.ok,reason:replay.reason};
} else if (mode === 'restart') {
  // Fail after input snapshot preparation, rather than during startup binding.
  let interruptedWrites=0;
  const prepare=db.prepare.bind(db);
  db.prepare=(sql)=>{
    const statement=prepare(sql);
    if (!/^\\s*INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+tags\\b/i.test(sql)) return statement;
    return new Proxy(statement,{get(target,key){
      if (key==='run' || key==='all' || key==='get') return ()=>{
        interruptedWrites++;
        throw Object.assign(new Error('database is locked during restarted tagging'),{code:'SQLITE_BUSY'});
      };
      const value=Reflect.get(target,key,target);
      return typeof value==='function' ? value.bind(target) : value;
    }});
  };
  let dispatches = 0, refused = false;
  try {
    const output = await pass([...raw,u.userMessage('new request',3)],true);
    dispatches++;
    result = {dispatches,refused,output:JSON.stringify(output)};
  } catch (error) {
    refused = true;
    result = {dispatches,refused,code:error.code,message:error.message};
    result.reasons=[];
    for(let current=error;current;current=current.cause) result.reasons.push(current.message);
  }
  result.interruptedWrites=interruptedWrites;
} else {
  await pass(raw,mode !== 'seed-empty');
  const older = loadPersistedLkgSlot(db,session)?.jsonPrefix;
  if (mode === 'seed-clean') {
    result = {older:!!older,dirty:lkgRecoveryFenceUnclean(session)};
  } else {
    const tail = u.assistantMessage('continue',2,{
      provider:'anthropic',model:'claude-opus-5-5',api:'anthropic-messages',
      content:[{type:'thinking',thinking:'kept reasoning',thinkingSignature:'opaque-signature'},{type:'text',text:'continue'}],
    });
    const output = await pass([...raw,tail],false);
    result = {older:!!older,dirty:lkgRecoveryFenceUnclean(session),
      saved:!!loadPersistedLkgSlot(db,session),inMemory:!!getInMemorySlot(session),
      output:JSON.stringify(output),raw:JSON.stringify([...raw,tail])};
    if (mode === 'wider') {
      try { await pass([...raw,tail],false); result.refused=false; }
      catch (error) {
        result.refused=true;
        const reasons=[];
        for(let current=error;current;current=current.cause) reasons.push(current.message);
        result.reasons=reasons;
      }
    }
  }
}
console.log('UNCAPTURED_PROOF='+JSON.stringify(result));
db.close();
process.exit(0);
`;

function child(root: string, mode: string): Record<string, unknown> {
	const result = spawnSync(process.execPath, ["--eval", childCode], {
		windowsHide: true,
		cwd: root,
		env: {
			...process.env,
			NODE_ENV: "test",
			HOME: join(root, "home"),
			XDG_DATA_HOME: join(root, "data"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_CACHE_HOME: join(root, "cache"),
			MAGIC_CONTEXT_TEST_DATA_DIR: root,
			MAGIC_CONTEXT_STORAGE_DIR: join(root, "store"),
			MAGIC_CONTEXT_CONFIG_PATH: join(root, "missing-config.jsonc"),
			OPENCODE_DB: join(root, "absent-opencode.db"),
			MC_UNCAPTURED_SOURCE: source,
			MC_UNCAPTURED_ROOT: root,
			MC_UNCAPTURED_MODE: mode,
		},
		encoding: "utf8",
		timeout: 60000,
	});
	expect(result.status, result.stdout + result.stderr).toBe(0);
	const line = result.stdout
		.split("\n")
		.find((value) => value.startsWith("UNCAPTURED_PROOF="));
	expect(line, result.stdout + result.stderr).toBeDefined();
	if (line === undefined)
		throw new Error("Child process produced no restart proof");
	return JSON.parse(line.slice("UNCAPTURED_PROOF=".length));
}

function fixture(): string {
	const root = createTestTempDirFromPath(
		join(tmpdir(), "pi-uncaptured-restart-"),
	);
	mkdirSync(join(root, "home"));
	return root;
}

test("a clean saved request remains eligible for replay in a fresh process", () => {
	const root = fixture();
	try {
		expect(child(root, "seed-clean")).toMatchObject({
			older: true,
			dirty: false,
		});
		expect(child(root, "restart-replay")).toMatchObject({ replay: true });
	} finally {
		cleanupTestTempDir(root);
	}
}, 90000);

test("numbers-only publication with an older LKG fences its restart replay", () => {
	const root = fixture();
	try {
		const published = child(root, "seed-older");
		expect(published).toMatchObject({ older: true, saved: true, dirty: true });
		expect(published.output).not.toBe(published.raw);
		expect(child(root, "restart-replay")).toMatchObject({ replay: false });
		const restarted = child(root, "restart");
		expect(restarted.interruptedWrites).toBeGreaterThan(0);
		expect(restarted).toMatchObject({ dispatches: 0, refused: true });
	} finally {
		cleanupTestTempDir(root);
	}
}, 90000);

test("numbers-only publication without an LKG leaves no tombstone and restart cannot send raw", () => {
	const root = fixture();
	try {
		const published = child(root, "seed-empty");
		expect(published).toMatchObject({
			older: false,
			saved: false,
			inMemory: false,
			dirty: false,
		});
		expect(published.output).not.toBe(published.raw);
		expect(child(root, "restart-replay")).toMatchObject({ replay: false });
		const restarted = child(root, "restart");
		expect(restarted.interruptedWrites).toBeGreaterThan(0);
		expect(restarted).toMatchObject({ dispatches: 0, refused: true });
	} finally {
		cleanupTestTempDir(root);
	}
}, 90000);

test("an older LKG with unresolved signed entry IDs still refuses the required persisted rebuild", () => {
	const root = fixture();
	try {
		const published = child(root, "wider");
		expect(published).toMatchObject({
			older: true,
			dirty: true,
			refused: true,
		});
		expect(published.reasons).toContain(
			"Cannot persist thinking omission without a stable entry id",
		);
	} finally {
		cleanupTestTempDir(root);
	}
}, 90000);
