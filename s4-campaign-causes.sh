#!/usr/bin/env bash
set -uo pipefail
export RUSTC_WRAPPER= CARGO_BUILD_RUSTC_WRAPPER= CARGO_BUILD_JOBS=4
cargo --version
rustc --version
failure=0
run() { local label=$1; shift; echo "=== CAUSE $label"; "$@"; local code=$?; echo "=== CAUSE RESULT $label $code"; if [ "$code" -ne 0 ]; then failure=1; fi; }
run wire-metadata cargo test -p mc-module --lib source_lineage_minimum_is_trusted_metadata_not_wire_input -- --test-threads=1
run final-revert env MC_CUT_DIFF_DETAIL=1 MC_S4_REPLAY_SEED=1779033719 MC_S4_REPLAY_PROFILE=0 MC_S4_KINDS=0,1,2,3,4,5,6,9,10,11 cargo test -p mc-module --lib s4_replay_host_campaign_seed -- --ignored --nocapture --test-threads=1
run floor-broca env MC_S4_NO_REVERT=1 MC_S4_REPLAY_SEED=3144134341 MC_S4_REPLAY_PROFILE=0 cargo test -p mc-module --lib s4_replay_host_campaign_seed -- --ignored --nocapture --test-threads=1
run floor-opencode env MC_S4_NO_REVERT=1 MC_S4_REPLAY_SEED=3144134330 MC_S4_REPLAY_PROFILE=1 cargo test -p mc-module --lib s4_replay_host_campaign_seed -- --ignored --nocapture --test-threads=1
exit "$failure"
