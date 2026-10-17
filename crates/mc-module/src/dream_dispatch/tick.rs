//! The Rust dreamer's tick and manual entry for one project.
//!
//! A run starts on a background worker (`background::dreamer_tick` or
//! `background::manual_dream`), which resolves the trusted config once for the
//! whole run. From that one snapshot the run computes the published list
//! (`ownership::publish`) for the project and dispatches only those tasks: a
//! project whose claimant has gone, or whose user switched Rust off, gets nothing.
//! Host children are queued on the declaring claimant's session, in its project
//! root; a Broca run uses the configured Broca runner.
//!
//! Before planning, each task's Rust schedule adopts the TypeScript scheduler's
//! progress, and after the run the TypeScript row adopts Rust's (see
//! `mc_store::dream_schedule_bridge`), so a flip of ownership inside one cron
//! period neither repeats nor skips a run.

use super::broca_carrier::BrocaToolRoute;
use super::broca_port::SubcBroca;
use super::context::{Cancellation, Clock};
use super::dispatcher::{DispatchOutcome, Dispatcher};
use super::executor::{BrocaPorts, DreamExecutor, NoBroca, Transport};
use super::host_carrier::DreamQueue;
use super::ownership::{self, ClaimantRegistry, OwnershipInput, Wiring};
use crate::background::{self, ConfigInput};
use crate::config_parity::{ConfigResolveRequest, CoreConfigResolver};
use crate::dream_runner::resolve_task_models;
use crate::historian_runner::HistorianRunnerKind;
use crate::route_targets::RouteTargetConfig;
use mc_store::dream_scheduler::schedules::{TaskConfig, TaskName};
use mc_store::dream_scheduler::SqliteDreamScheduler;
use mc_store::parity_schema_manifest::{
    CapabilityResult, Generation, ProjectId, SessionId, StoreScope,
};
use mc_store::McStore;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// How often the timer looks for due dream tasks; the TypeScript timer's
/// cadence is 15 minutes, and a cron slot is never finer than a minute.
pub const TICK_INTERVAL: Duration = Duration::from_secs(60);
/// A project not seen on any dream route for this long is no longer ticked.
pub const TARGET_TTL_MS: i64 = 60 * 60_000;
/// The longest one task may run before the dispatcher aborts it.
pub const TASK_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The route a project was last seen on: where its children work and which
/// session a Broca child names as its parent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamTarget {
    pub directory: PathBuf,
    pub session: String,
    pub harness: String,
    pub seen_at_ms: i64,
}

struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        crate::now_ms()
    }
}

/// Process-wide state of the Rust dreamer.
pub struct DreamRuns {
    targets: Mutex<HashMap<String, DreamTarget>>,
    in_flight: Arc<Mutex<HashSet<String>>>,
    timer: AtomicBool,
    /// The connection to the configured runner module, when this process declares a
    /// background-completion route to one. Without it no Broca run is possible.
    broca: Option<(PathBuf, RouteTargetConfig)>,
    resolver: OnceLock<Arc<dyn CoreConfigResolver>>,
    clock: OnceLock<Arc<dyn Clock>>,
}

impl DreamRuns {
    pub fn new(connection_file: Option<PathBuf>, route_targets: &RouteTargetConfig) -> Self {
        Self {
            targets: Mutex::default(),
            in_flight: Arc::default(),
            timer: AtomicBool::new(false),
            broca: connection_file
                .filter(|_| SubcBroca::target(route_targets).is_some())
                .map(|file| (file, route_targets.clone())),
            resolver: OnceLock::new(),
            clock: OnceLock::new(),
        }
    }

    /// Whether a Broca transport for dream children is wired in this process.
    pub fn broca_wired(&self) -> bool {
        self.broca.is_some()
    }

    /// Remember where `project` was last seen.
    pub fn record(&self, project: &str, target: DreamTarget) {
        if let Ok(mut targets) = self.targets.lock() {
            targets.insert(project.to_owned(), target);
        }
    }

    fn target(&self, project: &str) -> Option<DreamTarget> {
        self.targets.lock().ok()?.get(project).cloned()
    }

