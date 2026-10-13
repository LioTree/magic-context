# Claude Code capability candidate — publication held

## Decision and status

The advertisement remains **held**. This change constructs a test-only candidate;
`role.describe` and `transform.declare` still advertise no `claude_code` bundle.
The candidate passes the shared type's structural validator, but this build does
**not** meet all behavior required after selecting it. Thalamus (THALAMUS), the request gateway, must not treat
structural validation or the exact-byte snapshot as production readiness.

The inventory below describes the original Magic Context (MC) runtime at
`4f8caea24604e6ddc27c8763fa08b0504987ad3a`, **before** the small safety fixes in
this change. The classified follow-up below supersedes closed rows. THALAMUS is
the gateway that decides whether and how to dispatch the resulting request to
Anthropic. Contract citations below refer to cortexkit/commons
`77f10f0fcfe465e6cab567dcf1a1bf8901c54547`:

- `crates/cortexkit-role-step-transform-provider/CONTRACT.md` §14.1–§14.3;
- `crates/cortexkit-role-compaction-provider/CONTRACT.md` §19.1–§19.5.

The shared type is
`crates/cortexkit-role-step-transform-provider/src/claude_code.rs::ClaudeCodeCapabilities`.
Compaction reuses it; it does not define a separate bundle type.

## Where the bundle is published and selected

| Surface | Exact field and timing |
| --- | --- |
| Discovery reply | Root `claude_code: ClaudeCodeCapabilities` on `role.describe`, before managed attachment. Both provider roles' `src/describe.rs::RoleDescribe` have the optional field. Discovery describes a build; it does not activate the lane. |
| Declaration request | Root `claude_code` on `transform.declare`; the runner selects a supported discovery bundle unchanged. `subscription.rs::DeclareRequest` carries it separately from opaque `params`. |
| Declaration reply | Root `claude_code` on `Declaration`, echoed unchanged. The accepted selection must remain frozen for that connection and plan. |
| Compaction setup request | Root `claude_code` on `setup.rs::SetupRequest`, copied unchanged from declaration. Setup cannot replace the selection. The typed `SetupAnswer::Ready` has no dedicated bundle member; §19.1's unchanged Setup selection is explicitly represented on the request. |

Sources: step contract §14.1 (lines 703–739), compaction §19.1 (895–925),
step `src/subscription.rs` (328–399), and compaction `src/setup.rs` (18–68).

The activation rule requires both the daemon-confirmed reserved identity of the
Thalamus gateway (`reserved:thalamus`) on its bound connection and the frozen
declaration's
`claude_code.capability = "claude-code-step/v1"`. Bound project/session/agent,
`harness=claude-code`, native profile and `observation=answer` must also match.
Body principal/profile/bundle fields never authenticate the caller. Selecting
this bundle on another principal must refuse `invalid_params` with
`detail.field = "claude_code"`; drift has the same named error.

The approved future discovery design is route-scoped: expose the candidate only
on daemon-attested, bound Claude Code routes. Discovery precedes selection, so
caller identity and the exact capability selection are checked at declaration
and setup, not by demanding an already
frozen declaration before discovery. No live discovery change is included while
the advertisement is held. OpenCode, Broca and unbound discovery remain unchanged.

A named refusal here means the provider's explicit RPC/role error prevents managed
publication, not an outage that can be passed through. Slice names used below:
**M3** is native endpoint/raw-view/cut and payload handling; **M4** is usable
geometry, measured fill and protection; **M6** is canonical tools/guidance and
notice delivery receipts; **M8** is capability attachment, generation isolation
and bootstrap ownership.

## Exact candidate bytes

The canonical UTF-8 JSON is 1,028 bytes, excluding the fixture's final LF.
SHA-256: `d4a00af0be7646a2eb5792d78f1b778274c5dc555ee4bee5cf41a713859c8c30`.
The exact bytes are also pinned in
`crates/mc-module/testdata/codec/claude-code-capability-candidate.json`.

