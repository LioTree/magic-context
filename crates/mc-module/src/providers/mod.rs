//! Provider discovery and method routing; conversation state is owned by mc-store.
use super::*;
use cortexkit_role_compaction_provider as compact;
use cortexkit_role_step_transform_provider as hooks;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

mod cache_policy;
#[cfg(test)]
#[path = "../../../../docs/reports/cc-step-lane-witnesses.rs"]
mod cc_step_lane_review;
#[cfg(test)]
mod claude_code_tests;
mod codec;
mod codec_claude_code;
mod codec_opencode;
mod compaction;
mod historian;
mod policy_summary;
mod records;
mod step_transform;
#[cfg(test)]
mod tests;

use codec::{checked_view, decode_message};
#[cfg(test)]
use codec::{encode_message, validate_replacement};
pub(crate) use historian::RunCompletion;
use records::{frontier, ingest, scan, HookRecord, HookState, Key, Record, Setup};
pub(crate) use records::{Catalog, Storage};
use step_transform::declaration;

pub const HOOK_BUDGET_MS: u64 = 1_500;

pub fn runner_groups() -> [&'static str; 1] {
    ["transcript_reads"]
}

/// Active and queued callers retain their lock; only idle entries can be evicted.
/// A rebuild in one conversation must never queue a hook in another conversation.
#[derive(Default)]
pub(crate) struct ProviderSerial {
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ProviderSerial {
    fn lock_arc(&self, key: &Key) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().expect("provider lock map");
        if locks.len() >= 1024 {
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        Arc::clone(
            locks
                .entry(key.store_key().conversation_key())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }
    pub(crate) async fn lock_for(&self, key: &Key) -> tokio::sync::OwnedMutexGuard<()> {
        self.lock_arc(key).lock_owned().await
    }
    pub(crate) fn try_lock_for(
        &self,
        key: &Key,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, tokio::sync::TryLockError> {
        self.lock_arc(key).try_lock_owned()
    }
}

fn invalid_field(field: &str, message: impl ToString) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: "invalid_params".into(),
        message: message.to_string(),
        detail: json!({"field":field}),
    }
}

fn answer_observation(params: &Value) -> bool {
    matches!(
        params.get("serializer_profile").and_then(Value::as_str),
        Some("opencode-aisdk" | "claude-code-anthropic")
    ) && params.get("observation").and_then(Value::as_str) == Some("answer")
}

fn attested_claude_code(binding: &SessionBinding) -> bool {
    binding.harness == "claude-code"
        && matches!(&binding.principal,
        Some(subc_protocol::Principal::Reserved { module_id }) if module_id == "thalamus")
}

fn host_binding(binding: &SessionBinding) -> bool {
    matches!(binding.harness.as_str(), "opencode" | "opencode2") || attested_claude_code(binding)
}

/// Claude Code requires the daemon-confirmed Thalamus caller and a plan choosing
/// the Anthropic serializer with gateway-observed answers. Additional negotiated
/// capabilities belong here, never in a caller-supplied principal field.
fn admit_claude_code(
    binding: &SessionBinding,
    method: &str,
    params: &Value,
) -> Result<(), HandlerOutcome> {
    let thalamus = matches!(&binding.principal, Some(subc_protocol::Principal::Reserved { module_id }) if module_id == "thalamus");
    let profile = params
        .pointer("/params/serializer_profile")
        .and_then(Value::as_str);
    if (profile == Some("claude-code-anthropic") || binding.harness == "claude-code") && !thalamus {
        return Err(error(
            "claude_code_lane_requires_attested_host",
            "Claude Code provider lane requires reserved:thalamus",
        ));
    }
    if thalamus
        && (binding.harness != "claude-code"
            || profile.is_some_and(|p| p != "claude-code-anthropic")
            || (matches!(method, "transform.declare" | "compaction.setup")
                && profile != Some("claude-code-anthropic")))
    {
        return Err(error(
            "claude_code_lane_profile_mismatch",
            "reserved:thalamus must use the Claude Code provider profile",
        ));
    }
    Ok(())
}

pub fn describe() -> HandlerOutcome {
    let mut answer: Value = match tool_catalog::role_describe_bytes() {
        Ok(bytes) => serde_json::from_slice(&bytes).expect("compiled role description"),
        Err(error) => return error.into_outcome(),
    };
    let majors = answer["majors"].as_array_mut().expect("role majors");
    majors.push(
        json!({"version": compact::PROVIDES, "ops": compact::REQUIRED_OPS, "stability": "alpha"}),
    );
    majors.push(
        json!({"version": hooks::PROVIDES, "ops": hooks::REQUIRED_OPS, "stability": "alpha"}),
    );
    answer["runner_groups"] = json!(runner_groups());
    HandlerOutcome::Response(serde_jcs::to_vec(&answer).expect("build-only role JSON"))
}

pub fn error(code: &str, message: impl ToString) -> HandlerOutcome {
    HandlerOutcome::Error {
        code: code.into(),
        message: message.to_string(),
    }
}

pub fn invalid(message: impl ToString) -> HandlerOutcome {
    error("invalid_params", message)
}

pub fn transient(message: impl ToString) -> HandlerOutcome {
    error("transient", message)
}

pub fn decode<T: serde::de::DeserializeOwned>(params: &Value) -> Result<T, HandlerOutcome> {
    serde_json::from_value(params.clone()).map_err(invalid)
}

pub fn bytes<T: Serialize>(answer: &T) -> Result<Vec<u8>, HandlerOutcome> {
    serde_json::to_vec(answer).map_err(transient)
}
pub fn preset(name: Option<&str>) -> Result<transform::compaction::Preset, HandlerOutcome> {
    match name.unwrap_or("head") {
        "head" | "primary" => Ok(transform::compaction::Preset::Head),
        "worker" | "subagent" => Ok(transform::compaction::Preset::Worker),
        "reader" => Ok(transform::compaction::Preset::Reader),
        _ => Err(invalid("unknown provider preset")),
    }
}
pub const FAULT_POINTS: &[&str] = &[
    "SetupRecorded",
    "MessagesIngested",
    "AnswerRecorded",
    "WaitAnswered",
    "WaitWorkDurable",
    "HookStateRecorded",
];

pub fn fault(point: &str) {
    debug_assert!(FAULT_POINTS.contains(&point));
    #[cfg(feature = "drive-fault")]
    if std::env::var("MC_PROVIDER_FAULT_POINT").ok().as_deref() == Some(point) {
        // The harness sees this line, then sends a real process kill. A
        // fault-enabled binary alone can park at a durable provider cut.
        eprintln!("MC_PROVIDER_FAULT_REACHED {point}");
        loop {
            std::thread::park();
        }
    }
}

impl McHandler {
    pub(crate) async fn handle_provider_value(
        &self,
        channel: u16,
        method: &str,
        params: &Value,
    ) -> HandlerOutcome {
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => {
                return error(
                    "route_unbound",
                    format!("{method} requires a bound project route"),
                )
            }
        };
        if let Err(error) = admit_claude_code(&binding, method, params) {
            return error;
        }
        // OpenCode keeps its existing authorization by bound harness. Claude Code
        // also requires the caller identity confirmed by the daemon at route bind.
        let host = host_binding(&binding);
        if !host && binding.harness != session_resolver::RUNNER_BIND_HARNESS {
            return error(
                "route_unbound",
                "provider operations require a host or runner bind",
            );
        }
        if matches!(method, "transform.declare" | "compaction.setup") {
            let plan = &params["params"];
            if let Err(error) = codec::Codec::from_params(plan) {
                return error;
            }
            if !host {
                for (field, value) in [
                    ("observation", "answer"),
                    ("serializer_profile", "opencode-aisdk"),
                ] {
                    if plan.get(field).and_then(Value::as_str) == Some(value) {
                        return invalid_field(
                            &format!("params.{field}"),
                            "runner plans cannot opt into host observation",
                        );
                    }
                }
            } else if !answer_observation(plan) {
                return invalid_field(
                    "params.observation",
                    "host lane requires its native profile and answer observation",
                );
            }
        }
        if host {
            for (field, expected) in [
                ("session", binding.session.as_str()),
                ("harness", binding.harness.as_str()),
            ] {
                if params
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| value != expected)
                {
                    return invalid_field(
                        field,
                        "provider call does not match its bound conversation",
                    );
                }
            }
            if let Err(error) = self.admit_host_plan(&binding, method, params).await {
                return error;
            }
        }
        if method == "transform.declare" {
            return match declaration(params).and_then(|d| bytes(&d)) {
                Ok(bytes) => HandlerOutcome::Response(bytes),
                Err(e) => e,
            };
        }
        if let Some(session) = params.get("session").and_then(Value::as_str) {
            if let Some(refusal) = self.provider_store.catalog_refusal(&binding, session) {
                return refusal;
            }
        }
        let result = match method {
            "compaction.setup" => self.provider_setup(binding, params).await,
            "compaction.step" => self.provider_step(binding, params).await,
            "transform.hook" => self.provider_hook(binding, params).await,
            _ => Err(invalid("unknown provider method")),
        };
        match result {
            Ok(bytes) => HandlerOutcome::Response(bytes),
            Err(error) => error,
        }
    }
}
