# Disposable two-pass integrations

These scripts exercise real hosts without using an operator installation or its
stores. They do not enable a production profile. Candidate authorization is
written only into the staged plugin copy by `runActivation` or the mock proof's
`prepare` operation.

## Host transports

`host-adapters.ts` exports `openCode1Adapter`, `openCode2Adapter`, and
`ohMyPiAdapter`, implementing `ActivationTransport` through
`processActivationTransport`. They install pinned releases under `host-dist`,
build the staged plugin, launch a foreground host, and connect its HTTP or JSONL
session API. The releases are OpenCode 1 **1.18.31**, OpenCode 2 **2.0.22**, and
Oh My Pi **18.12.3**. Build and launch are Linux-only; use an explicitly approved,
capped container if necessary.

Create the canonical root under `$TMPDIR/magic-context/`, then supply a fresh
`installRoot` below it. `disposableEnvironment(root)` supplies all six required
storage/configuration roots. Stage/build subprocesses also receive private
HOME, cache, and temporary directories. Staging excludes `.env`, `.npmrc`, and
`.yarnrc` credential files, existing dependencies, symlinks, build output, and
SQLite stores. No host
store is copied, so there is no credential-table sanitization shortcut.

The provider endpoint must be HTTP on `127.0.0.1`. The supplied mock provider is
appropriate for the provider-free proof. A separately authorized run may supply
a scoped, single-attempt loopback provider gateway instead; that gateway must
not add unobserved retries or dispatches. `providerId`, `providerPackage`, and
`piApi` must come from the actual host catalog for a non-mock route. A display
name, a route from another provider, or the mock's settings are not provenance
for a candidate profile.

Every HTTP attempt crosses `meteredDispatch` before forwarding. Each attempt
reserves one step and zero internal retries, because a host retry is another
separately observed HTTP request. Usage comes from all captured responses, not
from the plugin's last-step summary. A dispatch's purpose defaults to
`unclassified`; an optional classifier must use observed metadata, not words in
the prompt. Unknown usage retains its full reservation.

A lazy host reports carrier `unobservable` and store `null` until durable stage
rows and open handles establish them. The store binding requires the host to
hold that exact database (or its WAL) and requires the plugin's schema. The activation driver's receipt/history inspection opens that bound store read-only.

Each `runSession` starts a foreground session. Normal runs send the supplied
prompt unchanged. The explicit `forceWrapup` mock-probe option adds a confirming
turn and `/ctx-wrapup 1` to trigger short synthetic history; it is not a normal
activation or provider-quality trial. The adapter waits for turn one to be
published and turn two to be resolved on the same retained historian child. A timeout or a
terminal failure is not credited as success. Published/resolved rows establish
only those observed lifecycle stages; these APIs do not expose the plugin's
deferred-task queue, so global scheduler idleness remains **unobservable**.
Host events are recorded, but their contracts do not attribute a cache rebuild
to Magic Context. Rebuild status is therefore **unobservable**, not zero.

## Provider-free host proof

`mock-host-proof.ts prepare <lane> <root> <install> [carrier]` writes a mock
candidate into the staged source and seeds contradicted project memory. OpenCode 1
requires its carrier argument explicitly. `reset` uses the same arguments and
recreates only the disposable host/plugin stores before seeding. Build
the plugin after preparation. `run` uses the real host with the mock, requires
Linux with only a loopback network interface, requires actual `lsof` rather than
the `/proc` compatibility fallback, reconciles every captured request with a
settled reservation, and records raw request capture plus read-only store
witnesses. The mock reports distinct synthetic token counts on every request so
a last-step-only total cannot accidentally match.

Install host packages and runtime SDKs while registry access is available, then
run the proof container with `--network none`. An approved local container must
also use its agreed CPU/memory/PID caps, niceness, a read-only worktree mount,
and only a disposable scratch mount. Override the image entrypoint explicitly.
Preserve sanitized proof outside build directories before deleting scratch.
Never treat the synthetic tariff, generated usage, or mock replies as paid
provider pricing, cache-reuse evidence, grades, or an activation result.

## Anthropic measurement and grants

`measurementTransport` first invokes its supplied Broca opener. The concrete
`brocaMeasurementRoute` opens one isolated runner route and probes
`role.describe`, but admits no inference send: the pinned TypeScript client
cannot declare the runner role version and no attested retained two-turn
raw-history wire is available. It reports that limitation through its observation
callback and returns `null` for the defined first-party fallback. The relevant
contracts are the client's `RouteOpenOptions` in `@cortexkit/subc-client` 0.11.1,
`crates/mc-module/src/dream_dispatch/broca_port.rs:125-175`, and
`crates/mc-module/src/historian_producer.rs:63-80`. Do not invent a Broca wire
format or infer raw-history preservation from retention flags.

