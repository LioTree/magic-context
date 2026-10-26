#!/usr/bin/env bash
# One read-only Linux16c gate. No mutations, timing instrumentation or cost reruns.
set -uo pipefail
export RUSTC_WRAPPER= CARGO_BUILD_RUSTC_WRAPPER= CARGO_BUILD_JOBS=16
python3 - <<'S4_FINAL_GATE'
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

for name in list(os.environ):
    if name.startswith('MC_'):
        del os.environ[name]
logs = Path('target/scratch/s4-final-gate')
logs.mkdir(parents=True, exist_ok=True)
lock = threading.Lock()
results = []
started = time.monotonic()
cpus = sorted(os.sched_getaffinity(0))
if len(cpus) < 16:
    raise SystemExit('This final gate requires Linux16c; available affinity: '+str(cpus))
cpus = cpus[:16]
print('FINAL GATE CPU PARTITIONS library/store='+str(cpus[:8])+' comparisons='+str(cpus[8:12])+' campaigns='+str(cpus[12:16]), flush=True)
print('FINAL GATE library retention configuration: Broca200, master13174017127720468071; the same bounded configuration as the accepted suites plan.', flush=True)

def emit(text):
    with lock:
        print(text, flush=True)

def run(label, command, extra=None, affinity=None):
    env = dict(os.environ)
    if extra:
        env.update({key:str(value) for key,value in extra.items()})
    if affinity:
        env['CARGO_BUILD_JOBS'] = str(len(affinity))
        mask = ','.join(map(str,affinity))
        command = ['python3','-c','import os,sys; os.sched_setaffinity(0,set(map(int,sys.argv[1].split(",")))); os.execvp(sys.argv[2],sys.argv[2:])',mask,*command]
    emit('=== S4 FINAL GATE '+label+' '+json.dumps(command))
    before = time.monotonic()
    path = logs/(label+'.log')
    tail = []
    with path.open('w') as log:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        for line in process.stdout:
            log.write(line)
            tail.append(line.rstrip())
            if len(tail) > 100:
                tail.pop(0)
            if line.startswith(('test result:','production differential:','cut differential','S4 SUMMARY','FINAL retention','FINAL branches','FINAL foreign-ack','error','warning','    Finished','cargo ','rustc ','clippy ')) or '... FAILED' in line or 'has been running for over 60' in line:
                emit('['+label+'] '+line.rstrip())
        code = process.wait()
    elapsed = time.monotonic()-before
    if code:
        emit('=== S4 FINAL FAILURE TAIL '+label+'\n'+'\n'.join(tail))
    record = dict(step=label,exit=code,seconds=round(elapsed,3),log=str(path))
    with lock:
        results.append(record)
    emit('=== S4 FINAL RESULT '+json.dumps(record))
    return code

run('cargo-version',['cargo','--version'])
run('rustc-version',['rustc','--version'])
run('clippy-version',['cargo','clippy','--version'])
# Build once, before independent read-only test processes share the artifacts.
if run('build-test-targets',['cargo','test','--locked','-p','mc-module','-p','mc-store','--no-run']):
    raise SystemExit(1)

campaign_base = ['cargo','test','--locked','-p','mc-module','--lib','slice4_review::s4_independent_campaign','--','--ignored','--nocapture','--test-threads=1']
plans = [
    ('library-store', cpus[:8], [
        ('mc-module-lib',['cargo','test','--locked','-p','mc-module','--lib','--','--test-threads=8'],
            dict(MC_S4FINAL_PROFILE='Broca',MC_S4FINAL_RETENTION_MASTER_SEED=13174017127720468071,MC_S4FINAL_MASTER_SEED=10178464912710398531)),
        ('mc-store',['cargo','test','--locked','-p','mc-store','--','--test-threads=8'],{}),
    ]),
    ('comparisons', cpus[8:12], [
        ('two-cut',['cargo','test','--locked','-p','mc-module','--lib','successive_production_cuts_match_full_processing_over_many_sessions','--','--ignored','--nocapture','--test-threads=1'],
            dict(MC_PRODUCTION_CUT_SESSIONS=300,MC_PRODUCTION_CUT_STEPS=24)),
        ('fresh-starts',['cargo','test','--locked','-p','mc-module','--lib','cut_lineages_serve_what_full_processing_serves_over_many_sessions','--','--ignored','--nocapture','--test-threads=1'],
            dict(MC_CUT_DIFFERENTIAL_MODE='bootstrap',MC_CUT_DIFFERENTIAL_SESSIONS=100,MC_CUT_DIFFERENTIAL_STEPS=24)),
    ]),
    ('campaigns', cpus[12:16], [
        ('A1',campaign_base,dict(MC_S4_KINDS='0,1,2,3,4,5,6,9,10,11',MC_S4_SESSIONS=300,MC_S4_STEPS=12,MC_S4_FIRST_SEED=1779033703)),
        ('A2',campaign_base,dict(MC_S4_KINDS='0,1,2,3,4,5,6,9,10,11',MC_S4_SESSIONS=300,MC_S4_STEPS=12,MC_S4_FIRST_SEED=1779034003)),
        ('B',campaign_base,dict(MC_S4_NO_REVERT=1,MC_S4_SESSIONS=100,MC_S4_STEPS=12,MC_S4_FIRST_SEED=3144134277)),
    ]),
]

def group(plan):
    name, affinity, steps = plan
    for label, command, extra in steps:
        run(label,command,extra,affinity)
    emit('=== S4 FINAL GROUP FINISHED '+name)

# Separate fixtures and process-local environment; one job, all 16 CPUs bounded.
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(group,plans))
run('clippy',['cargo','clippy','--locked','-p','mc-module','-p','mc-store','--all-targets','--','-D','warnings'])
run('fmt',['cargo','fmt','--all','--check'])
print('=== S4 FINAL GATE SUMMARY', flush=True)
for row in results:
    print(json.dumps(row), flush=True)
print('=== S4 FINAL GATE WALL_SECONDS '+str(round(time.monotonic()-started,3)), flush=True)
failed = any(row['exit'] for row in results)
print('=== S4 FINAL GATE FINISHED '+str(int(failed)), flush=True)
sys.exit(int(failed))
S4_FINAL_GATE
