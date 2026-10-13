//! Hook token totals, protection windows and hint candidates rebuilt from policy rows.
//! Hooks admit one message and decide tag/reminder operations; they do not render
//! a conversation replacement, so native history and fold fragments are unnecessary.
use super::*;

#[derive(Default)]
pub(crate) struct ResidentPolicy {
    summary: Option<PolicySummary>,
    saved: Option<String>,
    before: HashMap<String, Option<ProviderPolicyPart>>,
    #[cfg(test)]
    pub(crate) rebuilt_parts: usize,
    #[cfg(test)]
    pub(crate) replays: u64,
}

impl ResidentPolicy {
    pub(crate) fn rebuild(
        index: &ProviderPolicyIndex<'_>,
        counters: &Value,
        floor: u64,
        tools: &BTreeMap<String, usize>,
    ) -> Result<Self, ProviderError> {
        let settings = Settings::resolve(
            &counters["engine_policy"],
            floor,
            tools,
            false,
            counters
                .pointer("/pass_context/model_key")
                .and_then(Value::as_str),
        );
        let parts = index.all_parts()?;
        let saved = index.summary()?;
        let changes = index.changes(CHANGE_CAP)?;
        // The durable change log starts at the last saved summary. Rebuilding
        // already includes those changes, so admitting the next message must
        // subtract the rebuilt rows' contributions, not the older logged copies.
        let before = changes
            .as_ref()
            .map(|changes| {
                changes
                    .iter()
                    .map(|change| (change.block_id.clone(), change.current.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let summary = if saved.is_some() && changes.is_some() {
            build(&parts, &settings, settings.key(index), None)
        } else {
            None
        };
        Ok(Self {
            summary,
            saved,
            before,
            #[cfg(test)]
            rebuilt_parts: parts.len(),
            #[cfg(test)]
            replays: 0,
        })
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        // Charge serialized payload and container overhead conservatively.
        // read_provider_resident_policy bounds input to 100,000 rows / 128 MiB
        // before allocating the temporary rebuild input.
        std::mem::size_of::<Self>()
            + self.saved.as_ref().map_or(0, String::capacity)
            + self.summary.as_ref().map_or(0, |summary| {
                serde_json::to_vec(summary).expect("summary JSON").len() * 4
            })
            + self
                .before
                .iter()
                .map(|(key, part)| {
                    key.capacity()
                        + std::mem::size_of::<ProviderPolicyPart>()
                        + part.as_ref().map_or(0, |part| {
                            serde_json::to_vec(part).expect("part JSON").len() * 4
                        })
                })
                .sum::<usize>()
    }

    fn adopt(&mut self, raw: &Option<String>) {
        self.summary = raw.as_ref().and_then(|raw| serde_json::from_str(raw).ok());
        self.saved.clone_from(raw);
        self.before.clear();
    }
}

#[cfg(test)]
#[path = "resident_policy_tests.rs"]
mod tests;

#[allow(clippy::too_many_arguments)]
pub(crate) fn resident_channel1_inputs(
    resident: &mut ResidentPolicy,
    index: &ProviderPolicyIndex<'_>,
    engine_policy: &Value,
    floor: u64,
    tools: &BTreeMap<String, usize>,
    carrier: bool,
    cache_busting: bool,
    model_key: Option<&str>,
) -> Result<(Channel1PolicyInputs, Option<String>), ProviderError> {
    let settings = Settings::resolve(engine_policy, floor, tools, cache_busting, model_key);
    let origin_matches = resident.saved == index.summary()?;
    if !cache_busting && index.preparation().is_none() && origin_matches {
        if let Some(held) = resident
            .summary
            .take()
            .filter(|summary| summary.key == settings.key(index))
        {
            if let Some(next) =
                replay_measured(index, held, &settings, None, Some(&resident.before))?
            {
                if let Some(inputs) = inputs_from_summary(&next, &settings, carrier) {
                    #[cfg(test)]
                    check_against_full(
                        index,
                        engine_policy,
                        floor,
                        tools,
                        model_key,
                        &settings,
                        &inputs,
                        &next,
                    )?;
                    let raw = Some(serde_json::to_string(&next).expect("summary JSON"));
                    resident.summary = Some(next);
                    #[cfg(test)]
                    {
                        resident.replays += 1;
                    }
                    resident.saved.clone_from(&raw);
                    resident.before.clear();
                    return Ok((inputs, raw));
                }
            }
        }
    }
    // Compaction, lineage changes and resetting frozen hygiene measurements may
    // invalidate these aggregates. Evaluate the complete policy in that case.
    let result = channel1_inputs(
        index,
        engine_policy,
        floor,
        tools,
        carrier,
        cache_busting,
        model_key,
    )?;
    resident.adopt(&result.1);
    Ok(result)
}
