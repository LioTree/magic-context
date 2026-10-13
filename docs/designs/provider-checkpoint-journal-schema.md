# Provider checkpoint and journal schema proposal

Status: **proposal only; no migration or serving consumption authorized**.
The proposal replaces the provider's full-array rebuild with a fold over maintained
state, leaving other transform routes alone. The project owner approved effective
rather than physical private-cell identity. Ordinary hooks, including the first
hook after a restart with a valid compact checkpoint, target <=10 ms; ordinary
folds, including decay re-tiering at 2,300 compartments, target <100 ms. Missing,
corrupt or stale checkpoints recover off the serving path and refuse with a named
retryable code. Large all-new-content/model-upgrade/memory-body cases have separate
measured bounds, not larger hidden product fences.

This schema proposal adds concrete relations and publication/recovery cuts to
`provider-resident-incremental-state.md`. The companion reader/writer
inventory is `docs/reports/provider-resident-reader-writer-inventory.md`.

## What exists and what can be reused

- Store migration 70's namespace policy revision covers provider policy inputs and
  engine/cache/tag writes transactionally. It is a freshness fence, **not a replay
  journal**. The existing per-conversation policy changes retain first before-images
  while a summary/preparation exists, not every transaction in order.
- Engine cache row version/CAS, immutable view versions/ranges, lineage ancestry,
  persisted frame bytes/sections and current receipt validation remain authority.
  Do not duplicate/redefine their serialized representations.
- Context compartment-history generation/version/rewrite-version, score selection
  watermark, memory row revisions/mutation cursor/fragment watermark, workspace
  fingerprint and project/profile epochs remain inputs to the domain vector.
  Max-id/watermark alone misses in-place updates, deletes and counter recreation.
- Pending context publication already has a durable store half followed by a
  fenced context half. The checkpoint must distinguish pending from applied;
  it cannot assert that two separate databases committed atomically.

A new store/context **generation nonce**, render-domain change clocks and an ordered
journal are needed where existing revisions/sections cannot express the contract.
Reuse existing sections for frame payloads and use references to immutable view
rows, not another full HostView JSON copy. Concrete migrations require another
review/authorization after this proposal.

## Proposed relations

Names are proposed and versioned; none exists in the current store. INTEGER
counters must check signed-64-bit overflow and fail, never become SQLite REAL.
Generations/nonces are opaque bytes/strings with equality, never wall timestamps.

| Relation | Key and columns | Authority / move classification |
| --- | --- | --- |
| `mc_provider_store_identity_v1` | Singleton: store_generation, schema_encoding_version. Rotate on reset/replacement/import; runtime store-instance identity is additionally required for in-memory actors. | Store identity, not portable actor state. Recreate/rebind at destination. |
| `mc_provider_baseline_epochs_v1` | PK (conv_key, generation). Namespace, original baseline identity, lineage/cut hash, actual newest ordinal and first-part position, coverage, unit_version, calibration ratio bits, baseline scalars, frozen-fact page root, accounted policy/event frontier. | **Authoritative, Ship**. It defines effective frozen measurements. Keep old generations while a current before-image/export requires them. |
| `mc_provider_measurement_overrides_v1` | PK (conv_key, generation, lineage_id, block_id). Full effective typed measurement JSON (not summed totals), content/identity hash, basis event/version. Optional group/range fact pages record frozen protection/tag/queue facts without one update per old part. | **Authoritative, Ship** with the epoch. Do not classify this as disposable cache. |
| `mc_provider_namespace_events_v1` | PK (engine_namespace, event_seq). Transaction/group identity, event kind, affected conversation/lineage/id/cut, old/new epoch or immutable locator, payload/page reference. Unique causal source identity for retries. | Delta recovery data. Retain until a current complete checkpoint accounts for it; move only with a rebased source generation or discard after logical materialization. |
| `mc_provider_checkpoint_heads_v1` | PK (engine_namespace, conv_key). Store generation, encoding/build identities, accepted engine row version/policy revision, ancestry/cut, domain vector, namespace/context frontiers, compact active-header payload, page root, ready flag. | **Derived, Discard** on move/reset/encoding mismatch. Checkpoint writes do not bump policy revision. |
| `mc_provider_checkpoint_pages_v1` | PK (checkpoint_id, page_kind, page_number). Encoding, compressed/uncompressed lengths, checksum, immutable payload or existing-section locator. Kinds: policy aggregates/indexes, tail native+CK/sidecars, tag/treatment indexes, fragment catalog/token data, accepted output chunks. | Derived pages; historical payload locators refer to existing authority. Per-page verification, not an eager full-arena hash on the first hook. |
| Context `provider_render_clocks_v1` | PK (domain_kind, owner_identity). Context generation, monotone render_revision, event frontier. Domains: history/dates/events/facts, score, memory/visibility/order, workspace/project, profile/notes/mural. | Current domain authority clock, updated by table triggers in context.db. |
| Context `provider_render_events_v1` | PK (context_generation, event_seq). Transaction/group id where available, domain, owner, object key, action, source revision and changed-row/immutable before-image locator. | Indexed domain deltas; preserve transaction order and before-image epoch. |

Index namespace events by `(namespace,event_seq)` and context events by
`(owner,domain,event_seq)`. Index policy pages by ordinal and block/tag/arc identity;
index overrides by exact epoch and part. The existing public PolicyIndex interface
resolves epochs plus point/group overrides. Physical source JSON is never an
alternate authority after an epoch applies.

