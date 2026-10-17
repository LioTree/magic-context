//! Plan scheduled and manual dream tasks on a background worker. Acquire the
//! shared context.db domain before the separate scheduler's task lease.

use super::context::{Cancellation, CapturedConfig, Clock, TaskContext};
use super::domain_control::{available, DomainControl, LeaseGuard};
use mc_store::dream_domain::LEASE_DURATION_MS;
use mc_store::dream_scheduler::schedules::{RunOutcome, ScheduleState, TaskConfig, TaskName};
use mc_store::dream_scheduler::SqliteDreamScheduler;
use mc_store::parity_schema_manifest::{
    BackgroundTask, DreamClaimRequest, DreamFinishRequest, InvocationId, StoreScope,
};
use mc_store::McStore;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Register only tasks proven to apply durable effects through real model-session
/// transports. Planners alone cannot take execution away from TypeScript.
pub const OPERATIONAL_TASKS: &[TaskName] = &[];

#[allow(async_fn_in_trait)]
pub trait TaskExecutor {
    fn operational_tasks(&self) -> &[TaskName];
    fn gate(
        &mut self,
        task: TaskName,
        scope: &StoreScope,
        state: &ScheduleState,
    ) -> Result<bool, String>;
    async fn run(&mut self, context: &TaskContext) -> RunOutcome;
}

pub struct UnavailableTasks;

