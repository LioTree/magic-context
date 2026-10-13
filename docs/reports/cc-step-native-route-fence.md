# Native route publication fence

An already-admitted step could write and return an old generation's view after
its route was rebound. This closes that race, reported in
`cc-step-native-independent-review.md` against base `7226c42d`.
The independent review and its original test module were imported from
`edefb0cd7e1068abf00fd146e18c74abdf2cc417` before this fix.

## Refusal and atomicity

After awaiting store access and the conversation's serial lock, native steps,
hooks and view reads validate the captured daemon-bound route against the current
binding table. They require the same connection incarnation, profile/provider
generation, principal, project, session and harness. A mismatch returns the named
RPC refusal `native_route_stale`, not a hook `pass`, view page or compaction view.

The check returns a guard holding the binding-table mutex. That guard remains live
through the synchronous store work and response construction. Route bind and
unbind acquire the same mutex to change the binding and clear its native plan;
their nested lock order is binding table, then native plan table, as in plan
installation. Thus a lifecycle change cannot occur between the identity check
and native writes/publication. No synchronous guard is held across an await, and
no route lock is held while waiting for the conversation's serial lock.

Native Setup uses the same fence because it also awaits after plan admission.
OpenCode and Broca do not acquire this native-operation guard. Capability
publication remains held; no store migration or shared role type was changed.
The unpublished capability bundle derives its provider-generation identifier
from the plan/view source. Its fixed JSON test fixture now pins the changed
identifier, so the corrected source cannot accidentally reuse the earlier bundle.

## Regression coverage

The original test name
`review_witness_old_generation_step_commits_after_rebind` is retained so the
independent reproduction command remains valid. Its assertion is deliberately
inverted: the late step must now refuse and leave the old conversation, messages,
lineage, views, hook answers and engine state unchanged.

Equivalent queued-operation witnesses cover `transform.hook` and
`compaction.view.read`. The read witness proves that its seeded frozen view is
readable on the current route before queuing the stale request. Each witness
uses the real dispatcher and a fair serial-lock handoff between admission and
effects, without sleeps, LLM calls or live stores. A separate check verifies that
`native_publication_fence` holds the binding-table mutex and rejects both a
replaced connection with an unchanged generation and a changed generation on
the same connection. Neither coordinate can substitute for the other.

The mutation controls remove each operation's effect fence separately. The
expected failures are the inverted step witness, the stale-hook witness and the
stale-view-read witness respectively; passing controls and restoration evidence
are recorded in the delivery declaration. The codec's real-capture round trip
was independently verified in the imported review, not rerun or newly claimed
by this lifecycle-only fix.