```json
{"bootstrap_complete":false,"cache_policy_revision":"1","canonical_reduce":false,"capability":"claude-code-step/v1","caps":{"hook_envelope_bytes":3145728,"ingress_envelope_bytes":3145728,"single_message_bytes":3145727,"view_page_bytes":3145727},"commons_revision":"77f10f0fcfe465e6cab567dcf1a1bf8901c54547","digest":"sha256","epochs":{"codec":1,"compartment":2,"memory":3,"raw_provenance":1,"render":3,"tagger":4},"exact_endpoint":"native_top_level_inclusive","guidance":false,"harness":"claude-code","notice_dispatch_ack":false,"observation":"answer","package_versions":{"compaction-provider":"0.2.0","step-transform-provider":"0.2.0"},"partial_message_cut":false,"principal":"reserved:thalamus","profile":"claude-code-anthropic","profile_generation":"codec-sha256:bdc8ba8a1452ea17554aac594cfffd4835f9f19c438013377298f6ff1d6a9e24","provider_generation":"key-sha256:737bd7db215bd994d049daeed00e66e7b7fcfe10775515700a02cd7c294cd4fd","raw_view_read":false,"wire_majors":{"compaction-provider":"v1","step-transform-provider":"v1"}}
```

`providers/capability_candidate.rs` is included only under `cfg(test)`. Its
immutable `LazyLock` constructs the value from the linked role identifiers,
compiled `Cargo.lock` versions/revision, serializer selection, live render/tagger/
memory/compartment epoch constants, the live cache-policy revision and shared
request-size ceiling. There is no second hand-maintained advertisement object.
The pinned JSON is an independent expected-byte fixture, never regenerated by a
normal test.

Important qualifications:

- Native codec/provenance epochs `1/1` are proposed first-format pins, defined
  beside the codec under `cfg(test)`. They are **not active connection pins**.
  `render=3` instead comes from the existing Claude Code request-render format;
  it is not a native codec/provenance version.
- Generation strings fingerprint the compiled codec source and provider-key
  implementation. They identify candidate formats, **not existing database
  generations**. Current rows, locks and views do not use either string.
- Envelope values come from the live 3 MiB ceiling. This change makes native
  inbound and inline-reply checks strict-below, checks original transport size
  before normalization, and explicitly enforces the per-message bound. The page
  value reserves the same headroom but offers no service with `raw_view_read=false`.
  No reference retrieval operation is advertised.
- `canonical_reduce`, `guidance`, `notice_dispatch_ack`, `bootstrap_complete`,
  `partial_message_cut` and `raw_view_read` are false. Further `capabilities` is
  empty and therefore omitted by the shared serializer.

## Obligations missing after selection

A normal production gateway currently refuses attachment because discovery has
no bundle. The runtime outcomes below describe a caller that **bypasses that
refusal** and sends this candidate anyway. The shared `ClaudeCodeLane` helper's
checks do not run automatically merely because serde decoded the fields; MC must
invoke and persist the admission/validation behavior itself.

