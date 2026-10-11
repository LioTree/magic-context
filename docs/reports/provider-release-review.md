# Independent correctness review: provider-only ck-mc

## Decision and scope

**Do not place this candidate yet.** The existing full-request host lanes passed the synthetic differential and regression gates below, and the context95/private65 storage boundary held. However, the new provider surface does **not** enforce the required `runner` route bind. A real executable reproduction admitted OpenCode-, Claude Code-, and Broca-bound routes into the same provider conversation. The existing 18-case conformance suite passes despite that defect.

Reviewed candidate: **`da10df31389af154f3fe3dbd4b39880a41ff9329`** (`train/provider-release`). Comparison master: **`0f8f341c8c4b27df6bf9678e022250ef3a9b8ac4`**, not the subsequently advanced local `master` ref. Migration comparison: **`origin/train/agent-move` at `cc8617ece9f2fa51c8fb34eb542b570e7400877c`**. The candidate delta is 37 files, +7,742/-64.

This is a report-only independent review, not a production placement, release-artifact build, live Broca canary, or certification of all recorded production traffic. `provider-release-gate.md` and `broca-compaction-fast-path.md` were read first; their previous results were not counted as my runs. Temporary tests, crash instrumentation and mutants were restored before delivery. No product changes are included. ARCHITECTURE.md and STRUCTURE.md were not edited.

## Findings by severity

### High — provider admission does not require a runner-bound route

**Location:** `crates/mc-module/src/providers/mod.rs:98-127`; `providers/records.rs:12-28`; `providers/compaction.rs:251-252,389`; `providers/step_transform.rs:49-51` (all under `crates/mc-module/src/`).

`handle_provider_value` only requires a binding to exist. It does not compare `binding.harness` with `RUNNER_BIND_HARNESS`. `transform.declare` returns immediately after that check; setup, step and hook proceed to keys built from the **bound project plus body session/harness**. `Key::new` validates nonempty strings but does not enforce the route harness. The runner-specific tool join in `lib.rs` does not protect these management methods.

