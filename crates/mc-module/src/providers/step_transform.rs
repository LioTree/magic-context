//! Pure declarations, write-time hooks and runner-bound reduction tools.
use super::*;
use mc_store::provider_records::{
    ProviderAnswerTag, ProviderHookAnswer, ProviderHookRequest, ProviderHookWrite, ProviderLineage,
    ProviderMessage, ProviderPolicyPart, ProviderPolicyTotals, ProviderSubject,
};
use serde::Deserialize;

pub(super) const CHANNEL1_NOTE: &str = "mc:channel1";

#[cfg(test)]
#[path = "step_transform_parity_tests.rs"]
mod parity_tests;
#[cfg(test)]
#[path = "step_transform_review_tests.rs"]
mod review_tests;

#[derive(Deserialize, Default)]
struct HostHookFields {
    subject_mid: Option<String>,
    subject_ordinal: Option<u64>,
    message: Option<Value>,
    subject_part: Option<String>,
    served_through_ordinal: Option<u64>,
    #[serde(default)]
    unserved_subjects: Vec<HostSubject>,
    descends_from: Option<HostDescent>,
    pass_complete: Option<bool>,
}
#[derive(Deserialize)]
struct HostDescent {
    lineage_id: String,
    through_ordinal: u64,
}
#[derive(Deserialize)]
struct HostSubject {
    subject_mid: String,
    hook: String,
    subject_part: Option<String>,
}

#[derive(Deserialize)]
struct ProviderPassInput {
    pass_id: Option<String>,
    ordered_ids: Option<Vec<String>>,
    lineage_id: String,
    descends_from: Option<HostDescent>,
    appended: Vec<compact::status::StatusMessage>,
    physical_tail: Option<ProviderTail>,
    exact_pass_plan: Option<String>,
    marker_hard_serves_frozen_prefix: Option<bool>,
    /// Usage, context geometry and historian model budgets synchronized before
    /// per-message transform hooks. This field never carries transcript content.
    historian_inputs: Option<Value>,
}
#[derive(Deserialize, Serialize)]
struct ProviderTail {
    mid: String,
    ordinal: u64,
}

/// An exact plan is scoped to the subjects synchronized for that pass. Retained
/// context must not authorize a later, unsynchronized message in the lineage.
fn exact_plan_for_subject(counters: &Value, lineage: &str, mid: &str) -> Option<mc_core::PassPlan> {
    let pass = counters.get("pass_context")?;
    if pass.get("lineage_id").and_then(Value::as_str) != Some(lineage)
        || !pass
            .get("appended_ids")
            .and_then(Value::as_array)?
            .iter()
            .any(|id| id.as_str() == Some(mid))
    {
        return None;
    }
    match pass.get("exact_pass_plan").and_then(Value::as_str) {
        Some("hard") => Some(mc_core::PassPlan::Hard),
        Some("migrate_hard") => Some(mc_core::PassPlan::MigrateHard),
        Some("soft") => Some(mc_core::PassPlan::Soft),
        Some("defer") => Some(mc_core::PassPlan::Defer),
        _ => None,
    }
}

fn provider_policy_error(error: mc_store::provider_records::ProviderError) -> HandlerOutcome {
    match error {
        mc_store::provider_records::ProviderError::Transient(ref reason)
            if reason == "an ingested ordinal changed" =>
        {
            invalid_field("message", "provider subject changed its admitted bytes")
        }
        mc_store::provider_records::ProviderError::InvalidParams { field } => {
            invalid_field(field, "conflicting provider policy")
        }
        error => transient(error),
    }
}

fn admission_policy_parts(
    req: &TransformRequest,
    projection: &ck_wire::FlatProjection,
) -> Vec<ProviderPolicyPart> {
    let tags = projection
        .blocks
        .iter()
        .filter_map(|b| {
            transform::taggable_source(b).map(|(kind, source)| McTagRow {
                tag_number: b.block_index as i64 + 1,
                block_id: b.id.clone(),
                kind: kind.as_store_kind().into(),
                token_count: mc_tokenizer::estimate_tokens(&source) as i64,
                created_at_ms: 0,
                source_bytes: Arc::from([]),
            })
        })
        .collect::<Vec<_>>();
    let empty = crate::protection_window::ProtectionWindow::from_persisted_rows(&[], 0);
    let measured = crate::tail_hygiene::measure_tail_hygiene_with_pending_drops(
        projection,
        &Default::default(),
        None,
        &tags,
        &empty.tag_numbers,
        &Default::default(),
        &Default::default(),
    );
    let mut parts = transform::capture_provider_parts(
        req,
        projection,
        &Default::default(),
        &measured.parts,
        &tags,
        false,
    );
    for part in &mut parts {
        part.tag_number = None;
    }
    parts
}

fn checked_part(part: Option<&str>) -> Result<&str, HandlerOutcome> {
    if part.is_some_and(|part| part.is_empty() || part.len() > 256) {
        return Err(invalid_field(
            "subject_part",
            "subject_part must be non-empty and at most 256 bytes",
        ));
    }
    Ok(part.unwrap_or(""))
}

fn host_channel1(
    inputs: &transform::Channel1PolicyInputs,
    state: &Value,
) -> (Vec<hooks::answer::Operation>, Value) {
    let mut meta = channel1_meta(state);
    meta.channel1_reduce_suppressed = state
        .get("reduce_pending")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    meta.tail_hygiene_baseline = Some(inputs.baseline.clone());
    let mut current = Some(inputs.baseline.clone());
    transform::apply_channel1_compliance_grace(&mut meta, &mut current, false);
    let before = (
        meta.channel1_last_nudge_undropped,
        meta.channel1_last_nudge_level.clone(),
    );
    let decision = transform::decide_channel1(current.as_ref(), &meta, inputs.users);
    let mut ops = Vec::new();
    let fire = decision.fire && inputs.carrier;
    if fire {
        let text = transform::commit_channel1_fire(
            &decision,
            &mut meta,
            inputs.users,
            inputs.tool_outputs,
            &inputs.hint,
        );
        ops.push(hooks::answer::Operation::Append {
            block: 0,
            text,
            note: None,
        });
    } else if !decision.fire {
        transform::apply_channel1_decision_state(&mut meta, &decision);
    }
    let changed = before
        != (
            meta.channel1_last_nudge_undropped,
            meta.channel1_last_nudge_level.clone(),
        );
    (
        ops,
        json!({"reduce_pending":meta.channel1_reduce_suppressed,"grace_u":meta.tail_hygiene_baseline.as_ref().and_then(|b|b.channel1_post_reduce_grace_baseline_u),"grace_level":meta.tail_hygiene_baseline.as_ref().map(|b|&b.channel1_post_reduce_grace_pre_level),"cadence_event":if fire || changed {Some(json!({"fire":fire,"nudge":meta.channel1_last_nudge_undropped,"level":meta.channel1_last_nudge_level,"users":inputs.users}))} else {None},
        "channel1":{"channel1_last_nudge_undropped":meta.channel1_last_nudge_undropped,"channel1_last_nudge_level":meta.channel1_last_nudge_level,"channel1_last_fire_level":meta.channel1_last_fire_level,"channel1_last_fire_ordinal":meta.channel1_last_fire_ordinal}}),
    )
}

fn channel1_meta(state: &Value) -> mc_store::ModuleMeta {
    let state = &state["channel1"];
    mc_store::ModuleMeta {
        channel1_last_nudge_undropped: state
            .get("channel1_last_nudge_undropped")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        channel1_last_nudge_level: state
            .get("channel1_last_nudge_level")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        channel1_last_fire_level: state
            .get("channel1_last_fire_level")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        channel1_last_fire_ordinal: state
            .get("channel1_last_fire_ordinal")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        ..Default::default()
    }
}

pub fn declaration(params: &Value) -> Result<hooks::subscription::Declaration, HandlerOutcome> {
    use hooks::subscription::{Declaration, DeclaredSubscription as Sub, Hook, OnUnavailable, Op};
    let request: hooks::subscription::DeclareRequest = decode(params)?;
    preset(request.preset.as_deref())?;
    let host = answer_observation(&Value::Object(request.params.clone()));
    // These edits optimise a single new subject. Broca freezes unavailable
    // outcomes too, so a missed tag, strip or reminder must pass through rather
    // than fail the user's turn; any still-due append targets a later subject.
    let mut subscriptions = vec![
        Sub::new(
            Hook::PreUser,
            if host {
                vec![Op::Prepend, Op::Append]
            } else {
                vec![Op::Append]
            },
            HOOK_BUDGET_MS,
        )
        .with_on_unavailable(OnUnavailable::Pass),
        Sub::new(
            Hook::PostTool,
            vec![Op::Prepend, Op::Append],
            HOOK_BUDGET_MS,
        )
        .with_on_unavailable(OnUnavailable::Pass),
    ];
    let reduction_owner = request.composition.is_none()
        || request
            .composition
            .as_ref()
            .and_then(|c| c.get("compaction"))
            .and_then(|c| c.get("provider"))
            .and_then(Value::as_str)
            == Some(DEFAULT_MODULE_ID);
    if reduction_owner {
        subscriptions.push(
            Sub::new(
                Hook::PostAssistant,
                if host {
                    vec![Op::Prepend, Op::Replace]
                } else {
                    vec![Op::Replace]
                },
                HOOK_BUDGET_MS,
            )
            .with_on_unavailable(OnUnavailable::Pass),
        );
    }
    #[cfg(feature = "advertise-claude-code-candidate")]
    let claude_code = match request.claude_code.as_ref() {
        Some(selection) if selection == &*super::capability_candidate::CANDIDATE => {
            Some(super::capability_candidate::CANDIDATE.clone())
        }
        Some(_) => {
            return Err(invalid_field(
                "claude_code",
                "declaration requires the exact advertised candidate",
            ));
        }
        None => None,
    };
    #[cfg(not(feature = "advertise-claude-code-candidate"))]
    let claude_code = None;
    Ok(Declaration {
        subscriptions,
        claude_code,
    })
}

