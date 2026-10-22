//! Production transitions onto a published cut. Setup uses only saved, window-bounded state.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct PublishedCut {
    pub(super) lineage: String,
    pub(super) version: u64,
    generation: u64,
    head: String,
}

pub(super) fn split_head_at(ranges: &mut Vec<view::ViewRange>, first: u64) {
    if let Some(index) = ranges.iter().position(|range| {
        matches!(range,
        view::ViewRange::Replace { from, to, .. } if *from < first && first < *to)
    }) {
        let to = ranges[index].to();
        if let view::ViewRange::Replace { to, .. } = &mut ranges[index] {
            *to = first;
        }
        ranges.insert(index + 1, view::ViewRange::replace(first, to, "[]"));
    }
}

impl AsyncRecord {
    pub(super) fn keep_published_cut(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
        first: u64,
        view: &view::CompactionView,
    ) -> Result<(), HandlerOutcome> {
        let seed = match self.capture_cut_seed(store, codec, first)? {
            Ok(seed) => seed,
            Err(reason) => {
                tracing::debug!(
                    first,
                    reason = reason.code(),
                    "cut seed unavailable; descent will be refused"
                );
                return Ok(());
            }
        };
        // Guard pruning before advertising that a cut is adoptable. Every retained
        // engine view must be renderable without the rows the cut removes.
        if self
            .produced_view
            .iter()
            .chain(&self.applied_view)
            .chain(self.published_engine.values())
            .any(|held| {
                held.view().map_or(true, |v| {
                    v.replacement
                        .iter()
                        .any(|m| !m.meta.synthetic && m.meta.ordinal.is_some_and(|n| n < first))
                })
            })
        {
            return Ok(());
        }
        let mut head = Vec::<Value>::new();
        for range in view
            .ranges
            .iter()
            .take_while(|range| matches!(range, view::ViewRange::Replace { .. }))
        {
            if let view::ViewRange::Replace { bytes, .. } = range {
                head.extend(serde_json::from_str::<Vec<Value>>(bytes).map_err(transient)?);
            }
        }
        let generation = self
            .generation
            .checked_add(view.view_version)
            .and_then(|v| v.checked_add(1))
            .ok_or_else(|| transient("async generation exhausted"))?;
        let namespace = format!("{}:async:{generation}", self.key.engine_key());
        if let Some(head) = &seed.window.head {
            store
                .adopt_namespace_head(&namespace, head)
                .map_err(transient)?;
        }
        let compartments = store
            .load_compartments(&self.namespace())
            .map_err(transient)?;
        store
            .replace_compartments(&namespace, &compartments)
            .map_err(transient)?;
        store
            .adopt_compartment_history_identity(&self.namespace(), &namespace)
            .map_err(transient)?;
        let tags = tag_rows_for(self.entries.range(first..).map(|(_, entry)| entry), codec)?;
        let record = serde_json::to_string(&*self).map_err(transient)?;
        let reference = self.reference();
        let key = self.key.store_key().conversation_key();
        let mut save = store.async_compaction_save(&reference, &key, &self.key.session, &record);
        save.tags(&namespace, &tags);
        save.commit().map_err(transient)?;
        self.published_cuts.insert(
            first,
            PublishedCut {
                lineage: view.lineage_id.clone(),
                version: view.view_version,
                generation,
                head: serde_json::to_string(&head).map_err(transient)?,
            },
        );
        self.pending_cut_seeds.insert(first, seed);
        Ok(())
    }
}

