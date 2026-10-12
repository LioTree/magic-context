# Independent Rust S4 cache-safety review

## Scope and conclusion

Reviewed `2111241d3c3e2f210ba795b00d5c56641fe28cfa` and
`6054201731dd00b51e16259b2407f3ec2b8928dd`, on the S4 Rust projection branch,
against `train/agent-move` at `1c5702224a126b13930711d836689ec6ea62846a`.
The accepted contract is the shown-state redesign in
[the S3 design](../designs/memory-s3-projection.md) and
[the Rust implementation note](../../crates/mc-module/MEMORY-PROJECTION.md),
not the retired live/deferred reconstruction algorithm. In this contract, m[0]
is the frozen memory baseline and m[1] its correction block: HARD rebuilds the
baseline from canonical data; independently authorized SOFT appends only the
editing session's immutable fragments; defer replays the prior bytes. SOFT/defer
must not read canonical memory rows, mutation logs, or their heads for the pair.
An edit is not its own refresh authorization, and foreign/automated edits wait
for HARD. Search may read current memory without changing the pair.

**No P0/P1 cache-safety violation was observed.** Own-session SOFT fragment
composition, byte-identical defer, HARD reset, independent authorization, and
canonical-read fences survived the exercised cases. The five author-described
mutation controls and two additional controls all reddened only their intended
test in the selected test groups. This is not an unconditional end-to-end memory
snapshot or session-move endorsement: the two P2 qualifications below remain.

This delivery changes reports, review tooling, and tests only. The sole addition
to `transform.rs` is inside its existing `#[cfg(test)]` module. No product
renderer, writer, migration, manifest, lockfile, `ARCHITECTURE.md`, or
`STRUCTURE.md` is changed.

## Findings by severity

### P2 — A real HARD can serve mutually inconsistent canonical text and host image

**Observed, and already acknowledged as a departure.** Rust accepts a
capability-gated host `data_url`/`content_hash` without a memory revision manifest.
The canonical rows/revisions/watermark are read in Rust's context snapshot, but
the host artifact is accepted separately (`m0_compose.rs:543–558,624–658`).
Neither a supplied hash nor the projection's m0 text hash proves the two sources
were read together.

The new `review_stale_host_mural_is_frozen_on_soft_but_accepted_at_hard` witness
uses a real PNG visibly spelling **NO**, initially paired with memory text `NO`.
After an automated revision changes the row to `YES`:

1. defer replays the complete previous serialized serve;
2. an independently authorized SOFT keeps the old m0 and PNG;
3. a render-config-authorized HARD serves canonical `#1: YES` **and the unchanged
   NO PNG**.

The opt-in `review_hard_requires_mural_revision_coherence` test requires HARD to
reject an image from an older canonical revision. It fails on that final serve:

> HARD serves canonical YES beside a host image visibly spelling NO; no revision manifest rejects it

See `transform_memory_cache_review_tests.rs:368–434`. This is an executable
witness of the documented limitation, not a mutation and not an assertion that
Rust currently promises to reject such input. The coherence test stays ignored
so normal package tests do not fail for the explicitly recorded host-wire gap.

**Cache consequence:** the mismatch does **not** authorize a SOFT bust. The
marker probe uses the applied text and frozen image, and defer/SOFT do not adopt
the new host artifact. An own correction beside a frozen image on SOFT is the
intended correction model, not this finding. The problematic case is a genuine
HARD establishing a new baseline with two different source revisions and no m1
correction. Severity is P2 semantic/snapshot inconsistency, not a P1 invariant-4
violation. Closing it requires a host revision/source manifest or a shared fold
snapshot, with rejection/re-render when it does not match Rust's selection; an
opaque content hash alone is insufficient.

### P2 — Fragment-ID collision refusal is declared, but not demonstrated by a context-half importer

**Assurance gap; no corruption was observed.** Version 69 is the Rust module
store's migration version. The module move copies its existing `mc_cache_state.meta`
JSON unchanged, preserving the new projection and its integer fragment references. The new populated
module-move witness compares raw `session_id,meta` cells and the decoded tuple,
including watermark 40 and committed fragment reference 42, after actual
capture/reserve/install (`move_store/tests.rs:1151–1191`). A context-half export
witness preserves IDs 37 and 91 and excludes the foreign session's ID 92
(`move_inventory.rs:4379` onward).

