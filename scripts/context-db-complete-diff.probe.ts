import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spyOn} from 'bun:test';
const flag=(name:string,fallback:string)=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]!:fallback;
const tree=resolve(flag('--tree','.')),root=resolve(flag('--root','local-ignore/complete-diff')),directory=resolve(flag('--project','local-ignore/complete-diff-project'));
const host=flag('--host','pi'),passes=Number(flag('--passes','240')),seed=Number(flag('--seed','9137'));
mkdirSync(directory,{recursive:true});
for(const [key,name] of [['HOME','home'],['XDG_DATA_HOME','data'],['XDG_CONFIG_HOME','config'],['XDG_STATE_HOME','state'],['XDG_RUNTIME_DIR','run'],['MAGIC_CONTEXT_STORAGE_DIR','mc']]) {const path=join(root,name!);mkdirSync(path,{recursive:true});process.env[key!]=path;}
process.env.OPENCODE_DB=join(root,'opencode.db');process.env.TZ='UTC';
let now=1_900_000_000_000;
const RealDate=Date;
globalThis.Date=class extends RealDate {constructor(...args:any[]){if(args.length)super(...args as [any]);else super(now);}static now(){return now;}} as DateConstructor;
const core=(path:string)=>import(join(tree,'packages/plugin/src',path));
const pi=(path:string)=>import(join(tree,'packages/pi-plugin/src',path));
const {Database}=await core('shared/sqlite.ts');
const {setHarness}=await core('shared/harness.ts');setHarness(host==='pi'?'pi':host==='oc2'?'opencode2':'opencode');
const storage=await core('features/magic-context/storage.ts');
const piUtils=host==='pi'?await pi('test-utils.test.ts'):undefined;
const db=host==='pi'?piUtils.createTestDb(join(root,'context.db')):storage.openDatabase(join(root,'context.db'));
const {getOrCreateSessionMeta,updateSessionMeta}=await core('features/magic-context/storage-meta.ts');
const {resolveProjectIdentityForSession}=await core('features/magic-context/memory/project-identity.ts');
const projectPath=resolveProjectIdentityForSession(directory,true);
const {insertMemory}=await core('features/magic-context/memory/storage-memory.ts');
const {replaceAllCompartments}=await core('features/magic-context/compartment-storage.ts');
const {createCtxReduceTools}=await core('tools/ctx-reduce/tools.ts');
const {executeFlush}=await core('hooks/magic-context/execute-flush.ts');
const {copySessionStateForClone}=await core('features/magic-context/storage-clone.ts');
const {forkCloneFilter}=await core('v2/fork-inheritance.ts');
const {refreshModelLimitsFromApi}=await core('shared/models-dev-cache.ts');
await refreshModelLimitsFromApi({config:{providers:async()=>({data:{providers:[{id:'anthropic',models:{'claude-opus-5-5':{input:['text','image'],limit:{context:2000000,output:10000}}}}]}})}});
for(let i=0;i<12;i++)insertMemory(db,{projectPath,category:'NAMING',content:`Baseline ${i}: preserve useful names and exact request bytes.`,sourceType:'historian'});
const logs=await core('features/magic-context/transform-decision-log.ts');
const replay=await core('features/magic-context/storage-replay-document.ts');
let policy:any=null;
const policyKeys=['decision','materialized','materializeReason','lkgFrozenReleaseReason','bustedThisPass','emergency','systemHashPrev','systemHashNew','m0ModelKeyPrev','m0ModelKeyNew','m0ToolSetHashPrev','m0ToolSetHashNew'];
function findPolicy(value:any,depth=0):any {
 if(!value||typeof value!=='object'||depth>2)return null;
 if('decision'in value&&('materialized'in value||'materializeReason'in value))return value;
 for(const item of Array.isArray(value)?value:Object.values(value)){const found=findPolicy(item,depth+1);if(found)return found;}
 return null;
}
const spies:any[]=[];
for(const [name,fn] of Object.entries(logs))if(typeof fn==='function'&&(/record.*Decision|note.*UnbustedPass/.test(name))) {
 const original=fn as (...args:any[])=>any;
 spies.push(spyOn(logs,name as never).mockImplementation((...args:any[])=>{
  const found=findPolicy(args);if(found)policy=Object.fromEntries(policyKeys.map(key=>[key,found[key]===undefined&&['lkgFrozenReleaseReason','m0ToolSetHashPrev','m0ToolSetHashNew'].includes(key)?null:found[key]]));
  return original(...args);
 }));
}
let state=seed>>>0;
const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
type Session={id:string;raw:any[];ids:string[];hidden?:{raw:any[];ids:string[]}};
const sessions:Session[]=[{id:'diff-original',raw:[],ids:[]}];
let serial=0;
const model={providerID:'anthropic',modelID:'claude-opus-5-5'};
function add(session:Session,role:'user'|'assistant',tool:boolean,signed:boolean) {
 const id=`message-${serial++}`,created=now+serial;
 session.ids.push(id);
 if(host==='pi') {
  const message=role==='user'?piUtils.userMessage(`Question ${id} é🙂`,created):tool?piUtils.assistantToolCall(`call-${id}`,'Read',{path:`/src/${id}.ts`,query:`query ${id}`},created):piUtils.assistantMessage(`Answer ${id}`,created,{api:'anthropic-messages',provider:'anthropic',model:model.modelID});
  if(role==='assistant') {
   Object.assign(message,{api:'anthropic-messages',provider:'anthropic',model:model.modelID,stopReason:tool?'toolUse':'stop'});
   if(signed)message.content.unshift({type:'thinking',thinking:`Signed thought ${id} `+'detail '.repeat(40),thinkingSignature:`signature-${id}`});
  }
  session.raw.push(message);
  if(tool) {session.ids.push(`result-${id}`);session.raw.push(piUtils.toolResultMessage(`call-${id}`,`Result ${id}: `+'validated boundary output\n'.repeat(90),created+1));}
 } else {
  const parts:any[]=[];
  if(signed)parts.push({id:`${id}-reason`,messageID:id,sessionID:session.id,type:'reasoning',text:`Signed thought ${id} `+'detail '.repeat(40),metadata:{anthropic:{signature:`signature-${id}`}}});
  parts.push({id:`${id}-text`,messageID:id,sessionID:session.id,type:'text',text:`${role==='user'?'Question':'Answer'} ${id} é🙂`});
  if(tool)parts.push({id:`${id}-tool`,messageID:id,sessionID:session.id,type:'tool',tool:'Read',callID:`call-${id}`,state:{status:'completed',input:{path:`/src/${id}.ts`,query:`query ${id}`},output:`Result ${id}: `+'validated boundary output\n'.repeat(90),title:id,time:{start:created,end:created+1}}});
  session.raw.push({info:{id,sessionID:session.id,role,time:{created,completed:created+2},model,providerID:model.providerID,modelID:model.modelID,finish:tool?'tool-calls':'stop'},parts});
 }
}
add(sessions[0]!,'user',false,false);add(sessions[0]!,'assistant',false,false);
updateSessionMeta(db,sessions[0]!.id,{piStableIdScheme:1,systemPromptTokens:100});
replaceAllCompartments(db,sessions[0]!.id,[{sequence:0,startMessage:1,endMessage:2,startMessageId:sessions[0]!.ids[0],endMessageId:sessions[0]!.ids[1],title:'Opening',content:'Preserve the completed opening work.'}]);
let rawDb:any;
if(host!=='pi') {
 rawDb=new Database(process.env.OPENCODE_DB!);rawDb.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
 const shapes=JSON.parse(readFileSync(join(tree,'packages/plugin/src/features/magic-context/__fixtures__/opencode-store-shapes.json'),'utf8')).shapes;
 for(const sql of Object.values(shapes[host==='oc2'?'fresh_v2':'fresh_v1'].ddl))rawDb.exec(sql as string);
 rawDb.prepare("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('fixture',?,1,1,'[]')").run(directory);
}
function store(session:Session) {
 if(!rawDb)return;
 const table=host==='oc2'?'session_v2':'session';
 rawDb.prepare(`INSERT OR IGNORE INTO ${table}(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,'fixture',?,?,'Differential','fixture',?,?)`).run(session.id,session.id,directory,now,now);
 rawDb.prepare(`UPDATE ${table} SET revert=? WHERE id=?`).run(session.hidden?JSON.stringify({messageID:session.ids.at(-1)}):null,session.id);
 rawDb.transaction(()=>{
  session.raw.forEach((message,i)=>{
   const id=session.ids[i],info=message.info,created=info.time.created;
   if(host==='oc2') {
    rawDb.prepare('INSERT OR REPLACE INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)').run(id,session.id,info.role,i+1,created,now,JSON.stringify(info.role==='user'?{text:message.parts.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n')}:{content:message.parts}));
   } else {
    const {id:_id,sessionID:_session,...data}=info;
    rawDb.prepare('INSERT OR REPLACE INTO message(id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)').run(id,session.id,created,now,JSON.stringify(data));
    rawDb.prepare('DELETE FROM part WHERE message_id=?').run(id);
    for(const part of message.parts) {
     const {id:partId,sessionID:_s,messageID:_m,...content}=part;
     rawDb.prepare('INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)').run(partId,id,session.id,created,now,JSON.stringify(content));
    }
   }
  });
 })();
}
const availability=await core('hooks/magic-context/ctx-reduce-availability.ts');availability.setCtxReduceRegisteredGlobally(true);
const usage=new Map<string,any>(),liveModels=new Map<string,any>();
let currentPass=0;
let handler:any,adapt:any,fake:any;
if(host==='pi') {
 fake=piUtils.createFakePi();Object.assign(fake.pi,{getAllTools:()=>[]});
 const {registerPiContextHandler}=await pi('context-handler.ts');
 registerPiContextHandler(fake.pi,{db,signedThinkingHold:'on',scheduler:{executeThresholdPercentage:80},protectedTools:{Read:0,read:0},heuristics:{keepReasoningTokens:1000,clearReasoningAge:2},injection:{memoryEnabled:true,injectionBudgetTokens:10000,injectDocs:false,temporalAwareness:false}});
 handler=fake.handlers.get('context');
} else {
 const {createTagger}=await core('features/magic-context/tagger.ts');
 const {createTransform}=await core('hooks/magic-context/transform.ts');
 const {createMessagesTransformHandler}=await core('plugin/messages-transform.ts');
 const transform=createTransform({db,directory,projectPath,tagger:createTagger(),signedThinkingHold:'on',scheduler:{shouldExecute:()=>currentPass%13===0?'execute':'defer'},contextUsageMap:usage,historyRefreshSessions:new Set(),pendingMaterializationSessions:new Set(),lastHeuristicsTurnId:new Map(),historianRunnable:false,protectedTokens:0,protectedTools:{Read:0,read:0},clearReasoningAge:2,memoryConfig:{enabled:true,injectionBudgetTokens:10000,autoPromote:false},injectDocs:false,liveModelBySession:liveModels});
 handler=createMessagesTransformHandler({magicContext:{'experimental.chat.messages.transform':transform}});
 if(host==='oc2')adapt=(await core('v2/hooks/payload.ts')).adaptPayload;
}
const reduce=createCtxReduceTools({db,protectedSet:new Set(),protectedTools:{Read:0,read:0},getSessionTokens:()=>10000}).ctx_reduce;
const forkProofs:any[]=[];
const coverage={passes:0,served:0,refused:0,tools:0,signed:0,reverts:0,unreverts:0,forks:0,flushes:0,reductions:0,memoryChanges:0,policyRecords:0};
function fork(source:Session) {
 const child:Session={id:`diff-fork-${coverage.forks}`,raw:structuredClone(source.raw),ids:source.ids.map(id=>`fork-${coverage.forks}-${id}`)};
 const parentToFork=new Map(source.ids.map((id,i)=>[id,child.ids[i]]));
 if(host!=='pi')child.raw.forEach((message,i)=>{
  message.info.id=child.ids[i];message.info.sessionID=child.id;
  if(message.info.parentID)message.info.parentID=parentToFork.get(message.info.parentID)??message.info.parentID;
  message.parts.forEach((part:any)=>{part.id=`fork-${coverage.forks}-${part.id}`;part.messageID=child.ids[i];part.sessionID=child.id;});
 });
 const tags=db.prepare("SELECT message_id,tool_owner_message_id FROM tags WHERE session_id=? AND type='tool'").all(source.id) as {message_id:string;tool_owner_message_id:string|null}[];
 const tools=new Set(tags.filter(tag=>tag.tool_owner_message_id&&parentToFork.has(tag.tool_owner_message_id)).map(tag=>tag.message_id));
 const map={parentToFork,parentOrdinals:new Map(source.ids.map((id,i)=>[i+1,id])),forkOrdinals:new Map(child.ids.map((id,i)=>[id,i+1]))};
 copySessionStateForClone(db,source.id,child.id,forkCloneFilter(map,tools));
 const copied=(db.prepare('SELECT COUNT(*) AS n FROM tags WHERE session_id=?').get(child.id) as {n:number}).n;
 if(copied===0)throw new Error('fork did not copy real tag state');
 forkProofs.push({source:source.id,destination:child.id,copiedTags:copied,copiedToolIds:tools.size});
 sessions.push(child);coverage.forks++;add(child,'user',false,false);return child;
}
const records:any[]=[];
for(let index=0;index<passes;index++) {
 currentPass=index;now+=1000;
 let session=sessions[index% sessions.length]!;
 let action='defer';
 if([50,170].includes(index)) {
  session=sessions[0]!;const keep=Math.max(2,session.raw.length-10);
  session.hidden={raw:session.raw,ids:session.ids};session.raw=session.raw.slice(0,keep);session.ids=session.ids.slice(0,keep);coverage.reverts++;action='revert';
 } else if([55,175].includes(index)) {
  session=sessions[0]!;if(!session.hidden)throw new Error('missing revert snapshot');session.raw=session.hidden.raw;session.ids=session.hidden.ids;delete session.hidden;coverage.unreverts++;action='unrevert';
 } else if([95,195].includes(index)) {session=fork(sessions[0]!);action='fork';}
 else if(index>0 && !session.hidden && random()<0.65) {
   const tool=random()<0.75,signed=random()<0.8;add(session,'assistant',tool,signed);
   if(!tool || random()<0.45)add(session,'user',false,false);
  if(tool)coverage.tools++;if(signed)coverage.signed++;action=tool?'tool-turn':'answer';
 }
 store(session);
 if(index>0&&index%17===0) {executeFlush(db,session.id);coverage.flushes++;action+='-flush';}
 if(index>0&&index%11===0) {
  const tags=db.prepare("SELECT tag_number FROM tags WHERE session_id=? AND type='tool' AND status='active' ORDER BY tag_number LIMIT 2").all(session.id) as {tag_number:number}[];
  if(tags.length){const reply=await reduce.execute({drop:tags.map(row=>String(row.tag_number)).join(',')},{sessionID:session.id});if(String(reply).includes('Error:'))throw new Error(String(reply));coverage.reductions++;}
 }
 if(index>0&&index%37===0){insertMemory(db,{projectPath,category:'NAMING',content:`Learned at ${index}: preserve archived identities and cached bytes.`,sourceType:'historian'});coverage.memoryChanges++;}
 policy=null;
 let output:any,refused=false;
 try {
 if(host==='pi') {
  const messages=structuredClone(session.raw);
  output=await handler({messages},{...piUtils.fakeContext(session.id,directory,session.ids,messages),getSystemPrompt:()=> 'Differential system.',getContextUsage:()=>({tokens:10000,percent:5,contextWindow:2000000}),model:{provider:model.providerID,id:model.modelID,api:'anthropic-messages',contextWindow:2000000,maxTokens:10000}});
 } else {
  usage.set(session.id,{usage:{percentage:5,inputTokens:10000},updatedAt:now});liveModels.set(session.id,model);
  if(host==='oc2') {
   const draft={sessionID:session.id,model:{providerID:model.providerID,id:model.modelID,limit:{context:2000000}},agent:'build',system:['Differential system.'],options:{},tools:{ctx_reduce:{description:'reduce',input:{type:'object'}}},messages:structuredClone(session.raw).map((message:any)=>({id:message.info.id,role:message.info.role,content:message.parts}))};
   const adapted=adapt(draft);await handler({},adapted);adapted.commit();output=draft;
  } else {output={messages:structuredClone(session.raw)};await handler({},output);}
 }
  } catch(error) {
   refused=true;coverage.refused++;
  const chain:any[]=[];for(let item:any=error;item&&chain.length<6;item=item.cause)chain.push({name:item.name,code:item.code??null,site:item.site??null});
  output={refused:chain};
 }
 if(!refused)coverage.served++;
 await new Promise<void>(done=>setTimeout(done,5));
 if(!policy && !refused) {
  const pending=host==='pi'?logs.__test.getPendingPi(session.id):logs.__test.getPending(session.id)??logs.__test.getStagedV2(session.id);
  const found=findPolicy(pending);if(found?.tsMs===now)policy=Object.fromEntries(policyKeys.map(key=>[key,found[key]??null]));
 }
 if(policy)coverage.policyRecords++;
 const bytes=JSON.stringify(output);
  // Pi's LKG fast path emits no policy log; compare the full persisted replay choices on every pass too.
  const replayDecisions=replay.serializeReplayDocument(replay.readReplayDocument(db,session.id));
  records.push({index,session:session.id,action,refused,bytes,sha256:createHash('sha256').update(bytes).digest('hex'),policy,replayDecisions});coverage.passes++;
}
for(const spy of spies)spy.mockRestore();
if(passes>=240 && (coverage.reverts!==2||coverage.unreverts!==2||coverage.forks!==2||coverage.served<200||coverage.tools<50||coverage.signed<50||coverage.reductions<10||coverage.policyRecords<(host==='pi'?10:100)))throw new Error('insufficient differential coverage: '+JSON.stringify(coverage));
const dropped=(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE status='dropped'").get() as {n:number}).n;
if(passes>=240&&dropped===0)throw new Error('ctx_reduce never applied a real drop');
const result={host,seed,tool:`Bun ${Bun.version}`,coverage,forkProofs,dropped,records};writeFileSync(join(root,'complete-diff.json'),JSON.stringify(result));console.log('COMPLETE_DIFF',JSON.stringify({host,seed,coverage}));
rawDb?.close();if(host==='pi')db.close();else storage.closeDatabase();