impl McHandler {
    pub(super) async fn setup_cut_descent(
        &self,
        binding: &SessionBinding,
        request: &compact::setup::SetupRequest,
        existing: Option<State>,
        store: &McStore,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let unknown = || {
            bytes(&compact::setup::SetupAnswer::refuse(
                &request.request_id,
                compact::errors::RefuseCode::from_code("unknown_cut"),
                "The lineage does not descend from a cut Magic Context published.",
            ))
        };
        let Some(mut state) = existing else {
            return unknown();
        };
        self.authorize_async(binding, &state)?;
        if state.setup.params != request.params
            || state.setup.composition != request.composition
            || state.setup.preset != request.preset
        {
            return Err(invalid_field("params", "async setup plan is frozen"));
        }
        if state.setup.descends_from == request.descends_from && state.lineage == request.lineage_id
        {
            let mut answer = state.initial;
            answer["request_id"] = json!(request.request_id);
            return bytes(&with_checkpoint(answer, None));
        }
        if state.lineage == request.lineage_id {
            return unknown();
        }
        let descends = request.descends_from.as_ref().expect("descending Setup");
        let Some(first) = descends.through_ordinal.checked_add(1) else {
            return unknown();
        };
        let Some(cut) = state
            .published_cuts
            .get(&first)
            .filter(|cut| cut.lineage == descends.lineage_id)
            .cloned()
        else {
            return unknown();
        };
        let Some(raw) = store
            .load_async_compaction_baseline(&state.reference(), &format!("published-cut:{first}"))
            .map_err(transient)?
        else {
            return unknown();
        };
        let seed: cut_seed::CutSeed = serde_json::from_str(&raw).map_err(transient)?;
        if request.lineage_id.is_none() {
            return Err(invalid_field(
                "lineage_id",
                "descending Setup needs a lineage",
            ));
        }
        state.lineage = request.lineage_id.clone();
        state.generation = cut.generation;
        state.lineage_first_ordinal = first;
        state.journal = Journal::new_record();
        state.journal.truncate_below = Some(first);
        state.begin_at_cut(store, seed, cut_seed::CutStart::Descending)?;
        let mut engine = state.engine_with_baselines()?;
        for view in [&mut engine.last_produced, &mut engine.last_applied]
            .into_iter()
            .flatten()
        {
            view.range.lineage_id = request.lineage_id.clone().expect("lineage");
        }
        state.adopt_engine(engine)?;
        if let Some(prefix) = &mut state.logical_prefix {
            Arc::make_mut(prefix).lineage = request.lineage_id.clone().expect("lineage");
        }
        state.applied = Some(cut.version);
        state.failure = None;
        state.resync = false;
        state.setup.lineage_id = request.lineage_id.clone();
        state.setup.descends_from = request.descends_from.clone();
        let old: compact::setup::SetupAnswer = decode(&state.initial)?;
        let codec = codec::Codec::from_params(&Value::Object(request.params.clone()))?;
        let initial = compact::message::CompactionMessage::new(
            format!("cut-{first}"),
            cut.version,
            compact::message::Range::new(first, first),
            serde_json::from_str(&cut.head).map_err(transient)?,
        );
        let mut answer = compact::setup::SetupAnswer::ready(&request.request_id, initial)
            .with_cache_ttl(state.cache_policy.resolve(&request.model));
        if let Some(ceiling) = old.ceiling() {
            answer = answer.with_ceiling(ceiling.clone());
        }
        if let Some(wait) = old.ride_wait_ms() {
            answer = answer.with_ride_wait_ms(wait);
        }
        state.initial = serde_json::to_value(answer).map_err(transient)?;
        state.initial["serializer_profile"] = json!(codec.wire_id());
        state.save(store, &[])?;
        self.provider_store
            .async_runtime
            .resident
            .lock()
            .expect("async resident cache")
            .forget(&state.reference());
        bytes(&state.initial)
    }
}

impl McHandler {
    pub(super) async fn ensure_lineage_window(
        &self,
        state: &mut State,
        budget: Duration,
    ) -> Result<(), HandlerOutcome> {
        if !state.entries.is_empty() || state.cut_seed.is_some() {
            return Ok(());
        }
        let raw = self
            .provider_runner
            .call_for_identity(
                &state.runner()?,
                &state.runner_identity(),
                "session.head",
                json!({}),
                budget,
            )
            .await
            .map_err(runner_error)?;
        let head: cortexkit_role_llm_runner::read::HeadMeta = decode(&raw)?;
        let first = head.first_ordinal.unwrap_or(0);
        if let Some(header) = state
            .conditions
            .as_ref()
            .and_then(|h| h.get("first_ordinal"))
        {
            if header.parse::<u64>().ok() != Some(first) {
                return Err(invalid_field(
                    "first_ordinal",
                    "notice and session.head disagree",
                ));
            }
        }
        if first == 0 {
            return Ok(());
        }
        if state.lineage.is_some() && state.lineage != head.lineage_id {
            return Err(transient("async lineage changed"));
        }
        state.lineage = head.lineage_id;
        state.lineage_first_ordinal = first;
        let cut = head
            .cut
            .ok_or_else(|| invalid_field("cut", "session.head omitted the cut"))?;
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let meta = store.load_meta(&state.namespace()).map_err(transient)?.meta;
        let mut seed = cut_seed::CutSeed::without_rows(
            first,
            cut.mid,
            meta.coverage_compartment_seq
                .unwrap_or(meta.folded_compartment_seq),
            String::new(),
        );
        seed.cut_digest = cut.digest;
        seed.time_basis = Some((i64::try_from(cut.written_at).ok(), None));
        let compartments = store
            .load_compartments(&state.namespace())
            .map_err(transient)?;
        if let Some(last) = compartments
            .iter()
            .filter(|c| c.end_message < first as i64)
            .max_by_key(|c| c.sequence)
        {
            seed.compartment_seq = last.sequence;
            seed.boundary_id = last.end_message_id.clone();
        }
        state.begin_at_cut(store, seed, cut_seed::CutStart::Fresh)?;
        state.initial["initial"]["range"] = json!({"from":first,"to":first});
        Ok(())
    }
}