However, inventory policy is not importer execution. The fragment inventory says
`PreserveOrRefuseCollision`: keep an incoming integer ID exactly, or refuse the
move when that ID already exists at the destination (`move_inventory.rs:2719–2742`), while the implemented
Rust installer and collision preflight iterate **`Store::Module`**, not
`Store::Context` (`move_store.rs:613,956–995`). The context exporter serializes
unchanged IDs (`move_snapshot.rs:187–249`), but this worktree did not establish a
context-half importer or a populated-fragment destination-collision test. The
module's existing `preflight_refusals_do_not_reserve_or_write_live_rows` tests
other module keys, not context fragment IDs.

The claim that IDs are shipped unchanged is supported. The stronger claim that a
complete move either preserves those references **or refuses a fragment
collision** is not yet an executed end-to-end guarantee here. Before certifying
that boundary, test a full context+module move with a populated tuple and a
conflicting destination fragment ID, and assert refusal before either half is
made live. Do not remap the integer IDs without atomically rewriting every
watermark/committed reference. This qualification does not invalidate the local
SOFT projection algorithm.

### P3 — Some inline Rust comments still describe the pre-S4 behavior

`m1_compose.rs:370–374` says Rust does not yet append own fragments, and the
SOFT arm at `transform.rs:4082–4083` says memory changes reach the prompt at the
next HARD. The wrapper now immediately follows the replay composer with own
fragment composition; the facade witnesses demonstrate the next independently
authorized SOFT. These comments can mislead a maintenance reader about the
ownership rule. The implementation note is accurate. No product comments were
rewritten in this report-only change.

## 1. Served bytes and parity

### Newly randomized serves, not just checked-in examples

`review_randomized_served_sequences_match_ts_composer` runs four independent
xorshift seeds: `0x8b45a029`, `0xa643d711`, `0x137efccb`, `0xc09d32a1`.
Each makes 160 actual Rust transforms, interleaving same-session, foreign-session,
and automated canonical edits, including XML metacharacters, emoji, and multiline
text. Budgets range over 0, 100, 500, 1200, and 8000 tokens. Cases that independently
rebuild the baseline (HARD) restore a large enough budget to include the current
canonical row, so the test does not mistake budget exclusion for a lost edit.

Observed operation counts over **640 served steps**:

| Operation | Count |
| --- | ---: |
| Plain defer | 93 |
| Independently armed SOFT | 104 |
| Direct `arm_soft_refresh`, the core flag used by `session.flush` | 85 |
| Reopen followed by defer | 88 |
| Explicit stale-writer CAS loss, then SOFT | 100 |
| Render-config HARD | 79 |
| Model-key plus render-config switch HARD | 91 |

All 181 defer/restart serves compare the entire serialized message array with the
previous serve, not just a digest or selected substring. Each SOFT checks frozen
m0; all 170 HARDs check the latest canonical prose, empty memory-updates, and an
empty committed fragment ledger. The CAS cases exercise a stale `McStore::commit`
refusal, not an injected race inside a running transform.

The shared golden generator now accepts `--input`, `--output`, `--seed`, and
`--steps` without changing its default fixture. The actual 289 SOFT states and
pending own fragments are fed to **production TS/Pi `composeSoftMemoryUpdates`**
through that generator; Rust's complete memory-updates block and committed
full/marker/aggregate records match its output exactly. This differential checks
composition from identical shown states. It does not pretend that the TS host
ran Rust's scheduler, restart, or CAS implementation.

A second explicit test generates **1296 additional cases** from the same four
new seeds (320 sequence cases plus four facade cases per seed), using the
production TS fragment-line renderers as well as its composer, and compares
Rust's output. In addition to comparing identical shown states, the test compares
against independently generated TS fragment bytes and budgets. The unchanged
164-case checked-in fixture passes `--check`.

The public facade's existing four-action witness separately covers real
`ctx_memory` update/merge/archive/write, real `session.flush`, owning-session
SOFT, other-session isolation, and subsequent complete defer replay. Randomized
flush-equivalent cases use the same `arm_soft_refresh` authorization but do not
replace that route-level witness. Randomized canonical operations are updates;
merge/archive/additive coverage is supplied by the production-generator cases and
fixed public-facade scenarios rather than claimed as random facade coverage.

### Read fences, authorization, and budget retention

