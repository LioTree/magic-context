# Vendored Broca wire goldens

These files are copied byte-for-byte from the Broca repository, so the fake Broca in
`../tests.rs` answers with the deployed runner's shapes. Do not edit them. To refresh
them, copy the new files from Broca and update the commit and checksums here and in
the `broca_goldens_match_their_pinned_checksums` test.

| File | Source path in Broca | sha256 |
|---|---|---|
| `role_describe.json` | `crates/broca-wire/tests/golden/role_describe.json` | `b02c1aeba85bfc1ad3a6dde615ba049c047e1f5f2ced66f90043c4fe34a5b0a2` |
| `run_status.budget_exhausted.json` | `crates/broca-wire/tests/golden/run_status.budget_exhausted.json` | `45452b91e62fa53be019c22c3bd5f1db3af487d73bf8645c5516b2f53648955f` |

Source: Broca commit `9772ee0` ("Bump workspace to 0.3.212"), the first release that
deploys the hard input-token cap (`input_token_cap`, llm-runner 0.2.4).