**Failing executable test:** temporary `compatibility::review_runner_admission_requires_runner_bind`, added to the existing Linux conformance target and run against the unmodified candidate executable:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review_runner_admission_requires_runner_bind() {
    let rig = Rig::start(None, false).await;
    let mut admitted = Vec::new();
    for harness in ["opencode", "claude-code", "broca"] {
        let identity = subc_protocol::BindIdentity::new(
            rig.dir.path().join("project"), harness, "route-admission");
        let response = rig.try_call(&identity, json!({
            "method":"compaction.setup", "params":setup("route-admission")
        })).await;
        if response.as_ref().is_ok_and(|answer| answer["answer"] == "ready") {
            admitted.push(harness);
        }
    }
    assert!(admitted.is_empty(), "non-runner binds admitted provider setup: {admitted:?}");
}
```

Command: `cargo test --locked -p mc-module --test broca_conformance --features drive-fault review_ -- --test-threads=1 --nocapture` (Linux8c; isolated environment as below). Relevant captured failure:

```text
review bind=opencode: Ok(... "answer":"ready", ... "version":2 ...)
review bind=claude-code: Ok(... "answer":"ready", ... "version":3 ...)
review bind=broca: Ok(... "answer":"ready", ... "version":4 ...)
non-runner binds admitted provider setup: ["opencode", "claude-code", "broca"]
```

All three answers used the **same compaction ID**. The body supplied `harness: "broca"`, as the normal setup helper does. The route harness was deliberately different. This is a reachable state-changing admission failure, not an inference from a parser: the executable returned ready answers and allocated versions. Because the conversation namespace excludes the route harness, differently bound callers under the same project can address the same provider record. This does not demonstrate that ordinary legacy host requests spontaneously change, nor does it claim cross-project access; it violates the explicit runner-only surface boundary.

**Required closure:** fence the four new management methods on the verified route bind before decoding/allocating state, and add negative executable cases for non-runner binds, including a body that claims `runner` or `broca`. Retain separate body harness coordinates for legitimate runner calls. This review intentionally does not implement that fix.

### Medium — the release gate is not a complete fault-cut/non-vacuity matrix

The executable suite has one selected crash marker: `compaction::kill_mid_request_retry_skips_reserved_version_preserves_cursor_and_fences_stale` uses **AnswerRecorded** (`tests/broca_conformance/compaction.rs:467-588`). Source also contains **SetupRecorded**, **MessagesIngested**, **WaitAnswered**, **WaitWorkDurable**, and **HookStateRecorded** (`src/providers/compaction.rs:309,405,429,461`; `src/providers/step_transform.rs:211`). No executable selection of those five cuts was found in the conformance target. Fresh-handler unit tests exercise persisted outcomes, but are not process deaths at all those cuts.

The runner-join test's negative `broca` bind concerns **tools**, not admission to `compaction.setup`. Thus a green suite did not defend the high-severity invariant above. I ran three independent production-code mutants, each caught by its named test, but **do not claim that every conformance clause and every fault cut has an independently demonstrated mutant**. The requested universal non-vacuity claim remains a release-evidence gap, not proof of five additional product bugs. Add and retain the missing route-admission regression test and deterministic process-death/recovery cases before describing the matrix as complete.

### Low — strict clippy with drive-fault fails on the current toolchain

Default-feature strict workspace clippy passed. The additional command `cargo clippy --locked --workspace --all-targets --features drive-fault -- -D warnings` exits **101** on rustc/Clippy1.99: deprecated `AtomicUsize::fetch_update` in `crates/mc-module/src/lib.rs:15905,23134,23147,23167,23181,23206`. These are inherited fault-helper calls, not a provider runtime regression. Fault-enabled tests compile with warnings and pass. The distinction matters: do not advertise fault-enabled strict clippy as green. No unrelated warning cleanup was made.

## 1. Existing Rust-mode behavior: hunk-by-hunk impact

The unchanged-host statement is valid for the **ordinary full-request data lane**, not for every control-plane response under every storage failure. The following covers every changed hunk in the five named files; line numbers refer to the candidate. T = response/tool bytes, P = cached prefix, N = tag numbering, D = drops, C = context.db writes.

| File / changed hunk | Existing OpenCode / Claude Code consequence |
| --- | --- |
| `transform.rs:2492` permission removes `|| status.prefix_rebuilding` | Only the existing append-only **compaction adapter** uses this change. It can suppress a runner replacement when the engine did not permit a prefix bust. Ordinary full-request transform does not call this adapter, so no direct T/P/N/D/C change for legacy requests. |
| `transform.rs:2507-2515` allocate current candidate instead of rejected last-produced view | Runner adapter T/P/D can change after independent history/model rebuild: it must return the engine's newest bytes rather than resurrect stale history or consumed drops. No legacy host serializer/transform implementation was replaced. The new regression is mutation-defended below. |
| `transform.rs:17735-17809` added regression | Test-only; no runtime impact. |
| `lib.rs:70,3871-3876,4469-4484,4516-4518,4888-4925` provider module/fields/construction | Adds storage wrapper over the **same** OnceLock/store handle, a provider mutex and a distinct callback client. Existing resolver and producer route configuration are retained. No extra store opener/epoch claimant; no direct T/P/N/D/C change. |
| `lib.rs:689-691,709-710,4609-4622,19267` startup test barrier and test registration | `cfg(test)` only; no runtime change. |
| `lib.rs:12789,12808-12867` async tool.catalog plus durable catalog save | Healthy catalog bytes still come from the unchanged encoder and are returned unchanged. Adds private65 catalog persistence, waiting for startup and failure bookkeeping for **all bound harnesses**. Can change latency and private-store failure behavior; does not rewrite host prefix, tags or drops. `store_for_request` may complete the existing attach/startup pending-context recovery; the schema/write implementation is unchanged. |
| `lib.rs:12791,14466` role.describe | **Control response bytes change intentionally**: adds compaction/step-transform roles and runner callback requirements to the existing tool-provider description. This is not a model-facing tool-catalog schema change. |
| `lib.rs:12908-12921` durable catalog fallback for tool admission | Guarded by route harness `runner`; ordinary OpenCode/Claude Code retain their frozen in-memory catalog path. T/P/N/D/C unchanged for legacy tool admission. |
| `lib.rs:13037-13041` runner conversation-key selection | Guarded by `runner`. Existing OpenCode session key / Claude resolver branch remains. New runner keys are isolated `mc-provider:` hashes; no legacy tag/drop namespace reassignment. |
| `lib.rs:13116-13121` runner ctx_reduce dispatch | Guarded by `runner`; legacy reduction path unchanged. Runner pending drops use the new provider lane. |
| `lib.rs:14431-14450` provider catalog refusal and ahead-of-binary catalog exception | Provider failure propagation affects only new methods. **Existing catalog error behavior can change** on store-ahead: composition discovery now returns config bytes where master refused. Other stateful legacy requests still refuse. This is an explicit compatibility exception, not byte-identical failure behavior. |
| `lib.rs:14467-14476` provider management-method dispatch | Adds previously unsupported methods. The missing runner admission check is the high-severity finding. These methods may invoke the shared context domain, but ordinary host `transform`, `ctx_reduce`, memory and historian methods retain their old dispatch. |
| `lib.rs:19172-19183` manifest capabilities | HELLO/manifest bytes change from absent capabilities to advertised provider majors, with **no required capabilities**. No Broca startup dependency; local no-Broca test passed. No model prompt/tool bytes change. |
| `session_resolver.rs:21-119` ProviderRunner implementation | New callbacks bind `runner` to the configured **ProviderRunner** target. Existing SessionResolver implementation/deadline is untouched. No legacy T/P/N/D/C change unless the newly admitted provider methods are called. |
| `route_targets.rs:198-207` test-only tool-route constructor | Test-only. Production route registry/configuration is unchanged. |
| `route_targets.rs:498-699` test root/env/manifest expectation/lsof changes | Test-only isolation and capability assertion; no product byte change. |
| `context_writes.rs:543-547` startup pending-publication enumeration excludes mc_move_fences | With empty move-fence tables, same pending sessions/order and same C behavior. With a persisted fence, startup deliberately leaves that session's pending write for the move coordinator rather than writing it. That can change future prefix/history publication for such a session; this provider release contains no move activation that creates those fences. Do not claim unconditional equivalence on a database already containing active move fences. |

Related storage changes were also inspected: v64 temporary writer guards can refuse writes to fenced sessions and root pruning now retains move-owned sessions; v65 adds provider records/catalog ownership. On an ordinary v63 upgrade those new tables are empty. `host_store.rs`, `single_store_reads.rs`, `single_store_schema.rs`, context migration/storage TypeScript, `tool_catalog.rs`, `ck_wire.rs`, legacy codecs, and `mc-core/src/lib.rs` are byte-unchanged against the pinned master (`git diff --exit-code` comparisons).

### Executable differential, not fixture-self-comparison

Master source was exported with `git archive 0f8f341c...` **inside this worktree**, then built separately with `cargo build --locked --manifest-path .review-scratch/master/Cargo.toml -p mc-module --bin ck-mc --target-dir .review-scratch/master-target`. The candidate was the conformance target's `CARGO_BIN_EXE_ck-mc`. The target directories were distinct. `MC_PROVIDER_BASELINE_CK_MC` selected the master executable; the old-binary refusal test additionally verified its max63 identity.

The existing `compatibility::legacy_opencode_and_claude_ck_bytes_match_master` test passed on the signed-reasoning/tool/media golden corpus, including candidate replay. That test compares actual serialized `ck_messages`, not whole response metadata. I added and removed two broader independent probes:

- `compatibility::review_legacy_host_lifecycle_differential`: both host binds/profiles, synthetic a/b/c/d messages; bootstrap, defer, publish a real compartment through fenced HostStore transactions, high-usage execute, render-config HARD fold, module restart, shared-history deletion plus shorter input/revert, revert replay. Writers were stopped before external fixture edits. **Raw response bytes matched after excising only the top-level `timings` object's byte span (including its separating comma).** The excision scanner respected quoted/escaped text and nested braces; it did not parse and reserialize the remaining bytes. A second assertion compared parsed full responses as well. No action/version/prefix/coverage/historian metadata was masked. Revert here exercises the conservative PASSTHROUGH path, not every possible recut; the context95 publication regression separately exercises actual truncate/reconnect recovery.
- `compatibility::review_legacy_tag_and_drop_differential`: four real read-call/result arcs with large distinct output, both profiles; compare allocated `(tag_number, block_id, kind, source_bytes)` rows, enqueue the first result's flat ID in the private pending queue, defer, priced HARD release, replay. Four tags were asserted present on each side, and the oldest output marker and its pending row were asserted absent after release. Canonical serialized whole responses, excluding only timings, matched (this probe parsed JSON before comparison, unlike the raw-byte lifecycle rerun). This is an engine/host-pass differential; it does not pretend to run Thalamus's external tool transport.

| Synthetic lifecycle pass | Action | Equal response byte count after timing removal, each host |
| --- | --- | ---: |
| bootstrap | HARD | 1,438 |
| defer | SOFT+ | 1,375 |
| execute first history | HARD | 1,400 |
| render-config fold | HARD | 1,296 |
| restart | SOFT+ | 1,237 |
| revert | PASSTHROUGH | 757 |
| revert replay | PASSTHROUGH | 624 |
| tool bootstrap | HARD | 176,430 |
| queued-drop defer | SOFT+ | 176,366 |
| priced drop | HARD | 133,072 |
| drop replay | SOFT+ | 132,862 |

That is **14 additional raw whole-response comparisons and 8 canonical whole-response comparisons**, plus the committed golden tests. The 14 lifecycle cases also had a redundant parsed-response assertion; it is not counted again in either total. Their successful temporary test commands used `--test broca_conformance --features drive-fault compatibility::<exact name> -- --exact --nocapture` with the separate baseline binary. The lifecycle probe also byte-compared raw catalogs for head/worker/reader through both actual host binds.

### Tool catalog and shared Broca bytes

`compatibility::master_catalog_tool_bytes_match_candidate` independently compared **raw tool.catalog response bytes** for all three presets; passed. The additional lifecycle probe repeated all three presets with actual `opencode` and `claude-code` binds; all six raw comparisons passed. This includes schemas and descriptions, not just tool names. `tool_catalog.rs:51-56,650-665` still pins the v1 ctx_reduce structural digest; `tests/tool_catalog.rs:488-502` and `tests/broca_contract.rs:147` retain the gateway-facing shape checks. No ctx_reduce schema/gateway-authorizer change is hidden in the role addition.

`docs/designs/mc-tool-catalog-v1/broca-session-read-messages.json` is **new relative to master**, so there is no master fixture to claim byte-equal to it. It is byte-identical to `origin/train/agent-move` (`git diff --exit-code`, one file). Its three records include signed assistant reasoning and a real tool call/result. `providers::tests::broca_real_messages_round_trip_byte_exactly` passed in the module suite. The joint fixture's real encoder comparison and executable replay both passed. These are fixture/wire compatibility results, not verification of Broca's live implementation or Anthropic acceptance of every possible signed-prefix mutation.

## 2. Context.db safety at schema95

**No context schema extraction was detected.** The actual storage initializer/migrator, schema fixture/fingerprints and memory writers are unchanged against the pinned master; bundled private-store migration head is65, not a context migration. The reported context ceiling remains95. The fingerprint fence remains per-table/companion schema checking, not a global requirement that existing writers advance to a new ledger stamp (`host_store.rs:58-68,307-359,627-660`).

I reran the gate's actual database reproduction, not only its numeric assertion. Each Rig launched Bun to execute `initializeDatabase` and `runMigrations` from the unchanged TypeScript code against a new isolated database; no Rust schema clone was substituted. `harness.rs:178-217` snapshots all context sqlite_master objects and the **entire ledger including descriptions/timestamps**, then `assert_context_95` and Rig drop compare them after startup, calls and restart. Those source files are identical to the master export, making this a fresh master-generated v95 database. The schema95/populated63 restart test and all18 executable cases passed. Consequently no v96-v100 tables, columns, indexes or triggers appeared behind a fake unchanged ceiling during these runs.

`compatibility::existing_writers_pending_publication_and_revert_recover_on_context95` passed: actual ctx_memory publication, fenced historian summary/fact writes, a context-side failure after private publication became durable, restart replay exactly once, pending-row removal, truncate/revert epoch increment, and boundary/reconnect recovery. Store/context-boundary regression suites also passed. The new startup fence filter changes recovery only for fenced sessions, as described in the hunk table; this release has no move coordinator activation.

This is synthetic populated-data compatibility, **not** inspection of a live or privately copied production context.db. It does not make the excluded migration-train context fingerprints safe at95.

## 3. Private store64/65 and rollback

### Layout provenance and forward compatibility

- v64 SQL was extracted independently from the `SCHEMA_SQL` string at the pinned migration ref and compared with `store_064_move.sql`, removing only the leading newline framing the Rust raw string. **Exact equality passed**: SHA256 `479d3bcc7ea1956130cffa0753cf2008a0732a014e7c85e7877963a2fad2d5f2`. It contains cortexkit_fence plus the five move tables, with the same columns, defaults, CHECKs, primary/unique keys.
- v65 SQL is exactly the migration ref's blob (`git diff --exit-code origin/train/agent-move -- crates/mc-store/src/migrations/store_065_provider_records.sql`, passed). Provider session/catalog tables keep the original project/session/harness and project/session keys and opaque JSON columns.
- Temporary `compatibility::review_real_provider65_accepts_unchanged_later_migrations` **passed**. It created setup/hook state through the actual candidate executable, stopped the module, registered the migration branch's exact `mc_provider_engine_namespace` function, and applied exported **unchanged v66 SQL, v67 SELECT1 and v68 SQL** to that real65 store. It checked namespace, version high-water, hook counters, normalized view and hook-answer rows. The future namespace function serializes a struct in project/session/harness order, matching the candidate Key, rather than hashing an arbitrarily reordered JSON object. This is a real-record SQL upgrade smoke test, not a full build/run of the later migration-train binary or all normalized-record shape cases.

The populated63 upgrade/reopen test passed in mc-store (`provider_records::tests::provider_migration_upgrades_a_populated_previous_store_and_survives_reopen`). The real-executable schema test also retained sentinel tag11, source/cache/version rows and pending drop `m0#0`. Fresh layout and atomic record/tag/catalog rollback tests passed.

