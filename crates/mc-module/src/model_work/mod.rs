//! Placement and outcome accounting for ck-mc's model work.
//!
//! The scoped routing transport and runner lifecycle are injected. No live caller
//! uses this engine yet; summary and dream adapters will supply those transports.
// Remove the dead-code allowance when the first summary or dream caller lands.
#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cortexkit_role_routing::{
    errors::{Refusal, RefusalCode},
    report::{Outcome, ReportAnswer, ReportRequest, Usage},
    select::{ConcurrencySlot, Requirements, SelectRequest},
};

use crate::runner_choices::RoutedChoice;

/// A route already bound to the work's daemon scope stamp. Implementations must
/// use this same stamp for routing and runner calls, never a scope in a body.
pub trait ScopeRoute: Sync {
    /// Stable project identity for parking work across sessions of that project.
    fn project_key(&self) -> &str;
    fn select(
        &self,
        provider: &str,
        request: &SelectRequest,
    ) -> impl Future<Output = Result<RoutedChoice, Refusal>> + Send;
    fn report(
        &self,
        provider: &str,
        request: &ReportRequest,
    ) -> impl Future<Output = Result<ReportAnswer, Refusal>> + Send;
}

/// Catalog discovery is supplied by the owner of the scoped route, not inferred
/// from runner configuration. Only routing/v1 providers belong in this list.
pub struct RoutingCatalog {
    pub generation: u64,
    pub providers: Vec<String>,
}

pub struct WorkOrder<'a, S> {
    pub scope_route: &'a S,
    pub work_id: String,
    pub consumer: String,
    pub requirements: Requirements,
    pub pin: Option<String>,
    pub affinity: String,
    pub concurrency_slots: Option<Vec<ConcurrencySlot>>,
    pub deadline_ms: u64,
    pub max_decisions: usize,
}

/// The adapter owns prompt construction, validation/repair and following a send
/// to its terminal outcome. It must send exactly choice.runner (including auth).
/// Limits are available before sending, so callers can size/chunk their input.
pub trait Runner<S>: Sync {
    type Output;
    fn send(
        &self,
        scope: &S,
        choice: &RoutedChoice,
        deadline_ms: u64,
    ) -> impl Future<Output = RunResult<Self::Output>> + Send;
    /// Cancel and settle the selected send before its timeout is reported.
    fn cancel(&self, scope: &S, choice: &RoutedChoice) -> impl Future<Output = ()> + Send;
}

pub struct RunResult<T> {
    pub outcome: Outcome,
    pub output: Option<T>,
    pub runner_code: Option<String>,
    pub credential_id: Option<String>,
    pub reset_at_ms: Option<u64>,
    pub usage: Option<Usage>,
}

impl<T> RunResult<T> {
    pub fn new(outcome: Outcome, output: Option<T>) -> Self {
        Self {
            outcome,
            output,
            runner_code: None,
            credential_id: None,
            reset_at_ms: None,
            usage: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Attempt {
    pub choice: RoutedChoice,
    pub report: ReportRequest,
}

#[derive(Debug)]
pub struct WorkDone<T> {
    pub output: T,
    pub choice: RoutedChoice,
    pub attempts: Vec<Attempt>,
}

/// Engine codes describe the work; source refusals and runner codes remain
/// untouched in source/attempts for callers and routing's outcome accounting.
#[derive(Clone, Debug)]
pub struct WorkError {
    pub code: &'static str,
    pub source: Option<Box<Refusal>>,
    pub reset_at_ms: Option<u64>,
    pub modules: Vec<String>,
    pub attempts: Vec<Attempt>,
}

impl WorkError {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            source: None,
            reset_at_ms: None,
            modules: Vec::new(),
            attempts: Vec::new(),
        }
    }
}

pub trait Clock {
    fn now_ms(&self) -> u64;
}

pub struct WallClock;

impl Clock for WallClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

/// Keep accounting retries small during a prolonged routing outage. Reports hold
/// no model output; the oldest accounting entry is sacrificed before paid work.
pub const PENDING_REPORT_CAP: usize = 64;

struct PendingReport {
    provider: String,
    report: ReportRequest,
    source: Refusal,
}

pub struct Engine<C = WallClock> {
    clock: C,
    provider: Option<(u64, Result<String, WorkError>)>,
    parked: HashMap<(String, String), WorkError>,
    misconfigured: HashMap<(String, String), (u64, WorkError)>,
    pending_reports: VecDeque<PendingReport>,
}

impl<C: Clock> Engine<C> {
    pub fn new(clock: C) -> Self {
        Self {
            clock,
            provider: None,
            parked: HashMap::new(),
            misconfigured: HashMap::new(),
            pending_reports: VecDeque::new(),
        }
    }

