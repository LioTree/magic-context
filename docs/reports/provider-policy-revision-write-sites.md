# Provider policy revision writer coverage (store version 70)

The revision is per engine namespace, not per harness/conversation. Conversations
sharing an engine therefore observe each other's changes. Store migration 70
adds `mc_provider_policy_revisions_v1` and the derived
`mc_provider_policy_preparations_v1` cache. The revision counter is shipped with
its namespace; preparations are reset when sessions move stores or conversations
change engine namespace. A prepared row is usable only when its saved revision
matches the current revision before `provider_host_hook` admits the actual message
and mutates its policy parts, and the settings/original-baseline key still matches.

## SQL coverage

Here “burn” means invalidating an unserved answer/tag, an ancestor cut is the
highest inherited ordinal, and a before-image is the old policy JSON retained
once per changed row. Its frontier is the set of changes since the summary or
preparation snapshot. Legacy conversion normalizes older serialized records into
these tables; historian updates come from background history compaction.

Every INSERT/UPDATE/DELETE of the following provider input tables has a revision
trigger. `mc_tags` and `mc_cache_state` writes bump only when that namespace has
provider conversations; without one they cannot feed an ordinary provider hook.
Updates resolve both old and new namespaces; duplicates in that set are removed.
Counters advance in the writer's transaction, so rollback also rolls back the
bumps. Explicit overflow checks use `RAISE(ABORT)` even if the outer write uses
`OR IGNORE`. Collision-free insert-then-update avoids inheriting a caller's
conflict policy. Rewrites conservatively bump even when values happen to match.

| Table | Inputs / writer sites covered |
| --- | --- |
| `mc_provider_conversations_v2` | frozen plan/settings/preset, engine policy/calibration/protection/baseline, surviving policy/cadence state; `save_conversation_tx`, engine policy save, pass/hook counter writes, catalog/historian updates |
| `mc_provider_lineages_v1` | root/descendant membership, first ordinal and ancestor cuts; `ensure_lineage_tx`, normalized legacy conversion and direct lineage edits |
| `mc_provider_messages_v1` | held/newest message admission and immutable-confirmation inputs; `insert_message_tx`, normalized legacy conversion and direct writes |
| `mc_provider_policy_parts_v1` | content-free measurements, tag/arc identity, protection/served/active/queued/reduced state; engine rewrite, admission, promotion, burns, queueing, baseline restatement and direct insert/replace/update/delete |
| `mc_provider_hook_answers_v1` | pending/live/burned policy and cadence/grace transitions; delta answer allocation, promotion/burn, drop consumption/queue updates and normalized legacy conversion |
| `mc_provider_policy_summaries_v1` | normal bounded policy summary; `save_policy_summary_tx`, `drop_policy_summary_tx`, invalidation/tampering/direct writes |
| `mc_provider_policy_changes_v1` | first-before-image log and its exact frontier; policy-part/consumed-tag triggers, summary save/clear, invalidation and direct edits |
| `mc_provider_pending_drops_v1` | queued/consumed release identity; queue, burn and consumption transactions |
| `mc_provider_legacy_tags_v1` | older-lane live/burned tag state, including normalized legacy conversion |
| `mc_provider_consumed_tags_v1` | namespace-wide deactivation/reactivation/renumbering; drop consumption and direct insert/update/delete |
| `mc_tags` | durable namespace tag/protection rows; tag insertion/promotion, core tag writes and direct edits, when the namespace has provider conversations |
| `mc_cache_state` | committed engine state/settings/protection supplying policy; engine/meta writes/reset/delete, when the namespace has provider conversations |

Moving a conversation to another namespace advances both the old and new
namespace revision counters. `INSERT OR REPLACE`
can delete a conversation without firing DELETE triggers when recursive triggers
are disabled, so a BEFORE INSERT guard also fences the existing old namespace.
A conversation DELETE resolves its namespace before the row disappears. Orphan
rows without a conversation cannot feed an ordinary provider hook; creating a
new conversation itself advances the namespace revision.

The prepared cache is not a normal policy summary/baseline: writing or deleting
its row does not bump the input revision or acknowledge/serve anything. The
first-before-image log may run while a preparation exists, without eager baseline
publication. A namespace change, conversation deletion or unsupported part
move/deletion discards derived preparation. Normal engine summary invalidation
also discards preparation before bulk policy rewrites.

The host's in-memory protected-token/tool-window settings must also match the
resolved settings key; SQL cannot version such a process-only change. Cached
OpenCode message JSON and the step-answer encoder are outside this preparation
and are not cached here.

## Tests and required non-vacuity

`provider_preparation::tests::every_policy_input_table_write_advances_the_revision`
performs independent raw SQL input writes and checks the durable revision after
each transaction. Rollback and ignored-writer overflow have separate tests.
Namespace move/replace/delete tests fence old/new spaces, and a sibling harness
invalidates a stored preparation. The admission test proves the revision check
occurs before the real hook's own message mutation, rather than always missing
after that mutation. A deliberate omission of a policy-part revision trigger must
fail the writer-coverage test; it is not enough merely to inspect trigger names.

To reproduce the omission control, disable the policy-part UPDATE revision trigger
with `WHEN 0`, then run
`cargo test -p mc-store every_policy_input_table_write_advances_the_revision`.
It must fail on the protection/measurement UPDATE despite that SQL write succeeding.
In the executed control exactly that test failed (0 passed / 1 failed; 348 filtered);
the mutation diff was two inserted lines and restoration left `git diff --stat`
empty. This checks the durable revision, not the presence of a trigger name. The version-62 migration fixture removes
version-70 triggers/new tables before rebuilding its historical schema, because
those triggers reference provider tables absent at version 62; its historical
migration expectations are unchanged.
