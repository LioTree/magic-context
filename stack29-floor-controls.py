from pathlib import Path
import json
import os
import re
import subprocess

root = Path.cwd()
planner = root/'packages/plugin/src/hooks/magic-context/emergency-drop.ts'
source = planner.read_text()
marker = '    if (fixedFloor > ceilingTokens) {'
assert source.count(marker) == 1
instrumented = source.replace(marker, marker+'\n        console.log(`ISSUE_731_DECISION fixed floor ${Math.round(fixedFloor)} exceeds ceiling ${Math.round(ceilingTokens)}; input=${currentTotalInputTokens} tail=${Math.round(tailTokens)}`); // NON-VACUITY BREAK')
files = [
    ('plugin', 'packages/plugin/src/hooks/magic-context/signed-thinking-prefix-audit.test.ts', ['OpenCode 1 TS mode', 'OpenCode 2']),
    ('pi-plugin', 'packages/pi-plugin/src/signed-thinking-prefix-audit.test.ts', ['Pi/OMP']),
]
summary = []
saved_planner = Path(os.environ['TMPDIR'])/'stack29-planner-original.ts'
saved_planner.write_text(source)
try:
    planner.write_text(instrumented)
    print('OLD_INPUT_DIAGNOSTIC', [line.strip() for line in instrumented.splitlines() if 'NON-VACUITY BREAK' in line], flush=True)
    for package, relative, hosts in files:
        path = root/relative
        original = path.read_text()
        saved = Path(os.environ['TMPDIR'])/('stack29-audit-'+package+'.ts')
        saved.write_text(original)
        old = subprocess.check_output(['git','show','f6da71695e206ece5d3847bbebd879d5dbb8eb10:'+relative], text=True)
        # Only the old fixture setup is restored: the contract fence verifies
        # every assertion, name and timeout is already identical to this source.
        path.write_text(old)
        subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)])
        try:
            for host in hosts:
                cases = [
                    ('primary', f'signed prefix audit: {host}, primary mid tool loop.*emergency 95% wall$'),
                    ('control', f'signed prefix audit: {host}, primary mid tool loop.*control: emergency 95% wall lands validly'),
                    ('subagent', f'signed prefix audit: {host}, subagent run.*emergency 95% wall$'),
                ]
                for name, pattern in cases:
                    result = subprocess.run(['bun','test',str(path.relative_to(root/'packages'/package)),'-t',pattern],cwd=root/'packages'/package,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env=dict(os.environ,BUN_JSC_useOMGJIT='0'))
                    lines = result.stdout.splitlines()
                    floors = [line for line in lines if line.startswith('ISSUE_731_DECISION')]
                    counts = [line for line in lines if re.search(r'^\s*\d+ (pass|fail|skip)$|^Ran |^\(fail\)', line)]
                    row={'package':package,'host':host,'case':name,'exit':result.returncode,'floors':list(dict.fromkeys(floors)),'counts':counts}
                    summary.append(row)
                    print('OLD_INPUT_RESULT',json.dumps(row,separators=(',',':')),flush=True)
                    if not floors:
                        print('OLD_INPUT_NO_FLOOR_DIAGNOSTIC\n'+result.stdout,flush=True)
        finally:
            path.write_text(original)
            path.touch()
            assert subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)]).returncode == 0
            print('OLD_INPUT_RESTORED',relative,'empty diff',flush=True)
finally:
    planner.write_text(source)
    planner.touch()
    assert subprocess.run(['git','diff','--no-index','--stat',str(saved_planner),str(planner)]).returncode == 0
    print('OLD_INPUT_PLANNER_RESTORED empty diff',flush=True)
print('OLD_INPUT_SUMMARY_JSON='+json.dumps(summary,separators=(',',':')),flush=True)
raise SystemExit(any(not row['floors'] for row in summary))
