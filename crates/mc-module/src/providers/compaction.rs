//! Setup, step and durable wait work through the compaction engine adapter.
use super::codec::Codec;
use super::*;
#[cfg(test)]
#[path = "compaction_review_tests.rs"]
mod compaction_review_tests;
use mc_store::provider_records::{
    ProviderConversation, ProviderError, ProviderLineage, ProviderMessage, ProviderSubject,
    ProviderView,
};
use serde::Deserialize;

fn invalid_field(field: &'static str) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: "invalid_params".into(),
        message: format!("invalid provider {field}"),
        detail: json!({"field":field}),
    }
}

/// The route, not the body's harness string, authorizes the host exception.
/// Both frozen plan opt-ins are required; runner plans cannot select it.
fn host_plan(
    binding: &SessionBinding,
    session: &str,
    harness: &str,
    params: &Value,
) -> Result<bool, HandlerOutcome> {
    let expected = if attested_claude_code(binding) {
        "claude-code-anthropic"
    } else {
        "opencode-aisdk"
    };
    let profile = params.get("serializer_profile").and_then(Value::as_str) == Some(expected);
    let answer = params.get("observation").and_then(Value::as_str) == Some("answer");
    if !profile && !answer && !host_binding(binding) {
        return Ok(false);
    }
    if !host_binding(binding) {
        return Err(invalid_field(if answer {
            "params.observation"
        } else {
            "params.serializer_profile"
        }));
    }
    if binding.session != session || binding.harness != harness {
        return Err(invalid_field("session"));
    }
    if !profile {
        return Err(invalid_field("params.serializer_profile"));
    }
    if !answer {
        return Err(invalid_field("params.observation"));
    }
    Ok(true)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ViewSummary {
    version: u64,
    range: transform::compaction::Range,
}
impl From<&transform::compaction::View> for ViewSummary {
    fn from(view: &transform::compaction::View) -> Self {
        Self {
            version: view.version,
            range: view.range.clone(),
        }
    }
}

/// Setup and view references stay small. Replacement bytes live only in the
/// immutable view rows, never in a noop's conversation UPDATE.
#[derive(Serialize, Deserialize)]
struct HostSetup {
    #[serde(flatten)]
    setup: Setup,
    applied: Option<ViewSummary>,
    produced: Option<ViewSummary>,
    #[serde(default)]
    invalidated: bool,
    #[serde(default)]
    repair_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cache_policy: Option<Value>,
}
#[derive(Serialize, Deserialize)]
pub(super) struct HostView {
    pub(super) engine: transform::compaction::View,
    pub(super) wire: compact::answer::CompactionMessage,
    #[serde(default)]
    pub(super) coverage: Option<HostCoverage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) raw_replacement: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) head_slots: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) cut_replacement: Option<super::native_cut::CutReplacement>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct HostCoverage {
    pub(super) end_mid: String,
    pub(super) ordinal: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) endpoint: Option<compact::view::NativeEndpoint>,
}

#[derive(Clone, Copy, Debug)]
struct FastPathInputs {
    prefix_rebuilding: bool,
    relevant_not_applied: bool,
    execute_due: bool,
    force_band: bool,
    emergency: bool,
    forced_work: bool,
}
fn can_skip_engine(input: FastPathInputs) -> bool {
    !input.prefix_rebuilding
        && !input.relevant_not_applied
        && !input.execute_due
        && !input.force_band
        && !input.emergency
        && !input.forced_work
}

fn gap_answer(request_id: &str, ordinal: u64) -> Value {
    json!({"answer":"refuse","request_id":request_id,"code":"history_unreadable",
        "reason":"The provider does not hold the complete lineage",
        "detail":{"history_gap_from":ordinal}})
}

fn host_lineage(
    store: &McStore,
    key: &Key,
    params: &Value,
    request: &compact::status::StepStatus,
) -> Result<ProviderLineage, HandlerOutcome> {
    let held = store
        .load_provider_lineage(&key.store_key(), &request.lineage_id)
        .map_err(transient)?;
    let descent = params.get("descends_from").filter(|v| !v.is_null());
    let parent = descent
        .map(|v| {
            v.get("lineage_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid_field("lineage_id"))
        })
        .transpose()?;
    let cut = descent
        .map(|v| {
            v.get("through_ordinal")
                .and_then(Value::as_u64)
                .ok_or_else(|| invalid_field("lineage_id"))
        })
        .transpose()?;
    if let Some(held) = held {
        if descent.is_some()
            && (held.descends_from.as_deref() != parent || held.through_ordinal != cut)
        {
            return Err(invalid_field("lineage_id"));
        }
        return Ok(held);
    }
    Ok(ProviderLineage {
        lineage_id: request.lineage_id.clone(),
        first_ordinal: cut
            .map(|n| n.checked_add(1).ok_or_else(|| invalid_field("lineage_id")))
            .transpose()?
            .unwrap_or_else(|| request.messages.first().map_or(1, |m| m.ordinal)),
        descends_from: parent.map(str::to_string),
        through_ordinal: cut,
    })
}

/// Follow metadata only, bounding each ancestor by every intervening cut.
fn ancestor_cut(
    store: &McStore,
    key: &Key,
    lineage: &ProviderLineage,
    ancestor: &str,
) -> Result<Option<u64>, HandlerOutcome> {
    let mut row = lineage.clone();
    let mut cut = u64::MAX;
    let mut seen = BTreeSet::new();
    loop {
        if row.lineage_id == ancestor {
            return Ok(Some(cut));
        }
        if !seen.insert(row.lineage_id.clone()) {
            return Err(invalid_field("lineage_id"));
        }
        let Some(parent) = row.descends_from else {
            return Ok(None);
        };
        cut = cut.min(
            row.through_ordinal
                .ok_or_else(|| invalid_field("lineage_id"))?,
        );
        let Some(parent) = store
            .load_provider_lineage(&key.store_key(), &parent)
            .map_err(transient)?
        else {
            return Ok(None);
        };
        row = parent;
    }
}

fn non_tag_messages_since(
    store: &McStore,
    key: &Key,
    lineage: &ProviderLineage,
    first: u64,
) -> Result<Vec<compact::status::StatusMessage>, HandlerOutcome> {
    let mut messages = store
        .load_provider_messages_since(&key.store_key(), &lineage.lineage_id, first)
        .map_err(transient)?
        .into_iter()
        .map(|m| {
            Ok(compact::status::StatusMessage {
                raw_message: None,
                ordinal: m.ordinal,
                mid: m.mid,
                message: serde_json::from_slice(&m.message_bytes).map_err(transient)?,
            })
        })
        .collect::<Result<Vec<_>, HandlerOutcome>>()?;
    // A long provider session holds one live answer per hooked message. Index the
    // messages and memoize ancestor cuts so replaying answers stays linear; the
    // index keeps the first message for a (mid, ordinal) pair, as a scan would.
    let mut index: HashMap<(String, u64), usize> = HashMap::new();
    for (position, message) in messages.iter().enumerate() {
        index
            .entry((message.mid.clone(), message.ordinal))
            .or_insert(position);
    }
    let mut cuts: HashMap<String, Option<u64>> = HashMap::new();
    for stored in store
        .load_provider_hook_answers_since(&key.store_key(), first)
        .map_err(transient)?
    {
        if stored.state != "live" {
            continue;
        }
        let cut = match cuts.get(&stored.lineage_id) {
            Some(cut) => *cut,
            None => {
                let cut = ancestor_cut(store, key, lineage, &stored.lineage_id)?;
                cuts.insert(stored.lineage_id.clone(), cut);
                cut
            }
        };
        if cut.is_none_or(|cut| stored.answer.ordinal > cut) {
            continue;
        }
        let answer = stored.answer;
        let Some(&position) = index.get(&(answer.subject.subject_mid.clone(), answer.ordinal))
        else {
            continue;
        };
        let message = &mut messages[position];
        let mut ops: Vec<hooks::answer::Operation> =
            serde_json::from_str(&answer.ops_json).map_err(transient)?;
        if message.message.get("raw_message").is_some() {
            // Claude Code hooks currently record unchanged messages. They do not
            // authorize tool reductions or delivery notices, and OpenCode's part
            // operations cannot be applied to Anthropic content blocks.
            if !ops.is_empty() {
                return Err(invalid_field("message"));
            }
            continue;
        }
        // The host record keeps its earlier hook answer unchanged when a step
        // does not replace history. Remove Channel 1 Appends from live post_tool
        // answers before engine ingestion: tagged CHANNEL1_NOTE operations and
        // legacy untagged copies of the Channel 1 system-reminder envelope.
        // Other Appends are retained; arbitrary note-less text is not ownership.
        // The engine decides after drops and the grace that suppresses nudges
        // following a fulfilled reduction; replaying the hook text bypasses that
        // decision and can duplicate an engine-saved reminder.
        if answer.subject.hook == "post_tool" {
            ops.retain(|op| {
                !matches!(op, hooks::answer::Operation::Append { note, text, .. }
                if note.as_deref()==Some(super::step_transform::CHANNEL1_NOTE)
                    || (note.is_none() && text.starts_with("\n\n<system-reminder>\n")
                        && text.contains("spent tool output") && text.ends_with("\n</system-reminder>")))
            });
        }
        if ops.is_empty() {
            continue;
        }
        let parts = message
            .message
            .get_mut("parts")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| invalid_field("messages"))?;
        let mut targets = parts
            .iter_mut()
            .filter_map(|part| {
                let kind = part.get("type").and_then(Value::as_str)?;
                if part.get("ignored").and_then(Value::as_bool) == Some(true) {
                    return None;
                }
                match answer.subject.hook.as_str() {
                    "pre_user" | "post_assistant" if kind == "text" => part.get_mut("text"),
                    "post_tool"
                        if kind == "tool"
                            && part.get("id").and_then(Value::as_str)
                                == Some(answer.subject.subject_part.as_str()) =>
                    {
                        let state = part.get_mut("state")?;
                        let field = if state.get("status").and_then(Value::as_str) == Some("error")
                        {
                            "error"
                        } else {
                            "output"
                        };
                        state.get_mut(field)
                    }
                    _ => None,
                }
            })
            .filter(|v| v.is_string())
            .collect::<Vec<_>>();
        let source = targets
            .iter()
            .map(|v| v.as_str().expect("text").to_string())
            .collect::<Vec<_>>();
        let rendered = hooks::answer::apply_ops(&source, &ops).map_err(|e| transient(e.name()))?;
        for (target, text) in targets.iter_mut().zip(rendered) {
            **target = json!(text);
        }
    }
    Ok(messages)
}

/// The conversation row is rewritten by every hook, so it keeps a receipt of
/// the last step answer rather than the answer itself: a replacement view can
/// be megabytes. Host steps read only the receipt's request id; the view bytes
/// stay in the immutable view row.
fn answer_receipt(answer: &Value) -> String {
    let mut receipt = answer.clone();
    if let Some(compaction) = receipt.get_mut("compaction") {
        *compaction = json!({
            "compaction_id": compaction.get("compaction_id"),
            "version": compaction.get("version"),
        });
    }
    receipt.to_string()
}

fn save_host_setup(
    store: &McStore,
    key: &Key,
    conversation: &mut ProviderConversation,
    setup: &HostSetup,
) -> Result<(), HandlerOutcome> {
    conversation.setup_json = Some(serde_json::to_string(setup).map_err(transient)?);
    conversation.version_high_water = setup.setup.state.version_high_water;
    conversation.rebuild_epoch = setup.setup.state.rebuild_epoch;
    store
        .save_provider_conversation(&key.store_key(), conversation)
        .map_err(transient)?;
    if matches!(key.harness.as_str(), "opencode" | "opencode2") {
        store
            .prune_provider_views_from_conversation(&key.store_key())
            .map_err(transient)?;
    }
    Ok(())
}

fn save_host_view(
    store: &McStore,
    key: &Key,
    view: &HostView,
    state: &str,
) -> Result<(), HandlerOutcome> {
    if matches!(key.harness.as_str(), "opencode" | "opencode2") {
        return super::view_recipe::save(store, key, view, state);
    }
    store
        .save_provider_view(
            &key.store_key(),
            &ProviderView {
                version: view.engine.version,
                lineage_id: view.engine.range.lineage_id.clone(),
                range_from: view.engine.range.from,
                range_to: view.engine.range.to,
                replacement_json: serde_json::to_string(view).map_err(transient)?,
                state: state.into(),
            },
        )
        .map_err(|e| transient(format!("save provider view: {e}")))
}

fn load_host_view(
    store: &McStore,
    key: &Key,
    summary: &ViewSummary,
) -> Result<HostView, HandlerOutcome> {
    if matches!(key.harness.as_str(), "opencode" | "opencode2") {
        if let Some(mut view) = super::view_recipe::load(store, key, summary.version)? {
            view.engine.range.lineage_id = summary.range.lineage_id.clone();
            return Ok(view);
        }
    }
    let row = store
        .load_provider_view(&key.store_key(), summary.version)
        .map_err(|e| transient(format!("load provider views: {e}")))?
        .ok_or_else(|| transient("recorded provider view is missing"))?;
    let mut view: HostView = serde_json::from_str(&row.replacement_json).map_err(transient)?;
    if key.generation.is_some() {
        super::native_view::validate(key, &view)?;
    }
    // Immutable bytes are shared by a descent; only the in-memory range's
    // lineage changes. Never rewrite a frozen view at an existing version.
    view.engine.range.lineage_id = summary.range.lineage_id.clone();
    Ok(view)
}

#[derive(Clone)]
struct Work {
    binding: SessionBinding,
    key: Key,
    project_path: String,
    project_directory: String,
    note_project_path: String,
    resident_folds: bool,
}

/// Metadata-only skip check shared by the handler and real-state comparison
/// tests. A false result requires the engine; it grants no mutation permission.
fn can_skip_host_step(
    store: &McStore,
    work: &Work,
    namespace: &str,
    model: &str,
    status: &transform::compaction::Status,
    relevant_not_applied: bool,
) -> Result<bool, HandlerOutcome> {
    let pending_reminder = store
        .load_provider_conversation(&work.key.store_key())
        .map_err(transient)?
        .map(|c| serde_json::from_str::<Value>(&c.hook_counters_json).map_err(transient))
        .transpose()?
        .is_some_and(|c| c["channel1_hook_append_pending"].as_bool() == Some(true));
    // A hook prepared a reminder that the engine has not yet reconciled.
    // Return false so the engine observes the complete input and saves its own
    // reminder decision. It may still answer noop; the host record's earlier
    // bytes change only when a replacement is actually applied.
    if pending_reminder {
        return Ok(false);
    }
    let meta = store.load_meta(namespace).map_err(transient)?.meta;
    let usage =
        status.usage().current_total_input_tokens as f64 * 100.0 / status.context_window as f64;
    Ok(can_skip_engine(FastPathInputs {
        prefix_rebuilding: status.prefix_rebuilding,
        relevant_not_applied,
        execute_due: usage
            >= work
                .binding
                .config
                .resolve_execute_threshold(Some(model))
                .percentage,
        force_band: usage >= 85.0,
        emergency: usage >= 95.0 || meta.emergency_drain_active,
        forced_work: !meta.initialized
            || meta.soft_refresh_pending
            || meta.project_memory_epoch_pending
            || meta.pending_rewrite.is_some()
            || meta.bootstrap_seed_fold_pending
            || meta.deferred_execute_state.is_some()
            || meta.pending_compaction_marker.is_some()
            || meta.boundary_divergence_pending_count > 0
            || !meta.reasoning_clear_initialized
            || meta.last_model_key != model,
    }) && transform::compaction::skip_facts(
        store,
        namespace,
        &producer_context(
            work,
            model,
            status.context_window,
            meta.historian.state != mc_store::HistorianPhase::Idle,
        ),
        model,
        status.context_window,
    )
    .map_err(transient)?
    .as_ref()
    .is_some_and(transform::compaction::can_skip_classified))
}

fn producer_context<'a>(
    work: &'a Work,
    model: &str,
    window: u64,
    historian_active: bool,
) -> transform::ProducerContext<'a> {
    let config = &work.binding.config;
    let protected = config.resolve_protected_tokens(window);
    let ttl = config.resolve_cache_ttl_with_provenance(Some(model));
    transform::ProducerContext {
        signed_thinking_hold: config.signed_thinking_hold,
        project_path: &work.project_path,
        note_project_path: &work.note_project_path,
        project_directory: &work.project_directory,
        history_budget_tokens: work.binding.history_budget_tokens,
        memory_budget_tokens: config.memory_budget_tokens,
        user_profile_budget_tokens: config.user_profile_budget_tokens,
        memory_enabled: config.memory_enabled,
        inject_docs: config.inject_docs,
        temporal_awareness: config.temporal_awareness,
        now_ms: now_ms(),
        execute_threshold_percentage: config.resolve_execute_threshold(Some(model)).percentage,
        protected_tokens_floor: protected.floor,
        protected_tokens_provenance: if protected.provenance == "derived" {
            "derived"
        } else {
            "absolute"
        },
        compaction_enabled: config.compaction_enabled,
        smart_drops: config.smart_drops,
        protected_tools: config.protected_tools.clone(),
        cache_ttl: ttl.value,
        cache_ttl_provenance: ttl.provenance,
        cache_ttl_policy: None,
        model_key: Some(model.into()),
        observed_last_response_at_ms: None,
        guidance_date: None,
        historian_active,
        wrapup_active: false,
        caveman_english_word_rules: transform::caveman_english_word_rules(
            config.language.as_deref(),
        ),
        #[cfg(test)]
        injected_reductions: vec![],
    }
}

