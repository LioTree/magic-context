"""Run a review gate with throwaway XDG roots and sampled lsof database auditing."""
import os, pathlib, subprocess, sys, threading
root = pathlib.Path(os.environ.get('TMPDIR', '/tmp')) / 'magic-context' / 's4-cache-review'
root.mkdir(parents=True, exist_ok=True)
for name in ('data', 'config', 'state', 'runtime', 'magic-context', 'tmp'):
    (root / name).mkdir(exist_ok=True)
for name, value in {'XDG_DATA_HOME': root/'data', 'XDG_CONFIG_HOME': root/'config', 'XDG_STATE_HOME': root/'state', 'XDG_RUNTIME_DIR': root/'runtime', 'OPENCODE_DB': root/'data'/'opencode.db', 'MAGIC_CONTEXT_STORAGE_DIR': root/'magic-context', 'TMPDIR': root/'tmp'}.items():
    os.environ[name] = str(value)
print('ISOLATION ' + str(root), flush=True)
for key in ('XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','OPENCODE_DB','MAGIC_CONTEXT_STORAGE_DIR','TMPDIR'):
    print(key + '=' + os.environ[key], flush=True)
subprocess.run(['lsof', '-v'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
process = subprocess.Popen(sys.argv[1:])
seen = set()
violations = set()
samples = 0
stop = threading.Event()
def audit():
    global samples
    while not stop.is_set():
        table = subprocess.run(['ps','-axo','pid=,ppid='], capture_output=True, text=True).stdout
        pairs = [tuple(map(int, line.split())) for line in table.splitlines() if len(line.split()) == 2]
        pids = {process.pid}
        changed = True
        while changed:
            previous = len(pids)
            pids.update(pid for pid, parent in pairs if parent in pids)
            changed = len(pids) != previous
        result = subprocess.run(['lsof', '-Fn', '-p', ','.join(map(str,pids))], capture_output=True, text=True)
        samples += 1
        for line in result.stdout.splitlines():
            if not line.startswith('n'):
                continue
            path = line[1:].split(' (deleted)')[0]
            if path.endswith(('.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3')):
                seen.add(path)
                if not path.startswith(str(root) + '/'):
                    violations.add(path)
        stop.wait(0.25)
thread = threading.Thread(target=audit)
thread.start()
code = process.wait()
stop.set()
thread.join()
print(f'LSOF AUDIT: {samples} samples, {len(seen)} distinct database descriptors, {len(violations)} paths outside throwaway root', flush=True)
for path in sorted(seen)[:12]:
    print('LSOF DB ' + path, flush=True)
for path in sorted(violations):
    print('ISOLATION VIOLATION ' + path, flush=True)
print(f'COMMAND EXIT={code}', flush=True)
sys.exit(97 if violations else code)
