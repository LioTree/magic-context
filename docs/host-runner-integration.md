# Pinned host-runner integration

Bridge plugins can pin a package version or repository commit and import
`@cortexkit/opencode-magic-context/host-runner`. This typed subpath has no database,
logger, tokenizer initialization or mutable singleton state at import time. It
exports the pure `record` transitions, `isFallbackAdmissible`, and
`recordProviderUsage`. Call `await loadOpenCodeProviderAdapter()` explicitly to
load the storage-backed OpenCode adapter and its `createOpenCodeProviderTransform`
factory; loading that runtime is separate from checking fallback admission.

## Adapter-owned record access

The adapter is multi-session. Bridges call
`adapter.isFallbackAdmissible(sessionId, inputs)` and
`adapter.recordProviderUsage(sessionId, usage)`; neither method exposes the record.
They hydrate and use that session's current record. Missing, inactive or exited
provider sessions refuse admission and cannot record usage. Usage recording is
synchronous and commits immediately to `context.db` (and refuses while a pass is
in flight); failed persistence does not leave speculative usage in the cache.
The pure exports described below remain available for other record owners.

## Durable step-transform outcomes

The adapter's durable store is **Magic Context's `context.db`**, keyed by session
and harness (`opencode` or `opencode2`), not a bridge cache or the ck-mc process.
An ordinary pass already committed frozen message bytes before publication:
`commitHostRunnerPass` writes `host_runner_entries.ingest_json`, `op_version` and
`hook_json`, the message/ordinal IDs, and `host_runner_state` together in one
immediate SQLite transaction. `run()` publishes its output only after that commit.
Restart hydration re-applies the recorded op version and answers to the saved
ingest, or replays saved raw ingest when unavailable; it never re-hooks retained
messages against the current provider.

Previously, unavailability was frozen only at whole-message granularity; the
per-subject unserved list could later be acknowledged away. `hook_json.outcomes`
now retains each **effective** subject outcome in that same transaction. The
existing all-or-nothing message rule is unchanged: if any subject is unavailable,
every subject for that message is recorded as unavailable and the whole message
stays raw, including text for which another hook returned successful ops. Otherwise
each answer's ops (including empty pass ops) are frozen. Bootstrap imports retained
history without running hooks, so those admissions have no hook outcomes. Older
records still replay their frozen whole-message result; unavailable subjects
cannot be reconstructed retroactively. When compaction consumes entries, their
outcomes are superseded by the durable replacement in `host_runner_views`; covered
messages are not re-hooked. A lineage descent/revert can deliberately re-admit a
changed suffix.

`OpenCodeProviderOptions.onOutcome(messageId, subject, outcome)` is optional and
awaited for newly committed outcomes, after the pass commit and before publication
or `run()` returning. It observes/mirrors the record; it never replaces persistence.
An observer failure refuses that pass's publication but leaves the frozen outcomes
committed. Notifications are not an exactly-once delivery queue and are not re-sent
on replay; a process can die after commit but before observation. Bridges must not
depend on a separate mirror to reconstruct the served view. The SIGKILL fixture
test kills a process between steps and opens the same temporary `context.db` in a
new process, proving identical ops/raw replay with no hook or declaration calls.

## Host-lane subjects and positions

ck-mc's host declaration (`crates/mc-module/src/providers/step_transform.rs`,
the declaration builder and the host hook handler) selects `observation: "answer"`
with `serializer_profile: "opencode-aisdk"`. It declares `pre_user` and `post_tool`,
plus `post_assistant` when MC owns reduction. **It does not declare or act on
`pre_tool` on this lane**; unsupported host hooks return `not_subscribed`.
Consequently the adapter does not run `pre_tool`, despite the broader subject list
in THALAMUS's design. There is no new position encoding: completed messages get
append-order ordinals within the lineage; a completed/error tool result shares its
assistant message's ordinal and uses `subject_part` to identify its part. Messages
with unfinished tools remain unnumbered passthrough until terminal. Inventing an
ordinal for a pre-tool event would not enable an MC host-lane effect.

## Fallback admission versus restart recovery

`adapter.recoverOutput(sessionId, output)` reloads committed storage and assembles
the last durable replacement plus retained frozen entries. It has no incoming host
window, model limit or envelope, cannot check fit/source continuity, and cannot add
a newly arrived raw tail. It is **restart recovery only**, not permission to send
that view as fallback for a new request. If `recoverOutput` returns false, it leaves
the supplied output unchanged.

For a new fallback step, serve **exactly the `view` returned by an admissible
result** from `adapter.isFallbackAdmissible`. That is the last durable replacement
plus unchanged retained frozen entries plus the current raw unadmitted tail. This
also preserves frozen hook ops in an identity view before any compaction. Source
continuity and fit must both be proven; never append a tail to `recoverOutput` and
assume the result was judged admissible.

`isFallbackAdmissible(record, inputs)` is synchronous. Supply the full incoming
host window in append order, normalized exactly as the record's admissions (the
adapter's `providerIncoming(message).read()` representation), its first provider
ordinal if the window starts later than `record.first_ordinal`, the selected
`provider/model`, a system/tool-envelope fingerprint, and the **usable prompt
window after output reserve**, not a guessed default. MC's id-less synthetic heads
and host compaction markers do not consume ordinals. Covered input digests
are retained after source bodies are pruned; restored older records lacking those
digests must refuse until rebuilt by the provider.

Record provider input usage only after attributing it to the exact served request,
including input and cache-read/cache-write tokens, with that request's model and
envelope. Persist `record.measured_usage` and `record.source_digests` with the rest
of the record; the built-in adapter's usage method commits them in its existing
`host_runner_state.setup_json` metadata.
A session's latest usage from an unrelated request is not evidence. Matching usage
prices only the new tail; otherwise callers must supply conservative local-token
bounds for system text and tool definitions. The fit calculation shares MC's
wire-field traversal, calibrated fit margin and byte-risk guard, and uses a UTF-8
byte upper bound instead of loading a tokenizer. This intentionally may decline
some requests that a full tokenized pass would admit.

A successful result is `{ admissible: true, view }`. Failures include
`covered_range_changed` (edits, removals, insertion or changed ordinal in the covered
range) and `fit_unproven` (unknown window or insufficient fit evidence). Refuse the
model step on either failure; do not fall back to unchecked raw history. The helper
never contacts ck-mc or opens storage and does not mutate the record or its inputs.

The subpath import test exercises the built package in a clean process with a
scratch HOME and XDG directories, blocking SQLite module loads, filesystem writes
and timers, and checking global properties and process listeners/handles. Build
before running it (`bun run --cwd packages/plugin build`).
