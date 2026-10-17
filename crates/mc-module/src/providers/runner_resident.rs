//! Keep the runner's existing authorization, tag and reminder rules while caching
//! its transcript between serialized session operations. The session lease owns
//! raw messages, decoded ingress and lookup indexes instead of rebuilding them
//! from SQLite on every hook and step.
use super::*;
use std::ops::{Deref, DerefMut};

fn decode_entry(
    entry: &compact::status::StatusMessage,
) -> Result<ck_wire::CkIngressMessage, HandlerOutcome> {
    // Compatibility execution historically installed ingress through the JSON
    // TransformRequest decoder. Preserve its optional-field presence semantics
    // once at admission, then retain that exact decoded value across folds.
    let ingress = codec::Codec::OwnedBroca.decode_message(entry)?;
    serde_json::from_value(serde_json::to_value(ingress).map_err(transient)?).map_err(transient)
}

pub(super) struct RunnerState {
    record: Record,
    token: (u64, Option<u64>),
    frontiers: BTreeMap<String, u64>,
    lineage: String,
    decoded: BTreeMap<u64, ck_wire::CkIngressMessage>,
    native_bytes: usize,
    metadata_bytes: usize,
    decoded_bytes: usize,
    saved_views: BTreeMap<u64, usize>,
    view_bytes: usize,
    originals: HashMap<String, Vec<u64>>,
    originals_lineage: String,
    originals_through: Option<u64>,
    originals_bytes: usize,
}

impl RunnerState {
    pub fn retained_bytes(&self) -> usize {
        // The compatibility record owns native JSON and answer/view trees. Charge
        // a conservative multiple for their allocations, not just wire length.
        std::mem::size_of::<Self>()
            + self.native_bytes
            + self.metadata_bytes
            + self.decoded_bytes
            + self.view_bytes
            + self.lineage.capacity()
            + self
                .frontiers
                .keys()
                .map(|key| key.capacity() + 64)
                .sum::<usize>()
            + self.saved_views.len() * 32
            + crate::retained_size::hash_map_allocation_bytes(&self.originals)
            + self.originals_lineage.capacity()
            + self.originals_bytes
    }
}

pub(super) struct RunnerRecord<'a> {
    lease: Option<super::resident_hooks::Lease<'a>>,
    state: Box<RunnerState>,
    reused: bool,
    assistant_growth: Option<usize>,
}

impl Deref for RunnerRecord<'_> {
    type Target = Record;
    fn deref(&self) -> &Record {
        &self.state.record
    }
}
impl DerefMut for RunnerRecord<'_> {
    fn deref_mut(&mut self) -> &mut Record {
        &mut self.state.record
    }
}

impl McHandler {
    pub(super) fn runner_record<'a>(
        &'a self,
        store: &McStore,
        key: &Key,
    ) -> Result<RunnerRecord<'a>, HandlerOutcome> {
        RunnerRecord::load(&self.provider_store, &self.provider_resident, store, key)
    }
}

