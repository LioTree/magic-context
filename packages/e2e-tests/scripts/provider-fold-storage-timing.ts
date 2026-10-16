import assert from "node:assert/strict";
import {mkdirSync,mkdtempSync,writeFileSync,statSync,readFileSync,existsSync,readdirSync} from "node:fs";
import {tmpdir,availableParallelism} from "node:os";
import {join} from "node:path";
import {buildDriver,Driver,fixture,message,tools} from "./provider-pipeline-differential";
import {updateSessionMeta} from "../../plugin/src/features/magic-context/storage-meta";
import {percentile} from "../../plugin/scripts/perf-audit/provider-pipeline-gate";
import {systemSample,psiDelta} from "./provider-post-rebuild-profile";

export async function foldStorageTiming(samples=50) {
    process.env.MC_RESIDENT_HOOKS="1";
    process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK="1";
    const root=join(tmpdir(),"magic-context","fold-storage-timing");mkdirSync(root,{recursive:true});
    const work=mkdtempSync(join(root,"run-"));mkdirSync(join(work,"stores"));
    const binary=buildDriver(join(work,"build"));
    let driver=new Driver(binary,join(work,"stores"));
    const threads=()=>Object.fromEntries(readdirSync(`/proc/${driver.pid}/task`).flatMap(id=>{
        try {
            const stat=readFileSync(`/proc/${driver.pid}/task/${id}/stat`,"utf8");
            const end=stat.lastIndexOf(")"),fields=stat.slice(end+2).split(/\s+/);
            return [[id,{name:stat.slice(stat.indexOf("(")+1,end),cpu_ticks:Number(fields[11])+Number(fields[12])}]];
        } catch {return [];}
    }));
    const results:Record<string,any>[]=[];
    try {
        for (const host of ["OpenCode1","OpenCode2"] as const) {
            // Scheduled historian work owns its handler after a fixture closes.
            // End the prior process so one host's retired fixture cannot consume
            // CPU during the other host's ordinary-fold measurement.
            if(host==="OpenCode2") {await driver.close();driver=new Driver(binary,join(work,"stores"));}
            const directory=join(work,"stores",host);
            const f=await fixture(driver,host,directory,false,true);
            try {
                updateSessionMeta(f.db,"session",{lastUsageContextLimit:4_000_000});
                const history=Array.from({length:17000},(_,i)=>i%5===0?message(`synthetic-${i}`,"user",`Fixture ${i}: café 🦀`):i%5===4?message(`synthetic-${i}`,"assistant",`Fixture ${i} completed`):tools(`synthetic-${i}`));
                history.forEach((entry,i)=>{(entry.info as any).absolute_ordinal=i+1;});
                await f.full(history);await f.pass(history);
                await f.event("realistic_seed",{covered:16500,compartments:2300,memories:1000});
                await f.full(history);await f.pass(history);
                const state=f.stored()!;
                const base=f.wires.filter(w=>w.method==="compaction.step").at(-1)!.params;
                let applied={compaction_id:state.views.at(-1)!.compaction_id,version:state.views.at(-1)!.version};
                const sql=(statement:string,write=false)=>driver.send({op:"sql",rig:f.rig,sql:statement,write});
                if(process.env.MC_TIMING_AUTOCHECKPOINT_OFF==="1")await driver.send({op:"autocheckpoint",rig:f.rig,frames:0});
                const wal=()=>{
                    const path=join(directory,"store.db-wal"),shmPath=join(directory,"store.db-shm");
                    if(!existsSync(path)||!existsSync(shmPath))return null;
                    const shm=readFileSync(shmPath);
                    // The Linux fixture's WAL-index header stores mxFrame at byte 16.
                    return {bytes:statSync(path).size,active_frames:shm.readUInt32LE(16)};
                };
                const footprint=async()=>{
                    await sql("PRAGMA wal_checkpoint(TRUNCATE)",true);
                    const db=statSync(join(directory,"store.db")).size;
                    const storage=await sql("SELECT 'v1',count(*),coalesce(sum(length(replacement_json)),0) FROM mc_provider_views_v1 UNION ALL SELECT 'v2',count(*),coalesce(sum(length(view_meta_json)+length(sequence_json)+coalesce(length(new_head_history_bytes),0)),0) FROM mc_provider_views_v2 UNION ALL SELECT 'overrides',count(*),coalesce(sum(length(patch_json)),0) FROM mc_provider_view_overrides_v1 UNION ALL SELECT 'policy_tail',count(*),coalesce(sum(length(policy_json)),0) FROM mc_provider_policy_parts_v1 UNION ALL SELECT 'frozen_facts',count(*),coalesce(sum(length(frozen_policy_bytes)),0) FROM mc_provider_messages_v1 WHERE frozen_policy_format=1 UNION ALL SELECT 'cuts',count(*),coalesce(sum(length(baseline_json)+length(defaults_json)+length(prefix_totals_json)+length(policy_key)),0) FROM mc_provider_policy_cuts_v1");
                    return {db_bytes:db,store_bytes_per_native_message:db/history.length,storage};
                };
                const start=await footprint();
                const sampleStart=systemSample();
                for(let sample=-2;sample<samples;sample++) {
                    await f.event("realistic_visible_delta",{sample:sample+2});await f.event("flush");
                    const id=`fold-${host}-${sample}`;
                    const body={method:"compaction.step",params:{...base,messages:[],request_id:id,step_id:id,model:base.model,now:2000+sample*1000,newest:{ordinal:state.state.next_ordinal-1,mid:history.at(-1)!.info.id},served_through_ordinal:state.state.next_ordinal-1,last_applied:applied}};
                    delete (body.params as any).more;delete (body.params as any).last_not_applied;
                    const before=systemSample();
                    const walBefore=wal();
                    const threadsBefore=threads();
                    const answer=await driver.send({op:"call",rig:f.rig,timing:true,body});
                    const after=systemSample();
                    const walAfter=wal();
                    const threadsAfter=threads();
                    assert.ok(!answer.error,JSON.stringify(answer.error));
                    assert.equal(answer.ok.answer,"compaction_message");
                    applied={compaction_id:answer.ok.compaction.compaction_id,version:answer.ok.compaction.version};
                    const bytes=await sql("SELECT coalesce(length(view_meta_json)+length(sequence_json)+coalesce(length(new_head_history_bytes),0),0)+(SELECT coalesce(sum(length(patch_json)),0) FROM mc_provider_view_overrides_v1 o WHERE o.conv_key=v.conv_key AND o.version=v.version) FROM mc_provider_views_v2 v WHERE version="+applied.version);
                    results.push({host,sample,warmup:sample<0,module_ms:answer.module_ms,cpu_ms:answer.cpu_ms,scheduler_wait_ms:answer.scheduler_wait_ms,db_acquire_ms:answer.db_acquire_ms,db_callback_ms:answer.db_callback_ms,db_finish_ms:answer.db_finish_ms,response_bytes:Buffer.byteLength(answer.raw),view_bytes:bytes,resident:await driver.send({op:"resident_stats",rig:f.rig}),before,after,wal_before:walBefore,wal_after:walAfter,threads_before:threadsBefore,threads_after:threadsAfter,psi:psiDelta(before,after)});
                }
                const sampleEnd=systemSample();
                const end=await footprint();
                results.push({host,retention:true,folds:samples,start,end,sample_start:sampleStart,sample_end:sampleEnd,db_growth_bytes:end.db_bytes-start.db_bytes});
            } finally {await f.close();}
        }
    } finally {await driver.close();}
    const lanes=["OpenCode1","OpenCode2"].map(host=>{const rows=results.filter(r=>r.host===host&&!r.retention&&!r.warmup);return {host,samples:rows.length,fold_p50_ms:percentile(rows.map(r=>r.module_ms),.5),fold_p95_ms:percentile(rows.map(r=>r.module_ms),.95),fold_p99_ms:percentile(rows.map(r=>r.module_ms),.99),over_100_ms:rows.filter(r=>r.module_ms>=100).length,over_250_ms:rows.filter(r=>r.module_ms>=250).length};});
    const result={bun:Bun.version,cpus:availableParallelism(),work,lanes,results};
    const printed=process.env.MC_TIMING_BRIEF==="1"?{...result,results:results.map(row=>row.retention?row:{host:row.host,sample:row.sample,module_ms:row.module_ms,cpu_ms:row.cpu_ms,scheduler_wait_ms:row.scheduler_wait_ms,response_bytes:row.response_bytes,view_bytes:row.view_bytes,resident:row.resident,psi:row.psi,pressure_before:row.before.host_cpu_pressure,pressure_after:row.after.host_cpu_pressure})}:result;
    console.log("FOLD_STORAGE_TIMING_RESULT="+JSON.stringify(printed));
    if(process.env.MC_TIMING_RESULT_OUT)writeFileSync(process.env.MC_TIMING_RESULT_OUT,JSON.stringify(result,null,2)+"\n");
    return result;
}
if(import.meta.main)await foldStorageTiming(Number(Bun.argv[2]??50));