### Actual mid-migration process deaths

I did not equate a post-answer crash with a schema migration crash. Temporary test-only instrumentation registered a SQLite scalar callback on the **real McStore migrator connection**; the original SQL gained a callback invocation after partial v64 DDL, or between the two v65 provider-table creates. At the callback, the child flushed a stdout marker and parked. The parent blocked on that marker, inspected its open files with lsof, killed it, inspected the database and reopened with the normal migrator. No fake migrator or sleep-timed kill was used.

`provider_records::review::review_real_migration_crash_rolls_back_partial_ddl_and_reopens` passed with `cargo test --locked -p mc-store --lib --features test-support <exact-name> -- --exact --nocapture`:

```text
review migration64: cut reached, killed with4 isolated DB handles,
  rolled back to63, reopen=65, legacy tag/drop preserved
review migration65: cut reached, killed with4 isolated DB handles,
  rolled back to64, reopen=65, legacy tag/drop preserved
```

The63 state contained no partial move/provider tables. The64 state contained the full five move tables but neither partially created provider table. The library commits migrations individually: a crash in65 preserves committed64 and rolls back65, including its ledger entry. Both normal reopens reached65 and retained sentinel tag/drop data. SQL instrumentation and callback/test code were restored afterward; migration identities in the delivery are unchanged.