impl McHandler {
    pub(crate) fn claude_code_pending_status(
        &self,
        binding: &SessionBinding,
    ) -> Result<Value, HandlerOutcome> {
        if !attested_claude_code(binding) {
            return Ok(Value::Null);
        }
        let mut scoped = binding.clone();
        if scoped.native_generation.is_none() {
            let pins = self.native_pins();
            scoped.native_generation = Some(mc_store::provider_records::ProviderGeneration {
                profile: pins.profile_generation,
                provider: pins.provider_generation,
            });
        }
        let key = Key::new(&scoped, &scoped.session, &scoped.harness)?;
        let store = self.store.get().ok_or_else(|| self.store_refusal())?;
        let Some(snapshot) = store
            .load_provider_pending_snapshot(&key.store_key())
            .map_err(transient)?
        else {
            return Ok(Value::Null);
        };
        let counters: Value =
            serde_json::from_str(&snapshot.conversation.hook_counters_json).map_err(transient)?;
        let mut reasons = BTreeMap::<&str, usize>::new();
        for held in snapshot.messages {
            let entry = compact::status::StatusMessage {
                raw_message: None,
                mid: held.mid,
                ordinal: held.ordinal,
                message: serde_json::from_slice(&held.message_bytes).map_err(transient)?,
            };
            let ingress = codec::Codec::ClaudeCodeAnthropic.decode_message(&entry)?;
            if ingress.ck.meta.synthetic || ingress.ck.role == "system" {
                continue;
            }
            let mixed_user = ingress.ck.role == "user"
                && ingress
                    .ck
                    .content
                    .iter()
                    .any(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }));
            let last_signed = ingress
                .ck
                .content
                .iter()
                .rposition(super::codec_claude_code::is_thinking_block);
            for (index, block) in ingress.ck.content.iter().enumerate() {
                if snapshot
                    .covered_blocks
                    .contains(&ck_wire::block_id(&entry.mid, index))
                {
                    continue;
                }
                // Use the text and tool-result shapes accepted by taggable_source.
                // Counting must also work when a failed hook left a stored tool
                // result without its matching tool call.
                let (hook, part, user_text, assistant_text) = match &block.kind {
                    ck_wire::CkKind::Text { .. } if ingress.ck.role == "user" => {
                        ("pre_user", "", true, false)
                    }
                    ck_wire::CkKind::Text { text }
                        if ingress.ck.role == "assistant" && !text.trim().is_empty() =>
                    {
                        ("post_assistant", "", false, true)
                    }
                    ck_wire::CkKind::ToolResult { id, output, .. } => {
                        let taggable = match &output.kind {
                            ck_wire::CkOutputKind::Text { .. }
                            | ck_wire::CkOutputKind::ErrorText { .. } => true,
                            ck_wire::CkOutputKind::Content { blocks }
                            | ck_wire::CkOutputKind::ErrorContent { blocks } => {
                                blocks.iter().any(|child| {
                                    matches!(child.kind, ck_wire::ResultBlockKind::Text { .. })
                                })
                            }
                            _ => false,
                        };
                        if !taggable {
                            continue;
                        }
                        ("post_tool", id.as_str(), false, false)
                    }
                    _ => continue,
                };
                let subject = json!({"subject_mid":entry.mid,"hook":hook,"subject_part":part});
                let failed = counters["failed_subjects"]
                    .as_array()
                    .is_some_and(|failed| failed.contains(&subject));
                let reason = if mixed_user && user_text {
                    "mixed_user_text"
                } else if assistant_text && last_signed.is_some_and(|last| last > index) {
                    "signed_prefix_hold"
                } else if failed {
                    "hook_failed"
                } else {
                    "freshness_unproven"
                };
                *reasons.entry(reason).or_default() += 1;
            }
        }
        let count: usize = reasons.values().sum();
        if count > 0 {
            let first = store
                .update_provider_hook_counters(&key.store_key(), |counters| {
                    let first = counters["pending_logged"] != true;
                    counters["pending_logged"] = json!(true);
                    first
                })
                .map_err(transient)?;
            if first == Some(true) {
                tracing::info!(
                    "mc-module: cc_pending session={} count={} reasons={:?}",
                    key.session,
                    count,
                    reasons
                );
            }
        }
        Ok(json!({"count":count,"reasons":reasons}))
    }

    async fn provider_claude_code_hook(
        &self,
        binding: SessionBinding,
        key: Key,
        call: &hooks::hook::HookCall,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        use hooks::{
            answer::{HookAnswer, Operation},
            subscription::Hook,
        };
        if !attested_claude_code(&binding) {
            return bytes(&HookAnswer::Pass);
        }
        if serde_json::to_vec(&json!({"method":"transform.hook","params":params}))
            .map_err(invalid)?
            .len()
            >= HOST_ENVELOPE_BYTES
        {
            return Err(invalid_field("message", "host hook exceeds 3 MiB"));
        }
        let fields: HostHookFields = decode(params)?;
        if fields.pass_complete == Some(false) {
            return Err(invalid_field(
                "pass_complete",
                "omit pass_complete unless true",
            ));
        }
        let mid = fields
            .subject_mid
            .as_deref()
            .filter(|m| !m.is_empty())
            .ok_or_else(|| invalid_field("subject_mid", "CC hooks require a MID"))?;
        let ordinal = fields
            .subject_ordinal
            .ok_or_else(|| invalid_field("subject_ordinal", "CC hooks require an ordinal"))?;
        let native = call
            .message
            .as_ref()
            .ok_or_else(|| invalid_field("message", "CC hooks require a message"))?;
        let message = super::codec_claude_code::from_wire(native, call.raw_message.as_deref())?;
        if serde_json::to_vec(&message).map_err(invalid)?.len() > HOST_ENVELOPE_BYTES - 1 {
            return Err(invalid_field(
                "message",
                "native message exceeds the single-message ceiling",
            ));
        }
        let part = checked_part(fields.subject_part.as_deref())?;
        let hook = call.subject.hook();
        let hook_name = match hook {
            Hook::PreUser => "pre_user",
            Hook::PostAssistant => "post_assistant",
            Hook::PostTool => "post_tool",
            _ => return Err(error("not_subscribed", "CC hook is not declared")),
        };
        if (hook == Hook::PostTool) != fields.subject_part.is_some() {
            return Err(invalid_field(
                "subject_part",
                "only post_tool addresses a tool result",
            ));
        }
        let entry = compact::status::StatusMessage {
            raw_message: None,
            mid: mid.into(),
            ordinal,
            message: message.clone(),
        };
        let ingress = codec::Codec::ClaudeCodeAnthropic.decode_message(&entry)?;
        let mut source = Vec::new();
        let mut targets = Vec::new();
        let mixed_user = ingress
            .ck
            .content
            .iter()
            .any(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }));
        let last_signed = ingress
            .ck
            .content
            .iter()
            .rposition(super::codec_claude_code::is_thinking_block);
        for (native_index, block) in ingress.ck.content.iter().enumerate() {
            match (&block.kind, hook) {
                (ck_wire::CkKind::Text { text }, Hook::PreUser) if ingress.ck.role == "user" => {
                    source.push(text.clone());
                    targets.push((!mixed_user).then_some(native_index));
                }
                (ck_wire::CkKind::Text { text }, Hook::PostAssistant)
                    if ingress.ck.role == "assistant" =>
                {
                    source.push(text.clone());
                    let signed_suffix = last_signed.is_some_and(|index| index > native_index);
                    targets.push((!text.is_empty() && !signed_suffix).then_some(native_index));
                }
                (ck_wire::CkKind::ToolResult { id, output, .. }, Hook::PostTool) if id == part => {
                    match &output.kind {
                        ck_wire::CkOutputKind::Text { text }
                        | ck_wire::CkOutputKind::ErrorText { text } => {
                            source.push(text.clone());
                            targets.push(Some(native_index));
                        }
                        ck_wire::CkOutputKind::Content { blocks }
                        | ck_wire::CkOutputKind::ErrorContent { blocks } => {
                            let mut first_text = true;
                            for child in blocks {
                                if let ck_wire::ResultBlockKind::Text { text } = &child.kind {
                                    source.push(text.clone());
                                    targets.push(first_text.then_some(native_index));
                                    first_text = false;
                                }
                            }
                        }
                        ck_wire::CkOutputKind::Json { value }
                        | ck_wire::CkOutputKind::ErrorJson { value } => {
                            if let Some(children) = value.as_array() {
                                for text in children
                                    .iter()
                                    .filter(|b| b["type"] == "text")
                                    .filter_map(|b| b["text"].as_str())
                                {
                                    source.push(text.to_owned());
                                    targets.push(None);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        if source != call.subject.blocks().unwrap_or_default() {
            return Err(invalid_field(
                "message",
                "subject blocks differ from native message",
            ));
        }
        let lineage_id = call
            .lineage_id
            .as_deref()
            .filter(|l| !l.is_empty())
            .ok_or_else(|| invalid_field("lineage_id", "CC hooks require a lineage"))?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        let route = self.native_publication_lock(&binding)?;
        let _route = self.native_publication_fence(&binding, &route)?;
        let subject = ProviderSubject {
            subject_mid: mid.into(),
            hook: hook_name.into(),
            subject_part: part.into(),
        };
        let result = (|| {
            let held = store
                .load_provider_conversation(&key.store_key())
                .map_err(transient)?
                .ok_or_else(|| invalid_field("params", "CC plan is not frozen"))?;
            let plan: Value = serde_json::from_str(&held.params_json).map_err(transient)?;
            let frozen: Value = serde_json::from_str(
                held.native_plan_json
                    .as_deref()
                    .ok_or_else(|| invalid_field("params", "CC plan is not frozen"))?,
            )
            .map_err(transient)?;
            let native_lane =
                plan["serializer_profile"] == "claude-code-anthropic" && answer_observation(&plan);
            let reduction_owner = frozen.get("composition").is_none_or(Value::is_null)
                || frozen
                    .pointer("/composition/compaction/provider")
                    .and_then(Value::as_str)
                    == Some(DEFAULT_MODULE_ID);
            let declared = declaration(&json!({"params":plan,"preset":held.preset}))?;
            if !declared
                .subscriptions
                .iter()
                .any(|s| s.hook == hook && s.phase == call.subject.phase())
            {
                return Err(error("not_subscribed", "CC hook is not declared"));
            }
            let descent = call.descends_from.as_ref().map(|parent| {
                compact::status::DescendsFrom::new(&parent.lineage_id, parent.through_ordinal)
            });
            let lineage = super::compaction::claude_code_lineage_fields(
                &store,
                &key,
                descent.as_ref(),
                lineage_id,
                ordinal,
                None,
            )?;
            let unserved = fields
                .unserved_subjects
                .iter()
                .map(|s| {
                    Ok(ProviderSubject {
                        subject_mid: s.subject_mid.clone(),
                        hook: s.hook.clone(),
                        subject_part: checked_part(s.subject_part.as_deref())?.into(),
                    })
                })
                .collect::<Result<Vec<_>, HandlerOutcome>>()?;
            let mut request: TransformRequest = decode(
                &json!({"v":2,"kind":"transform.hook","serializer_profile":"claude-code-anthropic","session_id":key.engine_key(),"render_config":"","messages":[],"tool_present":false,"auto_search_enabled":false}),
            )?;
            // Hook commits persist the immutable native ingest in the provider log,
            // before step admission and independently of pending answer edits. Loading
            // that log lets post_tool pair with an earlier post_assistant after restart;
            // burning an unserved answer does not erase its tool-use ingest. Include
            // the retained parent prefix when a hook first declares a descent.
            let needs_pairing = ingress
                .ck
                .content
                .iter()
                .any(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }));
            let mut prior = if !needs_pairing {
                Vec::new()
            } else if let Some(parent) = &lineage.descends_from {
                let cut = lineage.through_ordinal.expect("paired descent");
                let mut prior = store
                    .load_provider_messages(&key.store_key(), parent)
                    .map_err(transient)?;
                prior.retain(|message| message.ordinal <= cut);
                prior.extend(
                    store
                        .load_provider_messages(&key.store_key(), lineage_id)
                        .map_err(transient)?
                        .into_iter()
                        .filter(|message| message.ordinal > cut),
                );
                prior
            } else {
                store
                    .load_provider_messages(&key.store_key(), lineage_id)
                    .map_err(transient)?
            };
            prior.retain(|message| message.ordinal < ordinal);
            let mut entries = prior
                .into_iter()
                .map(|message| {
                    Ok(compact::status::StatusMessage {
                        raw_message: None,
                        mid: message.mid,
                        ordinal: message.ordinal,
                        message: serde_json::from_slice(&message.message_bytes)
                            .map_err(transient)?,
                    })
                })
                .collect::<Result<Vec<_>, HandlerOutcome>>()?;
            entries.push(entry);
            codec::Codec::ClaudeCodeAnthropic.prepare_request(&mut request, &entries)?;
            let projection = ck_wire::project_messages(&request.messages).map_err(|problem| {
                if matches!(problem, ck_wire::CkWireError::UnpairedToolResult { .. }) {
                    error("unpaired_tool_result", problem.to_string())
                } else {
                    transient(problem)
                }
            })?;
            let mut parts = admission_policy_parts(&request, &projection);
            parts.retain(|part| part.mid == mid);
            for p in &mut parts {
                if let Some(ck_wire::CkKind::ToolResult { id, .. }) = ingress
                    .ck
                    .content
                    .get(p.block_index as usize)
                    .map(|b| &b.kind)
                {
                    p.subject_part = id.clone();
                }
            }
            let mut input = ProviderMessage {
                mid: mid.into(),
                ordinal,
                message_bytes: serde_json::to_vec(&message).map_err(transient)?,
            };
            super::codec_claude_code::preserve_stored_forms(
                &store,
                &key,
                &lineage,
                std::slice::from_mut(&mut input),
            )?;
            let answer = store
                .commit_provider_hook_with_parts(
                    &key.store_key(),
                    ProviderHookRequest {
                        lineage: &lineage,
                        message: Some(&input),
                        served_through_ordinal: fields.served_through_ordinal,
                        unserved_subjects: &unserved,
                        repeat_subject: Some(&subject),
                    },
                    &parts,
                    |ctx| {
                        if let Some(held) = &ctx.repeat_answer {
                            let ops: Vec<Operation> = serde_json::from_str(&held.answer.ops_json)
                                .map_err(|e| {
                                mc_store::provider_records::ProviderError::Transient(e.to_string())
                            })?;
                            let answer = if ops.is_empty() {
                                HookAnswer::Pass
                            } else {
                                HookAnswer::Ops { ops }
                            };
                            return Ok((
                                ProviderHookWrite {
                                    answer: (held.state == "pending"
                                        && held.lineage_id == lineage.lineage_id)
                                        .then(|| held.answer.clone()),
                                    counters: ctx.counters.clone(),
                                    policy_summary: Default::default(),
                                },
                                answer,
                            ));
                        }
                        let mut ops = Vec::new();
                        let mut tags = Vec::new();
                        // Only THALAMUS's Claude Code answer hooks may add automatic
                        // tags, and only when MC owns compaction to resolve them later.
                        // The gateway freezes a plan with MC as its single step provider;
                        // composition is opaque and exposes no step-provider selector.
                        if ctx.counters["auto_tag"] == true && native_lane && reduction_owner {
                            for (hook_index, native_index) in targets.iter().enumerate() {
                                let Some(native_index) = native_index else {
                                    continue;
                                };
                                // Reservations use native content coordinates; hook ops
                                // index only the text blocks offered by the gateway.
                                let block_id = ck_wire::block_id(mid, *native_index);
                                let Some(target) =
                                    projection.blocks.iter().find(|b| b.id == block_id)
                                else {
                                    continue;
                                };
                                let Some((kind, source)) = transform::taggable_source(target)
                                else {
                                    continue;
                                };
                                let Some(number) = ctx
                                    .parts
                                    .iter()
                                    .find(|p| p.block_id == block_id)
                                    .and_then(|p| p.tag_number)
                                else {
                                    continue;
                                };
                                ops.push(Operation::Prepend {
                                    block: hook_index as u32,
                                    text: transform::tag_prefix(number),
                                    note: None,
                                });
                                tags.push(ProviderAnswerTag {
                                    number,
                                    block_id,
                                    kind: kind.as_store_kind().into(),
                                    token_count: mc_tokenizer::estimate_tokens(&source) as i64,
                                    source: source.into_owned(),
                                    created_at_ms: now_ms(),
                                });
                            }
                        }
                        let ops_json = serde_json::to_string(&ops).map_err(|e| {
                            mc_store::provider_records::ProviderError::Transient(e.to_string())
                        })?;
                        let answer = if ops.is_empty() {
                            HookAnswer::Pass
                        } else {
                            HookAnswer::Ops { ops }
                        };
                        Ok((
                            ProviderHookWrite {
                                answer: Some(ProviderHookAnswer {
                                    subject: subject.clone(),
                                    ordinal,
                                    ops_json,
                                    tags,
                                }),
                                counters: ctx.counters.clone(),
                                policy_summary: Default::default(),
                            },
                            answer,
                        ))
                    },
                )
                .map_err(provider_policy_error)?;
            bytes(&answer)
        })();
        drop(_route);
        if result.is_err() {
            // The bound connection or native generation may have changed after
            // the hook ran. Recheck that identity before recording its failure,
            // without replacing the error returned to the caller.
            if let Ok(_route) = self.native_publication_fence(&binding, &route) {
                let _ = store.record_provider_hook_failure(&key.store_key(), &subject);
            }
        }
        result
    }

    pub(crate) fn host_provider_conversation(
        &self,
        binding: &SessionBinding,
    ) -> Option<(Key, mc_store::provider_records::ProviderConversation)> {
        if !host_binding(binding) {
            return None;
        }
        let key = Key::new(binding, &binding.session, &binding.harness).ok()?;
        let c = self
            .store
            .get()?
            .load_provider_conversation(&key.store_key())
            .ok()??;
        let plan: Value = serde_json::from_str(&c.params_json).ok()?;
        let expected = if attested_claude_code(binding) {
            "claude-code-anthropic"
        } else {
            "opencode-aisdk"
        };
        (answer_observation(&plan) && plan["serializer_profile"] == expected).then_some((key, c))
    }

    pub(crate) fn sync_provider_pass_inputs(
        &self,
        binding: &SessionBinding,
        store: &McStore,
        chain: Option<&[String]>,
        pass_complete: bool,
        pass: Option<&Value>,
    ) -> Result<(), HandlerOutcome> {
        let Some((key, _)) = self.host_provider_conversation(binding) else {
            return if pass_complete || pass.is_some() {
                Err(invalid_field(
                    "pass_complete",
                    "pass barrier requires an admitted host conversation",
                ))
            } else {
                Ok(())
            };
        };
        let _serial = self
            .provider_serial
            .try_lock_for(&key)
            .map_err(|_| transient("provider conversation is busy"))?;
        self.sync_provider_pass_inputs_locked(binding, store, chain, pass_complete, pass)?;
        if pass_complete {
            self.schedule_provider_historian(binding.clone(), key);
        }
        Ok(())
    }

    pub(crate) fn sync_provider_pass_inputs_locked(
        &self,
        binding: &SessionBinding,
        store: &McStore,
        chain: Option<&[String]>,
        pass_complete: bool,
        pass: Option<&Value>,
    ) -> Result<(), HandlerOutcome> {
        let Some((key, _)) = self.host_provider_conversation(binding) else {
            return Ok(());
        };
        let mut c = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
            .ok_or_else(|| transient("provider conversation disappeared"))?;
        // Opening a pass invalidates the preceding barrier even if no message
        // was appended. A queued evaluator must not read a half-synchronized pass.
        let mut inputs = None;
        let mut admitted = None;
        if let Some(pass) = pass {
            let pass: ProviderPassInput = decode(pass)?;
            if let Some(value) = &pass.historian_inputs {
                inputs = Some(super::historian::checked_inputs(value)?);
            } else {
                inputs = Some(json!({}));
            }
            let first = pass.appended.first().map_or(0, |m| m.ordinal);
            let lineage = store
                .load_provider_lineage(&key.store_key(), &pass.lineage_id)
                .map_err(transient)?
                .unwrap_or(ProviderLineage {
                    lineage_id: pass.lineage_id.clone(),
                    first_ordinal: pass
                        .descends_from
                        .as_ref()
                        .map_or(first, |d| d.through_ordinal.saturating_add(1)),
                    descends_from: pass.descends_from.as_ref().map(|d| d.lineage_id.clone()),
                    through_ordinal: pass.descends_from.as_ref().map(|d| d.through_ordinal),
                });
            let decoded = super::codec_opencode::decode_messages(&pass.appended)?;
            admitted = Some((pass.lineage_id.clone(), decoded.messages.clone()));
            let mut req: TransformRequest = decode(
                &json!({"v":2,"session_id":c.engine_namespace,"render_config":"provider-policy","serializer_profile":"opencode-aisdk","messages":decoded.messages}),
            )?;
            req.tool_present = true;
            let projection = ck_wire::project_messages(&req.messages).map_err(transient)?;
            let mut parts = admission_policy_parts(&req, &projection);
            for part in &mut parts {
                if part.kind == "tool_result" {
                    part.subject_part = decoded
                        .sidecar
                        .messages
                        .get(&part.mid)
                        .and_then(|m| {
                            m.blocks
                                .iter()
                                .find(|b| b.block_index == part.block_index as usize)
                        })
                        .and_then(|b| b.raw.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into();
                }
            }
            let eligible_user = pass
                .physical_tail
                .as_ref()
                .and_then(|tail| {
                    parts.iter().find(|p| {
                        p.mid == tail.mid
                            && p.ordinal == tail.ordinal
                            && p.kind == "header"
                            && p.real_user
                    })
                })
                .map(|p| p.mid.clone());
            let eligible_tool = parts
                .iter()
                .rev()
                .find(|p| p.tag_kind.as_deref() == Some("tool_result"))
                .map(|p| p.block_id.clone());
            let ids = pass
                .ordered_ids
                .unwrap_or_else(|| pass.appended.iter().map(|m| m.mid.clone()).collect());
            let pass_id = pass.pass_id.unwrap_or_else(|| {
                sha256_hex(&serde_json::to_vec(&(&pass.lineage_id, &ids)).expect("pass identity"))
            });
            if pass.exact_pass_plan.as_deref().is_some_and(|p| {
                !matches!(p, "hard" | "migrate_hard" | "soft" | "defer" | "reject")
            }) {
                return Err(invalid_field(
                    "provider_pass.exact_pass_plan",
                    "unknown exact engine plan",
                ));
            }
            let context = json!({"pass_id":pass_id,"lineage_id":pass.lineage_id,"appended_ids":ids,"physical_tail":pass.physical_tail,"eligible_user_mid":eligible_user,"eligible_tool_block":eligible_tool,"exact_pass_plan":pass.exact_pass_plan,"marker_hard_serves_frozen_prefix":pass.marker_hard_serves_frozen_prefix,"model_key":binding.model_key});
            let messages = pass
                .appended
                .iter()
                .map(|m| {
                    Ok(ProviderMessage {
                        mid: m.mid.clone(),
                        ordinal: m.ordinal,
                        message_bytes: serde_json::to_vec(&m.message).map_err(transient)?,
                    })
                })
                .collect::<Result<Vec<_>, HandlerOutcome>>()?;
            store
                .admit_provider_pass(&key.store_key(), &lineage, &messages, &parts, &context)
                .map_err(provider_policy_error)?;
            c = store
                .load_provider_conversation(&key.store_key())
                .map_err(transient)?
                .ok_or_else(|| transient("provider conversation disappeared"))?;
        }
        let mut counters: Value = serde_json::from_str(&c.hook_counters_json).map_err(transient)?;
        if let Some((lineage, messages)) = admitted {
            super::historian::advance_ingest_watermarks(&mut counters, &lineage, &messages);
        }
        counters["pass_complete"] = Value::Null;
        if let Some(inputs) = inputs {
            counters["historian_inputs"] = inputs;
        }
        if counters.get("engine_policy").is_none() {
            counters["engine_policy"] = transform::provider_engine_settings(
                &store
                    .load_meta(&c.engine_namespace)
                    .map_err(transient)?
                    .meta,
            );
        }
        if let Some(chain) = chain {
            let chain = serde_json::to_string(chain).map_err(invalid)?;
            if c.historian_model_chain_json != chain {
                c.historian_model_chain_json = chain;
                counters["historian_evaluation_due"] = json!(true);
            }
        }
        if pass_complete {
            let through = c.cursor_frontier.saturating_sub(1);
            counters["pass_complete"] =
                json!({"lineage_id":c.lineage_id,"through_ordinal":through});
            super::historian::record_barrier(&mut counters);
        }
        c.hook_counters_json = serde_json::to_string(&counters).map_err(transient)?;
        store
            .save_provider_conversation(&key.store_key(), &c)
            .map_err(transient)?;
        Ok(())
    }

    async fn provider_host_reduce(
        &self,
        key: Key,
        requested: &[u64],
    ) -> Result<HandlerOutcome, HandlerOutcome> {
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        let conversation = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
            .ok_or_else(|| transient("provider conversation is missing"))?;
        let mut known = Vec::new();
        let mut unknown = Vec::new();
        let mut engine_blocks = BTreeMap::new();
        for number in requested {
            let Ok(n) = i64::try_from(*number) else {
                unknown.push(*number);
                continue;
            };
            if store
                .provider_answer_tag_known(&key.store_key(), n)
                .map_err(transient)?
            {
                known.push(*number);
            } else if let Some(block) = store
                .provider_engine_tag_block(&key.store_key(), n)
                .map_err(transient)?
            {
                known.push(*number);
                engine_blocks.insert(*number, block);
            } else {
                unknown.push(*number);
            }
        }
        let pending = store
            .load_provider_pending_drops(&key.store_key())
            .map_err(transient)?;
        let engine_pending = store
            .load_pending_agent_drops(&conversation.engine_namespace)
            .map_err(transient)?
            .into_iter()
            .map(|drop| drop.target_id)
            .collect::<BTreeSet<_>>();
        let already = known
            .iter()
            .copied()
            .filter(|n| {
                pending.contains(&(*n as i64))
                    || engine_blocks
                        .get(n)
                        .is_some_and(|block| engine_pending.contains(block))
            })
            .collect::<Vec<_>>();
        let queue = known
            .iter()
            .copied()
            .filter(|n| !already.contains(n))
            .collect::<Vec<_>>();
        let detail = ctx_reduce_ack_details(&unknown);
        if queue.is_empty() {
            if unknown.is_empty() && !already.is_empty() {
                return Ok(mcp_text_result(ctx_reduce_reply(already.len(), 0), false));
            }
            return Ok(tool_error_result(format!(
                "Refused: no valid tags to queue. {detail}"
            )));
        }
        let hook_queue = queue
            .iter()
            .filter(|n| !engine_blocks.contains_key(n))
            .map(|n| *n as i64)
            .collect::<Vec<_>>();
        if !hook_queue.is_empty() {
            store
                .queue_provider_drops(&key.store_key(), &hook_queue)
                .map_err(transient)?;
        }
        let engine_queue = queue
            .iter()
            .filter_map(|n| engine_blocks.get(n).cloned())
            .collect::<Vec<_>>();
        if !engine_queue.is_empty() {
            // Tags shown before provider hooks were enabled use ctx_reduce's
            // existing durable block-ID queue. Enqueueing must not change any
            // already-served bytes: the planner waits for the next independent
            // cache-rebuild opportunity before releasing the requested content.
            store
                .append_pending_agent_drops_with_command(
                    &conversation.engine_namespace,
                    None,
                    &engine_queue,
                    now_ms(),
                    false,
                )
                .map_err(transient)?;
        }
        let mut reply = ctx_reduce_reply(queue.len() + already.len(), 0);
        if !detail.is_empty() {
            reply.push(' ');
            reply.push_str(&detail);
            reply.push('.');
        }
        Ok(mcp_text_result(reply, false))
    }
    async fn provider_host_hook(
        &self,
        binding: SessionBinding,
        key: Key,
        call: &hooks::hook::HookCall,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        use hooks::{
            answer::{HookAnswer, Operation},
            subscription::Hook,
        };
        if serde_json::to_vec(&json!({"method":"transform.hook","params":params}))
            .map_err(invalid)?
            .len()
            > HOST_ENVELOPE_BYTES
        {
            return Err(invalid_field("message", "host hook exceeds 3 MiB"));
        }
        let fields: HostHookFields = decode(params)?;
        if fields.pass_complete == Some(false) {
            return Err(invalid_field(
                "pass_complete",
                "omit pass_complete unless true",
            ));
        }
        let part = checked_part(fields.subject_part.as_deref())?;
        let mid = fields
            .subject_mid
            .as_deref()
            .filter(|mid| !mid.is_empty())
            .ok_or_else(|| invalid_field("subject_mid", "host hooks require a subject_mid"))?;
        let ordinal = fields.subject_ordinal.ok_or_else(|| {
            invalid_field("subject_ordinal", "host hooks require a subject_ordinal")
        })?;
        let message = fields
            .message
            .as_ref()
            .ok_or_else(|| invalid_field("message", "host hooks require ingest bytes"))?;
        let hook = call.subject.hook();
        let hook_name = match hook {
            Hook::PreUser => "pre_user",
            Hook::PostAssistant => "post_assistant",
            Hook::PostTool => "post_tool",
            _ => return Err(error("not_subscribed", "host hook is not declared")),
        };
        if (hook == Hook::PostTool) != fields.subject_part.is_some() {
            return Err(invalid_field(
                "subject_part",
                "only post_tool addresses a tool part",
            ));
        }
        let subject = ProviderSubject {
            subject_mid: mid.into(),
            hook: hook_name.into(),
            subject_part: part.into(),
        };
        let unserved = fields
            .unserved_subjects
            .iter()
            .map(|s| {
                Ok(ProviderSubject {
                    subject_mid: s.subject_mid.clone(),
                    hook: s.hook.clone(),
                    subject_part: checked_part(s.subject_part.as_deref())?.into(),
                })
            })
            .collect::<Result<Vec<_>, HandlerOutcome>>()?;
        let lineage_id = call
            .lineage_id
            .as_deref()
            .filter(|l| !l.is_empty())
            .ok_or_else(|| invalid_field("lineage_id", "host hooks require lineage_id"))?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        let c = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
            .ok_or_else(|| invalid_field("params", "host plan is not frozen"))?;
        let plan: Value = serde_json::from_str(&c.params_json).map_err(transient)?;
        let declared = declaration(&json!({"preset":c.preset,"params":plan}))?;
        let subscription = declared
            .subscriptions
            .iter()
            .find(|s| s.hook == hook && s.phase == call.subject.phase())
            .ok_or_else(|| error("not_subscribed", "hook is not declared"))?;
        let lineage = if let Some(held) = store
            .load_provider_lineage(&key.store_key(), lineage_id)
            .map_err(transient)?
        {
            if fields.descends_from.as_ref().is_some_and(|d| {
                held.descends_from.as_deref() != Some(&d.lineage_id)
                    || held.through_ordinal != Some(d.through_ordinal)
            }) {
                return Err(invalid_field("descends_from", "descent changed"));
            }
            held
        } else {
            ProviderLineage {
                lineage_id: lineage_id.into(),
                first_ordinal: fields
                    .descends_from
                    .as_ref()
                    .map_or(ordinal, |d| d.through_ordinal.saturating_add(1)),
                descends_from: fields.descends_from.as_ref().map(|d| d.lineage_id.clone()),
                through_ordinal: fields.descends_from.as_ref().map(|d| d.through_ordinal),
            }
        };
        let entry = compact::status::StatusMessage {
            raw_message: None,
            mid: mid.into(),
            ordinal,
            message: message.clone(),
        };
        let decoded = super::codec_opencode::decode_messages(&[entry])?;
        let ingress = &decoded.messages[0];
        let projection = ck_wire::project_messages(&decoded.messages).map_err(transient)?;
        let shell = decoded.sidecar.messages.get(mid).expect("decoded sidecar");
        let targets = projection
            .blocks
            .iter()
            .filter(|b| match hook {
                Hook::PreUser => b.role == "user" && b.kind_tag == "text",
                Hook::PostAssistant => b.role == "assistant" && b.kind_tag == "text",
                Hook::PostTool => {
                    b.kind_tag == "tool_result"
                        && shell.blocks.iter().any(|meta| {
                            meta.block_index == b.block_index
                                && meta.raw.get("id").and_then(Value::as_str) == Some(part)
                        })
                }
                _ => false,
            })
            .collect::<Vec<_>>();
        let blocks = call.subject.blocks().unwrap_or_default();
        if targets.len() != blocks.len()
            || targets
                .iter()
                .zip(blocks)
                .any(|(target, text)| target.scalar_text().as_deref() != Some(text.as_str()))
        {
            return Err(invalid_field(
                "message",
                "subject blocks do not match their ingest part",
            ));
        }
        let mut metrics = ProviderPolicyTotals::default();
        if !ingress.ck.meta.synthetic {
            if hook == Hook::PreUser {
                metrics.real_users = 1;
            }
            for target in &targets {
                let tokens = mc_tokenizer::estimate_tokens(
                    target.scalar_text().as_deref().unwrap_or_default(),
                ) as i64;
                if hook == Hook::PostTool {
                    metrics.tool_tokens += tokens;
                    metrics.reclaimable_tokens += tokens;
                    metrics.tool_outputs += 1;
                } else {
                    metrics.text_tokens += tokens;
                    metrics.reclaimable_tokens += tokens;
                }
            }
            if hook == Hook::PostTool {
                for meta in shell.blocks.iter().filter(|meta| {
                    meta.kind == "tool_call"
                        && meta.raw.get("id").and_then(Value::as_str) == Some(part)
                }) {
                    if let mc_store::CkKind::ToolCall { input, .. } =
                        &ingress.ck.content[meta.block_index].kind
                    {
                        let tokens = mc_tokenizer::estimate_tokens(
                            &serde_json::to_string(input).map_err(transient)?,
                        ) as i64;
                        metrics.tool_tokens += tokens;
                        metrics.reclaimable_tokens += tokens;
                    }
                }
            }
        }
        let synced: Value = serde_json::from_str(&c.hook_counters_json).map_err(transient)?;
        let eligible_hint = synced
            .pointer("/pass_context/lineage_id")
            .and_then(Value::as_str)
            == Some(lineage_id)
            && synced
                .pointer("/pass_context/eligible_user_mid")
                .and_then(Value::as_str)
                == Some(mid);
        if hook == Hook::PreUser && synced.get("pass_context").is_none() {
            tracing::warn!(session=%key.session,"host hint suppressed: no synchronized pass policy");
        }
        let rendered_memory_ids = synced
            .pointer("/engine_policy/rendered_memory_ids")
            .and_then(|v| serde_json::from_value::<Vec<i64>>(v.clone()).ok())
            .unwrap_or_else(|| {
                store
                    .load_meta(&c.engine_namespace)
                    .map(|s| s.meta.rendered_memory_ids)
                    .unwrap_or_default()
            });
        let hint = if hook == Hook::PreUser && eligible_hint {
            self.host_user_hint(
                &store,
                &binding,
                &c.engine_namespace,
                &decoded.messages,
                &projection,
                &plan,
                &rendered_memory_ids,
            )?
        } else {
            None
        };
        let input = ProviderMessage {
            mid: mid.into(),
            ordinal,
            message_bytes: serde_json::to_vec(message).map_err(transient)?,
        };
        let policy_request: TransformRequest = decode(
            &json!({"v":2,"kind":"transform.hook","session_id":c.engine_namespace,"render_config":"provider-policy","serializer_profile":"opencode-aisdk","messages":decoded.messages}),
        )?;
        let mut policy_parts = admission_policy_parts(&policy_request, &projection);
        for p in &mut policy_parts {
            if p.kind == "tool_result" {
                p.subject_part = shell
                    .blocks
                    .iter()
                    .find(|b| b.block_index == p.block_index as usize)
                    .and_then(|b| b.raw.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into();
            }
        }
        // The store owns P1's newest-held/monotonic confirmation check. Descent,
        // message admission and the revert clamp share that transaction.
        let answer = store
            .commit_provider_hook_with_parts(
                &key.store_key(),
                ProviderHookRequest {
                    lineage: &lineage,
                    message: Some(&input),
                    served_through_ordinal: fields.served_through_ordinal,
                    unserved_subjects: &unserved,
                    repeat_subject: Some(&subject),
                },
                &policy_parts,
                |ctx| {
                    let mut counters = ctx.counters.clone();
                    super::historian::advance_ingest_watermarks(&mut counters, lineage_id, std::slice::from_ref(ingress));
                    let mut ops = Vec::new();
                    let mut tags = Vec::new();
                    let mut non_tag_ops = Vec::new();
                    let mut policy_state=ctx.counters["policy_state"].clone();
                    policy_state["reduce_pending"]=ctx.counters.pointer("/engine_policy/reduce_suppressed").cloned().unwrap_or(json!(false));
                    let state=&policy_state;
                    // A conservative preflight is not permission. With no exact
                    // engine plan, the hook is a defer; the rebuild owns its overlay.
                    let exact_plan=exact_plan_for_subject(&ctx.counters,lineage_id,mid);
                    let temporal_permitted=exact_plan.as_ref().is_some_and(|plan|transform::pass_plan_permits_prefix_mutation(plan,ctx.counters.pointer("/pass_context/marker_hard_serves_frozen_prefix").and_then(Value::as_bool).unwrap_or(false)));
                    for (index, target) in targets.iter().enumerate() {
                        if let Some((kind, source)) = transform::taggable_source(target) {
                            let number = ctx.parts.iter().find(|p|p.block_id==target.id).and_then(|p|p.tag_number).or_else(||ctx.tag_high_water.checked_add(tags.len() as i64+1))
                                .ok_or_else(|| {
                                    mc_store::provider_records::ProviderError::Transient(
                                        "tag numbers exhausted".into(),
                                    )
                                })?;
                            if hook == Hook::PostAssistant {
                                let clean = transform::strip_leading_tag_imitations(&blocks[index]);
                                if clean != blocks[index] {
                                    let op = Operation::Replace {
                                        block: index as u32,
                                        value: clean,
                                        note: None,
                                    };
                                    ops.push(op.clone());
                                    non_tag_ops.push(op);
                                }
                            }
                            if hook == Hook::PreUser
                                && index == 0
                                && binding.config.temporal_awareness
                                && temporal_permitted
                                && ctx.counters.pointer("/pass_context/lineage_id").and_then(Value::as_str)==Some(lineage_id)
                            {
                                if let Some(prefix) = ctx.policy_index.previous_header(ordinal)?.and_then(|p|transform::temporal_marker_from_timestamps(p.created_at_ms,p.completed_at_ms,ingress.ck.meta.created_at_ms)).filter(|p|!p.is_empty())
                                {
                                    let op = Operation::Prepend {
                                        block: 0,
                                        text: prefix,
                                        note: None,
                                    };
                                    ops.push(op.clone());
                                    non_tag_ops.push(op);
                                }
                            }
                            ops.push(Operation::Prepend {
                                block: index as u32,
                                text: transform::tag_prefix(number),
                                note: None,
                            });
                            tags.push(ProviderAnswerTag {
                                number,
                                block_id: target.id.clone(),
                                kind: kind.as_store_kind().into(),
                                source: source.into_owned(),
                                token_count: mc_tokenizer::estimate_tokens(&blocks[index]) as i64,
                                created_at_ms: now_ms(),
                            });
                        }
                    }
                    if let Some(hint) = &hint {
                        if !hint.hint_text.is_empty() {
                            let op = Operation::Append {
                                block: 0,
                                text: hint.hint_text.clone(),
                                note: None,
                            };
                            ops.push(op.clone());
                            non_tag_ops.push(op);
                        }
                    }
                    let new_ids=ctx.counters.pointer("/pass_context/appended_ids").and_then(Value::as_array);
                    let carrier_block=ctx.parts.iter().filter(|p|p.tag_kind.as_deref()==Some("tool_result") && new_ids.is_some_and(|ids|ids.iter().any(|id|id.as_str()==Some(p.mid.as_str())))).max_by_key(|p|(p.ordinal,p.block_index));
                    let carrier=hook==Hook::PostTool && targets.iter().any(|t|carrier_block.is_some_and(|p|p.block_id==t.id));
                    let cache_busting=temporal_permitted && !matches!(c.preset.as_deref(),Some("worker"|"subagent"|"reader"));
                    let pass_model=ctx.counters.pointer("/pass_context/model_key").and_then(Value::as_str);
                    let (inputs,policy_summary)=super::policy_summary::channel1_inputs(&ctx.policy_index,&ctx.counters["engine_policy"],binding.config.resolve_protected_tokens(100_000).floor,&binding.config.protected_tools,carrier,cache_busting,pass_model)?;
                    if cache_busting {counters["engine_policy"]["calibration"]=serde_json::to_value(crate::decision_calibration::DecisionCalibration::freeze_for_model(pass_model)).expect("calibration JSON");}
                    if ctx.counters.pointer("/engine_policy/baseline/baseline_generation").and_then(Value::as_u64)!=Some(inputs.baseline.baseline_generation) {
                        counters["policy_baseline_updates"]=json!(inputs.baseline.baseline_parts.iter().map(|m|json!({"block_id":m.key.split('\0').next().unwrap_or(""),"measurement":m})).collect::<Vec<_>>());
                        let mut baseline=inputs.baseline.clone();baseline.baseline_parts.clear();
                        if !counters["engine_policy"].is_object() {counters["engine_policy"]=json!({});}
                        counters["engine_policy"]["baseline"]=serde_json::to_value(baseline).expect("baseline JSON");
                        counters["engine_policy"]["baseline_len"]=json!(inputs.baseline.baseline_parts.len());
                    }
                    let (cadence_ops, mut policy) = host_channel1(&inputs,state);
                    counters["engine_policy"]["reduce_suppressed"]=policy["reduce_pending"].clone();
                    counters["engine_policy"]["baseline"]["channel1_post_reduce_grace_baseline_u"]=policy["grace_u"].clone();
                    counters["engine_policy"]["baseline"]["channel1_post_reduce_grace_pre_level"]=policy["grace_level"].clone();
                    policy.as_object_mut().expect("policy object").remove("channel1");
                    if hook == Hook::PostTool {
                        ops.append(&mut cadence_ops.clone());
                        for mut op in cadence_ops {
                            if let Operation::Append { note, .. } = &mut op {
                                *note = Some(CHANNEL1_NOTE.into());
                                counters["channel1_hook_append_pending"] = json!(true);
                            }
                            non_tag_ops.push(op);
                        }
                    }
                    policy["last_response_at_ms"] = json!(ingress
                        .ck
                        .meta
                        .completed_at_ms
                        .or_else(|| state.get("last_response_at_ms").and_then(Value::as_i64)));
                    policy["metrics"] = serde_json::to_value(&metrics).expect("metrics JSON");
                    counters["answer_policy"] = policy;
                    counters["pass_complete"] = Value::Null;
                    if fields.pass_complete == Some(true) {
                        counters["pass_complete"] =
                            json!({"lineage_id":lineage_id,"through_ordinal":ordinal});
                        super::historian::record_barrier(&mut counters);
                    }
                    let answer = if ops.is_empty() {
                        HookAnswer::Pass
                    } else {
                        HookAnswer::Ops { ops }
                    };
                    hooks::answer::check_answer(&call.subject, &subscription.ops, None, &answer)
                        .map_err(|e| {
                            mc_store::provider_records::ProviderError::Transient(e.name().into())
                        })?;
                    Ok((
                        ProviderHookWrite {
                            answer: Some(ProviderHookAnswer {
                                subject: subject.clone(),
                                ordinal,
                                ops_json: serde_json::to_string(&non_tag_ops).expect("ops JSON"),
                                tags,
                            }),
                            counters,
                            policy_summary,
                        },
                        answer,
                    ))
                },
            )
            .map_err(provider_policy_error)?;
        fault("HookStateRecorded");
        if fields.pass_complete == Some(true) {
            self.schedule_provider_historian(binding, key);
        }
        bytes(&answer)
    }

    // Hint selection needs project/session identity, current messages and search
    // thresholds, plus IDs of memories already shown to avoid duplicate hints.
    #[allow(clippy::too_many_arguments)]
    fn host_user_hint(
        &self,
        store: &McStore,
        binding: &SessionBinding,
        namespace: &str,
        messages: &[ck_wire::CkIngressMessage],
        projection: &ck_wire::FlatProjection,
        plan: &Value,
        rendered_memory_ids: &[i64],
    ) -> Result<Option<mc_store::UserHintDecisionInput>, HandlerOutcome> {
        let config = &binding.config;
        if !config.auto_search.enabled
            || plan.get("auto_search_enabled") == Some(&Value::Bool(false))
        {
            return Ok(None);
        }
        let directory = binding.project_root.to_string_lossy();
        let project = self.route_project(store, binding)?.key;
        let mut request: TransformRequest = decode(
            &json!({"v":2,"kind":"transform.hook","session_id":namespace,"serializer_profile":"opencode-aisdk","render_config":"host-hook","messages":messages}),
        )?;
        if let Some(chars) = plan
            .get("auto_search_min_prompt_chars")
            .and_then(Value::as_u64)
        {
            request.auto_search_min_prompt_chars = chars as usize;
        }
        if let Some(score) = plan
            .get("auto_search_score_threshold")
            .and_then(Value::as_f64)
        {
            request.auto_search_score_threshold = score;
        }
        let context = transform::ProducerContext {
            signed_thinking_hold: config.signed_thinking_hold,
            project_path: &project,
            note_project_path: &project,
            project_directory: &directory,
            history_budget_tokens: binding.history_budget_tokens,
            memory_budget_tokens: config.memory_budget_tokens,
            user_profile_budget_tokens: config.user_profile_budget_tokens,
            memory_enabled: config.memory_enabled,
            inject_docs: config.inject_docs,
            temporal_awareness: config.temporal_awareness,
            now_ms: now_ms(),
            execute_threshold_percentage: 80.0,
            protected_tokens_floor: 0,
            protected_tokens_provenance: "absolute",
            compaction_enabled: config.compaction_enabled,
            smart_drops: config.smart_drops,
            protected_tools: config.protected_tools.clone(),
            cache_ttl: config.resolve_cache_ttl_with_provenance(None).value,
            cache_ttl_provenance: config.resolve_cache_ttl_with_provenance(None).provenance,
            cache_ttl_policy: None,
            model_key: None,
            observed_last_response_at_ms: None,
            guidance_date: None,
            historian_active: false,
            wrapup_active: false,
            caveman_english_word_rules: transform::caveman_english_word_rules(
                config.language.as_deref(),
            ),
            #[cfg(test)]
            injected_reductions: vec![],
        };
        transform::maybe_decide_live_user_hint(
            store,
            &request,
            &context,
            projection,
            &[],
            None,
            None,
            None,
            rendered_memory_ids,
        )
        .map_err(transient)
    }
    pub(super) async fn admit_host_plan(
        &self,
        binding: &SessionBinding,
        method: &str,
        params: &Value,
    ) -> Result<(), HandlerOutcome> {
        let key = Key::new(binding, &binding.session, &binding.harness)?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        let held = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?;
        if method == "transform.declare" {
            declaration(params)?;
            let plan = serde_json::to_string(&params["params"]).map_err(invalid)?;
            if let Some(held) = held {
                if held.params_json != plan {
                    return Err(invalid_field("params", "provider plan is frozen"));
                }
            } else {
                store
                    .save_provider_conversation(
                        &key.store_key(),
                        &mc_store::provider_records::ProviderConversation {
                            params_json: plan,
                            preset: params
                                .get("preset")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            engine_namespace: if attested_claude_code(binding) {
                                key.engine_key()
                            } else {
                                binding.session.clone()
                            },
                            ..Default::default()
                        },
                    )
                    .map_err(transient)?;
            }
            return Ok(());
        }
        let held = held.ok_or_else(|| {
            invalid_field(
                "params",
                "host lane requires a frozen transform.declare plan",
            )
        })?;
        let plan: Value = serde_json::from_str(&held.params_json).map_err(transient)?;
        if !answer_observation(&plan) {
            return Err(invalid_field(
                "params.observation",
                "host observation is not admitted",
            ));
        }
        if params
            .get("params")
            .is_some_and(|supplied| supplied != &plan)
        {
            return Err(invalid_field(
                "params",
                "provider call changed its frozen plan",
            ));
        }
        Ok(())
    }

    pub(super) async fn provider_hook(
        &self,
        binding: SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        use hooks::{
            answer::{HookAnswer, Operation},
            subscription::Hook,
        };
        let deadline = Instant::now() + Duration::from_millis(HOOK_BUDGET_MS);
        let mut wire = params.clone();
        // Drop raw_message before typed decoding for other profiles. It remains
        // an ignored extra for them, so a non-string value is not a new error.
        if !attested_claude_code(&binding) {
            if let Some(object) = wire.as_object_mut() {
                object.remove("raw_message");
            }
        }
        let call: hooks::hook::HookCall = decode(&wire)?;
        preset(call.preset.as_deref())?;
        let key = Key::new(&binding, &call.session, &call.harness)?;
        if attested_claude_code(&binding) {
            return self
                .provider_claude_code_hook(binding, key, &call, params)
                .await;
        }
        if matches!(binding.harness.as_str(), "opencode" | "opencode2") {
            return self.provider_host_hook(binding, key, &call, params).await;
        }
        if call.lineage_id.is_none() && call.subject.hook() != Hook::PreUser {
            return Err(invalid("lineage_id is required after the first pre_user"));
        }
        let _store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        let mut record = self.provider_store.load(&key)?;
        record.hook.get_or_insert_with(HookState::default);
        if record.catalog.is_none() {
            record.catalog = self.provider_store.catalog(&SessionBinding {
                session: key.session.clone(),
                ..binding.clone()
            })?;
        }
        let mut declaration_params = json!({"preset":call.preset,"params":call.params});
        let compacting =
            record.setup.is_some() || record.catalog.as_ref().is_some_and(|c| c.compacting);
        if compacting {
            declaration_params["composition"] =
                json!({"compaction":{"provider":DEFAULT_MODULE_ID}});
        }
        let declared = declaration(&declaration_params)?;
        let subscription = declared
            .subscriptions
            .iter()
            .find(|s| s.hook == call.subject.hook() && s.phase == call.subject.phase());
        let Some(subscription) = subscription else {
            self.provider_store.save(&key, &record)?;
            return Err(error(
                "not_subscribed",
                "hook is not declared for this plan item",
            ));
        };
        let hook_kind = call.subject.hook();
        let reminder_every = call
            .params
            .get("reminder_every")
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .max(1);
        let nudge_every = call
            .params
            .get("nudge_every")
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .max(1);
        let due = |record: &Record| {
            let state = record.hook.as_ref().expect("hook state");
            match hook_kind {
                Hook::PostTool => {
                    state
                        .observed_tools
                        .saturating_add(1)
                        .saturating_sub(state.last_reminder_at.unwrap_or(0))
                        >= reminder_every
                }
                Hook::PreUser => {
                    state.last_nudge_at.is_none()
                        || state
                            .observed_users
                            .saturating_add(1)
                            .saturating_sub(state.last_nudge_at.unwrap_or(0))
                            >= nudge_every
                }
                _ => false,
            }
        };
        let mut observed = true;
        if due(&record)
            && call.lineage_id.is_some()
            && !call.subject.blocks().unwrap_or_default().is_empty()
        {
            observed = scan(
                &self.provider_store,
                self.provider_runner.as_ref(),
                &key,
                &mut record,
                call.lineage_id.as_deref(),
                &[],
                deadline,
            )
            .await
            .is_ok();
        }
        let mut ops = Vec::new();
        let mut tags = Vec::new();
        let blocks = call.subject.blocks().unwrap_or_default();
        if hook_kind == Hook::PostAssistant {
            static TAG: OnceLock<regex::Regex> = OnceLock::new();
            let regex = TAG.get_or_init(|| regex::Regex::new(r"§[0-9]+§ ?").expect("tag regex"));
            for (index, text) in blocks.iter().enumerate() {
                let clean = regex.replace_all(text, "").into_owned();
                if clean != *text {
                    ops.push(Operation::Replace {
                        block: index as u32,
                        value: clean,
                        note: None,
                    });
                }
            }
        } else if hook_kind == Hook::PostTool && !blocks.is_empty() {
            let state = record.hook.as_mut().expect("hook state");
            state.high_water = state
                .high_water
                .checked_add(1)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or_else(|| transient("tag numbers exhausted"))?;
            tags.push(state.high_water);
            ops.push(Operation::Prepend {
                block: 0,
                text: format!("§{}§ ", state.high_water),
                note: None,
            });
        }
        let cadence = observed && Instant::now() < deadline && due(&record) && !blocks.is_empty();
        if cadence {
            let text = if hook_kind == Hook::PostTool {
                "\n\n<system-reminder>Release tool output you no longer need with ctx_reduce; queued content remains visible until a compaction pass.</system-reminder>"
            } else {
                "\n\n<system-reminder>Keep useful context and release obsolete tool output with ctx_reduce when available.</system-reminder>"
            };
            ops.push(Operation::Append {
                block: (blocks.len() - 1) as u32,
                text: text.into(),
                note: None,
            });
        }
        let answer = if ops.is_empty() {
            HookAnswer::Pass
        } else {
            HookAnswer::Ops { ops: ops.clone() }
        };
        hooks::answer::check_answer(&call.subject, &subscription.ops, None, &answer)
            .map_err(|e| transient(e.name()))?;
        let rendered = hooks::answer::apply_ops(blocks, &ops).map_err(|e| transient(e.name()))?;
        let subject = sha256_hex(&serde_json::to_vec(&call.subject).map_err(transient)?);
        let state = record.hook.as_mut().expect("hook state");
        for old in &state.answers {
            if old.subject == subject && !old.observed {
                state.burned.extend(old.tags.iter().copied());
            }
        }
        let tool_call_id = match &call.subject {
            hooks::hook::Subject::PostTool { tool_call_id, .. } => Some(tool_call_id.clone()),
            _ => None,
        };
        state.answers.push(HookRecord {
            subject,
            lineage: call.lineage_id,
            answer: answer.clone(),
            rendered,
            tags,
            cadence,
            observed: false,
            tool_call_id,
        });
        self.provider_store.save(&key, &record)?;
        fault("HookStateRecorded");
        bytes(&answer)
    }

    pub(crate) async fn handle_provider_reduce(
        &self,
        channel: u16,
        requested: &[u64],
    ) -> HandlerOutcome {
        if let Ok(binding) = self.facade_binding(channel) {
            if let Some((key, _)) = self.host_provider_conversation(&binding) {
                return self
                    .provider_host_reduce(key, requested)
                    .await
                    .unwrap_or_else(|error| error);
            }
        }
        let result: Result<HandlerOutcome, HandlerOutcome> = async {
            let binding = self
                .facade_binding(channel)
                .map_err(|_| session_unresolved_error())?;
            let key = self.provider_store.tool_key(&binding)?;
            let _serial = self.provider_serial.lock_for(&key).await;
            let mut record = self.provider_store.load(&key)?;
            let needs_read = requested.iter().any(|n| {
                record
                    .hook
                    .as_ref()
                    .is_none_or(|h| !h.live.contains_key(n) && !h.burned.contains(n))
            });
            if needs_read {
                let lineage = record.messages.keys().next_back().cloned();
                scan(
                    &self.provider_store,
                    self.provider_runner.as_ref(),
                    &key,
                    &mut record,
                    lineage.as_deref(),
                    requested,
                    Instant::now() + Duration::from_millis(HOOK_BUDGET_MS),
                )
                .await?;
            }
            let live = record.hook.as_ref().map(|h| &h.live);
            let (known, unknown): (Vec<_>, Vec<_>) = requested
                .iter()
                .copied()
                .partition(|n| live.is_some_and(|l| l.contains_key(n)));
            let already = known
                .iter()
                .copied()
                .filter(|n| record.pending_drops.contains(n))
                .collect::<Vec<_>>();
            let queue = known
                .iter()
                .copied()
                .filter(|n| !record.pending_drops.contains(n))
                .collect::<Vec<_>>();
            record.pending_drops.extend(queue.iter().copied());
            self.provider_store.save(&key, &record)?;
            let detail = ctx_reduce_ack_details(&unknown);
            if queue.is_empty() {
                if unknown.is_empty() && !already.is_empty() {
                    return Ok(mcp_text_result(ctx_reduce_reply(already.len(), 0), false));
                }
                return Ok(tool_error_result(format!(
                    "Refused: no valid tags to queue. {detail}"
                )));
            }
            // Acknowledge stamps without promising when protected content will be released.
            let mut reply = ctx_reduce_reply(queue.len() + already.len(), 0);
            if !detail.is_empty() {
                reply.push(' ');
                reply.push_str(&detail);
                reply.push('.');
            }
            Ok(mcp_text_result(reply, false))
        }
        .await;
        match result {
            Ok(answer) => answer,
            Err(error) => {
                let message =
                    format!("Transcript observation incomplete; retry ctx_reduce: {error:?}");
                let HandlerOutcome::Response(bytes) = tool_error_result(message) else {
                    unreachable!()
                };
                let mut value: Value = serde_json::from_slice(&bytes).expect("tool error JSON");
                value["retryable"] = json!(true);
                respond(value)
            }
        }
    }
}

#[cfg(test)]
mod host_tests {
    use super::*;
    use hooks::{
        answer::{HookAnswer, Operation},
        hook::HookCall,
    };

    struct NoReads;
    #[async_trait]
    impl session_resolver::ProviderRunner for NoReads {
        async fn call(
            &self,
            _: &Path,
            _: &str,
            method: &str,
            _: Value,
            _: Duration,
        ) -> Result<Value, SessionResolveError> {
            panic!("answer observation must never issue {method}");
        }
    }
    pub(super) fn handler(dir: &Path) -> McHandler {
        let descriptor = StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into(),
            },
        };
        let mut h = McHandler::new();
        h.store
            .set(Arc::new(McStore::open_for_test(&descriptor).unwrap()))
            .ok()
            .unwrap();
        h.provider_runner = Arc::new(NoReads);
        for (channel, session) in [(7, "s"), (8, "t")] {
            h.bind_route(
                channel,
                SessionBinding {
                    connection_incarnation: 0,
                    native_generation: None,
                    principal: None,
                    project_root: dir.into(),
                    harness: "opencode".into(),
                    session: session.into(),
                    model_key: None,
                    config: McModuleConfig {
                        inject_docs: false,
                        memory_enabled: false,
                        ..Default::default()
                    },
                    history_budget_tokens: 4000.0,
                },
            );
        }
        h
    }
    fn plan() -> Value {
        json!({"serializer_profile":"opencode-aisdk","observation":"answer"})
    }
    pub(super) async fn dispatch(
        h: &McHandler,
        ch: u16,
        method: &str,
        params: Value,
    ) -> HandlerOutcome {
        h.dispatch_value(ch, json!({"method":method,"params":params}))
            .await
    }
    pub(super) fn response(outcome: HandlerOutcome) -> Value {
        match outcome {
            HandlerOutcome::Response(b) => serde_json::from_slice(&b).unwrap(),
            error => panic!("{error:?}"),
        }
    }
    pub(super) async fn admit(h: &McHandler, ch: u16) {
        response(dispatch(h, ch, "transform.declare", json!({"params":plan()})).await);
    }
    pub(super) async fn sync_pass(h: &McHandler, appended: &[(u64, Value)]) {
        let tail = appended
            .last()
            .map(|(ordinal, message)| json!({"mid":message["info"]["id"],"ordinal":ordinal}));
        response(h.dispatch_value(7,json!({"method":"state_sync","session_id":"s","provider_pass":{"lineage_id":"L","appended":appended.iter().map(|(ordinal,message)|json!({"mid":message["info"]["id"],"ordinal":ordinal,"message":message})).collect::<Vec<_>>(),"physical_tail":tail,"exact_pass_plan":"hard"}})).await);
    }
    pub(super) fn text(mid: &str, role: &str, value: &str) -> Value {
        json!({"info":{"id":mid,"role":role},"parts":[{"id":format!("{mid}-text"),"type":"text","text":value}]})
    }
    pub(super) fn hook(
        mid: &str,
        ordinal: u64,
        kind: &str,
        blocks: &[&str],
        message: Value,
    ) -> Value {
        let mut p = json!({"session":"s","harness":"opencode","params":plan(),"lineage_id":"L","subject_mid":mid,"subject_ordinal":ordinal,"message":message,"hook":kind,"blocks":blocks,"step_id":"step"});
        if kind == "post_tool" {
            p["tool"] = json!("read");
            p["tool_call_id"] = json!("repeat");
            p["is_error"] = json!(false);
        }
        p
    }
    #[tokio::test]
    async fn pre_switch_engine_tags_queue_in_full_request_delivery_lane() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        let store = h.store.get().unwrap();
        store
            .seed_tags_for_test(
                "s",
                &[mc_store::TagMintInput {
                    block_id: "old#0".into(),
                    kind: "message".into(),
                    token_count: 1,
                    source_bytes: b"old".to_vec(),
                }],
                1,
            )
            .unwrap();
        let answer = response(h.handle_provider_reduce(7, &[1]).await);
        assert!(
            answer["content"][0]["text"]
                .as_str()
                .unwrap()
                .eq("1 tag stamped."),
            "{answer}"
        );
        assert_eq!(
            store.load_pending_agent_drops("s").unwrap()[0].target_id,
            "old#0"
        );
        let key = Key::new(&h.facade_binding(7).unwrap(), "s", "opencode").unwrap();
        assert!(store
            .load_provider_pending_drops(&key.store_key())
            .unwrap()
            .is_empty());
        let repeat = response(h.handle_provider_reduce(7, &[1]).await);
        assert!(repeat["content"][0]["text"]
            .as_str()
            .unwrap()
            .eq("1 tag stamped."));
        assert_eq!(store.load_pending_agent_drops("s").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn consumed_hook_tag_is_refused_after_answer_row_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        let p = hook("u", 1, "pre_user", &["hello"], text("u", "user", "hello"));
        response(dispatch(&h, 7, "transform.hook", p).await);
        let mut confirm = hook("v", 2, "pre_user", &["next"], text("v", "user", "next"));
        confirm["served_through_ordinal"] = json!(1);
        response(dispatch(&h, 7, "transform.hook", confirm).await);
        let store = h.store.get().unwrap();
        let key = Key::new(&h.facade_binding(7).unwrap(), "s", "opencode").unwrap();
        store.queue_provider_drops(&key.store_key(), &[1]).unwrap();
        store
            .consume_provider_drops(&key.store_key(), &[1])
            .unwrap();
        store
            .execute_tag_sql_for_test(
                "DELETE FROM mc_provider_hook_answers_v1 WHERE subject_mid='u'",
            )
            .unwrap();
        assert!(store
            .load_tags_for_session("s")
            .unwrap()
            .iter()
            .any(|tag| tag.tag_number == 1));
        let answer = response(h.handle_provider_reduce(7, &[1]).await);
        assert_eq!(answer["isError"], true);
        assert!(answer["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not found"));
        assert!(store.load_pending_agent_drops("s").unwrap().is_empty());
    }

    #[tokio::test]
    async fn pre_switch_engine_tag_from_another_namespace_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        let store = h.store.get().unwrap();
        store
            .seed_tags_for_test(
                "t",
                &[mc_store::TagMintInput {
                    block_id: "foreign#0".into(),
                    kind: "message".into(),
                    token_count: 1,
                    source_bytes: b"foreign".to_vec(),
                }],
                1,
            )
            .unwrap();
        let answer = response(h.handle_provider_reduce(7, &[1]).await);
        assert_eq!(answer["isError"], true);
        assert!(store.load_pending_agent_drops("s").unwrap().is_empty());
        assert!(store.load_pending_agent_drops("t").unwrap().is_empty());
    }

    fn rendered(params: &Value, answer: Value) -> Vec<String> {
        let call: HookCall = decode(params).unwrap();
        let answer: HookAnswer = decode(&answer).unwrap();
        match answer {
            HookAnswer::Pass => call.subject.blocks().unwrap().to_vec(),
            HookAnswer::Ops { ops } => {
                hooks::answer::apply_ops(call.subject.blocks().unwrap(), &ops).unwrap()
            }
            _ => panic!("not text"),
        }
    }
    pub(super) fn key(h: &McHandler) -> Key {
        Key::new(&h.facade_binding(7).unwrap(), "s", "opencode").unwrap()
    }

    #[tokio::test]
    async fn host_tags_use_engine_numbers_kinds_blocks_and_overlay_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        let store = h.store.get().unwrap();
        // A switched namespace keeps the engine's allocator, not S3 high_water.
        store
            .save_provider_conversation(
                &key(&h).store_key(),
                &mc_store::provider_records::ProviderConversation {
                    engine_namespace: "s".into(),
                    params_json: plan().to_string(),
                    hook_counters_json: "{\"tag_high_water\":40}".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let p = hook("u", 1, "pre_user", &["hello"], text("u", "user", "hello"));
        let answer = response(dispatch(&h, 7, "transform.hook", p.clone()).await);
        assert_eq!(rendered(&p, answer), ["§41§ hello"]);
        assert!(store.load_tags_for_session("s").unwrap().is_empty());
        let mut p = hook(
            "a",
            2,
            "post_assistant",
            &["§7§ answer references §3§ inline"],
            text("a", "assistant", "§7§ answer references §3§ inline"),
        );
        p["served_through_ordinal"] = json!(1);
        let answer = response(dispatch(&h, 7, "transform.hook", p.clone()).await);
        assert_eq!(rendered(&p, answer), ["§42§ answer references §3§ inline"]);
        let rows = store.load_tags_for_session("s").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].tag_number,
                rows[0].block_id.as_str(),
                rows[0].kind.as_str()
            ),
            (41, "u#0", "message")
        );
        let entry = compact::status::StatusMessage {
            raw_message: None,
            mid: "a".into(),
            ordinal: 2,
            message: p["message"].clone(),
        };
        let ingress = codec::Codec::OpencodeAiSdk.decode_message(&entry).unwrap();
        let mut block = ingress.ck.content[0].clone();
        transform::apply_tag_prefix_to_block(
            "assistant",
            &mut block,
            transform::TaggableKind::Message,
            42,
        );
        let mc_store::CkKind::Text { text } = block.kind else {
            panic!()
        };
        assert_eq!(text, "§42§ answer references §3§ inline");
        assert_eq!(
            store
                .load_provider_conversation(&key(&h).store_key())
                .unwrap()
                .unwrap()
                .engine_namespace,
            "s"
        );
        assert!(Key::new(&h.facade_binding(7).unwrap(), "s", "broca")
            .unwrap()
            .engine_key()
            .starts_with("mc-provider:"));
    }

    #[tokio::test]
    async fn assistant_text_and_two_repeated_call_id_parts_keep_three_answers_and_one_ingest() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        let message = json!({"info":{"id":"a","role":"assistant"},"parts":[{"id":"txt","type":"text","text":"answer"},{"id":"p1","type":"tool","callID":"repeat","tool":"read","state":{"status":"completed","input":{},"output":"same"}},{"id":"p2","type":"tool","callID":"repeat","tool":"read","state":{"status":"completed","input":{},"output":"same"}}]});
        response(
            dispatch(
                &h,
                7,
                "transform.hook",
                hook("a", 1, "post_assistant", &["answer"], message.clone()),
            )
            .await,
        );
        for part in ["p1", "p2"] {
            let mut p = hook("a", 1, "post_tool", &["same"], message.clone());
            p["subject_part"] = json!(part);
            let answer = response(dispatch(&h, 7, "transform.hook", p.clone()).await);
            assert!(rendered(&p, answer)[0].contains("§"));
        }
        let store = h.store.get().unwrap();
        assert_eq!(
            store
                .load_provider_messages(&key(&h).store_key(), "L")
                .unwrap()
                .len(),
            1
        );
        let mut retry = hook("a", 1, "post_tool", &["same"], message.clone());
        retry["subject_part"] = json!("p1");
        response(dispatch(&h, 7, "transform.hook", retry).await);
        let mut p = hook("u", 2, "pre_user", &["next"], text("u", "user", "next"));
        p["served_through_ordinal"] = json!(1);
        p["pass_complete"] = json!(true);
        response(dispatch(&h, 7, "transform.hook", p).await);
        let answers = store
            .load_provider_hook_answers(&key(&h).store_key())
            .unwrap();
        assert_eq!(answers.iter().filter(|a| a.state == "live").count(), 3);
        assert_eq!(answers.iter().filter(|a| a.state == "burned").count(), 1);
        let tags = store.load_tags_for_session("s").unwrap();
        assert_eq!(
            tags.iter()
                .map(|t| t.block_id.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["a#0", "a#2", "a#4"])
        );
        assert!(!tags.iter().any(|t| t.tag_number == 2));
        let counters: Value = serde_json::from_str(
            &store
                .load_provider_conversation(&key(&h).store_key())
                .unwrap()
                .unwrap()
                .hook_counters_json,
        )
        .unwrap();
        assert_eq!(
            counters["pass_complete"],
            json!({"lineage_id":"L","through_ordinal":2})
        );
    }

    #[tokio::test]
    async fn opencode_exact_retry_keeps_new_reservation_behavior() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        let params = hook("u", 1, "pre_user", &["hello"], text("u", "user", "hello"));
        let first = response(dispatch(&h, 7, "transform.hook", params.clone()).await);
        assert_eq!(rendered(&params, first), ["§1§ hello"]);
        let retry = response(dispatch(&h, 7, "transform.hook", params.clone()).await);
        assert_eq!(rendered(&params, retry), ["§2§ hello"]);
        let rows = h
            .store
            .get()
            .unwrap()
            .load_provider_hook_answers(&key(&h).store_key())
            .unwrap();
        assert_eq!(
            rows.iter().map(|a| a.state.as_str()).collect::<Vec<_>>(),
            ["burned", "pending"]
        );
        assert_eq!(rows[0].answer.tags[0].number, 1);
        assert_eq!(rows[1].answer.tags[0].number, 2);
    }

    #[tokio::test]
    async fn unserved_subjects_burn_before_promotion_and_descents_burn_only_discarded_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        for (mid, n) in [("u1", 1), ("u2", 2)] {
            response(
                dispatch(
                    &h,
                    7,
                    "transform.hook",
                    hook(
                        mid,
                        n,
                        "pre_user",
                        &["continue"],
                        text(mid, "user", "continue"),
                    ),
                )
                .await,
            );
        }
        let mut p = hook(
            "u3",
            3,
            "pre_user",
            &["continue"],
            text("u3", "user", "continue"),
        );
        p["served_through_ordinal"] = json!(2);
        p["unserved_subjects"] = json!([{"subject_mid":"u1","hook":"pre_user"},{"subject_mid":"never","hook":"pre_user"}]);
        response(dispatch(&h, 7, "transform.hook", p).await);
        let store = h.store.get().unwrap();
        assert_eq!(
            store
                .load_tags_for_session("s")
                .unwrap()
                .iter()
                .map(|t| t.tag_number)
                .collect::<Vec<_>>(),
            [2]
        );
        let mut p = hook(
            "branch",
            3,
            "pre_user",
            &["new"],
            text("branch", "user", "new"),
        );
        p["lineage_id"] = json!("B");
        p["descends_from"] = json!({"lineage_id":"L","through_ordinal":2});
        p["served_through_ordinal"] = json!(2);
        response(dispatch(&h, 7, "transform.hook", p).await);
        let answers = store
            .load_provider_hook_answers(&key(&h).store_key())
            .unwrap();
        assert_eq!(answers.iter().filter(|a| a.state == "burned").count(), 2);
        assert_eq!(answers.iter().filter(|a| a.state == "live").count(), 1);
        let totals = store
            .load_provider_policy_totals(&key(&h).store_key())
            .unwrap();
        assert_eq!(totals.real_users, 2);
        let mut bad = hook("bad", 4, "pre_user", &["new"], text("bad", "user", "new"));
        bad["lineage_id"] = json!("bad");
        bad["descends_from"] = json!({"lineage_id":"missing","through_ordinal":2});
        assert!(
            matches!(dispatch(&h,7,"transform.hook",bad).await,HandlerOutcome::Error {code,..} if code=="transient")
        );
    }

    #[tokio::test]
    async fn host_admission_uses_bind_and_frozen_plan_never_body_harness() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        assert!(
            matches!(dispatch(&h,7,"transform.declare",json!({"params":{"serializer_profile":"opencode-aisdk"}})).await,HandlerOutcome::ErrorWithDetail {code,detail,..} if code=="invalid_params" && detail["field"]=="params.observation")
        );
        admit(&h, 7).await;
        let mut p = hook("u", 1, "pre_user", &["hi"], text("u", "user", "hi"));
        p["session"] = json!("other");
        assert!(
            matches!(dispatch(&h,7,"transform.hook",p).await,HandlerOutcome::ErrorWithDetail {detail,..} if detail["field"]=="session")
        );
        let mut binding = h.facade_binding(8).unwrap();
        binding.harness = "runner".into();
        h.bind_route(8, binding);
        for method in ["transform.declare", "compaction.setup"] {
            assert!(
                matches!(dispatch(&h,8,method,json!({"harness":"opencode","params":plan()})).await,HandlerOutcome::ErrorWithDetail {code,detail,..} if code=="invalid_params" && detail["field"]=="params.observation")
            );
        }
        assert_eq!(runner_groups(), ["transcript_reads"]);
        for value in ["".to_string(), "é".repeat(129)] {
            let mut p = hook("u", 1, "post_tool", &[], text("u", "assistant", ""));
            p["subject_part"] = json!(value);
            assert!(
                matches!(dispatch(&h,7,"transform.hook",p).await,HandlerOutcome::ErrorWithDetail {detail,..} if detail["field"]=="subject_part")
            );
        }
    }

    #[tokio::test]
    async fn conversations_run_concurrently_and_same_conversation_setup_step_and_work_serialize() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        admit(&h, 8).await;
        let held = h.provider_serial.lock_for(&key(&h)).await;
        let mut p = hook("u", 1, "pre_user", &["hi"], text("u", "user", "hi"));
        p["session"] = json!("t");
        response(
            tokio::time::timeout(Duration::from_secs(1), dispatch(&h, 8, "transform.hook", p))
                .await
                .expect("other conversation queued behind s"),
        );
        for method in ["compaction.setup", "compaction.step"] {
            let p = if method == "compaction.setup" {
                json!({"session":"s","harness":"opencode","request_id":"r","params":plan(),"model":"fixture","context_window":100000,"now":1,"lineage_id":"L"})
            } else {
                json!({"session":"s","harness":"opencode","request_id":"r","lineage_id":"L","step_id":"st","step_kind":"user_turn","model":"fixture","context_window":100000,"estimate":{"request_tokens":1},"messages":[],"now":1})
            };
            assert!(
                tokio::time::timeout(Duration::from_millis(20), dispatch(&h, 7, method, p))
                    .await
                    .is_err()
            );
        }
        assert!(
            tokio::time::timeout(
                Duration::from_millis(20),
                h.provider_serial.lock_for(&key(&h))
            )
            .await
            .is_err(),
            "background work shares the conversation lock"
        );
        drop(held);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), h.provider_serial.lock_for(&key(&h)))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn state_sync_records_chain_and_barrier_and_provider_reduce_routes_pending_not_burned_tags(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        let p = hook("u", 1, "pre_user", &["hi"], text("u", "user", "hi"));
        response(dispatch(&h, 7, "transform.hook", p.clone()).await);
        response(h.dispatch_value(7,json!({"method":"state_sync","session_id":"s","shadow_generation":0,"expected_shadow_seq":0,"historian_model_chain":["provider/a"],"pass_complete":true})).await);
        let c = h
            .store
            .get()
            .unwrap()
            .load_provider_conversation(&key(&h).store_key())
            .unwrap()
            .unwrap();
        assert_eq!(c.historian_model_chain_json, "[\"provider/a\"]");
        assert_eq!(
            serde_json::from_str::<Value>(&c.hook_counters_json).unwrap()["pass_complete"],
            json!({"lineage_id":"L","through_ordinal":1})
        );
        let reduced = response(
            h.dispatch_value(7, json!({"name":"ctx_reduce","arguments":{"drop":"1"}}))
                .await,
        );
        assert_eq!(reduced["isError"], false);
        response(dispatch(&h, 7, "transform.hook", p).await);
        let reduced = response(
            h.dispatch_value(7, json!({"name":"ctx_reduce","arguments":{"drop":"1"}}))
                .await,
        );
        assert_eq!(reduced["isError"], true);
        assert!(h
            .store
            .get()
            .unwrap()
            .load_provider_pending_drops(&key(&h).store_key())
            .unwrap()
            .is_empty());
        response(
            h.dispatch_value(
                7,
                json!({"method":"state_sync","session_id":"s","pass_complete":true}),
            )
            .await,
        );
    }

    #[test]
    fn channel1_cadence_and_temporal_bytes_equal_engine_policy_on_corpus() {
        let mut state = json!({});
        for (u, t, users) in [
            (0, 10000, 1),
            (30000, 100000, 2),
            (55000, 100000, 3),
            (90000, 150000, 5),
            (0, 30000, 6),
            (35000, 100000, 7),
        ] {
            let totals = ProviderPolicyTotals {
                text_tokens: t - u,
                tool_tokens: u,
                reclaimable_tokens: u,
                tool_outputs: 3,
                real_users: users,
            };
            let metrics = ProviderPolicyTotals {
                tool_outputs: 1,
                ..Default::default()
            };
            let meta = channel1_meta(&state);
            let baseline = mc_store::TailHygieneBaseline {
                baseline_u: u,
                baseline_t: t,
                evaluable: true,
                ..Default::default()
            };
            let decision = transform::decide_channel1(Some(&baseline), &meta, users as u64);
            let inputs = transform::Channel1PolicyInputs {
                baseline: baseline.clone(),
                users: users as u64,
                tool_outputs: (totals.tool_outputs + metrics.tool_outputs) as usize,
                hint: vec![],
                carrier: true,
            };
            let (ops, next) = host_channel1(&inputs, &state);
            if decision.fire {
                assert_eq!(
                    ops,
                    vec![Operation::Append {
                        block: 0,
                        text: transform::build_channel1_reminder(
                            decision.level,
                            u,
                            4,
                            &[],
                            decision.sticky
                        ),
                        note: None
                    }]
                );
            } else {
                assert!(ops.is_empty());
            }
            state = next;
        }
        assert_eq!(
            transform::temporal_gap_prefix(5 * 60 * 1000),
            Some("<!-- +5m -->\n".into())
        );
        assert_eq!(
            transform::temporal_gap_prefix(2 * 60 * 60 * 1000 + 4 * 60 * 1000),
            Some("<!-- +2h 4m -->\n".into())
        );
    }
}