    fn provider(&mut self, catalog: &RoutingCatalog) -> Result<String, WorkError> {
        if let Some((generation, result)) = &self.provider {
            if *generation == catalog.generation {
                return result.clone();
            }
        }
        let result = match catalog.providers.as_slice() {
            [] => Err(WorkError::new("mc_routing_unavailable")),
            [provider] => Ok(provider.clone()),
            providers => {
                let mut error = WorkError::new("mc_routing_ambiguous");
                error.modules = providers.to_vec();
                Err(error)
            }
        };
        self.provider = Some((catalog.generation, result.clone()));
        result
    }

    fn queue_report(&mut self, provider: &str, report: ReportRequest, source: Refusal) {
        if self.pending_reports.iter().any(|pending| {
            pending.provider == provider && pending.report.decision_id == report.decision_id
        }) {
            return;
        }
        tracing::warn!(
            decision_id = %report.decision_id,
            routing_provider = provider,
            code = %source.code,
            "model work report refused; queued for retry"
        );
        if self.pending_reports.len() == PENDING_REPORT_CAP {
            let oldest = self
                .pending_reports
                .pop_front()
                .expect("report queue is full");
            tracing::warn!(
                decision_id = %oldest.report.decision_id,
                routing_provider = %oldest.provider,
                "model work pending-report queue full; dropped oldest report"
            );
        }
        self.pending_reports.push_back(PendingReport {
            provider: provider.to_owned(),
            report,
            source,
        });
    }

    async fn retry_pending_reports<S: ScopeRoute>(&mut self, provider: &str, scope: &S) {
        let mut index = 0;
        while index < self.pending_reports.len() {
            let pending = &self.pending_reports[index];
            // Reports are idempotent by decision id. Leave an unacknowledged
            // entry in place across awaits, and log only its initial refusal.
            if pending.provider == provider && scope.report(provider, &pending.report).await.is_ok()
            {
                self.pending_reports.remove(index);
            } else {
                index += 1;
            }
        }
    }