Four tests rename `memories` or `memory_mutation_log` out of reach before SOFT
and SOFT+, making any row or head read fail. The row-reading renderer is their
positive control and must fail against those renamed tables.
`load_m1_revision_snapshot` omits both memory heads, and own pending fragments
are selected by session, `id > watermark`, and `harness='ck-mc'`
(`mc-store/src/lib.rs:12694–12750`; `memory_projection.rs:180–200`). Current
memory reads are reserved to HARD and named search/hint work, not the pair's
SOFT/defer decision or renderer.

The facade same-session test checks that an edit does not authorize its own bust:
the immediate pass is SOFT+ (historical wire spelling for defer), and only a
separate authorization makes the fragment visible. The pressure mutation below
also proves correction traces cannot create a HARD fold.

The composer reserves `min(200, allowance/2)` marker tokens, renders each operation
whole or as a marker, and then accumulates one overflow record. It retains prior
full and marker records (`agent_fragments.rs:83–199`). The new
`review_shown_full_and_marker_lines_survive_budget_collapse` freezes one full
correction and one oversize marker, collapses both budgets to zero, and appends
100 edits. Earlier records remain exactly equal; there is exactly one aggregate
with count 100. Mutation control 6 clears the retained records at zero allowance;
the retention test then fails because two earlier records are missing.

## 2. Store, crashes, migration, and move boundaries

**Row and fragment commit together.** Update/archive/merge/write route callbacks
record pre-rendered fragments inside `with_facade_command`'s context.db write
transaction (`mc-module/src/lib.rs:13533–13775`; `mc-store/src/lib.rs:8357–8361`;
`memory_projection.rs:66–85`). The separate store.db command receipt commits
later. A crash between the two databases may lose the command receipt and cause
a retry, but cannot split the canonical row from its fragment. Stable operation
keys retain the first fragment on retry. This is a local transaction guarantee,
not a cross-database exactly-once claim for every possible retried command.

Two additional witnesses exercise the dangerous intra-transaction cuts:

- `review_fragment_failure_rolls_back_canonical_edit_and_history` installs a
  trigger rejecting fragment insertion. The command fails and, after reopen,
  prose is unchanged and history/log/fragment rows are all absent.
- `review_crash_between_row_and_fragment_is_atomic` launches the test executable
  as a child, updates the canonical row inside that transaction, and exits with
  code 73 **without destructors and before fragment insertion**. Recovery reopens
  the original prose with no surviving history/log/fragment rows.

The applied tuple and served bytes share the cache row transaction/CAS. Existing
`applied_snapshot_commit_is_atomic` rejects the stale writer and compares both
bytes and tuple after reopening; the new CAS-bypass mutation makes it fail. The
store's existing killed-writer/chunk rollback tests also pass. A HARD captures
rows, revisions, and fragment watermark together via `context_read` and
`read_memory_render_snapshot`; SOFT reads no canonical revision heads to commit
its extension (`mc-store/src/lib.rs:7834–7858,14653–14670`;
`single_store_schema.rs:341–449`).

**Populated v68-to-v69 migration:** the older-chain test preserves frozen bytes,
adds/reopens a non-default tuple, and rejects a v68-max opener. Migration 69 is a
version fence (`SELECT 1`) because the new tuple is JSON in the existing meta
column; it is not a second cache table.

To distinguish a simulated old migration chain from an actual older reader, this
review also exported the committed `1c570222` tree into a temporary directory
inside the review worktree, compiled its `mc-store` into a tiny v68 reader, and
opened a fresh populated v69 store created by the current implementation. This
was an actual executable linked to the old store source, not the current binary
with its maximum version lowered. It returned `StoreAheadOfBinary { binary_max:
68, .. }`; output was:

> Current binary created a populated store v69
>
> Actual v68 binary refused the populated v69 store before metadata decode/write

Both small probe programs and the old source export were temporary and are not
product changes. The module's real-daemon store-ahead health/transform refusal
test also passes. Move inventory version 69, populated module meta transfer, and
context export-ID preservation pass; the collision qualification remains as
stated in the P2 finding.

## 3. Marker probe and mural

`MarkerMemorySource` may inspect current revision state during a **marker HARD**,
but normally renders applied memory/profile and scores. Incoming mural bytes are
replaced by the cached artifact for the probe. If independently rendered content
is unchanged, marker commit preserves the previous tuple and complete pair
(`transform.rs:3923–3989,10325–10496`). These canonical reads belong to the
independently requested HARD probe; an ordinary SOFT does not use that source.

