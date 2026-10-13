#!/usr/bin/env python3
"""Apply one marked mutation after staging the live implementation.

Each control must make its exact named test fail. Restore the printed path with
`git checkout -- <path> && touch <path>` and verify an empty unstaged diff before
applying another control. This script never runs tests or regenerates fixtures.
"""
import argparse
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PROVIDERS = "crates/mc-module/src/providers/"
CONTROLS = {
    "candidate-bundle": (PROVIDERS + "capability_candidate.rs", "canonical_reduce: false,", "// NON-VACUITY BREAK: change a meaningful advertised feature.\n        canonical_reduce: true,"),
    "held-selection": (PROVIDERS + "mod.rs", 'if params\n        .get("claude_code")\n        .is_some_and(|value| !value.is_null())', '// NON-VACUITY BREAK: silently ignore an unsupported selection.\n    if false && params\n        .get("claude_code")\n        .is_some_and(|value| !value.is_null())'),
    "geometry-forward": ("crates/mc-module/src/transform.rs", 'req.geometry = if native_cc {\n            template.geometry.clone()\n        } else {\n            None\n        };', '// NON-VACUITY BREAK: lose the supplied usable context walls.\n        req.geometry = None;'),
    "geometry-validation": (PROVIDERS + "compaction.rs", 'if !geometry.is_valid(request.context_window)', '// NON-VACUITY BREAK: accept invalid supplied geometry.\n                if false && !geometry.is_valid(request.context_window)'),
    "unverified-fill": (PROVIDERS + "compaction.rs", 'if request.fill.is_some() {', '// NON-VACUITY BREAK: silently discard unverified fill.\n            if false && request.fill.is_some() {'),
    "notice-receipt": (PROVIDERS + "compaction.rs", 'if request.channel2_receipt.is_some() || request.channel2_delivered_id.is_some() {', '// NON-VACUITY BREAK: silently discard unsupported receipt evidence.\n            if false && (request.channel2_receipt.is_some() || request.channel2_delivered_id.is_some()) {'),
    "whole-endpoint": (PROVIDERS + "codec_claude_code.rs", 'if boundary != format!("{}#{part}", entry.mid) {', '// NON-VACUITY BREAK: snap an earlier engine boundary forward.\n    if false && boundary != format!("{}#{part}", entry.mid) {'),
    "inline-reply": (PROVIDERS + "codec_claude_code.rs", 'if output.len() >= HOST_ENVELOPE_BYTES {', '// NON-VACUITY BREAK: return oversized inline reply bytes.\n    if false && output.len() >= HOST_ENVELOPE_BYTES {'),
    "inbound-envelope": (PROVIDERS + "mod.rs", 'if attested_claude_code(binding) && bytes.is_some_and(|bytes| bytes >= HOST_ENVELOPE_BYTES) {', '// NON-VACUITY BREAK: ignore original encoded body length.\n    if false && attested_claude_code(binding) && bytes.is_some_and(|bytes| bytes >= HOST_ENVELOPE_BYTES) {'),
    "coverage-replay": (PROVIDERS + "compaction.rs", 'codec != Codec::ClaudeCodeAnthropic || previous == current', '// NON-VACUITY BREAK: replay stale native coverage.\n    true || codec != Codec::ClaudeCodeAnthropic || previous == current'),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("control", choices=CONTROLS)
    control = parser.parse_args().control
    subprocess.run(["git", "diff", "--exit-code", "--stat"], cwd=ROOT, check=True)
    path, original, mutation = CONTROLS[control]
    target = ROOT / path
    source = target.read_text()
    if source.count(original) != 1:
        raise SystemExit("mutation anchor is not unique; refusing to edit")
    target.write_text(source.replace(original, mutation, 1))
    print(f"NON-VACUITY BREAK {control}: {path}")
    subprocess.run(["git", "diff", "--stat"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
