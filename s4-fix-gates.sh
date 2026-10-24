#!/usr/bin/env bash
# Run each gate serially; preserve every result even when a later gate fails.
set -uo pipefail
export RUSTC_WRAPPER= CARGO_BUILD_RUSTC_WRAPPER=
export CARGO_BUILD_JOBS=16
cargo --version
rustc --version
fail=0
run() {
  echo "=== GATE $1"
  local label=$1
  shift
  "$@"
  local result=$?
  echo "=== RESULT $label $result"
  if [ "$result" -ne 0 ]; then fail=1; fi
}
for repetition in 1 2 3; do
  run cost-$repetition cargo test --release -p mc-module --lib cost_rule_150k_vs_1k -- --ignored --nocapture --test-threads=1
done
run fmt cargo fmt --all --check
run typecheck cargo check -p mc-module --lib
run review cargo test -p mc-module --lib slice4_review -- --test-threads=4
run review-controls cargo test -p mc-module --lib slice4_review::s4_control -- --ignored --test-threads=1
run provider cargo test -p mc-module --lib providers:: -- --test-threads=4
run store cargo test -p mc-store --lib -- --test-threads=16
run two-cut env MC_PRODUCTION_CUT_SESSIONS=300 MC_PRODUCTION_CUT_STEPS=24 cargo test -p mc-module --lib successive_production_cuts_match_full_processing_over_many_sessions -- --ignored --nocapture --test-threads=1
run bootstrap env MC_CUT_DIFFERENTIAL_MODE=bootstrap MC_CUT_DIFFERENTIAL_SESSIONS=100 MC_CUT_DIFFERENTIAL_STEPS=24 cargo test -p mc-module --lib cut_lineages_serve_what_full_processing_serves_over_many_sessions -- --ignored --nocapture --test-threads=1
run A1 env MC_S4_KINDS=0,1,2,3,4,5,6,9,10,11 MC_S4_SESSIONS=300 MC_S4_FIRST_SEED=1779033703 cargo test -p mc-module --lib slice4_review::s4_independent_campaign -- --ignored --nocapture --test-threads=1
run A2 env MC_S4_KINDS=0,1,2,3,4,5,6,9,10,11 MC_S4_SESSIONS=300 MC_S4_FIRST_SEED=1779034003 cargo test -p mc-module --lib slice4_review::s4_independent_campaign -- --ignored --nocapture --test-threads=1
run B env MC_S4_NO_REVERT=1 MC_S4_SESSIONS=100 MC_S4_FIRST_SEED=3144134277 cargo test -p mc-module --lib slice4_review::s4_independent_campaign -- --ignored --nocapture --test-threads=1
run mutations python3 s4-fix-mutations.py
exit "$fail"
