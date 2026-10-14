# Resident stage-two independent review probes

These report-only probes compare candidate commit `968d09bcae1bbf8b77485239b049e72fd8b3850f` with baseline commit `8971c894be071854e250340ff5926a009618f001`. They do not change product sources. Rust snippets are included in temporary build overlays so they can exercise private store/handler test helpers. All database fixtures live under the operating system's temporary directory.

## Run

Create `review-tests/base.tar.gz` from the baseline commit using the following local command in this worktree; do not commit the archive:

```sh
git archive 8971c894be071854e250340ff5926a009618f001 | gzip > review-tests/base.tar.gz
```

Run the following gates on Linux with eight vCPUs. Dependencies come from the repository's installed lockfile dependencies; no live stores or daemons are required.

```sh
bun run --cwd packages/plugin tsc --noEmit -p ../../review-tests/tsconfig.json
bun review-tests/resident-stage2.ts
bun review-tests/rust-stage2.ts
```

`resident-stage2.ts` builds separate baseline and candidate executables and imports each revision's TypeScript sources independently. It compares JSON strings at the native-message serving boundary, plus paired raw Rust hook/fold responses on identical forked stores. It checks append, publication/deletion, restart, model switch, queued drops, memory updates, and fifty policy-only resident clones. The old executable is also run against a migrated database and an isolated compact-tail copy whose migration ledger is deliberately reduced so the older reader can reach and reject the relocated `tail_hygiene_baseline` field, independently of the database-version refusal.

The baseline generated test driver receives missing `SessionBinding` field initializers and a raw-response capture wrapper. Neither adjustment changes production code. Separate Cargo target directories prevent one revision from reusing the other revision's crate artifacts. The baseline and candidate driver processes disable the optional test-only check comparing summary replay with full policy recomputation; the independent differential assertions remain enabled. Durable-counter comparisons omit historian task bookkeeping and the baseline wall-clock timestamp; served-message and raw hook/fold comparisons omit no bytes.

`rust-stage2.ts mc-store` runs migration step/reset/idempotency checks, a partial-migration failure through the actual migration runner, process kills after applying the same migration SQL prefix in an open transaction, compact-prefix round trips, and native-fact agent-move reconstruction. The process-kill helper is ignored in ordinary runs and invoked explicitly by `review_migration_midway_process_kill_restores_rows_and_schema`. `rust-stage2.ts mc-module` runs an independent external-policy-update oracle and a fifty-slot/32-in-flight reservation, eviction, and authoritative-rebuild control.

The agent-move round-trip is expected to fail at the reviewed tip with `key_collision` on `mc_provider_policy_revisions_v1`. It is intentionally not converted into an assertion accepting that refusal: successful native-fact reconstruction remains the property under review. The detailed report and mutation evidence are kept in `.cortexkit/internal-docs/investigations/reports/resident-stage2-review.md`, which is intentionally not committed.