impl TaskExecutor for UnavailableTasks {
    fn operational_tasks(&self) -> &[TaskName] {
        OPERATIONAL_TASKS
    }
    fn gate(&mut self, _: TaskName, _: &StoreScope, _: &ScheduleState) -> Result<bool, String> {
        Err("unavailable_capability".into())
    }
    async fn run(&mut self, _: &TaskContext) -> RunOutcome {
        let mut outcome = RunOutcome::new(mc_store::dream_scheduler::schedules::RunStatus::Failed);
        outcome.error = Some("unavailable_capability".into());
        outcome
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchOutcome {
    Inactive,
    Unavailable,
    Refused(String),
    Finished(mc_store::dream_scheduler::schedules::RunStatus),
    Aborted(super::context::ControlError),
}

pub struct Dispatcher<E = UnavailableTasks> {
    pub store: Arc<McStore>,
    pub scheduler: Arc<SqliteDreamScheduler>,
    pub scope: StoreScope,
    pub config: Arc<CapturedConfig>,
    pub clock: Arc<dyn Clock>,
    pub executor: E,
}

fn background_task(task: TaskName) -> BackgroundTask {
    match task {
        TaskName::Map => BackgroundTask::Map,
        TaskName::Verify | TaskName::VerifyBroad => BackgroundTask::Verify,
        TaskName::Curate => BackgroundTask::Curate,
        TaskName::CompressCues => BackgroundTask::CompressMuralCues,
        TaskName::Classify => BackgroundTask::Classify,
        TaskName::Retrospective => BackgroundTask::Retrospective,
        TaskName::MaintainDocs => BackgroundTask::MaintainDocs,
        TaskName::EvaluateSmartNotes => BackgroundTask::EvaluateSmartNotes,
        TaskName::ReviewUserMemories => BackgroundTask::ReviewUserMemories,
        TaskName::PromotePrimers | TaskName::RefreshPrimers => BackgroundTask::Primers,
    }
}

fn unique_holder() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    // A process start timestamp plus monotonic sequence also distinguishes retries
    // across restarts without deriving ownership from a request-supplied command id.
    format!(
        "rust:{}:{}:{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

impl<E: TaskExecutor> Dispatcher<E> {
    /// Exclude tasks without an executor before planning, so discovering missing
    /// support cannot seed, reconcile or advance their durable schedules.
    pub async fn tick(
        &mut self,
        configs: &[TaskConfig],
        project_memory_enabled: bool,
        timeout: Duration,
    ) -> Result<Vec<(TaskName, DispatchOutcome)>, String> {
        if !self.config.activated {
            return Ok(Vec::new());
        }
        let supported: Vec<_> = configs
            .iter()
            .filter(|c| self.executor.operational_tasks().contains(&c.task))
            .cloned()
            .collect();
        let due = available(self.scheduler.plan_due(
            &self.scope,
            &supported,
            self.clock.now_ms(),
            project_memory_enabled,
        ))?;
        let mut outcomes = Vec::new();
        for due in due {
            let invocation = format!(
                "due:{}:{}:{}",
                due.task.as_str(),
                due.scheduled_at,
                unique_holder()
            );
            outcomes.push((
                due.task,
                self.dispatch(
                    due.task,
                    &invocation,
                    None,
                    timeout,
                    Cancellation::default(),
                )
                .await,
            ));
        }
        Ok(outcomes)
    }

    /// Manual commands use a durable command id; replay cannot run a finished id.
    /// Unlike due ticks, a manual force may run a disabled schedule and bypass gates.
    pub async fn manual(
        &mut self,
        config: &TaskConfig,
        command_id: &str,
        timeout: Duration,
        cancellation: Cancellation,
    ) -> DispatchOutcome {
        self.dispatch(config.task, command_id, Some(config), timeout, cancellation)
            .await
    }

    async fn dispatch(
        &mut self,
        task: TaskName,
        invocation: &str,
        manual: Option<&TaskConfig>,
        timeout: Duration,
        cancellation: Cancellation,
    ) -> DispatchOutcome {
        if !self.config.activated {
            return DispatchOutcome::Inactive;
        }
        if !self.executor.operational_tasks().contains(&task) {
            return DispatchOutcome::Unavailable;
        }
        let now = self.clock.now_ms();
        let Some(deadline_ms) = i64::try_from(timeout.as_millis())
            .ok()
            .filter(|t| *t > 0)
            .and_then(|t| now.checked_add(t))
        else {
            return DispatchOutcome::Refused("invalid_deadline".into());
        };
        if invocation.trim().is_empty() || !self.config.directory.is_absolute() {
            return DispatchOutcome::Refused("invalid_request".into());
        }
        if cancellation.is_cancelled() {
            return DispatchOutcome::Aborted(super::context::ControlError::Cancelled);
        }
        let key = task.lease_key(&self.scope.project.0);
        let domain = match self.store.acquire_dream_domain(&key, &unique_holder(), now) {
            Ok(Some(lease)) => lease,
            Ok(None) => return DispatchOutcome::Refused("domain_busy".into()),
            Err(e) => return DispatchOutcome::Refused(e.to_string()),
        };
        let claim = DreamClaimRequest {
            scope: self.scope.clone(),
            task: background_task(task),
            domain: key,
            invocation: InvocationId(invocation.into()),
            now_ms: now,
            lease_ms: LEASE_DURATION_MS as u64,
            token_budget: task.default_budget().unwrap_or(2_500_000),
            manual_force: manual.is_some(),
        };
        let executor = &mut self.executor;
        let lease =
            match available(
                self.scheduler
                    .claim_task_checked(&claim, task, manual, |state| {
                        executor
                            .gate(task, &self.scope, state)
                            .map_err(|_| mc_store::dream_scheduler::Error::Refused("gate_error"))
                    }),
            ) {
                Ok(lease) => lease,
                Err(reason) => {
                    let _ = self.store.release_dream_domain(&domain);
                    return DispatchOutcome::Refused(reason);
                }
            };
        let control = DomainControl::new(
            self.store.clone(),
            self.scheduler.clone(),
            domain.clone(),
            lease.clone(),
            cancellation.clone(),
            self.clock.clone(),
            deadline_ms,
        );
        let mut guard = match LeaseGuard::start(control) {
            Ok(guard) => guard,
            Err(e) => {
                let _ = self.scheduler.abandon(&lease);
                let _ = self.store.release_dream_domain(&domain);
                return DispatchOutcome::Refused(e.to_string());
            }
        };
        let context = TaskContext {
            task,
            scope: self.scope.clone(),
            config: self.config.clone(),
            domain_lease: domain,
            task_lease: lease.clone(),
            cancellation,
            clock: self.clock.clone(),
            deadline_ms,
            control: guard.control.clone(),
        };
        if let Err(error) = context.check_control() {
            return DispatchOutcome::Aborted(error);
        }
        let outcome = match tokio::time::timeout(timeout, self.executor.run(&context)).await {
            Ok(outcome) => outcome,
            Err(_) => return DispatchOutcome::Aborted(super::context::ControlError::Deadline),
        };
        guard.stop();
        // Exhausting the prompt-token budget stops further tool effects but still
        // records this run's outcome and provider-reported input/cache token count.
        if let Err(error) = context.check_control() {
            if error != super::context::ControlError::BudgetExhausted {
                return DispatchOutcome::Aborted(error);
            }
        }
        let spent = match available(self.scheduler.token_budget(&lease, self.clock.now_ms())) {
            Ok(budget) => budget.spent,
            Err(reason) => return DispatchOutcome::Refused(reason),
        };
        match available(self.scheduler.finish_task(
            &DreamFinishRequest {
                lease,
                now_ms: self.clock.now_ms(),
                spent_tokens: spent,
                succeeded: outcome.status
                    == mc_store::dream_scheduler::schedules::RunStatus::Completed,
            },
            &outcome,
        )) {
            Ok(_) => {
                guard.finished();
                DispatchOutcome::Finished(outcome.status)
            }
            Err(reason) => DispatchOutcome::Refused(reason),
        }
    }
}
