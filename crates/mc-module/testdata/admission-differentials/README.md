# Admission differential and latency gates

`SOURCE` pins the pre-tagging revision. The JSON files are exact byte snapshots,
not pretty-printed JSON: do not add a newline or reformat them. Existing fixture
tests compare raw hook responses and compact-serialized compaction replacement
arrays against these files. The latter exclude volatile compaction IDs and
versions, but no replacement message bytes are normalized.

Record from the pinned baseline and compare the working tree on Linux:

```sh
python3 crates/mc-module/scripts/admission-gates.py --record-goldens \
  --report-dir .cortexkit/internal-docs/admission-gates
```

The script archives the entire baseline inside this worktree, copies in only the
test harness and four instrumented fixture functions, and uses a separate Cargo
target directory so baseline and working-tree store artifacts cannot mix. It
does not check out or modify another repository. Review any golden update as a
baseline pin change, never as an automatic acceptance of changed output.

## Real hook capture (G8)

`cc_real_capture_hook_sequence` reads
`local-ignore/cc-admission-hooks.json` relative to the repository root, or the
path in `MC_CC_HOOK_CAPTURE`. A missing file prints its full path and `G8 NOT RUN`
before skipping. Other I/O errors, malformed captures, hook errors and unexpected
ops fail the test. Private captures must remain uncommitted.

The replay format is a JSON object with a nonempty `hooks` array. Each entry has
`params` (the unmodified `transform.hook` params, including the native
`raw_message`) and `expected` (the expected JSON answer, including ops). The
fixture creates an attested, tagging-enabled Claude Code conversation with
session `cc`, harness `claude-code`, and lineage `L`; capture those identifiers
when exporting the private sequence. It does not derive expected ops from the
implementation. A synthetic replay test checks both a first admission and retry;
a separate negative test verifies that a wrong expected answer fails.

```sh
cargo test -p mc-module --lib cc_real_capture_hook_sequence -- --nocapture
```

## Paired latency (G9)

```sh
python3 crates/mc-module/scripts/admission-gates.py --latency \
  --report-dir .cortexkit/internal-docs/admission-gates
```

Run with 16 Linux vCPUs for the serialized `--release -j 16` builds. The benchmark
times `provider_claude_code_hook` itself, including its SQLite transaction. Each
arm has its own temporary on-disk store and admits 200 each of `pre_user`,
`post_assistant`, and `post_tool`, with an assistant tool-use paired to every
tool result. It advances the served watermark and uses fresh native subjects,
not a repeated cache hit. Request construction and answer assertions are outside
the timer. No timeout or production setting is changed.

The baseline tagging-off arm runs first, followed by tagging-on at the working
tree and a working-tree tagging-off control. Four interleaved blocks contain 50
samples per hook each; baseline/on order reverses on alternate blocks. Each
arm's store persists across blocks. The script records `/proc/pressure/cpu` and
`/proc/loadavg` before and after every block. The benchmark is ignored in the
ordinary suite to avoid a noisy wall-clock gate there.

Reports contain raw samples per block, nearest-rank p50/p95/p99 per hook and
overall, baseline/on/off deltas, and load evidence. If any baseline hook's p95
already exceeds 10 ms, the absolute gate is explicitly **not judged**, rather
than a tagging regression. Otherwise each tagging-on p95 must be at most 10 ms.
The deltas and load evidence let the owner judge added tagging cost separately
from the absolute lane-wide limit. Keep reports outside `target/`.
