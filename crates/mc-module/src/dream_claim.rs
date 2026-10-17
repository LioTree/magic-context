//! Versioned, session-confined Host dream claimant management routes, and the
//! `dream.ownership` route that publishes which dream tasks Rust runs.

use crate::dream_dispatch::host_carrier::DreamQueue;
use crate::dream_dispatch::ownership::{
    self, ClaimantDeclaration, Ownership, OwnershipInput, Wiring,
};
use crate::{invalid_params_error, now_ms, providers, respond, McHandler, SessionBinding};
use mc_store::dream_scheduler::schedules::TaskName;
use serde_json::{json, Value};
use std::sync::Arc;
use subc_client_rs::HandlerOutcome;

/// Harness names whose plugin opens a principal-less route and runs the
/// TypeScript dreamer itself. Any other route needs a daemon-attested principal.
const PLUGIN_HARNESSES: [&str; 4] = ["opencode", "opencode2", "pi", "omp"];

/// True for a route opened by a Magic Context plugin: no principal and a harness
/// in `PLUGIN_HARNESSES`. Such a host runs every dream task itself unless the
/// task is in Rust's published list.
pub(crate) fn plugin_lane(binding: &SessionBinding) -> bool {
    binding.principal.is_none() && PLUGIN_HARNESSES.contains(&binding.harness.as_str())
}

impl McHandler {
    /// Off-thread executors share this queue with the management routes. Merely
    /// registering a claimant never starts a task or selects a different runner.
    pub fn dream_queue(&self) -> Arc<DreamQueue> {
        self.dream_children.clone()
    }

    /// The bound route and its project key, once the route passed the checks every
    /// dream route applies: a plugin route, or a principal-bearing route that
    /// `providers` admits as the attested harness module.
    fn dream_lane(
        &self,
        channel: u16,
        request: &Value,
        method: &str,
    ) -> Result<(SessionBinding, String), HandlerOutcome> {
        let binding = self.historian_lane_binding(channel, request, method)?;
        if binding.principal.is_some() {
            providers::admit_host_lane(&binding)
                .and_then(|()| providers::admit_harness_module(&binding))?;
        } else if !plugin_lane(&binding) {
            return Err(HandlerOutcome::Error {
                code: "host_lane_requires_plugin".into(),
                message: "dream claims require a plugin or attested harness route".into(),
            });
        }
        let Some(store) = self.store.get() else {
            return Err(self.store_refusal());
        };
        let project = self.historian_lane_project(&binding, store)?;
        Ok((binding, project))
    }

    pub(crate) fn handle_dream_child(
        &self,
        channel: u16,
        method: &str,
        request: &Value,
    ) -> HandlerOutcome {
        let (binding, project) = match self.dream_lane(channel, request, method) {
            Ok(lane) => lane,
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

    fn dream_wiring(&self) -> Wiring {
        #[cfg(test)]
        if let Some(wiring) = &self.dream_wiring {
            return wiring.clone();
        }
        Wiring::production()
    }

    /// The tasks Rust runs for this project right now, from the route's current
    /// config, this build's wiring and the freshest claimant declared on any of
    /// the project's attested harness routes. A declared claimant's own harness
    /// selects the runner and models, because its children run there.
    pub(crate) fn dream_ownership(&self, binding: &SessionBinding, project: &str) -> Ownership {
        let config = self.effective_config(&binding.project_root);
        // Settings are only read when activation could publish anything; a
        // resolution failure publishes nothing rather than guessing.
        let settings = config
            .rust_background_enabled()
            .then(|| self.dream_task_settings(&binding.project_root).ok())
            .flatten();
        let claimant = self.dream_claimants.current(project, now_ms());
        let harness = claimant
            .as_ref()
            .map_or(binding.harness.as_str(), |c| c.harness.as_str());
        let wiring = self.dream_wiring();
        ownership::publish(&OwnershipInput {
            config: &config,
            settings: settings.as_ref(),
            harness,
            wiring: &wiring,
            claimant: claimant.as_ref(),
        })
    }

    /// `dream.ownership {v:1, claimant?}` answers with the published list for the
    /// route's project; it is the only list a plugin's scheduler consults.
    ///
    /// Reading is open to plugin and attested harness routes. Only an attested
    /// harness route (the plugin-free THALAMUS harness, admitted by `dream_lane`)
    /// may declare a claimant (`claimant: {capabilities, agents}`) or withdraw its
    /// own (`claimant: null`): a plugin cannot make Rust take its own tasks away.
    pub(crate) fn handle_dream_ownership(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (binding, project) = match self.dream_lane(channel, request, "dream.ownership") {
            Ok(lane) => lane,
            Err(refusal) => return refusal,
        };
        if let Some(claimant) = request.get("claimant") {
            // dream_lane let a route through only as a plugin route (no principal)
            // or as the admitted harness module (principal present); refuse the former.
            if binding.principal.is_none() {
                return HandlerOutcome::Error {
                    code: "claimant_requires_attested_harness".into(),
                    message: "only an attested harness route can declare a dream claimant".into(),
                };
            }
            if claimant.is_null() {
                self.dream_claimants.withdraw(&project, &binding.session);
            } else {
                match ClaimantDeclaration::parse(claimant, now_ms()) {
                    Ok(declaration) => self.dream_claimants.declare(
                        &project,
                        &binding.session,
                        declaration.on_route(&binding.session, &binding.harness),
                    ),
                    Err(reason) => return invalid_params_error(reason),
                }
            }
        }
        respond(self.dream_ownership(&binding, &project).to_json())
    }

    /// Whether Rust publishes `task` for this route; used by `dreamer.run_task`.
    pub(crate) fn dream_task_published(&self, binding: &SessionBinding, task: TaskName) -> bool {
        let Some(store) = self.store.get() else {
            return false;
        };
        let Ok(project) = self.historian_lane_project(binding, store) else {
            return false;
        };
        self.dream_ownership(binding, &project).owns(task)
    }
}

#[cfg(test)]
mod tests;
