//! Which dream tasks Rust runs on a host: the single published list.
//!
//! A plugin attached to ck-mc reads this list over `dream.ownership` and skips
//! exactly the tasks named in it; it keeps no list of its own. A task is
//! published for a project only when Rust can actually run it there:
//!
//! 1. the user enabled `rust_background_enabled`;
//! 2. a production executor for the task is wired (see [`Wiring::production`]);
//! 3. the carrier the user's runner choice selects can carry every child the
//!    task opens. For the Host runner that means an attested harness claimant
//!    (the THALAMUS harness, when no plugin runs the host) declared on one of the project's
//!    routes, within [`DECLARATION_TTL_MS`], the agents and capabilities the
//!    dream-claim-v1 claim route would admit. A plugin route cannot declare one.
//!    For Broca it means the user configured Broca and a Broca transport is wired.
//!
//! Anything else stays with TypeScript, so a host without ck-mc, or with ck-mc
//! but no capable claimant, keeps running every dreamer task as it does today.

use crate::config::McModuleConfig;
use crate::dream_runner::{resolve_task_models, DreamRole};
use crate::historian_runner::{HistorianRunnerKind, ResolvedRunner, RunnerSource};
use mc_store::dream_scheduler::schedules::{TaskName, CANONICAL_TASKS};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

/// How long a claimant's declaration stays valid. A claimant re-declares while it
/// polls; one silent for longer may have stopped polling, and a child queued for
/// it would never be claimed, so its tasks fall back to TypeScript.
pub const DECLARATION_TTL_MS: i64 = 10 * 60_000;

/// The guards every claimed child needs, whatever its tools.
const MANDATORY_CAPABILITIES: [&str; 6] = [
    "child_guard",
    "steps",
    "tokens",
    "stop",
    "retire",
    "task_tools",
];

/// The tool the claimant routes back to Rust's task router. Every other tool runs
/// inside the host and therefore needs the host's own filesystem fence.
const TASK_ROUTED_TOOL: &str = "ctx_memory";

/// Why the claim route would refuse to hand a child with these tools and model to
/// a claimant declaring `capabilities`, or `None` when it would admit it. Both the
/// claim route and publication call this, so the two cannot disagree.
pub fn claim_refusal(
    capabilities: &Value,
    allowed_tools: &[&str],
    model_missing: bool,
) -> Option<String> {
    let Some(tools) = capabilities.get("tools").and_then(Value::as_array) else {
        return Some("tools".into());
    };
    let mut required: Vec<&str> = MANDATORY_CAPABILITIES.to_vec();
    if allowed_tools.iter().any(|tool| *tool != TASK_ROUTED_TOOL) {
        required.push("filesystem_fence");
    }
    if model_missing {
        required.push("default_model");
    }
    if let Some(missing) = required
        .iter()
        .find(|key| capabilities.get(**key).and_then(Value::as_bool) != Some(true))
    {
        return Some((*missing).to_string());
    }
    allowed_tools
        .iter()
        .find(|tool| !tools.iter().any(|declared| declared.as_str() == Some(tool)))
        .map(|tool| format!("tool:{tool}"))
}

/// The child roles each task's Rust host opens. `None` means no Rust host exists
/// for the task, whatever is wired. A source test pins this table to the hosts.
pub fn task_roles(task: TaskName) -> Option<&'static [DreamRole]> {
    match task {
        TaskName::Classify => Some(&[DreamRole::Classifier]),
        TaskName::Map | TaskName::Verify | TaskName::VerifyBroad => {
            Some(&[DreamRole::MemoryMapper])
        }
        TaskName::Curate => Some(&[DreamRole::Curate]),
        TaskName::Retrospective => Some(&[DreamRole::Reviewer, DreamRole::Retrospective]),
        TaskName::ReviewUserMemories => Some(&[DreamRole::Reviewer]),
        TaskName::PromotePrimers | TaskName::RefreshPrimers => {
            Some(&[DreamRole::PrimerInvestigator])
        }
        TaskName::CompressCues | TaskName::MaintainDocs | TaskName::EvaluateSmartNotes => None,
    }
}

/// What a running claimant can carry: its claim capabilities and, for each hidden
/// agent it registers, the fixed tools that registration allows. `session` and
/// `harness` come from the route it declared on, never from the request; Host
/// children for its project are queued on that session.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimantDeclaration {
    pub capabilities: Value,
    pub agents: BTreeMap<String, Vec<String>>,
    pub declared_at_ms: i64,
    pub session: String,
    pub harness: String,
    /// The project root of the declaring route: the directory its children work in.
    pub directory: std::path::PathBuf,
}

const MAX_DECLARED_NAMES: usize = 32;
const MAX_NAME_BYTES: usize = 128;

