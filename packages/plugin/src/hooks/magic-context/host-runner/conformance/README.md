# Frozen-byte relay conformance v1

`vectors/relay-v1.json` is the MC-authored, ordered contract for a first-observation
relay between a host bridge and ck-mc. THALAMUS can consume it without importing
our transport types. Unknown schema versions must be refused, not guessed.

## Generation and MC-side replay

From `packages/plugin`, with the repository's locked Bun/Cargo dependencies:

```sh
bun src/hooks/magic-context/host-runner/conformance/generate.ts --write
bun src/hooks/magic-context/host-runner/conformance/generate.ts
bun test src/hooks/magic-context/host-runner/conformance/
```

The first command intentionally updates the fixture; the second is read-only and
fails on any byte drift. The test also regenerates the entire file against real
MC. The generator version is `1`, the source baseline is recorded in the file,
and Cargo.lock pins the Rust provider/role encoders. Use Bun 1.4.2, the repository's
pinned version. Run the generator/regeneration test on the Linux build runner.
No `--write` is used by tests.

`mc-oracle.rs` is compiled into the mc-module library test target by the
`relay_conformance` test-only module in `crates/mc-module/src/providers/mod.rs`.
`oracle.ts` invokes exactly:

```sh
MC_RELAY_ORACLE=1 RUSTC_WRAPPER= CARGO_BUILD_RUSTC_WRAPPER= \
  cargo test -p mc-module --lib providers::relay_conformance::oracle -- --exact --nocapture
```

The Rust oracle dispatches the real provider routes on an in-process `McHandler`.
It creates a fresh temporary SQLite store for each case and reopens that same
store for a module restart. Any attempt to fetch host history through an external
runner callback panics: all admitted history must come from the vector. The fixed logical
project identity makes opaque compaction IDs reproducible; it is never opened as
a host store. `publish` seeds a compartment in that disposable MC store, just as
the existing provider tests do. There are no live stores, provider calls, clock
sleeps, environment-selected transport shims, or hand-authored expected answers.

The MC-side runner uses the production OpenCode adapter's `providerIncoming`,
`providerSubjects`, and versioned `providerOpFunctions`, the real `ProviderClient`
(including schema validation, encoded envelopes, paging and request fences), and
the real record admission/application/restart functions. Its fake relay owns the
step schedule, persisted records and Pi identity aliases. In replay mode the
fake module returns only recorded MC answer bytes; expected snapshots are never
fed into the implementation. The complete actual trace and snapshots must match.

This is a component-level adapter contract, not a public `BridgeView` receipt API
or a new Pi provider route. The existing full OpenCode transform additionally
fails closed on hook timeouts; the fake relay instead exercises the specified
whole-message raw-freeze policy via the shared record core. Pi-shaped entries
are projected onto this same tested native message lane by the fake relay; the
alias mapping is a requirement for THALAMUS, not a claim that a Pi bridge exists
in this directory. Native-marker writes and fit admission are deliberately not
performed. Only applied raw coverage is represented here.

## Exact format

`format.ts` is the independent TypeScript schema. JSON is UTF-8, four-space
indented with a final LF. All `*_bytes` values are **strings of exact UTF-8 JSON**:
decode the outer JSON string once, then compare those bytes without parsing and
reserializing. Whitespace, CRLF inside text, Unicode, key order, reasoning
signatures and tool input property order are significant. Ordinals/versions are
nonnegative safe integers; message ordinals start at one. Ranges are half-open.

