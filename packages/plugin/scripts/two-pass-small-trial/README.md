# Five-case direct DeepSeek trial

Run from the repository root with Bun 1.4.2. **No paid call is made by
preparation or mock mode.** The real corpus must remain in the read-only,
locally excluded `corpus-readonly/`; do not commit it or move it into internal
docs. `deepseek.json` pins its manifest and uses the existing hash-checking
corpus loader and structural preflight. The command does not enable the
two-pass historian in any installed plugin or change its model allowlist.

## Operator command

Set `CKCRED_ENROLLMENT_FILE` to the existing enrollment JSON file for the
`enrolled:mc-e2e` vault identity that has exact read access to `apikey:deepseek`
(the one containing `token`, not an API-key file). The key's exact grant is
already configured as `apikey:deepseek`; no grant substitution is needed.
Then run:

```sh
bun packages/plugin/scripts/two-pass-small-trial/run.ts --live \
  --config packages/plugin/scripts/two-pass-small-trial/deepseek.json \
  --enrollment "${CKCRED_ENROLLMENT_FILE:?Set to the existing mc-e2e enrollment JSON path}"
```

Only `--live` opens the Darwin-only `macCredentialSource`, then `fetchForRun`
fetches that grant once. The key stays in this process: no spawn, child
environment, API-key environment variable, saved credential or fallback key.
The enrollment file is never copied. All script and production-helper log
lines pass through the existing `redactedLines`; persisted artifacts also
redact raw/base64/hex key forms. A response is verbatim unless it echoes key
material, which is always redacted.

The command creates (exclusively, mode 0700):

```
.cortexkit/internal-docs/investigations/two-pass-small-trial/paid-run-001/
  run.json       # request hashes/sizes, raw responses, usage, latency, ledger
  review.md      # human-readable side-by-side review, claims, totals, failures
```

Raw request bodies stay in memory and are never copied into internal docs;
only provider responses and reviewed claims may quote private content there.
It refuses an existing run directory instead of accidentally repeating a paid
run or resetting its ledger. Do not remove an interrupted run to resume it:
unknown outcomes retain their reservations in its artifact. Any subsequent
trial needs the operator's approval of a fresh output path and a new spend ceiling.

## Selection and provider sources

One model, one repeat, cases **0, 8, 10, 12, 35**, in that order. Case 27 is
excluded because its calibration is known to be invalid. Across all 40,
recorded inputs span 432,983–483,188 UTF-8 bytes,
and claim counts span 2–32. Sent request sizes include the production system
and reconstructed enabled turn-one prompt. The enabled production builder
omits the recorded project-memory block and adds fact anchors instead.

| Case | Recorded bytes | Sent turn-one request bytes | Claims | Reason |
|---|---:|---:|---:|---|
| 0 | 449,174 | 127,141 | 2 | Fewest claims; near the lower end of sent input size |
| 8 | 463,912 | 147,199 | 32 | Joint-highest claim count; denser extraction |
| 10 | 483,188 | 167,850 | 20 | Largest recorded and sent input; larger claim set |
| 12 | 462,136 | 148,019 | 12 | Control: preserve the rule not to trust a worker's finished notice immediately after answering its question |
| 35 | 437,788 | 132,934 | 5 | Control: preserve exact memory-edit clauses and 64 KiB / >512 KiB thresholds; smaller input and claim set |

Fetched **2026-10-26 UTC** from public DeepSeek documentation:

- [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/):
  `deepseek-flash` (DeepSeek-V4.1-Flash-1017), direct OpenAI-format base
  `https://api.deepseek.com`. No OpenCode Zen route is involved.
- USD/M tokens, off-peak / peak: cache-hit input **0.003 / 0.006**, cache-miss
  input **0.15 / 0.30**, output **0.60 / 1.20**. Per token: **3e-9 / 6e-9**,
  **1.5e-7 / 3e-7**, **6e-7 / 1.2e-6**, respectively. Peak hours are 01:00–04:00
  and 06:00–10:00 UTC Monday–Friday, except Chinese public holidays.