#[cfg(test)]
mod confirmation_tests {
    use super::host_tests::*;
    use super::*;
    #[tokio::test]
    async fn host_confirmation_is_newest_bounded_monotonic_and_only_descent_clamps() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        admit(&h, 7).await;
        response(
            dispatch(
                &h,
                7,
                "transform.hook",
                hook("u1", 1, "pre_user", &["one"], text("u1", "user", "one")),
            )
            .await,
        );
        let mut p = hook("u2", 2, "pre_user", &["two"], text("u2", "user", "two"));
        p["served_through_ordinal"] = json!(5);
        assert!(
            matches!(dispatch(&h,7,"transform.hook",p.clone()).await,HandlerOutcome::ErrorWithDetail {code,detail,..} if code=="invalid_params" && detail["field"]=="served_through_ordinal")
        );
        p["served_through_ordinal"] = json!(1);
        response(dispatch(&h, 7, "transform.hook", p).await);
        let mut p = hook("u3", 3, "pre_user", &["three"], text("u3", "user", "three"));
        p["served_through_ordinal"] = json!(0);
        assert!(
            matches!(dispatch(&h,7,"transform.hook",p.clone()).await,HandlerOutcome::ErrorWithDetail {detail,..} if detail["field"]=="served_through_ordinal")
        );
        p.as_object_mut().unwrap().remove("served_through_ordinal");
        response(dispatch(&h, 7, "transform.hook", p).await);
        let store = h.store.get().unwrap();
        let c = store
            .load_provider_conversation(&key(&h).store_key())
            .unwrap()
            .unwrap();
        assert_eq!(c.served_through_ordinal, Some(1));
        assert_eq!(store.load_tags_for_session("s").unwrap().len(), 1);
        let mut p = hook("u4", 4, "pre_user", &["four"], text("u4", "user", "four"));
        p["served_through_ordinal"] = json!(3);
        response(dispatch(&h, 7, "transform.hook", p).await);
        let mut p = hook(
            "branch",
            3,
            "pre_user",
            &["branch"],
            text("branch", "user", "branch"),
        );
        p["lineage_id"] = json!("B");
        p["descends_from"] = json!({"lineage_id":"L","through_ordinal":2});
        p["served_through_ordinal"] = json!(2);
        response(dispatch(&h, 7, "transform.hook", p).await);
        assert_eq!(
            store
                .load_provider_conversation(&key(&h).store_key())
                .unwrap()
                .unwrap()
                .served_through_ordinal,
            Some(2)
        );
        let mut p = hook("b4", 4, "pre_user", &["four"], text("b4", "user", "four"));
        p["lineage_id"] = json!("B");
        p["served_through_ordinal"] = json!(1);
        assert!(
            matches!(dispatch(&h,7,"transform.hook",p).await,HandlerOutcome::ErrorWithDetail {detail,..} if detail["field"]=="served_through_ordinal")
        );
    }
}

