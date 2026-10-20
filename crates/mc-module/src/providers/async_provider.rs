//! Runner-owned tags and durable, off-request compaction views.
use super::codec::{InboundMessage, OutboundMessage};
use super::*;
use compact::{self as contract, ceiling::CeilingPolicy, notice, ride, view};
use cortexkit_bus_trait::{ContentDigest, DurableOwner, Stream, StreamCursor};
use cortexkit_role_llm_runner::{read::ReadMessage, session_ref, tags};
use serde::Deserialize;
#[cfg(test)]
mod tests;

fn bus_id(reference: &str, kind: &str, sequence: u64) -> String {
    format!("{reference}:{kind}:{sequence}")
}

#[async_trait]
trait Publisher: Send + Sync {
    async fn publish(&self, ready: &notice::ViewReady) -> Result<(), HandlerOutcome>;
}

struct Bus<S> {
    stream: Arc<S>,
    account: String,
}

struct RoutedRunner<'a> {
    runner: &'a dyn session_resolver::ProviderRunner,
    route: crate::route_targets::SessionRunnerRoute,
}
#[async_trait]
impl session_resolver::ProviderRunner for RoutedRunner<'_> {
    async fn call(
        &self,
        project: &Path,
        session: &str,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        if session != self.route.parent_session() {
            return Err(SessionResolveError::InvalidResponse(
                "session runner route mismatch".into(),
            ));
        }
        self.runner
            .call_for(&self.route, project, method, params, budget)
            .await
    }
}

