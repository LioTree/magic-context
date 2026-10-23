//! Production transitions onto a published cut. Setup uses only saved, window-bounded state.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct PublishedCut {
    pub(super) lineage: String,
    pub(super) version: u64,
    generation: u64,
    head: String,
    #[serde(default)]
    parent_namespace: String,
    #[serde(default)]
    parent_revision: Option<mc_store::CompartmentSourceRevision>,
    tag_high_water: i64,
}

#[derive(Serialize, Deserialize)]
pub(super) struct ParentHistory {
    namespace: String,
    revision: Option<mc_store::CompartmentSourceRevision>,
}

#[derive(Serialize, Deserialize)]
struct PendingStage {
    namespace: String,
    version: u64,
}

#[cfg(test)]
thread_local! { static CRASH_AFTER_STAGE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

#[cfg(test)]
pub(super) fn crash_after_stage_for_test() {
    CRASH_AFTER_STAGE.with(|flag| flag.set(true));
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
    fn stage_slot() -> &'static str {
        "pending-cut-stage"
    }

    pub(super) fn cleanup_pending_cut_stage(&self, store: &McStore) -> Result<(), HandlerOutcome> {
        let Some(raw) = store
            .load_async_compaction_baseline(&self.reference(), Self::stage_slot())
            .map_err(transient)?
        else {
            return Ok(());
        };
        let pending: PendingStage = serde_json::from_str(&raw).map_err(transient)?;
        let namespace = pending.namespace;
        let prefix = format!("{}:async:", self.key.engine_key());
        if !namespace.starts_with(&prefix) {
            return Err(invalid("staged namespace belongs to another conversation"));
        }
        let referenced = namespace == self.namespace()
            || self
                .published_cuts
                .values()
                .any(|cut| namespace == format!("{prefix}{}", cut.generation));
        if !referenced {
            store
                .discard_staged_namespace(&namespace, &self.key.project.to_string_lossy())
                .map_err(transient)?;
            store
                .retire_unannounced_async_view(&self.reference(), pending.version)
                .map_err(transient)?;
        }
        self.save_stage_intent(store, None)
    }

    fn save_stage_intent(
        &self,
        store: &McStore,
        stage: Option<(&str, u64)>,
    ) -> Result<(), HandlerOutcome> {
        let record = serde_json::to_string(self).map_err(transient)?;
        let reference = self.reference();
        let key = self.key.store_key().conversation_key();
        let mut save = store.async_compaction_save(&reference, &key, &self.key.session, &record);
        save.baseline(
            Self::stage_slot(),
            stage
                .map(|(namespace, version)| PendingStage {
                    namespace: namespace.into(),
                    version,
                })
                .map(|intent| serde_json::to_string(&intent))
                .transpose()
                .map_err(transient)?,
        );
        save.commit().map_err(transient)
    }

    pub(super) fn forward_parent_history(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        let Some(parent) = self.pending_parent_history.as_ref() else {
            return Ok(());
        };
        let namespace = self.namespace();
        if store
            .compartment_source_revision(&parent.namespace)
            .map_err(transient)?
            != parent.revision
            && store
                .compartment_source_revision(&namespace)
                .map_err(transient)?
                == parent.revision
        {
            let compartments = store
                .load_compartments(&parent.namespace)
                .map_err(transient)?;
            store
                .replace_compartments(&namespace, &compartments)
                .map_err(transient)?;
            store
                .adopt_compartment_history_identity(&parent.namespace, &namespace)
                .map_err(transient)?;
            store.arm_soft_refresh(&namespace).map_err(transient)?;
        }
        self.pending_parent_history = None;
        Ok(())
    }

    pub(super) fn keep_published_cut(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
        first: u64,
        view: &view::CompactionView,
    ) -> Result<(), HandlerOutcome> {
        let mut seed = match self.capture_cut_seed(store, codec, first)? {
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
        // The new lineage adopts this published view, not a parent's older
        // applied view. Its candidate must satisfy the same pruning guard;
        // parent views remain available only on the parent until descent.
        if self.produced_view.iter().any(|held| {
            held.view().map_or(true, |v| {
                v.replacement
                    .iter()
                    .any(|m| !m.meta.synthetic && m.meta.ordinal.is_some_and(|n| n < first))
            })
        }) {
            return Ok(());
        }
        let candidate = self
            .published_engine
            .get(&view.view_version)
            .ok_or_else(|| transient("published cut engine view missing"))?;
        seed.window.produced_view = Some(candidate.json.to_string());
        seed.window.applied_view = seed.window.produced_view.clone();
        seed.window
            .views
            .retain(|(version, _, _, _)| *version >= view.view_version);
        if let Some(record) = &mut seed.window.record {
            record.insert("applied".into(), json!(view.view_version));
            record.insert("frozen_edits_version".into(), json!(view.view_version));
        }
        if let Some(edits) = &candidate.frozen_edits {
            let mut frozen = self.frozen_edits.clone();
            frozen.merge(edits);
            let mids = self
                .entries
                .range(first..)
                .map(|(_, entry)| entry.mid.clone())
                .collect();
            seed.window.frozen_edits = Some(frozen.only_mids(&mids).json()?);
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
        // Persist one intent before any namespace writes. A crash can leave at
        // most this one unreferenced stage; the next publication removes it.
        self.cleanup_pending_cut_stage(store)?;
        self.save_stage_intent(store, Some((&namespace, view.view_version)))?;
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
        #[cfg(test)]
        if CRASH_AFTER_STAGE.with(|flag| flag.get()) {
            std::process::abort();
        }
        self.published_cuts.insert(
            first,
            PublishedCut {
                lineage: view.lineage_id.clone(),
                version: view.view_version,
                generation,
                head: serde_json::to_string(&head).map_err(transient)?,
                parent_namespace: self.namespace(),
                parent_revision: store
                    .compartment_source_revision(&self.namespace())
                    .map_err(transient)?,
                tag_high_water: store
                    .tag_cache_summary(&self.namespace())
                    .map_err(transient)?
                    .max_tag_number,
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
        // A cut may be prepared before the parent appends more messages. Those
        // rows are already held by the provider, but were not in the staged
        // tag namespace. Copy only tags allocated after the staged high-water
        // mark; never reread transcript history.
        let inherited_tags = store
            .load_tags_after(&cut.parent_namespace, cut.tag_high_water)
            .map_err(transient)?;
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
        // The initial answer is the published cut's exact head. A historian
        // completion on the parent after staging is folded only by a later view.
        state.pending_parent_history =
            (!cut.parent_namespace.is_empty()).then_some(ParentHistory {
                namespace: cut.parent_namespace.clone(),
                revision: cut.parent_revision.clone(),
            });
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
        state.save(store, &inherited_tags)?;
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