#[cfg(test)]
mod golden_tests {
    use super::host_tests::*;
    use super::*;
    #[tokio::test]
    async fn owned_broca_declaration_and_hook_corpus_remain_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        let mut binding = h.facade_binding(7).unwrap();
        binding.harness = "runner".into();
        h.bind_route(7, binding);
        let params = json!({"params":{"serializer_profile":"owned-broca"}});
        let expected=br#"{"subscriptions":[{"hook":"pre_user","ops":["append"],"on_unavailable":"pass","budget_ms":1500},{"hook":"post_tool","ops":["prepend","append"],"on_unavailable":"pass","budget_ms":1500},{"hook":"post_assistant","ops":["replace"],"on_unavailable":"pass","budget_ms":1500}]}"#;
        let HandlerOutcome::Response(declared) = dispatch(&h, 7, "transform.declare", params).await
        else {
            panic!()
        };
        assert_eq!(
            String::from_utf8_lossy(&declared),
            String::from_utf8_lossy(expected)
        );
        let corpus = [
            (
                json!({"session":"s","harness":"broca","hook":"pre_user","blocks":[]}),
                r#"{"answer":"pass"}"#,
            ),
            (
                json!({"session":"s","harness":"broca","lineage_id":"L","hook":"post_tool","step_id":"step","tool":"read","tool_call_id":"id","blocks":["output"],"is_error":false,"params":{"reminder_every":100}}),
                r#"{"answer":"ops","ops":[{"op":"prepend","block":0,"text":"§1§ "}]}"#,
            ),
            (
                json!({"session":"s","harness":"broca","lineage_id":"L","hook":"post_assistant","step_id":"step","blocks":["§1§ alpha"]}),
                r#"{"answer":"ops","ops":[{"op":"replace","block":0,"value":"alpha"}]}"#,
            ),
        ];
        for (params, expected) in corpus {
            let HandlerOutcome::Response(actual) = dispatch(&h, 7, "transform.hook", params).await
            else {
                panic!()
            };
            assert_eq!(String::from_utf8_lossy(&actual), expected);
        }
    }
}

