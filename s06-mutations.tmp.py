"""Linux-only regression proofs. No Git writes; restore staged snapshots from TMPDIR."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

root = Path.cwd()
projection = Path('packages/plugin/src/hooks/magic-context/served-prefix-projection.ts')
core = Path('packages/plugin/src/hooks/magic-context/served-prefix.ts')
oc_tests = 'packages/plugin/src/hooks/magic-context/served-prefix.test.ts'
pi_tests = 'packages/pi-plugin/src/served-prefix-pi.test.ts'
fields = 'packages/plugin/src/hooks/magic-context/served-prefix-projection.test.ts'
evidence = []

def stat(path, backup):
    run = subprocess.run(['git', 'diff', '--no-index', '--stat', '--', str(backup), str(path)], text=True, capture_output=True)
    assert run.returncode in (0, 1), run.stderr
    return run.stdout.strip()

def proof(label, path, mutate, testfile, name):
    before = path.read_text()
    with tempfile.TemporaryDirectory(prefix='s06-mutation-', dir=os.environ['TMPDIR']) as scratch:
        backup = Path(scratch) / path.name
        backup.write_text(before)
        assert not stat(path, backup)
        try:
            mutant = mutate(before)
            assert mutant != before
            path.write_text('// NON-VACUITY BREAK: temporary regression proof\n' + mutant)
            during = stat(path, backup)
            assert during
            run = subprocess.run(['bun', 'test', testfile, '-t', '^' + re.escape(name).replace(re.escape(' > '), '(?: > | )') + '$', '--timeout', '30000'], text=True, capture_output=True, env={**os.environ, 'BUN_JSC_useOMGJIT': '0'})
            output = run.stdout + run.stderr
            failed = re.findall(r'^\(fail\) (.+?)(?: \[[0-9.]+ms\])?$', output, re.M)
            passed = re.findall(r'^\(pass\) (.+?)(?: \[[0-9.]+ms\])?$', output, re.M)
            assert run.returncode != 0 and failed == [name], output
        finally:
            path.write_text(backup.read_text())
            path.touch()
        after = stat(path, backup)
        assert not after
        row = {'control': label, 'expected_red': name, 'captured_output': f'(fail) {failed[0]}; other failures=0; passed={passed}', 'applied_evidence': f'{path}: during={during}; after=(empty)', 'outcome': 'reddened'}
        evidence.append(row)
        print(json.dumps(row), flush=True)

for host, generation in [('opencode-v1', 'v1'), ('opencode-v2', 'v2'), ('pi', None)]:
    name = f'served prefix {generation} > host-only summary edits serve the fresh held request' if generation else 'Pi host-only timestamps serve the fresh held request'
    proof(f'{host}: restore whole-envelope hashing', projection,
          lambda s, h=host: s.replace('    if (!isRecord(message)) throw new Error("Cannot project an absent served message");', f'    if (provenance.host === "{h}") return message;\n    if (!isRecord(message)) throw new Error("Cannot project an absent served message");'),
          oc_tests if generation else pi_tests, name)

for host, generation in [('opencode-v1', 'v1'), ('opencode-v2', 'v2'), ('pi', None)]:
    if generation:
        # The input object is opaque; omitting it must lose both the integrated refusal and field perturbation.
        mutate = lambda s, v2=(generation == 'v2'): s.replace('const state = value.state;', f'const state = {{ ...value.state }}; if (v2 === {str(v2).lower()}) delete state.input;')
        name = f'served prefix {generation} > provider-visible tool input before kept thinking still refuses'
        perturbation = f'{host} converter input parts.2.state.input.command changes first-kept identity'
        testfile = oc_tests
    else:
        mutate = lambda s: s.replace(': message.content', ': undefined')
        name = 'Pi provider-visible text before kept thinking still refuses'
        perturbation = 'pi converter input content changes first-kept identity'
        testfile = pi_tests
    proof(f'{host}: omit provider-visible input', projection, mutate, testfile, name)
    proof(f'{host}: omit provider-visible input (independent field perturbation)', projection, mutate, fields, perturbation)
print('MUTATION SUMMARY: 9/9 expected tests reddened; zero unrelated failures; all paths restored')
