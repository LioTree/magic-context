//! Lossless rendering recipes address immutable message identities. Unchanged
//! source text is not copied merely to stamp a tag or append a reminder.
use super::codec::Codec;
use super::compaction::HostView;
use super::*;
use mc_store::{ProviderViewRecipe, ProviderViewSegment, ProviderViewTreatment};

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Edit {
    Set {
        path: Vec<String>,
        value: Value,
    },
    Remove {
        path: Vec<String>,
    },
    Affix {
        path: Vec<String>,
        before: String,
        after: String,
    },
}

fn difference(old: &Value, new: &Value, path: &mut Vec<String>, edits: &mut Vec<Edit>) {
    if old == new {
        return;
    }
    match (old, new) {
        (Value::Object(old), Value::Object(new)) => {
            for key in old.keys().filter(|key| !new.contains_key(*key)) {
                let mut path = path.clone();
                path.push(key.clone());
                edits.push(Edit::Remove { path });
            }
            for (key, new) in new {
                path.push(key.clone());
                if let Some(old) = old.get(key) {
                    difference(old, new, path, edits);
                } else {
                    edits.push(Edit::Set {
                        path: path.clone(),
                        value: new.clone(),
                    });
                }
                path.pop();
            }
        }
        (Value::Array(old), Value::Array(new)) if old.len() == new.len() => {
            for (i, (old, new)) in old.iter().zip(new).enumerate() {
                path.push(i.to_string());
                difference(old, new, path, edits);
                path.pop();
            }
        }
        (Value::String(old), Value::String(new))
            if !old.is_empty() && new.contains(old.as_str()) =>
        {
            let at = new.find(old.as_str()).expect("matched source");
            edits.push(Edit::Affix {
                path: path.clone(),
                before: new[..at].into(),
                after: new[at + old.len()..].into(),
            });
        }
        _ => edits.push(Edit::Set {
            path: path.clone(),
            value: new.clone(),
        }),
    }
}

fn at_path<'a>(value: &'a mut Value, path: &[String]) -> Result<&'a mut Value, HandlerOutcome> {
    let mut value = value;
    for key in path {
        value = if let Value::Array(array) = value {
            array.get_mut(key.parse::<usize>().map_err(transient)?)
        } else {
            value.get_mut(key)
        }
        .ok_or_else(|| transient("view treatment source path is missing"))?;
    }
    Ok(value)
}

fn apply(value: &mut Value, edits: &[Edit]) -> Result<(), HandlerOutcome> {
    for edit in edits {
        match edit {
            Edit::Set { path, value: next } => {
                if path.is_empty() {
                    *value = next.clone();
                } else {
                    let (last, parent) = path.split_last().expect("nonempty path");
                    let parent = at_path(value, parent)?;
                    if let Value::Object(object) = parent {
                        object.insert(last.clone(), next.clone());
                    } else {
                        *at_path(parent, std::slice::from_ref(last))? = next.clone();
                    }
                }
            }
            Edit::Remove { path } => {
                let (last, parent) = path
                    .split_last()
                    .ok_or_else(|| transient("view cannot remove message root"))?;
                let parent = at_path(value, parent)?
                    .as_object_mut()
                    .ok_or_else(|| transient("view removal requires object source"))?;
                parent.remove(last);
            }
            Edit::Affix {
                path,
                before,
                after,
            } => {
                let target = at_path(value, path)?;
                let source = target
                    .as_str()
                    .ok_or_else(|| transient("view affix requires text source"))?;
                *target = json!(format!("{before}{source}{after}"));
            }
        }
    }
    Ok(())
}

fn original(
    message: &mc_store::provider_records::ProviderMessage,
) -> Result<(Value, Value), HandlerOutcome> {
    let native: Value = serde_json::from_slice(&message.message_bytes).map_err(transient)?;
    let entry = compact::status::StatusMessage {
        ordinal: message.ordinal,
        mid: message.mid.clone(),
        message: native.clone(),
        raw_message: None,
    };
    let ck = Codec::OpencodeAiSdk.decode_message(&entry)?;
    Ok((serde_json::to_value(ck.ck).map_err(transient)?, native))
}

pub(super) fn save(
    store: &McStore,
    key: &Key,
    view: &HostView,
    state: &str,
) -> Result<(), HandlerOutcome> {
    save_with_base(store, key, view, state, None, None)
}

pub(super) trait RecipeBase {
    fn version(&self) -> u64;
    fn lineage(&self) -> &str;
    fn same_slot(&self, position: usize, ck: &ck_wire::CkWireMessage, wire: &Value) -> bool;
    fn same_native(&self, mid: &str, ordinal: u64, ck: &[u8], wire: &Value) -> bool;
}