#[cfg(test)]
mod overlay_parity_tests {
    use super::host_tests::*;
    use super::*;
    #[tokio::test]
    async fn host_temporal_prefix_and_user_hint_match_engine_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        let mut binding = h.facade_binding(7).unwrap();
        binding.config.memory_enabled = true;
        h.bind_route(7, binding.clone());
        let mut params = json!({"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
        response(dispatch(&h, 7, "transform.declare", json!({"params":params})).await);
        let store = h.store.get().unwrap();
        let project = h.route_project(store, &binding).unwrap().key;
        for n in 1..=30 {
            store
                .seed_memory(
                    n,
                    &project,
                    "CONSTRAINTS",
                    if n == 1 {
                        "rust ownership beta"
                    } else {
                        "unrelated archive material"
                    },
                    20,
                )
                .unwrap();
        }
        let mut message = text("a", "assistant", "reply");
        message["info"]["time"] = json!({"created":0,"completed":1000});
        let mut p = hook("a", 1, "post_assistant", &["reply"], message);
        p["params"] = params.clone();
        response(dispatch(&h, 7, "transform.hook", p).await);
        let mut message = text("u", "user", "rust ownership beta");
        message["info"]["time"] = json!({"created":301000});
        let mut p = hook("u", 2, "pre_user", &["rust ownership beta"], message);
        super::host_tests::sync_pass(&h, &[(2, p["message"].clone())]).await;
        p["params"] = params.take();
        let answer: hooks::answer::HookAnswer = decode(&response(
            dispatch(&h, 7, "transform.hook", p.clone()).await,
        ))
        .unwrap();
        let hooks::answer::HookAnswer::Ops { ops } = answer else {
            panic!()
        };
        let hint = ops
            .iter()
            .find_map(|op| {
                if let hooks::answer::Operation::Append { text, .. } = op {
                    Some(text)
                } else {
                    None
                }
            })
            .expect("seeded lexical fixture must yield a nonempty hint");
        assert_eq!(hint,"\n\n<ctx-search-hint>\nYour memory may contain 1 related fragment:\n- rust ownership beta\nIf the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.\n</ctx-search-hint>");
        let call: hooks::hook::HookCall = decode(&p).unwrap();
        let rendered = hooks::answer::apply_ops(call.subject.blocks().unwrap(), &ops).unwrap();
        assert_eq!(
            rendered,
            [format!("§2§ <!-- +5m -->\nrust ownership beta{hint}")]
        );
    }
}

#[cfg(test)]
mod admission_hook_tests {
    use super::super::claude_code_tests::{call, handler, setup, step, thalamus};
    use super::*;
    use hooks::answer::{HookAnswer, Operation};

