#!/usr/bin/env python3
"""Audit actual campaign RNG streams under different MC_S4_FIRST_SEED values."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

RNG = Path('crates/mc-module/src/providers/async_provider/differential_tests.rs')
HOST = Path('crates/mc-module/src/providers/async_provider/cut_lineage_tests/slice4_boundaries.rs')
CAMPAIGN = Path('crates/mc-module/src/providers/async_provider/cut_lineage_tests/slice4_review.rs')
originals = {path: path.read_bytes() for path in (RNG, HOST, CAMPAIGN)}
MASK = (1 << 64) - 1
MAIN_XOR = 0xD10F_629B_52A3_C947
HOST_XOR = 0xB0A0_DA4E
old_rng = '''    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }'''
new_rng = '''    fn next(&mut self) -> u64 {
        let before = self.0;
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let value = self.0.wrapping_mul(0x2545_F491_4F6C_DD1D);
        eprintln!("SEED-AUDIT DRAW {before} {} {value}", self.0);
        value
    }'''
old_host = '    let mut rng = Rng(seed ^ 0xB0A0_DA4E ^ cut);'
new_host = old_host + '\n    eprintln!("SEED-AUDIT HOST {seed} {cut} {}", rng.0);'
old_merge = '                    stats.merge(measured);'
new_merge = '                    eprintln!("SEED-AUDIT SESSION {seed} {profile:?} staged={}", measured.staged_cuts);\n' + old_merge

def patch(path, old, new):
    text = path.read_text()
    assert text.count(old) == 1, (path, text.count(old))
    path.write_text(text.replace(old, new))

results = []
try:
    patch(RNG, old_rng, new_rng)
    patch(HOST, old_host, new_host)
    patch(CAMPAIGN, old_merge, new_merge)
    for label, first, revert in [('B', 3731904001, False), ('B-repeat', 3731904001, False), ('C', 4102558001, True)]:
        env = dict(os.environ, RUSTC_WRAPPER='', CARGO_BUILD_RUSTC_WRAPPER='',
                   MC_S4_SESSIONS='4', MC_S4_STEPS='12', MC_S4_FIRST_SEED=str(first))
        env.pop('MC_S4_KINDS', None)
        if revert: env.pop('MC_S4_NO_REVERT', None)
        else: env['MC_S4_NO_REVERT'] = '1'
        command = ['cargo', 'test', '-p', 'mc-module', '--lib', 'slice4_review::s4_independent_campaign', '--', '--ignored', '--nocapture', '--test-threads=1']
        proc = subprocess.run(command, env=env, text=True, capture_output=True, timeout=1200)
        output = proc.stdout + proc.stderr
        print(f'=== SEED AUDIT {label} first={first} revert={revert} exit={proc.returncode}', flush=True)
        if proc.returncode: print(output[-12000:], flush=True)
        assert proc.returncode == 0
        draws = [tuple(map(int, values)) for values in re.findall(r'^SEED-AUDIT DRAW (\d+) (\d+) (\d+)$', output, re.M)]
        hosts = [tuple(map(int, values)) for values in re.findall(r'^SEED-AUDIT HOST (\d+) (\d+) (\d+)$', output, re.M)]
        sessions = re.findall(r'^SEED-AUDIT SESSION (\d+) (\S+) staged=(\d+)$', output, re.M)
        assert len(sessions) == 4 and {int(row[0]) for row in sessions} == set(range(first, first + 4))
        assert len(hosts) == 4 and {seed for seed, _, _ in hosts} == {first + 1, first + 2}
        edges = {}
        for before, after, value in draws:
            expected = before ^ (before >> 12)
            expected ^= (expected << 25) & MASK
            expected ^= expected >> 27
            expected &= MASK
            assert after == expected and value == (after * 0x2545_F491_4F6C_DD1D) & MASK
            edges[before] = after
        roots = {seed ^ MAIN_XOR for seed in range(first, first + 4)}
        assert roots.issubset(edges), 'every MC_S4_FIRST_SEED + index must initialize the real session RNG'
        for seed, cut, initial in hosts:
            assert initial == seed ^ HOST_XOR ^ cut and initial in edges
            roots.add(initial)
        reached = set()
        for root in roots:
            while root in edges and root not in reached:
                reached.add(root)
                root = edges[root]
        assert set(edges).issubset(reached), 'a campaign random stream has no seeded session or host root'
        fingerprint = hashlib.sha256(json.dumps(sorted(draws), separators=(',', ':')).encode()).hexdigest()
        summary = next(line for line in output.splitlines() if line.startswith('S4 SUMMARY '))
        assert f'seeds={first}..={first + 3}' in summary and 'failed=0' in summary
        result = dict(label=label, first=first, revert=revert, draws=len(draws), roots=len(roots),
                      fingerprint=fingerprint, sessions=sorted(sessions), hosts=sorted(hosts), summary=summary)
        print('SEED RESULT ' + json.dumps(result), flush=True)
        results.append(result)
    assert results[0]['fingerprint'] != results[2]['fingerprint']
    print('SEED REPEAT same_draw_multiset=' + str(results[0]['fingerprint'] == results[1]['fingerprint']), flush=True)
    print('SEED AUDIT SUMMARY ' + json.dumps(results), flush=True)
finally:
    for path, original in originals.items():
        path.write_bytes(original)
        assert path.read_bytes() == original
        print(f'RESTORED {path} byte-identically sha256={hashlib.sha256(original).hexdigest()}', flush=True)