#[async_trait]
impl<S: Stream + 'static> Publisher for Bus<S> {
    async fn publish(&self, ready: &notice::ViewReady) -> Result<(), HandlerOutcome> {
        let receipt = self
            .stream
            .publish(
                &notice::event_subject(&self.account, DEFAULT_MODULE_ID, notice::VIEW_READY_EVENT),
                &bus_id(&ready.session_ref, "view_ready", ready.view_version),
                ready.digest.parse::<ContentDigest>().map_err(transient)?,
                ready.to_headers(),
            )
            .await
            .map_err(transient)?;
        let _ = receipt.duplicate();
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct Runtime {
    #[cfg(test)]
    completed_notice: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    historian_evaluations: std::sync::atomic::AtomicU64,
    pub(crate) connection_file: Mutex<Option<PathBuf>>,
    pub(crate) bootstrapped: OnceLock<()>,
    /// The bus link's named state, which a `bus_not_ready` refusal reports.
    pub(crate) bus_link: Arc<super::async_bus::LinkStatus>,
    publisher: Mutex<Option<Arc<dyn Publisher>>>,
    unconfigured_logged: OnceLock<()>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct AsyncRecord {
    #[serde(default)]
    historian_cadence: Option<HistorianCadence>,
    #[serde(default)]
    historian_pending: bool,
    #[serde(default)]
    restored_no_new_content: bool,
    #[serde(default)]
    resync_sources: Option<ResyncSources>,
    #[serde(default)]
    restored_head: Option<RestoredHead>,
    #[serde(default)]
    last_discarded_drops: usize,
    #[serde(default)]
    last_transferred_drops: usize,
    #[serde(default)]
    tag_index: BTreeMap<String, PartAddress>,
    #[serde(default)]
    pub(crate) usage_policy: Option<super::usage_policy::UsagePolicyState>,
    #[serde(default)]
    pub(crate) todo_scan: Option<super::runner_todo::TodoScan>,
    #[serde(default)]
    pub(crate) runner_route: Option<Value>,
    #[serde(default)]
    pub(crate) dream_target: Option<Value>,
    #[serde(default)]
    pub(crate) reminder_cadence: Option<crate::runner_reminders::ReminderState>,
    key: Key,
    runner_module: String,
    setup: compact::setup::SetupRequest,
    initial: Value,
    engine: transform::compaction::State,
    published_engine: BTreeMap<u64, transform::compaction::View>,
    lineage: Option<String>,
    entries: BTreeMap<u64, ReadMessage>,
    seq: u64,
    completed_seq: u64,
    applied: Option<u64>,
    acknowledgements: Vec<String>,
    marker_outcomes: BTreeMap<String, String>,
    conditions: Option<BTreeMap<String, String>>,
    resync: bool,
    generation: u64,
}
type State = AsyncRecord;

#[derive(Serialize, Deserialize)]
struct PartAddress {
    ordinal: u64,
    mid: String,
    part: String,
    digest: String,
}

#[derive(Serialize, Deserialize)]
struct SourceMessage {
    mid: String,
    digest: String,
}
#[derive(Serialize, Deserialize)]
struct HistorySource {
    compartment: mc_store::StoredCompartment,
    messages: Vec<SourceMessage>,
}
#[derive(Serialize, Deserialize)]
struct DropSource {
    mid: String,
    part: String,
    digest: String,
    queued_at_ms: i64,
}
#[derive(Serialize, Deserialize)]
struct ResyncSources {
    namespace: String,
    history: Vec<HistorySource>,
    drops: Vec<DropSource>,
    queued_count: usize,
    head: Option<HistoryHeadSource>,
    #[serde(default)]
    messages: Vec<SourceMessage>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
struct HistorianCadence {
    user: Option<String>,
    tools: u64,
    model: String,
    settings: String,
}

#[derive(Serialize, Deserialize)]
struct HistoryHeadSource {
    bytes: String,
    messages: Vec<SourceMessage>,
}
#[derive(Serialize, Deserialize)]
struct RestoredHead {
    bytes: String,
    to: u64,
}

fn verified_descent(state: &State, header: &str) -> Option<u64> {
    let mut fields = header.rsplitn(3, ':');
    let digest = fields.next()?;
    let through = fields.next()?.parse::<u64>().ok()?;
    let lineage = fields.next()?;
    if state.lineage.as_deref() != Some(lineage) {
        return None;
    }
    let entry = state.entries.get(&through)?;
    (contract::digest::content_digest(&entry.message) == digest).then_some(through)
}

impl State {
    fn runner(&self) -> Result<crate::route_targets::SessionRunnerRoute, HandlerOutcome> {
        crate::route_targets::SessionRunnerRoute::for_principal(
            Some(&subc_protocol::Principal::Reserved {
                module_id: self.runner_module.clone(),
            }),
            &self.key.session,
        )
        .ok_or_else(|| invalid_field("runner", "unsupported session runner principal"))
    }
    fn reference(&self) -> String {
        session_ref(
            &self.key.harness,
            &self.key.project.to_string_lossy(),
            &self.key.session,
        )
    }
    fn namespace(&self) -> String {
        format!("{}:async:{}", self.key.engine_key(), self.generation)
    }
    fn save(&self, store: &McStore, tag_rows: &[mc_store::McTagRow]) -> Result<(), HandlerOutcome> {
        store
            .save_async_compaction(
                &self.reference(),
                &self.key.store_key().conversation_key(),
                &self.key.session,
                &serde_json::to_string(self).map_err(transient)?,
                &self.namespace(),
                tag_rows,
            )
            .map_err(transient)
    }
    fn reset(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        if self.resync_sources.is_none() {
            let namespace = self.namespace();
            store
                .resume_pending_context_write(&namespace)
                .map_err(transient)?;
            let history = store
                .load_compartments(&namespace)
                .map_err(transient)?
                .into_iter()
                .map(|compartment| {
                    let start = (compartment.start_message.max(0) as u64).max(
                        self.entries
                            .first_key_value()
                            .map_or(0, |(ordinal, _)| *ordinal),
                    );
                    let end = compartment.end_message.max(0) as u64;
                    let messages = if start <= end && self.entries.contains_key(&end) {
                        self.entries
                            .range(start..=end)
                            .map(|(_, entry)| SourceMessage {
                                mid: entry.mid.clone(),
                                digest: contract::digest::content_digest(&entry.message),
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    HistorySource {
                        compartment,
                        messages,
                    }
                })
                .collect();
            let codec = codec::Codec::from_params(&Value::Object(self.setup.params.clone()))?;
            let rows = tag_rows(self, codec)?;
            let queued = store
                .load_pending_agent_drops(&namespace)
                .map_err(transient)?;
            let drops = queued
                .iter()
                .filter_map(|drop| {
                    let row = rows.iter().find(|row| row.block_id == drop.target_id)?;
                    let tag = tags::format_tag(u64::try_from(row.tag_number).ok()?)?;
                    let address = self.tag_index.get(&tag)?;
                    Some(DropSource {
                        mid: address.mid.clone(),
                        part: address.part.clone(),
                        digest: address.digest.clone(),
                        queued_at_ms: drop.queued_at_ms,
                    })
                })
                .collect();
            let applied = self
                .applied
                .map(|version| {
                    store
                        .load_async_compaction_view(&self.reference(), version)
                        .map_err(transient)
                })
                .transpose()?
                .flatten()
                .map(|raw| serde_json::from_str::<view::CompactionView>(&raw).map_err(transient))
                .transpose()?;
            let head = applied.and_then(|view| match view.ranges.first()? {
                view::ViewRange::Replace { from: 0, to, bytes }
                    if *to == 0 || self.entries.contains_key(&(to - 1)) =>
                {
                    Some(HistoryHeadSource {
                        bytes: bytes.clone(),
                        messages: self
                            .entries
                            .range(..*to)
                            .map(|(_, entry)| SourceMessage {
                                mid: entry.mid.clone(),
                                digest: contract::digest::content_digest(&entry.message),
                            })
                            .collect(),
                    })
                }
                _ => None,
            });
            self.resync_sources = Some(ResyncSources {
                namespace,
                history,
                drops,
                queued_count: queued.len(),
                head,
                messages: self
                    .entries
                    .values()
                    .map(|entry| SourceMessage {
                        mid: entry.mid.clone(),
                        digest: contract::digest::content_digest(&entry.message),
                    })
                    .collect(),
            });
        }
        self.resync = true;
        self.restored_no_new_content = false;
        self.restored_head = None;
        self.entries.clear();
        self.tag_index.clear();
        self.todo_scan = None;
        self.lineage = None;
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| transient("async generation exhausted"))?;
        self.engine = transform::compaction::State::new(self.reference(), self.engine.preset);
        self.published_engine.clear();
        self.save(store, &[])?;
        store
            .retire_unannounced_async_views(&self.reference())
            .map_err(transient)?;
        Ok(())
    }
}

fn load(store: &McStore, reference: &str) -> Result<Option<State>, HandlerOutcome> {
    store
        .load_async_compaction(reference)
        .map_err(transient)?
        .map(|raw| serde_json::from_str(&raw).map_err(transient))
        .transpose()
}

fn checked_async_view(view: view::CompactionView) -> Result<view::CompactionView, HandlerOutcome> {
    view.check().map_err(|error| transient(error.name()))?;
    Ok(view)
}

struct OverflowFact {
    reported_limit_tokens: Option<u64>,
}

fn ride_overflow(request: &ride::RideRequest) -> Option<OverflowFact> {
    request.ceiling_overflow().map(|overflow| OverflowFact {
        reported_limit_tokens: overflow.reported_limit_tokens,
    })
}

fn apply_ride_overflow(state: &mut State, fact: OverflowFact) {
    let policy = state.usage_policy.get_or_insert_with(Default::default);
    let model = state
        .conditions
        .as_ref()
        .and_then(|headers| headers.get("model"))
        .unwrap_or(&state.setup.model)
        .clone();
    policy.model = Some(model.clone());
    if let Some(tokens) = fact.reported_limit_tokens.filter(|tokens| *tokens > 0) {
        policy.learned_limit = Some(super::usage_policy::LearnedLimit {
            tokens,
            model,
            provenance: Some(crate::scheduler::ContextLimitProvenance::Unknown),
        });
    }
    if state.engine.preset == transform::compaction::Preset::Head {
        policy.emergency_recovery_armed = true;
    }
}

impl McHandler {
    /// Attach only to the durable provisioned by ck-bus. No local consumer or
    /// unauthenticated NATS fallback is created when bootstrap is unavailable.
    pub async fn start_compaction_bus<S: Stream + 'static>(
        self: Arc<Self>,
        stream: Arc<S>,
        account: String,
    ) -> Result<tokio::task::JoinHandle<()>, String> {
        let names =
            cortexkit_bus_naming::AccountNames::derive(&account).map_err(|e| e.to_string())?;
        let _ = names;
        let mut cursor = stream
            .consumer(DurableOwner::Module(DEFAULT_MODULE_ID))
            .await
            .map_err(|e| e.to_string())?;
        *self
            .provider_store
            .async_runtime
            .publisher
            .lock()
            .expect("async publisher") = Some(Arc::new(Bus {
            stream,
            account: account.clone(),
        }));
        Ok(tokio::spawn(async move {
            loop {
                if let Err(error) = self.announce_async_views().await {
                    tracing::warn!(?error, "async compaction announcement retry");
                }
                let delivery = match cursor.next().await {
                    Ok(Some(delivery)) => delivery,
                    Ok(None) => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                    Err(error) => {
                        tracing::warn!(%error,"async compaction bus read failed");
                        break;
                    }
                };
                let result = self.advance_compaction(&account, &delivery.message).await;
                #[cfg(test)]
                if result.is_ok() {
                    let seq = delivery
                        .message
                        .headers
                        .get("seq")
                        .and_then(|seq| seq.parse().ok())
                        .unwrap_or(0);
                    self.provider_store
                        .async_runtime
                        .completed_notice
                        .fetch_max(seq, std::sync::atomic::Ordering::Relaxed);
                }
                let settled = match result {
                    Ok(()) => cursor.ack().await,
                    Err(HandlerOutcome::ErrorWithDetail { ref code, .. })
                        if code == "invalid_params" =>
                    {
                        cursor.term(Some("malformed_compaction_notice")).await
                    }
                    Err(error) => {
                        tracing::warn!(?error, "async compaction ingest retry");
                        cursor.nak(Duration::from_secs(1)).await
                    }
                };
                if let Err(error) = settled {
                    tracing::warn!(%error,"async compaction acknowledgement failed");
                    break;
                }
            }
            self.provider_store
                .async_runtime
                .publisher
                .lock()
                .expect("async publisher")
                .take();
        }))
    }

    pub(super) async fn async_setup(
        &self,
        channel: u16,
        binding: &SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let request: compact::setup::SetupRequest = decode(params)?;
        let mut key = Key::new(binding, &request.session, &request.harness)?;
        key.session.clone_from(&request.session);
        let _serial = self.provider_serial.lock_for(&key).await;
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        if self
            .provider_store
            .async_runtime
            .publisher
            .lock()
            .expect("async publisher")
            .is_none()
        {
            self.provider_store
                .async_runtime
                .unconfigured_logged
                .get_or_init(|| tracing::warn!("async compaction bus not configured"));
            let reason = format!(
                "Async compaction bus not ready ({})",
                self.provider_store.async_runtime.bus_link.describe()
            );
            return bytes(
                &json!({"answer":"refuse","request_id":request.request_id,"code":"provider_busy","provider_code":"bus_not_ready","reason":reason}),
            );
        }
        let reference = session_ref(&key.harness, &key.project.to_string_lossy(), &key.session);
        if let Some(state) = load(store, &reference)? {
            self.authorize_async(binding, &state)?;
            let project = self.historian_lane_project(channel, binding, store)?;
            self.record_session_runner_dream_target(
                &project,
                &state.key.project,
                &state.key.harness,
                state.runner()?,
            );
            if state.setup.params != request.params
                || state.setup.composition != request.composition
                || state.setup.preset != request.preset
            {
                return Err(invalid_field("params", "async setup plan is frozen"));
            }
            let mut answer = state.initial;
            answer["request_id"] = json!(request.request_id);
            return bytes(&answer);
        }
        let codec = codec::Codec::from_params(&Value::Object(request.params.clone()))?;
        let chosen = preset(request.preset.as_deref())?;
        let mut engine = transform::compaction::State::new(reference.clone(), chosen);
        let mut state = State {
            historian_cadence: None,
            historian_pending: false,
            restored_no_new_content: false,
            resync_sources: None,
            restored_head: None,
            last_discarded_drops: 0,
            last_transferred_drops: 0,
            tag_index: BTreeMap::new(),
            usage_policy: None,
            todo_scan: None,
            runner_route: None,
            dream_target: None,
            reminder_cadence: None,
            key,
            runner_module: match &binding.principal {
                Some(subc_protocol::Principal::Reserved { module_id }) => module_id.clone(),
                _ => {
                    return Err(invalid_field(
                        "compaction_mode",
                        "async requires an attested runner",
                    ))
                }
            },
            setup: request.clone(),
            initial: Value::Null,
            engine: engine.clone(),
            published_engine: BTreeMap::new(),
            lineage: request.lineage_id.clone(),
            entries: BTreeMap::new(),
            seq: 0,
            completed_seq: 0,
            applied: None,
            acknowledgements: vec![],
            marker_outcomes: BTreeMap::new(),
            conditions: None,
            resync: false,
            generation: 0,
        };
        let route = state.runner()?;
        state.runner_route =
            Some(json!({"module_id":route.module_id(),"parent_session":route.parent_session()}));
        let project = self.historian_lane_project(channel, binding, store)?;
        state.dream_target = Some(
            json!({"project":project,"directory":state.key.project,"harness":state.key.harness,"route":state.runner_route}),
        );
        self.record_session_runner_dream_target(
            &project,
            &state.key.project,
            &state.key.harness,
            route,
        );
        let status = transform::compaction::Status {
            lineage_id: state.lineage.clone().unwrap_or_default(),
            newest_ordinal: None,
            previous_usage: None,
            request_tokens: 0,
            context_window: request.context_window.ok_or_else(|| {
                invalid_field("context_window", "async setup needs a context window")
            })?,
            prefix_rebuilding: false,
            pipeline_switch: false,
            last_applied_version: None,
            last_not_applied: None,
        };
        let (_template, output) =
            self.async_engine(channel, binding, &state, codec, &status, &mut engine)?;
        let transform::compaction::Answer::Replacement(initial) = &output.answer else {
            return Err(transient("async setup returned no initial view"));
        };
        let wire = rendered_view(codec, initial, &state)?;
        state.engine = engine;
        // `serializer_profile` is a ck-mc extension member: the profile this
        // Setup accepted, so the runner can confirm ck-mc reads its schema.
        state.initial = json!({"answer":"ready","request_id":request.request_id,"initial":wire, "ceiling":CeilingPolicy::new(0.95,300_000).with_on_overflow(),"serializer_profile":codec.wire_id()});
        state.save(store, &[])?;
        bytes(&state.initial)
    }

    fn async_engine(
        &self,
        channel: u16,
        binding: &SessionBinding,
        state: &State,
        codec: codec::Codec,
        status: &transform::compaction::Status,
        engine: &mut transform::compaction::State,
    ) -> Result<(TransformRequest, transform::compaction::Output), HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let model = state
            .conditions
            .as_ref()
            .and_then(|n| n.get("model"))
            .map(String::as_str)
            .unwrap_or(&state.setup.model);
        let mut template: TransformRequest = decode(
            &json!({"v":2,"kind":"compaction.step","session_id":state.namespace(),"messages":[],"render_config":serde_json::to_string(&state.setup.params).map_err(transient)?,"model_key":model,"tool_present":false,"auto_search_enabled":false}),
        )?;
        let messages = state
            .entries
            .values()
            .map(|entry| InboundMessage {
                ordinal: entry.ordinal,
                mid: entry.mid.clone(),
                message: entry.message.clone(),
            })
            .collect::<Vec<_>>();
        codec.prepare_request(&mut template, &messages)?;
        template.native_tail_section = true;
        if let Some(policy) = &state.usage_policy {
            template.emergency_recovery_armed = policy.emergency_recovery_armed;
            if let Some(limit) = policy.limit_for(model) {
                template.detected_context_limit = limit;
                template.detected_context_limit_model_key = Some(model.into());
            }
        }
        let work = self.provider_work(channel, store, binding.clone(), state.key.clone())?;
        let mut context = compaction::producer_context(
            &work,
            template.model_key.as_deref().unwrap_or(&state.setup.model),
            status.context_window,
            false,
        );
        context.cache_ttl = "never".into();
        // On this lane the runner owns the model provider's companion edit:
        // views never remove the signed reasoning they invalidate.
        let signed = transform::compaction::SignedReasoning::RunnerCompanion;
        let output = if engine.last_applied.is_none() {
            transform::compaction::setup_with(store, &template, &context, status, engine, signed)
        } else {
            transform::compaction::step_with(store, &template, &context, status, engine, signed)
        }
        .map_err(transient)?;
        Ok((template, output))
    }
}

fn parts(message: &Value) -> Result<std::borrow::Cow<'_, [Value]>, HandlerOutcome> {
    // An Anthropic message may carry its content as one string instead of a
    // block array; the runner exposes that string as the message's one part.
    if let Some(text @ Value::String(_)) = message.get("content") {
        if message.get("parts").is_none() {
            return Ok(std::borrow::Cow::Owned(vec![text.clone()]));
        }
    }
    message
        .get("parts")
        .or_else(|| message.get("content"))
        .or_else(|| message.pointer("/message/content"))
        .and_then(Value::as_array)
        .map(|parts| std::borrow::Cow::Borrowed(parts.as_slice()))
        .ok_or_else(|| invalid_field("message", "codec must expose an ordered parts array"))
}

fn decoded_entry(
    codec: codec::Codec,
    entry: &InboundMessage,
) -> Result<ck_wire::CkIngressMessage, HandlerOutcome> {
    codec
        .decode_entries(std::slice::from_ref(entry))?
        .pop()
        .ok_or_else(|| error("history_unreadable", "runner entry has no model message"))
}

fn rendered_view(
    codec: codec::Codec,
    view: &transform::compaction::View,
    state: &State,
) -> Result<OutboundMessage, HandlerOutcome> {
    let entries = state
        .entries
        .values()
        .map(|entry| InboundMessage {
            ordinal: entry.ordinal,
            mid: entry.mid.clone(),
            message: entry.message.clone(),
        })
        .collect::<Vec<_>>();
    codec.render_view(view, &state.key.session, &entries)
}

fn render_part(part: &Value, tag: Option<&str>, render: bool) -> Value {
    let mut part = part.clone();
    if !render {
        return part;
    }
    if let Value::String(text) = &part {
        return json!(tags::render_text(
            tags::RenderKind::ToolResultText,
            tag,
            text
        ));
    }
    // An Anthropic `tool_result` may carry its output as a plain `content` string.
    let anthropic_result = (part["type"] == "tool_result").then_some("/content");
    for pointer in ["/text", "/state/output", "/state/error", "/output/text"]
        .into_iter()
        .chain(anthropic_result)
    {
        if let Some(value) = part.pointer_mut(pointer).filter(|v| v.is_string()) {
            *value = json!(tags::render_text(
                tags::RenderKind::ToolResultText,
                tag,
                value.as_str().unwrap()
            ));
            break;
        }
    }
    part
}

fn stable_entry(left: &ReadMessage, right: &ReadMessage) -> bool {
    left.ordinal == right.ordinal
        && left.mid == right.mid
        && left.message == right.message
        && left.tags == right.tags
        && left.role == right.role
        && left.written_at == right.written_at
        && left.delivered_as == right.delivered_as
}

fn tag_rows(state: &State, codec: codec::Codec) -> Result<Vec<mc_store::McTagRow>, HandlerOutcome> {
    let mut rows = Vec::new();
    let mut seen = BTreeSet::new();
    for entry in state.entries.values() {
        let native = parts(&entry.message)?;
        if native.len() != entry.tags.len() {
            return Err(invalid_field(
                "tags",
                "runner must expose one tag row per part",
            ));
        }
        let decoded = decoded_entry(
            codec,
            &InboundMessage {
                ordinal: entry.ordinal,
                mid: entry.mid.clone(),
                message: entry.message.clone(),
            },
        )?;
        for (index, block) in decoded.ck.content.iter().enumerate() {
            let native_index = block
                .provider_extras
                .get("_cortexkit_codec")
                .and_then(|e| e.get("nativeIndex"))
                .and_then(Value::as_u64)
                .unwrap_or(index as u64) as usize;
            let Some(row) = entry.tags.get(native_index) else {
                return Err(invalid_field(
                    "tags",
                    "codec part index outside runner tags",
                ));
            };
            let Some(tag) = row.tag.as_deref() else {
                continue;
            };
            let number = tags::parse_tag(tag)
                .ok_or_else(|| invalid_field("tags", "malformed runner tag"))?;
            let (kind, text) = match &block.kind {
                ck_wire::CkKind::Text { text } => ("message", text.as_str()),
                ck_wire::CkKind::ToolResult { output, .. } => match &output.kind {
                    ck_wire::CkOutputKind::Text { text }
                    | ck_wire::CkOutputKind::ErrorText { text } => ("tool_result", text.as_str()),
                    _ => continue,
                },
                _ => continue,
            };
            if !seen.insert(number) {
                return Err(invalid_field("tags", "runner reused a tag"));
            }
            rows.push(mc_store::McTagRow {
                tag_number: i64::try_from(number).map_err(invalid)?,
                block_id: format!("{}#{index}", entry.mid),
                kind: kind.into(),
                token_count: mc_tokenizer::estimate_tokens(text) as i64,
                created_at_ms: now_ms(),
                source_bytes: text.as_bytes().into(),
            });
        }
    }
    Ok(rows)
}

fn ranges(
    state: &State,
    codec: codec::Codec,
    wire: &OutboundMessage,
    engine: &transform::compaction::View,
    history_through: Option<u64>,
) -> Result<Vec<view::ViewRange>, HandlerOutcome> {
    let end = state
        .entries
        .last_key_value()
        .ok_or_else(|| transient("empty async view"))?
        .0
        .checked_add(1)
        .ok_or_else(|| invalid("ordinal exhausted"))?;
    let mut ranges = Vec::new();
    let mut synthetic = Vec::new();
    let mut next = 0;
    let history_end = history_through
        .map_or(0, |through| through.saturating_add(1))
        .max(
            state
                .entries
                .first_key_value()
                .map_or(0, |(ordinal, _)| *ordinal),
        );
    let render = state
        .setup
        .composition
        .get("render_tags")
        .and_then(Value::as_bool)
        == Some(true);
    for (position, message) in wire.replacement.iter().enumerate() {
        let mid = message
            .pointer("/info/id")
            .or_else(|| message.get("id"))
            .and_then(Value::as_str);
        let original = if let Some(mid) = mid {
            state.entries.values().find(|entry| entry.mid == mid)
        } else {
            engine
                .replacement
                .get(position)
                .filter(|m| !m.meta.synthetic)
                .and_then(|m| m.meta.ordinal)
                .and_then(|n| state.entries.get(&n))
        };
        let Some(original) = original else {
            synthetic.push(message.clone());
            continue;
        };
        if original.ordinal < next {
            return Err(transient("async render reordered transcript"));
        }
        if original.ordinal > next || !synthetic.is_empty() {
            append_view_gap(
                state,
                &mut ranges,
                &mut synthetic,
                &mut next,
                original.ordinal,
                history_end,
            )?;
        }
        let before = parts(&original.message)?;
        let after = parts(message)?;
        // Which runner part each rendered part came from, for schemas whose
        // parts have no ids: a removed part then shifts the rest left, so
        // position alone would pair a kept part with its neighbour's bytes.
        let origins = engine
            .replacement
            .get(position)
            .and_then(|ck| codec.part_origins(ck, message));
        let mut edits = Vec::new();
        for (index, (part, row)) in before.iter().zip(&original.tags).enumerate() {
            let expected = render_part(part, row.tag.as_deref(), render);
            let changed = if let Some(origins) = &origins {
                origins
                    .iter()
                    .position(|origin| *origin == Some(index))
                    .and_then(|at| after.get(at))
            } else if let Some(id) = part.get("id").and_then(Value::as_str) {
                after
                    .iter()
                    .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
            } else {
                after.get(index)
            };
            match changed {
                None => edits.push(view::PartEdit::drop(
                    original.ordinal,
                    &original.mid,
                    &row.part,
                )),
                Some(value) if value != &expected && value != part => {
                    edits.push(view::PartEdit::replace(
                        original.ordinal,
                        &original.mid,
                        &row.part,
                        serde_json::to_string(value).map_err(transient)?,
                    ))
                }
                _ => {}
            }
        }
        ranges.push(view::ViewRange::keep_with_edits(
            original.ordinal,
            original.ordinal + 1,
            edits,
        ));
        next = original.ordinal + 1;
    }
    if next < end || !synthetic.is_empty() {
        append_view_gap(
            state,
            &mut ranges,
            &mut synthetic,
            &mut next,
            end,
            history_end,
        )?;
    }
    Ok(ranges)
}

fn append_view_gap(
    state: &State,
    ranges: &mut Vec<view::ViewRange>,
    synthetic: &mut Vec<Value>,
    next: &mut u64,
    to: u64,
    history_end: u64,
) -> Result<(), HandlerOutcome> {
    let prefix = ranges.is_empty() && *next == 0;
    let replacement_to = if prefix {
        to.min(history_end)
    } else if !synthetic.is_empty() {
        to
    } else {
        *next
    };
    if replacement_to > *next || !synthetic.is_empty() {
        ranges.push(view::ViewRange::replace(
            *next,
            replacement_to,
            serde_json::to_string(synthetic).map_err(transient)?,
        ));
        synthetic.clear();
        *next = replacement_to;
    }
    for (ordinal, entry) in state.entries.range(*next..to) {
        let edits = entry
            .tags
            .iter()
            .map(|part| view::PartEdit::drop(*ordinal, &entry.mid, &part.part))
            .collect();
        ranges.push(view::ViewRange::keep_with_edits(
            *ordinal,
            *ordinal + 1,
            edits,
        ));
    }
    *next = to;
    Ok(())
}

impl McHandler {
    async fn announce_async_views(&self) -> Result<(), HandlerOutcome> {
        let Some(store) = self.store.get() else {
            return Ok(());
        };
        let publisher = self
            .provider_store
            .async_runtime
            .publisher
            .lock()
            .expect("async publisher")
            .clone()
            .ok_or_else(|| transient("bus not configured"))?;
        for (reference, version, raw) in
            store.pending_async_compaction_views().map_err(transient)?
        {
            let view: view::CompactionView = serde_json::from_str(&raw).map_err(transient)?;
            if load(store, &reference)?.is_none_or(|state| {
                state.resync || state.lineage.as_deref() != Some(&view.lineage_id)
            }) {
                continue;
            }
            publisher
                .publish(&notice::ViewReady::for_view(&view))
                .await?;
            store
                .mark_async_compaction_announced(&reference, version)
                .map_err(transient)?;
        }
        Ok(())
    }

    pub(super) async fn advance_compaction(
        &self,
        account: &str,
        message: &cortexkit_bus_trait::Message,
    ) -> Result<(), HandlerOutcome> {
        let notice = notice::AdvanceNotice::from_headers(&message.headers)
            .map_err(|e| invalid_field("notice", e.name()))?;
        if bus_id(&notice.session_ref, "advanced", notice.seq) != message.id
            || notice.digest() != message.digest.to_string()
        {
            return Err(invalid_field("notice", "claim check digest or id mismatch"));
        }
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(mut state) = load(store, &notice.session_ref)? else {
            return Ok(());
        };
        if message.subject
            != notice::event_subject(account, &state.runner_module, notice::ADVANCED_EVENT)
        {
            return Err(invalid_field(
                "subject",
                "notice not from the session runner",
            ));
        }
        let _serial = self.provider_serial.lock_for(&state.key).await;
        state = load(store, &notice.session_ref)?
            .ok_or_else(|| transient("async session disappeared"))?;
        let duplicate = notice.seq <= state.seq;
        let mut descended = false;
        if let Some(lineage) = message
            .headers
            .get("lineage_id")
            .filter(|new| state.lineage.as_ref().is_some_and(|old| old != *new))
        {
            if let Some(through) = message
                .headers
                .get("descends_from")
                .and_then(|header| verified_descent(&state, header))
            {
                let parent = state.lineage.clone().expect("held lineage");
                state.entries.retain(|ordinal, _| *ordinal <= through);
                state
                    .tag_index
                    .retain(|_, address| address.ordinal <= through);
                state
                    .engine
                    .descend(lineage, &parent, through)
                    .map_err(transient)?;
                state.engine.last_applied = None;
                state.lineage = Some(lineage.clone());
                let retained = store
                    .load_compartments(&state.namespace())
                    .map_err(transient)?
                    .into_iter()
                    .filter(|row| row.end_message <= through as i64)
                    .collect::<Vec<_>>();
                store
                    .replace_compartments(&state.namespace(), &retained)
                    .map_err(transient)?;
                descended = true;
            } else {
                state.reset(store)?;
                state.save(store, &[])?;
            }
        }
        if !duplicate {
            state.applied = notice.applied_view_version;
            if let Some(applied) = state
                .applied
                .and_then(|version| state.published_engine.get(&version))
                .filter(|view| Some(&view.range.lineage_id) == state.lineage.as_ref())
            {
                state.engine.last_applied = Some(applied.clone());
            }
            state.acknowledgements = notice.events.iter().map(notice::Event::token).collect();
            for token in &state.acknowledgements {
                if let Some(outcome) = token.strip_prefix("marker_outcome:") {
                    if let Some((result, cut)) = outcome.split_once(':') {
                        state.marker_outcomes.insert(cut.into(), result.into());
                    }
                }
            }
            state.seq = notice.seq;
            state.conditions = Some(notice.to_headers());
        }
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        let mut resynced = state.resync || descended;
        for attempt in 0..2 {
            let from = state.entries.last_key_value().map_or(0, |(n, _)| *n);
            let read = self
                .read_async(&mut state, from, Duration::from_secs(10))
                .await;
            let verified = read.is_ok()
                && state
                    .entries
                    .get(&notice.through_ordinal)
                    .is_some_and(|entry| {
                        contract::digest::content_digest(&entry.message) == notice.through_digest
                    });
            if verified {
                state.resync = false;
                break;
            }
            state.reset(store)?;
            state.save(store, &[])?;
            resynced = true;
            if attempt == 1 {
                read?;
                tracing::warn!(session_ref=%notice.session_ref,"async digest mismatch; waiting for a matching notice");
                return Ok(());
            }
        }
        state.reindex()?;
        state.restore_sources(store, codec)?;
        state.save(store, &tag_rows(&state, codec)?)?;
        self.advance_async_policy(&mut state, &notice, codec)?;
        let pending_before = store
            .load_pending_agent_drops(&state.namespace())
            .map_err(transient)?
            .len();
        if state.completed_seq < notice.seq || resynced {
            self.publish_async(0, &mut state, codec, resynced)?;
        }
        state.completed_seq = state.seq;
        let drops_applied = store
            .load_pending_agent_drops(&state.namespace())
            .map_err(transient)?
            .len()
            < pending_before;
        self.advance_async_reminders(&mut state, &notice, codec, drops_applied)
            .await?;
        let historian_due = self.advance_async_historian_cadence(&mut state, codec)?;
        state.save(store, &[])?;
        drop(_serial);
        if historian_due {
            self.schedule_async_historian(&state)?;
        }
        self.announce_async_views().await
    }

    async fn read_async(
        &self,
        state: &mut State,
        mut from: u64,
        budget: Duration,
    ) -> Result<(), HandlerOutcome> {
        let deadline = Instant::now() + budget;
        loop {
            let mut params = json!({"from_ordinal":from,"max_bytes":1_048_576});
            if let Some(lineage) = &state.lineage {
                params["lineage_id"] = json!(lineage);
            }
            let page = self
                .provider_runner
                .call_for(
                    &state.runner()?,
                    &state.key.project,
                    "session.read",
                    params,
                    deadline.saturating_duration_since(Instant::now()),
                )
                .await
                .map_err(transient)?;
            let lineage = page["lineage_id"]
                .as_str()
                .ok_or_else(|| transient("async read has no lineage"))?;
            if state.lineage.as_deref().is_some_and(|held| held != lineage) {
                return Err(transient("async lineage changed"));
            }
            state.lineage = Some(lineage.into());
            let entries: Vec<ReadMessage> = decode(&page["messages"])?;
            if entries.is_empty()
                && state
                    .entries
                    .last_key_value()
                    .is_some_and(|(last, _)| *last >= from)
            {
                return Err(transient("async transcript shortened"));
            }
            let mut expected = if state.entries.is_empty() && from == 0 {
                entries.first().map_or(0, |entry| entry.ordinal.min(1))
            } else {
                from
            };
            for entry in entries {
                if entry.ordinal != expected {
                    return Err(transient("async transcript gap"));
                }
                expected = expected
                    .checked_add(1)
                    .ok_or_else(|| invalid("ordinal exhausted"))?;
                if let Some(held) = state.entries.get(&entry.ordinal) {
                    if !stable_entry(held, &entry) {
                        return Err(transient("async entry changed on re-read"));
                    }
                } else {
                    state.entries.insert(entry.ordinal, entry);
                }
            }
            let Some(next) = page["next_from_ordinal"].as_u64() else {
                break;
            };
            if next != expected || next <= from || Instant::now() >= deadline {
                return Err(transient("async paging did not advance within deadline"));
            }
            from = next;
        }
        Ok(())
    }

    async fn advance_async_reminders(
        &self,
        state: &mut State,
        notice: &notice::AdvanceNotice,
        codec: codec::Codec,
        drops_applied: bool,
    ) -> Result<(), HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let loaded = store.load(&state.namespace()).map_err(transient)?;
        let rows = store
            .load_tags_for_session(&state.namespace())
            .map_err(transient)?;
        let messages = state
            .entries
            .values()
            .map(|entry| {
                decoded_entry(
                    codec,
                    &InboundMessage {
                        ordinal: entry.ordinal,
                        mid: entry.mid.clone(),
                        message: entry.message.clone(),
                    },
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let projection = ck_wire::project_messages(&messages).map_err(transient)?;
        let mut active =
            transform::active_tags_for_nudge(&loaded.core, &loaded.meta, &projection, &rows, None);
        active.retain(|tag| {
            rows.iter()
                .find(|row| row.tag_number == tag.tag_number)
                .is_some_and(|row| !loaded.meta.protected_tool_block_ids.contains(&row.block_id))
        });
        let config = self.effective_config(&state.key.project);
        let window = crate::protection_window::ProtectionWindow::from_persisted_rows(
            &rows,
            config
                .resolve_protected_tokens(notice.window.or(state.setup.context_window).unwrap_or(0))
                .floor,
        );
        let pending = store
            .load_pending_agent_drops(&state.namespace())
            .map_err(transient)?;
        let queued = rows
            .iter()
            .filter(|row| pending.iter().any(|drop| drop.target_id == row.block_id))
            .map(|row| row.tag_number)
            .collect::<HashSet<_>>();
        let oldest = transform::oldest_reclaimable_hint(&active, &window.cutoff, &queued)
            .into_iter()
            .filter_map(|(number, _)| u64::try_from(number).ok())
            .collect::<Vec<_>>();
        let channel2 = transform::oldest_channel2_hint(&active, &window.cutoff, &queued)
            .into_iter()
            .filter_map(|(number, _)| u64::try_from(number).ok())
            .collect::<Vec<_>>();
        let last = messages.last();
        let carrier = last
            .filter(|message| {
                message
                    .ck
                    .content
                    .iter()
                    .any(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
            })
            .and_then(|message| {
                rows.iter().rev().find(|row| {
                    row.kind == "tool_result"
                        && row.block_id.starts_with(&format!("{}#", message.mid))
                        && row.token_count > 0
                })
            })
            .and_then(|row| u64::try_from(row.tag_number).ok());
        let user = last.filter(|message| {
            message.ck.role == "user"
                && !message
                    .ck
                    .content
                    .iter()
                    .any(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
        });
        let users = messages
            .iter()
            .filter(|message| {
                message.ck.role == "user"
                    && !message
                        .ck
                        .content
                        .iter()
                        .any(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
            })
            .count() as u64;
        let mut entries = state.entries.values().rev();
        let written = entries.next().and_then(|entry| entry.written_at);
        let prior = entries.next().and_then(|entry| entry.written_at);
        let gap_ms = written
            .zip(prior)
            .and_then(|(written, prior)| i64::try_from(written).ok().zip(i64::try_from(prior).ok()))
            .map(|(written, prior)| written.saturating_sub(prior));
        let mut cadence = state.reminder_cadence.take().unwrap_or_else(|| {
            let mut cadence = crate::runner_reminders::ReminderState::default();
            cadence.meta = loaded.meta.clone();
            cadence
        });
        let conditions = crate::runner_reminders::ReminderConditions {
            notice_id: &bus_id(&state.reference(), "advanced", notice.seq),
            now_ms: now_ms().max(0) as u64,
            real_user_turn_count: users,
            baseline: loaded.meta.tail_hygiene_baseline.as_ref(),
            newest_tool_tag: carrier,
            oldest_reclaimable_tags: &oldest,
            channel2_tags: &channel2,
            drops_applied,
            baseline_refreshed: cadence
                .meta
                .tail_hygiene_baseline
                .as_ref()
                .map(|b| b.baseline_generation)
                != loaded
                    .meta
                    .tail_hygiene_baseline
                    .as_ref()
                    .map(|b| b.baseline_generation),
            hard_fold_coverage_advanced: loaded.meta.coverage_ordinal
                > cadence.meta.coverage_ordinal,
            user_message_id: user.map(|message| message.mid.as_str()),
            temporal_enabled: config.temporal_awareness,
            gap_ms,
            ready_search_hint: None,
        };
        let runner = RoutedRunner {
            runner: self.provider_runner.as_ref(),
            route: state.runner()?,
        };
        let outcome = crate::runner_reminders::send_due_reminders(
            &runner,
            &state.key.project,
            &state.key.session,
            &mut cadence,
            &conditions,
        )
        .await;
        cadence.meta.coverage_ordinal = loaded.meta.coverage_ordinal;
        state.reminder_cadence = Some(cadence);
        for error in outcome.errors {
            tracing::warn!(%error,"async reminder send unavailable");
        }
        Ok(())
    }

    fn async_binding(&self, state: &State) -> SessionBinding {
        SessionBinding {
            principal: Some(subc_protocol::Principal::Reserved {
                module_id: state.runner_module.clone(),
            }),
            scope: None,
            project_root: state.key.project.clone(),
            harness: session_resolver::RUNNER_BIND_HARNESS.into(),
            session: state.key.session.clone(),
            model_key: None,
            config: self.effective_config(&state.key.project).clone(),
            history_budget_tokens: 4_000.0,
        }
    }

    fn publish_async(
        &self,
        channel: u16,
        state: &mut State,
        codec: codec::Codec,
        ride: bool,
    ) -> Result<Option<view::CompactionView>, HandlerOutcome> {
        if state.resync || state.entries.is_empty() {
            return Ok(None);
        }
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let headers = state
            .conditions
            .as_ref()
            .ok_or_else(|| transient("no async conditions"))?;
        let notice =
            notice::AdvanceNotice::from_headers(headers).map_err(|e| transient(e.name()))?;
        let binding = self.async_binding(state);
        let status = transform::compaction::Status {
            lineage_id: state.lineage.clone().unwrap_or_default(),
            newest_ordinal: state.entries.last_key_value().map(|(n, _)| *n),
            previous_usage: None,
            request_tokens: notice.est_tokens,
            context_window: state
                .usage_policy
                .as_ref()
                .and_then(|policy| policy.limit_for(&notice.model))
                .or(notice.window.or(state.setup.context_window))
                .ok_or_else(|| invalid("window unknown"))?,
            prefix_rebuilding: ride,
            pipeline_switch: false,
            last_applied_version: None,
            last_not_applied: None,
        };
        let mut engine = state.engine.clone();
        let (_template, output) =
            self.async_engine(channel, &binding, state, codec, &status, &mut engine)?;
        state.engine = engine;
        let transform::compaction::Answer::Replacement(mut candidate) = output.answer else {
            return Ok(None);
        };
        if !ride && !output.prefix_bust_permitted {
            return Ok(None);
        }
        let wire = rendered_view(codec, &candidate, state)?;
        let coverage = store
            .load_meta(&state.namespace())
            .map_err(transient)?
            .meta
            .coverage_ordinal;
        let mut ranges = ranges(state, codec, &wire, &candidate, coverage)?;
        if let Some(head) = state.restored_head.take() {
            if let Some(view::ViewRange::Replace { from: 0, to, bytes }) =
                ranges.first_mut().filter(|range| range.to() == head.to)
            {
                let _ = to;
                *bytes = head.bytes.clone();
                let messages: Vec<Value> = serde_json::from_str(&head.bytes).map_err(transient)?;
                let mut decoded = Vec::new();
                for (index, mut message) in messages.into_iter().enumerate() {
                    let mid = message
                        .pointer("/info/id")
                        .or_else(|| message.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("restored-head-{index}"));
                    if message.get("info").is_some_and(Value::is_object)
                        && message.pointer("/info/id").is_none()
                    {
                        // Synthetic heads have no transcript id. This id is only
                        // temporary decoder input; the published bytes stay unchanged.
                        message["info"]["id"] = json!(mid);
                    }
                    let mut entry = decoded_entry(
                        codec,
                        &InboundMessage {
                            ordinal: 0,
                            mid,
                            message,
                        },
                    )?;
                    entry.ck.meta.synthetic = true;
                    entry.ck.meta.ordinal = None;
                    decoded.push(entry.ck);
                }
                let prefix = candidate
                    .replacement
                    .iter()
                    .take_while(|message| message.meta.synthetic)
                    .count();
                candidate.replacement.splice(..prefix, decoded);
                state.engine.last_produced = Some(candidate.clone());
                if state
                    .engine
                    .last_applied
                    .as_ref()
                    .is_some_and(|view| view.version == candidate.version)
                {
                    state.engine.last_applied = Some(candidate.clone());
                }
            }
        }
        let version = store
            .reserve_async_compaction_version(&state.reference(), state.applied.unwrap_or(0))
            .map_err(transient)?;
        let last = state
            .entries
            .last_key_value()
            .expect("nonempty transcript")
            .1;
        let mut view = view::CompactionView::new(
            state.reference(),
            version,
            state.lineage.as_deref().unwrap_or_default(),
            compact::lineage::MessageRef {
                ordinal: last.ordinal,
                mid: last.mid.clone(),
            },
            ranges,
        );
        if let Some(through) = view
            .ranges
            .iter()
            .take_while(|range| matches!(range, view::ViewRange::Replace { .. }))
            .last()
            .and_then(|range| range.to().checked_sub(1))
        {
            view = view.with_cut(view::ViewCut::new(format!("v{version}"), through));
        }
        let view = checked_async_view(view)?;
        store
            .save_async_compaction_view(
                &state.reference(),
                version,
                &serde_json::to_string(&view).map_err(transient)?,
            )
            .map_err(transient)?;
        state.published_engine.insert(version, candidate);
        Ok(Some(view))
    }

    pub(super) async fn async_view_get(
        &self,
        binding: &SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let request: view::ViewGetRequest = decode(params)?;
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(state) = load(store, &request.session_ref)? else {
            return bytes(
                &json!({"answer":"refuse","code":"unknown_session","reason":"Unknown async conversation"}),
            );
        };
        self.authorize_async(binding, &state)?;
        match store
            .load_async_compaction_view(&request.session_ref, request.view_version)
            .map_err(transient)?
        {
            Some(raw) => {
                let view: view::CompactionView = serde_json::from_str(&raw).map_err(transient)?;
                bytes(&view::ViewGetAnswer::view(view))
            }
            None => bytes(
                &json!({"answer":"refuse","code":"unknown_version","reason":"Unknown immutable view version"}),
            ),
        }
    }

    fn authorize_async(
        &self,
        binding: &SessionBinding,
        state: &State,
    ) -> Result<(), HandlerOutcome> {
        if binding.project_root.as_os_str() != state.key.project.as_os_str()
            || !matches!(&binding.principal,Some(subc_protocol::Principal::Reserved{module_id}) if module_id==&state.runner_module)
        {
            return Err(invalid_field(
                "session_ref",
                "async conversation is owned by another runner",
            ));
        }
        Ok(())
    }

    pub(super) async fn async_ride(
        &self,
        binding: &SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let request: ride::RideRequest = decode(params)?;
        request
            .check()
            .map_err(|e| invalid_field("deadline_ms", e.name()))?;
        if matches!(request.cause, ride::RideCause::Unknown(_)) {
            return bytes(&ride::RideAnswer::nothing());
        }
        let started = Instant::now();
        let budget = Duration::from_millis(request.deadline_ms);
        let work = async {
            let store = self
                .store
                .get()
                .ok_or_else(|| transient("store unavailable"))?;
            let Some(mut state) = load(store, &request.session_ref)? else {
                return bytes(&ride::RideAnswer::nothing());
            };
            self.authorize_async(binding, &state)?;
            let _serial = self.provider_serial.lock_for(&state.key).await;
            state = load(store, &request.session_ref)?
                .ok_or_else(|| transient("async session disappeared"))?;
            if state.resync {
                return bytes(&ride::RideAnswer::nothing());
            }
            let from = state.entries.last_key_value().map_or(0, |(n, _)| *n);
            if self
                .read_async(&mut state, from, budget.saturating_sub(started.elapsed()))
                .await
                .is_err()
            {
                state.reset(store)?;
                state.save(store, &[])?;
                return bytes(&ride::RideAnswer::nothing());
            }
            let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
            if matches!(request.cause, ride::RideCause::Ceiling) {
                if let Some(fact) = ride_overflow(&request) {
                    apply_ride_overflow(&mut state, fact);
                }
            }
            state.reindex()?;
            state.save(store, &tag_rows(&state, codec)?)?;
            let worker = self.provider_historian_worker();
            let store = Arc::clone(store);
            let view = tokio::task::spawn_blocking(move || {
                let _serial = _serial;
                let view = worker.publish_async(0, &mut state, codec, true)?;
                state.save(&store, &[])?;
                Ok::<_, HandlerOutcome>(view)
            })
            .await
            .map_err(transient)??;
            self.announce_async_views().await?;
            match view {
                Some(view) => bytes(&ride::RideAnswer::view(view)),
                None => bytes(&ride::RideAnswer::nothing()),
            }
        };
        tokio::time::timeout(budget, work)
            .await
            .unwrap_or_else(|_| bytes(&ride::RideAnswer::nothing()))
    }
}

impl McHandler {
    pub(super) async fn async_reduce(
        &self,
        binding: &SessionBinding,
        requested: &[u64],
    ) -> Result<HandlerOutcome, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let rows = store
            .async_compaction_for_session(&binding.project_root.to_string_lossy(), &binding.session)
            .map_err(transient)?;
        if rows.len() != 1 {
            return Err(session_unresolved_error());
        }
        let state: State = serde_json::from_str(&rows[0]).map_err(transient)?;
        let _serial = self.provider_serial.lock_for(&state.key).await;
        let state = load(store, &state.reference())?
            .ok_or_else(|| transient("async session disappeared"))?;
        if state.resync {
            return Err(transient("async transcript resync in progress"));
        }
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        let tags = tag_rows(&state, codec)?;
        let mut targets = Vec::new();
        let mut unknown = Vec::new();
        for number in requested {
            match tags
                .iter()
                .find(|row| u64::try_from(row.tag_number).ok() == Some(*number))
            {
                Some(row) => targets.push(row.block_id.clone()),
                None => unknown.push(*number),
            }
        }
        if targets.is_empty() {
            return Ok(tool_error_result(format!(
                "Refused: no valid tags to queue. {}",
                ctx_reduce_ack_details(&unknown)
            )));
        }
        store
            .append_pending_agent_drops_with_command(
                &state.namespace(),
                None,
                &targets,
                now_ms(),
                false,
            )
            .map_err(transient)?;
        Ok(mcp_text_result(
            format!(
                "{} {}",
                ctx_reduce_reply(targets.len(), 0),
                ctx_reduce_ack_details(&unknown)
            ),
            false,
        ))
    }
}

struct AsyncHistoryFence {
    reference: String,
    generation: u64,
    key: Key,
    serial: Arc<ProviderSerial>,
}
impl crate::historian::HistorianPublicationFence for AsyncHistoryFence {
    fn publish(
        &self,
        store: &McStore,
        request: mc_store::HistorianPublishRequest<'_>,
    ) -> Result<mc_store::HistorianPublishResult, mc_store::HistorianPublishError> {
        let reject = || mc_store::HistorianPublishError::FenceRejected {
            reason: "async lineage sources changed".into(),
        };
        let _serial = self.serial.try_lock_for(&self.key).map_err(|_| reject())?;
        let state = load(store, &self.reference)
            .map_err(|_| reject())?
            .ok_or_else(reject)?;
        if state.resync || state.generation != self.generation {
            return Err(reject());
        }
        store.publish_historian_chunk(request)
    }
}

impl McHandler {
    fn schedule_async_historian(&self, state: &State) -> Result<(), HandlerOutcome> {
        if state.engine.preset != transform::compaction::Preset::Head {
            return Ok(());
        }
        #[cfg(test)]
        self.provider_store
            .async_runtime
            .historian_evaluations
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let binding = self.async_binding(state);
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        let mut request = self.async_historian_fields(state);
        request["v"] = json!(2);
        request["kind"] = json!("compaction.async");
        request["session_id"] = json!(state.namespace());
        request["render_config"] = json!("async-provider");
        request["messages"] = json!([]);
        let notice = state
            .conditions
            .as_ref()
            .map(notice::AdvanceNotice::from_headers)
            .transpose()
            .map_err(|e| transient(e.name()))?;
        request["model_key"] = json!(notice
            .as_ref()
            .map(|n| n.model.as_str())
            .unwrap_or(&state.setup.model));
        if let Some(notice) = &notice {
            request["usage"] = serde_json::to_value(mc_store::ModuleUsage {
                current_total_input_tokens: notice.est_tokens,
                context_limit_tokens: notice.window.or(state.setup.context_window).unwrap_or(0),
                ..Default::default()
            })
            .map_err(transient)?;
        }
        let mut parsed: TransformRequest = decode(&request)?;
        let messages = state
            .entries
            .values()
            .map(|entry| InboundMessage {
                ordinal: entry.ordinal,
                mid: entry.mid.clone(),
                message: entry.message.clone(),
            })
            .collect::<Vec<_>>();
        codec.prepare_request(&mut parsed, &messages)?;
        let store = Arc::clone(
            self.store
                .get()
                .ok_or_else(|| transient("store unavailable"))?,
        );
        let worker = self.provider_historian_worker();
        let fence = Arc::new(AsyncHistoryFence {
            reference: state.reference(),
            generation: state.generation,
            key: state.key.clone(),
            serial: Arc::clone(&self.provider_serial),
        });
        let reference = state.reference();
        let namespace = state.namespace();
        let generation = state.generation;
        let cadence = state.historian_cadence.clone();
        let settings = self.historian_settings_loader()(&state.key.project);
        let harness = state.key.harness.clone();
        tokio::spawn(async move {
            let configured = super::historian_config::resolve_with_model_catalog(
                &settings,
                &harness,
                &binding.project_root,
                &worker.historian_model_catalog,
            )
            .await;
            parsed.historian_model_limits = configured.model_limits;
            let prepare = worker.clone();
            let result = tokio::task::spawn_blocking(move || {
                let projection = ck_wire::project_messages(&parsed.messages).map_err(transient)?;
                let mut timings = HistorianTriggerTimings::default();
                Ok::<_, HandlerOutcome>(prepare.prepare_historian_fire(
                    store,
                    &parsed,
                    &binding,
                    &binding.project_root.to_string_lossy(),
                    &projection,
                    HistorianPrepareContext {
                        rust_background_enabled: None,
                        now: now_ms(),
                        snapshot_generation: None,
                        publication_fence: Some(fence),
                        tag_snapshot: None,
                        reclaim_ride_available: false,
                        runner_lane: true,
                        timings: &mut timings,
                    },
                ))
            })
            .await;
            match result {
                Ok(Ok(PreparedHistorianAction::FireReady(prepared))) => {
                    if let Err(error) = worker
                        .finish_async_historian_evaluation(&reference, generation, &cadence)
                        .await
                    {
                        tracing::warn!(?error, "async historian cadence save failed");
                    }
                    let completion = worker.live_historian_completion_wait(&namespace);
                    worker.spawn_historian_firing(prepared.task);
                    if let Some(completion) = completion {
                        completion.await;
                    }
                    if let Err(error) = worker.publish_async_wake(&reference).await {
                        tracing::warn!(?error, "async historian view publication failed");
                    }
                }
                Ok(Ok(PreparedHistorianAction::Busy { completion, .. })) => {
                    completion.await;
                    if let Some(store) = worker.store.get() {
                        if let Ok(Some(state)) = load(store, &reference) {
                            if state.historian_pending {
                                let _ = worker.schedule_async_historian(&state);
                            }
                        }
                    }
                }
                Ok(Ok(PreparedHistorianAction::Complete(_))) => {
                    if let Err(error) = worker
                        .finish_async_historian_evaluation(&reference, generation, &cadence)
                        .await
                    {
                        tracing::warn!(?error, "async historian cadence save failed");
                    }
                }
                Ok(Err(error)) => tracing::warn!(?error, "async historian evaluation failed"),
                Err(error) => tracing::warn!(%error, "async historian worker failed"),
            }
        });
        Ok(())
    }

    fn async_historian_fields(&self, state: &State) -> Value {
        let settings = self.historian_settings_loader()(&state.key.project);
        Value::Object(
            super::historian_config::resolve(&settings, &state.key.harness).request_fields(),
        )
    }
}

impl McHandler {
    fn advance_async_policy(
        &self,
        state: &mut State,
        notice: &notice::AdvanceNotice,
        codec: codec::Codec,
    ) -> Result<(), HandlerOutcome> {
        let conditions = super::usage_policy::UsageConditions {
            est_tokens: notice.est_tokens,
            window: notice.window.or(state.setup.context_window).unwrap_or(0),
            model: notice.model.clone(),
            last_usage: notice
                .last_usage
                .as_ref()
                .map(|usage| super::usage_policy::LastUsage {
                    input: Some(usage.input),
                    cache_read: Some(usage.cache_read),
                    cache_write: Some(usage.cache_write),
                    output: Some(usage.output),
                    completed_at: None,
                    finish_reason: None,
                }),
            provider_error: None,
        };
        let (policy, _) = super::usage_policy::advance(
            &state.usage_policy.clone().unwrap_or_default(),
            &conditions,
            state.engine.preset == transform::compaction::Preset::Head,
        );
        state.usage_policy = Some(policy);
        let mut scan = state.todo_scan.clone().unwrap_or_default();
        let messages = state
            .entries
            .values()
            .map(|entry| {
                decoded_entry(
                    codec,
                    &InboundMessage {
                        ordinal: entry.ordinal,
                        mid: entry.mid.clone(),
                        message: entry.message.clone(),
                    },
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(todo) = scan.advance(state.lineage.as_deref().unwrap_or_default(), &messages) {
            self.store
                .get()
                .ok_or_else(|| transient("store unavailable"))?
                .set_todo_state(
                    &state.namespace(),
                    &todo.state_json,
                    &todo.owner_message_id,
                    &todo.state_hash,
                )
                .map_err(transient)?;
        }
        state.todo_scan = Some(scan);
        Ok(())
    }
}

impl AsyncRecord {
    fn reindex(&mut self) -> Result<(), HandlerOutcome> {
        let mut index = BTreeMap::new();
        for entry in self.entries.values() {
            let native = parts(&entry.message)?;
            if native.len() != entry.tags.len() {
                return Err(invalid_field(
                    "tags",
                    "one row per exposed part is required",
                ));
            }
            let mut keys = BTreeSet::new();
            for (part, row) in native.iter().zip(&entry.tags) {
                if row.part.is_empty() || row.part.len() > 256 || !keys.insert(&row.part) {
                    return Err(invalid_field(
                        "tags",
                        "part keys must be distinct, nonempty and at most 256 bytes",
                    ));
                }
                if let Some(tag) = &row.tag {
                    if tags::parse_tag(tag).is_none() {
                        return Err(invalid_field("tags", "malformed runner tag"));
                    }
                    let address = PartAddress {
                        ordinal: entry.ordinal,
                        mid: entry.mid.clone(),
                        part: row.part.clone(),
                        digest: contract::digest::content_digest(part),
                    };
                    if index.insert(tag.clone(), address).is_some() {
                        return Err(invalid_field("tags", "runner reused a tag"));
                    }
                }
            }
        }
        self.tag_index = index;
        Ok(())
    }
}

impl McHandler {
    async fn publish_async_wake(&self, reference: &str) -> Result<(), HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(mut state) = load(store, reference)? else {
            return Ok(());
        };
        let _serial = self.provider_serial.lock_for(&state.key).await;
        state = load(store, reference)?.ok_or_else(|| transient("async session disappeared"))?;
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        self.publish_async(0, &mut state, codec, false)?;
        state.save(store, &[])?;
        drop(_serial);
        self.announce_async_views().await
    }

    pub(crate) fn flush_async_compaction(
        &self,
        binding: &SessionBinding,
    ) -> Option<HandlerOutcome> {
        if binding.harness != session_resolver::RUNNER_BIND_HARNESS {
            return None;
        }
        let store = self.store.get()?;
        let rows = match store
            .async_compaction_for_session(&binding.project_root.to_string_lossy(), &binding.session)
        {
            Ok(rows) => rows,
            Err(error) => return Some(transient(error)),
        };
        if rows.is_empty() {
            return None;
        }
        if rows.len() != 1 {
            return Some(session_unresolved_error());
        }
        let state: State = match serde_json::from_str(&rows[0]) {
            Ok(state) => state,
            Err(error) => return Some(transient(error)),
        };
        match store.arm_soft_refresh(&state.namespace()) {
            Ok(armed) => {
                let worker = self.provider_historian_worker();
                let reference = state.reference();
                tokio::spawn(async move {
                    if let Err(error) = worker.publish_async_wake(&reference).await {
                        tracing::warn!(?error, "async flush view publication failed");
                    }
                });
                Some(respond(json!({"ok":true,"armed":armed})))
            }
            Err(error) => Some(transient(error)),
        }
    }
}

impl McHandler {
    pub(crate) fn async_compaction_namespace(
        &self,
        binding: &SessionBinding,
    ) -> Result<Option<String>, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let rows = store
            .async_compaction_for_session(&binding.project_root.to_string_lossy(), &binding.session)
            .map_err(transient)?;
        match rows.as_slice() {
            [] => Ok(None),
            [raw] => {
                let state: State = serde_json::from_str(raw).map_err(transient)?;
                if state.resync {
                    return Err(transient("async transcript resync in progress"));
                }
                Ok(Some(state.namespace()))
            }
            _ => Err(session_unresolved_error()),
        }
    }
}

impl AsyncRecord {
    fn restore_sources(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
    ) -> Result<(), HandlerOutcome> {
        let Some(source) = &self.resync_sources else {
            return Ok(());
        };
        let by_mid = self
            .entries
            .values()
            .map(|entry| (entry.mid.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        let mut retained = Vec::new();
        let mut sequences = Vec::new();
        for history in &source.history {
            let mapped = history
                .messages
                .iter()
                .map(|old| {
                    by_mid.get(old.mid.as_str()).copied().filter(|entry| {
                        contract::digest::content_digest(&entry.message) == old.digest
                    })
                })
                .collect::<Option<Vec<_>>>();
            let Some(mapped) = mapped.filter(|mapped| {
                !mapped.is_empty()
                    && mapped
                        .windows(2)
                        .all(|pair| pair[0].ordinal.checked_add(1) == Some(pair[1].ordinal))
            }) else {
                break;
            };
            let mut compartment = history.compartment.clone();
            let first = mapped.first().unwrap();
            let last = mapped.last().unwrap();
            if retained.is_empty()
                && self
                    .entries
                    .first_key_value()
                    .is_some_and(|(_, entry)| entry.mid != first.mid)
            {
                break;
            }
            if retained
                .last()
                .is_some_and(|prior: &mc_store::StoredCompartment| {
                    prior.end_message.checked_add(1) != Some(first.ordinal as i64)
                })
            {
                break;
            }
            compartment.start_message = first.ordinal as i64;
            compartment.end_message = last.ordinal as i64;
            let start_part = compartment
                .start_message_id
                .rsplit_once('#')
                .map(|(_, part)| part)
                .unwrap_or("0")
                .to_owned();
            let end_part = compartment
                .end_message_id
                .rsplit_once('#')
                .map(|(_, part)| part)
                .unwrap_or("0")
                .to_owned();
            compartment.start_message_id = format!("{}#{start_part}", first.mid);
            compartment.end_message_id = format!("{}#{end_part}", last.mid);
            sequences.push((history.compartment.sequence, compartment.sequence));
            retained.push(compartment);
        }
        let namespace = self.namespace();
        store
            .replace_compartments(&namespace, &retained)
            .map_err(transient)?;
        let copied = store
            .copy_async_history_artifacts(&source.namespace, &namespace, &sequences)
            .map_err(transient)?;
        let rows = tag_rows(self, codec)?;
        let mut transferred = 0;
        for drop in &source.drops {
            let matched = self.tag_index.iter().find(|(_, address)| {
                address.mid == drop.mid
                    && address.part == drop.part
                    && address.digest == drop.digest
            });
            let Some((tag, _)) = matched else {
                continue;
            };
            let Some(number) = tags::parse_tag(tag) else {
                continue;
            };
            let Some(row) = rows
                .iter()
                .find(|row| u64::try_from(row.tag_number).ok() == Some(number))
            else {
                continue;
            };
            store
                .append_pending_agent_drops(
                    &namespace,
                    std::slice::from_ref(&row.block_id),
                    drop.queued_at_ms,
                )
                .map_err(transient)?;
            transferred += 1;
        }
        store
            .clear_async_compaction_drops(&source.namespace)
            .map_err(transient)?;
        if let Some(head) = &source.head {
            let mapped = head
                .messages
                .iter()
                .map(|old| {
                    by_mid.get(old.mid.as_str()).copied().filter(|entry| {
                        contract::digest::content_digest(&entry.message) == old.digest
                    })
                })
                .collect::<Option<Vec<_>>>();
            if let Some(mapped) = mapped.filter(|mapped| {
                mapped
                    .windows(2)
                    .all(|pair| pair[0].ordinal.checked_add(1) == Some(pair[1].ordinal))
                    && mapped.first().is_none_or(|first| {
                        self.entries
                            .first_key_value()
                            .is_some_and(|(_, entry)| entry.mid == first.mid)
                    })
            }) {
                let to = mapped
                    .last()
                    .map(|entry| entry.ordinal + 1)
                    .unwrap_or_else(|| {
                        self.entries
                            .first_key_value()
                            .map_or(0, |(ordinal, _)| *ordinal)
                    });
                self.restored_head = Some(RestoredHead {
                    bytes: head.bytes.clone(),
                    to,
                });
            }
        }
        self.last_discarded_drops = source.queued_count.saturating_sub(transferred);
        self.last_transferred_drops = transferred;
        let old_messages = source
            .messages
            .iter()
            .map(|message| (message.mid.as_str(), message.digest.as_str()))
            .collect::<BTreeMap<_, _>>();
        self.restored_no_new_content = retained.len() == source.history.len()
            && self.entries.values().all(|entry| {
                old_messages.get(entry.mid.as_str()).is_some_and(|digest| {
                    *digest == contract::digest::content_digest(&entry.message)
                })
            });
        if !self.restored_no_new_content {
            self.historian_pending = true;
        }
        tracing::info!(session_ref=%self.reference(),history_compartments=retained.len(),copied_chunk_embeddings=copied,transferred_drops=transferred,discarded_drops=self.last_discarded_drops,"async lineage sources revalidated");
        self.resync_sources = None;
        Ok(())
    }
}

impl McHandler {
    fn advance_async_historian_cadence(
        &self,
        state: &mut State,
        codec: codec::Codec,
    ) -> Result<bool, HandlerOutcome> {
        if state.engine.preset != transform::compaction::Preset::Head {
            return Ok(false);
        }
        let mut user = None;
        let mut tools = 0;
        for entry in state.entries.values() {
            let message = decoded_entry(
                codec,
                &InboundMessage {
                    ordinal: entry.ordinal,
                    mid: entry.mid.clone(),
                    message: entry.message.clone(),
                },
            )?;
            let results = message
                .ck
                .content
                .iter()
                .filter(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
                .count() as u64;
            tools += results;
            if message.ck.role == "user" && results == 0 {
                user = Some(entry.mid.clone());
            }
        }
        let facts = HistorianCadence {
            user,
            tools,
            model: state
                .conditions
                .as_ref()
                .and_then(|headers| headers.get("model"))
                .unwrap_or(&state.setup.model)
                .clone(),
            settings: sha256_hex(
                &serde_jcs::to_vec(&self.async_historian_fields(state)).map_err(transient)?,
            ),
        };
        if state.restored_no_new_content
            && state
                .historian_cadence
                .as_ref()
                .is_some_and(|prior| prior.model == facts.model && prior.settings == facts.settings)
        {
            state.historian_cadence = Some(facts);
            state.historian_pending = false;
            state.restored_no_new_content = false;
            return Ok(false);
        }
        state.restored_no_new_content = false;
        let due = state.historian_pending
            || state.historian_cadence.as_ref().is_none_or(|prior| {
                prior.user != facts.user
                    || prior.model != facts.model
                    || prior.settings != facts.settings
                    || facts.tools >= prior.tools.saturating_add(25)
            });
        if due {
            state.historian_cadence = Some(facts);
            state.historian_pending = true;
        }
        Ok(due)
    }

    async fn finish_async_historian_evaluation(
        &self,
        reference: &str,
        generation: u64,
        cadence: &Option<HistorianCadence>,
    ) -> Result<(), HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(mut state) = load(store, reference)? else {
            return Ok(());
        };
        let _serial = self.provider_serial.lock_for(&state.key).await;
        state = load(store, reference)?.ok_or_else(|| transient("async session disappeared"))?;
        if state.generation == generation && &state.historian_cadence == cadence {
            state.historian_pending = false;
            state.save(store, &[])?;
        }
        Ok(())
    }
}
