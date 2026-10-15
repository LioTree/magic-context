#!/usr/bin/env python3
"""Register review-only Rust tests or apply one deliberately failing control.

Run inside a disposable review worktree. `NON-VACUITY BREAK` marks deliberate
source damage used to prove that the selected tests detect a broken invariant.
Mutations require an empty unstaged
Git diff; stage the live state first and restore the mutated path from the index
with `git checkout -- <path> && touch <path>`. No tests or stores run here.
"""
import argparse
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "crates/mc-module/src/providers/mod.rs"
REGISTRATION = '\n#[cfg(test)]\n#[path = "cc_step_lane_witnesses.rs"]\nmod cc_step_lane_review;\n'
CODEC = "crates/mc-module/src/providers/codec_claude_code.rs"
COMPACTION = "crates/mc-module/src/providers/compaction.rs"
CONTROLS = {
    "author-signed-prefix": (
        CODEC,
        '''if !same_identity_prefix(&input_ids, &output_ids, index, position)
                || raw[..position] != original[..index]
                || signed_prefix(&raw[position]) != signed_prefix(&original[index])
            {''',
        '''// NON-VACUITY BREAK: neutralize the kept-prefix comparison.
            if false && (!same_identity_prefix(&input_ids, &output_ids, index, position)
                || raw[..position] != original[..index]
                || signed_prefix(&raw[position]) != signed_prefix(&original[index]))
            {''',
    ),
    "author-terminal-refusal": (
        COMPACTION,
        '''return match bytes(&answer) {
            Ok(bytes) => HandlerOutcome::Response(bytes),
            Err(error) => error,
        };''',
        '''// NON-VACUITY BREAK: make protected-tail refusal transient so its test fails.
        return transient("neutralized protected-tail refusal");''',
    ),
    "review-marker": (
        CODEC,
        'if &parsed != message || has_marker(&parsed) {',
        '''// NON-VACUITY BREAK: accept transport markers despite valid raw equivalence.
    if &parsed != message || (false && has_marker(&parsed)) {''',
    ),
    "review-raw-answer": (
        CODEC,
        '''out.push('[');
                    out.push_str(&raw.join(","));
                    out.push(']');''',
        '''// NON-VACUITY BREAK: serialize parsed JSON so original-byte tests must fail.
                    out.push_str(&serde_json::to_string(value).map_err(transient)?);''',
    ),
    "identity-prefix": (
        CODEC,
        'if !same_identity_prefix(&input_ids, &output_ids, index, position)',
        '''// NON-VACUITY BREAK: allow equal bytes to stand in for gateway identity.
            if false && !same_identity_prefix(&input_ids, &output_ids, index, position)''',
    ),
    "duplicate-key-marker": (
        CODEC,
        'let parsed = parse_unique_json(raw)?;',
        '''// NON-VACUITY BREAK: choose last duplicate-key values at admission.
    let parsed: Value = serde_json::from_str(raw).map_err(|_| invalid_raw("invalid JSON"))?;''',
    ),
    "duplicate-key-text": (
        CODEC,
        'let parsed = parse_unique_json(raw)?;',
        '''// NON-VACUITY BREAK: choose last duplicate-key values at admission.
    let parsed: Value = serde_json::from_str(raw).map_err(|_| invalid_raw("invalid JSON"))?;''',
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "remove", *CONTROLS])
    action = parser.parse_args().action
    if action in ("install", "remove"):
        source = MODULE.read_text()
        if action == "install":
            if REGISTRATION in source:
                print("review module already installed")
                return
            if "mod cc_step_lane_review;" in source:
                raise SystemExit("unexpected existing registration; refusing to edit")
            MODULE.write_text(source + REGISTRATION)
        else:
            if source.count(REGISTRATION) != 1:
                raise SystemExit("exact review registration not found; refusing to edit")
            MODULE.write_text(source.replace(REGISTRATION, "", 1))
        print(f"{action}: {MODULE.relative_to(ROOT)}")
        return
    subprocess.run(["git", "diff", "--exit-code", "--stat"], cwd=ROOT, check=True)
    path, original, mutant = CONTROLS[action]
    target = ROOT / path
    source = target.read_text()
    if source.count(original) != 1:
        raise SystemExit("control anchor is not unique; refusing to edit")
    target.write_text(source.replace(original, mutant, 1))
    print(f"NON-VACUITY BREAK {action}: {path}")
    subprocess.run(["git", "diff", "--stat"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
