import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading

root = Path.cwd()
logs = root / '.cortexkit/internal-docs/investigations/stack29-final-gates'
logs.mkdir(parents=True, exist_ok=True)
permits = threading.Condition()
available = 16
print_lock = threading.Lock()
unit_lock = threading.Lock()
summary = {}
tracked = subprocess.check_output(['git', 'ls-files', '-z'], text=True).split('\0')
tracked = [p for p in tracked if p]
gitdir = subprocess.check_output(['git', 'rev-parse', '--absolute-git-dir'], text=True).strip()


def capture(name, command, cwd=root, extra_env=None):
    env = dict(os.environ, RUSTC_WRAPPER='', CARGO_BUILD_RUSTC_WRAPPER='')
    env.pop('OPENCODE_DB', None)
    if extra_env:
        env.update(extra_env)
    path = logs / (name + '.log')
    with print_lock:
        print('START', name, command, flush=True)
    with path.open('w') as output:
        result = subprocess.run(command, cwd=cwd, shell=isinstance(command, str), executable='/bin/bash' if isinstance(command, str) else None, stdout=output, stderr=subprocess.STDOUT, env=env)
    lines = path.read_text(errors='replace').splitlines()
    counts = [l for l in lines if re.search(r'^Ran |^test result:|^\s*\d+ (pass|fail|skip)$|^Checked |^GATE|^EXACT_HOST|^HOST_FILES|^AUDIT CONTRACT|^Version |^TypeScript |^rustc |^cargo |^[0-9]+\.[0-9]+\.[0-9]+$', l)]
    failures = list(dict.fromkeys(re.sub(r' \[[^\]]+\]$', '', l) for l in lines if l.startswith('(fail)')))
    selected = set()
    seen = set()
    for i, line in enumerate(lines):
        if line.startswith('(fail)') or re.search(r'^error:|^Error:|^error\[|BLOCKED|Cannot find|Traceback|FileNotFound|Exception|Killed|memory limit', line):
            key = re.sub(r' \[[^\]]+\]$', '', line)
            if key not in seen:
                seen.add(key)
                selected.update(range(max(0, i-12), min(len(lines), i+2)))
    with print_lock:
        print('\nRESULT', name, 'exit='+str(result.returncode), flush=True)
        print('\n'.join(counts), flush=True)
        print('\n'.join(lines[i] for i in sorted(selected)), flush=True)
        summary[name] = {'exit': result.returncode, 'counts': counts, 'failures': failures}
    return result.returncode


def dependency_links(source, dest):
    dest.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        target = dest / entry.name
        if entry.is_symlink():
            link = os.readlink(entry)
            absolute = Path(link)
            if absolute.is_absolute():
                try:
                    relative = absolute.relative_to(root / 'packages')
                    link = str(workspace_copy_root / 'packages' / relative)
                except ValueError:
                    pass
            target.symlink_to(link, target_is_directory=entry.is_dir())
        elif entry.is_dir() and (entry.name.startswith('@') or entry.name == '.bin'):
            dependency_links(entry, target)
        elif entry.is_dir():
            if entry.name != '.cache':
                target.symlink_to(entry, target_is_directory=True)
        else:
            shutil.copy2(entry, target)


# Copy the captured source and same-build dists into independent checkouts, so
# parallel packaging and host tests cannot rewrite one another's dist chunks.
clone_lock = threading.Lock()
workspace_copy_root = root

def isolated(name):
    global workspace_copy_root
    with clone_lock:
        tree = Path(os.environ['TMPDIR']) / ('stack29-final-'+name)
        subprocess.run(['git', 'clone', '--shared', '--quiet', str(root), str(tree)], check=True)
        for relative in tracked:
            source = root / relative
            if not source.exists() and not source.is_symlink():
                continue
            dest = tree / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            if source.is_symlink():
                if dest.exists() or dest.is_symlink():
                    dest.unlink()
                dest.symlink_to(os.readlink(source))
            else:
                if dest.is_symlink():
                    dest.unlink()
                shutil.copy2(source, dest)
            if source.is_file() and not source.is_symlink():
                assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(dest.read_bytes()).digest()
        workspace_copy_root = tree
        for relative in [Path('node_modules'), *[p.relative_to(root) for p in (root/'packages').glob('*/node_modules')]]:
            dependency_links(root/relative, tree/relative)
        for relative in ['packages/plugin/dist','packages/pi-plugin/dist','packages/cli/dist','packages/retina-local-fs/dist','tests/docker/.generated']:
            source = root/relative
            if source.exists():
                shutil.copytree(source, tree/relative, dirs_exist_ok=True, symlinks=True)
        workspace_copy_root = root
        with print_lock:
            print('ISOLATED_SOURCE', name, len(tracked), 'tracked paths copied and byte-checked', flush=True)
        return tree


def unit(mode):
    tree = isolated('plugin-'+mode)
    return capture('plugin-'+mode, ['python3',str(root/'stack29-unit-gates.py'),mode], cwd=tree)


