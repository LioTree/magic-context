import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import concurrent.futures

root = Path.cwd()
logs = root / '.cortexkit/internal-docs/investigations/stack29-followup'
logs.mkdir(parents=True, exist_ok=True)
condition = threading.Condition()
print_lock = threading.Lock()
available = 16
summary = {}
build_done = threading.Event()

def capture(name, command, cwd=root, env=None):
    path = logs / (name + '.log')
    with path.open('w') as stream:
        result = subprocess.run(command, cwd=cwd, shell=isinstance(command, str), executable='/bin/bash' if isinstance(command, str) else None, stdout=stream, stderr=subprocess.STDOUT, env=env or dict(os.environ, RUSTC_WRAPPER='', CARGO_BUILD_RUSTC_WRAPPER=''))
    lines = path.read_text(errors='replace').splitlines()
    selected = set()
    seen = set()
    failures = []
    for i, line in enumerate(lines):
        if re.search(r'^Ran |^\s*\d+ (pass|fail|skip|expect\(\))|^test result:|^Checked |^GATE|^CLASSIFICATION|^ROLE_DESCRIBE_SHA256|^MUTATION|^error\[|^error:|^\(fail\)', line):
            key = re.sub(r' \[[^\]]+\]$', '', line)
            if key in seen:
                continue
            seen.add(key)
            selected.add(i)
            if line.startswith('(fail)'):
                failures.append(key)
                selected.update(range(max(0, i-15), i+1))
    with print_lock:
        print('\nRESULT', name, 'exit=' + str(result.returncode), flush=True)
        print('\n'.join(lines[i] for i in sorted(selected)), flush=True)
        summary[name] = {'exit': result.returncode, 'counts': [line for line in lines if re.search(r'^Ran |^test result:|^\s*\d+ (pass|fail|skip)$', line)], 'failures': failures}
    return result.returncode

def classify():
    trees = {}
    for label, sha in [('merge-before-corrections', 'a66b5642ae1bd64e6ec6fcf819771a5bb8154cd3'), ('base', 'f6da71695e206ece5d3847bbebd879d5dbb8eb10')]:
        tree = Path(os.environ['TMPDIR']) / ('stack29-' + label)
        tree.mkdir(exist_ok=True)
        source = subprocess.Popen(['git', 'archive', sha], stdout=subprocess.PIPE)
        unpack = subprocess.run(['tar', '-x', '-C', str(tree)], stdin=source.stdout)
        source.stdout.close()
        assert source.wait() == 0 and unpack.returncode == 0
        for dependency in [Path('node_modules'), *[p.relative_to(root) for p in (root / 'packages').glob('*/node_modules')]]:
            dest = tree / dependency
            if not dest.exists():
                dest.symlink_to(root / dependency, target_is_directory=True)
        (tree / '.git').write_text('gitdir: ' + subprocess.check_output(['git','rev-parse','--absolute-git-dir'], cwd=root, text=True).strip() + '\n')
        trees[label] = tree
    tests = [
        ('plugin','src/features/magic-context/dreamer/first-output-fallback.test.ts','through the Rust classify module.*primary that streamed output and then timed out'),
        ('plugin','src/features/magic-context/dreamer/first-output-fallback.test.ts','verify batches'),
        ('plugin','src/hooks/magic-context/post-flush-cache-rewrites.test.ts','a date-only refresh waits while signed thinking'),
        ('plugin','src/features/magic-context/memory/standalone-differential.test.ts','OpenCode 2 identity folds wait'),
        ('plugin','src/features/magic-context/mode3-move-fixture.test.ts','is what the standalone plugin writes today'),
        ('plugin','src/hooks/magic-context/lkg-recovery-fence.test.ts','two processes racing to publish'),
        ('plugin','src/hooks/magic-context/signed-thinking-prefix-audit.test.ts','.'),
        ('pi-plugin','src/compaction-off-first-render-strip-pi.test.ts','replays a first render'),
        ('pi-plugin','src/context-handler-lkg.test.ts','fit-guards 2812 raw messages.*handler'),
    ]
    focus = next((arg.split('=',1)[1].split(',') for arg in sys.argv if arg.startswith('--focus=')), None)
    for number, (package, file, pattern) in enumerate(tests):
        if focus is not None and str(number) not in focus:
            continue
        for label, tree in trees.items():
            dest = tree / 'packages' / package / file
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes((trees['merge-before-corrections'] / 'packages' / package / file).read_bytes())
                with print_lock:
                    print('BASE TEST-ONLY OVERLAY', file, flush=True)
            capture(f'isolated-{number}-{label}', ['bun', 'test', file, '-t', pattern], cwd=tree/'packages'/package, env=dict(os.environ, BUN_JSC_useOMGJIT='0', RUSTC_WRAPPER='', CARGO_BUILD_RUSTC_WRAPPER=''))
    return 0

