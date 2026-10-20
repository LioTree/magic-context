import { Database } from "bun:sqlite";
import { foregroundMeter, summarizeForeground } from "./context-db-foreground-meter";
import { spyOn } from "bun:test";

type Owner = { name: string; pagetype: string };
type Sample = { bytes: Buffer; owners: Map<number, Owner>; meta: Record<string, unknown> };
export type Change = { pass: number; sql: string; pages: Record<string, number>; overflow: Record<string, number>; columns: Record<string, unknown[]>; };
const targets = new Set(["session_meta", "lkg_slots", "lkg_slot_chunks", "session_render_cache", "session_meta_chunks", "session_meta_collection_revisions", "tags"]);

// Compare actual database page bytes, not dbstat's payload lengths: equal lengths
// do not mean an UPDATE preserved the overflow chain.
export function meter(db: Database) {
  const pageSize = (db.query("PRAGMA page_size").get() as {page_size: number}).page_size;
  const query = db.query.bind(db);
  let active = false;
  let reading = false;
  let pass = 0;
  const changes: Change[] = [];
  const wrapped = new WeakSet<object>();
  function sample(): Sample {
    reading = true;
    try {
      const owners = new Map<number, Owner>();
      for (const row of query("SELECT name,pageno,pagetype FROM dbstat WHERE name IN ('session_meta','lkg_slots','lkg_slot_chunks','session_render_cache','session_meta_chunks','session_meta_collection_revisions','sqlite_autoindex_session_meta_collection_revisions_1','sqlite_sequence')").all() as (Owner & { pageno: number })[]) owners.set(row.pageno, row);
      const row = query("SELECT * FROM session_meta LIMIT 1").get() as Record<string, unknown>;
      const meta = Object.fromEntries(Object.entries(row ?? {}).map(([k,v]) => [k, typeof v === 'string' || v instanceof Uint8Array ? [Buffer.byteLength(v), Bun.hash(v).toString()] : v]));
      return { owners, bytes: db.serialize(), meta };
    } finally { reading = false; }
  }
  function wrap(sql: string, statement: any) {
    if (!/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql) || ![...targets].some(t => sql.includes(t)) || wrapped.has(statement)) return statement;
    wrapped.add(statement);
    for (const method of ["run", "get", "all", "values"]) {
      const original = statement[method].bind(statement);
      Object.defineProperty(statement, method, { configurable: true, value: (...args: unknown[]) => {
        if (!active || reading) return original(...args);
        const before = sample();
        const result = original(...args);
        const after = sample();
        const pages: Record<string, number> = {};
        const overflow: Record<string, number> = {};
        for (const n of new Set([...before.owners.keys(), ...after.owners.keys()])) {
          const start = (n - 1) * pageSize;
          if (before.bytes.subarray(start, start + pageSize).equals(after.bytes.subarray(start, start + pageSize))) continue;
          const owner = after.owners.get(n) ?? before.owners.get(n)!;
          pages[owner.name] = (pages[owner.name] ?? 0) + 1;
          if (owner.pagetype === "overflow") overflow[owner.name] = (overflow[owner.name] ?? 0) + 1;
        }
        const columns = Object.fromEntries(Object.keys(after.meta).filter(k => JSON.stringify(before.meta[k]) !== JSON.stringify(after.meta[k])).map(k => [k, [before.meta[k], after.meta[k]]]));
        changes.push({ pass, sql: sql.replace(/\s+/g, " ").trim(), pages, overflow, columns });
        return result;
      }});
    }
    return statement;
  }
  for (const method of ["query", "prepare"] as const) {
    const original = db[method].bind(db);
    (db as any)[method] = (sql: string, ...args: unknown[]) => wrap(sql, (original as any)(sql, ...args));
  }
  return { changes, start(n: number) { pass = n; active = true; }, stop() { active = false; } };
}

