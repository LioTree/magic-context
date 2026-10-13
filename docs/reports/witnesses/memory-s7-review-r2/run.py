#!/usr/bin/env python3
"""Historian memory parity probes using temporary stores and Linux-only Rust execution."""
import importlib.util
import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
OLD = HERE.parent / "memory-s7-review" / "run.py"
spec = importlib.util.spec_from_file_location("s7_original", OLD)
assert spec is not None and spec.loader is not None
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)
base_snapshot = original.snapshot


def snapshot(parent, name):
    dest = base_snapshot(parent, name)
    if name == "head":
        path = dest / "crates/mc-module/src/historian.rs"
        text = path.read_text()
        cut = text.rfind("}")
        path.write_text(text[:cut] + f'\ninclude!(r#"{HERE / "driver.rs"}"#);\n' + text[cut:])
    # Capture raw Broca session.send bodies before parsing loses their key order;
    # byte equality is stricter than equality of the decoded JSON objects.
    path = dest / "crates/mc-module/src/historian_producer.rs"
    text = path.read_text()
    needle = 'log_task.lock().await.sends.push(req["params"].clone());'
    assert text.count(needle) == 1
    text = text.replace(needle, 'println!("S7_R2_RAW_SEND {}", String::from_utf8_lossy(&frame.body));\n' + needle)
    path.write_text(text)
    return dest


def classify():
    data = json.loads((original.INPUT / "differential.json").read_text())
    classes = {}
    for difference in data["differences"]:
        case = difference["case"]
        before, after = difference["base"], difference["head"]
        if case.startswith("driver-"):
            delta = [a - b for a, b in zip(after["counts"], before["counts"])]
            key = "driver:" + json.dumps(delta, separators=(",", ":"))
        elif case.startswith("fold-"):
            # Reproduce the xorshift input generator in memory-s7-review/fold.rs;
            # collection flags must come from the input, not the observed rows.
            index = int(case.split("-")[1])
            rng = 0xf01d73371012
            for _ in range(index + 1):
                rng ^= (rng << 13) & ((1 << 64) - 1)
                rng ^= rng >> 7
                rng ^= (rng << 17) & ((1 << 64) - 1)
            key = (f"fold:fields={','.join(difference['fields'])}"
                   f":facts={rng % 4}:promote={bool(rng & 4)}:ts_owned={bool(rng & 8)}")
        else:
            key = case + ":" + ",".join(difference["fields"])
        classes.setdefault(key, []).append(case)
    result = {"cases": data["cases"], "changed": data["changed"],
              "classes": [{"class": key, "count": len(cases), "cases": cases}
                          for key, cases in sorted(classes.items())]}
    import hashlib
    import re
    raw = {}
    for revision in ["base", "head"]:
        output = (original.INPUT / f"{revision}-mc-module.log").read_text()
        raw[revision] = re.findall(r"S7_R2_RAW_SEND (.+)", output)
    assert len(raw["base"]) == len(raw["head"]) == 2
    result["raw_wire"] = {"identical": raw["base"] == raw["head"],
                          "requests": raw["head"],
                          "sha256": [hashlib.sha256(body.encode()).hexdigest() for body in raw["head"]]}
    assert result["raw_wire"]["identical"]
    (original.INPUT / "r2-classification.json").write_text(json.dumps(result, indent=2) + "\n")
    print("S7_R2_CLASSIFICATION " + json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    original.require_opt_in()
    setattr(original, "snapshot", snapshot)
    if len(sys.argv) > 1 and sys.argv[1] == "r2":
        import re
        import subprocess
        import tempfile
        if sys.platform != "linux":
            raise SystemExit("Rust probes must run on Linux")
        subprocess.run(["cargo", "--version"], check=True)
        subprocess.run(["rustc", "--version"], check=True)
        with tempfile.TemporaryDirectory(prefix="mc-s7-r2-", dir=os.environ.get("TMPDIR")) as tmp:
            dest = snapshot(Path(tmp), "head")
            result = original.cargo(dest, "mc-module", "s7_r2", True, "r2-witnesses")
            failed = set(re.findall(r"^    (historian::tests::s7_r2_\S+)$", result.stdout, re.M))
            expected = {"historian::tests::s7_r2_late_typed_error_must_not_abandon_fresh_attempt"}
            assert result.returncode == 101 and failed == expected
            assert "late error from attempt 1 abandoned attempt 2" in result.stdout
            assert "2 passed; 1 failed" in result.stdout
            print("S7_R2_EXPECTED_RED late_typed_error; other 2 independent witnesses passed")
    else:
        original.main()
        if len(sys.argv) > 1 and sys.argv[1] == "differential":
            classify()
