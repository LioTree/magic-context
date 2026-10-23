import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path.cwd()
host = sys.argv[1]
base = Path(os.environ['TMPDIR']) / 'magic-context/stack29' / host
base.mkdir(parents=True, exist_ok=True)
env = dict(os.environ)
env.update(TMPDIR=str(base), XDG_DATA_HOME=str(base/'data'), XDG_CONFIG_HOME=str(base/'config'), XDG_CACHE_HOME=str(base/'cache'), MAGIC_CONTEXT_STORAGE_DIR=str(base/'storage'), MC_E2E_PRIVATE_TMPDIR=str(base/'private-tmp'), MC_E2E_MODE='ts', NODE_ENV='', CI='true')
env['OPENCODE_DB'] = str(base/'opencode.db')
for name in ['MC_E2E_KEEP', 'MC_LIVE_PROVIDERS']:
    env.pop(name, None)
for name in ['XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','MAGIC_CONTEXT_STORAGE_DIR','MC_E2E_PRIVATE_TMPDIR']:
    Path(env[name]).mkdir(parents=True, exist_ok=True)
print('HOST_ROOT', str(base), flush=True)
subprocess.run(['bun', '--version'], check=True, env=env)
cwd = root / 'packages/e2e-tests'

def run(command, *, where=cwd):
    print('HOST_COMMAND', command, flush=True)
    subprocess.run(command, cwd=where, env=env, check=True)

def select(command):
    files = subprocess.check_output(command, cwd=cwd, env=env, text=True).splitlines()
    assert files, command
    return files

# The fixture subprocesses set still narrower roots of their own.
if host in ['pi', 'omp']:
    env['MC_E2E_HOST'] = host
    if host == 'pi':
        packages = list(root.glob('node_modules/.bun/@earendil-works+pi-coding-agent@0.87.1*/node_modules/@earendil-works/pi-coding-agent/package.json'))
        if not packages:
            raise SystemExit('BLOCKED: cached real Pi 0.87.1 package is unavailable')
        assert json.loads(packages[0].read_text())['version'] == '0.87.1'
        env.update(MC_E2E_PI_VERSION='0.87.1', MC_E2E_PI_PACKAGE_JSON=str(packages[0]))
    else:
        package = subprocess.check_output(['bun', '-e', "console.log(require.resolve('@oh-my-pi/pi-coding-agent/package.json'))"], cwd=cwd, env=env, text=True).strip()
        assert json.loads(Path(package).read_text())['version'] == '18.2.6'
        env['MC_E2E_OMP_PACKAGE_JSON'] = package
    only_file = next((a.split('=',1)[1] for a in sys.argv if a.startswith('--file=')), None)
    pattern = next((a.split('=',1)[1] for a in sys.argv if a.startswith('--pattern=')), None)
    files = [only_file] if only_file else select(['bun','scripts/validate-mode-manifest.ts','--mode','ts','--harness',host])
    print('HOST_FILES', host, len(files), flush=True)
    command = ['bun','test','--timeout','600000',*files]
    if pattern:
        command.extend(['-t', pattern])
    run(command)
else:
    assert host in ['2.0.22','2.1.0']
    env['HOME'] = str(base/'home')
    Path(env['HOME']).mkdir(parents=True, exist_ok=True)
    env['OPENCODE_VERSION'] = '1.18.31'
    run(['bash','tests/docker/install-opencode.sh'], where=root)
    legacy = Path(env['HOME'])/'.opencode/bin/opencode'
    env['MC_E2E_OPENCODE1_CLI'] = str(legacy)
    env['PATH'] = str(legacy.parent) + os.pathsep + env.get('PATH','')
    legacy_version = subprocess.check_output([str(legacy),'--version'], env=env, text=True).strip()
    print('LEGACY_HOST', str(legacy), legacy_version, flush=True)
    assert legacy_version in ['1.18.31','opencode 1.18.31','opencode v1.18.31']
    install = base / 'cli'
    install.mkdir(exist_ok=True)
    (install/'package.json').write_text(json.dumps({'private':True,'dependencies':{'@opencode/cli':host},'trustedDependencies':['@opencode/cli']}))
    run(['bun','install','--linker=hoisted'], where=install)
    cli = install/'node_modules/@opencode/cli/bin/opencode.exe'
    try:
        version = subprocess.check_output([str(cli),'--version'], env=env, text=True, stderr=subprocess.STDOUT).strip()
    except (OSError, subprocess.CalledProcessError):
        run(['node','postinstall.mjs'], where=install/'node_modules/@opencode/cli')
        version = subprocess.check_output([str(cli),'--version'], env=env, text=True).strip()
    print('EXACT_HOST', str(cli), version, flush=True)
    assert version == 'opencode v'+host
    env.update(MC_E2E_HOST='opencode2', MC_E2E_OPENCODE2_VERSION=host, MC_E2E_OPENCODE2_CLI=str(cli))
    status = 0
    for shard in range(2):
        files = select(['bun','scripts/select-host-shard.ts','opencode2',f'{shard}/2'])
        print('HOST_FILES', host, shard, len(files), flush=True)
        try:
            run(['bun','test','--timeout','600000',*files])
        except subprocess.CalledProcessError:
            status = 1
    for file in ['tests/opencode2/store-generation-conversion.test.ts','tests/opencode2/marker-s3-runtime.test.ts']:
        try:
            run(['bun','test','--timeout','600000',file])
        except subprocess.CalledProcessError:
            status = 1
    raise SystemExit(status)
