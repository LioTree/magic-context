# BEAM benchmark harness for Magic Context

Runs the BEAM long-term-memory benchmark (Tavakoli et al., *Beyond a Million Tokens*,
[arXiv:2510.27246](https://arxiv.org/abs/2510.27246)) against Magic Context in a real OpenCode
host, following the authors' **released code** at
[`mohammadtavakoli78/BEAM@b2da22e`](https://github.com/mohammadtavakoli78/BEAM/tree/b2da22eac88bb0874c64665f13457eb99835774a)
wherever it and the paper's listings differ. No question annotation (rubric, hint, expected
behaviour) ever reaches the answer model.

Two arms run on the same conversations, with the same answer model, question text and judge:

- **vanilla**: the released long-context baseline. Every turn is sent as a chat message
  (`role`, `content`), followed by the question wrapper; no system message.
- **mc**: Magic Context. One OpenCode project and one session per conversation; the history is
  compacted by Magic Context's own incremental historian; each question is asked from a fresh copy
  of the post-ingest stores through the real host, with `ctx_search` and `ctx_expand` available.

## Files

| File | What it does |
| --- | --- |
| `run.ts` | CLI: `prepare`, `verify-prompts` / `--verify-prompts`, `list-credentials`, `smoke-transport`, `vanilla`, `mc`, `summary` |
| `dataset.ts` | BEAM rows to ordered turns with timestamps, and the probing questions |
| `parquet_to_jsonl.py` | One-time parquet to JSON Lines conversion (pyarrow in a private venv) |
| `prompts.ts`, `prompts/` | Vendored prompts, the prompt-set interface, and the verbatim check |
| `scoring.ts` | Nugget averaging, LLM alignment and Kendall tau-b for event ordering, summaries |
| `llm.ts` | Direct ChatGPT Codex backend client (Vanilla answers and every judge call) |
| `credentials.ts` | The only module that reads credentials (vault, or fixed fakes for the stub) |
| `host.ts` | Throwaway OpenCode roots, host config, start/stop, `lsof` isolation, snapshot/restore |
| `store-writer.ts` | Writes the conversation's turns into the stopped host's OpenCode store |
| `boundary-probe.ts` | Production protected-tail boundary, to size the raw tail kept by `/ctx-wrapup` |
| `relay.ts` | Loopback relay from OpenCode's Gemini provider to Cloud Code Assist |
| `stub.ts` | Local stand-in for Codex, Cloud Code Assist and Voyage, for credential-free runs |

## Data and isolation

Everything the harness writes lives under `packages/plugin/scripts/beam/.runs/` (git-ignored),
or under `$BEAM_DATA_DIR` when set: the dataset cache, the Python venv, the OpenCode binary,
throwaway host roots (`roots/`), and run outputs (`runs/<run>/`).

Each host runs with HOME, every XDG directory, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` and
`TMPDIR` inside its root, and `lsof` on the host and its children is sampled at the start and end
of every host session; any database outside the root stops the run. Samples go to
`runs/<run>/mc/isolation.jsonl`. After each host session the OpenCode store is checked for
credential or account rows. The live stores are never opened.

## Credentials and transport

Real runs read credentials only at run time, on the Mac that holds the vault:

- **ChatGPT (answer and judge)**: `chatgpt:openai*` through the `mc-e2e` enrollment
  (`~/.config/cortexkit/mc-e2e/enrollment.json`, or `MC_E2E_ENROLLMENT_PATH`), `getScoped` with a
  15-minute minimum lifetime. With more than one granted ChatGPT row, choose one with
  `--chatgpt-credential` (`list-credentials` prints the non-secret inventory).
- **Antigravity (historian)**: `antigravity:google`; the token plus its `project_id`.
- **Voyage (embeddings)**: the key file `~/.config/voyage.key` (`--voyage-key-file`).

No token is written to disk. The host configs reference them as `{env:NAME}` and the values travel
only in the host's environment. `report_auth_failure` is never called; a 401 or 403 from any
upstream stops the run without retrying, and a 429 stops it too (resume later).

Each subscription credential has its own refresh getter. It reuses a token only while its
expiry is more than 10 minutes away, or for less than 30 minutes when the vault gives no expiry.
Concurrent callers share one vault read; every read requests the same 15-minute minimum lifetime.
A refresh refusal stops the run with exit 3 and the vault's reason, without falling back to the old
token or retrying the read. All token versions remain in the in-memory log scrubber until exit.
Direct answer and judge requests resolve credentials on each request (including transport retries),
the historian relay resolves them on each forwarded request, and each host spawn resolves a fresh
Codex environment. The vault client stays connected until the run ends.

The long `/ctx-wrapup` command uses only the configured Gemini historian through the relay:
the production command hook ends it with a sentinel before OpenCode can forward it to the answer
model. Its host can therefore hold an unused Codex environment for more than 30 minutes. Question
hosts restart from the snapshot for each question and have a 30-minute answer request timeout;
their Codex environment is fixed for that host's lifetime, not updated in-place.

How the throwaway host reaches each upstream without any OpenCode auth plugin or stored login:

- **Codex backend (answer model)**: OpenCode's built-in `openai` provider with
  `baseURL https://chatgpt.com/backend-api/codex`, the access token as its API key (so
  `Authorization: Bearer`) and a static `chatgpt-account-id` header. OpenCode itself sends
  `store: false` and drops `max_output_tokens` for this provider. OpenCode fills the Responses
  `instructions` field only when a ChatGPT login is stored, so here the system prompt travels as a
  `developer` input item; the transport smoke test shows whether the backend accepts that.
- **Cloud Code Assist (historian)**: OpenCode's `google` provider pointed at the loopback relay
  (`relay.ts`). The relay listens on `127.0.0.1` on a random port and accepts only the per-run
  random key. Both host `:streamGenerateContent` and `:generateContent` use the upstream's
  streaming-only `POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`.
  There is no fallback to the production endpoint. Streaming host calls receive unwrapped SSE;
  non-streaming calls receive JSON with all text deltas collected and final usage retained.

  The route uses **`node:https` over HTTP/1.1**, not `fetch`, to preserve the native agy CLI 1.3.5
  header order: `Host`, `User-Agent`, `Content-Length`, `Authorization`, `Content-Type`,
  `Accept-Encoding`. The user agent is
  `antigravity/cli/1.3.5 (aidev_client; os_type=<darwin|linux|windows>; arch=<arm64|amd64>; cl=998863838; auth_method=consumer)`;
  encoding is `gzip`. No `X-Goog-Api-Client` or `Client-Metadata` is sent. Loopback tests use
  `node:http` and assert the actual HTTP version and raw header order, not a preflight proxy.

  The ordered envelope is `{ project, requestId, request, model, userAgent: "antigravity", requestType: "agent" }`.
  The request's ordered keys are `contents`, `systemInstruction`, `tools`, `toolConfig`, `labels`,
  `generationConfig`, `sessionId` (optional host fields are omitted when absent). `contents`,
  `systemInstruction` and `tools` remain byte-equal JSON. Every override/addition is named in
  `CLOUD_CODE_FIELD_ALLOWLIST`: validated tool calling mode, labels, thinking configuration,
  maximum output tokens, and session id. Unknown host fields or a final non-user turn are refused,
  not dropped/rewritten to make the payload fit. The historian sends no tools.

  `--historian-variant low|medium|high` selects `gemini-3.8-flash-{variant}`, a thinking budget of
  1000/4000/-1 and model enum M320/M319/M318 respectively; default **medium**. All variants set
  `includeThoughts: true`, `maxOutputTokens: 65536`. `summary.json` records the exact model,
  variant and controls. `--historian-model`, if given, must match the variant.

  A harness-only `chat.headers` hook forwards the actual OpenCode child session id and workspace
  URI **only to the loopback relay**; neither header is forwarded upstream. The relay keeps a
  conversation/trajectory UUID pair per child session and workspace. The request id is
  `agent/<conversationUuid>/<timestampMs>/<trajectoryUuid>/<last_step_index+1>`. Labels are the
  native string-valued `last_step_index`, `model_enum`, `trajectory_id`, `used_claude`,
  `used_claude_conservative`, `used_non_gemini_model` (the last three are always `"false"`).
  Steps count history content turns, not parts (one user turn has index `"0"`). No execution or
  cascade ids are invented. `sessionId` is the signed-decimal FNV-1a 64 hash of the workspace's
  `file://` URI and is shared by child sessions in the same workspace, not by different workspaces.

  The log records method, path, status, time to headers, byte counts and token counts. Failed
  upstream responses include their complete secret-scrubbed body in `errorBody`; successful
  bodies, request bodies and headers are never logged. Error bodies returned to the host are
  scrubbed too.
- **Voyage**: Magic Context's `openai-compatible` embedding provider, `voyage-4`,
  `input_type: document`, `query_input_type: query`, `max_input_tokens: 8192`.

## Protocol

| Item | Choice | Source |
| --- | --- | --- |
| Dataset | `Mohammadta/BEAM` revision `3205395e897e7318c7b094ef4e6047b9b82dbb03`, split `100K`, conversations 1-5 | Hugging Face |
| Turns | Every turn in order; noon UTC on the session's day plus one microsecond per turn (OpenCode stores milliseconds) | past.dev `dataset.py` |
| Question turn | `long-context-question.txt` verbatim, whitespace included, as turn \|T\|+1 in both arms | `long_term_memory_methods.py:587-592` |
| Nugget judge | `judge.txt` (the code's version of Listing 20; no question slot) as one user message, score per nugget, mean over nuggets | `prompts.py`, `compute_metrics.py` |
| Event ordering | answer split on `\n`; each line aligned to the first unused reference nugget the equivalence prompt calls the same (`"yes"` anywhere in the reply); Kendall tau-b over union ranks; reported score `(tau_b + 1) / 2` | `compute_metrics.py:align_with_llm`, `event_ordering_score`, `report_results.py` |
| Headline | mean over questions; per-ability means beside it | §2.4 |
| Answer and judge model | GPT-6 Luna (`gpt-6-luna`) on the ChatGPT subscription, reasoning effort `none`, temperature **not set** | operator choice; the Codex backend rejects `temperature`. This deviates from the paper's temperature 0; the paper's judge was `gpt-4.1-mini` (`src/llm.py`) |
| Historian | Gemini 3.8 Flash medium on Cloud Code Assist; native CLI thinking budget 4000, includeThoughts true, maxOutputTokens 65536; other generation settings unchanged | operator-provided AGAUTH native CLI 1.3.5 wire contract |
| Dreamer | off | brief |

`prompts/released/` holds the strings the harness sends, extracted as Python runtime values from
the pinned commit; `prompts/listing-*.txt` hold Listings 20, 21 and 44 from the arXiv v2 TeX
source, kept for comparison. `provenance.json` records each file's source and SHA-256, and
`--verify-prompts` re-downloads both sources and compares every byte. Differences between the two:

- the released judge prompt has no `QUESTION` slot and its responsiveness rule is not anchored to
  the question (Listing 20 has both);
- the released equivalence prompt is a system message (with the typo "exaplanation") plus a user
  message with indentation; Listing 21 is one block;
- the released code also runs the nugget judge on event-ordering questions, but its report reads
  only `tau_norm` for them, so the harness skips that extra judging;
- Listing 44 (the RAG answer prompt) is not used: the session itself is the context.

### Magic Context ingest

1. A live host creates the project (from a fresh git repository whose only commit is derived from
   the conversation id) and an empty session, then stops.
2. With the host stopped, `store-writer.ts` inserts every turn as an OpenCode 1.18.30 user or
   assistant text message, in the shapes the host writes itself.
3. `boundary-probe.ts` runs the production `resolveOpenCodeProtectedTailBoundary` (trigger mode)
   on a scratch copy of the stores, with the usage the first question would report (all raw
   tokens over the answer model's context limit), and returns how many trailing messages the
   protected tail keeps raw.
4. The host runs `/ctx-wrapup N` with that N: Magic Context's incremental historian (the one that
   runs under context pressure in production) compacts everything before the tail into
   compartments and promotes extracted facts to project memories. `/ctx-recomp` is not used: it is
   a structural rebuild that extracts no facts or memories.
5. The host stops; `data/` and `work/` are copied to `runs/<run>/mc/snapshots/c<id>/`.

Each question then restores that snapshot into the same root path, starts the host, sends the
question turn through `POST /session/:id/message`, reads the final assistant text (the only thing
the judge sees) and every tool call, and stops the host.

## Running

From the repository root, on the Mac, with the plugin built (`bun run build` in
`packages/plugin`):

```sh
B=packages/plugin/scripts/beam
mkdir -p $B/.runs/host && cp ~/.opencode/bin/opencode-stock-1.18.30 $B/.runs/host/opencode-1.18.30
bun $B/run.ts prepare                       # dataset at the pinned revision, pyarrow venv
bun $B/run.ts --verify-prompts              # every vendored prompt, byte for byte
bun $B/run.ts list-credentials              # non-secret inventory of the mc-e2e grants
nice -n 10 bun $B/run.ts --smoke-transport --run smoke --chatgpt-credential chatgpt:openai:NAME
nice -n 10 bun $B/run.ts vanilla --run spike-100k --chatgpt-credential chatgpt:openai:NAME
nice -n 10 bun $B/run.ts mc      --run spike-100k --chatgpt-credential chatgpt:openai:NAME
bun $B/run.ts summary --run spike-100k
```

Add `--stub` to any command to run it against the local stub with fake credentials. Both arms are
resumable: rerun the same command with the same `--run`; finished questions are skipped, an
answered but unjudged question is only judged, and an unfinished ingest starts over. A run's
settings are pinned in `runs/<run>/settings.json` and a resumed run with different settings is
refused. Useful flags: `--conversations 1,2,3,4,5`, `--questions <ids>`, `--split`,
`--reasoning-effort`, `--historian-variant low|medium|high` (default medium),
`--temperature <n|omit>` (default `omit`; use `--stub --temperature 0` to
exercise an explicit zero without the subscription backend), `--answer-context-limit` (default 272000),
`--max-input-tokens` (per arm, default 30,000,000; the run also stops when the projection for
the remaining questions crosses it), `--opencode <binary>`.

Exit codes: 0 done, 3 stopped with a reason in `runs/<run>/stopped-<arm>.json` (credential
rejected, rate limited, budget, isolation), 4 credential problem, 1 other failure.

Per question, `runs/<run>/<arm>/questions/<id>.json` records the id, ability, question text, the
exact question turn, the answer, every tool call (tool, input, status, output size), the score with
every judge verdict and equivalence check, and answer, judge and historian token usage. Ingest
records go to `runs/<run>/mc/ingest/`, host and Magic Context logs (secrets scrubbed) to
`runs/<run>/mc/logs/`, and the summary to `runs/<run>/summary.json`. The command prints per-arm
means by ability next to the paper's GPT-4.1-nano 100K row, and token totals.

`summary.json` explicitly records `sampling.answerTemperature`, `sampling.judgeTemperature`
(`null` when not set), `sampling.temperatureSet`, and `protocolDeviations`. Omitting temperature
does not mean temperature 0. A run previously pinned with temperature 0 needs a new `--run` name
to use the new default.

`--smoke-transport` (also spelled as the `smoke-transport` subcommand) prints complete sanitized
Cloud Code error bodies even when they are JSON, before the usual terminal 401/403 stop. The
body is also saved in `runs/<run>/relay-log-smoke-transport-<pid>.json`. It starts no OpenCode host.

## Attribution

The vendored prompts are from the BEAM paper (CC BY 4.0) and its released code; see
`prompts/NOTICE`. The dataset is CC BY-SA 4.0. The row parsing follows the MIT-licensed
pastdotdev/benchmarks `beam/dataset.py`; none of its ExaBase prompts are used.