    fn fresh_projects(&self, now_ms: i64) -> Vec<String> {
        self.targets
            .lock()
            .map(|targets| {
                targets
                    .iter()
                    .filter(|(_, t)| now_ms.saturating_sub(t.seen_at_ms) < TARGET_TTL_MS)
                    .map(|(project, _)| project.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Replace the config resolver for a hermetic test; production resolves the
    /// trusted user and project config from the environment.
    pub fn use_resolver(&self, resolver: Arc<dyn CoreConfigResolver>) {
        let _ = self.resolver.set(resolver);
    }

    /// Replace the clock for a hermetic test.
    pub fn use_clock(&self, clock: Arc<dyn Clock>) {
        let _ = self.clock.set(clock);
    }

    fn resolver(&self) -> Arc<dyn CoreConfigResolver> {
        self.resolver
            .get_or_init(|| {
                Arc::new(crate::config_parity::TrustedConfigResolver::from_environment())
            })
            .clone()
    }

    fn clock(&self) -> Arc<dyn Clock> {
        self.clock.get_or_init(|| Arc::new(SystemClock)).clone()
    }
}

/// What one run did, task by task. Empty when nothing was published or due.
pub type RunReport = Vec<(TaskName, DispatchOutcome)>;

/// A requested manual run of one task, under a durable command id.
#[derive(Debug, Clone)]
pub struct ManualRun {
    pub task: TaskName,
    pub command_id: String,
}

/// The shared handles a run needs, cloned out of the handler so the timer and
/// the worker threads outlive no borrow.
#[derive(Clone)]
pub struct DreamHandles {
    pub store: Arc<OnceLock<Arc<McStore>>>,
    pub claimants: Arc<ClaimantRegistry>,
    pub queue: Arc<DreamQueue>,
    pub broca_routes: Arc<BrocaToolRoute>,
    pub runs: Arc<DreamRuns>,
    pub wiring: Wiring,
    pub module_id: String,
}

/// Removes a project from the in-flight set when its worker ends, however it ends.
struct InFlight {
    set: Arc<Mutex<HashSet<String>>>,
    project: String,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.project);
        }
    }
}

/// A started run: the worker resolves config, then reports what it dispatched.
pub type Job = std::thread::JoinHandle<Result<Option<Result<RunReport, String>>, String>>;

impl DreamHandles {
    /// Start one run for `project` on a background worker: the scheduled tick, or
    /// with `manual` one forced task on the manual entry. Returns `None` when the
    /// project was never seen on a dream route, its store is not open, or a run
    /// for it is already in flight.
    pub fn start(&self, project: &str, manual: Option<ManualRun>) -> Option<Job> {
        let store = self.store.get()?.clone();
        // Declarations are stamped with the wall clock when they arrive, so their
        // freshness is judged by the same clock.
        let claimant = self.claimants.current(project, crate::now_ms());
        let target = self.runs.target(project);
        // Host children are queued on the claimant's session in its root; without a
        // claimant only a Broca run is possible, on the route the project was seen on.
        let (directory, session, harness) = match (&claimant, target) {
            (Some(c), _) if !c.directory.as_os_str().is_empty() => {
                (c.directory.clone(), c.session.clone(), c.harness.clone())
            }
            (_, Some(t)) => (t.directory, t.session, t.harness),
            _ => return None,
        };
        {
            let mut in_flight = self.runs.in_flight.lock().ok()?;
            if !in_flight.insert(project.to_owned()) {
                return None;
            }
        }
        let guard = InFlight {
            set: self.runs.in_flight.clone(),
            project: project.to_owned(),
        };
        let input = ConfigInput {
            resolver: self.runs.resolver(),
            request: ConfigResolveRequest {
                user_config_path: String::new(),
                project_root: directory.to_string_lossy().into_owned(),
                generation: Generation(0),
            },
        };
        let handles = self.clone();
        let project = project.to_owned();
        let manual_entry = manual.is_some();
        let work = move |unit: background::Unit| {
            let _guard = guard;
            let captured = unit.captured_dream_config(harness.clone(), directory.clone());
            let run = Run {
                handles: &handles,
                store,
                project: &project,
                session: &session,
                harness: &harness,
                claimant: claimant.as_ref(),
            };
            run.execute(captured, manual)
        };
        let job = if manual_entry {
            background::manual_dream(input, work)
        } else {
            background::dreamer_tick(input, work)
        };
        job.ok()
    }

    /// Start the process timer once, on the current tokio runtime.
    pub fn ensure_timer(&self) {
        if self.runs.timer.swap(true, Ordering::AcqRel) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            self.runs.timer.store(false, Ordering::Release);
            return;
        };
        let handles = self.clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(TICK_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                let now = handles.runs.clock().now_ms();
                for project in handles.runs.fresh_projects(now) {
                    // The worker runs detached; its outcome is in the schedule rows.
                    let _ = handles.start(&project, None);
                }
            }
        });
    }
}

struct Run<'a> {
    handles: &'a DreamHandles,
    store: Arc<McStore>,
    project: &'a str,
    session: &'a str,
    harness: &'a str,
    claimant: Option<&'a ownership::ClaimantDeclaration>,
}

