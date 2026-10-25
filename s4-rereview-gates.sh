#!/usr/bin/env bash
# Serial Linux16c release gates. Select one phase to resume under a lane cap;
# all (the default) runs every phase and preserves every runner's exit status.
set -uo pipefail
export RUSTC_WRAPPER= CARGO_BUILD_RUSTC_WRAPPER= CARGO_BUILD_JOBS=16
cargo --version
rustc --version
python3 --version
failure=0
run() {
  local label=$1
  shift
  echo "=== REREVIEW GATE $label"
  "$@"
  local result=$?
  echo "=== REREVIEW RESULT $label $result"
  if [ "$result" -ne 0 ]; then failure=1; fi
}
suites() {
  run fmt cargo fmt --all --check
  run typecheck cargo check -p mc-module --tests
  run review cargo test -p mc-module --lib slice4_review -- --test-threads=4
  run controls cargo test -p mc-module --lib slice4_review::s4_control -- --ignored --test-threads=1
  run cut-lineage cargo test -p mc-module --lib cut_lineage_tests -- --test-threads=4
  run providers cargo test -p mc-module --lib providers:: -- --test-threads=4
  run store cargo test -p mc-store --lib -- --test-threads=16
}
comparisons() {
  run two-cut env -u MC_PRODUCTION_CUT_FIRST_SEED MC_PRODUCTION_CUT_SESSIONS=300 MC_PRODUCTION_CUT_STEPS=24 cargo test -p mc-module --lib successive_production_cuts_match_full_processing_over_many_sessions -- --ignored --nocapture --test-threads=1
  run bootstrap env -u MC_CUT_DIFFERENTIAL_FIRST_SEED MC_CUT_DIFFERENTIAL_MODE=bootstrap MC_CUT_DIFFERENTIAL_SESSIONS=100 MC_CUT_DIFFERENTIAL_STEPS=24 cargo test -p mc-module --lib cut_lineages_serve_what_full_processing_serves_over_many_sessions -- --ignored --nocapture --test-threads=1
}
campaigns() {
  run A1 env -u MC_S4_NO_REVERT MC_S4_STEPS=12 MC_S4_KINDS=0,1,2,3,4,5,6,9,10,11 MC_S4_SESSIONS=300 MC_S4_FIRST_SEED=1779033703 cargo test -p mc-module --lib slice4_review::s4_independent_campaign -- --ignored --nocapture --test-threads=1
  run A2 env -u MC_S4_NO_REVERT MC_S4_STEPS=12 MC_S4_KINDS=0,1,2,3,4,5,6,9,10,11 MC_S4_SESSIONS=300 MC_S4_FIRST_SEED=1779034003 cargo test -p mc-module --lib slice4_review::s4_independent_campaign -- --ignored --nocapture --test-threads=1
  run B env -u MC_S4_KINDS MC_S4_STEPS=12 MC_S4_NO_REVERT=1 MC_S4_SESSIONS=100 MC_S4_FIRST_SEED=3144134277 cargo test -p mc-module --lib slice4_review::s4_independent_campaign -- --ignored --nocapture --test-threads=1
}
cost() {
  export MC_ASYNC_NOTICES=50 MC_ASYNC_VIEWS=5 MC_ASYNC_TAIL_MESSAGES=3000 MC_ASYNC_TAIL_TOKENS=40000 MC_ASYNC_EST_TOKENS=1000
  for repetition in 1 2 3; do
    run cost-$repetition cargo test --release -p mc-module --lib cost_rule_150k_vs_1k -- --ignored --nocapture --test-threads=1
  done
}
original_mutations() {
  run mutation-anchors python3 s4-fix-mutations.py --anchors
  run cache-and-storage-mutations python3 s4-fix-mutations.py
}
reviewer_mutations() {
  run reviewer-anchors python3 rereview-mutations.py --anchors
  run reviewer-0-13 python3 rereview-mutations.py 0 1 2 3 4 5 6 7 8 9 10 11 12 13
}
case "${1:-all}" in
  all) suites; comparisons; campaigns; cost; original_mutations; reviewer_mutations ;;
  suites) suites ;;
  comparisons) comparisons ;;
  campaigns) campaigns ;;
  cost) cost ;;
  original-mutations) original_mutations ;;
  reviewer-mutations) reviewer_mutations ;;
  *) echo 'usage: bash s4-rereview-gates.sh {all|suites|comparisons|campaigns|cost|original-mutations|reviewer-mutations}' >&2; exit 2 ;;
esac
exit "$failure"
