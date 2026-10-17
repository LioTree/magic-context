//! Versioned, session-confined Host dream claimant management routes.

use crate::dream_dispatch::host_carrier::DreamQueue;
use crate::{providers, respond, McHandler};
use serde_json::{json, Value};
use std::sync::Arc;
use subc_client_rs::HandlerOutcome;

impl McHandler {
    /// Off-thread executors share this queue with the management routes. Merely
    /// registering a claimant never starts a task or selects a different runner.
    pub fn dream_queue(&self) -> Arc<DreamQueue> {
        self.dream_children.clone()
    }

    pub(crate) fn handle_dream_child(
        &self,
        channel: u16,
        method: &str,
        request: &Value,
    ) -> HandlerOutcome {
        let binding = match self.historian_lane_binding(channel, request, method) {
            Ok(binding) => binding,
            Err(refusal) => return refusal,
        };
        if binding.principal.is_some() {
            if let Err(refusal) = providers::admit_host_lane(&binding)
                .and_then(|()| providers::admit_harness_module(&binding))
            {
                return refusal;
            }
        } else if !matches!(
            binding.harness.as_str(),
            "opencode" | "opencode2" | "pi" | "omp"
        ) {
            return HandlerOutcome::Error {
                code: "host_lane_requires_plugin".into(),
                message: "dream claims require a plugin or attested harness route".into(),
            };
        }
        let Some(store) = self.store.get() else {
            return self.store_refusal();
        };
        let project = match self.historian_lane_project(&binding, store) {
            Ok(project) => project,
            Err(refusal) => return refusal,
        };
        match self
            .dream_children
            .route(&project, &binding.session, method, request)
        {
            Ok(body) => respond(body),
            Err(refusal) => respond(json!({"ok": false, "refusal": refusal})),
        }
    }
}

#[cfg(test)]
mod tests;
