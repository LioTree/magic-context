import os
from pathlib import Path
import re
import subprocess

root=Path.cwd()
subprocess.run(['python3','stack29-classify-final.py','--focus='],check=True)
base=Path(os.environ['TMPDIR'])/'stack29-train-base'
for label,tree in [('merged',root),('base',base)]:
 print('PI_HOST_CLASSIFY_BUILD',label,flush=True)
 command='bun run --cwd packages/plugin build && bun run --cwd packages/pi-plugin build && bun run --cwd packages/pi-plugin build:e2e-argv'
 result=subprocess.run(['bash','-c',command],cwd=tree,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 if result.returncode:
  print(result.stdout,flush=True); raise SystemExit(result.returncode)
 file='packages/e2e-tests/tests/dreamer-pi-model-chain.test.ts'
 if not (tree/file).exists():
  (tree/file).write_bytes((root/file).read_bytes()); print('PI_HOST_TEST_ONLY_OVERLAY',label,flush=True)
 command=['python3',str(root/'stack29-host-gate.py'),'pi','--file=tests/dreamer-pi-model-chain.test.ts','--pattern=uses its valid primary']
 print('PI_HOST_CLASSIFY',label,command,flush=True)
 result=subprocess.run(command,cwd=tree,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 lines=result.stdout.splitlines(); chosen=set()
 for i,line in enumerate(lines):
  if re.search(r'^HOST_|^\(fail\)|^\(pass\)|^Ran |^\s*\d+ (pass|fail|skip|expect\(\))|^error:|timeout',line):
   chosen.add(i)
   if '(fail)' in line or line.startswith('error:'): chosen.update(range(max(0,i-18),min(len(lines),i+2)))
 print('\n'.join(lines[i] for i in sorted(chosen)),flush=True)
 print('PI_HOST_CLASSIFY_EXIT',label,result.returncode,flush=True)