The direct opener starts an isolated Anthropic worker. It retains exactly two
turns, preserves the actual first reply in assistant history, uses identical
first-turn cache breakpoints, performs one HTTP attempt per send, and reports
observed input/output/cache counters. The default endpoint is the first-party
Messages API; the only override accepted is HTTP on `127.0.0.1` for a mock.
`runCacheMeasurement` owns the shared meter and reserves before calling `send`.
Byte-prefix extension and a mock cache counter are not proof of real cache reuse.

`scopedCredentials` accepts a lazy broker-client constructor and an in-memory
enrollment token. It rejects non-Darwin construction before calling that
constructor. The existing `withCredential` Darwin-only fetch boundary is
unchanged. No enrollment files, host configs, or environment-key fallbacks are
read by this adapter. The trusted Mac orchestrator uses the CortexKit credential vault (CKCRED) and supplies exact grants named
`apikey:anthropic` for the direct measurement and `apikey:cline-pass` for that
OMP provider, and supplies the run-ended callback.

Linux workers accept **already-fetched** material only through the host start or
direct-client child-environment seam. Those seams consume the supplied API-key
slots after spawning; host logs and returned evidence mask the material, and
shutdown drops redaction copies. The bridge must give a worker neither an enrollment token
nor a credential-broker connection. Tests use mock material and verify the child
receives it, it is absent from argv and persisted client files, input slots are
cleared, and Linux cannot construct a broker client.

The separately authorized run still needs an attested Mac-to-container bridge.
The Mac-side orchestrator must fetch the exact CKCRED grant and hand material to
the child without `docker inspect` exposure: never `docker -e`, a command-line
argument, or a retained disk file. Use a bounded stdin handoff or child-only
tmpfs file removed after startup, erase receive buffers, redact outputs before
persisting, and notify the trusted orchestrator at run end. That bridge is not
implemented or authorized by these mock proofs. No script fetches a real grant
on import or starts an enrollment ceremony.

## Before an authorized campaign

Resolve or drop every matrix row with unresolved configuration, variant, route,
or tariff provenance; the six explicit zero tariffs are historical free-catalog
evidence, not a fresh billing attestation. Supply independent graders and their
exact tariffs/bounds, reconcile previous spending into one shared ledger, and
verify that the host's real read tool exists but every historian read is blocked,
and record a fresh host-transport send that is not refused at the Zen origin,
before any Zen run. These prerequisites are defined in
`.cortexkit/internal-docs/investigations/two-pass-validation-report.md`,
"Live validation prerequisites", and are not established by the mock endpoint. Hydrate the private corpus only through its authorized process.
Antigravity and grader credential grant names remain unresolved until their
actual auth-plugin/catalog identities are supplied. These mock integrations do
not authorize a row, an exception, a cache-reuse claim, or an allowlist change.

## Guarded OMP retention

The OMP retained/check path is separate from ordinary one-pass print mode.
Before selecting continuation, an eligible profile asks an idle instance of the
resolved OMP executable to advertise RPC v2, successfully negotiate it, and
return an empty `get_state.data.dumpTools` inventory. A missing/failed protocol
falls back to one pass with one diagnostic per runner. The actual retained child
negotiates again before its first provider prompt. Each turn requires its own
correlated `prompt_result` as well as the final assistant state; queued work must
settle before completion is credited. Bounded v2 chunks preserve UTF-8.

Only that new retained/check path disables extension discovery and user-supplied
extension entries. The shipped lean guard entry suppresses all tool registration
under its retained-OMP marker, while retaining budget-finalization refusal and
blocking unexpected tool calls even before finalization. Calibration remains
loaded without adding tools. The real child inventory and captured provider
requests must both have no tools. Plain Pi's existing guarded-RPC capability is
unchanged, and no Pi candidate or production allowlist entry is added.

Ordinary OMP print-mode discovery is deliberately unchanged. A separate released
policy finding is retained under
`.cortexkit/internal-docs/investigations/two-pass-mock-integrations/released-omp-tool-boundary.md`:
`--no-tools` alone does not exclude discovered third-party extension tools on
OMP 18.12.3. The new retained guard must not be mistaken for a released one-pass
backport.
