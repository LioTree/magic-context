import os
import re
import subprocess
import sys
from pathlib import Path

root = Path.cwd()
mode = sys.argv[1]
status = 0
print(subprocess.check_output(['bun', '--version'], text=True).strip(), flush=True)
for shard in range(4):
    files = subprocess.check_output(['bun', 'packages/e2e-tests/scripts/select-unit-shard.ts', 'plugin', mode, f'{shard}/4'], text=True).splitlines()
    assert files
    env = dict(os.environ)
    env.pop('OPENCODE_DB', None)
    if mode == 'assertions':
        env['MAGIC_CONTEXT_DEBUG_ASSERTIONS'] = '1'
    command = ['bun', 'run', '--cwd', 'packages/plugin', 'test', *files]
    print(f'GATE plugin {mode} {shard}/4: {len(files)} files', flush=True)
    result = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    text = result.stdout
    print('\n'.join(line for line in text.splitlines() if re.search(r'^\s*\d+ (pass|fail|skip|expect\(\))|^Ran |^bun test |^\(fail\)|error:|ModuleNotFound|Cannot find|timed out', line)), flush=True)
    if result.returncode:
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if line.startswith('(fail)'):
                print('\n'.join(lines[max(0, i-22):i+1]), flush=True)
        status = 1
    print(f'GATE plugin {mode} {shard}/4 exit={result.returncode}', flush=True)
sys.exit(status)
