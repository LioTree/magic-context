#!/usr/bin/env bash
set -uo pipefail
export RUSTC_WRAPPER= CARGO_BUILD_RUSTC_WRAPPER= CARGO_BUILD_JOBS=16
cargo --version
rustc --version
failure=0
for repetition in 1 2 3; do
  echo "=== ISOLATED COST $repetition"
  cargo test --release -p mc-module --lib cost_rule_150k_vs_1k -- --ignored --nocapture --test-threads=1
  result=$?
  echo "=== ISOLATED COST RESULT $repetition $result"
  if [ "$result" -ne 0 ]; then failure=1; fi
done
exit "$failure"
