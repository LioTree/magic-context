# Compartment rescoring

`/ctx-rescore` repairs the importance of stored, tiered history without rebuilding
its summaries or invalidating the provider's frozen prefix. The host runs a shared
TypeScript job service in both TypeScript and Rust transform modes. OpenCode 1,
OpenCode 2 and Pi/OMP use the same argument parser and durable job tables.

## Commands

| Form | Action |
| --- | --- |
| `/ctx-rescore` | Preview the current session and create an immutable snapshot. |
| `/ctx-rescore --project` | Preview eligible sessions of the canonical project, across harnesses. |
| `/ctx-rescore confirm <snapshot-id>` | Confirm that exact preview and start paid work. |
| `/ctx-rescore status` | Show all jobs in the canonical project, including interrupted jobs. |
| `/ctx-rescore pause` | Stop admitting batches for the newest nonterminal project job. |
| `/ctx-rescore resume` | Recover admitted spend, clear pauses, and retry pending/failed items. |
| `/ctx-rescore cancel` | Cancel the newest nonterminal project job and interrupt its carrier. |
| `/ctx-rescore undo <job-id> [base]` | Undo only selections still owned by that job. |
| `/ctx-rescore undo <compartment-id> <revision-id\|base>` | Select a validated revision of one compartment, or its original score. |

Malformed arguments are refused before database, model or carrier access. Bare
confirmation is invalid, and repeating a preview never confirms it. A newer
preview supersedes earlier unconfirmed snapshots of the same scope. Confirmation
refuses a changed model profile or newly eligible items outside the snapshot.

Commands remain available with compaction or memory collection disabled. They
never enable either feature, force history injection, or request a refresh. Undo
does not call a provider. On OpenCode 2, the host command registry works for every
client; result text uses the existing connected-TUI notification channel (the
host has no ignored-message result carrier for non-TUI clients).

## Eligibility and activation limitation

The first migrated open of `context.db` inserts one activation timestamp with
insert-or-ignore, before that process can publish historian compartments. Only
content-bearing, nonlegacy tiered compartments created strictly before that
timestamp qualify. A source identity hashes the row's original score, creation
identity, title, summary tiers and message coordinates. Rows with a revision for
that exact identity and the current scoring-rubric version are already scored;
empty P1s and boundary-only markers are also excluded. Oversize singleton requests are
counted but never sent, even on resume.

**The activation row is installation-wide, not a per-writer upgrade record.**
Writers share `context.db` and record their harness. A harness upgraded after the
activation row was inserted can keep writing rows treated as post-activation,
even if its historian was not fixed yet. Preview reports post-activation rows per
harness so this limitation is visible. It also counts eligible rows after the
display-only fix-shipped date, `2026-10-06T10:13:16Z`: stored rows have no historian
version provenance, so that count cannot prove the fixed historian scored them.
The date is not an eligibility cutoff.

## Durable work and controls

Preview freezes canonical project, target sessions, source identities, rubric,
seed policy, cost estimate and model sampling profile. Each admitted attempt is a
spend record committed before inference; only one can be admitted per job. Scoring
uses a dedicated completion with no tools, never the historian's summary/fact
publisher, and never tries a fallback model after the frozen model fails.
Validated payloads are staged privately, then published in one short transaction.
An accepted score creates a revision even when equal to the base score.

Status exposes item counts, attempt/abandoned spend counts, state, consecutive
failures, `last_error`, pause reason, waits for `/ctx-recomp`'s compartment-write
lease to be released, and the job reserving an overlapping item. It works from other harnesses without resolving their models. A lapsed
heartbeat is reported as interrupted; reopening never starts a call by itself.

Resume requires the originating harness and unchanged frozen profile. A different
process must wait for two missed heartbeats before fenced lease takeover. Recovery
publishes a saved payload or reattaches an OpenCode child without a new call; an
unrecoverable attempt becomes abandoned/failed. A carrier still provably active
keeps its reservation until termination is known. Once recovered, explicit resume
clears user, failed-item, overlap and automatic pauses, the blocker and failure
count. Sources are rehashed; changed rows become stale. Only pending/failed items
are retried. Cancel is available from any harness and is the publication cutoff.

## Score views and cache safety

- **Base:** `compartments.importance`, the original historian score.
- **Effective:** the latest selection whose revision still matches the source
  identity; an undo or mismatched source falls back to base.
- **Applied:** that same append-only view bounded by the watermark committed with
  the runtime's frozen m[0] bytes.

`/ctx-status` shows these separately and labels effective/applied differences
**pending next natural rebuild**. The dashboard compartment cards do the same for
rows with selections; untouched rows retain the existing single-score badge.
TypeScript stores its applied watermark in `session_meta`; Rust stores its own in
`store.db`'s `mc_cache_state.meta`. When both caches exist, the dashboard labels
both applied views (TS/Rust) rather than guessing which runtime served the session.
All dashboard reads are read-only, including source validation.

Publication and undo append sidecar revisions/selections only. They never update
compartments, history revisions, boundary identities, mutation logs, epochs,
refresh/force flags, m[0]/m[1] bytes or materialization time. Raw loaders retain
base scores. Render-only copies adopt scores on an independently required HARD
fold, committing the acquired watermark with their bytes; selection changes are
not fold reasons. TypeScript/Pi adopt the latest acquired view on every committing
HARD. Rust's byte-identical marker HARD keeps its previous view and watermark;
cache-loss folds adopt the latest view. Noncommitting renders stay at the applied
watermark. m[1], the recently added history after the frozen m[0] baseline,
continues to render at P1 (the most detailed summary tier).

## Verification

Command-surface tests exercise invalid grammar before dependency access on all
three hosts, snapshot-bound confirmation, cross-harness status and pause clearing.
Score-visibility tests distinguish publication and undo from adoption. Dashboard
reader tests share the canonical identity goldens and cover selected/unselected
rows, pending adoption, undo and stale sources without writes.

The live check uses a throwaway real OpenCode host with a local deterministic
provider and seeded history. It samples `lsof` before and after, runs preview and
snapshot confirmation through the host command endpoint, compares the actual wire
m[0]/m[1] bytes on subsequent passes, then changes the model to cause a natural
cold fold. It uses no rescore force/refresh mechanism and no operator model routing
or credentials. Captured evidence is reported with the delivery.