### Refusal and rollback

`compatibility::master_binary_refuses_provider65_without_modifying_either_schema` passed using the independently built max63 executable. It checks a logical snapshot of **all** private-store rows/schema/ledger, not just a version integer. Context schema/ledger remained95. On Mac, the native store-ahead test also passed at candidate max65 versus fixture66; an extra temporary lsof readback found0 open DB handles in the refused module and daemon after health had reported terminal refusal. Zero is expected there because the refused store handle is closed; it is not offered as proof that a healthy startup opens its required files.

**Rollback requires the paired pre-upgrade store.db/context.db backup and stopped writers, together with the prior binary.** Simply swapping back max63 ck-mc cannot open65. Do not delete ledger stamps, drop provider tables, or label a binary-only swap as rollback. Dashboard/doctor readers are separate consumers of the private layout and must not be mistaken for schema owners. No live preflight, backup, drain, swap or cleanup was attempted here.

## 4. Runner surface, restart state and controls

Setup's host-only plan settings (`observation`, `serializer_profile`) are rejected before work (`providers/compaction.rs:243-250`); the executable negative/positive case passed. The compaction adapter sets `owned-broca`, disables native serving, engine-side tag minting, auto-search and todo tools (`transform.rs:2473-2485`). The callback uses the configured provider-runner route, independently of the host producer target. Thus **once admitted**, these plans do not enter the host observation/serializer lane. That is separate from the missing bind admission fence.

