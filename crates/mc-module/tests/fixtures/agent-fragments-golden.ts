// Generate/check agent-fragments-golden.json using composeSoftMemoryUpdates,
// the production memory-delta renderer shared by the TypeScript and Pi plugins.
import { Database } from "bun:sqlite";
import { composeSoftMemoryUpdates } from "../../../../packages/plugin/src/hooks/magic-context/inject-compartments";
import type { AppliedProjection } from "../../../../packages/plugin/src/features/magic-context/memory/applied-projection";
import { renderAddedFragmentLine, renderUpdatedFragmentLine, renderRemovedFragmentLine, renderSupersededFragmentLine } from "../../../../packages/plugin/src/features/magic-context/memory/agent-fragments";

const db = new Database(":memory:");
db.exec(`CREATE TABLE memory_agent_fragments(id INTEGER PRIMARY KEY,session_id TEXT,harness TEXT,project_path TEXT,operation_key TEXT,memory_ids_json TEXT,current_id INTEGER,lines TEXT,visible_texts_json TEXT)`);
const file = new URL("./agent-fragments-golden.json",import.meta.url);
const cases: unknown[] = [];
let seed = 0x54c0ffee;
const random = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed; };
const fresh = (): AppliedProjection => ({generation:1,hardMemoryBlock:JSON.stringify({updateLines:[],newMemories:""}),fragmentWatermark:0,committed:[],legacy:false});
let projection = fresh();
let nextId = 0;
for (let step=0;step<160;step++) {
    const pass = step<4 ? "soft" : ["soft","defer","hard"][random()%3];
    const pending = [];
    if (pass === "hard") { db.exec("DELETE FROM memory_agent_fragments"); projection=fresh(); }
    const before = structuredClone(projection);
    if (pass === "soft") {
        for (let index=0;index<1+random()%6;index++) {
            const id=++nextId;
            const text = step === 0 ? "literal & <claim> \"quoted\" 🦀" : "immutable claim ".repeat(1+random()%90);
            const kind = random()%4;
            const lines = kind===0 ? [renderRemovedFragmentLine(id)] : kind===1 ? [renderSupersededFragmentLine(id,id+100),renderAddedFragmentLine(id+100,"CONSTRAINTS",text)] : [kind===2 ? renderUpdatedFragmentLine(id,"CONSTRAINTS",text) : renderAddedFragmentLine(id,"CONSTRAINTS",text)];
            const memoryIds=kind===1 ? [id,id+100] : [id];
            const currentId=kind===0 ? null : kind===1 ? id+100 : id;
            const visibleTexts=currentId===null ? [] : [{id:currentId,text}];
            const fragment={id,operationKey:`op-${id}`,memoryIds,currentId,lines,visibleTexts};
            pending.push(fragment);
            db.prepare("INSERT INTO memory_agent_fragments VALUES(?, 'ses','opencode','/repo',?,?,?,?,?)").run(id,fragment.operationKey,JSON.stringify(memoryIds),currentId,lines.join("\n"),JSON.stringify(visibleTexts));
        }
    }
    const memoryBudgetTokens=step===0 ? 8000 : [0,100,500,1200,8000][random()%5];
    const historyBudgetTokens=60000;
    const independentTokens=random()%1000;
    const m0Tokens=[0,499,500,8000][random()%4];
    let block="";
    if (pass==="soft") { const result=composeSoftMemoryUpdates({db:db as never,sessionId:"ses",projection,memoryBudgetTokens,historyBudgetTokens,independentTokens,m0Tokens:()=>m0Tokens}); projection=result.projection;block=result.block; }
    cases.push({pass,before,pending,memoryBudgetTokens,historyBudgetTokens,independentTokens,m0Tokens,block,committed:projection.committed});
}
const rendered="[\n"+cases.map(item=>JSON.stringify(item)).join(",\n")+"\n]\n";
if (process.argv.includes("--check")) {
    if (await Bun.file(file).text()!==rendered) throw new Error("Rust fragment golden differs from TS/Pi production output");
    console.log(`TS/Pi fragment parity: ${cases.length} fixed-seed pass cases checked`);
} else {
    await Bun.write(file,rendered);
    console.log(`TS/Pi fragment parity: ${cases.length} fixed-seed pass cases generated`);
}
