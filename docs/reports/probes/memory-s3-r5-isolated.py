#!/usr/bin/env python3
"""Run opt-in review checks under disposable storage and sample their open files."""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading

original_home = pathlib.Path.home()
base = pathlib.Path(os.environ.get("TMPDIR", tempfile.gettempdir())) / "magic-context" / "memory-s3-r5"
base.mkdir(parents=True, exist_ok=True)
root = pathlib.Path(tempfile.mkdtemp(prefix="run-", dir=base))
env = dict(os.environ)
for name, child in {
    "XDG_DATA_HOME": "data",
    "XDG_CONFIG_HOME": "config",
    "XDG_STATE_HOME": "state",
    "XDG_RUNTIME_DIR": "runtime",
    "MAGIC_CONTEXT_STORAGE_DIR": "storage",
    "HOME": "home",
    "TMPDIR": "tmp",
}.items():
    directory = root / child
    directory.mkdir(mode=0o700)
    env[name] = str(directory)
env["OPENCODE_DB"] = str(root / "data" / "opencode.db")
# The remote checkout may be owned by the mount user. Trust only this worktree,
# in a disposable config, so identity probes do not need the operator's config.
subprocess.run(["git", "config", "--file", str(root / "home" / ".gitconfig"), "--add", "safe.directory", str(pathlib.Path.cwd())], check=True)
# Tool caches are not host stores; retain offline compiler/toolchain discovery.
env.setdefault("CARGO_HOME", str(original_home / ".cargo"))
env.setdefault("RUSTUP_HOME", str(original_home / ".rustup"))
for name in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "OPENCODE_DB", "MAGIC_CONTEXT_STORAGE_DIR", "HOME", "TMPDIR"):
    print(f"ISOLATION {name}={env[name]}", flush=True)
stop = threading.Event()
seen = set()
violations = set()
samples = [0]
failures = []


def observe(pid):
    while not stop.is_set():
        try:
            tree = subprocess.check_output(["ps", "-eo", "pid=,ppid="], text=True, timeout=10)
            parents = dict(tuple(map(int, line.split())) for line in tree.splitlines())
            owned = {pid}
            while True:
                expanded = owned | {child for child, parent in parents.items() if parent in owned}
                if expanded == owned:
                    break
                owned = expanded
            files = subprocess.run(["lsof", "-nP", "-p", ",".join(map(str, owned)), "-Fn"], capture_output=True, text=True, timeout=10)
            if files.returncode not in (0, 1):
                failures.append(files.stderr.strip())
            samples[0] += 1
            for line in files.stdout.splitlines():
                if not line.startswith("n/"):
                    continue
                path = line[1:].removesuffix(" (deleted)")
                forbidden = (
                    str(original_home / ".local/share/opencode") + "/",
                    str(original_home / ".local/share/cortexkit/magic-context") + "/",
                    str(original_home / ".config/opencode") + "/",
                    str(original_home / ".config/cortexkit") + "/",
                )
                if any(path.startswith(prefix) for prefix in forbidden):
                    violations.add(path)
                if path.endswith((".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite-wal", ".sqlite-shm")):
                    seen.add(path)
                    if not path.startswith(str(root) + "/"):
                        violations.add(path)
        except Exception as error:
            failures.append(str(error))
        stop.wait(0.25)


try:
    child = subprocess.Popen(sys.argv[1:], env=env)
    observer = threading.Thread(target=observe, args=(child.pid,), daemon=True)
    observer.start()
    code = child.wait()
    stop.set()
    observer.join()
    print(f"LSOF samples={samples[0]} database_files={len(seen)} violations={len(violations)} observer_errors={len(failures)}", flush=True)
    for path in sorted(seen)[:12]:
        print(f"LSOF isolated-open {path}", flush=True)
    for host in ("opencode", "opencode2", "pi"):
        representative = next((path for path in sorted(seen) if f"projection-{host}-r5-" in path), None)
        if representative:
            print(f"LSOF host={host} {representative}", flush=True)
    for path in sorted(violations):
        print(f"LSOF VIOLATION {path}", flush=True)
    for error in failures[:3]:
        print(f"LSOF ERROR {error}", flush=True)
    if violations or failures or samples[0] == 0:
        code = 99
finally:
    shutil.rmtree(root)
    print(f"ISOLATION removed {root}", flush=True)
sys.exit(code)