impl Run<'_> {
    fn execute(
        &self,
        captured: Arc<super::context::CapturedConfig>,
        manual: Option<ManualRun>,
    ) -> Result<RunReport, String> {
        let published = ownership::publish(&OwnershipInput {
            config: &captured.route,
            settings: Some(&captured.effective),
            harness: self.harness,
            wiring: &self.handles.wiring,
            claimant: self.claimant,
        });
        if published.published.is_empty() {
            return Ok(Vec::new());
        }
        let root = self
            .store
            .data_dir()
            .ok_or("dream data directory unavailable")?
            .join("dream");
        mc_store::private_permissions::ensure_directory(&root, true).map_err(|e| e.to_string())?;
        let fence_root = root.join("fences");
        mc_store::private_permissions::ensure_directory(&fence_root, true)
            .map_err(|e| e.to_string())?;
        let scheduler = Arc::new(
            SqliteDreamScheduler::open(root.join("scheduler.db"), captured.activated)
                .map_err(|e| format!("{e:?}"))?,
        );
        let scope = StoreScope {
            project: ProjectId(self.project.to_owned()),
            session: SessionId(self.session.to_owned()),
            generation: Generation(1),
        };
        let configs: Vec<TaskConfig> = published
            .published
            .iter()
            .map(|task| self.task_config(*task, &captured.effective))
            .collect::<Result<_, String>>()?;
        for config in &configs {
            if let Ok(Some(legacy)) = self.store.legacy_task_schedule(self.project, config.task) {
                let _ = scheduler.adopt_legacy(&scope, config, &legacy);
            }
        }
        let report = match published.runner.kind {
            HistorianRunnerKind::Host => {
                let transport = Transport::<NoBroca>::Host {
                    queue: self.handles.queue.clone(),
                    fence_root,
                };
                self.dispatch(
                    transport,
                    &scheduler,
                    &scope,
                    &captured,
                    &configs,
                    &published.published,
                    manual,
                )
            }
            HistorianRunnerKind::Broca => {
                let Some((connection_file, route_targets)) = &self.handles.runs.broca else {
                    return Ok(Vec::new());
                };
                let transport = Transport::Broca {
                    ports: SubcBroca {
                        connection_file: connection_file.clone(),
                        route_targets: route_targets.clone(),
                        project_root: captured.directory.clone(),
                        harness: self.harness.to_owned(),
                    },
                    routes: self.handles.broca_routes.clone(),
                    module_id: self.handles.module_id.clone(),
                };
                self.dispatch(
                    transport,
                    &scheduler,
                    &scope,
                    &captured,
                    &configs,
                    &published.published,
                    manual,
                )
            }
        };
        for config in &configs {
            if let CapabilityResult::Available { value: Some(state) } =
                scheduler.schedule(&scope, config.task)
            {
                let _ = self
                    .store
                    .publish_task_schedule(self.project, config.task, &state);
            }
        }
        Ok(report)
    }

    fn task_config(
        &self,
        task: TaskName,
        settings: &serde_json::Value,
    ) -> Result<TaskConfig, String> {
        let legacy = self
            .store
            .legacy_task_schedule(self.project, task)
            .map_err(|e| e.to_string())?;
        Ok(TaskConfig {
            task,
            schedule: resolve_task_models(settings, self.harness, task.as_str())
                .schedule
                .unwrap_or_default(),
            has_input: true,
            legacy_last_run_at: legacy.and_then(|l| l.last_run_at),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch<B: BrocaPorts>(
        &self,
        transport: Transport<B>,
        scheduler: &Arc<SqliteDreamScheduler>,
        scope: &StoreScope,
        captured: &Arc<super::context::CapturedConfig>,
        configs: &[TaskConfig],
        published: &[TaskName],
        manual: Option<ManualRun>,
    ) -> RunReport {
        let mut dispatcher = Dispatcher {
            store: self.store.clone(),
            scheduler: scheduler.clone(),
            scope: scope.clone(),
            config: captured.clone(),
            clock: self.handles.runs.clock(),
            executor: DreamExecutor::new(
                self.store.clone(),
                scheduler.clone(),
                transport,
                published,
                &self.handles.wiring.tasks,
            ),
        };
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return Vec::new();
        };
        runtime.block_on(async {
            match manual {
                Some(manual) => {
                    let Some(config) = configs.iter().find(|c| c.task == manual.task) else {
                        return vec![(manual.task, DispatchOutcome::Unavailable)];
                    };
                    let outcome = dispatcher
                        .manual(
                            config,
                            &manual.command_id,
                            TASK_TIMEOUT,
                            Cancellation::default(),
                        )
                        .await;
                    vec![(manual.task, outcome)]
                }
                None => dispatcher
                    .tick(configs, captured.route.memory_enabled, TASK_TIMEOUT)
                    .await
                    .unwrap_or_default(),
            }
        })
    }
}
