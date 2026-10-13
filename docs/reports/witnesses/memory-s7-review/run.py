#!/usr/bin/env python3
"""Opt-in, snapshot-isolated historian review. Never opens a user store.

Local preparation (Git stays in this worktree):
  MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review/run.py prepare

Linux differential:
  MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review/run.py differential

Linux regression witnesses:
  MC_S7_REVIEW=1 python3 docs/reports/witnesses/memory-s7-review/run.py witnesses
The input archives and captured results are disposable; conclusions belong in the report.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
INPUT = ROOT / ".s7-review-input"
BASE = "3549c4340ef37066f6690fb466824ac752ba0cbb"
HEAD = "6f7231135fa12c040a58e199a059718fb4850016"


def require_opt_in():
    if os.environ.get("MC_S7_REVIEW") != "1":
        print("S7 review ignored: set MC_S7_REVIEW=1 to run temporary-store witnesses")
        sys.exit(0)


def prepare():
    INPUT.mkdir(exist_ok=True)
    for name, revision in [("base", BASE), ("head", HEAD)]:
        with (INPUT / f"{name}.tar").open("wb") as archive:
            subprocess.run(["git", "archive", revision], cwd=ROOT, stdout=archive, check=True)
    print(f"prepared two pinned source snapshots in {INPUT}")


def snapshot(parent, name):
    dest = parent / name
    dest.mkdir()
    with tarfile.open(INPUT / f"{name}.tar") as archive:
        archive.extractall(dest, filter="data")
    if name == "head":
        # Controls must exercise mutated working sources, not the pristine archive.
        shutil.copytree(ROOT / "crates", dest / "crates", dirs_exist_ok=True)
    injections = [
        ("crates/mc-module/src/historian.rs", "driver.rs"),
        ("crates/mc-module/src/historian_producer.rs", "wire.rs"),
        ("crates/mc-module/src/tests/gate_a2.rs", "host.rs"),
        ("crates/mc-store/src/context_writes.rs", "fold.rs"),
    ]
    for target, probe in injections:
        path = dest / target
        include = f'\ninclude!(r#"{HERE / probe}"#);\n'
        text = path.read_text()
        if target.endswith("gate_a2.rs"):
            path.write_text(text + include)
        else:
            # historian.rs, historian_producer.rs and context_writes.rs end in
            # test modules. Inject there to reuse their private fixture helpers.
            assert text.rstrip().endswith("}"), target
            cut = text.rfind("}")
            path.write_text(text[:cut] + include + text[cut:])
    return dest


def cargo(dest, package, filter_name, head, label):
    env = os.environ.copy()
    flags = "--check-cfg=cfg(mc_s7_head)"
    if head:
        flags += " --cfg mc_s7_head"
    env["RUSTFLAGS"] = flags
    command = ["cargo", "test", "--offline", "--manifest-path", str(dest / "Cargo.toml"),
               "-p", package, "--lib", filter_name, "--", "--nocapture", "--test-threads=1"]
    result = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, timeout=600)
    print("\n".join(line for line in result.stdout.splitlines() if "S7_SNAPSHOT " not in line), flush=True)
    (INPUT / f"{label}.log").write_text(result.stdout)
    return result


def records(output):
    return {m.group(1): json.loads(m.group(2)) for m in
            re.finditer(r"S7_SNAPSHOT ([^ ]+) (\{[^\n]*\})", output)}


def main():
    require_opt_in()
    mode = sys.argv[1] if len(sys.argv) > 1 else "differential"
    if mode == "prepare":
        prepare()
        return
    if sys.platform != "linux":
        raise SystemExit("Rust review must run on Linux; prepare is the only local operation")
    subprocess.run(["cargo", "--version"], check=True)
    subprocess.run(["rustc", "--version"], check=True)
    with tempfile.TemporaryDirectory(prefix="mc-s7-review-", dir=os.environ.get("TMPDIR")) as tmp:
        parent = Path(tmp)
        if mode == "differential":
            captured = {}
            for name in ["base", "head"]:
                dest = snapshot(parent, name)
                combined = ""
                for package in ["mc-module", "mc-store"]:
                    result = cargo(dest, package, "s7_review_snapshot", name == "head", f"{name}-{package}")
                    if result.returncode:
                        raise SystemExit(result.returncode)
                    combined += result.stdout
                captured[name] = records(combined)
            assert captured["base"] and captured["base"].keys() == captured["head"].keys()
            changes = []
            for case, before in captured["base"].items():
                after = captured["head"][case]
                keys = sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
                if keys:
                    changes.append({"case": case, "fields": keys, "base": before, "head": after})
            summary = {"cases": len(captured["base"]), "changed": len(changes), "differences": changes}
            (INPUT / "differential.json").write_text(json.dumps(summary, indent=2))
            print("S7_DIFFERENTIAL " + json.dumps({"cases": summary["cases"], "changed": summary["changed"],
                                                   "fields": sorted({k for c in changes for k in c["fields"]})}))
            for prefix in ["driver-", "host-", "fold-", "wire-", "crash-"]:
                group = [c for c in changes if c["case"].startswith(prefix)]
                print("S7_GROUP " + json.dumps({"group":prefix,"changed":len(group),
                    "fields":sorted({k for c in group for k in c["fields"]})}))
            for case in ["driver-0", "wire-false", "wire-true", "crash-before-ack"]:
                diff = next((c for c in changes if c["case"] == case), None)
                if diff:
                    print("S7_EXAMPLE " + json.dumps(diff))
            disabled = [c for c in changes if c["case"].startswith("driver-") and
                not c["head"]["memory_enabled"] and c["head"]["counts"][3] > 0]
            print("S7_DISABLED_MEMORY_CANDIDATES " + json.dumps([c["case"] for c in disabled]))
        elif mode in ["witnesses", "control"]:
            dest = snapshot(parent, "head")
            if mode == "control":
                package, test_filter = sys.argv[2:4]
                result = cargo(dest, package, test_filter, True, "control")
                raise SystemExit(result.returncode)
            expected = {
                "mc-module": {"historian::tests::s7_review_witness_unknown_outcome_has_a_deadline",
                              "historian::tests::s7_review_witness_dormant_publish_has_no_new_rows",
                              "historian::tests::s7_review_witness_disabled_memory_does_not_queue_facts"},
                "mc-store": {"context_writes::tests::s7_review_witness_no_candidate_fold_is_byte_identical"},
            }
            for package, names in expected.items():
                result = cargo(dest, package, "s7_review_witness", True, f"witness-{package}")
                passed = set(re.findall(r"^test ([^ ]+) \.\.\. ok$", result.stdout, re.M))
                assert result.returncode == 0 and names <= passed, (package, result.returncode, passed, names)
                print(f"S7_WITNESSES_GREEN {package}: {len(names)} named witnesses passed")
        else:
            raise SystemExit("mode must be prepare, differential, witnesses, or control PACKAGE FILTER")


if __name__ == "__main__":
    main()
