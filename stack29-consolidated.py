import concurrent.futures
import os
from pathlib import Path
import re
import subprocess
import threading

root = Path.cwd()
logs = root / '.cortexkit/internal-docs/investigations/stack29-gates'
logs.mkdir(parents=True, exist_ok=True)
condition = threading.Condition()
available = 16
print_lock = threading.Lock()

rust = r'''set +e
rustc --version; cargo --version
export CARGO_BUILD_JOBS=4 RUST_TEST_THREADS=4
cargo test --locked -p mc-module --lib keeps_force_band_reclaim -- --nocapture
merged_force=$?
cargo test --locked -p mc-module --lib served_role_describe_matches_committed_jcs_fixture -- --nocapture
merged_describe=$?
cargo test --locked -p mc-store --lib
store=$?
base="$TMPDIR/stack29-base"
mkdir -p "$base"
set -o pipefail
git archive f6da71695e206ece5d3847bbebd879d5dbb8eb10 | tar -x -C "$base"
archive=$?
if [ "$archive" -ne 0 ]; then exit "$archive"; fi
cd "$base"
cargo test --locked -p mc-module --lib keeps_force_band_reclaim -- --nocapture
base_force=$?
cargo test --locked -p mc-module --lib served_role_describe_matches_committed_jcs_fixture -- --nocapture
base_describe=$?
printf '\nCLASSIFICATION merged_force=%s merged_describe=%s store=%s base_force=%s base_describe=%s\n' "$merged_force" "$merged_describe" "$store" "$base_force" "$base_describe"
exit $((merged_force || merged_describe || store || base_force || base_describe))
'''
checks = 'bun --version && bun run typecheck && bun run lint'
pi = 'bun --version && cd packages/pi-plugin && bun test src/tag-snapshot-hydration-pi.test.ts src/context-handler-lkg.test.ts src/adv-proactive-strip-pi-move.test.ts src/compaction-off-first-render-strip-pi.test.ts'
cli = 'bun --version; bun run --cwd packages/cli test; a=$?; (cd packages/plugin && bun test src/shared/); b=$?; exit $((a || b))'
tasks = [('rust-classification', 4, rust), ('plugin-normal', 4, 'python3 stack29-unit-gates.py normal'), ('plugin-assertions', 4, 'python3 stack29-unit-gates.py assertions'), ('pi-integration', 2, pi), ('typecheck-lint', 2, checks), ('cli-shared', 2, cli)]

def run(item):
    global available
    name, cpus, command = item
    with condition:
        condition.wait_for(lambda: available >= cpus)
        available -= cpus
    with print_lock:
        print(f'START {name} ({cpus} CPUs): {command}', flush=True)
    path = logs / f'{name}.log'
    with path.open('w') as output:
        result = subprocess.run(['bash', '-c', command], stdout=output, stderr=subprocess.STDOUT, env=dict(os.environ, RUSTC_WRAPPER='', CARGO_BUILD_RUSTC_WRAPPER=''))
    lines = path.read_text(errors='replace').splitlines()
    with print_lock:
        print(f'RESULT {name} exit={result.returncode} log={path}', flush=True)
        selected = set()
        for i, line in enumerate(lines):
            if re.search(r'(^GATE|^CLASSIFICATION|^test result:|^Ran |^\s*\d+ (pass|fail|skip)|^Checked |^Found \d+ errors|^\(fail\)|^error:|^error\[|^.*FAILED$|^[0-9]+\.[0-9]+\.[0-9]+$)', line):
                selected.add(i)
                if '(fail)' in line or 'FAILED' in line or 'error:' in line:
                    selected.update(range(max(0,i-18), min(len(lines),i+3)))
        print('\n'.join(lines[i] for i in sorted(selected)), flush=True)
    with condition:
        available += cpus
        condition.notify_all()
    return result.returncode

with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as pool:
    results = list(pool.map(run, tasks))
print('CONSOLIDATED', dict(zip((t[0] for t in tasks), results)), flush=True)
raise SystemExit(any(results))