The provider record stores setup and last answers, version high-water, hook high-water/live/burned tags, transcript cursors and pending drops. Synchronous step reserves a high-water value before engine work and saves its answer before the crash marker. Wait work reserves before execution, saves state before ready callback. Store persistence places record and observed engine tags in one fenced transaction. Fresh-handler/tag/cursor/version tests passed, and the real kill test observed the durable unsent answer before death, retried above its version, reproduced replacement bytes, and rejected stale/superseded answers without changing served prompts. These results support the tested restart boundaries; they are not universal exactly-once delivery claims.

### Three independently rerun production-code mutants

For each control I staged the original specific source, confirmed an empty working diff, applied a labelled break, captured the nonempty diff, ran the named check, then restored using `git checkout -- <path> && touch <path>` and captured an empty diff. No mutant or temporary test is in the delivered tree.

| Control | Exact test that reddened | Other tests in that run | Applied / restored working diff |
| --- | --- | --- | --- |
| Leave assistant text tag stamps unchanged instead of stripping them | `hooks::post_assistant_strips_only_addressed_text_preserves_signed_and_nontext_bytes` | `hooks::pre_user_post_tool_append_only_new_content_and_disallowed_answer_is_unavailable` **passed**; all other cases filtered | `src/providers/step_transform.rs`: 1file,+2/-1 / empty |
| On nonstructural rejection allocate last-produced view instead of current candidate | `transform::tests::compaction_adapter_tests::lost_broca_view_cannot_hide_independent_model_rebuild` | Exact test only;1failed,1747filtered | `src/transform.rs`: 1file,+2/-0 / empty |
| Skip the final step record save before AnswerRecorded | `compaction::kill_mid_request_retry_skips_reserved_version_preserves_cursor_and_fences_stale` | Exact test only;1failed,17filtered | `src/providers/compaction.rs`: 1file,+1/-1 / empty |

