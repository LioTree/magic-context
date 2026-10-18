//! Versioned, session-confined Host dream claimant management routes, and the
//! `dream.ownership` route that publishes which dream tasks Rust runs.

use crate::dream_dispatch::host_carrier::DreamQueue;
use crate::dream_dispatch::ownership::{
    self, ClaimantDeclaration, Ownership, OwnershipInput, Wiring,
};
use crate::dream_dispatch::tick::{DreamHandles, DreamTarget, ManualRun};
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

    /// Resolve the bound project after checking the v1 envelope and admitting
    /// either a principal-less plugin route or a daemon-attested harness route.
    fn dream_lane(
        &self,
        channel: u16,
        request: &Value,
        method: &str,
    ) -> Result<(SessionBinding, String), HandlerOutcome> {
        if request.get("v").and_then(Value::as_u64) != Some(1) {
            return Err(HandlerOutcome::Error {
                code: "bad_request".into(),
                message: format!("{method} requires v=1"),
            });
        }
        let binding = self
            .facade_binding(channel)
            .map_err(|_| HandlerOutcome::Error {
                code: "route_unbound".into(),
                message: format!("{method} on a channel with no session binding"),
            })?;
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
        Wiring {
            broca: self.dream_runs.broca_wired(),
            ..Wiring::production()
        }
    }

    /// The handles a Rust dream run needs, with this handler's wiring.
    pub(crate) fn dream_handles(&self) -> DreamHandles {
        DreamHandles {
            store: self.store.clone(),
            claimants: self.dream_claimants.clone(),
            queue: self.dream_children.clone(),
            broca_routes: self.broca_dream_tools.clone(),
            runs: self.dream_runs.clone(),
            wiring: self.dream_wiring(),
            module_id: std::env::var("SUBC_MODULE_ID")
                .ok()
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| crate::DEFAULT_MODULE_ID.to_owned()),
        }
    }

    /// Remember the project of an admitted dream route, so the Rust tick can find
    /// it, and start the tick timer once a project has been seen. Only while the
    /// user has the Rust dreamer switched on: with it off nothing is recorded and
    /// no timer runs, exactly as before the tick existed.
    fn record_dream_target(&self, binding: &SessionBinding, project: &str) {
        if !self
            .effective_config(&binding.project_root)
            .rust_background_enabled()
        {
            return;
        }
        self.dream_runs.record(
            project,
            DreamTarget {
                directory: binding.project_root.clone(),
                session: binding.session.clone(),
                harness: binding.harness.clone(),
                seen_at_ms: now_ms(),
            },
        );
        // Tests drive runs explicitly; a background timer would race them.
        #[cfg(not(test))]
        self.dream_handles().ensure_timer();
    }

    /// `dream.run {v:1, task, command_id}`: run one published task now, on the
    /// manual entry, under a durable command id (a replayed id never runs twice).
    /// A task Rust has not published is refused, so it stays with TypeScript.
    pub(crate) fn handle_dream_run(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (binding, project) = match self.dream_lane(channel, request, "dream.run") {
            Ok(lane) => lane,
            Err(refusal) => return refusal,
        };
        let Some(task) = request
            .get("task")
            .and_then(Value::as_str)
            .and_then(|name| {
                mc_store::dream_scheduler::schedules::CANONICAL_TASKS
                    .into_iter()
                    .find(|t| t.as_str() == name)
            })
        else {
            return invalid_params_error("dream.run requires a canonical task");
        };
        let Some(command_id) = request
            .get("command_id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty() && id.len() <= 256)
        else {
            return invalid_params_error("dream.run command_id must be 1-256 bytes");
        };
        self.record_dream_target(&binding, &project);
        if !self.dream_ownership(&binding, &project).owns(task) {
            return respond(json!({"ok": false, "refusal": "not_published"}));
        }
        let started = self
            .dream_handles()
            .start(
                &project,
                Some(ManualRun {
                    task,
                    command_id: command_id.to_owned(),
                }),
            )
            .is_some();
        respond(json!({"ok": started, "started": started}))
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
        self.record_dream_target(&binding, &project);
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
                        declaration
                            .on_route(&binding.session, &binding.harness)
                            .in_directory(&binding.project_root),
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
