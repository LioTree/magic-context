# Pinned host-runner integration

Bridge plugins can pin a package version or repository commit and import
`@cortexkit/opencode-magic-context/host-runner`. This typed subpath has no database,
logger, tokenizer initialization or mutable singleton state at import time. It
exports the pure `record` transitions, `isFallbackAdmissible`, and
`recordProviderUsage`, plus the supported lazy `createBridgeAdapter` constructor.
The low-level `loadOpenCodeProviderAdapter()` factory remains available, but bridge
callers do not need its private dependency types or a separately built database,
module client, legacy transform, or `SessionMeta`.

## Supported bridge constructor

```ts
import { createBridgeAdapter } from "@cortexkit/opencode-magic-context/host-runner";

const adapter = await createBridgeAdapter({
    openCodeClient, // OpenCode 1 SDK client, or OpenCode 2 host context
    projectRoot: "/absolute/project",
    connectionFile: "/absolute/subc-connection.json",
    storageDir: "/absolute/magic-context", // contains the shared context.db
    configPath: "/absolute/magic-context.jsonc",
    // allowMigration: true, // deliberate installation-wide schema upgrade only
});
const unsubscribe = adapter.onOutcome(async (messageId, subject, outcome) => {
    // Observe committed ops/unavailability; context.db remains the replay owner.
});
const view = await adapter.run({ sessionId, messages: rawHostWindow, kind: "model" });
// Send this view, not the unchecked rawHostWindow.
unsubscribe();
await adapter.dispose();
```

All four filesystem inputs are absolute. `configPath` uses the normal loader's
`MAGIC_CONTEXT_CONFIG_PATH` semantics (trimmed exact user-tier file, JSONC,
relative file substitutions, project-tier security, and no XDG/legacy user
fallback if missing). The loader now accepts an explicit override; the bridge
passes it with runtime-global updates disabled and never changes `process.env`.
The bridge does not run config-location migration or install reload timers.

The bridge **always selects the provider lane**. `transform_mode` and
`rust_pipeline` select the in-tree plugin renderer and do not apply to the bridge;
the harness's own off-by-default bridge flag owns opt-in. `kind` has exactly one
supported value, **`"model"`**, because the OpenCode messages-transform hook has no
caller kind and the provider adapter emits model steps. Rebuilds are not another
kind: the adapter compares the host window to saved message identities and checks
whether the selected model, system/tool fingerprint or persisted source state has
changed. Idle-cache time and token pressure can also require a rebuilt history
view, using the same rules as the in-tree provider path.
`run` owns `SessionMeta`, publication, normalization through `providerIncoming`,
and the bootstrap/rebuild record; it returns a `Promise<MessageLike[]>` view.
Supply the complete raw host window in append order with its real identities,
not just the new tail or a previous provider projection. No private type or
mutable output parameter is needed.

The store is an independently owned handle opened by the shared storage module,
with the ordinary WAL/NORMAL policy, foreign keys, 5-second busy timeout, private
permissions and write-transaction helpers. It does not reuse or close another
host's cached handle, copy legacy stores, or start unrelated store backfills.
**Schema changes affect every host sharing `context.db`.** By default any version
other than this build's `LATEST_SUPPORTED_VERSION` throws
`StoreVersionMismatchError`, with `code: "store_version_mismatch"`, `found` and
`expected` version fields and both versions in its message, **before schema
initialization or migration**. This includes a fresh store at version 0. Only an
explicit `allowMigration: true` initializes/migrates an older store using the
ordinary migration/write-lock implementation. A newer store is always refused:
allowing migration cannot downgrade it. Older hosts must update to a build that
supports the newer store's schema version.

The constructor builds `SubcModuleTransport` from the supplied connection file.
It binds the canonical project root and each call's session, with `opencode` for
the SDK client or `opencode2` for a host context whose `session.hook` is a function.
The harness is instance-scoped; no global harness switch is needed. Route opening
passes `consumerIdentity: null`, so inherited `SUBC_MODULE_ID`/
`SUBC_LAUNCH_NONCE` never identify this independent host.

Bootstrap uses the native canonical-store ordinal resolver, **never ordinals
invented from `session.messages`**. OpenCode 1 reads its canonical host store.
OpenCode 2 must already have a per-session raw-history provider registered, as the
in-tree v2 context integration registers with `setBoundedRawMessageProvider`.
The host integration must register a reader for its own canonical history; the
module transport only sends provider requests and cannot supply that host reader.
Without it, `run` refuses before any canonical-store fallback or module call.
The constructor supports v2 detection and this boundary, not a replacement for
v2's host-history registration lifecycle.