Captured failures, respectively: `left: answer=pass, right: answer=ops(replace visible answer)`; `current_bytes.contains("NEWEST-HISTORY")` false; persisted answer `ready` instead of `compaction_message`. These are failures of the intended behavior, not compilation failures or accidental startup errors. The first attempted exact adapter name omitted `_tests` and selected0 tests; it was explicitly rejected as evidence and rerun with the real name. An initially overbroad stale-view mutant failed earlier in the same test; the final narrowed mutant above reaches the newest-history assertion.

Restored checks: adapter12/12; full conformance18/18; store248/248 and core22/22; default strict clippy and fmt. The high-severity admission reproduction is a genuine unmodified-candidate failure, not one of these mutation failures.

## 5. Dependencies and wire versions

The resolved role pin is internally consistent: compaction-provider0.1.2, step-transform-provider0.1.2, llm-runner0.2.0, llm-runner-conformance0.2.0 and its Git harness all resolve to commons **`90d5c5567ad7ec8dcc8d26252b1a759fdd49bb75`** (`mc-module/Cargo.toml:45-48,95-98`; Cargo.lock). Stable tool-provider and tool conformance remain registry0.5.0, the documented approved exception, not an accidental partial update. The older cache-core pin is a separate package and does not supply the new role contract.

Runtime verification used both normal-edge reverse trees:

