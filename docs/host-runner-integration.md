# Pinned host-runner integration

Bridge plugins can pin a package version or repository commit and import
`@cortexkit/opencode-magic-context/host-runner`. This typed subpath has no database,
logger, tokenizer initialization or mutable singleton state at import time. It
exports the pure `record` transitions, `isFallbackAdmissible`, and
`recordProviderUsage`. Call `await loadOpenCodeProviderAdapter()` explicitly to
load the storage-backed OpenCode adapter and its `createOpenCodeProviderTransform`
factory; loading that runtime is separate from checking fallback admission.

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
of the record; the built-in adapter retains them in its existing setup metadata.
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
