#!/usr/bin/env bash
# Generate and check the frozen historian wire through mc-module's real routes.
set -euo pipefail
cd "$(dirname "$0")/../../../../../../.."
if [[ "${1:-}" == "--write" ]]; then
    export MC_WRITE_HISTORIAN_CLAIM_VECTORS=1
elif [[ $# -ne 0 ]]; then
    printf 'usage: %s [--write]\n' "$0" >&2
    exit 2
fi
cargo test -p mc-module --lib historian_claim_conformance::historian_claim_vectors_byte_identical_regeneration -- --exact --nocapture