pub(super) fn save_with_base(
    store: &McStore,
    key: &Key,
    view: &HostView,
    state: &str,
    previous_view: Option<&dyn RecipeBase>,
    engine_bytes: Option<&[std::borrow::Cow<'_, [u8]>]>,
) -> Result<(), HandlerOutcome> {
    let started = std::time::Instant::now();
    let first = view
        .engine
        .replacement
        .iter()
        .filter(|ck| !ck.meta.synthetic)
        .filter_map(|ck| ck.meta.ordinal)
        .min()
        .unwrap_or(view.engine.range.to);
    let sources: BTreeMap<_, _> = if first < view.engine.range.to {
        store
            .load_provider_message_sources_since(
                &key.store_key(),
                &view.engine.range.lineage_id,
                first,
            )
            .map_err(transient)?
            .into_iter()
            .map(|(lineage, message)| ((message.mid.clone(), message.ordinal), (lineage, message)))
            .collect()
    } else {
        BTreeMap::new()
    };
    let source_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut metadata = if previous_view.is_some() {
        serde_json::to_value(super::resident_view::ResidentView::metadata_of(view))
            .map_err(transient)?
    } else {
        serde_json::to_value(view).map_err(transient)?
    };
    metadata["engine"]["replacement"] = json!([]);
    metadata["wire"]["replacement"] = json!([]);
    let conversation = store
        .load_provider_conversation(&key.store_key())
        .map_err(transient)?;
    let counters: Value = conversation
        .as_ref()
        .map(|row| serde_json::from_str(&row.hook_counters_json).map_err(transient))
        .transpose()?
        .unwrap_or(Value::Null);
    let base = conversation
        .as_ref()
        .and_then(|c| c.setup_json.as_ref())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|s| s.pointer("/produced/version").and_then(Value::as_u64));
    let previous_view = previous_view.filter(|previous| {
        Some(previous.version()) == base
            && previous.lineage() == view.engine.range.lineage_id
            && previous.version() < view.engine.version
    });
    let mut recipe = ProviderViewRecipe {
        version: view.engine.version,
        lineage_id: view.engine.range.lineage_id.clone(),
        range_from: view.engine.range.from,
        range_to: view.engine.range.to,
        base_version: previous_view.map(|previous| previous.version()),
        policy_cut_id: counters
            .pointer("/engine_policy/baseline_cut_id")
            .and_then(Value::as_u64),
        metadata,
        segments: Vec::new(),
        synthetic: BTreeMap::new(),
        treatments: Vec::new(),
        serializer_profile: "opencode-aisdk".into(),
        render_key: "provider-open-code-render-v2".into(),
        tokenizer_key: "mc-tokenizer-byte-bpe-v1".into(),
        state: state.into(),
    };
    for (position, (ck, wire)) in view
        .engine
        .replacement
        .iter()
        .zip(&view.wire.replacement)
        .enumerate()
    {
        if ck.meta.synthetic || ck.meta.harness_id.is_none() {
            let slot = format!("synthetic-{position}");
            if !previous_view.is_some_and(|previous| previous.same_slot(position, ck, wire)) {
                recipe
                    .synthetic
                    .insert(slot.clone(), json!({"engine":ck,"wire":wire}));
            }
            recipe
                .segments
                .push(ProviderViewSegment::Synthetic { slot });
            continue;
        }
        let mid = ck.meta.harness_id.as_deref().expect("native identity");
        let ordinal = ck
            .meta
            .ordinal
            .ok_or_else(|| transient("view native ordinal is missing"))?;
        let (lineage, message) = sources
            .get(&(mid.to_string(), ordinal))
            .ok_or_else(|| transient("view source message is missing"))?;
        let encoded = engine_bytes.map(|bytes| bytes[position].as_ref());
        let fallback;
        let encoded = if let Some(encoded) = encoded {
            encoded
        } else {
            fallback = ck.to_canonical_json_vec().map_err(transient)?;
            &fallback
        };
        let unchanged =
            previous_view.is_some_and(|previous| previous.same_native(mid, ordinal, encoded, wire));
        if !unchanged {
            let (old_engine, old_wire) = original(message)?;
            let mut engine_edits = Vec::new();
            let mut wire_edits = Vec::new();
            difference(
                &old_engine,
                &serde_json::to_value(ck).map_err(transient)?,
                &mut Vec::new(),
                &mut engine_edits,
            );
            difference(&old_wire, wire, &mut Vec::new(), &mut wire_edits);
            let edited = !engine_edits.is_empty() || !wire_edits.is_empty();
            if edited || previous_view.is_some() {
                recipe.treatments.push(ProviderViewTreatment {
                    source_lineage_id: lineage.clone(),
                    mid: mid.into(),
                    ordinal,
                    block_index: -1,
                    block_id: format!("{mid}#@message"),
                    patch: edited
                        .then(|| json!({"format":1,"engine":engine_edits,"wire":wire_edits})),
                });
            }
        }
        if let Some(ProviderViewSegment::NativeRange {source_lineage_id,to,last_mid,..})=recipe.segments.last_mut().filter(|segment|matches!(segment,ProviderViewSegment::NativeRange {source_lineage_id,to,..} if source_lineage_id==lineage && *to==ordinal)) {*to=ordinal+1;*last_mid=mid.into();let _=source_lineage_id;} else {
            recipe.segments.push(ProviderViewSegment::NativeRange {source_lineage_id:lineage.clone(),from:ordinal,to:ordinal+1,first_mid:mid.into(),last_mid:mid.into()});
        }
    }
    let diff_ms = started.elapsed().as_secs_f64() * 1000.0 - source_ms;
    // Store only changed synthetic slots and treatments relative to the base view.
    // After 16 ancestors or 8 MiB of inherited recipes, the store merges their
    // entries into one standalone recipe without copying native message bodies.
    if let Some(base) = base.filter(|base| previous_view.is_none() && *base < recipe.version) {
        if let Some(old) = store
            .resolve_provider_view_catalog(&key.store_key(), base)
            .map_err(transient)?
        {
            recipe.base_version = Some(base);
            recipe
                .synthetic
                .retain(|slot, value| old.recipe.synthetic.get(slot) != Some(value));
            let mut previous: BTreeMap<_, _> = old
                .recipe
                .treatments
                .into_iter()
                .map(|t| {
                    (
                        (t.source_lineage_id.clone(), t.mid.clone(), t.block_index),
                        t,
                    )
                })
                .collect();
            recipe.treatments.retain(|t| {
                previous
                    .remove(&(t.source_lineage_id.clone(), t.mid.clone(), t.block_index))
                    .is_none_or(|old| old.patch != t.patch)
            });
            for (_, mut reset) in previous {
                reset.patch = None;
                recipe.treatments.push(reset);
            }
        }
    }
    let catalog_ms = started.elapsed().as_secs_f64() * 1000.0 - source_ms - diff_ms;
    let bytes = store
        .save_provider_view_recipe(&key.store_key(), &recipe)
        .map_err(transient)?;
    tracing::info!(session_id=%key.session,view_version=view.engine.version,stored_view_bytes=bytes,source_ms,diff_ms,catalog_ms,persist_ms=started.elapsed().as_secs_f64()*1000.0-source_ms-diff_ms-catalog_ms,"provider view recipe stored");
    Ok(())
}