impl<'a> RunnerRecord<'a> {
    pub fn load(
        storage: &records::Storage,
        resident: &'a super::resident_hooks::ResidentHooks,
        store: &McStore,
        key: &Key,
    ) -> Result<Self, HandlerOutcome> {
        let mut lease = resident
            .begin(store.tag_cache_namespace(), key)
            .map_err(transient)?;
        let token = store
            .provider_record_token(&key.store_key())
            .map_err(transient)?;
        let saved = lease
            .as_mut()
            .and_then(|lease| lease.state.runner.take())
            .filter(|state| state.token == token);
        let reused = saved.is_some();
        let state = if let Some(saved) = saved {
            saved
        } else {
            let record = storage.load(key)?;
            if let Some(lease) = lease.as_mut().filter(|_| token.1.is_some()) {
                if let Some(rebuilt) = store
                    .read_provider_fold_resident_policy(&key.store_key(), |index, counters| {
                        super::policy_summary::ResidentPolicy::rebuild(
                            index,
                            counters,
                            0,
                            &Default::default(),
                        )
                    })
                    .map_err(transient)?
                {
                    lease.state = rebuilt;
                    if let Some(conversation) = store
                        .load_provider_conversation(&key.store_key())
                        .map_err(transient)?
                    {
                        lease.state.fold_lineage = Some(conversation.lineage_id);
                        lease.state.fold_data_version = Some(token.0);
                        let compartments = store
                            .load_compartments(&key.engine_key())
                            .map_err(transient)?;
                        if let Some(prefix) = lease.state.fold_prefix.as_ref() {
                            let current = store
                                .compartment_source_revision(&key.engine_key())
                                .map_err(transient)?;
                            let captured = store
                                .provider_cut_source_revision(
                                    &key.store_key(),
                                    &key.engine_key(),
                                    prefix.cut_id,
                                )
                                .map_err(transient)?;
                            if current.is_none() || current != captured {
                                lease.state.fold_prefix = None;
                            }
                        }
                        lease.state.fold_structure =
                            lease.state.fold_prefix.as_ref().map(|prefix| {
                                compaction::fold_structure(&compartments, prefix.through)
                            });
                    }
                }
            }
            let frontiers = record
                .messages
                .iter()
                .filter_map(|(lineage, entries)| {
                    entries
                        .last_key_value()
                        .map(|(ordinal, _)| (lineage.clone(), *ordinal))
                })
                .collect();
            let native_bytes = serde_json::to_vec(&record.messages)
                .map_err(transient)?
                .len()
                * 4;
            let saved_views = record
                .setup
                .iter()
                .flat_map(|setup| [&setup.state.last_produced, &setup.state.last_applied])
                .chain([&record.wait_view])
                .flatten()
                .map(|view| {
                    Ok((
                        view.version,
                        serde_json::to_vec(view).map_err(transient)?.len() * 4,
                    ))
                })
                .collect::<Result<BTreeMap<_, _>, HandlerOutcome>>()?;
            let lineage = lease
                .as_ref()
                .and_then(|lease| lease.state.fold_lineage.clone())
                .unwrap_or_default();
            let through = lease
                .as_ref()
                .and_then(|lease| lease.state.fold_prefix.as_ref())
                .map(|prefix| prefix.through);
            let decoded = record
                .messages
                .get(&lineage)
                .into_iter()
                .flat_map(|entries| entries.iter())
                .filter(|(ordinal, _)| through.is_none_or(|through| **ordinal > through))
                .map(|(ordinal, entry)| Ok((*ordinal, decode_entry(entry)?)))
                .collect::<Result<BTreeMap<_, _>, HandlerOutcome>>()?;
            let decoded_bytes = decoded
                .values()
                .map(|entry| {
                    crate::retained_size::ck_wire_message_retained_bytes(&entry.ck)
                        + entry.mid.capacity()
                        + 96
                })
                .sum();
            Box::new(RunnerState {
                record,
                token,
                frontiers,
                lineage,
                decoded,
                native_bytes,
                metadata_bytes: 0,
                decoded_bytes,
                saved_views,
                view_bytes: 0,
                originals: HashMap::new(),
                originals_lineage: String::new(),
                originals_through: None,
                originals_bytes: 0,
            })
        };
        Ok(RunnerRecord {
            lease,
            state,
            reused,
            assistant_growth: None,
        })
    }
}