def mutation():
    path = root / 'packages/pi-plugin/src/tag-snapshot-pi.ts'
    original = path.read_text()
    old = 'const tags = transactionView(sessionId);'
    assert original.count(old) == 1
    saved = Path(os.environ['TMPDIR'])/'stack29-tag-snapshot-original.ts'
    saved.write_text(original)
    try:
        path.write_text(original.replace(old, 'throw new PiTagHydrationError("managed snapshot read inside a transaction"); // NON-VACUITY BREAK\n            const tags = transactionView(sessionId);'))
        print('MUTATION applied:', [line.strip() for line in path.read_text().splitlines() if 'NON-VACUITY BREAK' in line], flush=True)
        subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)])
        code = capture('hydration-regression-control', ['bun','test','src/tag-snapshot-hydration-pi.test.ts','-t','^paired edits read journaled tags without publishing uncommitted snapshot rows$'], cwd=root/'packages/pi-plugin')
        assert code != 0
    finally:
        path.write_text(original)
        path.touch()
        restored = subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)])
        assert restored.returncode == 0
        print('MUTATION restored: empty git diff --no-index --stat', flush=True)

def parking_controls():
    path = root / 'packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts'
    original = path.read_text()
    old = '(holdEnabled\n            ? !emergencyDropEligible\n            : args.thinkingBindingRecoveryEnabledForModel !== true)'
    assert original.count(old) == 1
    saved = Path(os.environ['TMPDIR']) / 'stack29-parking-original.ts'
    saved.write_text(original)
    cases = []
    for generation in ['v1', 'v2']:
        cases.append((generation+'-execute', 'signed prefix parking: '+generation+'.*held execute signal is not a standing permission'))
        for role in ['primary', 'subagent']:
            cases.append((generation+'-switch-'+role, 'step2b review: '+generation+'.*model switch keeps the issuer boundary.*'+role))
    for name, pattern in cases:
        baseline = capture('parking-baseline-'+name, ['bun','test','src/hooks/magic-context/signed-thinking-prefix-audit.test.ts','-t',pattern], cwd=root/'packages/plugin')
        assert baseline == 0
        try:
            path.write_text(original.replace(old, '(args.thinkingBindingRecoveryEnabledForModel !== true /* NON-VACUITY BREAK */)'))
            print('MUTATION parking applied:', name, [line.strip() for line in path.read_text().splitlines() if 'NON-VACUITY BREAK' in line], flush=True)
            subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)])
            code = capture('parking-control-'+name, ['bun','test','src/hooks/magic-context/signed-thinking-prefix-audit.test.ts','-t',pattern], cwd=root/'packages/plugin')
            assert code != 0 and len(summary['parking-control-'+name]['failures']) == 1
        finally:
            path.write_text(original)
            path.touch()
            restored = subprocess.run(['git','diff','--no-index','--stat',str(saved),str(path)])
            assert restored.returncode == 0
            print('MUTATION parking restored:', name, 'empty git diff --no-index --stat', flush=True)

if '--classify-only' in sys.argv:
    classify()
    print('CLASSIFICATION_SUMMARY_JSON=' + json.dumps(summary, separators=(',', ':')), flush=True)
    raise SystemExit(0)

# The deliberate regression runs alone, before any parallel reader can see it.
mutation()
parking_controls()
if '--controls-only' in sys.argv:
    print('CONTROL_SUMMARY_JSON=' + json.dumps(summary, separators=(',', ':')), flush=True)
    raise SystemExit(0)
def build():
    try:
        return capture('build-types-lint', 'bun --version && bun run typecheck && bun run lint && bun run build && bun run --cwd packages/pi-plugin build:e2e-argv')
    finally:
        build_done.set()

def run_task(item):
    global available
    name, cpus, action, needs_build = item
    if needs_build:
        build_done.wait()
    with condition:
        condition.wait_for(lambda: available >= cpus)
        available -= cpus
    with print_lock:
        print('START', name, cpus, flush=True)
    try:
        return action()
    finally:
        with condition:
            available += cpus
            condition.notify_all()

tasks = [
    ('build', 4, build, False),
    ('isolated-base-classification', 2, classify, False),
    ('rust-corrected', 4, lambda: capture('rust-corrected', 'rustc --version && cargo --version && CARGO_BUILD_JOBS=4 cargo fmt --check && CARGO_BUILD_JOBS=4 cargo clippy --locked -p mc-module -p mc-store --all-targets -- -D warnings && CARGO_BUILD_JOBS=4 cargo test --locked -p mc-module --lib keeps_force_band_reclaim && CARGO_BUILD_JOBS=4 cargo test --locked -p mc-module --lib served_role_describe_matches_committed_jcs_fixture'), False),
    ('master-729', 2, lambda: capture('master-729', 'bun --version && cd packages/plugin && bun test src/hooks/magic-context/*729*.test.ts src/hooks/magic-context/signed-thinking-hold*.test.ts && cd ../pi-plugin && bun test src/*729*.test.ts src/signed-thinking-hold-differential.test.ts'), True),
    ('pi-serial', 2, lambda: capture('pi-serial', 'bun --version && bun run --cwd packages/pi-plugin test:serial'), True),
    ('plugin-normal', 4, lambda: capture('plugin-normal', 'python3 stack29-unit-gates.py normal'), True),
    ('plugin-assertions', 4, lambda: capture('plugin-assertions', 'python3 stack29-unit-gates.py assertions'), True),
]
with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as pool:
    results = list(pool.map(run_task, tasks))
for name, result in summary.items():
    print('FINAL', name, 'exit=' + str(result['exit']), result['counts'], flush=True)
    for failure in result['failures']:
        print('FINAL_FAIL', name, failure, flush=True)
print('FOLLOWUP_SUMMARY_JSON=' + json.dumps(summary, separators=(',',':')), flush=True)
raise SystemExit(any(results))
