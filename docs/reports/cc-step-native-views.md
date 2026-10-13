# Claude Code native views and hook cuts

This continuation completes internal generation isolation, native raw-view
identities and representable whole-message hook cuts against commons
`77f10f0fcfe465e6cab567dcf1a1bf8901c54547`. It does **not** release the capability:
live discovery still omits `claude_code`, and live non-null capability selections
still refuse by name. The pinned candidate is an internal, testable format bundle,
not an attachment advertisement. No production store or native Claude Code hook
was exercised.

## Identity and storage

The daemon confirms the caller's identity at route bind; `reserved:thalamus`
identifies the Thalamus gateway module, not a request-body claim. That route,
bound to `harness=claude-code`, must declare
its Anthropic/answer-observation plan before other provider operations. Bind
incarnations prevent a new connection from borrowing an earlier route's plan.
The full declaration and component pins are immutable within a generation.
Selecting a capability after declaring without one refuses
`native_selection_frozen`; the caller cannot silently upgrade a live generation.

Profile/provider generations scope provider conversation keys, engine namespaces,
locks, message identities, views and child ledgers. The additive schema-70
migration preserves the original three-coordinate legacy keys, raw message BLOBs,
views and existing memory data. Canonical project/session coordinates remain
separate from generation coordinates; project memory still resolves through the
bound session's project. Historian/engine conversation state is generation-local.

## Frozen working view

When the engine has folded an original history prefix through a specific message
and its final top-level content part,
`compaction.raw_view` is a typed `FrozenView` with:

- immutable `view_id`, `version`, raw UTF-8 `byte_length` and SHA-256;
- `profile`, profile/provider generations and transcript `lineage_id`;
- the exact inclusive original top-level `endpoint`; its message ID matches
  `coverage.end_mid`, the stable ID of the final original message folded away;
- `payload={"kind":"inline","bytes":"<raw replacement JSON array>"}`.

The bytes are assembled from the codec's committed raw message strings, not from
parsed/re-encoded objects. The full payload corresponds to the role's `[from,to)`
replacement. Stored view metadata is checked against its generation, original
endpoint, role range/version and exact raw bytes before replay or acknowledgement.

The unnegotiated profile-only lane retains its existing no-cut working-range
replacement, without `raw_view`. The empty native Setup is also an empty insertion,
not a cut. A selected native plan cannot publish a nonempty view with no covered
original endpoint: it returns a terminal `refuse` with
`provider_code=native_endpoint_missing`, never an endpoint invented from its range.
Whole-message endpoints are supported; earlier part boundaries still refuse
`native_endpoint_unrepresentable` instead of being snapped forward.

## Native hook head and retained tail

A representable hook cut additionally publishes both
`raw_view.cut_replacement_ref` and `raw_view.retained_tail`. The reference names a
separately frozen raw array containing only the new synthetic prefix, with the
same generation, lineage and version scope as its parent working view. The mapper
uses message provenance to find that prefix; it does not assume two summaries or
interpret their text.

Every retained original top-level part is listed in transcript order as
`{endpoint:{message_id,part_index},engine_handle:"<mid>#<part>"}`. Scalar content
has part zero. Nested tool-result children are not independent coordinates.
Replacing all covered history publishes an explicit empty tail list.

This implementation supports unchanged retained native tails only. If the
working view removes, reorders or edits that tail, it refuses
`native_hook_cut_unrepresentable` rather than installing the full working-range
replacement as just a prefix. Codec signed-prefix and tool-arc admission remain
independent prerequisites. Reading a head does not acknowledge a hook cut or
provider dispatch.

## Immutable reads and bounds

`compaction.view.read` accepts the commons `ViewReadRequest` fields
`request_id`, `view_id`, `version`, `sha256`, `byte_cursor`. It can resolve either
the full view or its cut-head reference, only in the declared route's generation
and current lineage. It returns typed `page` or `refuse` answers; unknown versions,
wrong digests, invalid UTF-8 byte cursors and invalid frozen objects refuse by name.
Pages shrink until the actual escaped reply is strictly below the native envelope
ceiling. The joined UTF-8 bytes retain their original length and digest.

Large ingress messages and large inline compaction answers still refuse rather
than truncating or omitting replacement content. This is not chunked-message
ingestion or an oversized replacement-publication workaround. The internal
candidate now records `raw_view_read=true`; activation remains held.

## Capture qualification

The supplied private capture at `.cortexkit/private/14047-req-body` is 157790 bytes,
mode 0600, SHA-256
`ca6d004324b7d758d5fe7e17d6e637d468c873d7a4a4dbc7116e26e4c7cc314c`.
The Linux runner does not sync this ignored file, so the remote real-capture gate
ran **zero tests**. The file was neither copied nor committed. Synthetic signed,
redacted, noncanonical JSON and UTF-8 paging tests ran; they are not a claim of a
new real-capture replay or native hook end-to-end verification.