The existing marker witness covers compaction on and off, a restart, an own
fragment already shown, pending lifecycle text, changed incoming image/hash,
unchanged complete serialized output and projection, and eventual adoption on a
natural HARD. External same-revision SQL repair and privacy/workspace revocation
remain stronger safety inputs. The corresponding peers stay green when the
marker-adopts-latest mutation breaks the freeze.

Thus the unproven cross-process image snapshot does not itself create a SOFT bust
in the exercised path. A caller changing an independently cache-affecting
render-config key can request a HARD; that is a separate authorization, not a
mural hash silently acting as an edit-triggered SOFT authorization. The genuine
HARD's semantic coherence remains the P2 issue above.

## 4. Departures evaluated against the accepted rules

| Recorded departure | Review judgment |
| --- | --- |
| No classification/replay of deferred operations to reconstruct the memory pool (the old adoption scans, rebases, and hole-bearing cursor) | Complies with the replacement contract: neither foreign nor automated writes enter SOFT; there is no row/log reconstruction to leak them. |
| Automated cue corrections wait for HARD | Complies. Own image-only edits may append full correction or stale marker without regenerating the frozen image. |
| Search returns unlabelled current text | No violation of these rules. `fully_visible_memory_ids` requires trustworthy shown full prose equal to the current row; old revision, cue, marker, or unknown legacy state does not suppress a current hit. The cue mutation proves this distinction. |
| Existing pair owns bytes/image; tuple binds m0 rather than duplicating it | No observed local atomicity violation. Shared cache CAS and reopen tests defend the binding; it is not proof of host image source coherence. |
| Host pre-rendered mural lacks source manifest | P2 genuine-HARD coherence limitation, not a SOFT/defer freeze violation. |
| Dashboard approval/undo epoch routing remains elsewhere | No dashboard guarantee is certified here. Within this slice, automated and foreign writes wait for an independently authorized HARD. |
| Agent mutation-log rows retained for compatibility | Acceptable: the SOFT pair renderer does not read them or their heads. |

Explicit search and a newly computed automatic hint may read current memory;
that exception to the read prohibition does not permit recomposing the pair. The existing search and hint tests pass in the complete suite. This review
adds no new host automatic-search protocol and does not claim labelled
revision/adoption search results or a cross-host rendering snapshot.

## 5. Mutation controls

The original exact diffs were not recorded in the commits. The task giver supplied
the five control/test descriptions from the original delivery evidence. Controls
1–5 below are **reconstructed from the author's descriptions**, not claimed to
be byte-identical reruns of an unavailable original patch. Controls 6–7 are new.

Every control used the same safe sequence: stage the live files; confirm empty
`git diff --stat`; apply the deliberate unsafe code change listed below, marked
`NON-VACUITY BREAK` to prevent accidentally shipping it; capture the nonempty stat;
run the named tests on Linux; restore **from the index** with
`git checkout -- <path> && touch <path>`; confirm an empty unstaged stat. No mutant
is committed. Mutation output is summarized here rather than left in a deletable
build directory.

The same projection test group runs with each relevant mutation. Its other tests
must continue passing to localize the failure rather than credit an unrelated
suite failure. Let **projection peers** mean these other nine tests in
`transform::tests::memory_projection`: `external_repair_still_recuts`,
`privacy_revocation_still_invalidates`, `soft_keeps_admitted_membership_and_revisions`,
`pending_lifecycle_cannot_manufacture_pressure_hard`,
`current_revision_search_survives_old_prompt_exclusion`,
`cue_visibility_does_not_hide_full_text`, `retired_rows_are_history_only`,
`applied_snapshot_commit_is_atomic`, and
`randomized_soft_defer_hard_restarts_replay_exact_pair`, excluding the red test
and including `marker_probe_and_commit_ignore_pending_lifecycle` when it is not
the red test. In each 10-test run exactly one named test failed and the other
nine passed.