```text
VectorFile = {
  schema: "mc-relay/v1",
  generator: {version: 1, source_base: string, oracle: string},
  cases: [{id: string, steps: [{action: Action, exchanges: Exchange[], expected: Snapshot}]}]
}
Exchange = {
  method: "transform.declare" | "compaction.setup" | "transform.hook" | "compaction.step",
  request_bytes: string,    // full {method,params} envelope, including each hook's params
  answer_bytes: string,     // exact Rust provider response, even when delivery is suppressed
  delivery: "answer" | "transport" | "timeout"
}
Snapshot = {
  served_bytes: string,     // complete selected provider message array
  lineage_id: string,
  served_through_ordinal: number,
  after_ordinal: number,
  unserved_subjects: [{subject_mid: string, hook: Hook, subject_part?: string}],
  last_applied: {compaction_id: string, version: number},
  last_not_applied: {compaction_id: string, version: number, reason: string} | null,
  coverage: {end_mid: string, ordinal: number} | null,
  entries: [{mid: string, ordinal: number, ingest_bytes: string, served_bytes: string,
             op_version: number, answers_bytes: string}],
  aliases: [string, string][] // [new host identity, original frozen identity]
}
Hook = "pre_user" | "post_assistant" | "post_tool"
Action =
  {kind: "bootstrap"} |
  {kind: "serve", messages: NativeMessage[], fault?: {hook: Hook, mode: "transport" | "timeout"}} |
  {kind: "retry", mid: string} |
  {kind: "restart", target: "relay" | "module"} |
  {kind: "status", admission: "accept" | "structural" | "late" | "superseded", rebuild?: true} |
  {kind: "publish", end_mid: string, ordinal: number, content: string} |
  {kind: "pi", entries: PiEntry[]} |
  {kind: "alias", from: string, to: string}
PiEntry = {id: string, parentId: string | null,
           message: {role: "user" | "assistant", timestamp: number,
                     content: [{type: "text", text: string}]}}
NativeMessage = {info: {id: string, role: "user" | "assistant", ...}, parts: object[]}
```

`answers_bytes` is the persisted record's `HookAnswer[]` (subject, ops, tags and
optional note), not an invented wire answer. A relay restart reconstructs served
bytes from original ingest plus these answers using **the recorded op version**.
The recorded version is 1; hydration installs a current version 2 whose function
throws if selected. This catches accidentally selecting the latest function rather
than version 1's saved implementation. An exact retry reuses the recorded op version/answers to reconstruct the original
served bytes; it does not issue a new hook or reapply operations to served bytes.
A fresh hook call with changed receipt controls is not an exact relay retry.

## Step semantics and coverage

* `bootstrap` declares subscriptions, sets up compaction and completes an empty
  cold model status pass. This prevents the later ordinary-ingest case from
  accidentally testing an authorized initial rebuild instead.
* `serve` admits unknown terminal messages, invokes every subscribed subject in
  order, applies successful operations once and commits a frozen entry. Known
  identities do not reread changed host content. Faults suppress delivery **after
  MC computed its answer**, so they cover committed-but-lost answers. `timeout`
  advances the injected clock to the persisted deadline: the real client must
  reject that late answer. Any failure burns every subject of the whole message,
  including subjects whose operations succeeded.
* `restart` preserves record state/answers/aliases. Relay restart discards served
  objects and hydrates from the persisted ingest; module restart reopens MC's
  temporary store. Neither permits adding or changing a visible tag in frozen messages.
* `status` transmits real missing-ingest pages and the actual applied/not-applied
  receipts. `after_ordinal` is the contiguous **ingested** cursor, not the served
  watermark. A raw serve can advance the latter without the former. Only an
  answered, accepted page acknowledges the subjects and entries it carried.
* `rebuild:true` requests a real replacement. The fake relay then accepts it,
  rejects its structure, delivers it at the deadline, or supersedes its request
  fence before applying it. All four cases carry real nonempty raw coverage in
  MC's answer. Rejection/late/supersession must preserve the old served view and
  confer **no coverage**. A following status sends `last_not_applied`; it is not
  allowed to resurrect a rejected view. Accepted coverage has a positive control.
* `pi` presents real entry-shaped inputs with branch-parent identity. `alias`
  maps a later real entry ID to the original frozen identity; it neither appends
  another ordinal nor allocates another visible tag. Branch lineage/native cuts
  must be checked separately by a Pi bridge.

The eight cases cover applied-once replay/exact retry and both restarts, transport
failure, timeout/late-hook delivery, structural/late/superseded compaction views,
a positive accepted-coverage control, and Pi entry aliases. The failed messages
have a successful assistant hook and two failed tool subjects: a successful
sibling cannot escape the whole-message freeze.

## Mutation controls

The delivery report records safe, restored mutations against three production
controls: accepting a hook at/after its deadline, ignoring the persisted op
version on restart, and bypassing structural compaction admission. Each is run
against a specifically named replay test, without regenerating expected values.
No mutation is part of the committed fixture or generator.
