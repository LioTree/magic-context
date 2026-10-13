# Offline resident-state builder: authorized increment

Status: deliverable for review before any migration or serving consumer. The project owner approved only
(a) a read-only resident builder and independent offline snapshots, (b) the
reader/write-site inventory, and (c) a checkpoint/journal schema proposal. **No
migration, baseline overlay, serving cache/consumer or retryable serving route has
been implemented.** TypeScript transform and full-array Rust algorithms remain
unchanged.

## Implemented input/index prototype

- `crates/mc-module/src/providers/resident.rs` is compiled only with `cfg(test)`.
  It has no module/provider route. It packs full effective parts, exact admitted
  native tail BLOBs and decoded CK, domain input snapshots, sorted block/tag indexes
  and diagnostic raw token/user-token prefixes into an owned arena. Raw prefixes
  are not channel-1 effective/calibrated policy totals.
- Per-compartment fragments are built for tiers 1–5 and temporal dates off/on
  (ten variants), using the current renderer and tokenizer. The full source tuple,
  selected score, tier/options and explicit renderer/tokenizer identity inputs
  accompany each digest. The prototype identities are offline labels, **not a
  reviewed persistent-cache build/vocabulary fingerprint**; there is no cache hit
  or serving path that can consume them.
- `crates/mc-store/src/provider_resident_read.rs` is test/test-support-only. It
  captures conversation/revision/ancestry/effective policy in one read transaction.
  It counts policy rows/UTF-8 bytes before cold hydration and restricts native
  BLOB SQL to after coverage, <=500 messages, with count/byte/depth caps and refusal
  rather than truncation. Duplicate effective native ordinals are refused.
- Input policy hydration is deliberately cold-build work, not an incremental
  hook or valid-checkpoint restore. Domain snapshots are collected through current
  APIs in the isolated synchronous driver; this is not a cross-database publication
  protocol or concurrency proof.

## Independent proof results

`provider-resident-snapshot-differential.ts` uses real provider fixtures. The Rust
oracle independently reads physical policy rows, resolves ancestry/shadowing and
consumption, and compares **all fields** against the packed effective parts. The
old full-lineage reader is used **only by the oracle** to compare the tail's exact
admitted BLOBs. The builder/capture itself does not replay old messages or hook ops.
Domain input serialization is checked field-for-field; source counters and view
eligibility metadata are unchanged by capture. Literal Rust assertions additionally
cover queue/protection/tag/measurement facts and header store/conversation/revision
identity; the expected literal is not built by the packer.

The realistic test ran six snapshots: after fold, after handler restart and after
one compartment delta, on both host bindings. Each snapshot contains:

| Property | Observed |
| --- | ---: |
| Effective policy parts | 74,800 |
| Native BLOBs materialized by capture | **500**, not 17,000 |
| Native tail bytes | 229,200 |
| Compartments / memories | 2,300 / 1,000 |
| Tier/date fragments | 23,000 |
| Retained arena/index capacities | 94,212,680 bytes (about 89.85 MiB) |
| Builder-only duration | 201.445–256.020 ms across six observations |

Those times exclude SQL/domain hydration and the debug snapshot/oracle. They are
**not** fold latency, restart latency, median/p99 acceptance or a sub-100-ms claim.
The retained count includes owned resident capacities, not caller-owned cold input,
temporary rendering/tokenization or the debug JSON snapshot; it does not prove the
proposed process-wide/in-flight serving memory bound. The compact checkpoint must
restore bounded active pages, not load/decode this whole historical arena.

The final small arm adds a real post-bootstrap provider hook carrying signed native
reasoning and an opaque metadata field. All six snapshots compare exact accepted
native BLOB vectors (including preceding messages). Attempting to seed that signed
part through the legacy full-array bootstrap encoder first produced the existing
`CK message block identity drift` refusal. The fixture now admits it through the
provider hook; no product path/test expectation was weakened to hide that refusal.
This does not replace the full signed-thinking serving differential.

Hashes match before/after **handler** restart and change after a domain delta,
while the policy revision stays unchanged on the compartment edit. That is an
executed witness that policy revision 70 alone is not a complete render key.
It is not a module-process cold-checkpoint recovery proof: no checkpoint exists yet.
Raw small/large/signed snapshot observations are preserved in
`provider-resident-snapshot-proofs.json` (18 snapshots, including the initial plain
small validation run).

## Mutation evidence

