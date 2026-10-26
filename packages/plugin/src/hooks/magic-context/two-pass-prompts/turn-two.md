Turn two: check each candidate fact, then compare it with project memory.
allowed_fact_ids: {{ALLOWED_FACT_IDS}}

1. Return exactly one decision for each id in allowed_fact_ids, and no others. The bullet numbers and compartment numbers in your turn-one reply are not fact ids.
2. Check the fact first, using "What becomes a memory" in the system prompt. The whole chunk is above, in turn one's <new_messages>. Read the lines the fact cites and every line after them:
   - Is it stated in this chunk's new messages?
   - Who decided it: a `U:` line, or only an `A:` proposal?
   - Does a later line correct, reverse, measure or replace it?
   - Is it a hypothesis, an open question, a one-off step or a value that changes on the next build?
   - If it is an accepted decision that isn't built, does its text start with `Decided:`?
   If any check fails, the action is `abstain`.
3. Only a fact that passes is compared with memory. Its neighbouring memories are listed under it:
   - `covered`: a neighbour already says the same thing.
   - `edit` or `replaces`: a neighbour says something this fact updates or overturns.
   - `merge`: two or more neighbours and this fact belong in one memory.
   - `conflict`: it contradicts a neighbour, and the chunk doesn't settle which is right.
   - `new`: no neighbour covers it.
4. Write `check` before `action`. Example: `"check": "A proposes it at [152965-152971]; U accepts at [152972]. Not built in this chunk; the text starts with Decided:. Passes."`
5. In `removed`, `replaced` and `added`, cite only a source block of that fact, by its printed start ordinal, with an exact excerpt. Only that fact's neighbours are eligible targets.
