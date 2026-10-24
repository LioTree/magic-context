#!/usr/bin/env bash
# Second priority job: original campaign sizes/seeds plus native host cases and red controls.
set -uo pipefail
export RUSTC_WRAPPER= CARGO_BUILD_RUSTC_WRAPPER= CARGO_BUILD_JOBS=16
cargo --version
rustc --version
python3 --version
failure=0
run() { local label=$1; shift; echo "=== CAMPAIGNS GATE $label"; "$@"; local result=$?; echo "=== CAMPAIGNS RESULT $label $result"; if [ "$result" -ne 0 ]; then failure=1; fi; }
run A1 env MC_S4_KINDS=0,1,2,3,4,5,6,9,10,11 MC_S4_SESSIONS=300 MC_S4_FIRST_SEED=1779033703 cargo test -p mc-module --lib slice4_review::s4_independent_campaign -- --ignored --nocapture --test-threads=1
run A2 env MC_S4_KINDS=0,1,2,3,4,5,6,9,10,11 MC_S4_SESSIONS=300 MC_S4_FIRST_SEED=1779034003 cargo test -p mc-module --lib slice4_review::s4_independent_campaign -- --ignored --nocapture --test-threads=1
run B env MC_S4_NO_REVERT=1 MC_S4_SESSIONS=100 MC_S4_FIRST_SEED=3144134277 cargo test -p mc-module --lib slice4_review::s4_independent_campaign -- --ignored --nocapture --test-threads=1
run mutation-anchors python3 s4-fix-mutations.py --anchors
run mutations python3 s4-fix-mutations.py
exit "$failure"