`provider-resident-mutation-controls.json` records four isolated controls. Each was
staged from live source, showed a non-empty working diff, ran the whole relevant
narrow suite, failed exactly the named test while the other tests passed, and was
restored with `git checkout -- <path> && touch <path>` followed by an empty diff.
Each temporary deliberately broken source change was marked `NON-VACUITY BREAK`
so it could not be mistaken for the implementation being delivered. No injected
break remains in source.

| Control | Exact test that failed | Unaffected |
| --- | --- | --- |
| Neutralize retained-capacity guard | `providers::resident::tests::resident_retained_capacity_cap_refuses_instead_of_truncating` | Other three resident tests |
| Omit full compartment source from key | `providers::resident::tests::resident_fragment_keys_cover_source_and_render_inputs` | Other three resident tests |
| Remove native-tail coverage lower bound | `provider_resident_read::tests::resident_authority_covered_history_is_not_materialized` | Read-only transaction and native-limit tests |
| Pack queued=false instead of true | `providers::resident::tests::resident_snapshot_preserves_every_effective_part_fact` | Other three resident tests |

The four mutation controls defend the offline builder/capture; they do not test
operation of an unimplemented cache in the provider serving route.

## Inventory and concrete schema proposal

- `provider-resident-reader-writer-inventory.md` closes the literal policy/API
  reader searches, names the confirmed **raw agent-move exporter**, proves the
  limited dashboard/doctor store projections do not read measurements, and lists
  store/host/plugin/dashboard/domain/reset/import/direct-SQL publication families.
  It explicitly distinguishes a table/publication-family inventory from a semantic
  audit of every maintenance SQL statement. The remaining generated table/column
  registry and maintenance-script audit are readiness gates, not falsely claimed
  completed negative searches.
- `../designs/provider-checkpoint-journal-schema.md` gives concrete keys/columns,
  authoritative Ship versus derived Discard classification, store/context journal
  separation, generations, page checksums and bounded active recovery. Generic
  export/import must resolve effective rows or ship/rebind authoritative overlays.
- Ordinary all-tier decay is in the target population. **BPE fragment counts are
  not automatically additive**; the proposal requires exact separator/join-boundary
  correction proofs against whole-string tokenization before prefix sums choose
  tiers. This is a remaining algorithm proof, not an assumed renderer optimization.

## Verification and limits

Linux 4 vCPUs, Rust/Cargo 1.99.0, Bun 1.4.2; local rustfmt only for file formatting,
all Cargo/build/test execution on Linux. Verification after restoring source:

- `CARGO_PROFILE_TEST_OPT_LEVEL=3 cargo test -p mc-module --lib providers::resident:: -- --nocapture`: 4 tests passed.
- `CARGO_PROFILE_TEST_OPT_LEVEL=3 cargo test -p mc-store --lib resident_authority_ -- --nocapture`: 3 tests passed; 17k/500 BLOB-bound witness included.
- `bun packages/e2e-tests/scripts/provider-resident-snapshot-differential.ts` and
  `... --large`: six snapshots each final population passed; raw field/native
  parity and no counters/view-eligibility writes.
- `bun packages/e2e-tests/scripts/pure-replay-differential.ts --provider-pipeline`:
  rerun after driver changes, 90 checks passed with no failures.
- `cargo clippy -p mc-module -p mc-store --lib --tests -- -D warnings`:
  package-scoped lint passed after replacing a new literal-bool assert with the
  equivalent `assert!`; no baseline code was changed.
- `cargo check -p mc-module --lib`: normal non-test build passed.
- `cargo fmt --all -- --check`: passed with rustfmt 1.10.0 after fixing new export ordering.
- `bun test packages/e2e-tests/scripts/provider-post-rebuild-profile.test.ts`:
  2 tests / 25 assertions passed.
- Scoped TypeScript 5.9.3 check includes the new script and reports only the two
  documented inherited diagnostics in rust-harness.ts:805 and command-handler.ts:223;
  no changed-file error. No manifest/lockfile/install changes.

The scoped Cargo job was temporarily inaccessible during the fleet AFT format-17
reader-floor incident. Work was held as instructed, with no AFT file/storage
changes. After the parent released the hold, the original task result was retrieved
(three initial resident tests passed), then work and final gates resumed.

The 100-sample before profile/gap table remains the authoritative performance
baseline. Production performance is unchanged and above target. Serving 720+48
randomized parity, signed-thinking, cold-process restart, joined-BPE, full-tier
assembly and reader-routing mutations remain mandatory for the future consumer,
not claims of this read-only increment. The next action is review of (a)–(c) before
any migration or serving consumption.