```text
cargo tree --locked -p mc-module --edges normal --invert subc-protocol@0.29.1
  subc-protocol0.29.1 <- tool-provider0.5.0, mc-module,
                         subc-client-rs0.26.1, control/transport
cargo tree --locked -p mc-module --edges normal --invert subc-protocol@0.30.2
  warning: nothing to print
```

The second version is reached through **dev-only llm-runner-conformance**, not through the new role crates' production serde/JSON data types. No runtime0.30.2 protocol frames are linked into the normal ck-mc path. SDK, transport/control and module wire types remain0.29.1; embedded daemon remains registry0.31.2. This does not certify an independently installed Broca/daemon version or upgrade the stable tool bind-mode contract. The amended optional CompactionMessage coverage is explicitly omitted; the provider does not fabricate a host trim marker.

## Verification ledger and isolation

All remote Rust build/check/test/lint lines ran on **Linux8c**, one heavy job at a time, foreground/waited. Tool versions: cargo1.99.0 (`5f94df478`), rustc1.99.0 (`b940084d7`), rustfmt1.10.0-stable, Clippy0.1.99; Bun1.4.2. Mac uses the same cargo/rustc and `nice -n10`, with4 build jobs; nested daemon compilation uses2. Git2.54.0 and Python3.9.6 were used for source/SQL identity checks.