fn claude_code_engine_failure(
    error: transform::TransformError,
    request_id: &str,
) -> HandlerOutcome {
    // An impossible protected tail is a terminal compaction answer, not a hook
    // outage. Classify the typed error before the generic transient conversion.
    if matches!(
        error,
        transform::TransformError::ProtectedToolResultsOverLimit
    ) {
        let answer = compact::answer::StepAnswer::Refuse {
            request_id: request_id.into(),
            code: compact::errors::RefuseCode::WindowTooSmall,
            reason: transform::PROTECTED_TOOL_RESULTS_OVER_LIMIT_MESSAGE.into(),
            provider_code: Some(transform::PROTECTED_TOOL_RESULTS_OVER_LIMIT_CODE.into()),
            detail: None,
        };
        return match bytes(&answer) {
            Ok(bytes) => HandlerOutcome::Response(bytes),
            Err(error) => error,
        };
    }
    transient(error)
}

#[cfg(test)]
thread_local! {
    // Inject only at the actual engine-return boundary so adapter tests cannot
    // pass by checking a separate refusal serializer that dispatch never uses.
    static CC_ENGINE_REFUSAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn host_engine_step(
    store: &McStore,
    request: &TransformRequest,
    context: &transform::ProducerContext<'_>,
    status: &transform::compaction::Status,
    state: &mut transform::compaction::State,
) -> Result<transform::compaction::Output, transform::TransformError> {
    #[cfg(test)]
    if CC_ENGINE_REFUSAL.with(|flag| flag.replace(false)) {
        return Err(transform::TransformError::ProtectedToolResultsOverLimit);
    }
    transform::compaction::step(store, request, context, status, state)
}

#[allow(clippy::too_many_arguments)]
fn execute_host(
    store: &McStore,
    work: &Work,
    conversation: &ProviderConversation,
    setup: &mut HostSetup,
    status: &transform::compaction::Status,
    lineage: &ProviderLineage,
    request_id: &str,
    native_status: Option<&compact::status::StepStatus>,
) -> Result<Option<HostView>, HandlerOutcome> {
    let codec = Codec::from_params(&Value::Object(setup.setup.request.params.clone()))?;
    let started = Instant::now();
    let messages = non_tag_messages_since(store, &work.key, lineage, 0)?;
    let replay_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut template: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step",
        "serializer_profile":codec.serializer_profile().wire_id(),"session_id":conversation.engine_namespace,
        "render_config":serde_json::to_string(&setup.setup.request.params).map_err(transient)?,
        "model_key":setup.setup.request.model,"messages":[],"tool_present":true,"auto_search_enabled":false}))?;
    codec.prepare_request(&mut template, &messages)?;
    template.native_tail_section = work.resident_folds && codec == Codec::OpencodeAiSdk;
    if codec == Codec::ClaudeCodeAnthropic {
        if let Some(native_status) = native_status {
            template.geometry =
                native_status
                    .geometry
                    .as_ref()
                    .map(|geometry| transform::TransformGeometry {
                        usable_soft: geometry.usable_soft,
                        usable_hard: geometry.usable_hard,
                        absolute_wall: geometry.absolute_wall,
                        derivation: geometry.derivation.clone(),
                    });
            template.mid_turn = native_status.mid_turn.unwrap_or(false);
        }
    }
    let meta = store
        .load_meta(&conversation.engine_namespace)
        .map_err(transient)?
        .meta;
    if let (Some(coverage), Some(first)) = (
        meta.coverage_ordinal,
        template
            .messages
            .iter()
            .filter(|message| !message.ck.meta.synthetic)
            .map(|message| message.ordinal)
            .min(),
    ) {
        if coverage.checked_add(1) == Some(first) {
            let core = store
                .load(&conversation.engine_namespace)
                .map_err(transient)?
                .core;
            if let Some((mid, _)) = core.boundary_id.rsplit_once('#') {
                // The host may have removed the messages already covered by
                // summaries. Declare their last block and ordinal, and the
                // first remaining ordinal; the engine validates these against
                // its stored boundary and applied summary before trusting them.
                template.declared_trim = Some(transform::DeclaredTrim {
                    flat_boundary_id: core.boundary_id.clone(),
                    boundary_bare_message_id: mid.into(),
                    boundary_absolute_ordinal: coverage,
                    next_absolute_ordinal: first,
                });
            }
        }
    }
    // Provider status does not carry the full request's system/provider identity.
    // Preserve the namespace's observed inputs instead of treating their absence
    // as a system-prompt change during transport adoption.
    template.provider_id =
        (!meta.last_provider_id.is_empty()).then(|| meta.last_provider_id.clone());
    template.system_prompt_hash = meta.last_system_prompt_hash.clone();
    template.upgrade_state = meta.last_upgrade_state.clone();
    // Status has no tool-array observation. Keep the head's advertised tagger
    // surface during transport adoption; the host overlay renders live hook
    // tags independently, without inventing a new tagger epoch on the switch.
    template.tool_present = !meta.initialized || meta.tagging_surface_active || meta.cc_u1_active;
    let mut context = producer_context(
        work,
        &setup.setup.request.model,
        status.context_window,
        meta.historian.state != mc_store::HistorianPhase::Idle,
    );
    // The host owns idle detection on this lane. Without a trusted prior-response
    // time the engine would treat every positive-usage step as TTL-expired.
    context.cache_ttl = "never".into();
    if transform::compaction::skip_facts(
        store,
        &conversation.engine_namespace,
        &context,
        &setup.setup.request.model,
        status.context_window,
    )
    .map_err(transient)?
    .is_some_and(|facts| facts.cached_m1_missing)
    {
        setup.repair_pending = true;
    }
    // A repaired head is frozen before its answer can be observed. Retain the
    // outstanding repair until acknowledgement, so a lost answer can be replayed
    // even though the engine's newly committed head is already complete.
    let mut status = status.clone();
    status.prefix_rebuilding |= setup.repair_pending;
    let status = &status;
    let mut state = setup.setup.state.clone();
    let previous = setup
        .produced
        .as_ref()
        .map(|s| load_host_view(store, &work.key, s))
        .transpose()?;
    state.last_applied = setup
        .applied
        .as_ref()
        .map(|summary| {
            // Acknowledged and produced references usually name the same immutable
            // row. Decode it once, retaining each reference's descended lineage.
            if let Some(view) = previous
                .as_ref()
                .filter(|v| v.engine.version == summary.version)
            {
                let mut engine = view.engine.clone();
                engine.range.lineage_id = summary.range.lineage_id.clone();
                Ok(engine)
            } else {
                load_host_view(store, &work.key, summary).map(|v| v.engine)
            }
        })
        .transpose()?;
    state.last_produced = previous.as_ref().map(|v| v.engine.clone());
    let pending = store
        .load_provider_pending_drops(&work.key.store_key())
        .map_err(transient)?;
    let live = if pending.is_empty() {
        Vec::new()
    } else {
        store
            .load_provider_hook_answers(&work.key.store_key())
            .map_err(transient)?
    };
    let targets = live
        .iter()
        .filter(|a| a.state == "live")
        .flat_map(|a| &a.answer.tags)
        .filter(|t| pending.contains(&t.number))
        .map(|t| t.block_id.clone())
        .collect::<Vec<_>>();
    store
        .append_pending_agent_drops(&conversation.engine_namespace, &targets, now_ms())
        .map_err(transient)?;
    let prepare_ms = started.elapsed().as_secs_f64() * 1000.0 - replay_ms;
    let engine_started = Instant::now();
    let output =
        host_engine_step(store, &template, &context, status, &mut state).map_err(|error| {
            if codec == Codec::ClaudeCodeAnthropic {
                claude_code_engine_failure(error, request_id)
            } else {
                transient(error)
            }
        })?;
    let engine_ms = engine_started.elapsed().as_secs_f64() * 1000.0;
    // Keep only scalars in Setup. Engine and native bytes are committed together
    // in one immutable view row below, before publishing their reference.
    setup.setup.state.version_high_water = state.version_high_water;
    setup.setup.state.rebuild_epoch = state.rebuild_epoch;
    let transform::compaction::Answer::Replacement(engine) = output.answer else {
        return Ok(None);
    };
    let (mut wire, mut coverage, raw_replacement, head_slots) = if let Some(previous) = previous
        .filter(|p| {
            status
                .last_not_applied
                .is_some_and(|n| !n.structural && n.version == p.engine.version)
                && p.engine.replacement == engine.replacement
                && p.engine.range == engine.range
                && coverage_replay_matches(
                    codec,
                    p.coverage.as_ref().map(|coverage| coverage.ordinal),
                    output.engine.response.coverage_ordinal,
                )
        }) {
        let mut wire = previous.wire;
        wire.version = engine.version;
        (
            wire,
            previous.coverage,
            previous.raw_replacement,
            previous.head_slots,
        )
    } else {
        let (wire, raw_replacement) = if codec == Codec::ClaudeCodeAnthropic {
            let (wire, raw) = super::codec_claude_code::encode_view(
                &engine,
                &template,
                output.engine.response.coverage_ordinal,
            )?;
            (wire, Some(raw))
        } else {
            (
                codec.encode_view(
                    &engine,
                    &template,
                    &super::codec_opencode::NativeRenderContext::from(&output.engine),
                )?,
                None,
            )
        };
        let coverage = output.engine.response.coverage_ordinal.and_then(|ordinal| {
            messages
                .iter()
                .find(|m| m.ordinal == ordinal)
                .map(|m| HostCoverage {
                    end_mid: m.mid.clone(),
                    ordinal,
                    endpoint: None,
                })
        });
        let head_slots = raw_replacement
            .as_ref()
            .map(|raw| super::cache_policy::head_slots(&engine, raw, setup.setup.state.preset));
        (wire, coverage, raw_replacement, head_slots)
    };
    if codec == Codec::ClaudeCodeAnthropic {
        if output.engine.response.coverage_ordinal.is_some() && coverage.is_none() {
            return Err(error(
                "native_endpoint_unrepresentable",
                "covered native message is missing",
            ));
        }
        if let Some(coverage) = &mut coverage {
            let message = messages
                .iter()
                .find(|m| m.mid == coverage.end_mid && m.ordinal == coverage.ordinal)
                .ok_or_else(|| {
                    error(
                        "native_endpoint_unrepresentable",
                        "covered native message is missing",
                    )
                })?;
            let boundary = store
                .load(&conversation.engine_namespace)
                .map_err(transient)?
                .core
                .boundary_id;
            coverage.endpoint = Some(super::codec_claude_code::whole_message_endpoint(
                message, &boundary,
            )?);
        }
        wire.raw_view = super::native_view::frozen_for_plan(
            &work.key,
            &engine,
            conversation,
            coverage
                .as_ref()
                .and_then(|coverage| coverage.endpoint.as_ref()),
            raw_replacement
                .as_deref()
                .ok_or_else(|| invalid_field("raw_view"))?,
        )?;
    }
    tracing::info!(session_id = %work.key.session, harness = %work.key.harness,
        replay_ms, prepare_ms, engine_ms,
        encode_ms = started.elapsed().as_secs_f64() * 1000.0 - replay_ms - prepare_ms - engine_ms,
        "provider rebuild stages");
    let mut view = HostView {
        engine,
        wire,
        coverage,
        raw_replacement,
        head_slots,
        cut_replacement: None,
    };
    if codec == Codec::ClaudeCodeAnthropic && view.wire.raw_view.is_some() {
        super::native_cut::attach(&work.key, &mut view, &template)?;
    }
    Ok(Some(view))
}