| Obligation, section and field | Original MC 4f8 behavior if forced | Closure and approximate size |
| --- | --- | --- |
| §14.1 / §19.1: discover a supported root `claude_code`, echo it in declaration and require both keys | Discovery and declaration omit it. A conforming gateway **refuses attachment**. MC currently keys its CC exception on attested bind plus profile/answer opt-ins, not the capability selection. A capability-only selection on another profile can be **silently ignored**, rather than the required `invalid_params/claude_code`. The existing CC-profile principal spoof does refuse. | **M8 publication + M2 gate**, about 0.5–1 day for scoped discovery, full-value equality, named refusals and declaration echo. |
| §14.1 / §19.1: freeze the entire selection for the connection and Setup; reject drift and borrowing | `admit_host_plan` freezes `params_json`, not the root capability bundle. There is no connection-scoped `ClaudeCodeLane`. A changed root bundle or a new connection using the same conversation is **silently ignored**. Setup can decode/store a selection but does not validate it against declaration. | **M8**, about 0.5–1 day, overlapping the publication gate; use trusted route identity and persist the frozen selection in existing JSON. |
| §14.1 / §14.3 / §19.1: actual profile/provider generation scope and component epoch pins | Candidate fingerprints are not used by `records::Key`, store uniqueness, locks, ingest cursors, views or receipts. Native codec/provenance pins are not checked. Selecting a different generation or native epoch is **silently ignored**; reused MIDs with different bytes may then get an immutable-ingest **refusal**, rather than a distinct generation. State/view identity can otherwise be attributed to the wrong declared generation. Generic render epochs still function. | **M8**, about 1–2 days for generation-aware key/indices/locks and canonical mapping, plus 0.25–0.5 day for active native epoch pins. This is the previously deferred additive store migration, not solved by advertisement. |
| §19.2: `coverage.endpoint = {message_id, part_index}`, exact original top-level inclusive boundary, with `partial_message_cut=false` | `execute_host` publishes `HostCoverage {end_mid, ordinal}` only. The exact endpoint is **absent**. A conforming gateway must **refuse/decline the native cut**, not infer a part. Forcing ordinal-only cutting can remove later blocks in a message whose engine boundary was earlier; this is a potential **wrong-bytes/lost-tail** outcome, not proof that every existing boundary is already whole-message-safe. | **M3**, about 0.5–1 day for whole-message endpoint emission, checking it against the original part map and rejecting non-representable boundaries; partial cutting can remain disabled. |
| §19.2: inline `compaction.raw_view` with immutable version, length, SHA-256, profile/generations, lineage and endpoint | Raw replacements are correctly spliced and persisted, but no typed `FrozenView` is emitted. Per-slot head hashes are not a full frozen raw-view identity. These fields are **absent**; a conforming gateway cannot verify the required object and must **refuse publication requiring it**. | **M3 + M8 scope**, about 0.5–1 day for inline freezing/validation once endpoint and generation scope are available. `raw_view_read=false` avoids a retrieval RPC, not inline raw-view obligations. |
| §19.2: a native hook cut additionally requires `cut_replacement_ref` and `retained_tail` together | MC emits neither. A conforming gateway **declines the cut** and retains its transcript. Treating the full role replacement as just the cut head can duplicate its included tail or discard native remainder: **wrong bytes** if forced. | **M3**, about 1–2 days for exact head/tail mapping and frozen references; this can overlap endpoint/raw-view work. It is required only when attempting the native hook-cut path. |
| §14.2 / §19.3: full encoded request/reply envelopes strictly below caps, named oversized-message refusals, no truncation or oversized-first-message exception | Request guards use re-serialized params and `>` the ceiling, so exactly-ceiling or differently escaped original envelopes are not checked as required. There is no independent negotiated single-message guard or CC response-size guard. New cap values are **not selected/enforced**. Ordinary oversized inputs do get existing named request-size **refusals**, but a large frozen replacement can exceed the allowed envelope with no bounded CC retrieval path. A conforming gateway must **refuse** such publication. | **M3**, about 0.5–1 day for original inbound-byte accounting, strict boundaries, selected per-message limits and bounded inline replies. Supporting larger native originals/reference replies is additional work. |
| §19.4: required `geometry`; validate soft/hard/absolute walls and `output_reserve` without double subtraction | Shared fields decode, but MC's provider `status` normalization drops geometry/reserve, and `transform::compaction::run` resets request geometry. Missing or contradictory geometry is **silently ignored**, not refused. Scheduling/fit can use the model window instead of the gateway's usable walls, yielding a **wrong fit decision** or a provider context error. | **M4**, about 0.5–1 day for validation and adapter forwarding, preserving independent protected-token/tool and signed-run gates. |
| §19.4: current-request `fill` attribution/validation and explicit `mid_turn` continuation | Both are **silently ignored** by normalization. Existing usage/estimate scheduling remains, but measured fill is not checked against admitted request/generation evidence and native continuation is not carried. Wrong fill/protection decisions can follow. The real protected-tail terminal condition still lacks trusted final-wire evidence on this adapter. | **M4**, about 0.5–1 day beyond geometry; together roughly 1–2 days with focused tests. |
| §14.2 / §19.5: only negotiated notices may be armed; any supplied delivery acknowledgement must be receipt-scoped and idempotent | No typed directive is emitted and `notice_dispatch_ack=false` deliberately offers no notice delivery support. If acknowledgement fields are nevertheless sent, they are **silently ignored**. The native adapter is not wired to a frozen selection/receipt ledger; the general engine's legacy notice state is not proof of the stronger negotiated arming rule. | **M6**, audit/gating about 0.5 day before activation; about 1–2 days for typed notice persistence, receipt validation and replay before setting the flag true. False avoids claiming that optional service, not permission to treat service ordinals as HTTP dispatch evidence. |

Sizes are engineering-day estimates for focused MC implementation and tests,
not a release schedule. Several rows overlap; do not add them as independent
estimates. Generation migration and publication must be reviewed together.

## Unsupported optional features are not silently claimed

