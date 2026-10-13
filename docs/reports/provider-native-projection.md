# OpenCode provider-native projection

## Boundary and retained fields

The implementation is `packages/plugin/src/hooks/magic-context/host-runner/`,
not a new `src/host-runner/` directory. `src/host-runner.ts` is its export facade.

`opencode-adapter.ts:192-237` projects at `providerIncoming.read()`, before
`record.ts:410-433` serializes an admission. That one immutable native JSON
supplies bootstrap and continuation pages, ordinary hooks, Status resends after
a history gap, host persistence, and subsequent replacement views. Known rows
are not read again. The v2 restart data also contained an original native tool
in `info.magicContextHostReplay.bridges[].native`; `v2/hooks/payload.ts:460-472`
now projects that nested copy as well.

The model field definition remains the one from issue 653:
`provider-visible-parts.ts:39-105`. `providerNativePart` calls that same
`providerVisiblePart`, not a second model-field list. It then adds one small
policy allowlist (`:116-156`). The original model-only projection used by LKG
snapshots and digests is unchanged.

Tool state retains `status`, `input`, `output`, `error`, `attachments`, `content`,
`time.compacted` (or an empty time object), and, on errors only,
`metadata.interrupted` / `metadata.output`. Provider metadata on the part itself,
reasoning signatures, every non-tool part, and message info remain intact.
Titles, start/end tool times, streamed raw input, LSP diagnostics, diffs and
file snapshots in tool-state metadata are excluded.

### Non-model reader inventory

Only tool **state** is narrowed. Readers of message info, other parts, and
part-level metadata therefore need no new retained fields.

| Reader | Keys or values consumed | Treatment |
|---|---|---|
| Rust OpenCode codec, `crates/mc-module/src/codec/opencode.rs:209-227` | `/state/metadata` answer predicate; emits `opencode.user_answer_block_indices` | Preserve the six structural metadata keys below. |
| Rust predicate, `crates/mc-module/src/user_answer.rs:4-14` | `userAnswer === true`; arrays `answers`, `selectedOptions`; strings `answer`, `customInput`; recursive array `results` | Empty arrays/strings still count. `results` entries are recursively projected so nested diagnostics do not survive. |
| Rust selection construction, `crates/mc-module/src/transform.rs:49228-49249` | Typed `user_answer_block_indices` becomes `SelItem.user_answer` | No additional native-state keys. |
| Rust automatic selectors, `crates/mc-module/src/selection.rs:1612-1649` | Excludes arcs with `user_answer` from automatic reclaim | Manual agent drops remain allowed, as specified by `:2567-2618`. |
| TS predicate, `packages/plugin/src/shared/user-answer.ts:4-17` | Same six keys, from `state.metadata` or part-level `details` | Preserve state markers; `details` is already unchanged. |
| TS v2 adaptation, `packages/plugin/src/v2/hooks/payload.ts:344-350` | Generates `metadata.userAnswer: true` for built-in question results | Preserve this generated mark on native admission. |
| TS host runner, `opencode-adapter.ts:97-108,192-264,268-309` | IDs, role, text, tool name/call ID, state status/input/output/error | All retained; no diagnostic/title/start/end-time policy reads. |
| Rust decode, `codec/opencode.rs:51-79,549-619,656-671` | Message identity/ordinal, info timestamps and provider/model origin; tool input/status/output/error/attachments; part-level `metadata.providerExecuted` | Already retained by the model projection or unchanged outer fields. Tool-state start/end times and titles are not interpreted for provider selection. |
| Rust typed engine/core | CK blocks, provider extras, ordinals and policy summaries | Does not parse tool-state diagnostic/title/raw keys. Native blobs and fingerprints can bind bytes, but do not add another metadata-key policy. |
| TS full-request encoder, `module-wire.ts:1096-1119` | Answer predicate; additionally `state.title` / `metadata.title` as recovery labels | Not the incremental provider ingest path. No new title field is needed for provider selection. |

The policy list is exactly `userAnswer`, `answers`, `answer`, `selectedOptions`,
`customInput`, `results`. Their actual values are retained; arbitrary sibling
metadata is not. This extension was explicitly approved after discovering
that model-only projection would otherwise remove answer protection.

## Provider request identity

OpenCode 1.18.35 converts transformed messages through
`MessageV2.toModelMessagesEffect`. The hash-pinned source copy in
`__fixtures__/opencode-v1.18.35-to-model-messages.txt:213-285` reads the retained
tool fields; `:250-267` shows why interrupted error output must survive.
Upstream source:
<https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/session/message-v2.ts>.

