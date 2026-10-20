//! Shared discovery, polling interval and stream-event wake predicate for background runs.

use cortexkit_role_llm_runner::capabilities as caps;
use serde_json::Value;
use std::time::Duration;

/// Four status probes per second while a stream is quiet bound completion latency
/// without a tight polling loop.
pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Treat stream events whose kind is control only as wake hints. Their
/// runner-specific bodies are neither answers nor terminal-state signals.
pub(crate) fn control_wake(event: &Value) -> bool {
    event.get("kind").and_then(Value::as_str) == Some("control")
}

#[derive(Clone, Copy, Default)]
pub(crate) struct FollowCapabilities {
    pub run_ops: bool,
    pub run_status: bool,
    pub streaming: bool,
    pub run_usage: bool,
}

impl FollowCapabilities {
    pub fn from_describe(answer: &Value) -> Self {
        let answer = answer.get("result").unwrap_or(answer);
        let declares = |name| {
            answer["capabilities"]
                .as_array()
                .is_some_and(|groups| groups.iter().any(|group| group.as_str() == Some(name)))
        };
        Self {
            run_ops: declares(caps::RUN_OPS),
            run_status: declares(caps::RUN_STATUS),
            streaming: declares(caps::STREAMING),
            run_usage: declares(caps::RUN_USAGE),
        }
    }

    pub fn missing(self) -> Option<&'static str> {
        if !self.run_ops {
            Some("background_runner_missing_groups: run_ops")
        } else if !self.run_status {
            Some("background_runner_missing_groups: run_status")
        } else {
            None
        }
    }
}