import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const flag=(key:string,fallback:string)=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]!:fallback;
const root=resolve(flag('--root','local-ignore/large-benchmark'));
const tree=resolve(flag('--tree','.'));
const passes=Number(flag('--passes','50'));
const foreground=flag('--foreground','0')==='1';
const host=flag('--host','pi');
if(!['pi','oc1'].includes(host))throw new Error('unsupported benchmark host');
let now=1_900_000_000_000;
const RealDate=Date;
globalThis.Date=class extends RealDate {constructor(...args:any[]){if(args.length)super(...args as [any]);else super(now);}static now(){return now;}} as DateConstructor;
for(const [key,name] of [['HOME','home'],['XDG_DATA_HOME','data'],['XDG_CONFIG_HOME','config'],['XDG_STATE_HOME','state'],['XDG_RUNTIME_DIR','run'],['MAGIC_CONTEXT_STORAGE_DIR','mc']]) {const dir=join(root,name!);mkdirSync(dir,{recursive:true});process.env[key!]=dir;}
process.env.OPENCODE_DB=join(root,'opencode.db');
const core=(path:string)=>import(join(tree,'packages/plugin/src',path));
const pi=(path:string)=>import(join(tree,'packages/pi-plugin/src',path));
const utils=await pi('test-utils.test.ts');
const {setHarness}=await core('shared/harness.ts');setHarness(host==='pi'?'pi':'opencode');
const {registerPiContextHandler}=await pi('context-handler.ts');
const {insertMemory}=await core('features/magic-context/memory/storage-memory.ts');
const {resolveProjectIdentityForSession}=await core('features/magic-context/memory/project-identity.ts');
const {replaceAllCompartments}=await core('features/magic-context/compartment-storage.ts');
const {updateSessionMeta}=await core('features/magic-context/storage-meta.ts');
const persisted=await core('features/magic-context/storage-meta-persisted.ts');
const {readReplayEnvelope,serializeReplayDocument}=await core('features/magic-context/storage-replay-document.ts');
const {saveNativeToolInputs}=await core('features/magic-context/storage-native-replay.ts');
const {publishPiServedNumbers}=await pi('pi-served-identities.ts');
const {createCtxReduceTools}=await core('tools/ctx-reduce/tools.ts');
const {executeFlush}=await core('hooks/magic-context/execute-flush.ts');
const lkg=await core('hooks/magic-context/lkg-persist.ts');
const {checkLkgDurability}=await core('hooks/magic-context/lkg-served-marker.ts');
const {providerVisibleMessage}=await core('hooks/magic-context/provider-visible-parts.ts');
const {setMuralCue,computeCueContentHash}=await core('features/magic-context/mural/storage-mural-cues.ts');
const {refreshModelLimitsFromApi}=await core('shared/models-dev-cache.ts');
await refreshModelLimitsFromApi({config:{providers:async()=>({data:{providers:[{id:'anthropic',models:{'claude-sonnet-4-5':{input:['text','image'],limit:{context:2000000,output:10000}}}}]}})}});
const db=host==='pi'?utils.createTestDb(join(root,'context.db')):(await core('features/magic-context/storage.ts')).openDatabase(join(root,'context.db'));
const foregroundTiming=foreground?foregroundMeter(db):undefined;
const m=foreground?{changes:[] as Change[],start:(_:number)=>{},stop:()=>{}}:meter(db);
const sessionId='large-retained-history';
const directory=join(root,'project');mkdirSync(directory,{recursive:true});
const projectPath=resolveProjectIdentityForSession(directory,true);
updateSessionMeta(db,sessionId,{piStableIdScheme:1,systemPromptTokens:100,counter:50000});
for(let i=0;i<500;i++) {
 const content=`Rule ${i}: `+'Use meaningful names and document the public API boundary. '.repeat(25);
 const memory=insertMemory(db,{projectPath,category:'NAMING',content,sourceType:'historian'});
 setMuralCue(db,projectPath,memory.id,`Rule ${i}: validate schema boundaries, preserve signatures and expose stable meaningful names.`,computeCueContentHash(content));
}
replaceAllCompartments(db,sessionId,[{sequence:0,startMessage:1,endMessage:2,startMessageId:'entry-0',endMessageId:'entry-1',title:'Opening work',content:'Validated the request schema and cross-checked the deployment configuration. '.repeat(1000)}]);
const fake=utils.createFakePi();Object.assign(fake.pi,{getAllTools:()=>[]});
if(host==='pi')registerPiContextHandler(fake.pi,{db,signedThinkingHold:'on',scheduler:{executeThresholdPercentage:80},heuristics:{keepReasoningTokens:1000,clearReasoningAge:2,protectedTools:{Read:0}},injection:{memoryEnabled:true,injectionBudgetTokens:30000,injectDocs:false,temporalAwareness:false,muralEnabled:true}});
const reduce=createCtxReduceTools({db,protectedSet:new Set(),protectedTools:{Read:0},getSessionTokens:()=>50000}).ctx_reduce;
const model={provider:'anthropic',id:'claude-sonnet-4-5',api:'anthropic-messages',contextWindow:2000000,maxTokens:10000};
const raw:any[]=[utils.userMessage('Opening work',1),utils.assistantMessage('Opening reply',2,{api:model.api,provider:model.provider,model:model.id})];
const collections=['trailing_blank_decisions','merged_reasoning_stripped_ids','note_nudge_anchors','auto_search_hint_decisions','stale_reduce_stripped_ids','stripped_placeholder_ids','processed_image_stripped_ids','memory_block_ids'];
const cacheColumns=['cached_m0_bytes','cached_m1_bytes','cached_m0_mural_data_url'];
const inline=new Set((db.prepare('PRAGMA table_info(session_meta)').all() as {name:string}[]).map(r=>r.name));
const modernCollections=inline.has('trailing_blank_decisions')?undefined:await core('features/magic-context/storage-session-collections.ts');
const modernCache=inline.has('cached_m0_bytes')?undefined:await core('features/magic-context/storage-session-cache.ts');
const revisionCache=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_meta_collection_revisions'").get();
if(foregroundTiming && modernCollections && revisionCache) {
 const state=await core('features/magic-context/storage-session-collection-state.ts');
 const originalState=state.readCollectionState,originalRead=modernCollections.readSessionMetaCollection;
 spyOn(state,'readCollectionState').mockImplementation((...args:any[])=>foregroundTiming.collectionAccess(()=>originalState(...args)));
 spyOn(modernCollections,'readSessionMetaCollection').mockImplementation((...args:any[])=>foregroundTiming.collectionAccess(()=>originalRead(...args)));
}
if(foregroundTiming && modernCollections) {
 const layout=await core('features/magic-context/session-meta-chunk-layout.ts');
 const original=layout.layoutSessionMetaBytes;
 spyOn(layout,'layoutSessionMetaBytes').mockImplementation((bytes:Uint8Array)=>foregroundTiming.layout(()=>original(bytes)));
}
let ocHandler:any,ocDb:any;
const usageMap=new Map<string,any>();
if(host==='oc1') {
 const {createTagger}=await core('features/magic-context/tagger.ts');
 const {createTransform}=await core('hooks/magic-context/transform.ts');
 const {createMessagesTransformHandler}=await core('plugin/messages-transform.ts');
 const {Database:HostDatabase}=await core('shared/sqlite.ts');
 const {OPENCODE1_MESSAGE_PART_SCHEMA}=await core('features/magic-context/__tests__/opencode1-query-fixture.ts');
 ocDb=new HostDatabase(process.env.OPENCODE_DB!);ocDb.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
 const transform=createTransform({db,directory,projectPath,tagger:createTagger(),signedThinkingHold:'on',scheduler:{shouldExecute:()=> 'defer'},contextUsageMap:usageMap,historyRefreshSessions:new Set(),pendingMaterializationSessions:new Set(),lastHeuristicsTurnId:new Map(),historianRunnable:false,protectedTokens:0,protectedTools:{Read:0},clearReasoningAge:2,memoryConfig:{enabled:true,injectionBudgetTokens:30000,autoPromote:false},injectDocs:false,muralEnabled:true,liveModelBySession:new Map([[sessionId,{providerID:model.provider,modelID:model.id}]])});
 ocHandler=createMessagesTransformHandler({magicContext:{'experimental.chat.messages.transform':transform}});
}
let storedMessages=0;
function ocMessages() {
 const messages:any[]=[];
 for(let i=0;i<raw.length;i++) {
  const message=raw[i];if(message.role==='toolResult')continue;
  const id=`entry-${i}`,parts:any[]=[];
  for(const part of typeof message.content==='string'?[{type:'text',text:message.content}]:message.content) {
   if(part.type==='text')parts.push({type:'text',text:part.text});
   if(part.type==='thinking')parts.push({type:'reasoning',text:part.thinking,metadata:{anthropic:{signature:part.thinkingSignature}}});
   if(part.type==='toolCall') {
    const result=raw.slice(i+1).find((value:any)=>value.role==='toolResult'&&value.toolCallId===part.id);
    const output=result?(typeof result.content==='string'?result.content:result.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n')):'';
    parts.push({type:'tool',tool:part.name,callID:part.id,state:{status:'completed',input:part.arguments,output,title:part.name,time:{start:i+1,end:i+2}}});
   }
  }
  parts.forEach((part,index)=>Object.assign(part,{id:`${id}-part-${index}`,messageID:id,sessionID:sessionId}));
  messages.push({info:{id,sessionID:sessionId,role:message.role,time:{created:i+1,completed:i+2},model:{providerID:model.provider,modelID:model.id},providerID:model.provider,modelID:model.id,finish:'stop'},parts});
 }
 ocDb.transaction(()=>{
  for(const message of messages.slice(storedMessages)) {
   const {id,sessionID:_session,...data}=message.info;
   ocDb.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id,sessionId,data.time.created,data.time.completed,JSON.stringify(data));
   for(const part of message.parts) {const {id:partId,messageID:_m,sessionID:_s,...body}=part;ocDb.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(partId,id,sessionId,data.time.created,data.time.completed,JSON.stringify(body));}
  }
 }).immediate();
 storedMessages=messages.length;return messages;
}
function read(column:string):Buffer|null {
 const sql=inline.has(column)?column:collections.includes(column)?modernCollections.sessionMetaCollectionValueSql(column):modernCache.sessionRenderCacheValueSql(column);
 const row=db.prepare(`SELECT CAST(${sql} AS BLOB) AS raw FROM session_meta WHERE session_id=?`).get(sessionId) as {raw:Uint8Array|null};
 return row.raw===null?null:Buffer.from(row.raw);
}
function shape(a:any,b:any):{added:number;inplace:boolean} {
 if(Object.is(a,b))return {added:0,inplace:false};
 if(Array.isArray(a)&&Array.isArray(b)) {
  if(b.length<a.length)return {added:0,inplace:true};
  let added=b.length-a.length,inplace=false;
  for(let i=0;i<a.length;i++){const change=shape(a[i],b[i]);added+=change.added;inplace ||=change.inplace;}
  return {added,inplace};
 }
 if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)) {
  let added=Object.keys(b).filter(key=>!Object.hasOwn(a,key)).length,inplace=false;
  for(const key of Object.keys(a)){if(!Object.hasOwn(b,key)){inplace=true;continue;}const change=shape(a[key],b[key]);added+=change.added;inplace ||=change.inplace;}
  return {added,inplace};
 }
 return {added:0,inplace:true};
}
function classify(before:Buffer|null,after:Buffer|null) {
 if(before===null||after===null)return before===after?'same':'opaque-edit';
 if(before.equals(after))return 'same';
 try {const change=shape(JSON.parse(before!.toString()),JSON.parse(after!.toString()));return change.inplace?'in-place':change.added?'append':'serialization';}catch{return 'opaque-edit';}
}
function fingerprint(value:Buffer|null){return value===null?null:{bytes:value.length,sha256:createHash('sha256').update(value).digest('hex')};}
function paddedRecords(target:number,count:number,build:(i:number,padding:number)=>any) {
 const zero=Array.from({length:count},(_,i)=>build(i,0));
 const extra=target-Buffer.byteLength(JSON.stringify(zero));
 if(extra<0)throw new Error('seed target smaller than its records');
 return Array.from({length:count},(_,i)=>build(i,Math.floor(extra/count)+(i<extra%count?1:0)));
}
function ids(target:number,prefix:string,count=Math.floor(target/(prefix.length+12))) {
 return paddedRecords(target,count,(i,pad)=>`${prefix}${String(i).padStart(6,'0')}${'x'.repeat(pad)}:p0`) as string[];
}
function seedLarge() {
 db.transaction(()=>{
  publishPiServedNumbers(db,sessionId,Array.from({length:12025},(_,i)=>i+1));
  const old=readReplayEnvelope(db,sessionId);
  const count=28226;
  const make=(padding:number,remainder:number)=>new Map(Array.from({length:count},(_,i)=>[`archive-call-${i}`,JSON.stringify({p:`/old/file-${i}.ts`,q:`retained é🙂${' '.repeat(padding+(i<remainder?1:0))}`})]));
  const native=old.piNative&&typeof old.piNative==='object'?old.piNative:{};
  const size=(inputs:Map<string,string>)=>Buffer.byteLength(serializeReplayDocument({...old,version:2,piNative:{...native,toolInputs:Object.fromEntries(inputs),reasoningIds:[]}}));
  const extra=3_718_063-size(make(0,0));if(extra<0)throw new Error('native seed exceeds target');
  saveNativeToolInputs(db,sessionId,make(Math.floor(extra/count),extra%count));
  persisted.addMergedReasoningStrippedIds(db,sessionId,ids(438_734,'old-reasoning-'));
  persisted.addStaleReduceStrippedIds(db,sessionId,ids(7_954,'old-reduce-'));
  persisted.setStrippedPlaceholderIds(db,sessionId,new Set(ids(142_224,'old-placeholder-',4096)));
  persisted.addProcessedImageStrippedIds(db,sessionId,ids(7_023,'old-image-'));
  for(const anchor of paddedRecords(160_366,600,(i,pad)=>({messageId:`old-note-${i}`,text:`Past delivered reminder ${'x'.repeat(pad)}`}))) persisted.appendNoteNudgeAnchor(db,sessionId,anchor.messageId,anchor.text);
  for(const decision of paddedRecords(76_129,600,(i,pad)=>({messageId:`old-hint-${i}`,decision:'hint',text:`Past delivered hint ${'x'.repeat(pad)}`}))) persisted.appendAutoSearchHintDecision(db,sessionId,decision);
 }).immediate();
 const sizes=Object.fromEntries(collections.map(column=>[column,read(column)?.length??null]));
 if(sizes.trailing_blank_decisions!==3_718_063)throw new Error('native seed serialization differed: '+sizes.trailing_blank_decisions);
 console.log('SEEDED',JSON.stringify(sizes));
 return {sizes,namespaces:Object.keys(readReplayEnvelope(db,sessionId))};
}
const heads:any[]=[],changes:any[]=[],certificates:any[]=[];
let seed:any,reductions=0,fullPairs=0;
for(let pass=0;pass<=passes;pass++) {
  now+=1000;
 if(pass>0) {
  raw.push(utils.userMessage(`Investigate task ${pass}.`,raw.length+1));
  for(let j=0;j<3;j++) {
   const call=`call-${pass}-${j}`,a=utils.assistantToolCall(call,'Read',{path:`/src/file-${pass}-${j}.ts`},raw.length+1);
   Object.assign(a,{api:model.api,provider:model.provider,model:model.id,stopReason:'toolUse'});
   a.content.unshift({type:'thinking',thinking:`Inspect request ${pass}/${j}. `.repeat(30),thinkingSignature:`signature-${pass}-${j}`});
   raw.push(a,utils.toolResultMessage(call,`Result ${pass}/${j}: `+'const stableName = validateBoundary(input);\n'.repeat(90),raw.length+2));
  }
  raw.push(utils.assistantMessage(`Completed ${pass}.`,raw.length+1,{api:model.api,provider:model.provider,model:model.id}));
  if(host==='oc1')raw.push(utils.userMessage(`Continue after completed task ${pass}.`,raw.length+1));
 }
  const before=pass>0&&!foreground?Object.fromEntries(collections.map(column=>[column,read(column)])):{};
  if(pass>0)m.start(pass);
  if(pass>0)foregroundTiming?.start(pass);
 if(pass>0&&pass%10===0)executeFlush(db,sessionId);
 if(pass>0&&pass%3===0) {
  const tags=db.prepare("SELECT tag_number FROM tags WHERE session_id=? AND type='tool' AND status='active' ORDER BY tag_number LIMIT 6").all(sessionId) as {tag_number:number}[];
  if(tags.length) {const reply=await reduce.execute({drop:tags.map(row=>String(row.tag_number)).join(',')},{sessionID:sessionId});if(String(reply).includes('Error:'))throw new Error(String(reply));reductions++;}
 }
 const messages=host==='pi'?structuredClone(raw):ocMessages(),entryIds=messages.map((_:unknown,i:number)=>`entry-${i}`);
 const usage=50000+pass*4000;
 usageMap.set(sessionId,{usage:{percentage:usage/2000000*100,inputTokens:usage},updatedAt:now});
 const started=pass>0?foregroundTiming?.handlerStart():undefined;
 const served=host==='pi'?await fake.handlers.get('context')({messages},{...utils.fakeContext(sessionId,directory,entryIds,messages),getSystemPrompt:()=> 'Page write measurement system.',getContextUsage:()=>({tokens:usage,percent:usage/2000000*100,contextWindow:2000000}),model}) as {messages:unknown[]} : await (async()=>{const output={messages};await ocHandler({},output);return output;})();
 if(started)foregroundTiming?.handlerEnd(started);
 await new Promise<void>(done=>setTimeout(done,10));
  m.stop();
  if(pass>0)foregroundTiming?.stop();
 if(pass===0)seed=seedLarge();
 heads.push(Object.fromEntries(cacheColumns.map(column=>[column,fingerprint(read(column))])));
  if(pass>0&&!foreground)for(const column of collections) {
  const after=read(column),kind=classify(before[column]??null,after);
  if(kind!=='same') {
   let servedAdded=0;
   if(column==='trailing_blank_decisions')servedAdded=(JSON.parse(after!.toString()).piServedTagNumbers?.length??0)-(JSON.parse(before[column]!.toString()).piServedTagNumbers?.length??0);
   changes.push({pass,column,kind,servedAdded,before:before[column]?.length??null,after:after?.length??null});
  }
 }
 const slot=lkg.loadPersistedLkgSlot(db,sessionId,true);
 if(!slot)throw new Error('no durable LKG slot after pass '+pass);
 const equal=slot.jsonPrefix===JSON.stringify(host==='pi'?served.messages:served.messages.map(providerVisibleMessage));
 if(equal)fullPairs++;
  const certificate=checkLkgDurability(db,sessionId);
   if(host==='pi' && (!certificate.durable || certificate.servedCaptureId===null))throw new Error('served request lacks a durable bound certificate on pass '+pass);
 if(slot.fullCoverage!==false&&!equal)throw new Error('durable full-coverage copy differs from the served request');
 certificates.push({pass,equal,fullCoverage:slot.fullCoverage,certificate});
 if(pass%10===0)console.log('PASS',pass,'messages',raw.length,'head',JSON.stringify(heads.at(-1)));
}
if(new Set(heads.map(head=>JSON.stringify(head))).size!==1)throw new Error('ordinary passes changed cached m0/m1/mural bytes');
if(host==='pi' && (foreground ? (read('trailing_blank_decisions')?.length??0)<=seed.sizes.trailing_blank_decisions : changes.filter(change=>change.column==='trailing_blank_decisions'&&change.servedAdded>0).length<passes-2))throw new Error('ordinary passes did not actually grow the replay envelope');
const totals:Record<string,number>={},ordinary:Record<string,number>={},byStatement:Record<string,Record<string,number>>={};
for(const change of m.changes) {
 for(const [owner,pages] of Object.entries(change.pages)) {totals[owner]=(totals[owner]??0)+pages;if(change.pass%10!==0)ordinary[owner]=(ordinary[owner]??0)+pages;}
 const sum=byStatement[change.sql]??={};for(const [owner,pages] of Object.entries(change.pages))sum[owner]=(sum[owner]??0)+pages;
}
const kinds:Record<string,Record<string,number>>={};for(const change of changes){const counts=kinds[change.column]??={};counts[change.kind]=(counts[change.kind]??0)+1;}
const summary={tool:`Bun ${Bun.version}`,passes,ordinaryPasses:Array.from({length:passes},(_,i)=>i+1).filter(pass=>pass%10!==0).length,seed,totals,ordinary,byStatement,mutationKinds:kinds,reductions,fullPairs,uniqueHeads:new Set(heads.map(head=>JSON.stringify(head))).size,head:heads[0]};
writeFileSync(join(root,'pages.json'),JSON.stringify({summary,changes,statements:m.changes,heads,certificates},null,2));
console.log('BENCHMARK_SUMMARY',JSON.stringify(summary));
if(foregroundTiming) {
 if(revisionCache && !foregroundTiming.records.some(record=>(record.timing['handler:collectionAccess']?.calls??0)>0))throw new Error('revision-cache read scopes were not observed');
 const result={host,summary:summarizeForeground(foregroundTiming),records:foregroundTiming.records,sql:foregroundTiming.sqlText};
 writeFileSync(join(root,'foreground.json'),JSON.stringify(result));
 console.log('FOREGROUND_SUMMARY',JSON.stringify({host,...result.summary}));
}
ocDb?.close();
db.close();