OpenCode 2's commit reads state input/status/output/error/content in
`v2/hooks/payload.ts:555-592,642-682` and `v2/tool-result.ts:19-35`. A retained
native bridge contributes only call identity/name in its reconstruction branch,
not diagnostics, title or tool timing. Its downstream 2.0.24 lowering reads
tool input/content/error and part-level provider state, not display metadata:
<https://github.com/anomalyco/opencode/blob/v2.0.24/packages/core/src/session/runner/to-llm-message.ts#L104-L151>.

`provider-visible-replay.test.ts` now runs the issue-653 corpus through native
admission too: seven OC1 routes/options, all tool states, interrupted output,
attachments, reasoning signatures and other part kinds. It compares encoded
Anthropic HTTP bodies after the OC1 host conversion and AI SDK step, and encoded
OpenAI-compatible HTTP bodies after the OC2 commit and provider lowering.
Both use injected offline responses; no network transport or live host/store
is opened. The OC2 body test ran with the installed 2.0.22 package and also the
exact 2.0.24 package installed in a throwaway build directory. The latter used
113 transient packages; no repository manifest or lockfile changed.

The real-module end-to-end corpus passes 92 cases across both hosts, including
question answers surviving automatic emergency reclaim while ordinary peer
outputs are reclaimed. The Rust differentials pass 720 append passes / 46,980
per-message comparisons / 1,850 checked summary replays, and 48 HARD passes /
113 exact new-message comparisons. Those differentials are complementary to
the HTTP-body checks, not substitutes for host conversion.

## Identity and clean cutover

Host identity is `info.id`; tool subject identity is the existing part ID or
call ID plus position (`opencode-adapter.ts:97-105`). Rust provider decode
requires native `info.id == mid` (`providers/codec_opencode.rs:11-25`), so the
general codec's whole-raw-message hash fallback for idless messages is not used
on this lane. Bootstrap declines idless/nonpersisted rows rather than assigning
them content-hash IDs. Neither row identity nor ordinal assignment changes.

Store keys are conversation/lineage/ordinal, with unique conversation/lineage/
message ID; hook receipts use conversation/answer sequence and views use
conversation/version (`mc-store/src/migrations/store_066_provider_log.sql:38-90`).
Those keys are independent of discarded state fields.

Native bytes **do** participate in the host's source digest
(`host-runner/record.ts:122-125,477-510`) and in exact native replay comparisons.
After this change a new bootstrap hashes/stores projected JSON, not whole-native
JSON. A pre-change development store can retain whole-native digests/views;
this change does not migrate, reinterpret or validate a mixed development store.
The task owner's final ruling was a clean pre-release cutover with **no format
marker, refusal, reset or migration machinery**. Development stores must be
fresh for this change; the first deployed provider lane starts projected.

The placed executable was probed only with `--version`:
`ck-mc 0.1.0 (ce465bba22d950551c62c6e0ed9d4b222e4a962b)`.
That SHA is an ancestor of this base; the host provider adapter was introduced
later at `b604dfe92c`. Provider mode is also off by default, experimental and
user-config-only (`config/schema/magic-context.ts:1141-1152`,
`config/project-security.ts:374-378`). Together with the owner's deployment
statement this supports the pre-release cutover; no live configuration or store
was inspected to infer universal absence of sessions.

## Storage measurement

Run `bun packages/e2e-tests/scripts/provider-native-storage.ts` on Linux.
It uses the existing real `McHandler` driver, fresh temporary stores, 400
alternating user/tool messages, approximately equal model-output and diagnostic
payloads, and 20 answer-policy marks. Both forms fit one page under the 3 MiB
cap. The before run replaces outgoing messages with the original whole-native
values; the after run uses the production adapter. All 400 native rows, 20
answer marks and produced views are checked in SQL; session.read calls remain
zero. Sizes below are the `store.db` file after WAL checkpoint/truncation,
without VACUUM. They include fixed schema, engine state, tags and view overhead.

| Host | Form | Native rows, bytes | Replacement JSON, bytes (2 views) | store.db bytes | Bytes/source message |
|---|---|---:|---:|---:|---:|
| OC1 | Whole native | 2,604,520 | 4,102,835 | 9,379,840 | 23,449.60 |
| OC1 | Model + policy | 1,348,290 | 2,846,605 | 7,061,504 | 17,653.76 |
| OC2 | Whole native | 2,604,520 | 4,102,835 | 9,383,936 | 23,459.84 |
| OC2 | Model + policy | 1,348,290 | 2,846,605 | 7,065,600 | 17,664.00 |

Physical storage falls about **24.7%**, native bytes **48.2%**, and summed
replacement JSON **30.6%**. The retained answer keys do not change the physical
page counts compared with the initial model-only measurement; native bytes
increase by only 620 bytes for this fixture. This is a synthetic scale sample,
not an extrapolation of whole-database savings for the 20k-message investigation.
The referenced investigation document was absent in this isolated worktree;
the parent checkout and live stores were never opened.

