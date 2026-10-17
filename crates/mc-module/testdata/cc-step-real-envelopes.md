# Recorded Claude Code pressure regressions

`cc-step-real-envelopes.json` is the unchanged 16-row gateway capture (one setup,
15 steps), SHA-256 `ea64cda3a21b1a59c9ed4d463f94df73ce72b4f7f9fbcce7739729880a661961`.
`cc-step-real-envelopes-reads.json` is the unchanged 20-row reads rerun (one setup,
19 steps), SHA-256 `d213385da4224b73c30ae1d4f720f3629d4ee1f7664b90dc826460ece22ee4cd`.
Message pages contain only hashes, byte counts and message counts, not private
content. These fixtures are metadata recordings, not raw-body replay claims.

`providers::claude_code_tests::real_envelope_tests` replays declaration, setup,
admission hooks, the facade `ctx_reduce` tool, all recorded steps and session
status. It substitutes public bodies, preserving the recorded step parameters,
newest IDs, page counts, tool-turn flags, estimates and geometry. Unknown body
IDs and view identities are reminted. Without the
`advertise-claude-code-candidate` feature, setup omits the `claude_code` candidate
capability selection, which default builds deliberately do not publish. With
that feature enabled, setup selects the exact recorded bundle. Replays use the
default TTL configuration and assert the engine's actual scheduler pass, so a
completed step below 65% cannot silently execute because of fabricated idle age.

The original sequence has only the marker Read and ctx_reduce results. The reads
sequence adds four 24-byte results after the 51-byte marker. Neither sequence
can drop the marker output: the automatic recent-tool protection window includes
its tag. New user text does not contribute tool-output mass. The protection floor is
1,920 tokens (8% of usable-soft 24,000), not 16,000 from the absolute wall.

Two deliberate synthetic variants let the queued marker-output drop pass the
recent-tool protection window. They use real admission hooks, not artificially
inserted tag rows or a lowered floor: three newer 800-word tool results in the original shape,
and four 3,000-byte (`"one "` repeated 750 times) Read results in the reads shape.
Each must drain at the first completed Execute step (sequence 35 or 47), preserve
tool pairing, remove invalidated later signatures, and then answer noop after
acknowledgment. The tests print and check the measured calibrated newer-tool mass.
Below-threshold unfinished tool steps remain noop with their drop queued.
An additional `expired_cache` variant drains the eligible drop at sequence 31,
below the pressure threshold, and then remains stable after acknowledgment.

Measured newer-tool masses (including the 2-token ctx_reduce reply) are 2 tokens
for the original capture, 22 for the tiny-reads reconstruction, 2,405 for the
three-800-word variant, and 3,006 for the four-3-KB variant. The fixed model
calibration has `tools_ratio = 1`. Raw private bodies cannot be recovered from
hashes; the 22-token result measures the public 24-byte substitutes, not the
unknown original bytes. The supplied drive description bounds the original tiny
outputs below 300 tokens, still far below 1,920.