`dispose()` is idempotent and returns the same promise on repeated calls. It
rejects new calls immediately, drains in-flight passes and stops the historian,
then closes the module connection and its store handle exactly once. Methods
other than repeated disposal refuse after disposal. Observers can unsubscribe;
they are awaited after durable commit, as described below.

### Refused provider handoffs

The native adapter's "legacy transform" is the Rust **full-request** transform.
It caches message-id to canonical-ordinal mappings for bootstrap, but also normally
runs when provider selection is off or bootstrap/exit hands off. The bridge
constructs that same Rust transform internally for its ordinal cache only. It
**never executes a full-request handoff**. These throw `BridgeRefusalError` (an emergency fail-closed error) with
stable `code` and `reason` fields:

| Code | Reason / handoff |
| --- | --- |
| `bridge_bootstrap_declined` | `bootstrap_declined`: initialization cannot produce a committed provider view (missing/noncanonical IDs or unfinished messages, host window changed before initialization completed, declaration unavailable, setup refused/unavailable, or no applied bootstrap replacement) |
| `bridge_provider_message_too_large` | `provider_message_too_large`: a message cannot be admitted within the provider request cap |
| `bridge_provider_history_lost` | `provider_history_lost`: the module cannot preserve the required history |
| `bridge_provider_record_lost` | `provider_record_lost`: a module-ahead setup cannot be adopted without a durable host record |
| `bridge_provider_foreign_history` | `provider_foreign_history`: host window belongs to incompatible history |
| `bridge_provider_revert_ambiguous` | `provider_revert_ambiguous`: the record cannot resolve the host revert |
| `bridge_rollback` | `rollback`: a previously rolled-back provider record cannot complete re-entry |
| `bridge_provider_disabled` | `provider_disabled`: defensive low-level reason; unreachable with the bridge's fixed provider lane |
| `bridge_raw_history_provider_missing` | `raw_history_provider_missing`: OpenCode 2 session has no registered raw-history provider |

No handoff refusal authorizes sending raw history. The caller may ask
`isFallbackAdmissible` and send **only** its returned admissible view, or refuse the
step. Other native failures (durability, store-ahead, transport and explicit
provider refusal) retain their native error codes; they are not disguised as a
full-request handoff.

### OpenCode 1 measured usage is not an automatic bridge witness

`message.updated` exposes assistant reply id, model, input and cache-read/write
tokens and completion metadata. The in-tree event handler uses these for session
pressure, rejecting older reply ids. Pressure is not exact-request fit evidence.
Its last-known-good (LKG) saved-request path is stricter: an initial empty assistant
update establishes the v1
response id; the messages pass claims that identity and captures a saved request;
a completed nonfailed reply must match the response id/model. Replay then checks
that the saved prefix is unchanged and that the first appended message is that
assistant reply (`lkg-measured-request.ts`). This also relies on private
request/capture state, not merely the assistant's final `tokens`.

The LKG envelope compares model, system-token count, agent and measured tool-token
count. Those counts do **not** prove equal system/tool bytes. The provider adapter
separately uses `system_prompt_hash` from the system hook and the tool-set hash to
trigger rebuilds, but neither that manifest nor the next pass's preceding messages
proves that a particular reply measured that exact sent envelope. This facade has
no final provider-request record or system/tool hook witness. There is therefore
**no sound automatic `recordReplyUsage(sessionId, assistantMessage)` helper** on
this surface. Do not turn the session's most recent usage into such a witness.
OpenCode 1 bridges lacking additional request attribution should skip
`recordProviderUsage` and supply conservative system/tool token bounds instead;
fallback will refuse when fit cannot be proven.

`recordProviderUsage` remains an explicit, caller-attested API for integrations
that can attribute a count (including cache reads/writes) to the exact returned
view, model and complete system/tool envelope. Fallback matches lineage, view
version, message-prefix digests, model and envelope; changed prefix/model/system/
tools never borrow that count. The constructor regression test proves the matching
control admits without local envelope bounds and each changed identity refuses.


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
host window in append order, normalized exactly as the record's admissions for
the pure/low-level API (the adapter's `providerIncoming(message).read()`
representation). The supported bridge facade takes the **raw** window and owns
this normalization. Supply its first provider
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