- [Chat completions](https://api-docs.deepseek.com/api/create-chat-completion):
  `POST /chat/completions`; `usage.prompt_cache_hit_tokens`,
  `usage.prompt_cache_miss_tokens`, `usage.prompt_tokens`,
  `usage.completion_tokens`, `usage.total_tokens` are captured and checked.
- [Context caching](https://api-docs.deepseek.com/guides/kv_cache/): enabled by
  default, best effort; a repeated prefix does not guarantee a hit.

Every HTTP attempt reserves against **one run-wide $2 ledger before fetch**,
using input UTF-8 bytes plus 4,096 framing tokens and 32,000 output tokens at
peak rates, with no assumed cache savings. Known usage settles to its peak
cost ceiling. Unknown usage, HTTP refusals, timeouts and malformed responses
retain the full reservation. Reports show both the off-peak lower bound and
peak ceiling; neither is claimed as an exact invoice. Peak pricing cannot be
undercut by a pricing-window change. Observed usage costing more than that
request's reservation stops as `usage_exceeds_reservation`; a reservation that
would exceed the run-wide ceiling is refused before dispatch as `spend_cap_refused`.

Only one request is in flight. A 429 honors `retry-after` seconds or HTTP-date,
at most **two retries**, each separately reserved. With no valid header the
wait is one second. A requested wait over two minutes stops as
`credential_rate_limited`, rather than shortening it. Billing/no-credit errors
take precedence over 429 and stop the whole run as `credential_no_credit`,
without retry or key switching. Pacing is local to this command, not a global
lock on other applications consuming the same key (including web search and
agent routing).

## Request fidelity and review limits

`turnOne` unwraps the recorded seed, reference and transcript sections, calls
the production `buildCompartmentAgentPrompt` with enabled anchored facts and
no project memory, and appends production `HISTORIAN_FORMAT_INSTRUCTION`.
It calls `historianSystemPrompt(true)` rather than copying prompt text.
Requests use non-thinking mode, temperature 0.1, a 32,000-token output ceiling,
no tool surface, and no provider SDK/hidden retries.

`turnTwo` uses production validation, ordinary non-emergency tail discard,
`publishedFacts`, and `commitTurnOnePublication` in a disposable **in-memory**
store. Seeded memories use recorded IDs/revisions. Production selection and
lexical retrieval feed `buildTurnTwoPrompt`; the facts-only size-fitting loop
follows the fact-fitting portion of `reserveTurnTwo` in
`src/features/magic-context/memory/turn-two.ts`: include the coverage notice,
defer whole facts rather than truncating them, and allow the first fact alone
to exceed the 160,000 UTF-16-unit prompt limit. The request includes the same system/user
messages followed by the verbatim assistant reply and new user prompt. No
seed/reference/transcript block is regenerated from different source data.

The corpus has no recovered tool-arc metadata, emergency/force-keep state,
semantic embeddings, prior retryable backlog, or due agent-memory scores;
those are not invented. Empty published facts skip turn two as a recorded
case failure rather than sending a non-production empty reconciliation.
Production prompt functions are used for that isolated state. The command
does not run an OpenCode/Pi host or prove that an installed plugin will enable
or publish two-pass memories.

There are at most ten successful model calls, plus the specified 429 retries:
no extra grading model, format-repair requests, comparison run with project
memory removed, clause-safety-check requests, or real memory write.
The report shows **proposed** `new` fact text and `edit`/`merge`/`replaces`
final text, category, all reviewed claims, the raw decisions and summary.
The production decision labels `covered`, `conflict` and `abstain` describe
existing coverage, conflicts or deferrals, not new writes. Mechanical capture/miss and
contradiction/invention flags are lexical review leads, explicitly marked for
people to correct; they are not semantic acceptance grades.

## Provider-free checks

Preparation is local because it reads the staged Mac corpus. It writes only
metrics and hashes, not a corpus copy, and makes zero provider/vault calls:

```sh
bun packages/plugin/scripts/two-pass-small-trial/run.ts --prepare \
  --config packages/plugin/scripts/two-pass-small-trial/deepseek.json
```

Mock mode starts an in-process loopback DeepSeek-compatible server, uses five
synthetic cases (no private corpus or vault), and writes `paid-run-001-mock/`:

```sh
bun packages/plugin/scripts/two-pass-small-trial/run.ts --mock \
  --config packages/plugin/scripts/two-pass-small-trial/deepseek.json
```

Run verification on Linux:

```sh
bun test packages/plugin/scripts/two-pass-small-trial/trial.test.ts
bun run --cwd packages/plugin typecheck
bun run --cwd packages/plugin biome check --config-path scripts/two-pass-small-trial/biome.json scripts/two-pass-small-trial
```

The tests exercise both turns, conversation bytes, usage/cost arithmetic,
ledger accumulation, pre-dispatch cap refusal, 429 recovery/exhaustion,
billing precedence, and redaction. The test
`cap refusal happens before HTTP dispatch and survives in report` asserts
that a too-small budget causes no HTTP request; disabling the spend-cap guard
must make that test fail.