    fn response(outcome: HandlerOutcome) -> Value {
        let HandlerOutcome::Response(bytes) = outcome else {
            panic!("{outcome:?}")
        };
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn fixture(
        auto_tag: bool,
        composition: Option<Value>,
    ) -> (tempfile::TempDir, McHandler, Key) {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path(), thalamus());
        let mut declare = json!({"session":"cc","harness":"claude-code","params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"preset":"head"});
        if let Some(composition) = composition {
            declare["composition"] = composition;
        }
        response(call(&h, "transform.declare", declare).await);
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        let mut held = store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap();
        let mut counters = json!({"reserved_tag_high_water":40});
        if auto_tag {
            counters["auto_tag"] = json!(true);
        }
        held.hook_counters_json = counters.to_string();
        store
            .save_provider_conversation(&key.store_key(), &held)
            .unwrap();
        (dir, h, key)
    }

    fn hook(raw: &str, mid: &str, ordinal: u64, kind: &str, blocks: &[&str]) -> Value {
        let mut params = json!({"session":"cc","harness":"claude-code","lineage_id":"L","step_id":"hook","params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},
            "subject_mid":mid,"subject_ordinal":ordinal,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,"hook":kind,"blocks":blocks});
        if kind == "post_tool" {
            params["subject_part"] = json!("call-a");
            params["tool_call_id"] = json!("call-a");
            params["tool"] = json!("Read");
            params["is_error"] = serde_json::from_str::<Value>(raw).unwrap()["content"]
                .as_array()
                .unwrap()
                .iter()
                .find(|b| b["type"] == "tool_result")
                .and_then(|b| b["is_error"].as_bool())
                .unwrap_or(false)
                .into();
        }
        params
    }

    async fn run(h: &McHandler, params: Value) -> HookAnswer {
        serde_json::from_value(response(call(h, "transform.hook", params).await)).unwrap()
    }

    fn assert_prepends(
        h: &McHandler,
        key: &Key,
        answer: HookAnswer,
        mid: &str,
        expected: &[(u32, usize, i64)],
    ) {
        let ops = expected
            .iter()
            .map(|(hook_index, _, number)| Operation::Prepend {
                block: *hook_index,
                text: format!("§{number}§ "),
                note: None,
            })
            .collect::<Vec<_>>();
        assert_eq!(answer, HookAnswer::Ops { ops: ops.clone() });
        let answers = h
            .store
            .get()
            .unwrap()
            .load_provider_hook_answers(&key.store_key())
            .unwrap();
        let stored = &answers
            .iter()
            .rev()
            .find(|a| a.answer.subject.subject_mid == mid)
            .unwrap()
            .answer;
        assert_eq!(stored.ops_json, serde_json::to_string(&ops).unwrap());
        assert_eq!(stored.tags.len(), expected.len());
        for (tag, (_, native_index, number)) in stored.tags.iter().zip(expected) {
            assert_eq!(tag.block_id, format!("{mid}#{native_index}"));
            assert_eq!(tag.number, *number);
        }
    }

    async fn pair_call(h: &McHandler) {
        let raw = r#"{"role":"assistant","content":[{"type":"tool_use","id":"call-a","name":"Read","input":{"path":"a"}}]}"#;
        assert_eq!(
            run(h, hook(raw, "call", 0, "post_assistant", &[])).await,
            HookAnswer::Pass
        );
    }

    fn pending(h: &McHandler) -> Value {
        response(h.handle_session_status_value(7, &json!({"v":1,"session_id":"cc"})))["cc_pending"]
            .clone()
    }

    fn counters(h: &McHandler, key: &Key) -> Value {
        serde_json::from_str(
            &h.store
                .get()
                .unwrap()
                .load_provider_conversation(&key.store_key())
                .unwrap()
                .unwrap()
                .hook_counters_json,
        )
        .unwrap()
    }

    fn hold(h: &McHandler, key: &Key, lineage: &ProviderLineage, raws: &[(&str, u64, &str)]) {
        let messages = raws
            .iter()
            .map(|(mid, ordinal, raw)| ProviderMessage {
                mid: (*mid).into(),
                ordinal: *ordinal,
                message_bytes: serde_json::to_vec(
                    &super::super::codec_claude_code::from_wire(
                        &serde_json::from_str::<Value>(raw).unwrap(),
                        Some(raw),
                    )
                    .unwrap(),
                )
                .unwrap(),
            })
            .collect::<Vec<_>>();
        h.store
            .get()
            .unwrap()
            .commit_provider_status(&key.store_key(), lineage, &messages, None, &[])
            .unwrap();
    }

    fn root() -> ProviderLineage {
        ProviderLineage {
            lineage_id: "L".into(),
            first_ordinal: 0,
            descends_from: None,
            through_ordinal: None,
        }
    }

    #[tokio::test]
    async fn cc_pending_reason_freshness_counts_unanswered_bootstrap_parts() {
        let (_dir, h, key) = fixture(true, None).await;
        setup(&h).await;
        response(call(&h, "compaction.step", step(r#"{"role":"user","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]}"#)).await);
        assert_eq!(
            pending(&h),
            json!({"count":2,"reasons":{"freshness_unproven":2}})
        );
        assert_eq!(counters(&h, &key)["pending_logged"], true);
    }

    #[tokio::test]
    async fn cc_pending_reason_mixed_text_excludes_covered_results() {
        let (_dir, h, key) = fixture(true, None).await;
        pair_call(&h).await;
        let raw = r#"{"role":"user","content":[{"type":"text","text":"mixed"},{"type":"tool_result","tool_use_id":"call-a","content":"result"}]}"#;
        assert_eq!(
            run(&h, hook(raw, "u", 1, "pre_user", &["mixed"])).await,
            HookAnswer::Pass
        );
        run(&h, hook(raw, "u", 1, "post_tool", &["result"])).await;
        h.store
            .get()
            .unwrap()
            .record_provider_hook_failure(
                &key.store_key(),
                &ProviderSubject {
                    subject_mid: "u".into(),
                    hook: "pre_user".into(),
                    subject_part: "".into(),
                },
            )
            .unwrap();
        assert_eq!(
            pending(&h),
            json!({"count":1,"reasons":{"mixed_user_text":1}})
        );
    }

    #[tokio::test]
    async fn cc_pending_reason_signed_hold_precedes_failed_subject() {
        let (_dir, h, key) = fixture(true, None).await;
        let raw = r#"{"role":"assistant","content":[{"type":"text","text":"held"},{"type":"redacted_thinking","data":"signed"},{"type":"text","text":"tagged"}]}"#;
        run(&h, hook(raw, "a", 0, "post_assistant", &["held", "tagged"])).await;
        h.store
            .get()
            .unwrap()
            .record_provider_hook_failure(
                &key.store_key(),
                &ProviderSubject {
                    subject_mid: "a".into(),
                    hook: "post_assistant".into(),
                    subject_part: "".into(),
                },
            )
            .unwrap();
        assert_eq!(
            pending(&h),
            json!({"count":1,"reasons":{"signed_prefix_hold":1}})
        );
    }

    #[tokio::test]
    async fn cc_pending_failure_fence_records_only_counters_and_preserves_error() {
        let (_dir, h, key) = fixture(true, None).await;
        let raw = r#"{"role":"user","content":"original"}"#;
        hold(&h, &key, &root(), &[("u", 0, raw)]);
        let store = h.store.get().unwrap();
        let before = store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap();
        let outcome = call(
            &h,
            "transform.hook",
            hook(
                r#"{"role":"user","content":"changed"}"#,
                "u",
                0,
                "pre_user",
                &["changed"],
            ),
        )
        .await;
        assert_eq!(
            format!("{outcome:?}"),
            format!(
                "{:?}",
                invalid_field("message", "provider subject changed its admitted bytes")
            )
        );
        let after = store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap();
        assert_eq!(after.lineage_id, before.lineage_id);
        assert_eq!(after.cursor_frontier, before.cursor_frontier);
        assert_eq!(after.served_through_ordinal, before.served_through_ordinal);
        assert_eq!(counters(&h, &key)["reserved_tag_high_water"], 40);
        assert!(answers(&h, &key).is_empty());
        assert_eq!(
            counters(&h, &key)["failed_subjects"],
            json!([{"subject_mid":"u","hook":"pre_user","subject_part":""}])
        );
        assert_eq!(pending(&h), json!({"count":1,"reasons":{"hook_failed":1}}));
        run(&h, hook(raw, "u", 0, "pre_user", &["original"])).await;
        assert_eq!(counters(&h, &key)["failed_subjects"], json!([]));
        assert_eq!(pending(&h), json!({"count":0,"reasons":{}}));
    }

    #[tokio::test]
    async fn cc_pending_failure_fence_rebind_before_publication_leaves_counters_unchanged() {
        let (dir, h, key) = fixture(true, None).await;
        let before = counters(&h, &key);
        let serial = h.provider_serial.lock_for(&key).await;
        let params = hook(
            r#"{"role":"user","content":"hello"}"#,
            "u",
            0,
            "pre_user",
            &["hello"],
        );
        let wire: hooks::hook::HookCall = decode(&params).unwrap();
        let mut call = Box::pin(h.provider_claude_code_hook(
            h.facade_binding(7).unwrap(),
            key.clone(),
            &wire,
            &params,
        ));
        tokio::select! {
            biased;
            outcome = &mut call => panic!("hook did not wait for provider serial: {outcome:?}"),
            _ = tokio::task::yield_now() => {}
        }
        h.bind_route(
            7,
            super::super::claude_code_tests::binding(dir.path(), thalamus()),
        );
        drop(serial);
        let outcome = call.await.unwrap_err();
        assert!(
            format!("{outcome:?}").contains("native_route_stale"),
            "{outcome:?}"
        );
        assert_eq!(counters(&h, &key), before);
    }

    #[tokio::test]
    async fn cc_pending_exclusions_do_not_count_intrinsic_shapes() {
        let (_dir, h, key) = fixture(true, None).await;
        hold(
            &h,
            &key,
            &root(),
            &[
                ("s", 0, r#"{"role":"system","content":"guidance"}"#),
                (
                    "a",
                    1,
                    r#"{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"s"},{"type":"redacted_thinking","data":"x"},{"type":"tool_use","id":"t","name":"Read","input":{}},{"type":"text","text":"  "}]}"#,
                ),
                (
                    "u",
                    2,
                    r#"{"role":"user","content":[{"type":"image","source":{}},{"type":"tool_result","tool_use_id":"t","content":[{"type":"future","text":"not text"}]},{"type":"tool_result","tool_use_id":"t","content":[{"type":"image","source":{}}]}]}"#,
                ),
            ],
        );
        assert_eq!(pending(&h), json!({"count":0,"reasons":{}}));
        assert!(counters(&h, &key).get("pending_logged").is_none());
    }

    #[tokio::test]
    async fn cc_pending_log_line_is_once_across_events_and_restart() {
        #[derive(Clone)]
        struct Writer(Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Writer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (dir, h, key) = fixture(true, None).await;
        let output = Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = Writer(output.clone());
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            hold(
                &h,
                &key,
                &root(),
                &[("u", 0, r#"{"role":"user","content":"first"}"#)],
            );
            assert_eq!(pending(&h)["count"], 1);
            hold(
                &h,
                &key,
                &root(),
                &[("v", 1, r#"{"role":"user","content":"second"}"#)],
            );
            assert_eq!(pending(&h)["count"], 2);
            assert_eq!(pending(&h)["count"], 2);
            assert_eq!(counters(&h, &key)["pending_logged"], true);
            drop(h);
            let restarted = handler(dir.path(), thalamus());
            assert_eq!(pending(&restarted)["count"], 2);
        });
        let log = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        assert_eq!(log.matches("mc-module: cc_pending").count(), 1, "{log}");
    }

    #[tokio::test]
    async fn cc_pending_lineage_and_native_generation_do_not_leak_abandoned_parts() {
        let (_dir, h, key) = fixture(true, None).await;
        hold(
            &h,
            &key,
            &root(),
            &[("prefix", 0, r#"{"role":"user","content":"prefix"}"#)],
        );
        let first = pending(&h);
        hold(
            &h,
            &key,
            &root(),
            &[(
                "abandoned",
                1,
                r#"{"role":"assistant","content":[{"type":"text","text":"held"},{"type":"thinking","thinking":"signed","signature":"s"}]}"#,
            )],
        );
        let child = ProviderLineage {
            lineage_id: "B".into(),
            first_ordinal: 1,
            descends_from: Some("L".into()),
            through_ordinal: Some(0),
        };
        hold(&h, &key, &child, &[]);
        assert_eq!(pending(&h), first);
        let mut foreign = key.store_key();
        foreign.generation.as_mut().unwrap().profile = "other-native-generation".into();
        let mut conversation = h
            .store
            .get()
            .unwrap()
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap();
        conversation.lineage_id.clear();
        conversation.hook_counters_json = "{}".into();
        let mut pins: Value =
            serde_json::from_str(conversation.native_pins_json.as_deref().unwrap()).unwrap();
        pins["profile_generation"] = json!("other-native-generation");
        conversation.native_pins_json = Some(pins.to_string());
        h.store
            .get()
            .unwrap()
            .save_provider_conversation(&foreign, &conversation)
            .unwrap();
        h.store
            .get()
            .unwrap()
            .commit_provider_status(
                &foreign,
                &root(),
                &[ProviderMessage {
                    mid: "foreign".into(),
                    ordinal: 0,
                    message_bytes: serde_json::to_vec(
                        &super::super::codec_claude_code::from_wire(
                            &json!({"role":"user","content":"foreign"}),
                            Some(r#"{"role":"user","content":"foreign"}"#),
                        )
                        .unwrap(),
                    )
                    .unwrap(),
                }],
                None,
                &[],
            )
            .unwrap();
        assert_eq!(pending(&h), first);
        assert_eq!(counters(&h, &key)["pending_logged"], true);
        assert_eq!(
            h.claude_code_pending_status(&super::super::claude_code_tests::binding(
                std::path::Path::new("/unrelated"),
                thalamus()
            ))
            .unwrap(),
            Value::Null
        );
        let mut unattested = h.facade_binding(7).unwrap();
        unattested.principal = None;
        assert_eq!(
            h.claude_code_pending_status(&unattested).unwrap(),
            Value::Null
        );
    }

    #[tokio::test]
    async fn admission_hook_scalar_user_preserves_authored_tag_text() {
        for composition in [
            None,
            Some(json!({"compaction":{"provider":DEFAULT_MODULE_ID}})),
        ] {
            let (_dir, h, key) = fixture(true, composition).await;
            let raw = r#"{ "role":"user", "content":"§900§ authored" }"#;
            let answer = run(&h, hook(raw, "user", 0, "pre_user", &["§900§ authored"])).await;
            assert_prepends(&h, &key, answer, "user", &[(0, 0, 41)]);
        }
    }

    fn answers(h: &McHandler, key: &Key) -> Vec<mc_store::provider_records::ProviderStoredAnswer> {
        h.store
            .get()
            .unwrap()
            .load_provider_hook_answers(&key.store_key())
            .unwrap()
    }

    fn tags_json(answer: &mc_store::provider_records::ProviderStoredAnswer) -> String {
        serde_json::to_string(&answer.answer.tags).unwrap()
    }

    #[tokio::test]
    async fn admission_lifecycle_exact_retry_keeps_ops_tags_and_pending_number() {
        let (_dir, h, key) = fixture(true, None).await;
        let raw = r#"{"role":"user","content":"hello"}"#;
        let params = hook(raw, "u", 1, "pre_user", &["hello"]);
        let first = run(&h, params.clone()).await;
        assert_prepends(&h, &key, first.clone(), "u", &[(0, 0, 41)]);
        assert_eq!(
            super::super::codec_claude_code::splice_admission_tag(raw, 0, 41)
                .unwrap()
                .as_bytes(),
            r#"{"role":"user","content":"§41§ hello"}"#.as_bytes()
        );
        assert_eq!(run(&h, params).await, first);
        let rows = answers(&h, &key);
        assert_eq!(
            rows.iter().map(|a| a.state.as_str()).collect::<Vec<_>>(),
            ["burned", "pending"]
        );
        assert_eq!(rows[0].answer.ops_json, rows[1].answer.ops_json);
        assert_eq!(tags_json(&rows[0]), tags_json(&rows[1]));
        let held = h
            .store
            .get()
            .unwrap()
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&held.hook_counters_json).unwrap()
                ["reserved_tag_high_water"],
            41
        );
    }

    #[tokio::test]
    async fn admission_lifecycle_watermark_promotes_replay_without_answer_or_reservation() {
        let (_dir, h, key) = fixture(true, None).await;
        let mut params = hook(
            r#"{"role":"user","content":"hello"}"#,
            "u",
            1,
            "pre_user",
            &["hello"],
        );
        let first = run(&h, params.clone()).await;
        assert_eq!(answers(&h, &key)[0].state, "pending");
        params["served_through_ordinal"] = json!(0);
        assert_eq!(run(&h, params.clone()).await, first);
        assert!(answers(&h, &key).iter().all(|a| a.state != "live"));
        params["served_through_ordinal"] = json!(1);
        assert_eq!(run(&h, params.clone()).await, first);
        let before = answers(&h, &key);
        assert_eq!(
            before.iter().map(|a| a.state.as_str()).collect::<Vec<_>>(),
            ["burned", "live"]
        );
        assert_eq!(run(&h, params).await, first);
        let after = answers(&h, &key);
        assert_eq!(after.len(), before.len());
        assert_eq!(after[1].answer.ops_json, before[1].answer.ops_json);
        assert_eq!(tags_json(&after[1]), tags_json(&before[1]));
        let held = h
            .store
            .get()
            .unwrap()
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&held.hook_counters_json).unwrap()
                ["reserved_tag_high_water"],
            41
        );
    }

    #[tokio::test]
    async fn admission_lifecycle_restart_repeats_live_replay_and_pending_retry() {
        let (dir, h, key) = fixture(true, None).await;
        let mut live = hook(
            r#"{"role":"user","content":"served"}"#,
            "u",
            1,
            "pre_user",
            &["served"],
        );
        let live_answer = run(&h, live.clone()).await;
        live["served_through_ordinal"] = json!(1);
        assert_eq!(run(&h, live.clone()).await, live_answer);
        let pending = hook(
            r#"{"role":"assistant","content":[{"type":"text","text":"pending"}]}"#,
            "a",
            2,
            "post_assistant",
            &["pending"],
        );
        let pending_answer = run(&h, pending.clone()).await;
        let before = answers(&h, &key);
        drop(h);
        let h = handler(dir.path(), thalamus());
        response(call(&h, "transform.declare", json!({"session":"cc","harness":"claude-code","params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"preset":"head"})).await);
        assert_eq!(run(&h, live).await, live_answer);
        assert_eq!(answers(&h, &key).len(), before.len());
        assert_eq!(run(&h, pending).await, pending_answer);
        let after = answers(&h, &key);
        assert_eq!(
            after.iter().map(|a| a.state.as_str()).collect::<Vec<_>>(),
            ["live", "burned", "pending"]
        );
        assert_eq!(after[1].answer.ops_json, after[2].answer.ops_json);
        assert_eq!(tags_json(&after[1]), tags_json(&after[2]));
        assert_eq!(after[2].answer.tags[0].number, 42);
    }

    #[tokio::test]
    async fn admission_lifecycle_text_form_flip_keeps_first_admission_bytes() {
        let (_dir, h, key) = fixture(true, None).await;
        let raw = r#"{ "role":"user", "content":"a\\nline" }"#;
        let first = run(&h, hook(raw, "u", 1, "pre_user", &[r"a\nline"])).await;
        let admitted = h
            .store
            .get()
            .unwrap()
            .load_provider_messages(&key.store_key(), "L")
            .unwrap();
        let flipped = r#"{ "role":"user", "content":[{"type":"text","text":"a\\nline"}] }"#;
        assert_eq!(
            run(&h, hook(flipped, "u", 1, "pre_user", &[r"a\nline"])).await,
            first
        );
        let rows = answers(&h, &key);
        assert_eq!(rows[0].answer.ops_json, rows[1].answer.ops_json);
        assert_eq!(tags_json(&rows[0]), tags_json(&rows[1]));
        let messages = h
            .store
            .get()
            .unwrap()
            .load_provider_messages(&key.store_key(), "L")
            .unwrap();
        assert_eq!(messages, admitted);
    }

    #[tokio::test]
    async fn admission_lifecycle_unserved_burn_retires_number_before_watermark() {
        let (_dir, h, key) = fixture(true, None).await;
        let original = hook(
            r#"{"role":"user","content":"hello"}"#,
            "u",
            1,
            "pre_user",
            &["hello"],
        );
        run(&h, original.clone()).await;
        let mut later = hook(
            r#"{"role":"user","content":"later"}"#,
            "v",
            2,
            "pre_user",
            &["later"],
        );
        later["served_through_ordinal"] = json!(1);
        later["unserved_subjects"] = json!([{"subject_mid":"u","hook":"pre_user"}]);
        run(&h, later).await;
        assert_eq!(answers(&h, &key)[0].state, "burned");
        assert_prepends(
            &h,
            &key,
            run(&h, original.clone()).await,
            "u",
            &[(0, 0, 43)],
        );
        assert_eq!(run(&h, original.clone()).await, run(&h, original).await);
        let rows = answers(&h, &key);
        assert!(rows
            .iter()
            .skip(1)
            .flat_map(|a| &a.answer.tags)
            .all(|t| t.number != 41));
        assert_eq!(rows.last().unwrap().answer.tags[0].number, 43);
    }

    #[tokio::test]
    async fn admission_lifecycle_descent_keeps_prefix_and_retires_only_pending_suffix() {
        let (_dir, h, key) = fixture(true, None).await;
        let prefix = hook(
            r#"{"role":"user","content":"prefix"}"#,
            "u",
            1,
            "pre_user",
            &["prefix"],
        );
        let prefix_answer = run(&h, prefix.clone()).await;
        let suffix = hook(
            r#"{"role":"user","content":"suffix"}"#,
            "v",
            2,
            "pre_user",
            &["suffix"],
        );
        run(&h, suffix.clone()).await;
        let mut child_prefix = prefix;
        child_prefix["lineage_id"] = json!("B");
        child_prefix["descends_from"] = json!({"lineage_id":"L","through_ordinal":1});
        assert_eq!(run(&h, child_prefix.clone()).await, prefix_answer);
        let rows = answers(&h, &key);
        assert_eq!(
            rows.iter().map(|a| a.state.as_str()).collect::<Vec<_>>(),
            ["pending", "burned"]
        );
        let mut child_suffix = suffix.clone();
        child_suffix["lineage_id"] = json!("B");
        assert_eq!(
            run(&h, child_suffix).await,
            HookAnswer::Ops {
                ops: vec![Operation::Prepend {
                    block: 0,
                    text: "§43§ ".into(),
                    note: None
                }]
            }
        );
        let rows = answers(&h, &key);
        assert_eq!(rows.last().unwrap().answer.tags[0].number, 43);
        // The abandoned parent's policy row must also be retired, not merely
        // hidden by the child's cut, even if that parent receives another hook.
        let parent_retry = run(&h, suffix).await;
        assert_eq!(
            parent_retry,
            HookAnswer::Ops {
                ops: vec![Operation::Prepend {
                    block: 0,
                    text: "§44§ ".into(),
                    note: None
                }]
            }
        );
        child_prefix["served_through_ordinal"] = json!(1);
        assert_eq!(run(&h, child_prefix).await, prefix_answer);
        let rows = answers(&h, &key);
        assert_eq!(rows[0].state, "live");
        assert_eq!(rows[0].answer.tags[0].number, 41);
        assert!(rows
            .iter()
            .skip(2)
            .flat_map(|a| &a.answer.tags)
            .all(|t| t.number != 42));
    }

    #[tokio::test]
    async fn admission_hook_each_top_level_user_text_uses_native_reservation() {
        let (_dir, h, key) = fixture(true, None).await;
        let raw = r#"{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://example.invalid/a.png"}},{"type":"text","text":"one"},{"type":"image","source":{}},{"type":"text","text":""}]}"#;
        let answer = run(&h, hook(raw, "user", 0, "pre_user", &["one", ""])).await;
        assert_prepends(&h, &key, answer, "user", &[(0, 1, 41), (1, 3, 42)]);
    }

    #[tokio::test]
    async fn admission_hook_assistant_text_after_last_signed_block() {
        let (_dir, h, key) = fixture(true, None).await;
        let raw = r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"sig"},{"type":"redacted_thinking","data":"redacted"},{"type":"text","text":"first"},{"type":"text","text":"second"}]}"#;
        let answer = run(
            &h,
            hook(raw, "assistant", 0, "post_assistant", &["first", "second"]),
        )
        .await;
        assert_prepends(&h, &key, answer, "assistant", &[(0, 2, 41), (1, 3, 42)]);
    }

    #[tokio::test]
    async fn admission_hook_tool_result_string_and_error_string() {
        for error in [false, true] {
            let (_dir, h, key) = fixture(true, None).await;
            pair_call(&h).await;
            let raw = json!({"role":"user","content":[{"type":"text","text":"mixed"},{"type":"tool_result","tool_use_id":"call-a","is_error":error,"content":"result"}]}).to_string();
            let answer = run(&h, hook(&raw, "result", 1, "post_tool", &["result"])).await;
            assert_prepends(&h, &key, answer, "result", &[(0, 1, 42)]);
        }
    }

    async fn array_result(error: bool) {
        let (_dir, h, key) = fixture(true, None).await;
        pair_call(&h).await;
        let raw = json!({"role":"user","content":[{"type":"image","source":{}},{"type":"tool_result","tool_use_id":"call-a","is_error":error,"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}},{"type":"text","text":"first"},{"type":"text","text":"second"}]}]}).to_string();
        let answer = run(
            &h,
            hook(&raw, "result", 1, "post_tool", &["first", "second"]),
        )
        .await;
        assert_prepends(&h, &key, answer, "result", &[(0, 1, 41)]);
    }

    #[tokio::test]
    async fn admission_hook_array_result_collects_all_text_and_prepends_only_first() {
        array_result(false).await;
    }

    #[tokio::test]
    async fn admission_hook_error_array_result_collects_all_text_and_prepends_only_first() {
        array_result(true).await;
    }

    #[tokio::test]
    async fn admission_hook_intrinsically_excluded_blocks_get_no_ops() {
        for raw in [
            r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"sig"},{"type":"redacted_thinking","data":"opaque"},{"type":"tool_use","id":"call-a","name":"Read","input":{}},{"type":"image","source":{}}]}"#,
            r#"{"role":"user","content":[{"type":"image","source":{}}]}"#,
            r#"{"role":"system","content":"system"}"#,
        ] {
            let (_dir, h, _key) = fixture(true, None).await;
            let kind = if raw.contains("assistant") {
                "post_assistant"
            } else {
                "pre_user"
            };
            assert_eq!(
                run(&h, hook(raw, "excluded", 0, kind, &[])).await,
                HookAnswer::Pass
            );
        }
    }

    #[tokio::test]
    async fn admission_hook_assistant_before_later_thinking_or_redacted_gets_no_op() {
        for signed in [
            json!({"type":"thinking","thinking":"private","signature":"sig"}),
            json!({"type":"redacted_thinking","data":"opaque"}),
        ] {
            let (_dir, h, _key) = fixture(true, None).await;
            let raw = json!({"role":"assistant","content":[{"type":"text","text":"held"},signed]})
                .to_string();
            let answer = run(&h, hook(&raw, "assistant", 0, "post_assistant", &["held"])).await;
            assert_eq!(answer, HookAnswer::Pass);
        }
    }

    #[tokio::test]
    async fn admission_hook_empty_assistant_text_gets_no_op() {
        let (_dir, h, _key) = fixture(true, None).await;
        let raw = r#"{"role":"assistant","content":[{"type":"text","text":""},{"type":"text","text":"   "}]}"#;
        assert_eq!(
            run(&h, hook(raw, "empty", 0, "post_assistant", &["", "   "])).await,
            HookAnswer::Pass
        );
    }

    #[tokio::test]
    async fn admission_hook_mixed_user_text_gets_no_op() {
        let (_dir, h, _key) = fixture(true, None).await;
        pair_call(&h).await;
        let raw = r#"{"role":"user","content":[{"type":"text","text":"held"},{"type":"tool_result","tool_use_id":"call-a","content":"result"}]}"#;
        assert_eq!(
            run(&h, hook(raw, "mixed", 1, "pre_user", &["held"])).await,
            HookAnswer::Pass
        );
    }

    #[tokio::test]
    async fn admission_hook_non_text_or_image_array_result_is_excluded() {
        for error in [false, true] {
            let (_dir, h, _key) = fixture(true, None).await;
            pair_call(&h).await;
            let raw = json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"call-a","is_error":error,"content":[{"type":"text","text":"visible"},{"type":"future","data":7}]}]}).to_string();
            assert_eq!(
                run(&h, hook(&raw, "json", 1, "post_tool", &["visible"])).await,
                HookAnswer::Pass
            );
        }
    }

    #[tokio::test]
    async fn admission_hook_subject_blocks_must_include_every_text_in_order() {
        let (_dir, h, _key) = fixture(true, None).await;
        pair_call(&h).await;
        let raw = r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-a","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]}]}"#;
        for blocks in [&["one"][..], &["two", "one"][..]] {
            let outcome = call(
                &h,
                "transform.hook",
                hook(raw, "result", 1, "post_tool", blocks),
            )
            .await;
            assert!(
                matches!(outcome, HandlerOutcome::ErrorWithDetail { ref code, .. } | HandlerOutcome::Error { ref code, .. } if code == "invalid_params"),
                "{outcome:?}"
            );
        }
    }

    #[tokio::test]
    async fn admission_hook_without_auto_tag_passes() {
        let (_dir, h, _key) = fixture(false, None).await;
        let raw = r#"{"role":"user","content":"untagged"}"#;
        assert_eq!(
            run(&h, hook(raw, "user", 0, "pre_user", &["untagged"])).await,
            HookAnswer::Pass
        );
    }

    #[tokio::test]
    async fn admission_hook_non_cc_answer_lane_passes() {
        for plan in [
            json!({"serializer_profile":"opencode-aisdk","observation":"answer"}),
            json!({"serializer_profile":"claude-code-anthropic"}),
        ] {
            let (_dir, h, key) = fixture(true, None).await;
            let store = h.store.get().unwrap();
            let mut held = store
                .load_provider_conversation(&key.store_key())
                .unwrap()
                .unwrap();
            held.params_json = plan.to_string();
            store
                .save_provider_conversation(&key.store_key(), &held)
                .unwrap();
            let raw = r#"{"role":"user","content":"legacy"}"#;
            let params = hook(raw, "user", 0, "pre_user", &["legacy"]);
            let call: hooks::hook::HookCall = decode(&params).unwrap();
            let bytes = h
                .provider_claude_code_hook(h.facade_binding(7).unwrap(), key, &call, &params)
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<HookAnswer>(&bytes).unwrap(),
                HookAnswer::Pass
            );
        }
    }

    #[tokio::test]
    async fn admission_hook_another_reduction_owner_passes() {
        for composition in [json!({}), json!({"compaction":{"provider":"other"}})] {
            let (_dir, h, _key) = fixture(true, Some(composition)).await;
            for (ordinal, (kind, role)) in [("pre_user", "user"), ("post_assistant", "assistant")]
                .into_iter()
                .enumerate()
            {
                let raw = json!({"role":role,"content":"not owned"}).to_string();
                assert_eq!(
                    run(&h, hook(&raw, role, ordinal as u64, kind, &["not owned"])).await,
                    HookAnswer::Pass
                );
            }
        }
    }

    #[tokio::test]
    async fn admission_hook_unattested_caller_passes_without_writing() {
        let (_dir, h, key) = fixture(true, None).await;
        let raw = r#"{"role":"user","content":"not attested"}"#;
        let params = hook(raw, "user", 0, "pre_user", &["not attested"]);
        let call: hooks::hook::HookCall = decode(&params).unwrap();
        let mut binding = h.facade_binding(7).unwrap();
        binding.principal = None;
        let bytes = h
            .provider_claude_code_hook(binding, key.clone(), &call, &params)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<HookAnswer>(&bytes).unwrap(),
            HookAnswer::Pass
        );
        assert!(h
            .store
            .get()
            .unwrap()
            .load_provider_hook_answers(&key.store_key())
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn admission_hook_bootstrap_and_batch_attachment_never_answer_or_tag() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path(), thalamus());
        setup(&h).await;
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        let mut held = store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap();
        held.hook_counters_json = json!({"auto_tag":true}).to_string();
        store
            .save_provider_conversation(&key.store_key(), &held)
            .unwrap();
        let raw = r#"{"role":"user","content":"bootstrap"}"#;
        let mut status = step(raw);
        response(call(&h, "compaction.step", status.clone()).await);
        status["messages"] = json!([{"mid":"batch","ordinal":1,"message":{"role":"user","content":"attached"},"raw_message":r#"{"role":"user","content":"attached"}"#}]);
        status["newest"] = json!({"mid":"batch","ordinal":1});
        status["after_ordinal"] = json!(0);
        status["step_id"] = json!("2");
        response(call(&h, "compaction.step", status).await);
        assert!(store
            .load_provider_hook_answers(&key.store_key())
            .unwrap()
            .is_empty());
        let messages = store.load_provider_messages(&key.store_key(), "L").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            serde_json::from_slice::<Value>(&messages[0].message_bytes).unwrap()["raw_message"],
            raw
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&messages[1].message_bytes).unwrap()["raw_message"],
            r#"{"role":"user","content":"attached"}"#
        );
    }
}
