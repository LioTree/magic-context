# THALAMUS G8 recorded RPC replay

`SOURCE` pins both unmodified recordings to the THALAMUS repository (not this
repository). Synthetic has 36 calls / 14 frozen hooks (plus two lost hook answers);
live has 56 calls / 35 hooks from ten real Claude Code turns. The operator reviewed and scrubbed the live export
before vendoring. Add a recording with one `FIXTURES` entry and its `SOURCE` pin.

The runner requires the ordered `calls` array and cross-checks each `hooks` row's
sequence, method, params and answer/error against its call row. There are no
reconstructed calls. All RPCs use the real dispatcher on a fresh store and the
attested `reserved:thalamus` Claude Code route, with the recorded plan choosing
Magic Context for compaction. Setup has no `descends_from`; the recorded hooks
and steps establish the retained-prefix fork. No discovery capability is added.

## Reproducible identity versus byte oracles

Run the feature replay with the Git SHA embedded in the recorded `role.describe`
answer's `implementation_version` (the MC binary's compile-time build identity):

```sh
MC_BUILD_SHA=7e915050844ecdf41a0f62206ff2626664bead78 cargo test -p mc-module --features advertise-claude-code-candidate --lib g8_
```

The default build does not publish or admit the Claude Code capability bundle
(the serializer/provider generations, flags and wire limits in `claude_code`), so
it runs the fixture digest and hook/call alignment checks, not RPC replays.
The `advertise-claude-code-candidate` G8 replay uses actual compiled flags and capabilities. Provider
generations fingerprint source bytes, so a native reduction implementation change
can change the generation without changing any advertised capability. The replay
uses the existing test-only bundle override to pin only `provider_generation` to
the recording's identity (and derives the bundle digest from that identity). It
asserts that the recorded and compiled bundles are otherwise identical. No
recorded response bytes are normalized for this: they still compare exactly.
`g8_compiled_generation_changed_and_production_refuses_recorded_pins` separately
checks that the compiled generation changed and that a handler without the test
override refuses the old generation. Production generation fencing is unchanged.

A fresh provider binding/project path produces different opaque IDs. The replay
contract therefore permits alpha-renaming only these JSON string fields, without
normalizing any content or metadata derived from content:

- `compaction_id`, including setup/step results and later acknowledgements;
- `view_id`, including `raw_view.view_id`, `cut_replacement_ref.view_id` and echoes;
- `lineage_id` echoed in answers: params already have normalized `L`/`L2`/`L3`, while
  the recording preserves the original opaque lineage in answer byte arrays.

Each listed field maps recorded IDs to produced IDs in a separate bijection.
The first produced answer binds an ID;
later answers must keep it and two recorded IDs cannot share one produced ID.
Later params use that same mapping. Comparisons replace only complete JSON string
tokens in the recorded bytes: they do not reserialize the expected answer.
Build version text is not normalized. Every other byte, including content hashes,
lengths, versions, endpoints, and payloads, must remain exact. Hook answers are
additionally checked before any answer normalization. Recorded hook params are
unchanged except any already-bound opaque ID field.

The runner checks session allocation order and uniqueness from stored answers,
tracks unserved reports and forbids later reuse, checks frozen allocations across
recorded retries, and verifies the refused synthetic send keeps its pending
number. A subject is a message MID plus hook kind and optional tool-result part.
Whole-message `served` bytes are compared only where all its subjects have recorded
`applied` operations (rather than unavailable/error outcomes) and MC can derive the native splices; gateway refusal, forwarding and
clean completion are not reimplemented. The final synthetic clean retry has no
subsequent MC service report: its pending tags stay pending until a later report.

A separately named **supplemental** control replays the synthetic prefix and
re-offers its first still-pending hook after the recorded step. That extra hook
is not claimed to be recorded: its params and byte oracle are copied unchanged
from the recorded hook. It separately makes the retry-reuse lookup observable;
the synthetic recording now also contains two genuine saved-fence hook retries.
The full recording runner
never synthesizes calls.

The synthetic gateway deliberately discards two received hook answers before
freezing them, recorded as `expected_error: "replay_hook_crash"`. These are gateway
crash stand-ins, not MC errors: replay still calls MC normally and preserves its
commit. The byte oracle for each discarded answer is the later successful call
with identical params in the same recording. Only that successful row supplies
a `hooks` entry. The runner checks both genuine retries (one immediate, one after
a recorded step), including stored pending numbers and operations.