The false flags do not require implementing every optional service now:
`raw_view_read=false` permits inline verified bytes instead of retrieval;
`partial_message_cut=false` permits whole-message-only boundaries; false
canonical reduction/guidance flags do not authorize tools/system surfaces; false
notice/bootstrap flags do not advertise typed acknowledgement/completion services.
They also do **not** disable mandatory geometry, exact native endpoint/raw-view
metadata, generation scope, double-key admission or strict payload bounds.

M6 must bind any future actually served canonical tool/guidance surface to the
selected plan and generation; generic facade existence and tags are not that
permission (§14.1, 755–761). A typed final-ingress bootstrap receipt, when enabled,
belongs to M8 / compaction §19.7, not Setup-ready or noop; it remains unadvertised.
Already-working protections include raw equality/duplicate-key refusal, exact
signed-block byte replay, no edits before retained signed prefixes, stable MID
admission, host paging/gap fencing and runner-owned cache expiry. They do not
substitute for the missing fields above.

## Does whole-message cutting meet `native_top_level_inclusive`?

**Yes as a subset of the coordinate semantics; no as proof that the current MC
publication is already conformant.** For a message with `n` original top-level
content blocks, cutting the entire message is the endpoint
`{message_id: MID, part_index: n - 1}`. Scalar content has one part at zero.
Nested tool-result children are not this coordinate. Setting
`partial_message_cut=false`
limits supported cuts to representable whole-message endpoints; it does not
require cutting inside a message.

The value promises the **exact original inclusive block endpoint**, not merely
an ordinal or the ability to remove a whole message. MC must emit the typed
endpoint, verify that its engine coverage really ends there and preserve the
matching frozen raw replacement/scope. A boundary just after signed thinking
is not automatically a complete signed/tool run. Earlier engine part boundaries
cannot be snapped to the last part to make whole-message cutting convenient.
The gateway must decline a non-representable cut and record structural rejection
for that view (§19.2, 929–967). At `4f8caea2`, `end_mid/ordinal` alone did not
satisfy that promise. This change now emits the exact whole-message endpoint and
refuses an earlier part boundary; it does not yet implement generation-scoped
FrozenView identity or native cut-head/tail references.

## Reproduction and non-vacuity

The normal test `providers::capability_candidate::candidate_discovery_and_declaration_echo_identical_frozen_bytes`
constructs both test-only paths from the same immutable candidate, verifies
byte-identical root `claude_code` values, and refuses other principals or a
changed selection. The live paths still omit the bundle. The normal test
`providers::capability_candidate::candidate_bundle_bytes_are_pinned_and_not_advertised`
compares the canonical bytes to the fixed fixture and proves the live hold.
The export test is ignored during ordinary suites because it only prints the
canonical configuration and digest; it never regenerates the pinned fixture:

```sh
cargo test --locked -j 4 -p mc-module --lib providers::capability_candidate::print_candidate_bundle -- --ignored --exact --nocapture
```

Run these Cargo commands on Linux with four allocated CPUs. A mutation changing the candidate's `canonical_reduce` from
false to true must fail the byte-pinning test; it changes a real bundle field,
not a proxy file hash. Stage the live file, verify an empty unstaged diff,
make the temporary source mutation marked `NON-VACUITY BREAK`, capture the
nonempty diff, run the exact test, then
restore from the index and touch the file. Never commit the damaged source.

### MC source anchors

- `crates/mc-module/src/providers/mod.rs::describe` and
  `step_transform.rs::declaration`: no live `claude_code` advertisement/echo.
- `crates/mc-module/src/providers/mod.rs::admit_claude_code` and
  `step_transform.rs::admit_host_plan`: bind/profile/observation checks and the
  existing params-only plan freeze, without root-bundle or connection selection.
- `crates/mc-module/src/providers/records.rs::Key` / `Key::engine_key` and
  `crates/mc-store/src/provider_records.rs::ProviderSessionKey`: current triple
  identity, without the candidate generation fields.
- `crates/mc-module/src/providers/compaction.rs::HostCoverage`, `execute_host`,
  `host_step`, and `codec_claude_code.rs::encode_view` / `answer_bytes`: ordinal
  coverage, immutable raw strings and exact splicing, without typed endpoint/
  FrozenView/cut-mapping publication or a reply-size guard.
- `crates/mc-module/src/providers/compaction.rs::status` and
  `crates/mc-module/src/transform.rs::compaction::run`: the original adapter dropped
  geometry; the new CC template now passes validated usable walls and continuation
  to the real engine. `compaction::Status::usage` still lacks causal final-wire
  trust; unsupported `fill` now gets a named refusal rather than being discarded.
