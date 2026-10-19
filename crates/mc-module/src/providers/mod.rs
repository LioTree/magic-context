//! Workspace engine adapters and provider discovery. The runner owns transcript tags.
use super::*;
use cortexkit_role_compaction_provider as compact;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

pub mod codec;
pub mod codec_opencode;
pub mod codec_pi;
pub mod compaction;
pub mod fold_prefix;
pub mod fold_working;
pub mod historian;
pub mod historian_budget;
pub mod hygiene_memo;
pub mod policy_summary;
pub mod records;
mod reduce;
pub mod resident_bytes;
pub mod view_recipe;

pub(crate) use historian::RunCompletion;
pub use records::{Catalog, Key, Storage};

/// Active and queued callers retain their lock; only idle entries can be evicted.
/// A rebuild in one conversation must never queue a hook in another conversation.
#[derive(Default)]
pub struct ProviderSerial {
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
    pub async fn lock_for(&self, key: &Key) -> tokio::sync::OwnedMutexGuard<()> {
        self.lock_arc(key).lock_owned().await
    }
    pub fn try_lock_for(
        &self,
        key: &Key,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, tokio::sync::TryLockError> {
        self.lock_arc(key).try_lock_owned()
    }
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
pub fn runner_groups() -> [&'static str; 1] {
    ["transcript_reads"]
}

pub fn describe() -> HandlerOutcome {
    let mut answer: Value = match tool_catalog::role_describe_bytes() {
        Ok(bytes) => serde_json::from_slice(&bytes).expect("compiled role description"),
        Err(error) => return error.into_outcome(),
    };
    answer["majors"]
        .as_array_mut()
        .expect("role majors")
        .push(json!({
            "version": compact::PROVIDES,
            "ops": ["role.describe", "compaction.setup", "view.get", "compaction.ride"],
            "stability": "alpha"
        }));
    answer["runner_groups"] = json!(runner_groups());
    HandlerOutcome::Response(serde_jcs::to_vec(&answer).expect("build-only role JSON"))
}

fn invalid_field(field: &str, message: impl ToString) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: "invalid_params".into(),
        message: message.to_string(),
        detail: json!({"field":field}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_does_not_advertise_retired_step_or_native_capabilities() {
        let HandlerOutcome::Response(bytes) = describe() else {
            panic!("role discovery failed")
        };
        let answer: Value = serde_json::from_slice(&bytes).unwrap();
        let majors = answer["majors"].as_array().unwrap();
        assert!(!majors
            .iter()
            .any(|major| major["version"] == "step-transform-provider/v1"));
        let compaction = majors
            .iter()
            .find(|major| major["version"] == compact::PROVIDES)
            .unwrap();
        assert!(!compaction["ops"]
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op == "compaction.step" || op == "compaction.view.read"));
        assert!(answer.get("claude_code").is_none());
    }

    #[tokio::test]
    async fn retired_step_and_hook_methods_are_unrecognized() {
        let handler = McHandler::new();
        for method in [
            "compaction.step",
            "compaction.delete",
            "compaction.view.read",
            "transform.declare",
            "transform.hook",
        ] {
            let answer = handler
                .dispatch_value(1, json!({"method":method,"params":{}}))
                .await;
            assert!(
                matches!(answer, HandlerOutcome::Error { ref code, .. } if code == "unrecognized_request_shape"),
                "{method}: {answer:?}"
            );
        }
    }
}
