#!/usr/bin/env python3
"""Compare OpenCode/Broca bytes and Claude Code hook latency against fa1f68e4."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time

BASELINE = "fa1f68e428209cd1d52ccd7741d040d690bcd983"
ROOT = Path(__file__).resolve().parents[3]
MODULE = Path("crates/mc-module")
FIXTURES = {
    "step_transform.rs": [
        "host_tags_use_engine_numbers_kinds_blocks_and_overlay_bytes",
        "owned_broca_declaration_and_hook_corpus_remain_byte_identical",
    ],
    "compaction.rs": [
        "rebuild_replacement_equals_hook_served_bytes_with_one_overlay_tag_per_block",
    ],
    "tests.rs": [
        "allocated_unsent_work_is_retried_above_its_version_without_runner_rejection",
    ],
}


def run(command, cwd, env):
    print("+", " ".join(map(str, command)), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def baseline_tree(destination):
    # Only test functions and the new harness are transplanted. Production sources,
    # the store, lockfile and fixtures all come from the archived baseline commit.
    archive = subprocess.Popen(
        ["git", "archive", BASELINE], cwd=ROOT, stdout=subprocess.PIPE
    )
    with tarfile.open(fileobj=archive.stdout, mode="r|") as source:
        source.extractall(destination, filter="data")
    archive.stdout.close()
    if archive.wait() != 0:
        raise RuntimeError("git archive failed")
    providers = MODULE / "src/providers"
    for name in ["admission_differential_tests.rs", "admission_latency_tests.rs"]:
        shutil.copyfile(ROOT / providers / name, destination / providers / name)
    with (destination / providers / "mod.rs").open("a") as output:
        output.write("\n#[cfg(test)]\nmod admission_differential_tests;\n")
    with (destination / providers / "step_transform.rs").open("a") as output:
        output.write('\n#[cfg(test)]\n#[path = "admission_latency_tests.rs"]\nmod admission_latency_tests;\n')
    for filename, names in FIXTURES.items():
        current = (ROOT / providers / filename).read_text()
        target = destination / providers / filename
        old = target.read_text()
        for name in names:
            pattern = rf"(?ms)^([ ]*)async fn {name}\(.*?^\1}}\n"
            replacement = re.search(pattern, current)
            if replacement is None:
                raise RuntimeError(f"missing current fixture: {name}")
            old, count = re.subn(pattern, lambda _: replacement[0], old)
            if count != 1:
                raise RuntimeError(f"missing or ambiguous baseline fixture: {name}")
        target.write_text(old)


def cargo_test(cwd, env, name, ignored=False):
    command = ["cargo", "test", "--locked", "-p", "mc-module", "--lib", "-j", "4", name, "--"]
    if ignored:
        command.append("--ignored")
    command.extend(["--nocapture", "--test-threads=1"])
    run(command, cwd, env)


def release_binary(cwd, env, destination):
    command = ["cargo", "test", "--locked", "--release", "-p", "mc-module", "--lib",
               "-j", "16", "--no-run", "--message-format=json"]
    print("+", " ".join(command), flush=True)
    output = subprocess.run(command, cwd=cwd, env=env, check=True, stdout=subprocess.PIPE, text=True)
    binaries = [event["executable"] for line in output.stdout.splitlines()
                if (event := json.loads(line)).get("reason") == "compiler-artifact"
                and event.get("executable") and event["target"]["name"] == "mc_module"]
    if len(binaries) != 1:
        raise RuntimeError(f"expected one module test binary, got {binaries}")
    shutil.copyfile(binaries[0], destination)
    destination.chmod(0o755)


def machine_load():
    return {"unix_time": time.time(), **{
        name: Path(path).read_text() for name, path in [
            ("cpu_pressure", "/proc/pressure/cpu"), ("loadavg", "/proc/loadavg")
        ]}}


def percentiles(samples):
    ordered = sorted(samples)
    return {"samples": len(ordered), **{
        f"p{percent}_ms": ordered[math.ceil(len(ordered) * percent / 100) - 1]
        for percent in [50, 95, 99]}}


def paired_latency(baseline, env, scratch, report_dir):
    if not Path("/proc/pressure/cpu").exists():
        raise RuntimeError("G9 must run on Linux with /proc pressure/load evidence")
    binaries = {arm: scratch / f"{arm}-tests" for arm in ["baseline", "on", "off"]}
    release_binary(baseline, dict(env, CARGO_TARGET_DIR=str(ROOT / "target/admission-baseline")), binaries["baseline"])
    release_binary(ROOT, env, binaries["on"])
    binaries["off"] = binaries["on"]
    kinds = ["pre_user", "post_assistant", "post_tool", "all"]
    samples = {arm: {kind: [] for kind in kinds} for arm in binaries}
    load = []
    for block in range(4):
        # Adjacent baseline/on blocks share machine conditions; reversing their
        # order avoids always charging the later arm for a rising system load.
        order = ["baseline", "on", "off"] if block % 2 == 0 else ["on", "baseline", "off"]
        for arm in order:
            output = report_dir / f"latency-{arm}-block-{block}.json"
            block_env = dict(env, MC_CC_LATENCY_MODE=arm, MC_CC_LATENCY_FIRST=str(block * 50),
                             MC_CC_LATENCY_COUNT="50", MC_CC_LATENCY_REPORT=str(output),
                             MC_CC_LATENCY_STORE=str(scratch / f"store-{arm}"))
            evidence = {"arm": arm, "block": block, "before": machine_load()}
            run([str(binaries[arm]), "cc_admission_hook_latency", "--ignored", "--nocapture",
                 "--test-threads=1"], ROOT, block_env)
            evidence["after"] = machine_load()
            load.append(evidence)
            (report_dir / "latency-load.json").write_text(json.dumps(load, indent=2) + "\n")
            values = json.loads(output.read_text())
            for kind in kinds:
                assert values[kind]["samples"] == (150 if kind == "all" else 50)
                samples[arm][kind].extend(values[kind]["samples_ms"])
    summary = {arm: {kind: percentiles(values) for kind, values in groups.items()}
               for arm, groups in samples.items()}
    for arm in summary:
        for kind in kinds:
            assert summary[arm][kind]["samples"] == (600 if kind == "all" else 200)
    differences = {}
    for comparator in ["baseline", "off"]:
        differences[f"on_minus_{comparator}"] = {
            kind: {f"delta_p{percent}_ms": summary["on"][kind][f"p{percent}_ms"] -
                   summary[comparator][kind][f"p{percent}_ms"] for percent in [50, 95, 99]}
            for kind in kinds}
    baseline_over = any(summary["baseline"][kind]["p95_ms"] > 10 for kind in kinds)
    passed = all(summary["on"][kind]["p95_ms"] <= 10 for kind in kinds)
    report = {"baseline_revision": BASELINE, "profile": "release", "block_size_per_hook": 50,
              "arms": summary, "differences": differences,
              "judgment": "not_judged_baseline_over_10_ms" if baseline_over else
                  ("passed" if passed else "failed_tagging_on_over_10_ms")}
    (report_dir / "latency-comparison.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if baseline_over:
        print("G9 NOT JUDGED: optimized baseline p95 exceeds 10 ms; report to owner")
    elif not passed:
        raise RuntimeError("G9 tagging-on p95 exceeds 10 ms")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-goldens", action="store_true")
    parser.add_argument("--latency", action="store_true")
    parser.add_argument("--report-dir", type=Path, required=True)
    args = parser.parse_args()
    report_dir = args.report_dir.resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    run(["rustc", "--version"], ROOT, os.environ)
    run(["cargo", "--version"], ROOT, os.environ)
    env = dict(os.environ, CARGO_TARGET_DIR=str(ROOT / "target"))
    env.pop("MC_G8_RECORD_DIRECTORY", None)
    env.pop("MC_G8_BASELINE_REVISION", None)
    scratch = ROOT / MODULE / "target"
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="admission-baseline-", dir=scratch) as directory:
        baseline = Path(directory)
        baseline_tree(baseline)
        if args.latency:
            paired_latency(baseline, env, Path(directory), report_dir)
        if args.record_goldens:
            golden_dir = ROOT / MODULE / "testdata/admission-differentials"
            recording = dict(env, CARGO_TARGET_DIR=str(ROOT / "target/admission-baseline"),
                             MC_G8_RECORD_DIRECTORY=str(golden_dir), MC_G8_BASELINE_REVISION=BASELINE)
            for names in FIXTURES.values():
                for name in names:
                    cargo_test(baseline, recording, name)
            (golden_dir / "SOURCE").write_text(
                f"revision {BASELINE}\n"
                "command python3 crates/mc-module/scripts/admission-gates.py --record-goldens --report-dir <report-dir>\n"
                "Hook files are raw response bytes; compaction files are compact JSON replacement bytes.\n"
            )
            print("G8_GOLDENS " + json.dumps({path.name: path.read_text()
                  for path in sorted(golden_dir.iterdir()) if path.is_file()}), flush=True)
    for names in FIXTURES.values():
        for name in names:
            cargo_test(ROOT, env, name)


if __name__ == "__main__":
    main()