| # | Break | Exact red test (unique within selected group) | Green controls | Applied diff; restored diff |
| --- | --- | --- | --- | --- |
| 1 | Marker source selects latest prose regardless of applied revision/repair permission | `transform::tests::memory_projection::marker_probe_and_commit_ignore_pending_lifecycle`: `!marker.prefix_bust_permitted` | Nine projection peers, including external repair/privacy | `transform.rs`: 1 insertion, 3 deletions; empty |
| 2 | Authorized SOFT calls `load_memory_render_snapshot` | `transform::tests::soft_reads_no_memory_rows_or_watermark`: `armed=true table=memories: ... no such table: memories` | `transform::tests::memory_only_change_opens_no_execute_band_soft` | `m1_compose.rs`: 2 insertions; empty |
| 3 | Memory-updates included in independent content and pressure tokens | `transform::tests::memory_projection::pending_lifecycle_cannot_manufacture_pressure_hard`: served action not SOFT/SOFT+ | Nine projection peers | `transform.rs`: 3 insertions, 4 deletions; empty |
| 4 | Cue representation treated as full visible text | `transform::tests::memory_projection::cue_visibility_does_not_hide_full_text`: visible exclusions not empty | Nine projection peers, including current-revision search | `memory_projection.rs`: 2 insertions, 1 deletion; empty |
| 5 | Fragment writer rerouted to the fixture's other session, `pm_facade/other/epoch-1`, instead of its editing session | `tests::facade_memory_operations_match_ts_goldens_on_soft_and_isolate_sessions`: update must record exactly one own-session fragment; got 0 | `agent_fragments::tests::ts_pi_rust_fragment_bytes_match_shared_randomized_fixture` | `memory_projection.rs`: 2 insertions; empty |
| 6 | Zero allowance clears already committed full/marker records | `transform::tests::memory_cache_review::review_shown_full_and_marker_lines_survive_budget_collapse`: two retained records absent (slice length 1) | Fragment-failure rollback and stale-mural freeze/HARD witnesses; three opt-in tests ignored | `agent_fragments.rs`: 2 insertions; empty |
| 7 | Bypass stale cache `row_version` refusal | `transform::tests::memory_projection::applied_snapshot_commit_is_atomic`: stale `commit(...).is_err()` false | Nine projection peers | `mc-store/src/lib.rs`: 2 insertions, 1 deletion; empty |

**Result: seven defended controls, zero undefended controls.** The controls cover
important seams, not all of the prose contract. In particular, a renderer golden
alone cannot defend facade ownership (control 5 demonstrates why), and a module
key collision test cannot defend the absent context-half importer. The failing
mural coherence witness is independent of these mutation proofs.

## Verification record and reproduction

All substantive Rust builds/tests/clippy ran on Linux with `runon: "linux,8c"`,
`-j 8`, locked dependencies, and no remote network. Tool versions:

- `rustc 1.99.0 (b940084d7 2026-09-28)`
- `cargo 1.99.0 (5f94df478 2026-08-27)`
- `clippy 0.1.99 (b940084d7e 2026-09-28)`
- Bun `1.4.2`; TypeScript `5.9.3`

Final authoritative gate:

```sh
python3 docs/reports/probes/memory-s4-isolated.py \
  cargo test --locked -p mc-module -p mc-store -j 8
```

**Passed: 2309 tests; 34 ignored; zero failures.** Breakdown: module library
1918 passed/27 ignored; module utility binary 5 passed; 15 integration targets
54 passed/2 ignored; store 332 passed/5 ignored. Three other targets contained
zero tests. The two opt-in parity tests also ran separately and passed (640
serves/289 exact SOFT comparisons and 1296 new-seed cases). The ignored stricter
mural coherence witness was explicitly run and **failed as expected**, as shown
above. Existing private-capture/clone/drive tests were not enabled, and the
real-store-copy integration test early-returns without a supplied clone; no live
store or private clone was supplied to it.

Other passed gates:

```sh
python3 docs/reports/probes/memory-s4-isolated.py \
  cargo clippy --locked -p mc-module -p mc-store --all-targets -j 8 -- -D warnings
python3 docs/reports/probes/memory-s4-isolated.py cargo fmt --all --check
python3 docs/reports/probes/memory-s4-isolated.py \
  rustfmt --edition 2021 --check crates/mc-module/src/transform_memory_cache_review_tests.rs
python3 docs/reports/probes/memory-s4-isolated.py bun run --cwd packages/plugin typecheck
python3 docs/reports/probes/memory-s4-isolated.py \
  bun run --cwd packages/plugin tsc --noEmit -p tsconfig.memory-review.json
python3 docs/reports/probes/memory-s4-isolated.py \
  bun crates/mc-module/tests/fixtures/agent-fragments-golden.ts --check
```

Clippy checks both requested packages and all their targets. The explicit
rustfmt check covers the standalone file reached through `include!`, which
Cargo's formatter does not traverse. The repository
plugin typecheck runs its three configured compiler steps; the additional
review tsconfig checks the generator itself, which the normal plugin include
list does not cover. Both compiler gates exited zero; the default golden checks
all 164 cases. A scoped inspection reported no Rust diagnostics but partial
coverage for the out-of-package TS fixture; the explicit compiler check is the
authoritative evidence, not that partial inspection.

