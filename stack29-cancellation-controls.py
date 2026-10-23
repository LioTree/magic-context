import os
from pathlib import Path
import re
import subprocess

path=Path('packages/pi-plugin/src/tag-snapshot-pi.ts')
original=path.read_text()
saved=Path(os.environ['TMPDIR'])/'stack29-cancellation-original.ts'
saved.write_text(original)
first='returning to a preempted hydration waits for release and does not poison the next session'
second='cancelled prewarm is never shared by readiness before its worker releases'

def run(name):
 r=subprocess.run(['bun','test','--parallel=1','--timeout','30000','src/tag-snapshot-hydration-pi.test.ts','-t','^'+re.escape(name)+'$'],cwd='packages/pi-plugin',stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env=dict(os.environ,BUN_JSC_useOMGJIT='0'))
 print(r.stdout,flush=True)
 return r
print('BUN',subprocess.check_output(['bun','--version'],text=True).strip(),flush=True)
for name in [first,second]:
 print('CANCELLATION_BASELINE',name,flush=True); assert run(name).returncode==0
reuse,count=re.subn(r'&&\s*!current\.cancelled', '/* NON-VACUITY BREAK: cancelled result can be shared */',original)
assert count==1
backoff,count=re.subn(r'!destination\.cancelled\s*&&', 'true /* NON-VACUITY BREAK: cancellation poisons backoff */ &&',original)
assert count==1
publication,count=re.subn(r'if \(destination\.cancelled\)(\s+)throw new PiTagHydrationError\(\s*"owner hydration cancelled",\s*"stale",?\s*\);',r'if (false /* NON-VACUITY BREAK: cancelled publication admitted */)\1throw new PiTagHydrationError("owner hydration cancelled", "stale");',original)
assert count==1
for label,mutant,name in [('reuse-returning',reuse,first),('reuse-prewarm',reuse,second),('backoff',backoff,first),('publication',publication,first)]:
 try:
  path.write_text(mutant)
  print('CANCELLATION_MUTATION',label,[line.strip() for line in mutant.splitlines() if 'NON-VACUITY BREAK' in line],flush=True)
  subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)])
  result=run(name)
  failed={re.sub(r' \[[^\]]+\]$','',line) for line in result.stdout.splitlines() if line.startswith('(fail)')}
  assert result.returncode!=0 and len(failed)==1 and name in next(iter(failed)), (label,result.returncode,failed)
  print('CANCELLATION_CONTROL_RED',label,name,flush=True)
 finally:
  path.write_text(original); path.touch()
  assert subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)]).returncode==0
  print('CANCELLATION_RESTORED',label,'empty diff',flush=True)