    pub async fn run<S: ScopeRoute, R: Runner<S>>(
        &mut self,
        catalog: &RoutingCatalog,
        order: &WorkOrder<'_, S>,
        runner: &R,
    ) -> Result<WorkDone<R::Output>, WorkError> {
        let provider = self.provider(catalog)?;
        self.retry_pending_reports(&provider, order.scope_route)
            .await;
        let key = (
            order.scope_route.project_key().to_owned(),
            order.consumer.clone(),
        );
        if let Some(error) = self.parked.get(&key) {
            if self.clock.now_ms() < error.reset_at_ms.unwrap_or(0) {
                return Err(error.clone());
            }
        }
        self.parked.remove(&key);
        if let Some((generation, error)) = self.misconfigured.get(&key) {
            if *generation == catalog.generation {
                return Err(error.clone());
            }
        }
        self.misconfigured.remove(&key);

        let mut attempts = Vec::new();
        let mut exclude = Vec::new();
        let mut timeouts = 0;
        loop {
            let remaining = order.deadline_ms.saturating_sub(self.clock.now_ms());
            if remaining == 0 {
                let mut error = WorkError::new("mc_run_timed_out");
                error.attempts = attempts;
                return Err(error);
            }
            if attempts.len() >= order.max_decisions {
                let mut error = WorkError::new("mc_route_exhausted");
                error.attempts = attempts;
                return Err(error);
            }
            let mut request = SelectRequest::new(&order.consumer, order.requirements.clone());
            request.pin = order.pin.clone();
            request.affinity = Some(order.affinity.clone());
            request.correlation_id = Some(order.work_id.clone());
            request.concurrency_slots = order.concurrency_slots.clone();
            request.exclude = (!exclude.is_empty()).then(|| exclude.clone());
            let selected = tokio::time::timeout(
                Duration::from_millis(remaining),
                order.scope_route.select(&provider, &request),
            )
            .await;
            let choice = match selected {
                Ok(Ok(choice)) => choice,
                Ok(Err(source)) => {
                    let mut error = WorkError::new(match source.code {
                        RefusalCode::InvalidRequirements | RefusalCode::UnknownConsumer => {
                            "mc_route_misconfigured"
                        }
                        RefusalCode::NoRoute if source.wait_until_ms().is_none() => "mc_no_route",
                        _ if source.wait_until_ms().is_some() => "mc_route_waiting",
                        _ => "mc_route_refused",
                    });
                    error.reset_at_ms = source.wait_until_ms();
                    error.source = Some(Box::new(source));
                    // Parking belongs to the project/consumer, not this work's
                    // attempt history; another task must not inherit its sends.
                    if error.reset_at_ms.is_some() {
                        self.parked.insert(key.clone(), error.clone());
                    } else if error.code == "mc_route_misconfigured" {
                        self.misconfigured
                            .insert(key.clone(), (catalog.generation, error.clone()));
                    }
                    error.attempts = attempts;
                    return Err(error);
                }
                Err(_) => {
                    let mut error = WorkError::new("mc_run_timed_out");
                    error.attempts = attempts;
                    return Err(error);
                }
            };

            let remaining = order.deadline_ms.saturating_sub(self.clock.now_ms());
            let mut result = if remaining == 0 {
                RunResult::new(Outcome::TimedOut, None)
            } else {
                match tokio::time::timeout(
                    Duration::from_millis(remaining),
                    runner.send(order.scope_route, &choice, order.deadline_ms),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => RunResult::new(Outcome::TimedOut, None),
                }
            };
            if result.outcome == Outcome::TimedOut {
                if remaining > 0 {
                    runner.cancel(order.scope_route, &choice).await;
                }
                timeouts += 1;
            }
            // A claimed completion without a validated value is a failed run,
            // not a successful affinity signal.
            if result.outcome == Outcome::Completed && result.output.is_none() {
                result.outcome = Outcome::Failed;
            }
            let mut report = ReportRequest::new(&choice.decision_id, result.outcome.clone());
            report.runner_code = result.runner_code;
            report.credential_id = result.credential_id;
            report.reset_at_ms = result.reset_at_ms;
            report.usage = result.usage;
            attempts.push(Attempt {
                choice: choice.clone(),
                report: report.clone(),
            });
            if let Err(source) = order.scope_route.report(&provider, &report).await {
                self.queue_report(&provider, report, source);
            }
            if result.outcome == Outcome::Completed {
                return Ok(WorkDone {
                    output: result.output.expect("completed run has validated output"),
                    choice,
                    attempts,
                });
            }
            if result.outcome == Outcome::Cancelled || timeouts >= 2 {
                let mut error = WorkError::new(if result.outcome == Outcome::Cancelled {
                    "mc_run_cancelled"
                } else {
                    "mc_run_timed_out"
                });
                error.attempts = attempts;
                return Err(error);
            }
            // Routing treats unknown outcomes as failures. Exclude the failed
            // route even if routing has not acknowledged its report yet.
            exclude.push(choice.route.route_key());
        }
    }
}

#[cfg(test)]
mod tests;