fn status(
    params: &Value,
    record: &Record,
) -> Result<transform::compaction::Status, HandlerOutcome> {
    let lineage = params
        .get("lineage_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let window = params
        .get("context_window")
        .and_then(Value::as_u64)
        .filter(|w| *w > 0)
        .or_else(|| record.setup.as_ref().and_then(|s| s.request.context_window))
        .ok_or_else(|| invalid("context_window must be known and positive"))?;
    let previous_usage = params
        .get("previous_usage")
        .filter(|v| v.is_object())
        .map(|u| transform::compaction::PreviousUsage {
            input_tokens: u.get("input").and_then(Value::as_u64),
            cached_input_tokens: u.get("cache_read").and_then(Value::as_u64),
            cache_write_tokens: u.get("cache_write").and_then(Value::as_u64),
        });
    let mut status = transform::compaction::Status {
        lineage_id: lineage.into(),
        newest_ordinal: params.pointer("/newest/ordinal").and_then(Value::as_u64),
        previous_usage,
        request_tokens: params
            .pointer("/estimate/request_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        context_window: window,
        prefix_rebuilding: params
            .get("prefix_rebuilding")
            .is_some_and(|v| !v.is_null()),
        pipeline_switch: params
            .pointer("/prefix_rebuilding/reason")
            .and_then(Value::as_str)
            == Some("pipeline_switch"),
        last_applied_version: params
            .pointer("/last_applied/version")
            .and_then(Value::as_u64),
        last_not_applied: params
            .get("last_not_applied")
            .filter(|v| v.is_object())
            .map(|v| {
                Ok(transform::compaction::NotApplied {
                    version: v
                        .get("version")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| invalid("last_not_applied.version is required"))?,
                    structural: v.get("reason").and_then(Value::as_str) == Some("structural"),
                })
            })
            .transpose()?,
    };
    if status.last_not_applied.is_none() {
        if let Some(state) = record.setup.as_ref().map(|s| &s.state) {
            let applied = status
                .last_applied_version
                .or_else(|| state.last_applied.as_ref().map(|v| v.version))
                .unwrap_or(0);
            let fresh_request = record
                .last_answer
                .as_ref()
                .and_then(|a| a.get("request_id"))
                .is_some_and(|id| Some(id) != params.get("request_id"));
            if let Some(view) = state
                .last_produced
                .as_ref()
                .filter(|v| fresh_request && v.version > applied)
            {
                // An allocated-but-unsent answer is invisible to the runner's
                // last_not_applied. A newer issued request fences it anyway;
                // retain its frozen work and retry only on a permitted pass.
                status.last_not_applied = Some(transform::compaction::NotApplied {
                    version: view.version,
                    structural: false,
                });
            }
        }
    }
    Ok(status)
}

/// Compare frame-derived decisions through the real decoder and scheduler.
/// Omitting message rendering and history mutations keeps saved-view changes out of this comparison.
#[cfg(test)]
pub(super) fn oracle_input_decision(frame: &Value, now: u64, mid_tool_use: bool) -> Value {
    let mut params = frame.clone();
    params["session"] = json!("relay-v1");
    params["harness"] = json!("opencode");
    params["request_id"] = json!("input-differential");
    params["lineage_id"] = json!("input-differential");
    params["messages"] = json!([]);
    params["now"] = json!(now);
    let _: compact::status::StepStatus =
        decode(&params).unwrap_or_else(|_| panic!("invalid frame"));
    let parsed = status(&params, &Record::default()).unwrap_or_else(|_| panic!("invalid status"));
    let usage = parsed.usage();
    let percentage = usage.current_total_input_tokens as f64 * 100.0 / parsed.context_window as f64;
    let outcome = crate::scheduler::decide(&crate::scheduler::SchedulerInputs {
        config: crate::scheduler::SchedulerConfig::default(),
        usage: crate::scheduler::ContextUsage {
            percentage,
            input_tokens: usage.current_total_input_tokens as f64,
            hard_wall_percentage: Some(percentage),
        },
        // execute() sets "never" to disable time-based expiry: it does not read
        // previous_usage.completed_at. OpenCode reports idle rebuilds separately
        // through prefix_rebuilding, not this completion timestamp.
        session: crate::scheduler::SessionMeta {
            last_response_time_ms: 0,
            cache_ttl: "never".into(),
        },
        now_ms: now,
        model_key: frame["model"].as_str().map(str::to_owned),
        context_limit: Some(parsed.context_window as f64),
        tail_state: crate::scheduler::TailState { mid_tool_use },
        deferred_execute: None,
        boundary_bypass: crate::scheduler::BoundaryBypass::default(),
        drain_latch: crate::scheduler::LatchState::default(),
        overflow_error_text: None,
        emergency_recovery_armed: false,
    });
    json!({"input_tokens":usage.current_total_input_tokens,"outcome":outcome})
}

fn execute(
    store: &McStore,
    work: &Work,
    record: &mut Record,
    status: &transform::compaction::Status,
    initial: bool,
) -> Result<transform::compaction::Output, HandlerOutcome> {
    let setup = record
        .setup
        .as_ref()
        .ok_or_else(|| error("setup_missing", "compaction.step requires a Setup record"))?;
    let messages = record
        .messages
        .get(&status.lineage_id)
        .map(|m| {
            m.values()
                .map(decode_message)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let template: TransformRequest = decode(
        &json!({"v":2,"kind":"compaction.step","serializer_profile":"owned-broca",
        "session_id":work.key.engine_key(),"render_config":serde_json::to_string(&setup.request.params).map_err(transient)?,
        "model_key":setup.request.model,"messages":messages,"tool_present":false,"auto_search_enabled":false}),
    )?;
    let mut context = producer_context(work, &setup.request.model, status.context_window, false);
    // The runner reports cache expiry through prefix_rebuilding. It supplies no
    // prior-response timestamp, so the scheduler's zero fallback would measure
    // idle time from the Unix epoch and execute every step with nonzero usage.
    context.cache_ttl = "never".into();
    let targets = record
        .pending_drops
        .iter()
        .filter_map(|n| record.hook.as_ref()?.live.get(n))
        .filter(|t| t.lineage == status.lineage_id)
        .map(|t| t.block_id.clone())
        .collect::<Vec<_>>();
    store
        .append_pending_agent_drops(&work.key.engine_key(), &targets, now_ms())
        .map_err(transient)?;
    let state = &mut record.setup.as_mut().expect("setup exists").state;
    // An initial empty insertion had no lineage yet. Attach it to the first
    // actual lineage without inventing an ordinal or rebuilding Setup.
    for view in [&mut state.last_applied, &mut state.last_produced]
        .into_iter()
        .flatten()
    {
        if view.range.lineage_id.is_empty() && view.range.from == view.range.to {
            view.range.lineage_id = status.lineage_id.clone();
        }
    }
    let result = if initial {
        transform::compaction::setup(store, &template, &context, status, state)
    } else {
        transform::compaction::step(store, &template, &context, status, state)
    }
    .map_err(transient)?;
    let pending = store
        .load_pending_agent_drops(&work.key.engine_key())
        .map_err(transient)?;
    if let Some(hook) = &record.hook {
        record.pending_drops.retain(|n| {
            hook.live
                .get(n)
                .is_some_and(|t| pending.iter().any(|p| p.target_id == t.block_id))
        });
    }
    Ok(result)
}

fn wait_bound(config: &McModuleConfig, model: &str) -> u64 {
    let ttl = config.resolve_cache_ttl(Some(model));
    let millis = if let Some(minutes) = ttl.strip_suffix('m') {
        minutes
            .parse::<u64>()
            .ok()
            .map(|n| n.saturating_mul(60_000))
    } else if let Some(hours) = ttl.strip_suffix('h') {
        hours
            .parse::<u64>()
            .ok()
            .map(|n| n.saturating_mul(3_600_000))
    } else if let Some(seconds) = ttl.strip_suffix('s') {
        seconds.parse::<u64>().ok().map(|n| n.saturating_mul(1_000))
    } else {
        None
    };
    millis.unwrap_or(1_000).min(1_000)
}

impl McHandler {
    fn host_setup(
        &self,
        store: &McStore,
        binding: SessionBinding,
        key: &Key,
        request: compact::setup::SetupRequest,
        chosen: transform::compaction::Preset,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let codec = Codec::from_params(&Value::Object(request.params.clone()))?;
        if !binding.config.compaction_enabled {
            return bytes(&compact::setup::SetupAnswer::Refuse {
                request_id: request.request_id,
                code: compact::errors::RefuseCode::Misconfigured,
                reason: "Magic Context compaction is disabled".into(),
                provider_code: None,
            });
        }
        let mut conversation = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
            .unwrap_or_default();
        if conversation.engine_namespace.is_empty() {
            conversation.engine_namespace = if codec == Codec::ClaudeCodeAnthropic {
                key.engine_key()
            } else {
                binding.session.clone()
            };
        }
        let mut setup: HostSetup = if let Some(raw) = &conversation.setup_json {
            serde_json::from_str(raw).map_err(transient)?
        } else {
            let id = format!(
                "mc-{}",
                sha256_hex(
                    format!(
                        "{}:{}:{}",
                        conversation.engine_namespace, request.request_id, request.now
                    )
                    .as_bytes()
                )
            );
            let setup = HostSetup {
                setup: Setup {
                    request: request.clone(),
                    state: transform::compaction::State::new(id, chosen),
                    stability: if chosen == transform::compaction::Preset::Head
                        && codec != Codec::ClaudeCodeAnthropic
                    {
                        vec![
                            compact::setup::StabilityRank { index: 0, rank: 2 },
                            compact::setup::StabilityRank { index: 1, rank: 1 },
                        ]
                    } else {
                        vec![]
                    },
                    call_when: compact::setup::CallWhen::new(
                        binding
                            .config
                            .resolve_execute_threshold(Some(&request.model))
                            .percentage
                            / 100.0,
                    ),
                },
                applied: None,
                produced: None,
                invalidated: false,
                repair_pending: false,
                cache_policy: if codec == Codec::ClaudeCodeAnthropic {
                    Some(super::cache_policy::resolve(
                        &binding,
                        &request.model,
                        chosen,
                    )?)
                } else {
                    None
                },
            };
            conversation.params_json = serde_json::to_string(&request.params).map_err(transient)?;
            conversation.preset = request.preset.clone();
            save_host_setup(store, key, &mut conversation, &setup)?;
            fault("SetupRecorded");
            setup
        };
        if codec == Codec::ClaudeCodeAnthropic && setup.cache_policy.is_none() {
            setup.cache_policy = Some(super::cache_policy::resolve(
                &binding,
                &setup.setup.request.model,
                chosen,
            )?);
        }
        // Setup is an insertion, not an engine opportunity. In particular, it
        // must not seed or mutate frozen full-request state during a switch.
        let high = conversation
            .version_high_water
            .max(setup.setup.state.version_high_water)
            .checked_add(1)
            .ok_or_else(|| transient("version exhausted"))?;
        let mut view = if let Some(summary) = &setup.applied {
            let mut view = load_host_view(store, key, summary)?;
            view.engine.version = high;
            view.wire.version = high;
            view
        } else {
            let engine = transform::compaction::View {
                compaction_id: setup.setup.state.compaction_id.clone(),
                version: high,
                range: transform::compaction::Range {
                    lineage_id: request.lineage_id.clone().unwrap_or_default(),
                    from: 0,
                    to: 0,
                },
                replacement: if chosen == transform::compaction::Preset::Head
                    && codec != Codec::ClaudeCodeAnthropic
                {
                    vec![
                        ck_wire::CkWireMessage::synthetic_user_text(
                            transform::compaction::M0_EMPTY_PLACEHOLDER,
                        ),
                        ck_wire::CkWireMessage::synthetic_user_text(
                            transform::compaction::M1_EMPTY_PLACEHOLDER,
                        ),
                    ]
                } else {
                    vec![]
                },
            };
            let mut template: TransformRequest = decode(
                &json!({"v":2,"kind":"compaction.step","session_id":conversation.engine_namespace,"messages":[],"render_config":"","tool_present":false,"auto_search_enabled":false}),
            )?;
            codec.prepare_request(&mut template, &[])?;
            let tags = BTreeMap::new();
            let wire = codec.encode_view(
                &engine,
                &template,
                &super::codec_opencode::NativeRenderContext {
                    reasoning_clear_units: &[],
                    tag_numbers: &tags,
                    mutation_exempt_mid: None,
                    lineage_anchor_mid: None,
                    transition_consumed: false,
                    native_reasoning_keep_mids: &[],
                },
            )?;
            HostView {
                engine,
                wire,
                coverage: None,
                raw_replacement: (codec == Codec::ClaudeCodeAnthropic).then(Vec::new),
                head_slots: (codec == Codec::ClaudeCodeAnthropic).then(Vec::new),
                cut_replacement: None,
            }
        };
        if codec == Codec::ClaudeCodeAnthropic && view.wire.raw_view.is_some() {
            let retained = view
                .wire
                .raw_view
                .as_ref()
                .and_then(|frozen| frozen.retained_tail.clone());
            view.wire.raw_view = Some(Box::new(super::native_view::freeze(
                key,
                &view.engine,
                view.coverage
                    .as_ref()
                    .and_then(|coverage| coverage.endpoint.as_ref()),
                view.raw_replacement
                    .as_deref()
                    .ok_or_else(|| invalid_field("raw_view"))?,
            )?));
            super::native_cut::refresh(key, &mut view, retained)?;
        }
        save_host_view(store, key, &view, "applied")?;
        setup.setup.state.version_high_water = high;
        setup.applied = Some(ViewSummary::from(&view.engine));
        setup.produced = setup.applied.clone();
        let raw_replacement = view.raw_replacement.clone();
        let head_slots = view.head_slots.clone();
        let answer = compact::setup::SetupAnswer::Ready {
            request_id: request.request_id,
            initial: view.wire,
            stability: setup.setup.stability.clone(),
            call_when: Some(setup.setup.call_when.clone()),
        };
        conversation.last_answer_json = Some(serde_json::to_string(&answer).map_err(transient)?);
        save_host_setup(store, key, &mut conversation, &setup)?;
        fault("AnswerRecorded");
        match raw_replacement {
            Some(raw) => {
                let mut answer = serde_json::to_value(answer).map_err(transient)?;
                answer["cache_policy"] = setup
                    .cache_policy
                    .clone()
                    .ok_or_else(|| invalid_field("cache_policy"))?;
                answer["head_slots"] = json!(head_slots.unwrap_or_default());
                super::codec_claude_code::answer_bytes(&answer, &raw)
            }
            None => bytes(&answer),
        }
    }

    fn host_step(
        &self,
        store: &McStore,
        work: &Work,
        mut conversation: ProviderConversation,
        params: &Value,
        request: compact::status::StepStatus,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let _span =
            tracing::info_span!("provider_step", request_id = %request.request_id).entered();
        let _meters = mc_store::provider_meters::ProviderStoreMeter::start(
            &work.key.session,
            &work.key.harness,
            &request.request_id,
        );
        let envelope_bytes =
            serde_json::to_vec(&json!({"method":"compaction.step","params":params}))
                .map_err(transient)?
                .len();
        if if attested_claude_code(&work.binding) {
            envelope_bytes >= HOST_ENVELOPE_BYTES
        } else {
            envelope_bytes > HOST_ENVELOPE_BYTES
        } {
            return Err(invalid_field("messages"));
        }
        let mut setup: HostSetup =
            serde_json::from_str(conversation.setup_json.as_deref().ok_or_else(|| {
                error("setup_missing", "compaction.step requires a Setup record")
            })?)
            .map_err(transient)?;
        let codec = Codec::from_params(&Value::Object(setup.setup.request.params.clone()))?;
        if codec == Codec::ClaudeCodeAnthropic {
            if let Some(geometry) = &request.geometry {
                if !geometry.is_valid(request.context_window)
                    || request.output_reserve.is_some_and(|reserve| {
                        geometry
                            .usable_hard
                            .checked_add(reserve)
                            .is_none_or(|reserved| reserved > geometry.absolute_wall)
                    })
                {
                    return Err(invalid_field("geometry"));
                }
            } else if request.output_reserve.is_some() {
                return Err(invalid_field("geometry"));
            }
            if request.fill.is_some() {
                return Err(invalid_field("fill"));
            }
            if request.channel2_receipt.is_some() || request.channel2_delivered_id.is_some() {
                return Err(invalid_field("channel2_receipt"));
            }
            if request.messages.iter().any(|message| {
                serde_json::to_vec(message)
                    .map_or(true, |bytes| bytes.len() > HOST_ENVELOPE_BYTES - 1)
            }) {
                return Err(invalid_field("messages"));
            }
        }
        let lineage = host_lineage(store, &work.key, params, &request)?;
        // An acknowledgement names a frozen object, not just a sequence number.
        // Validate both components before admission can promote or burn anything.
        for field in ["last_applied", "last_not_applied"] {
            if let Some(ack) = params.get(field).filter(|v| !v.is_null()) {
                let version = ack.get("version").and_then(Value::as_u64);
                if ack.get("compaction_id").and_then(Value::as_str)
                    != Some(setup.setup.state.compaction_id.as_str())
                    || ![&setup.applied, &setup.produced]
                        .into_iter()
                        .flatten()
                        .any(|v| Some(v.version) == version)
                {
                    return Err(invalid_field(field));
                }
                if codec == Codec::ClaudeCodeAnthropic {
                    let summary = [&setup.applied, &setup.produced]
                        .into_iter()
                        .flatten()
                        .find(|view| Some(view.version) == version)
                        .ok_or_else(|| invalid_field(field))?;
                    load_host_view(store, &work.key, summary)?;
                }
            }
        }
        if let Some(parent) = &lineage.descends_from {
            let cut = lineage.through_ordinal.expect("paired descent");
            let frontier = store
                .provider_frontier(&work.key.store_key(), parent)
                .map_err(transient)?;
            if store
                .load_provider_lineage(&work.key.store_key(), parent)
                .map_err(transient)?
                .is_none()
                || frontier <= cut
            {
                return bytes(&gap_answer(&request.request_id, frontier));
            }
        }
        let messages = request
            .messages
            .iter()
            .map(|m| {
                let mut m = m.clone();
                if codec == Codec::ClaudeCodeAnthropic {
                    m.message =
                        super::codec_claude_code::from_wire(&m.message, m.raw_message.as_deref())?;
                }
                codec.decode_message(&m)?;
                Ok(ProviderMessage {
                    ordinal: m.ordinal,
                    mid: m.mid.clone(),
                    message_bytes: serde_json::to_vec(&m.message).map_err(transient)?,
                })
            })
            .collect::<Result<Vec<_>, HandlerOutcome>>()?;
        let unserved = params
            .get("unserved_subjects")
            .map(|v| {
                let entries = v
                    .as_array()
                    .ok_or_else(|| invalid_field("unserved_subjects"))?;
                entries
                    .iter()
                    .map(|entry| {
                        let part = entry
                            .get("subject_part")
                            .map(|v| {
                                v.as_str()
                                    .filter(|s| !s.is_empty() && s.len() <= 256)
                                    .ok_or_else(|| invalid_field("subject_part"))
                            })
                            .transpose()?
                            .unwrap_or("");
                        Ok(ProviderSubject {
                            subject_mid: entry
                                .get("subject_mid")
                                .and_then(Value::as_str)
                                .ok_or_else(|| invalid_field("unserved_subjects"))?
                                .into(),
                            hook: entry
                                .get("hook")
                                .and_then(Value::as_str)
                                .ok_or_else(|| invalid_field("unserved_subjects"))?
                                .into(),
                            subject_part: part.into(),
                        })
                    })
                    .collect::<Result<Vec<_>, HandlerOutcome>>()
            })
            .transpose()?
            .unwrap_or_default();
        let served = params
            .get("served_through_ordinal")
            .map(|v| {
                v.as_u64()
                    .ok_or_else(|| invalid_field("served_through_ordinal"))
            })
            .transpose()?;
        // The store validates the whole page before any acknowledgement or burn;
        // a conflicting resend must not make a stranded hook answer live.
        match store.commit_provider_status_page(
            &work.key.store_key(),
            mc_store::provider_records::ProviderStatusPage {
                lineage: &lineage,
                messages: &messages,
                served,
                unserved: &unserved,
                newest: request.newest.as_ref().map(|n| n.ordinal),
                more: params.get("more").and_then(Value::as_bool) == Some(true),
            },
        ) {
            Ok(Some(gap)) => return bytes(&gap_answer(&request.request_id, gap)),
            Ok(None) => {}
            Err(e) => {
                return Err(match e {
                    ProviderError::InvalidParams {
                        field: "subject_mid" | "subject_ordinal",
                    } => invalid_field("messages"),
                    ProviderError::InvalidParams { field } => invalid_field(field),
                    ProviderError::Transient(reason) if reason == "an ingested ordinal changed" => {
                        invalid_field("messages")
                    }
                    other => transient(other),
                });
            }
        }
        fault("MessagesIngested");
        conversation = store
            .load_provider_conversation(&work.key.store_key())
            .map_err(transient)?
            .expect("committed conversation");
        if params.get("more").and_then(Value::as_bool) == Some(true) {
            // In answer-observed paging, the durable status page is the work
            // held for the next page; there is no background transcript scan.
            fault("WaitWorkDurable");
            // Paging is an execution fence, not a statement about held bytes.
            // Hooks may already cover newest, but only the final page may render
            // a view or acknowledge the pass's hook answers.
            conversation.cursor_frontier = store
                .provider_frontier(&work.key.store_key(), &lineage.lineage_id)
                .map_err(transient)?;
            conversation.wait_request = None;
            let answer = json!({"answer":"wait","request_id":request.request_id,"reason":"Awaiting the next host status page","bound_ms":1});
            conversation.last_answer_json = Some(answer.to_string());
            save_host_setup(store, &work.key, &mut conversation, &setup)?;
            fault("WaitAnswered");
            fault("AnswerRecorded");
            return bytes(&answer);
        }
        let frontier = store
            .provider_frontier(&work.key.store_key(), &lineage.lineage_id)
            .map_err(transient)?;
        let incomplete = request
            .newest
            .as_ref()
            .is_some_and(|n| frontier <= n.ordinal);
        let mut normalized = status(
            params,
            &Record {
                setup: Some(setup.setup.clone()),
                ..Default::default()
            },
        )?;
        setup.setup.request.model = request.model.clone();
        if params
            .pointer("/prefix_rebuilding/reason")
            .and_then(Value::as_str)
            == Some("flush")
        {
            // An explicit flush uses the same incremental refresh as a
            // whole-history request. Changing the serialization epoch instead
            // would rebuild the entire prefix and fold new summaries into m0
            // rather than updating the incremental history frame (m1).
            store
                .arm_soft_refresh(&conversation.engine_namespace)
                .map_err(transient)?;
            normalized.prefix_rebuilding = false;
        }
        if let Some(rejected) = normalized.last_not_applied.filter(|v| v.structural) {
            store
                .set_provider_view_state(&work.key.store_key(), rejected.version, "not_applied")
                .map_err(transient)?;
        }
        if let Some(version) = normalized.last_applied_version {
            if setup
                .produced
                .as_ref()
                .is_some_and(|v| v.version == version)
            {
                setup.applied = setup.produced.clone();
                setup.invalidated = false;
                setup.repair_pending = false;
                store
                    .set_provider_view_state(&work.key.store_key(), version, "applied")
                    .map_err(transient)?;
            }
        }
        if let Some(applied) = &mut setup.applied {
            if applied.range.from == 0 && applied.range.to == 0 {
                applied.range.lineage_id = lineage.lineage_id.clone();
            }
            if applied.range.lineage_id != lineage.lineage_id {
                let cut = ancestor_cut(store, &work.key, &lineage, &applied.range.lineage_id)?
                    .ok_or_else(|| invalid_field("lineage_id"))?;
                if applied.range.to > 0 && cut < applied.range.to - 1 {
                    setup.invalidated = true;
                    store
                        .set_provider_view_state(
                            &work.key.store_key(),
                            applied.version,
                            "not_applied",
                        )
                        .map_err(transient)?;
                }
                applied.range.lineage_id = lineage.lineage_id.clone();
            }
        }
        if let Some(produced) = &mut setup.produced {
            if produced.range.lineage_id != lineage.lineage_id {
                if let Some(cut) =
                    ancestor_cut(store, &work.key, &lineage, &produced.range.lineage_id)?
                {
                    if produced.range.to > 0 && cut < produced.range.to - 1 {
                        setup.produced = None;
                    } else {
                        produced.range.lineage_id = lineage.lineage_id.clone();
                    }
                } else {
                    setup.produced = None;
                }
            }
        }
        normalized.prefix_rebuilding |= setup.invalidated;
        if normalized.last_not_applied.is_none() {
            if let Some(produced) = &setup.produced {
                if setup
                    .applied
                    .as_ref()
                    .is_none_or(|v| v.version < produced.version)
                    && conversation
                        .last_answer_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .is_some_and(|a| a.get("request_id") != params.get("request_id"))
                {
                    normalized.last_not_applied = Some(transform::compaction::NotApplied {
                        version: produced.version,
                        structural: false,
                    });
                }
            }
        }
        let mut raw_replacement = None;
        let answer = if incomplete {
            // Host paging never owns asynchronous wait work or a ready callback.
            // The lock's guard belongs to the request and drops at this return.
            if params.get("more").and_then(Value::as_bool) == Some(true) {
                json!({"answer":"wait","request_id":request.request_id,"reason":"Awaiting the next host status page","bound_ms":1})
            } else {
                gap_answer(&request.request_id, frontier)
            }
        } else {
            let relevant = normalized.last_not_applied.is_some_and(|n| {
                setup
                    .produced
                    .as_ref()
                    .is_some_and(|v| v.version == n.version)
                    && setup.applied.as_ref().is_none_or(|v| v.version < n.version)
            });
            let skip = !(codec == Codec::ClaudeCodeAnthropic && request.geometry.is_some())
                && can_skip_host_step(
                    store,
                    work,
                    &conversation.engine_namespace,
                    &request.model,
                    &normalized,
                    relevant,
                )?;
            if skip {
                json!({"answer":"noop","request_id":request.request_id})
            } else {
                setup.setup.state.version_high_water = conversation
                    .version_high_water
                    .max(normalized.last_applied_version.unwrap_or(0))
                    .max(normalized.last_not_applied.map_or(0, |n| n.version))
                    .checked_add(1)
                    .ok_or_else(|| transient("version exhausted"))?;
                save_host_setup(store, &work.key, &mut conversation, &setup)?;
                let view = match execute_host(
                    store,
                    work,
                    &conversation,
                    &mut setup,
                    &normalized,
                    &lineage,
                    &request.request_id,
                    Some(&request),
                ) {
                    Err(HandlerOutcome::Error { code, message })
                        if codec == Codec::ClaudeCodeAnthropic
                            && matches!(
                                code.as_str(),
                                "signed_prefix_edit"
                                    | "native_endpoint_missing"
                                    | "native_hook_cut_unrepresentable"
                                    | "invalid_signed_tool_boundary"
                                    | "native_endpoint_unrepresentable"
                            ) =>
                    {
                        return bytes(
                            &json!({"answer":"refuse","request_id":request.request_id,"code":"misconfigured","reason":message,"provider_code":code}),
                        );
                    }
                    result => result?,
                };
                let current = store
                    .load_provider_conversation(&work.key.store_key())
                    .map_err(transient)?
                    .ok_or_else(|| transient("provider conversation disappeared"))?;
                let mut counters: Value =
                    serde_json::from_str(&current.hook_counters_json).map_err(transient)?;
                counters["channel1_hook_append_pending"] = json!(false);
                conversation.hook_counters_json = counters.to_string();
                if let Some(view) = view {
                    raw_replacement = view.raw_replacement.clone();
                    save_host_view(store, &work.key, &view, "produced")?;
                    setup.produced = Some(ViewSummary::from(&view.engine));
                    let mut answer = json!({"answer":"compaction_message","request_id":request.request_id,"compaction":view.wire});
                    if let Some(slots) = view.head_slots {
                        answer["head_slots"] = json!(slots);
                    }
                    if let Some(coverage) = view.coverage {
                        answer["coverage"] = serde_json::to_value(coverage).map_err(transient)?;
                    }
                    answer
                } else {
                    json!({"answer":"noop","request_id":request.request_id})
                }
            }
        };
        let mut answer = answer;
        if codec == Codec::ClaudeCodeAnthropic {
            answer["cache_policy"] = setup
                .cache_policy
                .clone()
                .ok_or_else(|| invalid_field("cache_policy"))?;
        }
        conversation.cursor_frontier = frontier;
        conversation.wait_request = None;
        conversation.last_answer_json = Some(answer_receipt(&answer));
        save_host_setup(store, &work.key, &mut conversation, &setup)?;
        fault("AnswerRecorded");
        if params
            .get("consume_prepared_policy")
            .and_then(Value::as_bool)
            == Some(true)
            && answer.get("answer").and_then(Value::as_str) == Some("compaction_message")
        {
            let started = Instant::now();
            let prepared = store
                .prepare_provider_policy(&work.key.store_key(), |index, counters| {
                    super::policy_summary::prepare_policy(
                        index,
                        &counters["engine_policy"],
                        work.binding.config.resolve_protected_tokens(100_000).floor,
                        &work.binding.config.protected_tools,
                        counters
                            .pointer("/pass_context/model_key")
                            .and_then(Value::as_str),
                    )
                })
                .map_err(transient)?;
            tracing::info!(session_id = %work.key.session, request_id = %request.request_id,
                prepared, preparation_ms = started.elapsed().as_secs_f64()*1000.0,
                "provider policy preparation complete");
        }
        match raw_replacement {
            Some(raw) => super::codec_claude_code::answer_bytes(&answer, &raw),
            None => bytes(&answer),
        }
    }

    fn provider_work(
        &self,
        store: &McStore,
        binding: SessionBinding,
        key: Key,
    ) -> Result<Work, HandlerOutcome> {
        let route = self.route_project(store, &binding)?;
        Ok(Work {
            resident_folds: self.provider_resident.is_enabled(),
            project_directory: binding.project_root.to_string_lossy().into_owned(),
            note_project_path: route.key.clone(),
            project_path: route.key,
            binding,
            key,
        })
    }

    pub(super) async fn provider_setup(
        &self,
        binding: SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let request: compact::setup::SetupRequest = decode(params)?;
        let key = Key::new(&binding, &request.session, &request.harness)?;
        let chosen = preset(request.preset.as_deref())?;
        let plan_params = serde_json::to_value(&request.params).map_err(transient)?;
        Codec::from_params(&plan_params)?;
        let host = host_plan(&binding, &request.session, &request.harness, &plan_params)?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        if host {
            let _route = if attested_claude_code(&binding) {
                Some(self.native_publication_fence(&binding)?)
            } else {
                None
            };
            return self.host_setup(&store, binding, &key, request, chosen);
        }
        let mut record = self.provider_store.load(&key)?;
        if record.catalog.is_none() {
            record.catalog = self.provider_store.catalog(&SessionBinding {
                session: key.session.clone(),
                ..binding.clone()
            })?;
        }
        let work = self.provider_work(&store, binding, key.clone())?;
        if record.setup.is_none() {
            if !work.binding.config.compaction_enabled {
                return bytes(&compact::setup::SetupAnswer::Refuse {
                    request_id: request.request_id,
                    code: compact::errors::RefuseCode::Misconfigured,
                    reason: "Magic Context compaction is disabled".into(),
                    provider_code: None,
                });
            }
            let threshold = work
                .binding
                .config
                .resolve_execute_threshold(Some(&request.model))
                .percentage
                / 100.0;
            let id = format!(
                "mc-{}",
                sha256_hex(
                    format!(
                        "{}:{}:{}",
                        key.engine_key(),
                        request.request_id,
                        request.now
                    )
                    .as_bytes()
                )
            );
            record.setup = Some(Setup {
                request: request.clone(),
                state: transform::compaction::State::new(id, chosen),
                stability: if chosen == transform::compaction::Preset::Head {
                    vec![
                        compact::setup::StabilityRank { index: 0, rank: 2 },
                        compact::setup::StabilityRank { index: 1, rank: 1 },
                    ]
                } else {
                    vec![]
                },
                call_when: compact::setup::CallWhen::new(threshold),
            });
            // Persist the Setup before engine work. Re-entry can finish a Setup
            // killed between recording its inputs and producing its initial view.
            self.provider_store.save(&key, &record)?;
            fault("SetupRecorded");
        }
        if request.newest.is_some() {
            scan(
                &self.provider_store,
                self.provider_runner.as_ref(),
                &key,
                &mut record,
                request.lineage_id.as_deref(),
                &[],
                Instant::now() + Duration::from_millis(HOOK_BUDGET_MS),
            )
            .await?;
        }
        let mut normalized = status(params, &record)?;
        if normalized.lineage_id.is_empty() {
            normalized.lineage_id = request.lineage_id.clone().unwrap_or_default();
        }
        let high = record
            .setup
            .as_ref()
            .expect("setup")
            .state
            .version_high_water
            .checked_add(1)
            .ok_or_else(|| transient("compaction version exhausted"))?;
        record
            .setup
            .as_mut()
            .expect("setup")
            .state
            .version_high_water = high;
        self.provider_store.save(&key, &record)?;
        let initial = if let Some(mut initial) = record
            .setup
            .as_ref()
            .expect("setup")
            .state
            .last_applied
            .clone()
        {
            initial.version = high;
            let state = &mut record.setup.as_mut().expect("setup").state;
            state.last_produced = Some(initial.clone());
            state.last_applied = Some(initial.clone());
            initial
        } else {
            match execute(&store, &work, &mut record, &normalized, true)?.answer {
                transform::compaction::Answer::Replacement(initial) => initial,
                transform::compaction::Answer::Noop => {
                    return Err(transient("Setup did not produce an initial view"))
                }
            }
        };
        let setup = record.setup.as_ref().expect("setup");
        let answer = compact::setup::SetupAnswer::Ready {
            request_id: request.request_id,
            initial: checked_view(&initial, &record)?,
            stability: setup.stability.clone(),
            call_when: Some(setup.call_when.clone()),
        };
        record.last_answer = Some(serde_json::to_value(&answer).map_err(transient)?);
        self.provider_store.save(&key, &record)?;
        fault("AnswerRecorded");
        bytes(&answer)
    }

    pub(super) async fn provider_step(
        &self,
        binding: SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        // Usage can omit unreported fields. Decode the remainder with the role
        // type, but normalize the original measurements without filling holes.
        let mut wire = params.clone();
        // Only a reserved:thalamus binding for Claude Code uses raw_message.
        // Drop it for other bindings before typed decoding: those callers used
        // to send it as an ignored extra, including values that are not strings.
        if !attested_claude_code(&binding) {
            if let Some(messages) = wire.get_mut("messages").and_then(Value::as_array_mut) {
                for message in messages {
                    if let Some(object) = message.as_object_mut() {
                        object.remove("raw_message");
                    }
                }
            }
        }
        wire.as_object_mut()
            .ok_or_else(|| invalid("step params must be an object"))?
            .remove("previous_usage");
        let request: compact::status::StepStatus = decode(&wire)?;
        let key = Key::new(&binding, &request.session, &request.harness)?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        if attested_claude_code(&binding) {
            let _route = self.native_publication_fence(&binding)?;
            let conversation = store
                .load_provider_conversation(&key.store_key())
                .map_err(transient)?
                .ok_or_else(|| {
                    error(
                        "setup_missing",
                        "native step requires its frozen conversation",
                    )
                })?;
            let frozen: Value =
                serde_json::from_str(&conversation.params_json).map_err(transient)?;
            if !host_plan(&binding, &request.session, &request.harness, &frozen)? {
                return Err(invalid_field("params"));
            }
            let work = self.provider_work(&store, binding, key)?;
            return self.host_step(&store, &work, conversation, params, request);
        }
        if let Some(conversation) = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
        {
            let frozen: Value =
                serde_json::from_str(&conversation.params_json).map_err(transient)?;
            if host_plan(&binding, &request.session, &request.harness, &frozen)? {
                let work = self.provider_work(&store, binding, key)?;
                return self.host_step(&store, &work, conversation, params, request);
            }
        }
        let mut record = self.provider_store.load(&key)?;
        if record.setup.is_none() {
            return Err(error(
                "setup_missing",
                "compaction.step requires a Setup record for this project and session",
            ));
        }
        let work = self.provider_work(&store, binding, key.clone())?;
        ingest(&mut record, &request.lineage_id, &request.messages)?;
        self.provider_store.save(&key, &record)?;
        fault("MessagesIngested");
        let normalized = status(params, &record)?;
        let complete = request
            .newest
            .as_ref()
            .is_none_or(|n| frontier(&record, &request.lineage_id) > n.ordinal);
        if !complete {
            let bound = wait_bound(&work.binding.config, &request.model);
            if bound == 0 {
                return Err(transient("prefix cache TTL does not permit waiting"));
            }
            record.wait_request = Some(request.request_id.clone());
            let answer = compact::answer::StepAnswer::Wait {
                request_id: request.request_id.clone(),
                reason: "Reading the remaining transcript".into(),
                bound_ms: bound,
            };
            record.last_answer = Some(serde_json::to_value(&answer).map_err(transient)?);
            self.provider_store.save(&key, &record)?;
            let storage = Arc::clone(&self.provider_store);
            let runner = Arc::clone(&self.provider_runner);
            let serial = Arc::clone(&self.provider_serial);
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                fault("WaitAnswered");
                let _serial = serial.lock_for(&key).await;
                let result = async {
                    let mut record = storage.load(&key)?;
                    if record.wait_request.as_deref() != Some(&request.request_id) {
                        return Ok(());
                    }
                    scan(
                        &storage,
                        runner.as_ref(),
                        &key,
                        &mut record,
                        Some(&request.lineage_id),
                        &[],
                        Instant::now() + Duration::from_millis(bound),
                    )
                    .await?;
                    let state = &mut record.setup.as_mut().expect("wait setup").state;
                    state.version_high_water = state
                        .version_high_water
                        .max(normalized.last_applied_version.unwrap_or(0))
                        .checked_add(1)
                        .ok_or_else(|| transient("version exhausted"))?;
                    storage.save(&key, &record)?;
                    if let transform::compaction::Answer::Replacement(view) =
                        execute(&store, &work, &mut record, &normalized, false)?.answer
                    {
                        checked_view(&view, &record)?;
                        record.wait_view = Some(view);
                    }
                    record.wait_request = None;
                    storage.save(&key, &record)?;
                    fault("WaitWorkDurable");
                    runner
                        .call(
                            &key.project,
                            &request.session,
                            "compaction.ready",
                            json!({"session":request.session,"request_id":request.request_id}),
                            Duration::from_millis(bound),
                        )
                        .await
                        .map_err(transient)?;
                    Ok::<(), HandlerOutcome>(())
                }
                .await;
                if let Err(error) = result {
                    tracing::warn!("mc-module: provider wait work failed: {error:?}");
                }
            });
            return bytes(&answer);
        }
        let state = &mut record.setup.as_mut().expect("setup").state;
        // Reserve before touching engine state. A crash can skip a number,
        // but cannot let a later answer reuse an allocated number.
        state.version_high_water = state
            .version_high_water
            .max(normalized.last_applied_version.unwrap_or(0))
            .max(normalized.last_not_applied.map_or(0, |n| n.version))
            .checked_add(1)
            .ok_or_else(|| transient("version exhausted"))?;
        self.provider_store.save(&key, &record)?;
        let output = execute(&store, &work, &mut record, &normalized, false)?;
        let produced = output.answer;
        if matches!(produced, transform::compaction::Answer::Replacement(_)) {
            record.wait_view = None;
        }
        let answer = match produced {
            transform::compaction::Answer::Noop => compact::answer::StepAnswer::Noop {
                channel2_directive: None,
                bootstrap_complete: None,
                request_id: request.request_id,
            },
            transform::compaction::Answer::Replacement(view) => {
                compact::answer::StepAnswer::CompactionMessage {
                    channel2_directive: None,
                    bootstrap_complete: None,
                    request_id: request.request_id,
                    compaction: checked_view(&view, &record)?,
                    coverage: None,
                }
            }
        };
        record.wait_request = None;
        record.last_answer = Some(serde_json::to_value(&answer).map_err(transient)?);
        self.provider_store.save(&key, &record)?;
        fault("AnswerRecorded");
        bytes(&answer)
    }
}

#[cfg(test)]
mod host_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct NoReads(AtomicUsize);
    #[async_trait]
    impl session_resolver::ProviderRunner for NoReads {
        async fn call(
            &self,
            _: &Path,
            _: &str,
            _: &str,
            _: Value,
            _: Duration,
        ) -> Result<Value, SessionResolveError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            // A stray wait scan would hold the conversation lock long enough
            // that the next page's timing assertion fails, not merely log it.
            tokio::time::sleep(Duration::from_secs(5)).await;
            Err(SessionResolveError::Transport(
                "host cannot serve transcript reads".into(),
            ))
        }
    }

    fn handler(dir: &Path, runner: Arc<NoReads>) -> (McHandler, SessionBinding, Arc<McStore>, Key) {
        let descriptor = StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into_owned(),
            },
        };
        let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
        let mut handler = McHandler::new();
        handler.store.set(store.clone()).ok().unwrap();
        handler.provider_runner = runner;
        let binding = SessionBinding {
            connection_incarnation: 0,
            native_generation: None,
            principal: None,
            scope: None,
            project_root: dir.into(),
            harness: "opencode".into(),
            session: "s".into(),
            model_key: None,
            history_budget_tokens: 4000.0,
            config: McModuleConfig {
                inject_docs: false,
                memory_enabled: false,
                protected_tokens_user: Some(0),
                protected_tools: BTreeMap::new(),
                ..Default::default()
            },
        };
        handler.bind_route(7, binding.clone());
        let key = Key::new(&binding, "s", "opencode").unwrap();
        (handler, binding, store, key)
    }
    fn setup() -> Value {
        json!({"session":"s","harness":"opencode","request_id":"setup","preset":"head","params":{"serializer_profile":"opencode-aisdk","observation":"answer"},"composition":{},"model":"fixture","context_window":100000,"now":1,"lineage_id":"L"})
    }
    fn message(ordinal: u64) -> Value {
        json!({"ordinal":ordinal,"mid":format!("m{ordinal}"),"message":{"info":{"id":format!("m{ordinal}"),"role":"user","time":{"created":1}},"parts":[{"id":format!("p{ordinal}"),"type":"text","text":format!("raw {ordinal}")} ]}})
    }
    fn step(id: &str, messages: Vec<Value>, newest: u64) -> Value {
        json!({"session":"s","harness":"opencode","request_id":id,"lineage_id":"L","step_id":"st","step_kind":"user_turn","model":"fixture","context_window":100000,"estimate":{"request_tokens":1000},"messages":messages,"newest":{"ordinal":newest,"mid":format!("m{newest}")},"now":2})
    }
    fn answer(result: Result<Vec<u8>, HandlerOutcome>) -> Value {
        serde_json::from_slice(&result.unwrap()).unwrap()
    }

    fn full_request_native(
        h: &McHandler,
        binding: &SessionBinding,
        store: &McStore,
        native: &[Value],
        model: &str,
    ) -> (Value, String) {
        let entries = native
            .iter()
            .enumerate()
            .map(|(i, m)| compact::status::StatusMessage {
                raw_message: None,
                ordinal: i as u64 + 1,
                mid: m["info"]["id"].as_str().unwrap().into(),
                message: m.clone(),
            })
            .collect::<Vec<_>>();
        let mut request: TransformRequest = decode(&json!({"v":2,"kind":"transform","session_id":"s",
            "serializer_profile":"opencode-aisdk","render_config":"independent-full-request",
            "model_key":model,"messages":[],"tool_present":true,"auto_search_enabled":false,
            "protected_tokens_effective":0,"usage":{"current_total_input_tokens":1000,"context_limit_tokens":100000}})).unwrap();
        Codec::OpencodeAiSdk
            .prepare_request(&mut request, &entries)
            .unwrap();
        let key = Key::new(binding, "s", "opencode").unwrap();
        let work = h.provider_work(store, binding.clone(), key).unwrap();
        let mut context = producer_context(&work, model, 100000, false);
        context.temporal_awareness = false;
        context.cache_ttl = "never".into();
        let mut engine = transform::transform_with_projection(store, &request, &context).unwrap();
        crate::attach_native_messages_with_tags(
            &mut engine.response,
            &request,
            &engine.reasoning_clear_units,
            &engine.tag_numbers,
            engine.mutation_exempt_mid.as_deref(),
            engine.lineage_anchor_mid.as_deref(),
            engine.transition_consumed,
        );
        (
            serde_json::to_value(engine.response.native_messages.unwrap()).unwrap(),
            engine.response.action,
        )
    }

    #[tokio::test]
    async fn model_switch_uses_current_step_model_and_matches_full_request_bytes() {
        let actual = tempfile::tempdir().unwrap();
        let oracle = tempfile::tempdir().unwrap();
        let (h, mut binding, store, _) = handler(actual.path(), Arc::new(NoReads::default()));
        let (oh, mut ob, os, _) = handler(oracle.path(), Arc::new(NoReads::default()));
        binding.config.temporal_awareness = false;
        ob.config.temporal_awareness = false;
        let native = vec![message(1)["message"].clone(), message(2)["message"].clone()];
        for _ in 0..2 {
            assert_eq!(
                full_request_native(&h, &binding, &store, &native, "fixture").0,
                full_request_native(&oh, &ob, &os, &native, "fixture").0
            );
        }
        answer(h.provider_setup(binding.clone(), &setup()).await);
        let mut boot = step("boot-model", vec![message(1), message(2)], 2);
        boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(binding.clone(), &boot).await);
        let mut switched = step("model-switch", vec![], 2);
        switched["model"] = json!("next-model");
        switched["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
        switched["prefix_rebuilding"] = json!({"reason":"model_switch"});
        let previous_core_version = store.load("s").unwrap().core.version;
        let actual = answer(h.provider_step(binding, &switched).await);
        let (expected, decision) = full_request_native(&oh, &ob, &os, &native, "next-model");
        assert_eq!(decision, "HARD");
        let served = if actual["answer"] == "noop" {
            &view["compaction"]["replacement"]
        } else {
            assert_eq!(actual["answer"], "compaction_message");
            &actual["compaction"]["replacement"]
        };
        assert_eq!(*served, expected);
        assert!(
            store.load("s").unwrap().core.version > previous_core_version,
            "model eviction executes the HARD even when served bytes need no new view"
        );
        assert_eq!(
            store.load_meta("s").unwrap().meta.last_model_key,
            "next-model"
        );
    }

    #[tokio::test]
    async fn published_trimmed_prefix_bootstraps_then_flushes_like_full_request() {
        let actual = tempfile::tempdir().unwrap();
        let oracle = tempfile::tempdir().unwrap();
        let (h, mut binding, store, _) = handler(actual.path(), Arc::new(NoReads::default()));
        let (oh, mut ob, os, _) = handler(oracle.path(), Arc::new(NoReads::default()));
        binding.config.temporal_awareness = false;
        ob.config.temporal_awareness = false;
        let native = (1..=3)
            .map(|n| message(n)["message"].clone())
            .collect::<Vec<_>>();
        let baseline = mc_store::StoredCompartment {
            sequence: 1,
            start_message: 1,
            end_message: 1,
            end_message_id: "m1#0".into(),
            title: "baseline".into(),
            content: "summary".into(),
            p1: Some("summary".into()),
            importance: 50,
            ..Default::default()
        };
        for s in [&store, &os] {
            s.replace_compartments("s", std::slice::from_ref(&baseline))
                .unwrap();
        }
        let mut expected = Value::Null;
        for _ in 0..2 {
            expected = full_request_native(&oh, &ob, &os, &native, "fixture").0;
            assert_eq!(
                full_request_native(&h, &binding, &store, &native, "fixture").0,
                expected
            );
        }
        answer(h.provider_setup(binding.clone(), &setup()).await);
        let mut boot = step("published-switch", vec![message(2), message(3)], 3);
        boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(binding.clone(), &boot).await);
        assert_eq!(view["answer"], "compaction_message");
        assert_eq!(view["compaction"]["replacement"], expected);
        let published = mc_store::StoredCompartment {
            sequence: 2,
            start_message: 2,
            end_message: 2,
            end_message_id: "m2#0".into(),
            title: "new".into(),
            content: "delta".into(),
            p1: Some("delta".into()),
            importance: 50,
            ..Default::default()
        };
        for s in [&store, &os] {
            s.replace_compartments("s", &[baseline.clone(), published.clone()])
                .unwrap();
        }
        let mut ordinary = step("after-publication", vec![], 3);
        ordinary["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
        assert_eq!(
            answer(h.provider_step(binding.clone(), &ordinary).await)["answer"],
            "noop"
        );
        assert_eq!(
            full_request_native(&oh, &ob, &os, &native, "fixture").0,
            expected
        );
        let mut flush = ordinary;
        flush["request_id"] = json!("published-flush");
        flush["prefix_rebuilding"] = json!({"reason":"flush"});
        os.arm_soft_refresh("s").unwrap();
        let actual = answer(h.provider_step(binding, &flush).await);
        assert_eq!(actual["answer"], "compaction_message");
        assert_eq!(
            actual["compaction"]["replacement"],
            full_request_native(&oh, &ob, &os, &native, "fixture").0
        );
    }
    fn field(result: Result<Vec<u8>, HandlerOutcome>) -> String {
        match result.unwrap_err() {
            HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
                assert_eq!(code, "invalid_params");
                detail["field"].as_str().unwrap().into()
            }
            other => panic!("{other:?}"),
        }
    }

    fn hook_answer(
        store: &McStore,
        key: &Key,
        lineage: &ProviderLineage,
        entry: &Value,
        hook: &str,
        target: (&str, Value, &[usize]),
    ) {
        let (part, ops, tag_blocks) = target;
        let message = ProviderMessage {
            ordinal: entry["ordinal"].as_u64().unwrap(),
            mid: entry["mid"].as_str().unwrap().into(),
            message_bytes: serde_json::to_vec(&entry["message"]).unwrap(),
        };
        store
            .commit_provider_hook(
                &key.store_key(),
                mc_store::provider_records::ProviderHookRequest {
                    lineage,
                    message: Some(&message),
                    served_through_ordinal: None,
                    unserved_subjects: &[],
                    repeat_subject: None,
                },
                |ctx| {
                    let tags = tag_blocks
                        .iter()
                        .enumerate()
                        .map(|(i, block)| mc_store::provider_records::ProviderAnswerTag {
                            number: ctx.tag_high_water + 1 + i as i64,
                            block_id: format!("{}#{block}", message.mid),
                            kind: if hook == "post_tool" {
                                "tool_result"
                            } else {
                                "message"
                            }
                            .into(),
                            source: "raw".into(),
                            token_count: 1,
                            created_at_ms: 1,
                        })
                        .collect();
                    Ok((
                        mc_store::provider_records::ProviderHookWrite {
                            answer: Some(mc_store::provider_records::ProviderHookAnswer {
                                subject: ProviderSubject {
                                    subject_mid: message.mid.clone(),
                                    hook: hook.into(),
                                    subject_part: part.into(),
                                },
                                ordinal: message.ordinal,
                                ops_json: ops.to_string(),
                                tags,
                            }),
                            counters: ctx.counters.clone(),
                            policy_summary: None,
                        },
                        (),
                    ))
                },
            )
            .unwrap();
    }

    #[tokio::test]
    async fn rebuild_replacement_equals_hook_served_bytes_with_one_overlay_tag_per_block() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(NoReads::default());
        let (h, b, s, k) = handler(dir.path(), runner.clone());
        answer(h.provider_setup(b.clone(), &setup()).await);
        let l = ProviderLineage {
            lineage_id: "L".into(),
            first_ordinal: 4000,
            descends_from: None,
            through_ordinal: None,
        };
        let user = message(4000);
        let assistant = json!({"ordinal":4001,"mid":"a","message":{"info":{"id":"a","role":"assistant","time":{"created":1,"completed":2}},"parts":[{"id":"text","type":"text","text":"assistant"},{"id":"tool1","type":"tool","callID":"c1","tool":"read","state":{"status":"completed","input":{"path":"a"},"output":"one"}},{"id":"tool2","type":"tool","callID":"c2","tool":"read","state":{"status":"completed","input":{"path":"b"},"output":"two"}}]}});
        hook_answer(
            &s,
            &k,
            &l,
            &user,
            "pre_user",
            (
                "",
                json!([{"op":"prepend","block":0,"text":"<!-- +2h -->\n"},{"op":"append","block":0,"text":"\nhint"}]),
                &[0],
            ),
        );
        hook_answer(
            &s,
            &k,
            &l,
            &assistant,
            "post_assistant",
            ("", json!([]), &[0]),
        );
        hook_answer(
            &s,
            &k,
            &l,
            &assistant,
            "post_tool",
            (
                "tool1",
                json!([{"op":"append","block":0,"text":"\nreminder"}]),
                &[2],
            ),
        );
        hook_answer(
            &s,
            &k,
            &l,
            &assistant,
            "post_tool",
            ("tool2", json!([]), &[4]),
        );
        let mut page = step("rebuild", vec![], 4001);
        page["served_through_ordinal"] = json!(4001);
        page["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let output = answer(h.provider_step(b.clone(), &page).await);
        assert_eq!(output["answer"], "compaction_message");
        let replacement = output["compaction"]["replacement"].as_array().unwrap();
        let rendered_user = replacement
            .iter()
            .find(|m| m.pointer("/info/id") == Some(&json!("m4000")))
            .unwrap();
        let mut served_user = user["message"].clone();
        served_user["parts"][0]["text"] = json!("§1§ <!-- +2h -->\nraw 4000\nhint");
        assert_eq!(
            rendered_user,
            &served_user,
            "engine view: {}",
            s.load_provider_views(&k.store_key())
                .unwrap()
                .last()
                .unwrap()
                .replacement_json
        );
        assert_eq!(
            serde_json::to_vec(rendered_user).unwrap(),
            serde_json::to_vec(&served_user).unwrap()
        );
        let rendered_assistant = replacement
            .iter()
            .find(|m| m.pointer("/info/id") == Some(&json!("a")))
            .unwrap();
        let mut served_assistant = assistant["message"].clone();
        served_assistant["parts"][0]["text"] = json!("§2§ assistant");
        served_assistant["parts"][1]["state"]["output"] = json!("§3§ one\nreminder");
        served_assistant["parts"][2]["state"]["output"] = json!("§4§ two");
        assert_eq!(
            serde_json::to_vec(rendered_assistant).unwrap(),
            serde_json::to_vec(&served_assistant).unwrap()
        );
        let tags = s.load_tags_for_session("s").unwrap();
        assert_eq!(tags.len(), 4);
        let bytes = output.to_string();
        for n in 1..=4 {
            assert_eq!(bytes.matches(&format!("§{n}§")).count(), 1);
        }
        assert_eq!(runner.0.load(Ordering::SeqCst), 0);
        let mut settled = step("settled", vec![], 4001);
        settled["last_applied"] = json!({"compaction_id":output["compaction"]["compaction_id"],"version":output["compaction"]["version"]});
        settled["served_through_ordinal"] = json!(4001);
        assert_eq!(answer(h.provider_step(b, &settled).await)["answer"], "noop");
    }

    #[tokio::test]
    async fn fast_noop_does_not_read_rebuild_payloads_or_commit_frozen_state() {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
        answer(h.provider_setup(b.clone(), &setup()).await);
        let mut first = step("first", vec![message(1)], 1);
        first["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(b.clone(), &first).await);
        let l = s
            .load_provider_lineage(&k.store_key(), "L")
            .unwrap()
            .unwrap();
        // Valid opaque JSON, deliberately not an ops array. A needless rebuild
        // would have to read/decode it and fail; a real noop needs only metadata.
        hook_answer(
            &s,
            &k,
            &l,
            &message(2),
            "pre_user",
            ("", json!({"unreadable_ops":true}), &[]),
        );
        let before = s.load_meta("s").unwrap().row_version;
        let mut noop = step("noop", vec![], 2);
        noop["served_through_ordinal"] = json!(2);
        noop["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
        assert_eq!(answer(h.provider_step(b, &noop).await)["answer"], "noop");
        assert_eq!(s.load_meta("s").unwrap().row_version, before);
    }

    #[tokio::test]
    async fn rebuild_keeps_pre_switch_tag_numbers_and_does_not_mint_raw_fallback_tags() {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
        let old = s
            .seed_tags_for_test(
                "s",
                &[mc_store::TagMintInput {
                    block_id: "m1#0".into(),
                    kind: "message".into(),
                    token_count: 2,
                    source_bytes: b"raw 1".to_vec(),
                }],
                1,
            )
            .unwrap()[0]
            .tag_number;
        answer(h.provider_setup(b.clone(), &setup()).await);
        let l = ProviderLineage {
            lineage_id: "L".into(),
            first_ordinal: 1,
            descends_from: None,
            through_ordinal: None,
        };
        hook_answer(&s, &k, &l, &message(2), "pre_user", ("", json!([]), &[0]));
        let mut page = step("switch", vec![message(1), message(3)], 3);
        page["served_through_ordinal"] = json!(3);
        page["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(b, &page).await);
        let raw = view["compaction"]["replacement"].as_array().unwrap();
        for (mid, text) in [
            ("m1", format!("§{old}§ raw 1")),
            ("m2", format!("§{}§ raw 2", old + 1)),
            ("m3", "raw 3".into()),
        ] {
            let rendered = raw
                .iter()
                .find(|m| m.pointer("/info/id") == Some(&json!(mid)))
                .unwrap();
            assert_eq!(rendered["parts"][0]["text"], text);
        }
        assert_eq!(s.load_tags_for_session("s").unwrap().len(), 2);
    }

    #[tokio::test]
    async fn restart_resumes_bootstrap_pages_without_reads_and_setup_reentry_keeps_frozen_view() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(NoReads::default());
        let (h, b, s, k) = handler(dir.path(), runner.clone());
        answer(h.provider_setup(b.clone(), &setup()).await);
        let mut first = step("page1", vec![message(4000)], 4001);
        first["more"] = json!(true);
        assert_eq!(answer(h.provider_step(b, &first).await)["answer"], "wait");
        assert_eq!(s.provider_frontier(&k.store_key(), "L").unwrap(), 4001);
        drop(h);
        drop(s);
        let (h, b, _, _) = handler(dir.path(), runner.clone());
        let mut last = step("page2", vec![message(4001)], 4001);
        last["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(b.clone(), &last).await);
        let mut observe = step("observed", vec![], 4001);
        observe["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
        assert_eq!(
            answer(h.provider_step(b.clone(), &observe).await)["answer"],
            "noop"
        );
        let ready = answer(h.provider_setup(b, &setup()).await);
        assert_eq!(ready["initial"]["range"], view["compaction"]["range"]);
        assert_eq!(
            ready["initial"]["replacement"],
            view["compaction"]["replacement"]
        );
        assert_eq!(runner.0.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn coverage_names_the_published_boundary_only_on_a_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, _) = handler(dir.path(), Arc::new(NoReads::default()));
        answer(h.provider_setup(b.clone(), &setup()).await);
        s.replace_compartments(
            "s",
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 4000,
                end_message: 4000,
                end_message_id: "m4000#0".into(),
                title: "history".into(),
                content: "published history".into(),
                p1: Some("published history".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
        let mut page = step("rebuild", vec![message(4000), message(4001)], 4001);
        page["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(b.clone(), &page).await);
        assert_eq!(view["answer"], "compaction_message");
        assert_eq!(view["coverage"], json!({"end_mid":"m4000","ordinal":4000}));
        let mut next = step("noop", vec![], 4001);
        next["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
        let noop = answer(h.provider_step(b, &next).await);
        assert_eq!(noop["answer"], "noop");
        assert!(noop.get("coverage").is_none());
    }

    #[tokio::test]
    async fn executed_host_drops_leave_the_provider_queue_and_do_not_reapply() {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
        answer(h.provider_setup(b.clone(), &setup()).await);
        let l = ProviderLineage {
            lineage_id: "L".into(),
            first_ordinal: 1,
            descends_from: None,
            through_ordinal: None,
        };
        // The last three tagged tool results are structurally protected even
        // with a zero token floor. Put the queued target outside that window.
        for ordinal in 2..=5 {
            let tool = json!({"ordinal":ordinal,"mid":format!("tool{ordinal}"),"message":{
                "info":{"id":format!("tool{ordinal}"),"role":"assistant","time":{"created":1,"completed":2}},
                "parts":[{"id":"part","type":"tool","callID":format!("call{ordinal}"),"tool":"read",
                    "state":{"status":"completed","input":{"path":"a"},"output":if ordinal==2 {"obsolete payload"} else {"fresh payload"}}}]}});
            hook_answer(&s, &k, &l, &tool, "post_tool", ("part", json!([]), &[1]));
        }
        let mut bootstrap = step("bootstrap", vec![message(1), message(6)], 6);
        bootstrap["served_through_ordinal"] = json!(6);
        bootstrap["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(b.clone(), &bootstrap).await);
        s.replace_compartments(
            "s",
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 1,
                end_message_id: "m1#0".into(),
                title: "history".into(),
                content: "published".into(),
                p1: Some("published".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
        s.queue_provider_drops(&k.store_key(), &[1]).unwrap();
        let mut execute = step("execute", vec![], 6);
        execute["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
        execute["estimate"]["request_tokens"] = json!(66000);
        execute["prefix_rebuilding"] = json!({"reason":"flush"});
        let dropped = answer(h.provider_step(b.clone(), &execute).await);
        assert_eq!(dropped["answer"], "compaction_message");
        assert!(!dropped["compaction"]["replacement"]
            .to_string()
            .contains("obsolete payload"));
        assert!(s.load_pending_agent_drops("s").unwrap().is_empty());
        assert!(s
            .load_provider_pending_drops(&k.store_key())
            .unwrap()
            .is_empty());
        let mut again = step("again", vec![], 6);
        again["last_applied"] = json!({"compaction_id":dropped["compaction"]["compaction_id"],"version":dropped["compaction"]["version"]});
        again["prefix_rebuilding"] = json!({"reason":"flush"});
        let _ = answer(h.provider_step(b, &again).await);
        assert!(s.load_pending_agent_drops("s").unwrap().is_empty());
        assert!(s
            .load_provider_pending_drops(&k.store_key())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn engine_rebase_preserves_boundary_views_and_invalidates_inner_cuts() {
        let mut state =
            transform::compaction::State::new("c".into(), transform::compaction::Preset::Worker);
        let original = transform::compaction::View {
            compaction_id: "c".into(),
            version: 1,
            range: transform::compaction::Range {
                lineage_id: "L".into(),
                from: 1,
                to: 4,
            },
            replacement: vec![ck_wire::CkWireMessage::synthetic_user_text("frozen")],
        };
        state.last_applied = Some(original.clone());
        state.last_produced = Some(original.clone());
        assert!(!state.descend("child", "L", 3).unwrap());
        assert_eq!(
            state.last_applied.as_ref().unwrap().replacement,
            original.replacement
        );
        assert_eq!(
            state.last_applied.as_ref().unwrap().range.lineage_id,
            "child"
        );
        assert!(state.descend("grandchild", "child", 2).unwrap());
        assert!(state.last_produced.is_none());
        assert!(state.descend("foreign", "unknown", 2).is_err());
    }

    #[test]
    fn fast_path_exhaustive_six_input_table_never_skips_an_opportunity() {
        for mask in 0u8..64 {
            let input = FastPathInputs {
                prefix_rebuilding: mask & 1 != 0,
                relevant_not_applied: mask & 2 != 0,
                execute_due: mask & 4 != 0,
                force_band: mask & 8 != 0,
                emergency: mask & 16 != 0,
                forced_work: mask & 32 != 0,
            };
            // Every nonzero row carries independent work or pressure. Skipping
            // is legal only for the one row with none, never grants permission.
            assert_eq!(
                can_skip_engine(input),
                mask == 0,
                "row {mask:06b}: {input:?}"
            );
        }
    }

    #[test]
    fn fast_path_never_skips_any_engine_hard_or_soft_classifier_trigger() {
        use mc_core::{ClassifierInput, PassPlan};
        let base = ClassifierInput {
            initialized: true,
            valid_m0m1_shape: true,
            boundary_present: true,
            ..Default::default()
        };
        assert!(transform::compaction::can_skip_classified(&base));
        let cases = [
            (
                "bootstrap",
                ClassifierInput {
                    initialized: false,
                    ..base.clone()
                },
            ),
            (
                "legacy migration",
                ClassifierInput {
                    is_legacy_baseline: true,
                    ..base.clone()
                },
            ),
            (
                "missing cached m1",
                ClassifierInput {
                    cached_m1_missing: true,
                    ..base.clone()
                },
            ),
            (
                "unknown shape",
                ClassifierInput {
                    valid_m0m1_shape: false,
                    ..base.clone()
                },
            ),
            (
                "render identity",
                ClassifierInput {
                    render_config_changed: true,
                    ..base.clone()
                },
            ),
            (
                "hard fold",
                ClassifierInput {
                    hard_fold_requested: true,
                    ..base.clone()
                },
            ),
            (
                "reconcile missing boundary",
                ClassifierInput {
                    reconcile_pending: true,
                    boundary_present: false,
                    ..base.clone()
                },
            ),
            (
                "soft m1 delta",
                ClassifierInput {
                    m1_revision_changed: true,
                    bust_opportunity: true,
                    ..base.clone()
                },
            ),
            (
                "soft reduction",
                ClassifierInput {
                    reductions_pending: true,
                    bust_opportunity: true,
                    ..base.clone()
                },
            ),
        ];
        for (name, input) in cases {
            assert_ne!(
                mc_core::classify(&input),
                PassPlan::Defer,
                "fixture must trigger: {name}"
            );
            assert!(
                !transform::compaction::can_skip_classified(&input),
                "unsafe skip: {name}"
            );
        }
        for cause in [
            "first publication",
            "reasoning repair",
            "protection snapshot",
            "boundary divergence",
            "idle expiry",
            "system absorption",
            "external memory revision",
            "project memory epoch",
        ] {
            let input = ClassifierInput {
                hard_fold_requested: true,
                ..base.clone()
            };
            assert!(
                !transform::compaction::can_skip_classified(&input),
                "unsafe hard-fold skip: {cause}"
            );
        }
    }

    fn real_state_trigger_comparison(cause: &str, expected_action: &str) {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
        let mut work = h.provider_work(&s, b, k).unwrap();
        let baseline = mc_store::StoredCompartment {
            sequence: 0,
            start_message: 1,
            end_message: 1,
            end_message_id: "m1#0".into(),
            title: "baseline".into(),
            content: "BASE".into(),
            p1: Some("BASE".into()),
            importance: 50,
            ..Default::default()
        };
        let delta = mc_store::StoredCompartment {
            sequence: 1,
            start_message: 2,
            end_message: 2,
            end_message_id: "m2#0".into(),
            title: "delta".into(),
            content: "DELTA".into(),
            p1: Some("DELTA".into()),
            importance: 50,
            ..Default::default()
        };
        if !matches!(cause, "bootstrap" | "first_publication") {
            let compartments = if cause == "reconcile" {
                vec![baseline.clone(), delta.clone()]
            } else {
                vec![baseline.clone()]
            };
            s.replace_compartments("s", &compartments).unwrap();
        }
        let mut req: TransformRequest = decode(&json!({"v":2,"kind":"transform","session_id":"s","serializer_profile":"opencode-aisdk","render_config":"real-trigger-proof","model_key":"fixture","messages":[],"tool_present":false,"auto_search_enabled":false,"usage":{"current_total_input_tokens":1000,"context_limit_tokens":100000}})).unwrap();
        let initial = [message(1), message(2), message(3)]
            .into_iter()
            .map(|v| serde_json::from_value(v).unwrap())
            .collect::<Vec<_>>();
        Codec::OpencodeAiSdk
            .prepare_request(&mut req, &initial)
            .unwrap();
        let mut params = step("probe", vec![], 3);
        let warm_time = {
            let mut ctx = producer_context(&work, "fixture", 100000, false);
            ctx.observed_last_response_at_ms = Some(ctx.now_ms);
            if cause != "bootstrap" {
                transform::transform_with_projection(&s, &req, &ctx).unwrap();
                assert_eq!(
                    transform::transform_with_projection(&s, &req, &ctx)
                        .unwrap()
                        .response
                        .action,
                    "SOFT+"
                );
                let status = status(&params, &Record::default()).unwrap();
                assert!(
                    can_skip_host_step(&s, &work, "s", "fixture", &status, false).unwrap(),
                    "clean baseline must be skip eligible: {cause}"
                );
            }
            ctx.now_ms
        };
        match cause {
            "bootstrap" => {}
            "legacy" | "unknown_shape" => {
                let mut loaded = s.load("s").unwrap();
                loaded.core.frozen_units = vec![mc_core::FrozenUnit {
                    key: if cause == "legacy" {
                        "baseline"
                    } else {
                        "unknown"
                    }
                    .into(),
                    kind: "synthesized-region".into(),
                    frozen_payload: "OLD".into(),
                    durability_class: mc_core::DurabilityClass::Lineage,
                    reset_rule: String::new(),
                }];
                loaded.core.pending_changes.clear();
                s.commit("s", loaded.row_version, &loaded.core, &loaded.meta)
                    .unwrap();
            }
            "cached_m1" => {
                let mut loaded = s.load("s").unwrap();
                loaded.core.frozen_units.retain(|u| u.key != "m1");
                s.commit("s", loaded.row_version, &loaded.core, &loaded.meta)
                    .unwrap();
            }
            "model" => {
                req.model_key = Some("changed-model".into());
            }
            "module_epoch" => {
                s.replace_compartments("s", &[baseline.clone(), delta.clone()])
                    .unwrap();
                let mut ctx = producer_context(&work, "fixture", 100000, false);
                ctx.observed_last_response_at_ms = Some(ctx.now_ms);
                req.usage.as_mut().unwrap().current_total_input_tokens = 75000;
                assert_eq!(
                    transform::transform_with_projection(&s, &req, &ctx)
                        .unwrap()
                        .response
                        .action,
                    "SOFT"
                );
                req.usage.as_mut().unwrap().current_total_input_tokens = 1000;
                assert_eq!(
                    transform::transform_with_projection(&s, &req, &ctx)
                        .unwrap()
                        .response
                        .action,
                    "SOFT+"
                );
                assert!(can_skip_host_step(
                    &s,
                    &work,
                    "s",
                    "fixture",
                    &status(&params, &Record::default()).unwrap(),
                    false
                )
                .unwrap());
                let mut stored = s.load_meta("s").unwrap();
                let current = format!("mre:4:mre{}", crate::MEMORY_RENDER_FORMAT_EPOCH);
                assert!(stored.meta.last_render_config.contains(&current));
                stored.meta.last_render_config = stored
                    .meta
                    .last_render_config
                    .replace(&current, "mre:4:mre2");
                s.commit_meta("s", stored.row_version, &stored.meta)
                    .unwrap();
            }
            "first_publication" => {
                s.replace_compartments("s", std::slice::from_ref(&baseline))
                    .unwrap();
            }
            "reconcile" => {
                let mut replacement = message(2);
                replacement["mid"] = json!("replacement");
                replacement["message"]["info"]["id"] = json!("replacement");
                let reverted = [message(1), replacement]
                    .into_iter()
                    .map(|v| serde_json::from_value(v).unwrap())
                    .collect::<Vec<_>>();
                Codec::OpencodeAiSdk
                    .prepare_request(&mut req, &reverted)
                    .unwrap();
                let mut ctx = producer_context(&work, "fixture", 100000, false);
                ctx.observed_last_response_at_ms = Some(ctx.now_ms);
                let revert = transform::transform_with_projection(&s, &req, &ctx).unwrap();
                assert_eq!(revert.response.action, "SOFT+");
                assert!(revert.response.reconcile_pending);
                s.replace_compartments("s", std::slice::from_ref(&baseline))
                    .unwrap();
                params["newest"]["ordinal"] = json!(2);
            }
            "soft_delta" | "force" | "emergency" => {
                s.replace_compartments("s", &[baseline.clone(), delta.clone()])
                    .unwrap();
                let tokens = match cause {
                    "force" => 85000,
                    "emergency" => 95000,
                    _ => 75000,
                };
                req.usage.as_mut().unwrap().current_total_input_tokens = tokens;
                params["estimate"]["request_tokens"] = json!(tokens);
            }
            "soft_reduction" => {
                s.append_pending_agent_drops("s", &["m2#0".into()], 1)
                    .unwrap();
                s.arm_soft_refresh("s").unwrap();
            }
            "flush" => {
                s.replace_compartments("s", &[baseline.clone(), delta.clone()])
                    .unwrap();
                s.arm_soft_refresh("s").unwrap();
            }
            "cold" => {
                params["prefix_rebuilding"] = json!({"reason":"expired_cache"});
            }
            "external_revision" => {
                let mut changed = baseline.clone();
                changed.content = "UPDATED".into();
                changed.p1 = Some("UPDATED".into());
                s.replace_compartments("s", &[changed]).unwrap();
            }
            "memory_epoch" => {
                s.set_project_memory_epoch_for_test(&work.project_path, 7)
                    .unwrap();
            }
            "protection" => {
                let mut loaded = s.load_meta("s").unwrap();
                loaded.meta.protected_tokens_effective = None;
                s.commit_meta("s", loaded.row_version, &loaded.meta)
                    .unwrap();
                crate::protection_window::pre_snapshot_inputs_changed(
                    s.tag_cache_namespace(),
                    "s",
                    0,
                    100000,
                );
                work.binding.config.protected_tokens_user = Some(4000);
            }
            _ => panic!("unknown real trigger: {cause}"),
        }
        let model = req.model_key.as_deref().unwrap();
        let status = status(&params, &Record::default()).unwrap();
        let row_version = s.load_meta("s").unwrap().row_version;
        let full_decodes = mc_store::cache_codec::full_decode_count();
        assert!(
            !can_skip_host_step(&s, &work, "s", model, &status, false).unwrap(),
            "preflight skipped a concrete {cause} trigger"
        );
        assert_eq!(
            s.load_meta("s").unwrap().row_version,
            row_version,
            "preflight must be read-only"
        );
        assert_eq!(
            mc_store::cache_codec::full_decode_count(),
            full_decodes,
            "preflight must not decode frozen chunks"
        );
        let mut ctx = producer_context(&work, model, 100000, false);
        ctx.observed_last_response_at_ms = Some(ctx.now_ms);
        if cause == "cold" {
            ctx.now_ms = warm_time + 300002;
            ctx.observed_last_response_at_ms = Some(warm_time + 1);
        }
        let result = transform::transform_with_projection(&s, &req, &ctx);
        if cause == "unknown_shape" {
            assert!(matches!(
                result,
                Err(transform::TransformError::UnknownShape(_))
            ));
            assert_eq!(s.load("s").unwrap().core.frozen_units[0].key, "unknown");
        } else {
            let engine = result.unwrap();
            if expected_action == "MUTATION" {
                assert!(
                    engine.response.prefix_bust_permitted,
                    "real {cause} must permit mutation"
                );
            } else {
                assert_eq!(
                    engine.response.action, expected_action,
                    "real engine {cause} result"
                );
            }
        }
    }

    #[test]
    fn real_state_trigger_bootstrap() {
        real_state_trigger_comparison("bootstrap", "HARD");
    }
    #[test]
    fn real_state_trigger_legacy_migration() {
        real_state_trigger_comparison("legacy", "HARD");
    }
    #[test]
    fn real_state_trigger_cached_m1_repair() {
        real_state_trigger_comparison("cached_m1", "HARD");
    }
    #[test]
    fn real_state_trigger_unknown_shape_refusal() {
        real_state_trigger_comparison("unknown_shape", "REJECT");
    }
    #[test]
    fn real_state_trigger_model_identity() {
        real_state_trigger_comparison("model", "HARD");
    }
    #[test]
    fn real_state_trigger_previous_module_epoch() {
        real_state_trigger_comparison("module_epoch", "HARD");
    }
    #[test]
    fn real_state_trigger_first_publication() {
        real_state_trigger_comparison("first_publication", "HARD");
    }
    #[test]
    fn real_state_trigger_reconcile_rematerialization() {
        real_state_trigger_comparison("reconcile", "HARD");
    }
    #[test]
    fn real_state_trigger_soft_m1_delta() {
        real_state_trigger_comparison("soft_delta", "SOFT");
    }
    #[test]
    fn real_state_trigger_soft_reduction() {
        real_state_trigger_comparison("soft_reduction", "SOFT");
    }
    #[test]
    fn real_state_trigger_durable_flush() {
        real_state_trigger_comparison("flush", "SOFT");
    }
    #[test]
    fn real_state_trigger_idle_expiry() {
        real_state_trigger_comparison("cold", "HARD");
    }
    #[test]
    fn real_state_trigger_external_revision() {
        real_state_trigger_comparison("external_revision", "HARD");
    }
    #[test]
    fn real_state_trigger_project_memory_epoch() {
        real_state_trigger_comparison("memory_epoch", "HARD");
    }
    #[test]
    fn real_state_trigger_protection_snapshot_survives_preflight() {
        real_state_trigger_comparison("protection", "HARD");
    }
    #[test]
    fn real_state_trigger_force_band() {
        real_state_trigger_comparison("force", "MUTATION");
    }
    #[test]
    fn real_state_trigger_emergency_band() {
        real_state_trigger_comparison("emergency", "MUTATION");
    }

    #[tokio::test]
    async fn fast_path_matches_full_engine_across_pressure_rebuild_rejection_and_flush() {
        for tokens in [1_000, 64_999, 65_000, 85_000, 95_000] {
            for prefix in [false, true] {
                for rejected in [false, true] {
                    for flush in [false, true] {
                        let dir = tempfile::tempdir().unwrap();
                        let (h, b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
                        answer(h.provider_setup(b.clone(), &setup()).await);
                        let mut boot = step("boot", vec![message(1), message(2)], 2);
                        boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
                        answer(h.provider_step(b.clone(), &boot).await);
                        let compartment = mc_store::StoredCompartment {
                            sequence: 0,
                            start_message: 1,
                            end_message: 1,
                            end_message_id: "m1#0".into(),
                            title: "history".into(),
                            content: "published".into(),
                            p1: Some("published".into()),
                            importance: 50,
                            ..Default::default()
                        };
                        s.replace_compartments("s", std::slice::from_ref(&compartment))
                            .unwrap();
                        if flush {
                            s.arm_soft_refresh("s").unwrap();
                        }
                        let work = h.provider_work(&s, b.clone(), k).unwrap();
                        let context = producer_context(&work, "fixture", 100000, false);
                        let facts =
                            transform::compaction::skip_facts(&s, "s", &context, "fixture", 100000)
                                .unwrap()
                                .unwrap();
                        let threshold = b
                            .config
                            .resolve_execute_threshold(Some("fixture"))
                            .percentage;
                        let skip = can_skip_engine(FastPathInputs {
                            prefix_rebuilding: prefix,
                            relevant_not_applied: rejected,
                            execute_due: tokens as f64 / 1000.0 >= threshold,
                            force_band: tokens >= 85000,
                            emergency: tokens >= 95000,
                            forced_work: flush,
                        }) && transform::compaction::can_skip_classified(&facts);
                        // The oracle is the real full-request entry point in an
                        // independently prepared store, not the host wrapper.
                        let oracle_dir = tempfile::tempdir().unwrap();
                        let (oh, ob, os, ok) =
                            handler(oracle_dir.path(), Arc::new(NoReads::default()));
                        let ow = oh.provider_work(&os, ob, ok).unwrap();
                        let mut req: TransformRequest = decode(&json!({"v":2,"kind":"transform","session_id":"s","serializer_profile":"opencode-aisdk","render_config":"full-request-oracle","model_key":"fixture","messages":[],"tool_present":false,"auto_search_enabled":false,"usage":{"current_total_input_tokens":1000,"context_limit_tokens":100000}})).unwrap();
                        let entries = [message(1), message(2)]
                            .into_iter()
                            .map(|v| serde_json::from_value(v).unwrap())
                            .collect::<Vec<_>>();
                        Codec::OpencodeAiSdk
                            .prepare_request(&mut req, &entries)
                            .unwrap();
                        let mut ctx = producer_context(&ow, "fixture", 100000, false);
                        ctx.observed_last_response_at_ms = Some(ctx.now_ms);
                        transform::transform_with_projection(&os, &req, &ctx).unwrap();
                        os.replace_compartments("s", &[compartment]).unwrap();
                        if flush {
                            os.arm_soft_refresh("s").unwrap();
                        }
                        if prefix {
                            ctx.now_ms += 300_002;
                            ctx.observed_last_response_at_ms = Some(ctx.now_ms - 300_001);
                        }
                        req.usage.as_mut().unwrap().current_total_input_tokens = tokens;
                        let full = transform::transform_with_projection(&os, &req, &ctx).unwrap();
                        assert!(!(skip && full.response.prefix_bust_permitted),"unsafe skip: tokens={tokens}, prefix={prefix}, rejected={rejected}, flush={flush}");
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn setup_is_nonmutating_on_full_request_state_and_never_reads_a_host() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(NoReads::default());
        let (h, b, s, k) = handler(dir.path(), runner.clone());
        let mut seeded = s.load("s").unwrap();
        seeded.core.boundary_id = "existing".into();
        seeded.meta.initialized = true;
        s.commit("s", seeded.row_version, &seeded.core, &seeded.meta)
            .unwrap();
        let before = s.load_meta("s").unwrap();
        let ready = answer(h.provider_setup(b.clone(), &setup()).await);
        assert_eq!(ready["initial"]["range"], json!({"from":0,"to":0}));
        assert_eq!(ready["initial"]["replacement"].as_array().unwrap().len(), 2);
        assert_eq!(s.load_meta("s").unwrap().row_version, before.row_version);
        assert_eq!(runner.0.load(Ordering::SeqCst), 0);
        let c = s
            .load_provider_conversation(&k.store_key())
            .unwrap()
            .unwrap();
        assert_eq!(c.engine_namespace, "s");
        let repeat = answer(h.provider_setup(b, &setup()).await);
        assert!(
            repeat["initial"]["version"].as_u64().unwrap()
                > ready["initial"]["version"].as_u64().unwrap()
        );
        assert_eq!(
            repeat["initial"]["replacement"],
            ready["initial"]["replacement"]
        );
        assert_eq!(s.load_meta("s").unwrap().row_version, before.row_version);
    }

    #[tokio::test]
    async fn host_engine_runs_and_saves_only_in_the_conversation_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
        // Declaration normally initializes this row. Setup must preserve the
        // existing namespace instead of substituting the Broca key hash.
        s.save_provider_conversation(
            &k.store_key(),
            &ProviderConversation {
                engine_namespace: b.session.clone(),
                params_json: setup()["params"].to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        answer(h.provider_setup(b.clone(), &setup()).await);
        let mut page = step("bootstrap", vec![message(1)], 1);
        page["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        assert_eq!(
            answer(h.provider_step(b.clone(), &page).await)["answer"],
            "compaction_message"
        );
        let meta = s.load_meta(&b.session).unwrap();
        assert!(meta.row_version.is_some());
        assert!(meta.meta.initialized);
        assert_eq!(meta.meta.last_model_key, "fixture");
        assert!(s.load_meta(&k.engine_key()).unwrap().row_version.is_none());
        assert_eq!(
            s.load_provider_conversation(&k.store_key())
                .unwrap()
                .unwrap()
                .engine_namespace,
            b.session
        );
    }

    #[tokio::test]
    async fn pipeline_switch_keeps_observed_provider_and_system_identity() {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
        let work = h.provider_work(&s, b.clone(), k.clone()).unwrap();
        let mut req: TransformRequest = decode(&json!({"v":2,"kind":"transform","session_id":"s","serializer_profile":"opencode-aisdk","render_config":"old-full-request","model_key":"fixture","provider_id":"provider","system_prompt_hash":"system","upgrade_state":"upgrade","messages":[],"tool_present":false,"auto_search_enabled":false,"usage":{"current_total_input_tokens":1000,"context_limit_tokens":100000}})).unwrap();
        let entries = [message(1), message(2)]
            .into_iter()
            .map(|v| serde_json::from_value(v).unwrap())
            .collect::<Vec<_>>();
        Codec::OpencodeAiSdk
            .prepare_request(&mut req, &entries)
            .unwrap();
        let mut ctx = producer_context(&work, "fixture", 100000, false);
        ctx.observed_last_response_at_ms = Some(ctx.now_ms);
        transform::transform_with_projection(&s, &req, &ctx).unwrap();
        let old = transform::transform_with_projection(&s, &req, &ctx).unwrap();
        assert_eq!(old.response.action, "SOFT+");
        let expected = Codec::OpencodeAiSdk
            .encode_view(
                &transform::compaction::View {
                    compaction_id: "old".into(),
                    version: 1,
                    range: transform::compaction::Range {
                        lineage_id: "L".into(),
                        from: 1,
                        to: 3,
                    },
                    replacement: old
                        .response
                        .ck_messages
                        .as_ref()
                        .unwrap()
                        .iter()
                        .map(|m| (**m).clone())
                        .collect(),
                },
                &req,
                &super::super::codec_opencode::NativeRenderContext::from(&old),
            )
            .unwrap();
        answer(h.provider_setup(b.clone(), &setup()).await);
        let mut page = step("switch", vec![message(1), message(2)], 2);
        page["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let actual = answer(h.provider_step(b, &page).await);
        assert_eq!(
            actual["compaction"]["replacement"],
            json!(expected.replacement)
        );
        let meta = s.load_meta("s").unwrap().meta;
        assert_eq!(meta.last_provider_id, "provider");
        assert_eq!(meta.last_system_prompt_hash, "system");
        let setup: HostSetup = serde_json::from_str(
            s.load_provider_conversation(&k.store_key())
                .unwrap()
                .unwrap()
                .setup_json
                .as_ref()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(setup.setup.state.rebuild_epoch, 0);
    }

    #[tokio::test]
    async fn no_exact_hook_plan_late_hard_and_soft_temporal_views_match_full_engine() {
        for hard in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let (h, b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
            let oracle_dir = tempfile::tempdir().unwrap();
            let (oh, ob, os, ok) = handler(oracle_dir.path(), Arc::new(NoReads::default()));
            let ow = oh.provider_work(&os, ob, ok).unwrap();
            let timed = |ordinal: u64, role: &str, created: i64, completed: Option<i64>| {
                let mut entry = message(ordinal);
                entry["message"]["info"]["role"] = json!(role);
                entry["message"]["info"]["time"]["created"] = json!(created);
                if let Some(completed) = completed {
                    entry["message"]["info"]["time"]["completed"] = json!(completed);
                }
                entry
            };
            let entries = vec![
                timed(1, "user", 1000, None),
                timed(2, "assistant", 2000, Some(3000)),
                timed(3, "user", 7_203_000, None),
                timed(4, "assistant", 7_204_000, Some(7_205_000)),
                timed(5, "user", 10_805_000, None),
            ];
            let baseline = mc_store::StoredCompartment {
                sequence: 0,
                start_message: 1,
                end_message: 1,
                end_message_id: "m1#0".into(),
                title: "baseline".into(),
                content: "baseline history".into(),
                p1: Some("baseline history".into()),
                importance: 50,
                ..Default::default()
            };
            let delta = mc_store::StoredCompartment {
                sequence: 1,
                start_message: 2,
                end_message: 2,
                end_message_id: "m2#0".into(),
                title: "delta".into(),
                content: "delta history".into(),
                p1: Some("delta history".into()),
                importance: 50,
                ..Default::default()
            };
            for store in [&s, &os] {
                store
                    .replace_compartments("s", std::slice::from_ref(&baseline))
                    .unwrap();
            }
            answer(h.provider_setup(b.clone(), &setup()).await);
            let l = ProviderLineage {
                lineage_id: "L".into(),
                first_ordinal: 1,
                descends_from: None,
                through_ordinal: None,
            };
            for entry in &entries[..2] {
                let hook = if entry["message"]["info"]["role"] == "user" {
                    "pre_user"
                } else {
                    "post_assistant"
                };
                hook_answer(&s, &k, &l, entry, hook, ("", json!([]), &[0]));
            }
            let mut boot = step("boot", vec![], 2);
            boot["served_through_ordinal"] = json!(2);
            boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
            let first = answer(h.provider_step(b.clone(), &boot).await);
            let mut req: TransformRequest = decode(&json!({"v":2,"kind":"transform","session_id":"s","serializer_profile":"opencode-aisdk","render_config":"temporal-oracle","model_key":"fixture","messages":[],"tool_present":true,"auto_search_enabled":false,"usage":{"current_total_input_tokens":1000,"context_limit_tokens":100000}})).unwrap();
            let decode_entries = |entries: &[Value]| {
                entries
                    .iter()
                    .cloned()
                    .map(|v| serde_json::from_value(v).unwrap())
                    .collect::<Vec<compact::status::StatusMessage>>()
            };
            Codec::OpencodeAiSdk
                .prepare_request(&mut req, &decode_entries(&entries[..2]))
                .unwrap();
            let mut ctx = producer_context(&ow, "fixture", 100000, false);
            ctx.observed_last_response_at_ms = Some(ctx.now_ms);
            transform::transform_with_projection(&os, &req, &ctx).unwrap();
            // Hook-time metadata is not an exact engine plan. The fallback must
            // leave every new idle-gap candidate unmarked on the served clone.
            let exact_plan: Option<mc_core::PassPlan> = None;
            assert!(!exact_plan
                .as_ref()
                .is_some_and(|p| transform::pass_plan_permits_prefix_mutation(p, false)));
            for entry in &entries[2..] {
                let hook = if entry["message"]["info"]["role"] == "user" {
                    "pre_user"
                } else {
                    "post_assistant"
                };
                hook_answer(&s, &k, &l, entry, hook, ("", json!([]), &[0]));
            }
            let mut defer = step("defer", vec![], 5);
            defer["served_through_ordinal"] = json!(5);
            defer["last_applied"] = first["compaction"].clone();
            assert_eq!(
                answer(h.provider_step(b.clone(), &defer).await)["answer"],
                "noop"
            );
            Codec::OpencodeAiSdk
                .prepare_request(&mut req, &decode_entries(&entries))
                .unwrap();
            let held = transform::transform_with_projection(&os, &req, &ctx).unwrap();
            assert_eq!(held.response.action, "SOFT+");
            assert!(!held
                .response
                .ck_messages
                .as_ref()
                .unwrap()
                .iter()
                .any(|m| serde_json::to_string(m).unwrap().contains("<!-- +")));
            assert!(s
                .load_provider_hook_answers(&k.store_key())
                .unwrap()
                .iter()
                .all(|a| a.answer.ops_json == "[]"));
            assert!(!s
                .load_temporal_marks("s")
                .unwrap()
                .iter()
                .any(|m| !m.marker_text.is_empty()));
            for store in [&s, &os] {
                store
                    .replace_compartments("s", &[baseline.clone(), delta.clone()])
                    .unwrap();
            }
            let mut rebuild = step("rebuild", vec![], 5);
            rebuild["served_through_ordinal"] = json!(5);
            if hard {
                rebuild["prefix_rebuilding"] = json!({"reason":"expired_cache"});
                ctx.now_ms += 300_002;
                ctx.observed_last_response_at_ms = Some(ctx.now_ms - 300_001);
            } else {
                rebuild["estimate"]["request_tokens"] = json!(75000);
                req.usage.as_mut().unwrap().current_total_input_tokens = 75000;
            }
            let old = transform::transform_with_projection(&os, &req, &ctx).unwrap();
            assert_eq!(old.response.action, if hard { "HARD" } else { "SOFT" });
            let expected = Codec::OpencodeAiSdk
                .encode_view(
                    &transform::compaction::View {
                        compaction_id: "oracle".into(),
                        version: 1,
                        range: transform::compaction::Range {
                            lineage_id: "L".into(),
                            from: 1,
                            to: 6,
                        },
                        replacement: old
                            .response
                            .ck_messages
                            .as_ref()
                            .unwrap()
                            .iter()
                            .map(|m| (**m).clone())
                            .collect(),
                    },
                    &req,
                    &super::super::codec_opencode::NativeRenderContext::from(&old),
                )
                .unwrap();
            let actual = answer(h.provider_step(b, &rebuild).await);
            assert_eq!(actual["answer"], "compaction_message");
            assert_eq!(actual["compaction"]["range"]["to"], 6);
            assert_eq!(
                actual["compaction"]["replacement"],
                json!(expected.replacement),
                "late {} temporal overlay differs",
                if hard { "HARD" } else { "SOFT" }
            );
            let bytes = actual["compaction"]["replacement"].to_string();
            assert_eq!(bytes.matches("<!-- +2h -->").count(), 1);
            assert_eq!(bytes.matches("<!-- +1h -->").count(), 1);
            assert_eq!(
                s.load_tags_for_session("s").unwrap().len(),
                5,
                "view rendering must not mint extra tags"
            );
        }
    }

    #[tokio::test]
    async fn host_cold_signal_folds_below_threshold_without_changing_setup_or_broca_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let (h, mut b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
        b.config.cache_ttl = "10m".into();
        let mut request = setup();
        request["params"]["cache_ttl"] = json!("10m");
        answer(h.provider_setup(b.clone(), &request).await);
        let mut bootstrap = step("bootstrap", vec![message(1), message(2)], 2);
        bootstrap["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(b.clone(), &bootstrap).await);
        s.replace_compartments(
            "s",
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 1,
                end_message_id: "m1#0".into(),
                title: "history".into(),
                content: "idle fold".into(),
                p1: Some("idle fold".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
        let mut cold = step("cold", vec![], 2);
        cold["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
        cold["prefix_rebuilding"] = json!({"reason":"expired_cache"});
        let folded = answer(h.provider_step(b.clone(), &cold).await);
        assert_eq!(folded["answer"], "compaction_message");
        assert!(folded["compaction"]["replacement"]
            .to_string()
            .contains("idle fold"));
        assert_eq!(s.load_meta("s").unwrap().meta.folded_compartment_seq, 1);
        let saved: HostSetup = serde_json::from_str(
            s.load_provider_conversation(&k.store_key())
                .unwrap()
                .unwrap()
                .setup_json
                .as_ref()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(saved.setup.request.params["cache_ttl"], "10m");
        let work = h.provider_work(&s, b, k).unwrap();
        // Transport-specific execution overrides internal TTL scheduling, not
        // the configured policy returned by the common context builder.
        assert_eq!(
            producer_context(&work, "fixture", 100000, false).cache_ttl,
            "10m"
        );
    }

    #[tokio::test]
    async fn host_setup_requires_both_opt_ins_and_refuses_runner_spoofing() {
        let dir = tempfile::tempdir().unwrap();
        let (h, host_binding, _, _) = handler(dir.path(), Arc::new(NoReads::default()));
        let mut b = host_binding.clone();
        b.harness = "runner".into();
        assert_eq!(
            field(h.provider_setup(b.clone(), &setup()).await),
            "params.observation"
        );
        let mut profile = setup();
        profile["params"]
            .as_object_mut()
            .unwrap()
            .remove("observation");
        assert_eq!(
            field(h.provider_setup(b, &profile).await),
            "params.serializer_profile"
        );
        let b = host_binding;
        assert_eq!(
            field(h.provider_setup(b.clone(), &profile).await),
            "params.observation"
        );
        let mut foreign = setup();
        foreign["session"] = json!("other");
        assert_eq!(field(h.provider_setup(b, &foreign).await), "session");
    }

    #[tokio::test]
    async fn paged_bootstrap_wait_releases_lock_and_final_gap_names_first_missing() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(NoReads::default());
        let (h, b, s, k) = handler(dir.path(), runner.clone());
        answer(h.provider_setup(b.clone(), &setup()).await);
        let mut page = step("page1", vec![message(4000)], 4002);
        page["more"] = json!(true);
        assert_eq!(
            answer(h.provider_step(b.clone(), &page).await)["answer"],
            "wait"
        );
        tokio::task::yield_now().await;
        let final_gap = step("page2", vec![message(4002)], 4002);
        let refused = tokio::time::timeout(
            Duration::from_millis(250),
            h.provider_step(b.clone(), &final_gap),
        )
        .await
        .expect("next host page must not wait for background scan lock");
        let refused = answer(refused);
        assert_eq!(refused["code"], "history_unreadable");
        assert_eq!(refused["detail"], json!({"history_gap_from":4001}));
        let mut final_page = step("page3", vec![message(4001), message(4002)], 4002);
        final_page["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(b, &final_page).await);
        assert_eq!(view["answer"], "compaction_message");
        assert_eq!(view["compaction"]["range"], json!({"from":4000,"to":4003}));
        assert_eq!(s.provider_frontier(&k.store_key(), "L").unwrap(), 4003);
        assert_eq!(runner.0.load(Ordering::SeqCst), 0);
        assert!(s
            .load_provider_conversation(&k.store_key())
            .unwrap()
            .unwrap()
            .wait_request
            .is_none());
    }

    #[tokio::test]
    async fn step_gaps_use_held_history_not_the_claimed_status_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, _, _) = handler(dir.path(), Arc::new(NoReads::default()));
        answer(h.provider_setup(b.clone(), &setup()).await);
        // Only an intermediate page admits a partial transcript. The refused
        // final page below must not be used as a source of held bytes.
        let mut partial = step("partial", vec![message(10), message(12)], 12);
        partial["more"] = json!(true);
        assert_eq!(
            answer(h.provider_step(b.clone(), &partial).await)["answer"],
            "wait"
        );
        let page = step("first", vec![message(10), message(12)], 12);
        assert_eq!(
            answer(h.provider_step(b.clone(), &page).await)["detail"]["history_gap_from"],
            11
        );
        let mut empty = step("empty", vec![], 12);
        empty["after_ordinal"] = json!(12);
        assert_eq!(
            answer(h.provider_step(b, &empty).await)["detail"]["history_gap_from"],
            11
        );
    }

    #[tokio::test]
    async fn conflicting_status_refuses_messages_before_promotion_or_burn() {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, k) = handler(dir.path(), Arc::new(NoReads::default()));
        answer(h.provider_setup(b.clone(), &setup()).await);
        let l = ProviderLineage {
            lineage_id: "L".into(),
            first_ordinal: 1,
            descends_from: None,
            through_ordinal: None,
        };
        let native = message(1);
        let m = ProviderMessage {
            ordinal: 1,
            mid: "m1".into(),
            message_bytes: serde_json::to_vec(&native["message"]).unwrap(),
        };
        let subject = ProviderSubject {
            subject_mid: "m1".into(),
            hook: "pre_user".into(),
            subject_part: "".into(),
        };
        s.commit_provider_hook(
            &k.store_key(),
            mc_store::provider_records::ProviderHookRequest {
                lineage: &l,
                message: Some(&m),
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: None,
            },
            |ctx| {
                Ok((
                    mc_store::provider_records::ProviderHookWrite {
                        answer: Some(mc_store::provider_records::ProviderHookAnswer {
                            subject: subject.clone(),
                            ordinal: 1,
                            ops_json: "[]".into(),
                            tags: vec![],
                        }),
                        counters: ctx.counters.clone(),
                        policy_summary: None,
                    },
                    (),
                ))
            },
        )
        .unwrap();
        let mut conflict = step("conflict", vec![native], 1);
        conflict["messages"][0]["message"]["parts"][0]["text"] = json!("changed");
        conflict["served_through_ordinal"] = json!(1);
        conflict["unserved_subjects"] = json!([{"subject_mid":"m1","hook":"pre_user"}]);
        assert_eq!(field(h.provider_step(b, &conflict).await), "messages");
        assert_eq!(
            s.load_provider_hook_answers(&k.store_key()).unwrap()[0].state,
            "pending"
        );
    }

    #[tokio::test]
    async fn descent_keeps_view_at_boundary_and_rebuilds_when_cut_inside() {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, _, _) = handler(dir.path(), Arc::new(NoReads::default()));
        answer(h.provider_setup(b.clone(), &setup()).await);
        let mut first = step("first", vec![message(1), message(2), message(3)], 3);
        first["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = answer(h.provider_step(b.clone(), &first).await);
        let version = view["compaction"]["version"].clone();
        let mut descend = step("descend", vec![message(4)], 4);
        descend["lineage_id"] = json!("child");
        descend["descends_from"] = json!({"lineage_id":"L","through_ordinal":3});
        descend["last_applied"] =
            json!({"compaction_id":view["compaction"]["compaction_id"],"version":version});
        assert_eq!(
            answer(h.provider_step(b.clone(), &descend).await)["answer"],
            "noop"
        );
        let mut inside = step("inside", vec![], 2);
        inside["lineage_id"] = json!("grandchild");
        inside["descends_from"] = json!({"lineage_id":"child","through_ordinal":2});
        let rebuilt = answer(h.provider_step(b.clone(), &inside).await);
        assert_eq!(rebuilt["answer"], "compaction_message");
        assert_eq!(rebuilt["compaction"]["range"]["to"], 3);
        assert!(!rebuilt["compaction"]["replacement"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m.pointer("/info/id") == Some(&json!("m3"))));
        let mut foreign = step("foreign", vec![], 2);
        foreign["lineage_id"] = json!("foreign");
        assert_eq!(
            field(h.provider_step(b.clone(), &foreign).await),
            "lineage_id"
        );
        foreign["descends_from"] = json!({"lineage_id":"grandchild","through_ordinal":8});
        assert_eq!(
            answer(h.provider_step(b, &foreign).await)["detail"]["history_gap_from"],
            3
        );
    }
}

#[cfg(test)]
mod terminal_refusal_tests {
    use super::*;
    use crate::providers::claude_code_tests as cc;

    struct ClearInjection;
    impl Drop for ClearInjection {
        fn drop(&mut self) {
            CC_ENGINE_REFUSAL.with(|flag| flag.set(false));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn protected_tail_refusal_precedes_outage_pass_and_never_publishes_a_view() {
        let dir = tempfile::tempdir().unwrap();
        let h = cc::handler(dir.path(), cc::thalamus());
        cc::setup(&h).await;
        let declaration=declaration(&json!({"params":{"serializer_profile":"claude-code-anthropic","observation":"answer"}})).unwrap();
        assert!(declaration
            .subscriptions
            .iter()
            .all(|s| s.on_unavailable == Some(hooks::subscription::OnUnavailable::Pass)));
        let mut status = cc::step(r#"{"role":"user","content":"tail"}"#);
        status["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let _clear = ClearInjection;
        for request_id in ["lost-answer", "fresh-answer"] {
            status["request_id"] = json!(request_id);
            CC_ENGINE_REFUSAL.with(|flag| flag.set(true));
            let HandlerOutcome::Response(bytes) =
                cc::call(&h, "compaction.step", status.clone()).await
            else {
                panic!("typed engine refusal became an outage")
            };
            assert!(
                !CC_ENGINE_REFUSAL.with(|flag| flag.get()),
                "actual engine-return boundary was not reached"
            );
            let answer: compact::answer::StepAnswer = serde_json::from_slice(&bytes).unwrap();
            let compact::answer::StepAnswer::Refuse {
                request_id: echoed,
                code,
                reason,
                provider_code,
                ..
            } = answer
            else {
                panic!("refusal was swallowed by pass/fallback")
            };
            assert_eq!(echoed, request_id);
            assert_eq!(code, compact::errors::RefuseCode::WindowTooSmall);
            assert!(!code.retryable());
            assert_eq!(
                provider_code.as_deref(),
                Some("protected_tool_results_over_limit")
            );
            assert_eq!(reason,"The tool results kept by protected_tools are larger than this model's context window, so this turn was not sent. Lower the protected_tools counts.");
        }
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        assert!(store
            .load_provider_view(&key.store_key(), 2)
            .unwrap()
            .is_none());
        assert!(store
            .load_provider_view(&key.store_key(), 3)
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .load_provider_messages(&key.store_key(), "L")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn unrelated_engine_errors_remain_transient_not_terminal_refusals() {
        assert!(
            matches!(claude_code_engine_failure(transform::TransformError::AssistantTerminalRetry,"r"),HandlerOutcome::Error { code,.. } if code=="transient")
        );
    }
}

fn coverage_replay_matches(codec: Codec, previous: Option<u64>, current: Option<u64>) -> bool {
    codec != Codec::ClaudeCodeAnthropic || previous == current
}

#[cfg(test)]
mod native_replay_tests {
    use super::*;
    #[test]
    fn native_coverage_replay_requires_the_current_boundary_ordinal() {
        assert!(!coverage_replay_matches(
            Codec::ClaudeCodeAnthropic,
            Some(2),
            None
        ));
        assert!(!coverage_replay_matches(
            Codec::ClaudeCodeAnthropic,
            Some(2),
            Some(3)
        ));
        assert!(coverage_replay_matches(
            Codec::ClaudeCodeAnthropic,
            Some(2),
            Some(2)
        ));
        assert!(coverage_replay_matches(
            Codec::ClaudeCodeAnthropic,
            None,
            None
        ));
        assert!(coverage_replay_matches(Codec::OpencodeAiSdk, Some(2), None));
    }
}