A frozen-fact page records the measurement **at its baseline generation**, not
live current protection. For example, a later queue/window change must not rewrite
a previously frozen measurement until the old path would refreeze. The original
engine baseline/pending mismatch is retained until real newest-message admission.
Descriptor applicability excludes that newest message exactly; a header-only new
message advances the cut. Resolving an old change before-image uses the old epoch,
not today's descriptor.

## Publication, direct SQL and cross-database ordering

1. A provider transaction writes new admitted data/answers/tags, any authoritative
   epoch/override changes, journal events and the usual counters/receipts together.
   Store migration 70's triggers still advance policy revision for authoritative
   policy/conversation/tag/cache-state changes. Derived checkpoint writes do not.
   The namespace coordinator / conversation actor
   publishes its new immutable in-memory root only after commit succeeds.
2. One provider fold gate drains the bounded journal delta, uses current permitted
   model/config/usage/temporal state, and prepares changed pages/output. Validate
   engine row version, policy revision, lineage, view existence/eligibility and the
   **actual applied** domain vector before publishing its accounted frontiers.
3. Context writers append context events and advance render clocks **inside their
   context transaction**. SQLite triggers cannot generally write into another
   attached database's table; do not put a fake atomic store-journal append in a
   context trigger. The store header records the observed context generation and
   frontier, and later domain changes remain pending for the next authorized gate.
4. Bulk namespace/full-array/reset/import writers invalidate the coordinated
   checkpoint and old epoch applicability in their existing transaction. An
   external writer with an uncovered table/column cannot leave ready=true. The
   table/column registry and direct-SQL mutation tests are part of the migration
   review, not assumptions made by an in-process actor.
5. Checkpoint/journal compaction publishes a new page root + accounted frontier
   atomically, then removes only older accounted events/pages not referenced by a
   retained epoch/view/export. Crash at any cut leaves an old valid root or a
   not-ready root, never an invented acknowledgement or lost newer event.

View state changes/removal need their own indexed fence/event: migration 70 does
not make an immutable-row locator valid indefinitely. Shared engine namespaces
use one coordinator; independent conversation mutexes are insufficient.

## Compact ready-state recovery

Do **not** load the prototype's whole 90 MiB arena on the first hook. A valid
checkpoint restores a small active header plus bounded pages: <=500 native tail
messages, current window/arc/hint candidates, current baseline aggregate root and
needed fragment/output descriptors. Historical per-part/tag/treatment facts remain
in indexed immutable pages; no full JSON part/lineage/hook-answer replay occurs.
Policy prefix/range indexes have bounded page heights, with logarithmic queries
and delta edits; quantify touched pages, not just logical row count.

Validate header generations/versions/frontiers and required pages before ready.
Per-page checksums and root identity avoid touching every historical payload at
startup; use a reviewed safe byte codec with explicit lengths/UTF-8 boundaries,
not unchecked mmap casts. Open-store/validation/page I/O and any journal replay
are in the separate **valid-checkpoint restart** latency population. If replay lag
or page misses cannot fit that bounded active set, the checkpoint is not ready.

Missing/corrupt/stale checkpoint: proposed retryable code
`provider_checkpoint_not_ready`, with recovery scheduled outside the serving
transaction. No tag reservation/promotion/burn/ops publication while refusing.
The existing host last-good/fallback mechanism handles this refusal. Measure
startup recovery time and refusal count; do not subtract recovery from a claimed
first-request success. No such code or host route is implemented now.

## Ordinary re-tiering and exact token accounting

Maintain cached fragments for all supported tiers, including archived/heading-only
outputs and temporal-date variants. Cache key includes every stored source field,
selected score, tier/options and **actual renderer/tokenizer/vocabulary identity**.
Keep the exact key tuple with its digest; a digest alone is not equality. Score
publication does not itself grant fold permission.

Normal HARD decay can move many of 2,300 compartments between tiers. Reuse those
per-tier fragments, update selection/prefix indexes, and assemble the accepted
frame; do not re-render/tokenize every body. This still costs output bytes, which
must be measured and bounded separately from cached facts.

**BPE counts are not automatically additive.** `mc-tokenizer::estimate_tokens`
counts Claude byte-BPE (`mc-tokenizer/src/lib.rs:70-78`), and the old retry check
estimates the combined session-history slice (`m0_compose.rs:356-359`). The schema
therefore needs exact join/separator boundary token information, not merely a sum
of standalone fragment counts. Prove boundary correction against the independent
whole-string tokenizer for every tier/escaping/date/empty/archive variant, or keep
an explicitly measured exact combined-count fallback until that proof exists.
No cache may choose a different tier merely because a prefix sum is cheaper.
Model/upgrade all-new-content and huge bodies remain separately measured cases.

## Review items before implementation

- Approve exact epoch/override applicability and old-before-image resolution,
  including all effective readers and the generic agent-move exporter/importer.
- Approve the store/context table-and-column clock registry, generation reset
  rules, journal compaction and cross-database pending/applied publication cuts.
- Approve bounded active checkpoint/page codec, safe recovery, refusal semantics
  and **valid restart** first-request measurement; no full resident-arena restore.
- Require standalone-tier plus joined-BPE count proofs, all-tier decay assembly,
  output bytes and retained/transient/shared-memory accounting.
- Then run the existing byte/state differentials and per-change/key mutations
  before any serving consumer or migration. Until that review, only the offline
  builder/input/index proofs exist; performance targets and canary remain blocked.