impl ClaimantDeclaration {
    /// Parse `{capabilities, agents}` from a request. Oversized or malformed input
    /// is refused rather than truncated, so a declaration is never half-read.
    pub fn parse(value: &Value, now_ms: i64) -> Result<Self, String> {
        let name = |v: &Value| {
            v.as_str()
                .filter(|s| !s.is_empty() && s.len() <= MAX_NAME_BYTES)
                .map(str::to_owned)
                .ok_or_else(|| "invalid_claimant".to_string())
        };
        let capabilities = value
            .get("capabilities")
            .filter(|v| v.is_object())
            .ok_or("invalid_claimant")?;
        let tools = capabilities
            .get("tools")
            .and_then(Value::as_array)
            .ok_or("invalid_claimant")?;
        if tools.len() > MAX_DECLARED_NAMES {
            return Err("invalid_claimant".into());
        }
        let mut kept = Map::new();
        kept.insert(
            "tools".into(),
            Value::Array(
                tools
                    .iter()
                    .map(|t| name(t).map(Value::String))
                    .collect::<Result<_, _>>()?,
            ),
        );
        for key in MANDATORY_CAPABILITIES
            .iter()
            .chain(["filesystem_fence", "default_model"].iter())
        {
            match capabilities.get(*key) {
                None => {}
                Some(Value::Bool(flag)) => {
                    kept.insert((*key).into(), Value::Bool(*flag));
                }
                Some(_) => return Err("invalid_claimant".into()),
            }
        }
        let agents_value = value
            .get("agents")
            .and_then(Value::as_object)
            .ok_or("invalid_claimant")?;
        if agents_value.len() > MAX_DECLARED_NAMES {
            return Err("invalid_claimant".into());
        }
        let mut agents = BTreeMap::new();
        for (agent, carried) in agents_value {
            let agent = name(&Value::String(agent.clone()))?;
            let carried = carried.as_array().ok_or("invalid_claimant")?;
            if carried.len() > MAX_DECLARED_NAMES {
                return Err("invalid_claimant".into());
            }
            agents.insert(agent, carried.iter().map(name).collect::<Result<_, _>>()?);
        }
        Ok(Self {
            capabilities: Value::Object(kept),
            agents,
            declared_at_ms: now_ms,
            session: String::new(),
            harness: String::new(),
            directory: std::path::PathBuf::new(),
        })
    }

    /// Attach the identity of the route the declaration arrived on.
    pub fn on_route(mut self, session: &str, harness: &str) -> Self {
        self.session = session.to_owned();
        self.harness = harness.to_owned();
        self
    }

    /// Attach the declaring route's project root.
    pub fn in_directory(mut self, directory: &std::path::Path) -> Self {
        self.directory = directory.to_owned();
        self
    }

    /// Why this claimant cannot carry a child of `role`, or `None` when it can.
    pub(crate) fn refusal(&self, role: DreamRole, model_missing: bool) -> Option<String> {
        let Some(carried) = self.agents.get(role.agent()) else {
            return Some(format!("claimant_agent:{}", role.agent()));
        };
        if let Some(tool) = role
            .tools()
            .iter()
            .find(|tool| !carried.iter().any(|c| c == *tool))
        {
            return Some(format!("claimant_agent_tool:{}:{tool}", role.agent()));
        }
        claim_refusal(&self.capabilities, role.tools(), model_missing)
            .map(|missing| format!("claimant_capability:{missing}"))
    }
}

/// Live claimant declarations per (project, session). Entries older than
/// [`DECLARATION_TTL_MS`] no longer count; a newer declaration replaces an older
/// one for the same session.
#[derive(Default)]
pub struct ClaimantRegistry {
    entries: Mutex<HashMap<(String, String), ClaimantDeclaration>>,
}

impl ClaimantRegistry {
    pub fn declare(&self, project: &str, session: &str, declaration: ClaimantDeclaration) {
        if let Ok(mut entries) = self.entries.lock() {
            let now = declaration.declared_at_ms;
            entries.retain(|_, d| now.saturating_sub(d.declared_at_ms) < DECLARATION_TTL_MS);
            entries.insert((project.to_owned(), session.to_owned()), declaration);
        }
    }

    pub fn withdraw(&self, project: &str, session: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&(project.to_owned(), session.to_owned()));
        }
    }

    /// The most recent declaration still fresh at `now_ms` on any of the
    /// project's sessions. Ties go to the lexically smallest session, so the
    /// answer does not depend on map order.
    pub fn current(&self, project: &str, now_ms: i64) -> Option<ClaimantDeclaration> {
        let entries = self.entries.lock().ok()?;
        entries
            .iter()
            .filter(|((p, _), d)| {
                p == project
                    && d.declared_at_ms <= now_ms
                    && now_ms.saturating_sub(d.declared_at_ms) < DECLARATION_TTL_MS
            })
            .max_by(|((_, a_session), a), ((_, b_session), b)| {
                a.declared_at_ms
                    .cmp(&b.declared_at_ms)
                    .then_with(|| b_session.cmp(a_session))
            })
            .map(|(_, d)| d.clone())
    }
}