| Command / check | Independently observed result |
| --- | --- |
| `cargo test --locked -p mc-store -p mc-core --lib` | **248store +22core passed**,3store private-clone/performance cases ignored; rerun after crash instrumentation restore |
| `cargo test --locked -p mc-module --lib --features drive-fault` | **1726passed,22ignored**; full provider/engine/legacy suite |
| `cargo check --locked -p mc-store -p mc-module --all-targets` | Passed, two requested crates and their target graphs |
| `cargo test --locked -p mc-module --test broca_conformance --features drive-fault -- --include-ignored --test-threads=2 --nocapture`, with separate baseline | **18passed,0ignored**, final full run15.05s; startup lsof10 isolated handles per healthy module |
| `cargo test --locked -p mc-module --lib --features drive-fault compaction_adapter_tests` | **12passed**, after restoring the current-view mutant |
| `cargo test --locked -p mc-module --features drive-fault --test boundary_counter_durability --test cold_flip_adversarial --test fleet_logging --test launch_nonce_source_scan --test protection_window_golden --test scope_stamp_decode --test serde_json_feature_fidelity --test tag_cache_allocation --test temporal_mode_switch` | **1+5+1+2+1+2+1+1+1 =15passed** across nine targets |
| `nice -n10 cargo test --locked -j4 -p mc-module --test real_daemon -- --test-threads=1 --nocapture` | Mac: **5passed,2ignored**; actual module DB lsof8-11 isolated handles |
| `nice -n10 cargo test --locked -j4 -p mc-module --lib route_targets::tests::a_host_runner_starts_and_serves_without_broca_through_real_subc -- --exact --ignored --nocapture` | Mac: **1passed**; lsof checked both module and daemon; no live Broca/daemon used |
| `nice -n10 cargo test --locked -j4 -p mc-module --test real_daemon_store_ahead -- --nocapture` | Mac: **1passed**, plus isolated refusal lsof instrumentation rerun |
| Temporary independent lifecycle, tag/drop, migration-crash and later-SQL tests named above | **4test functions passed**; admission test **failed as described**, then all temporary probes removed |
| `cargo fmt --check` | Passed (silent-on-success gate; version above) |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | Passed, all four workspace crates/default-feature targets |
| Strict clippy with `--features drive-fault` | Failed only on six inherited deprecated atomic calls; not waived as green |
| Exact v64 SQL, v65 Git blob and shared Broca fixture comparisons | **3identity checks passed** |

The first full module run had1725passed/1failed because I set `MAGIC_CONTEXT_STORAGE_DIR` to a throwaway directory named `storage`: the pre-existing path-shape test requires its parent name to be `magic-context`. Correcting **only the isolated environment path** yielded1726/1726; no product/test assertion was edited to hide that failure. Two early temporary-probe errors were similarly discarded: sharing a private-store writer invalidated a module's writer epoch, and opening the master fixture with candidate McStore advanced it to65. Final differential probes instead edit only shared context through HostStore with writers stopped and never open the max63 private store through the candidate API. These setup errors are not candidate findings.

Linux roots were `/tmp/magic-context/provider-release-review/{data,config,state,runtime,tmp}`; Mac roots were `$TMPDIR/magic-context/provider-release-review-local/...`. Every process received throwaway XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_RUNTIME_DIR, OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR; rig subprocesses also override HOME. TMPDIR was pointed underneath the task root so generic tempfile allocation remained there. lsof checks observed required context/store/WAL/SHM handles below the owning roots. The migration child additionally proved4 isolated private DB handles at each cut. Native refusal instrumentation checked both processes after terminal refusal. Live-store/config paths named in the brief were never opened/read/written/migrated; no live daemon/module was touched.

For local sibling-dependent gates, a **task-owned source clone inside this worktree** provided Cargo.lock's exact subconscious revision `1a14993c120725fa1dce7267b6e7d0823835930c`; the harness exported and built that committed tree. It did not use or read the operator's sibling checkout. Prebuilt daemon/CLI paths for the refusal gate pointed at those task-owned outputs. No package manifests or lockfiles changed. Build outputs/source scratch and throwaway roots were removed after verification; evidence retained here is not under target/dist/cache.

**Explicitly not run/claimed:** private real-store-copy migration (no snapshot supplied, no live reads permitted), private planning/sync captures, actual Broca implementation/canary, all fault-cut mutations, production traffic corpus, release-mode signing/size/performance/placement. This report's negative admission finding must be closed before using otherwise green compatibility results as placement authorization.

Report-prose review clarified the timing-removal/count wording and the distinction between a temporary executed admission reproduction and a missing permanent regression. AFT inspection of this Markdown file was partial because no Markdown LSP producer/checkout call-graph view was available; it is not presented as a clean diagnostic gate. `git diff --check` and report-only staged-scope checks passed. Local cleanup removed3.5GiB of build output,121MiB of task source scratch and386MiB of throwaway fixtures/binary copies.
