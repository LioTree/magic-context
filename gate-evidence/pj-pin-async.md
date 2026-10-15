# ck-mc asynchronous project pin verification

All Rust commands ran on Linux with 4 vCPUs. Toolchain:

- cargo 1.99.0 (5f94df478 2026-08-27)
- clippy 0.1.99 (b940084d7e 2026-09-28)
- rustfmt 1.10.0-stable (b940084d7e 2026-09-28)

The test environment redirects `TMPDIR` into the job's
`$TMPDIR/magic-context/pj-pin-async/`; the full test runs also redirect HOME, XDG
directories, Magic Context storage and the database file named by `OPENCODE_DB`
into that temporary subtree. No live stores or real-daemon fixtures were used.

## Bind latency

`cargo test -p mc-module --lib --bins -j 4 -- --nocapture` included
`tests::binding_projects::on_bind_slow_pin_writer_latency_distribution`.
Each sample is a real `McHandler::on_bind`, with a fresh project folder, no host
session row, and an accepted registered response from an in-process wire peer.
All 50 binds per arm use the same writer; the injected delay is inside its actual
file-write callback, not in the resolver or a mocked timing measurement.

| Writer delay | Binds | p50 (ms) | p99 (ms, nearest rank) |
| --- | ---: | ---: | ---: |
| 0 ms | 50 | 1.055 | 1.422 |
| 1,000 ms | 50 | 1.048 | 2.332 |

Every bind must finish in less than 500 ms. Both arms verify the returned route
identity, that the resolver was called, and that the writer actually ran.

## Mutation control

After staging the live files and confirming an empty unstaged diff, the pin
handoff was changed to call `flush(5s)` synchronously immediately after publishing
the pin. The mutation was marked as deliberately incorrect blocking behavior;
the indexed implementation was restored before committing.

- Mutated path: `crates/mc-module/src/project_identity.rs`.
- During mutation: `1 file changed, 2 insertions(+)`.
- Command: `cargo test -p mc-module --lib tests::binding_projects::on_bind_slow_pin_writer_latency_distribution -j 4 -- --exact --nocapture`.
- Only failure: `tests::binding_projects::on_bind_slow_pin_writer_latency_distribution`.
- Failure message: `bind waited for pin writer (1000 ms): 1010.515 ms`.
- Summary: 0 passed, 1 failed, 1881 filtered out. The zero-delay arm completed
  successfully (p50 0.861 ms, p99 1.570 ms).
- Restored with `git checkout -- crates/mc-module/src/project_identity.rs && touch crates/mc-module/src/project_identity.rs`; unstaged `git diff --stat` was empty.
- The restored latency test subsequently passed in the full unit run above.

## Other gates

- `cargo fmt --all --check`: passed.
- `cargo clippy -p mc-module --all-targets -j 4 -- -D warnings`: passed.
- Unit library run: 1852 passed, 29 ignored, with one initial failure in
  `authority_managed_defers_populated_projects_until_row_removal` because its
  immediate sidecar-existence assertion assumed synchronous persistence. The
  assertion now waits for the writer, without changing the identity expectation;
  an exact rerun passed (1 passed). Thus all 1853 non-ignored unit tests passed
  across the full run and that targeted rerun.
- Binary tests: 5 passed; ck-mc's main target has no unit tests.
- Non-daemon integration targets: 18 reported passed across 12 targets. The
  `real_store_copy_migration` test is inert with `MC_REAL_STORE_COPY` unset, so
  this represents 17 executed checks plus one early return, not a real-store
  migration proof. `standalone_differential` required an invocation-only
  `safe.directory=$PWD` Git override in the read-only remote repository, and its
  source-copy harness now includes the new writer module. The rerun passed.
- `real_daemon` and `real_daemon_store_ahead`: skipped as requested; they require
  the sibling subconscious checkout. Existing ignored private-fixture tests
  remain ignored; the two subprocess-only identity tests are invoked by their
  parent tests rather than run independently.

The new behavioral tests cover pending-pin visibility over a stale git sidecar,
cross-resolver and repeated-bind visibility, common-directory pin conflicts,
latest-wins coalescing while an older write is active, late-publication pin
stickiness, successful and bounded shutdown, saturation/next-bind retry, failed
write retry, and abrupt process exit followed by restart without a durable pin.
