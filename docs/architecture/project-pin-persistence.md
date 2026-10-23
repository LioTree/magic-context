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

## TypeScript pin persistence

OpenCode, OpenCode 2 and Pi publish accepted pins to the process's identity cache
before completing a session-start decision. Exact-directory and common-Git-directory
reads consult this overlay before disk, including after failed or overflowed writes.
The first accepted identity wins; coalescing persistence never authorizes changing it.

`memory/project-pin-writer.ts` (under `packages/plugin/src/features/magic-context/`)
keeps at most 256 queued destinations and one active write. Repeated publications
for a destination coalesce. The separate identity cache can retain more folders
than the queue limit. Overflow and write failure retain the in-memory pin;
the next exact-directory decision/read retries enqueueing, without a busy retry loop.
Standalone legacy git-sidecar writes are unchanged.

One lazy `worker_threads` worker serializes and calls the unchanged
`writeStorageFileAtomicSync` with the permission policy captured by the host. The
atomic helper still creates a private sibling and renames it; unlike Rust's helper,
it does not fsync. The worker is emitted beside the built plugin in OpenCode v1/v2
and Pi/OMP packages. Worker failure never falls back to writing on the host thread;
the next queued attempt starts a fresh worker.

On natural process exit, `beforeExit` stops admission and allows a best-effort drain
of at most 250 ms. The idle worker is unreferenced and does not keep the host alive.
An explicit `process.exit`, signal termination or crash can bypass the drain.
The crash and restart semantics above also apply to these best-effort TypeScript pins:
session decisions and host rows do not wait for durability.