## Verification and regenerated expectations

All build/test/type/lint jobs used Linux with 8 vCPUs. Versions: Bun 1.4.2,
TypeScript 5.9.3, Biome 2.5.1, Cargo 1.99.0 (5f94df478 2026-08-27).

- `bun run build:dists`: plugin and Pi builds plus two dist import probes pass;
  the TUI build checks 9 unchanged artifacts. Package typecheck and lint ran
  after dist generation in the same job. `bun run --cwd packages/plugin
  typecheck` passes; lint checks 1,505 files with 69 existing warnings / 9 infos,
  no errors.
- Full plugin suite: **8,951 pass, 46 skip, 1 unrelated failure**, 8,998 tests
  across 851 files. The external-temp Node WASM fixture could not resolve its
  workspace dependency `onnxruntime-node` (the initial run lacked
  `onnxruntime-web/webgpu` too). Re-running the four relevant files, including
  that fixture, after exposing the frozen `onnxruntime-web`, `onnxruntime-node`
  and `sharp` packages under the job's temporary `node_modules`, gives
  **89 pass / 0 fail**. No production/package change was made for this runner
  dependency-resolution problem. An attempted in-repository TMPDIR was discarded:
  it made non-git fixtures appear inside a Git project and expanded test discovery.
- E2E-wide `tsc -p packages/e2e-tests/tsconfig.json` reports 29 existing unrelated
  errors. A narrowed config extending the plugin tsconfig, disabling declaration
  emission, including both changed runner scripts and plugin ambient declarations,
  and using plugin type roots passes `tsc --noEmit`. It is generated at
  `target/provider-native-typecheck.json`, not delivered as an evidence artifact.
- `bun packages/e2e-tests/scripts/provider-pipeline-differential.ts`: **92 pass**.
- `bun packages/e2e-tests/scripts/provider-native-storage.ts`: **4 pass**.
- `CARGO_PROFILE_TEST_OPT_LEVEL=3 cargo test --locked -p mc-module --lib
  providers::step_transform::parity_tests::r2_review_720_pass_differential_with_new_seeds_and_real_reduce
  -- --exact --nocapture`: **1 pass**, 720 passes and the comparison counts above.
- Same cargo command with
  `r2_published_hard_failures_and_new_seeded_switch_controls_match_full_engine`:
  **1 pass**, 48 HARD passes / 113 comparisons. No Rust production source changed.
- Exact OC2 2.0.24 provider capture: **1 pass**, using
  `MC_PROVIDER_OC2_AI_ROOT` to select a throwaway package install's `dist` directory.

No committed adapter-native JSON golden or digest needed regeneration. Codec
goldens intentionally still test raw codec round trips, not host adapter
admission. Two existing end-to-end ack assertions failed with identical
`{"content":[{"text":"1 tag stamped.","type":"text"}],"isError":false}` output
after restoring both production files exactly from base `8971c894` (only the
driver fixture's missing SessionBinding fields were initialized). The stale
`/Queued/` expectation now asserts that real current reply. The subsequent
queue/application assertions are unchanged. The driver fixture also now supplies
`connection_incarnation: 0`, `native_generation: None`, `principal: None`, matching
current Rust test bindings; its obsolete initializer initially did not compile.

## Mutation evidence

Before each break the live files were staged and unstaged `git diff --stat` was
empty. Each mutant carried the explicit break marker; the mutated file showed
`1 file changed, 1 insertion(+), 1 deletion(-)`. After `git checkout -- <path>`
and `touch <path>`, unstaged `git diff --stat` was empty again.

- Bypass native projection in `opencode-adapter.ts`: only
  `provider-native projection excludes display metadata from pages, hooks, stored rows and restarted views`
  fails (`Expected to not contain: "display-diagnostics"`). The OC1 Anthropic
  HTTP-body and OC2 HTTP-body identity tests both remain green: model equality
  alone cannot detect storage pollution.
- Resend the raw v2 bridge in `v2/hooks/payload.ts`: the same storage fence alone
  fails, now on `magicContextHostReplay.bridges[].native.state.metadata`;
  both HTTP-body identity tests remain green.
- Remove `userAnswer` from the policy allowlist: separately for each host, only
  `OpenCode1/A12.question-answer-policy-survives-native-projection` or
  `OpenCode2/A12.question-answer-policy-survives-native-projection` fails
  (`the answer must survive automatic reclaim`). The corresponding
  `A9.tag-prepend` control stays green. All mutants were restored before delivery.