To repeat the two randomized tests separately, without enabling
`review_hard_requires_mural_revision_coherence` (the known failing snapshot test):

```sh
python3 docs/reports/probes/memory-s4-isolated.py cargo test --locked -p mc-module \
  --lib review_randomized_served_sequences_match_ts_composer -j 8 -- --ignored --nocapture
python3 docs/reports/probes/memory-s4-isolated.py cargo test --locked -p mc-module \
  --lib review_new_seed_fragment_sequences_match_ts_composer -j 8 -- --ignored --nocapture
```

### Daemon prerequisite

`Cargo.lock` pins `subc-core` to
`1a14993c120725fa1dce7267b6e7d0823835930c`. A local network-enabled **Git export
step**, entirely inside the review worktree, prepared that committed tree. Its
binaries were then built offline on Linux:

```sh
python3 docs/reports/probes/memory-s4-isolated.py cargo build --locked --offline \
  --manifest-path .review-subconscious/Cargo.toml -p subc-core --bins \
  --target-dir target/review-subc -j 8
```

For integration tests, set:

```sh
export MC_TEST_LOCKED_SUBC_SOURCE="$PWD/.review-subconscious"
export MC_TEST_CK_SUBC_BIN="$PWD/target/review-subc/debug/ck-subc"
export MC_TEST_CK_BIN="$PWD/target/review-subc/debug/ck"
```

The source export contains `.source-revision` with that exact commit. The
review adds a test-only source override validating the marker against Cargo.lock,
so helpers that also need the CLI can build the locked export without accessing
or modifying an operator's sibling checkout. The marker is export provenance,
not a cryptographic verification of arbitrary caller-supplied source. The
export and old-reader probes are removed after the review; this override does
not add a production configuration surface.

### Isolation, failed preliminary gates, and cleanup

The committed `memory-s4-isolated.py` supplies `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
`XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`,
and `TMPDIR`, all below the throwaway task root
`$TMPDIR/magic-context/s4-cache-review/`. Test temporary directories inherit that
root. The protected live paths were never opened, read, written, or migrated:
`~/.local/share/opencode/*.db`,
`~/.local/share/cortexkit/magic-context/{context,store}.db`,
`~/.config/opencode/*`, and `~/.config/cortexkit/*`. The
only local runtime work was formatting and construction of the inert PNG;
substantive store/process tests were remote. Git source export did not access
live application data.

The audit samples `lsof -Fn` for each command and its descendant processes and
refuses any observed database descriptor outside the throwaway root. Final
complete suite evidence:

> LSOF AUDIT: 3933 samples, 15080 distinct database descriptors, 0 paths outside throwaway root
>
> COMMAND EXIT=0

Representative descriptors were task-local `.tmp*/context.db`, `store.db`, and
their WAL/SHM files. The actual v68 reader probe also sampled only task-local
`magic-context/probe.db{,-wal,-shm}`. Sampling alone cannot observe every
short-lived descriptor; explicit root-bound paths and code inspection complement
it. It is not described as a universal proof over unobserved future processes.

Two preliminary failures in isolation setup and test runs are recorded below:

- The first module run had 1913 passed, one failure, and 24 ignored because the
  chosen temporary storage directory was named `storage`, whereas the existing
  path-shape test expects its basename to be `magic-context`. Renaming the
  throwaway directory made the focused test pass; the final full suite passes.
  This was not a memory-projection regression.
- The first audited store run passed all product assertions, but the auditor
  refused 48 database descriptors under the **worktree's throwaway
  `target/.tmp*` directories**, not a live store. The inventory fixture explicitly
  used `tempdir_in(target)` despite TMPDIR. Its test-only helper now uses
  `tempfile::tempdir()` and honours TMPDIR. The final run has zero outside-root
  descriptors. No live store was involved in that refusal.

Review-test authoring issues (m0 multiline indentation, budget-controlled HARD
selection, a one-column call to an existing two-column dump helper, and a
review-tsconfig declaration option) were corrected before the final gate; they
are not reported as product defects. No manifest/lockfile changed, so no package
install was required. The transient source exports, probe programs, and host and
Linux throwaway roots are cleaned up; reusable build artifacts are not treated
as review evidence. This report and the result declaration retain the evidence
needed after build-directory deletion.