impl RunnerRecord<'_> {
    pub fn checked_view(
        &mut self,
        view: &transform::compaction::View,
    ) -> Result<compact::answer::CompactionMessage, HandlerOutcome> {
        if self.lease.is_none() {
            return codec::checked_view(view, &self.state.record);
        }
        let wire = codec::encode_view(view)?;
        let lineage = &view.range.lineage_id;
        if &self.state.originals_lineage != lineage {
            self.state.originals.clear();
            self.state.originals_bytes = 0;
            self.state.originals_through = None;
            self.state.originals_lineage.clone_from(lineage);
        }
        let entries = self.state.record.messages.get(lineage);
        if let Some(entries) = entries {
            for (ordinal, entry) in entries.range(
                self.state
                    .originals_through
                    .map_or(0, |through| through.saturating_add(1))..,
            ) {
                let hash = sha256_hex(&serde_jcs::to_vec(&entry.message).map_err(transient)?);
                let ordinals = self.state.originals.entry(hash.clone()).or_insert_with(|| {
                    self.state.originals_bytes += hash.capacity();
                    Vec::new()
                });
                let before = ordinals.capacity();
                ordinals.push(*ordinal);
                self.state.originals_bytes += (ordinals.capacity() - before) * 8;
                self.state.originals_through = Some(*ordinal);
            }
        }
        // Hashes locate candidate originals; exact JSON equality, not a digest,
        // still authorizes carried cache markers, origins and signed reasoning.
        codec::validate_replacement_with(&wire, &self.state.record, lineage, |message| {
            let Ok(bytes) = serde_jcs::to_vec(message) else {
                return false;
            };
            self.state
                .originals
                .get(&sha256_hex(&bytes))
                .is_some_and(|ordinals| {
                    ordinals.iter().any(|ordinal| {
                        entries
                            .and_then(|entries| entries.get(ordinal))
                            .is_some_and(|entry| entry.message == *message)
                    })
                })
        })?;
        Ok(wire)
    }

    pub fn save(&mut self, storage: &records::Storage, key: &Key) -> Result<(), HandlerOutcome> {
        self.reused = false;
        self.assistant_growth = None;
        if self.lease.is_none() {
            return storage.save(key, &self.state.record);
        }
        let messages = std::mem::take(&mut self.state.record.messages);
        self.state.record.messages = messages
            .iter()
            .map(|(lineage, entries)| {
                let after = self.state.frontiers.get(lineage).copied();
                (
                    lineage.clone(),
                    entries
                        .range(after.map_or(0, |after| after.saturating_add(1))..)
                        .map(|(ordinal, message)| (*ordinal, message.clone()))
                        .collect(),
                )
            })
            .collect();
        let appended_bytes = serde_json::to_vec(&self.state.record.messages)
            .map_err(transient)?
            .len()
            * 4;
        let produced = self
            .state
            .record
            .setup
            .as_mut()
            .and_then(|setup| setup.state.last_produced.take());
        let applied = self
            .state
            .record
            .setup
            .as_mut()
            .and_then(|setup| setup.state.last_applied.take());
        let wait = self.state.record.wait_view.take();
        let mut raw = serde_json::to_value(&self.state.record).map_err(transient)?;
        for (path, view) in [
            ("/setup/state/last_produced", &produced),
            ("/setup/state/last_applied", &applied),
            ("/wait_view", &wait),
        ] {
            if let Some(view) = view {
                *raw.pointer_mut(path).expect("serialized view slot") =
                    if let std::collections::btree_map::Entry::Vacant(entry) =
                        self.state.saved_views.entry(view.version)
                    {
                        let value = serde_json::to_value(view).map_err(transient)?;
                        entry.insert(serde_json::to_vec(&value).map_err(transient)?.len() * 4);
                        value
                    } else {
                        json!({"version":view.version})
                    };
            }
        }
        if let Some(setup) = &mut self.state.record.setup {
            setup.state.last_produced = produced;
            setup.state.last_applied = applied;
        }
        self.state.record.wait_view = wait;
        let raw = serde_json::to_string(&raw).map_err(transient)?;
        let metadata_bytes = raw.len() * 4;
        let result = storage.save_delta(key, &self.state.record, &messages, &raw, &self.state.token);
        self.state.record.messages = messages;
        result?;
        self.state.native_bytes += appended_bytes;
        self.state.metadata_bytes = metadata_bytes;
        let versions: Vec<_> = self
            .state
            .record
            .setup
            .iter()
            .flat_map(|setup| [&setup.state.last_produced, &setup.state.last_applied])
            .chain([&self.state.record.wait_view])
            .flatten()
            .map(|view| view.version)
            .collect();
        self.state.view_bytes = versions
            .iter()
            .map(|version| self.state.saved_views[version])
            .sum();
        self.state
            .saved_views
            .retain(|version, _| versions.contains(version));
        self.state.frontiers = self
            .state
            .record
            .messages
            .iter()
            .filter_map(|(lineage, entries)| {
                entries
                    .last_key_value()
                    .map(|(ordinal, _)| (lineage.clone(), *ordinal))
            })
            .collect();
        self.state.token = storage.token(key)?;
        Ok(())
    }

    pub fn save_assistant_answer(
        &mut self,
        store: &McStore,
        storage: &records::Storage,
        key: &Key,
    ) -> Result<(), HandlerOutcome> {
        // A freshly loaded runner has no byte estimate for old hook answers or
        // the last served answer. Count those allocations toward resident caps
        // with a full save before adding only the new answer's byte growth.
        if self.lease.is_none() || !self.reused {
            return self.save(storage, key);
        }
        let answers = &self.state.record.hook.as_ref().expect("hook state").answers;
        let answer =
            serde_json::to_value(answers.last().expect("new hook answer")).map_err(transient)?;
        store
            .append_provider_runner_answer(
                &key.store_key(),
                answers.len() - 1,
                &answer,
                &self.state.token,
            )
            .map_err(transient)?;
        // The transcript, views and existing answers stay owned by the lease.
        // Only this newly retained answer adds to the resident byte charge.
        let growth = serde_json::to_vec(&answer).map_err(transient)?.len() * 4;
        self.state.metadata_bytes += growth;
        self.assistant_growth = Some(growth);
        Ok(())
    }

    pub fn prepare(
        &mut self,
        lineage: &str,
        template: &mut TransformRequest,
    ) -> Result<(), HandlerOutcome> {
        if self.lease.is_none() {
            let messages = self
                .state
                .record
                .messages
                .get(lineage)
                .map(|messages| messages.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            template.messages = messages
                .iter()
                .map(decode_entry)
                .collect::<Result<_, _>>()?;
            return Ok(());
        }
        // Ordinals are meaningful only within a lineage. A fork may reuse every
        // ordinal and MID while carrying a different transcript.
        if self.state.lineage != lineage {
            self.state.decoded.clear();
            self.state.decoded_bytes = 0;
            self.state.lineage = lineage.into();
        }
        if let Some(messages) = self.state.record.messages.get(lineage) {
            for (ordinal, message) in messages {
                if !self.state.decoded.contains_key(ordinal) {
                    let decoded = decode_entry(message)?;
                    self.state.decoded_bytes +=
                        crate::retained_size::ck_wire_message_retained_bytes(&decoded.ck)
                            + decoded.mid.capacity()
                            + 96;
                    self.state.decoded.insert(*ordinal, decoded);
                }
            }
        }
        template.messages = self.state.decoded.values().cloned().collect();
        template.native_fold_projection = Some(Arc::new(
            ck_wire::project_messages(&template.messages).map_err(transient)?,
        ));
        Ok(())
    }

    pub fn prepare_fold(
        &mut self,
        store: &McStore,
        key: &Key,
        status: &transform::compaction::Status,
        template: &mut TransformRequest,
        initial: bool,
    ) -> Result<(), HandlerOutcome> {
        let Some(lease) = self.lease.as_mut() else {
            return self.prepare(&status.lineage_id, template);
        };
        let version = store.provider_external_data_version().map_err(transient)?;
        let meta = store.load_meta(&key.engine_key()).map_err(transient)?.meta;
        let compartments = store
            .load_compartments(&key.engine_key())
            .map_err(transient)?;
        let revision = store
            .compartment_source_revision(&key.engine_key())
            .map_err(transient)?;
        let confirmed = self.state.record.setup.as_ref().is_some_and(|setup| {
            setup.state.last_produced.as_ref().is_some_and(|produced| {
                Some(produced.version) == status.last_applied_version
                    && produced.range.lineage_id == status.lineage_id
            })
        });
        let prefix = lease
            .state
            .fold_prefix
            .as_ref()
            .filter(|prefix| {
                !initial
                    && confirmed
                    && !status.prefix_rebuilding
                    && status.last_not_applied.is_none()
                    && !prefix.has_system
                    && !lease.state.fold_source_raced
                    && revision.is_some()
                    && lease.state.fold_data_version == Some(version)
                    && lease.state.fold_lineage.as_deref() == Some(status.lineage_id.as_str())
                    && lease.state.fold_structure
                        == Some(compaction::fold_structure(&compartments, prefix.through))
                    && meta.pending_rewrite.is_none()
                    && meta.ordinal_continuation_base.is_none()
                    && meta.coverage_ordinal == Some(prefix.through)
                    && status.newest_ordinal.is_some_and(|newest| {
                        newest > prefix.through
                            && compartments.iter().all(|c| c.end_message < newest as i64)
                    })
                    && compartments.iter().any(|c| {
                        c.end_message == prefix.through as i64
                            && Some(c.sequence) == meta.coverage_compartment_seq
                    })
            })
            .cloned();
        template.native_tail_section = true;
        template.native_compartment_source_revision = revision;
        let Some(prefix) = prefix else {
            return self.prepare(&status.lineage_id, template);
        };
        let tail_key = super::fold_working::TailKey {
            through: prefix.through,
            newest: status.newest_ordinal,
            answers: (0, 0),
        };
        let reuse = lease
            .state
            .fold_working
            .as_ref()
            .is_some_and(|working| working.key == tail_key);
        if reuse {
            lease
                .state
                .fold_working
                .as_ref()
                .unwrap()
                .install(&lease.state.fold_arena, template)?;
        } else {
            let messages = self
                .state
                .record
                .messages
                .get(&status.lineage_id)
                .map(|messages| {
                    messages
                        .range(prefix.through.saturating_add(1)..)
                        .map(|(_, message)| message.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            template.messages = messages
                .iter()
                .map(decode_entry)
                .collect::<Result<_, _>>()?;
        }
        // A tail cannot heal a tool exchange whose call is in the covered prefix.
        // Retrying with the full transcript preserves the normal pairing checks.
        let mut open = BTreeSet::new();
        let mut intact = true;
        for block in template.messages.iter().flat_map(|entry| &entry.ck.content) {
            match &block.kind {
                ck_wire::CkKind::ToolCall {
                    id,
                    provider_executed: false,
                    ..
                } => {
                    open.insert(id);
                }
                ck_wire::CkKind::ToolResult {
                    id,
                    provider_executed: false,
                    ..
                } => {
                    intact &= open.remove(id);
                }
                _ => {}
            }
        }
        let mids = template
            .messages
            .iter()
            .map(|entry| entry.mid.as_str())
            .collect::<Vec<_>>();
        let snapshot = store
            .load_native_transform_snapshot(&key.engine_key(), &prefix.reference(), &mids)
            .map_err(transient)?;
        if !intact
            || !open.is_empty()
            || snapshot.loaded.core.reconcile_pending
            || snapshot
                .loaded
                .sections
                .as_ref()
                .is_none_or(|sections| sections.any_discarded())
            || !compartments.iter().any(|c| {
                c.end_message == prefix.through as i64
                    && c.end_message_id == snapshot.loaded.core.boundary_id
            })
        {
            return self.prepare(&status.lineage_id, template);
        }
        let Some(first) = template
            .messages
            .first()
            .map(|entry| entry.ordinal)
            .filter(|first| prefix.through.checked_add(1) == Some(*first))
        else {
            return self.prepare(&status.lineage_id, template);
        };
        let Some((mid, _)) = snapshot.loaded.core.boundary_id.rsplit_once('#') else {
            return self.prepare(&status.lineage_id, template);
        };
        template.declared_trim = Some(transform::DeclaredTrim {
            flat_boundary_id: snapshot.loaded.core.boundary_id.clone(),
            boundary_bare_message_id: mid.into(),
            boundary_absolute_ordinal: prefix.through,
            next_absolute_ordinal: first,
        });
        template.native_fold_snapshot = Some(Arc::new(snapshot));
        template.native_fold_hygiene = Some(lease.state.fold_hygiene.clone());
        template.native_fold_output = Some(lease.state.fold_output.clone());
        if !reuse {
            lease.state.fold_working = Some(super::fold_working::FoldWorking::build(
                &mut lease.state.fold_arena,
                tail_key,
                template,
                prefix.messages,
            )?);
        }
        template.native_fold_prefix = Some(prefix);
        template.native_fold_projection = Some(Arc::new(
            ck_wire::project_messages(&template.messages).map_err(transient)?,
        ));
        Ok(())
    }

    pub fn finish_fold(
        &mut self,
        store: &McStore,
        key: &Key,
        status: &transform::compaction::Status,
        template: &TransformRequest,
    ) -> Result<(), HandlerOutcome> {
        let Some(lease) = self.lease.as_mut() else {
            return Ok(());
        };
        let settings = store
            .provider_fold_settings(&key.store_key())
            .map_err(transient)?;
        if template
            .native_fold_prefix
            .as_ref()
            .is_some_and(|prefix| settings["coverage"].as_u64() == Some(prefix.through))
        {
            let mut prefix = template.native_fold_prefix.clone().unwrap();
            prefix.cut_id = settings["baseline_cut_id"]
                .as_u64()
                .ok_or_else(|| transient("runner baseline cut missing"))?;
            lease.state.fold_prefix = Some(prefix);
            #[cfg(test)]
            {
                lease.state.fold_tail_passes += 1;
            }
        } else {
            if let Some(rebuilt) = store
                .read_provider_fold_resident_policy(&key.store_key(), |index, counters| {
                    super::policy_summary::ResidentPolicy::rebuild(
                        index,
                        counters,
                        0,
                        &Default::default(),
                    )
                })
                .map_err(transient)?
            {
                lease.state = rebuilt;
            }
        }
        lease.state.fold_lineage = Some(status.lineage_id.clone());
        lease.state.fold_data_version =
            Some(store.provider_external_data_version().map_err(transient)?);
        lease.state.fold_source_raced = template
            .native_compartment_source_revision
            .as_ref()
            .is_some_and(|revision| {
                store
                    .compartment_source_revision(&key.engine_key())
                    .ok()
                    .flatten()
                    .as_ref()
                    != Some(revision)
            });
        let compartments = store
            .load_compartments(&key.engine_key())
            .map_err(transient)?;
        lease.state.fold_structure = lease
            .state
            .fold_prefix
            .as_ref()
            .map(|prefix| compaction::fold_structure(&compartments, prefix.through));
        Ok(())
    }

    pub fn publish(mut self) {
        if let Some(mut lease) = self.lease.take() {
            lease.state.runner = Some(self.state);
            if let Some(growth) = self.assistant_growth {
                lease.publish_assistant_growth(growth);
            } else {
                lease.publish();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

    #[test]
    fn cold_assistant_append_charges_existing_metadata_before_reusing_growth() {
        let root = std::env::temp_dir().join("magic-context/broca-hook");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let store = Arc::new(McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        }).unwrap());
        let slot = Arc::new(OnceLock::new());
        assert!(slot.set(store.clone()).is_ok());
        let storage = records::Storage::new(slot);
        let resident = super::super::resident_hooks::ResidentHooks::enabled(true);
        let key = Key {
            project: dir.path().join("project"),
            session: "cold".into(),
            harness: "broca".into(),
            generation: None,
        };
        let payload = "x".repeat(1024 * 1024);
        let initial = Record {
            hook: Some(HookState::default()),
            last_answer: Some(json!({"large_view":payload})),
            ..Default::default()
        };
        storage.save(&key, &initial).unwrap();
        let mut record = RunnerRecord::load(&storage, &resident, &store, &key).unwrap();
        assert!(!record.reused);
        record.hook.as_mut().unwrap().answers.push(HookRecord {
            subject: "assistant".into(),
            lineage: Some("L".into()),
            answer: hooks::answer::HookAnswer::Pass,
            rendered: vec!["answer".into()],
            tags: vec![],
            cadence: false,
            observed: false,
            tool_call_id: None,
        });
        record.save_assistant_answer(&store, &storage, &key).unwrap();
        assert!(record.state.metadata_bytes >= payload.len() * 4);
        assert!(record.assistant_growth.is_none());
        record.publish();
        assert!(resident.stats()["charged_bytes"].as_u64().unwrap() >= (payload.len() * 4) as u64);
        assert_eq!(storage.load(&key).unwrap().hook.unwrap().answers.len(), 1);
    }
}
