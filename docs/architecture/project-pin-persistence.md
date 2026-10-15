# Registered project pin persistence in ck-mc

An accepted Entorhinal answer still determines the route's identity at bind time.
The folder must remain eligible, the answer must arrive within the 500 ms resolver
deadline, and a registered answer cannot replace an identity marked in the store's
`authority_managed` table. That marker protects data already associated with the
existing key until an offline migration can move it safely.
Existing exact pins still take precedence over live answers; linked worktrees
and nested registrations retain their existing pin-authorization rules.
Persistence is not part of the bind's completion condition.

`ProjectIdentityResolver` publishes an authorized pin to a process-wide identity
cache before returning. Exact-pin reads and common-Git-directory lookups consult
that cache before sidecars. The first accepted pin takes precedence over sidecars,
cached git answers, and competing live answers, even after a failed write. The
failure affects durability, not the identity returned in this process.
A separate, single writer thread performs serialization and
the existing atomic file write (temporary file, file fsync, rename, permissions).
No writer lock is held during filesystem work.

The work queue contains at most 256 distinct sidecar destinations, plus one active
write. Queued snapshots are keyed by destination and coalesce latest-wins; that
persistence policy does not authorize changing an already accepted identity.
The identity cache is not a queue and can retain more folders than the work cap.
On saturation, a new pin remains visible in memory but is not queued. A later bind
for that folder retries enqueueing if persistence has not completed. Saturation is
logged once until the worker next frees a slot. Failed writes follow the same
retry-on-next-bind policy, without a busy retry loop.

On normal exit from `serve_with`, ck-mc stops accepting writes and drains for at
most 250 ms, including when serving returns an error. Any remaining queued work
is abandoned; an active filesystem operation cannot be cancelled. A hard process
termination bypasses this flush, just as a crash does.

## Crash semantics

A crash before a pin lands loses only that best-effort pin, not any store rows.
While the process is alive, a route retains its bind-time choice regardless of
the writer's progress. On restart, a host `session_projects` row still takes precedence.
With no such row and no durable pin, a new binding resolves again. If Entorhinal's
registration has changed, or it is unavailable and fallback rules apply, that new
binding can have a different identity, even for the same session name.

This follows the existing rules: an exact pin wins over any later registered
answer, and a bound route keeps its initial decision. Those rules do not guarantee
that a process-local choice survives crashes. Pin persistence was already best effort;
the asynchronous lane extends the window in which a crash can lose it. Stable
attribution across that window requires a durable host session row or a completed
pin. The cases in `test-vectors/project-identity-parity.json` verify precedence of
existing sidecars, not survival of an unpersisted choice across crashes. Callers
requiring cross-restart stability must not treat enqueueing as durability.

## TypeScript hot path (unchanged)

The plugin has the same synchronous pin-write concern: `session.created` awaits
the identity decision in `packages/plugin/src/hooks/magic-context/event-handler.ts:350`.
`memory/session-identity-decision.ts:123` calls `rememberResolvedProjectIdentity`,
and `memory/project-identity-cache.ts:90` calls `writeStorageFileAtomicSync`.
These `memory/` paths are under `packages/plugin/src/features/magic-context/`.
`packages/plugin/src/v2/hooks/context.ts:977` also awaits this decision when
preparing resumed sessions. This change does not alter the TypeScript path.