/// Which executors this binary has wired for production work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wiring {
    /// Tasks with a production executor. Publication never names any other task.
    pub tasks: Vec<TaskName>,
    /// Whether a Broca transport is wired for dream children.
    pub broca: bool,
    /// Whether the wired Broca runner is known to admit AFT's read tools
    /// (read, grep, glob, aft_outline, aft_zoom, aft_search) for a dream child.
    /// map-memories, verify and verify-broad read the repository, so a Broca run
    /// publishes them only when this holds.
    ///
    /// Production leaves it false: Broca has no way to declare which tools it
    /// admits. llm-runner/v1 `role.describe` lists capability groups only, and
    /// whether Broca admits the `aft` plan item is decided by Broca's own
    /// allowlist, which Magic Context cannot see. The real fix is Broca declaring
    /// its tool capability in `role.describe`; until then those three tasks stay
    /// with TypeScript for Broca users.
    pub broca_file_read: bool,
}

impl Wiring {
    /// The wiring of this build. It names no task until a production executor
    /// runs them, so publication stays empty and TypeScript keeps every task.
    pub fn production() -> Self {
        Self {
            tasks: super::dispatcher::OPERATIONAL_TASKS.to_vec(),
            broca: false,
            broca_file_read: false,
        }
    }
}

pub struct OwnershipInput<'a> {
    pub config: &'a McModuleConfig,
    /// The trusted dreamer settings (user profile applied), used to see whether a
    /// task's child would ask for the session's default model. `None` when the
    /// trusted config could not be resolved; nothing is published then.
    pub settings: Option<&'a Value>,
    pub harness: &'a str,
    pub wiring: &'a Wiring,
    pub claimant: Option<&'a ClaimantDeclaration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ownership {
    pub activated: bool,
    /// The runner this project's dream children would use, and why.
    pub runner: ResolvedRunner,
    /// Whether a fresh claimant declaration was considered.
    pub claimant_declared: bool,
    pub published: Vec<TaskName>,
    /// Every canonical task that is not published, with the first reason found.
    pub withheld: Vec<(TaskName, String)>,
}

impl Ownership {
    pub fn owns(&self, task: TaskName) -> bool {
        self.published.contains(&task)
    }

    pub fn to_json(&self) -> Value {
        let runner = self.runner;
        json!({
            "ok": true,
            "v": 1,
            "activated": self.activated,
            "runner": {"kind": runner.kind.as_str(), "source": runner.source.as_str()},
            "claimant_declared": self.claimant_declared,
            "published": self.published.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
            "withheld": self.withheld.iter().map(|(t, reason)| json!({"task": t.as_str(), "reason": reason})).collect::<Vec<_>>(),
        })
    }
}

/// Why `task` is not published for this input, or `None` when Rust runs it.
fn withheld_reason(task: TaskName, input: &OwnershipInput<'_>) -> Option<String> {
    if !input.config.rust_background_enabled() {
        return Some("inactive".into());
    }
    let Some(roles) = task_roles(task) else {
        return Some("no_rust_host".into());
    };
    if !input.wiring.tasks.contains(&task) {
        return Some("host_unwired".into());
    }
    let Some(settings) = input.settings else {
        return Some("config_unavailable".into());
    };
    let runner = input.config.dreamer_runner_for(input.harness);
    match runner.kind {
        HistorianRunnerKind::Broca => {
            // Broca is used only when the user named it (`dreamer.runner` or
            // `historian.runner`); a harness that merely defaults to Broca stays
            // with TypeScript, so Rust background work never requires Broca.
            if runner.source != RunnerSource::Configured {
                return Some("broca_not_configured".into());
            }
            if !input.wiring.broca {
                return Some("broca_unwired".into());
            }
            // BrocaCarrier refuses to open a child whose request names no model.
            if resolve_task_models(settings, input.harness, task.as_str())
                .primary
                .is_none()
            {
                return Some("broca_model_required".into());
            }
            // A child whose tools are not all served by Magic Context itself reads
            // files through AFT, which only a runner declaring file reads carries.
            let reads_files = roles.iter().any(|role| {
                role.tools()
                    .iter()
                    .any(|tool| !super::broca_carrier::MC_TOOLS.contains(tool))
            });
            if reads_files && !input.wiring.broca_file_read {
                return Some("broca_file_read".into());
            }
            None
        }
        HistorianRunnerKind::Host => {
            let Some(claimant) = input.claimant else {
                return Some("no_claimant".into());
            };
            let model_missing = resolve_task_models(settings, input.harness, task.as_str())
                .primary
                .is_none();
            roles
                .iter()
                .find_map(|role| claimant.refusal(*role, model_missing))
        }
    }
}

/// Compute the published list. Pure: the caller supplies every input.
pub fn publish(input: &OwnershipInput<'_>) -> Ownership {
    let mut published = Vec::new();
    let mut withheld = Vec::new();
    for task in CANONICAL_TASKS {
        match withheld_reason(task, input) {
            None => published.push(task),
            Some(reason) => withheld.push((task, reason)),
        }
    }
    Ownership {
        activated: input.config.rust_background_enabled(),
        runner: input.config.dreamer_runner_for(input.harness),
        claimant_declared: input.claimant.is_some(),
        published,
        withheld,
    }
}

#[cfg(test)]
pub(crate) mod tests;