pub(super) fn load(
    store: &McStore,
    key: &Key,
    version: u64,
) -> Result<Option<HostView>, HandlerOutcome> {
    let started = std::time::Instant::now();
    let Some(resolved) = store
        .resolve_provider_view(&key.store_key(), version)
        .map_err(transient)?
    else {
        return Ok(None);
    };
    let resolve_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut metadata = resolved.recipe.metadata;
    let mut engines = Vec::new();
    let mut wires = Vec::new();
    let mut sources: BTreeMap<_, _> = resolved
        .messages
        .into_iter()
        .map(|(lineage, message)| ((lineage, message.ordinal), message))
        .collect();
    let treatments: BTreeMap<_, _> = resolved
        .recipe
        .treatments
        .into_iter()
        .map(|t| ((t.source_lineage_id.clone(), t.mid.clone()), t))
        .collect();
    for segment in resolved.recipe.segments {
        match segment {
            ProviderViewSegment::Synthetic { slot } => {
                let entry = resolved
                    .recipe
                    .synthetic
                    .get(&slot)
                    .ok_or_else(|| transient("view synthetic slot is missing"))?;
                engines.push(entry["engine"].clone());
                wires.push(entry["wire"].clone());
            }
            ProviderViewSegment::NativeRange {
                source_lineage_id,
                from,
                to,
                ..
            } => {
                for ordinal in from..to {
                    let message = sources
                        .remove(&(source_lineage_id.clone(), ordinal))
                        .ok_or_else(|| transient("view source lifetime ended"))?;
                    let (mut engine, mut wire) = original(&message)?;
                    if let Some(treatment) =
                        treatments.get(&(source_lineage_id.clone(), message.mid))
                    {
                        let patch = treatment.patch.as_ref().expect("effective treatment");
                        if patch["format"] != json!(1) {
                            return Err(transient("unknown view treatment format"));
                        }
                        apply(
                            &mut engine,
                            &serde_json::from_value::<Vec<Edit>>(patch["engine"].clone())
                                .map_err(transient)?,
                        )?;
                        apply(
                            &mut wire,
                            &serde_json::from_value::<Vec<Edit>>(patch["wire"].clone())
                                .map_err(transient)?,
                        )?;
                    }
                    engines.push(engine);
                    wires.push(wire);
                }
            }
        }
    }
    metadata["engine"]["replacement"] = json!(engines);
    metadata["wire"]["replacement"] = json!(wires);
    let view = serde_json::from_value(metadata).map_err(transient)?;
    tracing::info!(session_id=%key.session,view_version=version,resolve_ms,reconstruct_ms=started.elapsed().as_secs_f64()*1000.0-resolve_ms,"provider view recipe loaded");
    Ok(Some(view))
}
