import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path.cwd()
logs = root/'.cortexkit/internal-docs/investigations/stack29-final-classification'
logs.mkdir(parents=True,exist_ok=True)
base = Path(os.environ['TMPDIR'])/'stack29-train-base'
sha='f6da71695e206ece5d3847bbebd879d5dbb8eb10'
subprocess.run(['git','clone','--shared','--no-checkout','--quiet',str(root),str(base)],check=True)
(base/'.git/HEAD').write_text(sha+'\n')
subprocess.run(['git','read-tree',sha],cwd=base,check=True)
p=subprocess.Popen(['git','archive',sha],stdout=subprocess.PIPE)
t=subprocess.run(['tar','-x','-C',str(base)],stdin=p.stdout)
p.stdout.close(); assert p.wait()==0 and t.returncode==0

def links(source,dest):
 dest.mkdir(parents=True,exist_ok=True)
 for entry in source.iterdir():
  target=dest/entry.name
  if entry.is_symlink():
   link=os.readlink(entry)
   if Path(link).is_absolute():
    try: link=str(base/'packages'/Path(link).relative_to(root/'packages'))
    except ValueError: pass
   target.symlink_to(link,target_is_directory=entry.is_dir())
  elif entry.is_dir() and (entry.name.startswith('@') or entry.name=='.bin'): links(entry,target)
  elif entry.is_dir():
   if entry.name!='.cache': target.symlink_to(entry,target_is_directory=True)
  else: shutil.copy2(entry,target)
for relative in [Path('node_modules'),*[p.relative_to(root) for p in (root/'packages').glob('*/node_modules')]]:
 links(root/relative,base/relative)

cases=[
 ('plugin','src/hooks/magic-context/auto-embed-session.test.ts','re-embeds 1600 old chunks'),
 ('plugin','src/v2/hooks/issue-750-defer-after-execute.test.ts','historian join at 97'),
 ('plugin','src/v2/hooks/model-limit-refresh.test.ts','re-reads the model catalog'),
 ('plugin','src/hooks/magic-context/compartment-runner-turn-one-review.test.ts','binds anchors of out-of-order'),
 ('plugin','src/hooks/magic-context/system-first-hook-order.test.ts','explicit history refresh consumes published'),
 ('plugin','src/hooks/magic-context/system-prompt-delivery-differential.test.ts','.'),
 ('pi-plugin','src/held-head-replay-witness.test.ts','held-head witness'),
 ('pi-plugin','src/index-env-guard.test.ts','registers the full runtime when the subagent guard is absent'),
 ('pi-plugin','src/inject-compartments-pi.test.ts','pi applied compaction bounds auto-search blob'),
 ('pi-plugin','src/issue-630-review.test.ts','Pi 95 percent without unsafe work'),
 ('pi-plugin','src/issue-665-hold-review-r2.test.ts','held replay over a shrunken window'),
 ('pi-plugin','src/latest-turn-thinking.test.ts','Pi Anthropic task applies queued drops mid-turn'),
 ('pi-plugin','src/latest-turn-thinking.test.ts','Pi rewriting first render'),
 ('pi-plugin','src/latest-turn-thinking.test.ts','Pi wall strips kept thinking'),
 ('pi-plugin','src/note-nudge-cache-review-witness.test.ts','pending note waits through 48'),
 ('pi-plugin','src/pending-user-prefix-pi.test.ts','different pending user cannot escape'),
 ('pi-plugin','src/session-identity-decision.test.ts',"keeps A.s git decision after B"),
 ('pi-plugin','src/signed-thinking-s03a-review.test.ts','handler refuses unproven stable-id migration'),
]
focus=next((set(a.split('=',1)[1].split(',')) for a in sys.argv if a.startswith('--focus=')),None)
summary=[]
print('VERSIONS',subprocess.check_output(['bun','--version'],text=True).strip(),flush=True)
for i,(package,file,pattern) in enumerate(cases):
 if focus is not None and str(i) not in focus: continue
 for label,tree in [('merged',root),('base',base)]:
  destination=tree/'packages'/package/file
  if not destination.exists():
   destination.parent.mkdir(parents=True,exist_ok=True)
   destination.write_bytes((root/'packages'/package/file).read_bytes())
   print('TEST_ONLY_OVERLAY',label,file,flush=True)
  env=dict(os.environ,BUN_JSC_useOMGJIT='0',RUSTC_WRAPPER='',CARGO_BUILD_RUSTC_WRAPPER='')
  env.pop('OPENCODE_DB',None)
  command=['bun','test','--parallel=1','--timeout','30000',file,'-t',pattern]
  if i==0: command=['bun','run','test:active-session-backfill']
  name=f'{i}-{label}'; path=logs/(name+'.log')
  with path.open('w') as out: result=subprocess.run(command,cwd=tree/'packages'/package,env=env,stdout=out,stderr=subprocess.STDOUT)
  text=path.read_text(errors='replace')
  if label=='base' and ('matched 0 tests' in text or 'No tests found' in text):
   destination.write_bytes((root/'packages'/package/file).read_bytes())
   print('RENAMED_TEST_ONLY_OVERLAY',file,flush=True)
   with path.open('w') as out: result=subprocess.run(command,cwd=tree/'packages'/package,env=env,stdout=out,stderr=subprocess.STDOUT)
   text=path.read_text(errors='replace')
  lines=text.splitlines(); chosen=set()
  for n,line in enumerate(lines):
   if re.search(r'^\(fail\)|^\(pass\)|^Ran |^\s*\d+ (pass|fail|skip|expect\(\))|^error:',line):
    chosen.add(n)
    if line.startswith('(fail)') or line.startswith('error:'): chosen.update(range(max(0,n-18),min(len(lines),n+2)))
  print('\nCLASSIFY',name,package,file,pattern,'exit='+str(result.returncode),flush=True)
  print('\n'.join(lines[n] for n in sorted(chosen)),flush=True)
  summary.append({'case':i,'tree':label,'exit':result.returncode,'counts':[line for line in lines if re.search(r'^Ran |^\s*\d+ (pass|fail|skip)$',line)],'failures':[line for line in lines if line.startswith('(fail)')]})
print('CLASSIFICATION_JSON='+json.dumps(summary,separators=(',',':')),flush=True)
