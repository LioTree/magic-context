import hashlib
import json
import os
from pathlib import Path
import subprocess

root=Path.cwd()
subprocess.run(['python3','stack29-classify-final.py','--focus='],check=True)
base=Path(os.environ['TMPDIR'])/'stack29-train-base'
relative=Path('packages/plugin/src/hooks/magic-context/system-prompt-delivery-differential.test.ts')
(base/relative).write_bytes((root/relative).read_bytes())
planner_relative=Path('packages/plugin/src/hooks/magic-context/emergency-drop.ts')
old_planner=(base/planner_relative).read_text()
new_planner=(root/planner_relative).read_text()
needle='    const reclaimTokens = Math.round(currentTotalInputTokens - target);'
assert old_planner.count(needle)==1
assert 'if (fixedFloor > ceilingTokens)' not in old_planner
start=new_planner.index('    // Tool drops cannot repair oversized fixed overhead.')
end=new_planner.index('    // Already at/under target',start)
guard=new_planner[start:end]
ref731=old_planner.replace(needle,needle+'\n'+guard)
rows={}; plans={}; wires={}

def run(label,tree,planner):
 path=tree/planner_relative; original=path.read_text()
 test=tree/relative; original_test=test.read_text()
 marker='            now = fixedClock + e.pass * 1000;'
 parts=original_test.split(marker); assert len(parts)==3
 oc='\n            (globalThis as any).__STACK29_CASE = {host,signed,active,seed,pass:e.pass}; // NON-VACUITY BREAK\n'
 pi='\n            (globalThis as any).__STACK29_CASE = {host:"pi",signed,active,seed,pass:e.pass}; // NON-VACUITY BREAK\n'
 observed_test=parts[0]+marker+oc+parts[1]+marker+pi+parts[2]
 observed_planner=planner
 if 'if (fixedFloor > ceilingTokens)' in planner:
  observed_planner=planner.replace('    if (fixedFloor > ceilingTokens) {','    if (fixedFloor > ceilingTokens) {\n        console.log("CAUSAL_731",JSON.stringify({...((globalThis as any).__STACK29_CASE ?? {}),input:currentTotalInputTokens,tail:tailTokens,floor:fixedFloor,ceiling:ceilingTokens})); // NON-VACUITY BREAK')
 output=Path(os.environ['TMPDIR'])/(label+'.json')
 try:
  path.write_text(observed_planner); test.write_text(observed_test)
  wire_output=Path(os.environ['TMPDIR'])/(label+'-wires.json')
  env=dict(os.environ,BUN_JSC_useOMGJIT='0',REVIEW_OUT=str(output),REVIEW_WIRES_OUT=str(wire_output))
  result=subprocess.run(['bun','test','--parallel=1','--timeout','30000',str(relative.relative_to('packages/plugin'))],cwd=tree/'packages/plugin',env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  print('MEASUREMENT_ONLY',label,'exit=',result.returncode,'golden assertion deliberately not claimed',flush=True)
  assert result.returncode==0,result.stdout[-10000:]
  parsed=json.loads(output.read_text())
  rows[label]={(r['host'],r['signed'],r['seed']):r['bodies'] for r in parsed if r['signed'] and not r['active']}
  assert len(rows[label])==12 and all(len(v)==80 for v in rows[label].values())
  wires[label]=json.loads(wire_output.read_text())
  probe=json.loads(wires[label][next(iter(rows[label].values()))[0]])
  print('MEASUREMENT_PROJECTION',label,type(probe).__name__,list(probe)[:8] if isinstance(probe,dict) else 'not-object',flush=True)
  plans[label]=[json.loads(line.partition(' ')[2]) for line in result.stdout.splitlines() if line.startswith('CAUSAL_731 ')]
 finally:
  path.write_text(original); path.touch(); test.write_text(original_test); test.touch()
  assert path.read_text()==original and test.read_text()==original_test
  print('MEASUREMENT_RESTORED',label,flush=True)

run('base-strict',base,old_planner)
run('base-strict-plus731',base,ref731)
run('merged-strict',root,new_planner)

out=root/'.cortexkit/internal-docs/investigations/train-stack29-evidence/differential-causal-proof.json'
out.parent.mkdir(parents=True,exist_ok=True)
report=[]

def leaves(a,b,path=''):
 if a==b: return []
 if isinstance(a,dict) and isinstance(b,dict):
  result=[]
  for key in sorted(set(a)|set(b)): result+=leaves(a.get(key),b.get(key),path+'/'+str(key))
  return result
 if isinstance(a,list) and isinstance(b,list) and len(a)==len(b):
  result=[]
  for i,(x,y) in enumerate(zip(a,b)): result+=leaves(x,y,path+'/'+str(i))
  return result
 def value(v):
  s=json.dumps(v,separators=(',',':'),ensure_ascii=False)
  return {'sha256':hashlib.sha256(s.encode()).hexdigest(),'length':len(s),'sample':s[:180]}
 return [{'path':path,'before':value(a),'after':value(b)}]

all_equal=True
for key,before in rows['base-strict'].items():
 after=rows['base-strict-plus731'][key]; actual=rows['merged-strict'][key]
 equal=after==actual; all_equal &= equal
 changed=[]; system_changes=[]
 for i,(a,b) in enumerate(zip(before,after)):
  if a==b: continue
  if a.startswith('ERROR:') or b.startswith('ERROR:'):
   diff=[{'path':'/error','before':a[:200],'after':b[:200]}]
  else:
   aa=json.loads(wires['base-strict'][a]); bb=json.loads(wires['base-strict-plus731'][b]); diff=leaves(aa,bb)
   if isinstance(aa,dict) and isinstance(bb,dict) and aa.get('system')!=bb.get('system'): system_changes.append(i)
  changed.append({'pass':i,'changes':diff})
 case_plans=[p for p in plans['base-strict-plus731'] if (p.get('host'),p.get('signed'),p.get('seed'))==key and not p.get('active')]
 row={'host':key[0],'seed':key[2],'reference731_equals_merged_all80':equal,'first_changed_pass':changed[0]['pass'] if changed else None,'changed_passes':len(changed),'system_changed_passes':system_changes,'guard_decisions':case_plans,'all_changed_blocks':changed,'reference_wire_hash':hashlib.sha256('\n'.join(after).encode()).hexdigest()}
 report.append(row)
 print('CAUSAL_CASE',json.dumps({k:v for k,v in row.items() if k not in ['all_changed_blocks','guard_decisions']},separators=(',',':')),flush=True)
 if not equal:
  first=next((i for i,(a,b) in enumerate(zip(after,actual)) if a!=b),None)
  print('UNEXPLAINED_MERGED_DIFF',key,'pass',first,flush=True)
  if first is not None:
   a=after[first]; b=actual[first]
   print('REFERENCE',wires['base-strict-plus731'].get(a,a)[:2000],flush=True); print('MERGED',wires['merged-strict'].get(b,b)[:2000],flush=True)
out.write_text(json.dumps(report,indent=2)+'\n')
print('CAUSAL_ALL_REFERENCE_EQUALS_MERGED',all_equal,flush=True)
print('CAUSAL_PROOF_JSON='+json.dumps(report,separators=(',',':')),flush=True)
raise SystemExit(not all_equal)
