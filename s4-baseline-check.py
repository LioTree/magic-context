#!/usr/bin/env python3
"""Run red-group diagnostics against exact historical sources, then restore."""
import json
import os
from pathlib import Path
import subprocess
import sys

snapshots = json.loads(Path('s4-baseline-source.json').read_text())
filters = [] if '--bootstrap-only' in sys.argv else [
    'a_conversation_pruned_below_its_cut_serves_what_full_processing_serves',
    'a_lineage_that_begins_at_a_cut_serves_what_full_processing_serves',
    'prefix_matches_full_lineage_with_crossing_native_arcs',
    'published_contract',
]
results=[]
for sha, files in snapshots.items():
    originals={name:Path(name).read_bytes() if Path(name).exists() else None for name in files}
    try:
        for name, source in files.items():
            p=Path(name)
            if source is None:
                if p.exists(): p.unlink()
            else:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(source)
        for name in filters:
            print(f'=== HISTORICAL {sha} {name}', flush=True)
            proc=subprocess.run(['cargo','test','-p','mc-module','--lib',name,'--','--test-threads=4'], env=dict(os.environ,RUSTC_WRAPPER='',CARGO_BUILD_RUSTC_WRAPPER=''))
            print(f'=== HISTORICAL RESULT {sha} {name} {proc.returncode}', flush=True)
            results.append((sha,name,proc.returncode))
        if '--bootstrap-only' in sys.argv:
            env=dict(os.environ,RUSTC_WRAPPER='',CARGO_BUILD_RUSTC_WRAPPER='',MC_CUT_DIFFERENTIAL_MODE='bootstrap',MC_CUT_DIFFERENTIAL_SESSIONS='100',MC_CUT_DIFFERENTIAL_STEPS='24')
            print(f'=== HISTORICAL {sha} BootstrapAtCut100',flush=True)
            proc=subprocess.run(['cargo','test','-p','mc-module','--lib','cut_lineages_serve_what_full_processing_serves_over_many_sessions','--','--ignored','--nocapture','--test-threads=1'],env=env)
            print(f'=== HISTORICAL RESULT {sha} BootstrapAtCut100 {proc.returncode}',flush=True)
            results.append((sha,'BootstrapAtCut100',proc.returncode))
            continue
        env=dict(os.environ,RUSTC_WRAPPER='',CARGO_BUILD_RUSTC_WRAPPER='',MC_ASYNC_FRESH_CUT='1',MC_ASYNC_SCALING_SIZES='1000',MC_ASYNC_NOTICES='2',MC_ASYNC_VIEWS='1')
        print(f'=== HISTORICAL {sha} fresh-host-cut cause probe (2 notices / 1 view, not ratio gate)', flush=True)
        proc=subprocess.run(['cargo','test','-p','mc-module','--lib','covered_tail_latency_benchmark','--','--ignored','--nocapture','--test-threads=1'],env=env)
        print(f'=== HISTORICAL RESULT {sha} fresh-host-cut {proc.returncode}', flush=True)
        results.append((sha,'fresh-host-cut',proc.returncode))
    finally:
        for name, original in originals.items():
            p=Path(name)
            if original is None:
                if p.exists(): p.unlink()
            else:
                p.write_bytes(original)
                os.utime(p,None)
        assert all((Path(name).read_bytes() if Path(name).exists() else None)==raw for name,raw in originals.items())
        print(f'=== HISTORICAL RESTORED {sha}: all {len(originals)} paths byte-identical', flush=True)
print('HISTORICAL SUMMARY '+json.dumps(results),flush=True)
sys.exit(1 if any(code for _,_,code in results) else 0)
