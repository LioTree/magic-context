# Historian and dreamer prompt contracts

The rows preserve the eight issues identified in section 8 of the profile-extraction
README: inherited instructions, safety scoring, decay labels, input naming, budget,
expiry, internal-agent detection, and persona identity. The historian
source renders an XML contract for dormant, repair and recomp work and a combined
contract for an authorized two-turn session. Both turns use the same combined
system; the second user message contains only notices and the work items.

| Row | Defect | Resolution | Regression |
| --- | --- | --- | --- |
| 1 | Turn two inherits turn-one prose. | Accepted: the combined system describes both steps without replacing its inherited prose. | `prompt-defects.test.ts`: `C5 row 1` |
| 2 | The safety-critical importance floor is prose only. | Owned by the safety-classification storage change; this prompt change does not replace the classifier's criterion or introduce a shape-based safety predicate. | Safety-classification slice: direct TypeScript, module, and Rust-owned classify/score/undo coverage. |
| 3 | Proposed decay class has no taxonomy. | Kept as a free nonempty string, at most 64 characters, not a new enum. The combined contract states the existing parser bounds. | `prompt-defects.test.ts`: `C5 row 3` |
| 4 | Dedup input is named `<project_memory>`. | Both contracts now name the actual `<project-memory>` block; its renderer is unchanged. | `prompt-defects.test.ts`: `C5 row 4` |
| 5 | Curate claims a 6,000-token injection budget. | The prompt receives the configured injection budget; its default is 4,000. | `dreamer/curate-snapshot.test.ts`: `C5 row 5` |
| 6 | Expiry runs only inside curate. | Each enabled project scheduler tick sweeps TTL expiry under the memory-domain lease, even with every model task disabled. Rust ownership routes the sweep through `memory.expire`. Manual curate also sweeps before its snapshot. | `dreamer/expire-memories.test.ts`: both `C5 row 6` cases |
| 7 | Three task prompts lack the internal-agent phrase. | No text change: friction-gate, retrospective and compress-cues keep their exact bytes and use the dreamer registration identity. The extracted README's `prompts/dreamer/_agent-registration.system.md` corresponds to `DREAMER_SYSTEM_PROMPT` in `dreamer/task-prompts.ts`, not a runtime Markdown asset. | `prompt-defects.test.ts`: `C5 row 7` pins task and registration bytes and checks the retrospective/classifier registrations. |
| 8 | “Coding agent” is both persona and detection key. | The persona sentence remains byte-identical in both renderings and structural recomp. | `prompt-defects.test.ts`: `C5 row 8` |

No tool-use prohibition is added to the historian source. For OpenCode Zen models
that require a tool definition, the transport supplies a read tool but blocks every
call, and appends this exact instruction: `Summarize only the supplied conversation and memory context. Do not call tools.` The tool definition and instruction remain
owned by the transport, not duplicated in either historian rendering.

Generate TypeScript renderings with
`bun packages/plugin/scripts/build-historian-prompt.ts`, then vendor both exact
strings with `bun crates/mc-module/gen/gen-historian-system-prompt.ts`.
The generator's `--check` mode checks both Rust assets without rewriting them.
Each system hash identifies the exact bytes sent to the provider. The XML and
combined hashes differ so validation of one output contract cannot authorize the
other. Changing either system or tool bytes requires a new validation epoch before
enabling the affected profile.