- `crates/mc-module/src/providers/step_transform.rs::provider_claude_code_hook`
  and `compaction.rs::provider_step`: durable native hook pass and absent typed
  notice/bootstrap reply fields, not negotiated delivery receipts.

## Trial classification and fixes in this change

THALAMUS's trial rule is applied literally: a named refusal or an explicitly
false unsupported feature is **acceptable**. Wrong bytes reaching Anthropic,
or an obligation ignored while the bundle claims it is met, **must close before
the trial**. Geometry and original per-message raw JSON are already supplied by
the gateway; neither is a request to make the gateway author MC's replacement.

The held build now refuses any non-null capability selection by name
(`invalid_params`, field `claude_code`) instead of silently accepting it. This is
not a workaround to run the trial: the candidate cannot be selected on this build
until publication is approved and the remaining mandatory scope work is done.
The table distinguishes that current safety outcome from what must be finished
before enabling a matching advertisement/declaration.

| Inventory item | Trial class after this change | Fix or precise remaining plan; size | More gateway data needed? |
| --- | --- | --- | --- |
| Advertisement plus declaration echo (§14.1 / §19.1) | **Acceptable while held: named refusal.** The earlier 783 declare refusals remain intentional while publication is held; bypassing advertisement alone cannot make declaration valid. **Must close before accepting a trial attachment.** | Both candidate paths now use one immutable constant and a byte-equality test; no live advertisement is enabled. Live non-null selections refuse by name. Enabling discovery/declaration is part of the M8 scope work below, not just replacing `None` with a blob. | No new raw-message/geometry input. The gateway must select the exact advertised root `claude_code`, copy it unchanged into declare/setup, and preserve the bound connection. |
| Frozen connection/plan selection and generation isolation (§14.1 / §14.3 / §19.1) | **Must close before trial activation.** Simply enabling the candidate would still leave these declared obligations unimplemented. Current selection is safely refused. | **M8, approximately 2–3 days together:** persist the full selection; bind it to trusted connection and canonical conversation; reject drift/rebinding misuse; add profile/provider generation to conversation uniqueness, child-ledger/view keys and locks; retain a canonical memory-owner mapping; classify existing rows as legacy without overwriting them. Assign/enforce native component pins and validate every frozen view against those scopes. Publication/freeze is not an independent safe half-day release without this state boundary. | No more message bytes. Need the explicit selected generation/bundle on declare/setup, which is already defined by commons. Imported-history bootstrap provenance is additional input only if that optional service is enabled; it remains false here. |
| Whole-message endpoint (§19.2) | **Closed small must-close fix.** A partial/unknown engine boundary is a **named terminal refusal**, acceptable to the trial. | This change emits `coverage.endpoint` at the actual final original native block. It refuses `native_endpoint_unrepresentable` instead of snapping an earlier engine boundary forward. A reused CC view must have the current engine coverage ordinal, then revalidate its endpoint. A real cold-fold test covers partial refusal and whole-message endpoint publication. | **No.** Gateway MID/ordinal and raw messages already supply the original part map. |
| Inline FrozenView identity (§19.2) | **Must close before accepting native publication under the bundle.** It is absent, not justified by `raw_view_read=false`. A gateway that declines it by name is safe; accepting generation-unverified metadata would ignore a claimed obligation. | **M3 + M8, approximately 1–1.5 days after scope integration:** freeze the actual committed `[from,to)` replacement array bytes, length/SHA-256, view/version, endpoint, lineage and selected generations together in existing immutable view JSON; emit typed inline `raw_view`; validate acknowledgements against that object. Do not reserialize parsed messages as raw bytes. This is coupled to M8 scopes and is not safely closed by inventing generation strings in the reply. | **No.** MC owns the replacement and has the original raw bytes; the gateway cannot supply MC's authoritative frozen object. |
| Native hook-cut head/tail mapping (§19.2) | **Acceptable only when the cut is declined/not attempted.** `partial_message_cut=false` disables partial-message cuts, not this whole-message hook-cut mapping requirement. Installing the full working view as only the cut head is a **must-close wrong-bytes risk**. | **M3, approximately 1–2 days:** freeze a separately addressable exact cut-head payload and `cut_replacement_ref`, plus `retained_tail` native endpoints/engine handles, with the same scope/digest; validate replay and lifetime. Until then the gateway must decline native hook cuts, keep the transcript, and not acknowledge them applied. Ordinary verified role-range application is not permission to infer a cut head. | No additional raw message bytes. Need the gateway's explicit decision not to attempt a native cut without both fields; it must not infer the head from summary text or assume two messages. |
| Envelope/single-message/inline reply caps (§14.2 / §19.3) | **Closed small must-close fix.** Oversized payloads now have named refusals. Retrieval is **off**, with `raw_view_read=false`. | Original inbound body size is checked before normalization; native serialized checks are strict-below; the per-message limit is explicit; inline reply bytes are bounded. Other profiles keep their prior bounds/bytes. Oversized frozen data may remain stored, but it is never returned above the cap. Chunked ingest or reference retrieval is optional future M3 work, not claimed. | **No.** Actual inbound length is available to MC transport. The gateway should classify named size errors terminally, never use raw fallback. |
| Geometry/reserve/continuation (§19.4) | **Closed for supplied valid geometry; invalid values produce named refusals.** Mandatory presence must be enforced as part of future negotiated activation, not imposed on the still-undeclared legacy path. | This change validates walls and checked `usable_hard + output_reserve`, forwards geometry and `mid_turn` to the actual engine, preserves the CC profile instead of rewriting it to Broca, and prevents the old context-window-only fast noop. The engine uses already-usable soft/hard walls; reserve is checked, **not subtracted again** or forwarded as a second budget deduction. The real engine seam test pins the received values and profile. M8 activation must add the missing-geometry refusal before admission under the selected bundle. | **No additional geometry data.** Optional `output_reserve` is the actual planned `max_tokens` when provided; optional `mid_turn` is explicit native continuation, not inferred from `step_kind`. Send those existing fields if their corresponding checks are needed. |
| Attributed fill/trusted protected-tail evidence (§19.4) | **Acceptable named refusal for supplied fill.** It is no longer silently ignored. Full trustworthy measurement handling remains **must close before accepting that evidence**, rather than fabricating trust from an estimate. | Supplied `fill` now refuses `invalid_params/fill`; absence still uses existing labeled estimates/usage. **M4 + M8, approximately 1–2 days:** retain admitted request/generation/publication evidence, validate `observed_request_id` and overlapping-response sequencing, distinguish estimates from trusted final-wire measurements without branching on open attribution labels, then pass calibrated evidence to protected-tail fit. The existing typed M7 refusal mapping is not proof this evidence reaches the real guard. | More than geometry/raw messages is needed for measured fill: a causally anchored request/dispatch identity and scope (and the corresponding publication evidence). Current `fill.observed_request_id` alone is not an MC-kept dispatch ledger. The gateway may omit fill meanwhile; no guessed zero is required. |
| Notice acknowledgement and arming (§14.2 / §19.5) | **Acceptable feature-off** with `notice_dispatch_ack=false`; supplied acknowledgement fields now have a **named refusal**. Never interpret ordinal service as HTTP acknowledgement. | This change refuses unsupported receipt/id fields before ingest. **M6, approximately 1–2 days before enabling:** gate actual arming/emission on the negotiated capability, freeze pending directives, validate receipt scope/id/view/wire digest and conflict/replay, and clear only after a matched 2xx dispatch receipt. Audit the general engine's legacy pending state as part of that work; do not convert the old lease into proof of dispatch. | Nothing more while disabled. If enabled, the gateway must send the typed directive id plus `DispatchReceipt` after actual 2xx headers, not just raw per-message bytes or geometry. |
| Canonical guidance/reduction and typed bootstrap | **Acceptable feature-off:** `guidance=false`, `canonical_reduce=false`, `bootstrap_complete=false`. | Guidance and the `ctx_reduce` schema passing replay gates confirm their existing facade surfaces, not their authority/generation binding under the new bundle. **M6, approximately 1–2 days** before enabling canonical tools/guidance; **M8, approximately 1–2 days** for optional bootstrap completion/source evidence, overlapping generation work. False flags authorize neither tool reduction nor a guessed bootstrap-complete receipt. | No more data while disabled. Enabling needs the actually served tool/system manifest and durable tool-use idempotence key; bootstrap import needs source frontier/count/digest and originals, not transformed history. |

The larger remaining changes above are a precise plan, not implementation hidden
behind the candidate's test-only builders. Estimates overlap. In particular,
geometry/raw messages being present at the gateway closes the input-availability
question, but it cannot manufacture provider generation isolation or MC-authored
frozen replacement identity.