def gate(name, cpus, action):
    # Serialize only the two four-worker unit modes, without reserving idle CPU
    # permits while the other mode runs.
    if name.startswith('plugin-'):
        with unit_lock:
            return admitted(name, cpus, action)
    return admitted(name, cpus, action)


def admitted(name, cpus, action):
    global available
    with permits:
        permits.wait_for(lambda: available >= cpus)
        available -= cpus
    try:
        return action()
    except Exception as error:
        with print_lock:
            print('GATE_EXCEPTION', name, repr(error), flush=True)
            summary[name] = {'exit': 1, 'counts': ['GATE_EXCEPTION '+repr(error)], 'failures': []}
        return 1
    finally:
        with permits:
            available += cpus
            permits.notify_all()


# Read the source contract itself, then prove the fence rejects an assertion edit.
selected_groups = next((set(arg.split('=',1)[1].split(',')) for arg in sys.argv if arg.startswith('--groups=')), None)
if selected_groups is None:
    assert capture('audit-contract-fence', ['bun','stack29-audit-fence.mjs']) == 0
    path = root/'packages/plugin/src/hooks/magic-context/signed-thinking-prefix-audit.test.ts'
    original = path.read_text()
    needle = 'expect(THINKING_STRIP_GATED).toBe(true);'
    assert original.count(needle) == 1
    saved = Path(os.environ['TMPDIR'])/'stack29-final-audit-original.ts'
    saved.write_text(original)
    try:
        path.write_text(original.replace(needle,'expect(THINKING_STRIP_GATED).toBe(false); // NON-VACUITY BREAK'))
        print('FENCE_CONTROL_APPLIED', [line.strip() for line in path.read_text().splitlines() if 'NON-VACUITY BREAK' in line], flush=True)
        subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)])
        assert capture('audit-contract-negative-control', ['bun','stack29-audit-fence.mjs']) != 0
        assert 'strict audit assertions changed' in (logs/'audit-contract-negative-control.log').read_text()
        summary['audit-contract-negative-control']['expected_red'] = True
    finally:
        path.write_text(original)
        path.touch()
        assert subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)]).returncode == 0
        print('FENCE_CONTROL_RESTORED empty diff', flush=True)

build = capture('build-typecheck-lint', 'bun --version && bun run --cwd packages/plugin tsc --version && bun run --cwd packages/plugin biome --version && bun run typecheck && bun run lint && bun run build && bun run --cwd packages/pi-plugin build:e2e-argv')
if build:
    print('FINAL_SUMMARY_JSON='+json.dumps(summary,separators=(',',':')),flush=True)
    raise SystemExit(build)


def pi_serial():
    return capture('pi-serial', 'bun --version && bun run --cwd packages/pi-plugin test:serial', cwd=isolated('pi-serial'))


def master729():
    tree=isolated('master-729')
    command = "git diff --exit-code 79ce01a522ae5a9d65d6bb2ac81aadf16fa8285a -- packages/plugin/src/hooks/magic-context/*729*.test.ts packages/plugin/src/hooks/magic-context/signed-thinking-hold*.test.ts packages/pi-plugin/src/*729*.test.ts packages/pi-plugin/src/signed-thinking-hold-differential.test.ts || exit $?; bun --version; (cd packages/plugin && bun test src/hooks/magic-context/*729*.test.ts src/hooks/magic-context/signed-thinking-hold*.test.ts); a=$?; (cd packages/pi-plugin && bun test src/*729*.test.ts src/signed-thinking-hold-differential.test.ts); b=$?; exit $((a || b))"
    return capture('master-729-unchanged', command, cwd=tree)


def host(version):
    return capture('host-'+version, ['python3',str(root/'stack29-host-gate.py'),version], cwd=isolated('host-'+version))


def rust():
    return capture('rust-libs-final', 'rustc --version && cargo --version && cargo fmt --check && cargo clippy --locked -p mc-module -p mc-store --all-targets -- -D warnings && cargo test --locked -p mc-module -p mc-store --lib', extra_env={'CARGO_BUILD_JOBS':'4','RUST_TEST_THREADS':'4'})

jobs = [
    ('rust',4,rust),
    ('pi-serial',2,pi_serial),
    ('master-729',2,master729),
    ('plugin-normal',4,lambda:unit('normal')),
    ('plugin-assertions',4,lambda:unit('assertions')),
    ('host-2.0.22',2,lambda:host('2.0.22')),
    ('host-2.1.0',2,lambda:host('2.1.0')),
    ('host-pi',2,lambda:host('pi')),
    ('host-omp',2,lambda:host('omp')),
]
if selected_groups is not None:
    jobs = [job for job in jobs if job[0] in selected_groups]
    assert {job[0] for job in jobs} == selected_groups
with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
    results=list(pool.map(lambda item: gate(*item),jobs))
for name,result in summary.items():
    print('FINAL',name,'exit='+str(result['exit']),result['counts'],flush=True)
    for failure in result['failures']:
        print('FINAL_FAIL',name,failure,flush=True)
print('FINAL_SUMMARY_JSON='+json.dumps(summary,separators=(',',':')),flush=True)
raise SystemExit(any(results))
