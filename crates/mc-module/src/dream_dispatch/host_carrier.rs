//! Host-pulled dream attempts. Dropping HostCarrier::open records cancellation in
//! the queue so a claimant must retire even a child created after that drop.

use super::context::{ChildEvent, ChildObserver, TaskContext, TaskToolRouter};
use super::domain_control::available;
use crate::dream_runner::{CarrierError, ChildRequest, Completion, DreamCarrier, Usage};
use mc_store::dream_scheduler::{
    budget::{BudgetAction, TokenBudget},
    SqliteDreamScheduler,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

mod recovery;
pub use recovery::RESTART_GRACE_MS;

const CAPACITY: usize = 64;
const MAX_BODY: usize = 1024 * 1024;
const MAX_EVENTS: usize = 4096;
const CLAIM_MS: i64 = 15_000;
const CLEANUP_MS: u64 = 2_000;

fn error(message: impl Into<String>) -> CarrierError {
    CarrierError {
        message: message.into(),
        retryable: false,
    }
}

fn secret() -> Result<String, CarrierError> {
    let mut bytes = [0_u8; 32];
    // Failure to obtain OS entropy is unavailability, never a predictable credential.
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| error(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(|| format!("invalid_{key}"))
}

fn usage(v: &Value) -> Result<Usage, String> {
    let meter = |key| {
        v.get(key)
            .and_then(Value::as_u64)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(|| format!("invalid_{key}"))
    };
    Ok(Usage {
        input: meter("input")?,
        output: meter("output")?,
        cache_read: meter("cache_read")?,
        cache_write: meter("cache_write")?,
    })
}

struct Entry {
    context: Arc<TaskContext>,
    request: ChildRequest,
    router: Arc<dyn TaskToolRouter>,
    observer: Arc<dyn ChildObserver>,
    fence: PathBuf,
    epoch: String,
    child: String,
    host_child: Option<String>,
    claim: Option<Claim>,
    deadline: i64,
    start: bool,
    stop: bool,
    cleaned: bool,
    settled: bool,
    completion: Option<Completion>,
    budget: Option<TokenBudget>,
    total: Usage,
    messages: HashMap<String, Value>,
    meters: HashMap<String, (Value, Value)>,
    events: BTreeMap<u64, (Value, Value)>,
    calls: HashMap<String, (Value, Value)>,
    next_seq: u64,
    event_bytes: usize,
    call_bytes: usize,
    steps: u32,
    abandoned: bool,
}

struct Claim {
    token: String,
    epoch: String,
    until: i64,
}

impl Entry {
    fn live(&mut self) -> Result<(), String> {
        let now = self.context.now_ms();
        let result = if self.stop || self.cleaned {
            Err("stopped".into())
        } else if now >= self.deadline || self.claim.as_ref().is_some_and(|c| now >= c.until) {
            Err(if now >= self.deadline {
                "deadline"
            } else {
                "claim_expired"
            }
            .into())
        } else {
            self.context.check_control().map_err(|e| format!("{e:?}"))
        };
        if result.is_err() {
            self.stop = true;
        }
        result
    }

    fn state(&self) -> Value {
        json!({"ok": true, "start": self.start && !self.stop, "stop": self.stop,
            "retire": self.stop, "claim_deadline_ms": self.claim.as_ref().map(|c| c.until),
            "heartbeat_interval_ms": 5000})
    }

    fn descriptor(&self) -> Value {
        let c = &self.context;
        json!({"scope": c.scope, "invocation": c.task_lease.invocation,
            "task": c.task, "task_lease": {"scope": c.task_lease.scope, "invocation": c.task_lease.invocation, "expires_at_ms": c.task_lease.expires_at_ms},
            "domain": {"key": c.domain_lease.key, "holder": c.domain_lease.holder,
                "generation": c.domain_lease.generation, "expires_at_ms": c.domain_lease.expires_at_ms},
            "parent_session_id": self.request.parent_session_id, "child_id": self.child,
            "directory": self.request.directory, "agent": self.request.agent,
            "allowed_tools": self.request.allowed_tools, "max_steps": self.request.max_steps,
            "model": self.request.model.as_ref().map(|m| json!({"model": m.model, "qualifier": m.qualifier})),
            "system": self.request.system, "prompt": self.request.prompt,
            "deadline_ms": self.deadline, "token_budget": self.request.token_budget})
    }
}

/// After restart, the coordinator cannot know whether an old external child still
/// runs. Replacement waits past the larger of its saved child deadline and lease
/// renewal timestamp, plus grace. That bound is frozen once; old tokens never resume.
#[derive(Default)]
pub struct DreamQueue {
    entries: Mutex<BTreeMap<String, Entry>>,
    epoch: OnceLock<String>,
}

impl DreamQueue {
    fn enqueue(
        &self,
        carrier: &HostCarrier,
        request: &ChildRequest,
    ) -> Result<String, CarrierError> {
        carrier
            .context
            .check_control()
            .map_err(|e| error(format!("{e:?}")))?;
        if request.prompt.len() + request.system.len() > MAX_BODY
            || request.parent_session_id != carrier.context.scope.session.0
            || request.directory != carrier.context.config.directory
            || !request.directory.is_absolute()
            || request.directory.canonicalize().ok().as_ref() != Some(&request.directory)
            || !carrier.fence_root.is_absolute()
            || request.runner.kind != crate::historian_runner::HistorianRunnerKind::Host
            || request.max_steps == 0
            || request.temperature.is_some()
        {
            return Err(error("invalid_descriptor"));
        }
        let mut entries = self.entries.lock().map_err(|_| error("queue_poisoned"))?;
        entries.retain(|_, e| !(e.cleaned && e.abandoned));
        if entries.len() >= CAPACITY {
            return Err(error("unavailable: queue_full"));
        }
        let id = secret()?;
        let child = format!("dream-{id}");
        let deadline = carrier.context.deadline_ms.min(
            carrier
                .context
                .now_ms()
                .saturating_add(request.timeout.as_millis().min(i64::MAX as u128) as i64),
        );
        let task_budget = available(
            carrier
                .scheduler
                .token_budget(&carrier.context.task_lease, carrier.context.now_ms()),
        )
        .map_err(error)?;
        if task_budget.finalize_fired || task_budget.hard_stopped() {
            return Err(error("token_budget"));
        }
        let remaining = task_budget.budget.saturating_sub(task_budget.spent);
        let mut request = request.clone();
        request.token_budget = Some(request.token_budget.unwrap_or(remaining).min(remaining));
        let budget = request
            .token_budget
            .map(TokenBudget::new)
            .transpose()
            .map_err(error)?;
        let epoch = if let Some(epoch) = self.epoch.get() {
            epoch.clone()
        } else {
            let epoch = secret()?;
            let _ = self.epoch.set(epoch.clone());
            epoch
        };
        let timing = carrier
            .store
            .dream_domain_timing(&carrier.context.domain_lease.key)
            .map_err(|e| error(e.to_string()))?
            .ok_or_else(|| error("unavailable: domain_timing_missing"))?;
        if timing.holder != carrier.context.domain_lease.holder
            || timing.generation != carrier.context.domain_lease.generation
        {
            return Err(error("LeaseLost"));
        }
        let key = format!(
            "{}\0{}",
            carrier.context.scope.project.0, carrier.context.domain_lease.key
        );
        let key = format!("{:x}", Sha256::digest(key.as_bytes()));
        let marker = recovery::Marker::new(
            &epoch,
            &id,
            &child,
            &carrier.context.task_lease.invocation.0,
            deadline,
            carrier.context.deadline_ms,
            &timing,
        );
        let (fence, retired) = recovery::reserve(
            &carrier.fence_root,
            &key,
            &marker,
            carrier.context.now_ms(),
            Some(&timing),
        )?;
        if let Some(retired) = retired {
            entries.remove(&retired);
        }
        entries.insert(
            id.clone(),
            Entry {
                context: carrier.context.clone(),
                request: request.clone(),
                router: carrier.router.clone(),
                observer: carrier.observer.clone(),
                fence,
                epoch,
                child,
                host_child: None,
                claim: None,
                deadline,
                start: false,
                stop: false,
                cleaned: false,
                settled: false,
                completion: None,
                budget,
                total: Usage::default(),
                messages: HashMap::new(),
                meters: HashMap::new(),
                events: BTreeMap::new(),
                calls: HashMap::new(),
                next_seq: 1,
                event_bytes: 0,
                call_bytes: 0,
                steps: 0,
                abandoned: false,
            },
        );
        Ok(id)
    }

    fn stop(&self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            if let Some(e) = entries.get_mut(id) {
                e.stop = true;
                e.abandoned = true;
                if e.claim.is_none() && recovery::release(&e.fence, id, &e.epoch).is_ok() {
                    e.cleaned = true;
                }
            }
        }
    }

    /// McHandler resolves these identities from the daemon-bound route, never
    /// from project or session fields in the claimant's request.
    pub(crate) fn route(
        &self,
        project: &str,
        session: &str,
        method: &str,
        request: &Value,
    ) -> Result<Value, String> {
        if request.to_string().len() > MAX_BODY {
            return Err("body_too_large".into());
        }
        let mut entries = self.entries.lock().map_err(|_| "queue_poisoned")?;
        if method == "dream.child.pending" {
            let pending: Vec<_> = entries
                .iter_mut()
                .filter_map(|(id, e)| {
                    if e.context.scope.project.0 != project || e.context.scope.session.0 != session
                    {
                        return None;
                    }
                    if e.live().is_err() || e.claim.is_some() {
                        return None;
                    }
                    Some(json!({"entry_id": id, "deadline_ms": e.deadline}))
                })
                .collect();
            return Ok(json!({"ok": true, "entries": pending}));
        }
        let id = field(request, "entry_id")?;
        let e = entries
            .get_mut(id)
            .filter(|e| {
                e.context.scope.project.0 == project && e.context.scope.session.0 == session
            })
            .ok_or("not_found")?;
        if method == "dream.child.claim" {
            e.live()?;
            if e.claim.is_some() {
                return Err("already_claimed".into());
            }
            let epoch = field(request, "claimant_epoch")?.to_string();
            let caps = request.get("capabilities").ok_or("unavailable")?;
            let tools = caps
                .get("tools")
                .and_then(Value::as_array)
                .ok_or("unavailable")?;
            let mut required = vec![
                "child_guard",
                "steps",
                "tokens",
                "stop",
                "retire",
                "task_tools",
            ];
            if e.request.allowed_tools.iter().any(|t| *t != "ctx_memory") {
                required.push("filesystem_fence");
            }
            if e.request.model.is_none() {
                required.push("default_model");
            }
            if required
                .iter()
                .any(|k| caps.get(k).and_then(Value::as_bool) != Some(true))
                || e.request
                    .allowed_tools
                    .iter()
                    .any(|t| !tools.iter().any(|v| v.as_str() == Some(t)))
            {
                e.stop = true;
                // A refused descriptor was never handed out and cannot have a remote child.
                recovery::release(&e.fence, id, &e.epoch).map_err(|e| e.message)?;
                e.cleaned = true;
                return Err("unavailable".into());
            }
            let token = secret().map_err(|e| e.message)?;
            e.claim = Some(Claim {
                token: token.clone(),
                epoch,
                until: e.deadline.min(e.context.now_ms().saturating_add(CLAIM_MS)),
            });
            return Ok(json!({"ok": true, "entry_id": id, "token": token,
                "descriptor": e.descriptor(), "control": e.state()}));
        }
        let claim = e.claim.as_ref().ok_or("not_claimed")?;
        if field(request, "token")? != claim.token
            || field(request, "claimant_epoch")? != claim.epoch
            || field(request, "child_id")? != e.child
        {
            return Err("stale_attempt".into());
        }
        // Open/cleanup acknowledgements remain available after revocation solely to
        // retire late children. They cannot authorize messages, paid work or tools.
        match method {
            "dream.child.opened" => {
                if e.cleaned {
                    return Err("stale_attempt".into());
                }
                let host_child = field(request, "host_child_id")?.to_string();
                if e.host_child.as_ref().is_some_and(|id| id != &host_child) {
                    return Err("child_changed".into());
                }
                e.host_child = Some(host_child);
                let _ = e.live();
                Ok(e.state())
            }
            "dream.child.cleanup" | "dream.child.unavailable" => {
                if method == "dream.child.unavailable" {
                    if e.start {
                        return Err("already_started".into());
                    }
                    e.stop = true;
                }
                if !e.stop {
                    return Err("stop_required".into());
                }
                if request.get("quiescent").and_then(Value::as_bool) != Some(true)
                    || request.get("retired").and_then(Value::as_bool) != Some(true)
                {
                    return Err("cleanup_unknown".into());
                }
                if !e.cleaned {
                    if let Some(child) = e.host_child.as_deref() {
                        e.observer
                            .observe(child, ChildEvent::Closed { settled: e.settled })
                            .map_err(|e| format!("{e:?}"))?;
                    }
                    recovery::release(&e.fence, id, &e.epoch).map_err(|e| e.message)?;
                    e.cleaned = true;
                }
                Ok(json!({"ok": true}))
            }
            "dream.child.heartbeat" => {
                if e.live().is_ok() {
                    if let Some(c) = &mut e.claim {
                        c.until = e.deadline.min(e.context.now_ms().saturating_add(CLAIM_MS));
                    }
                }
                Ok(e.state())
            }
            "dream.child.event" => {
                e.live()?;
                Self::event(e, request)
            }
            "dream.child.tool" => {
                e.live()?;
                Self::tool(e, request)
            }
            _ => Err("unknown_method".into()),
        }
    }

    fn event(e: &mut Entry, request: &Value) -> Result<Value, String> {
        let seq = request
            .get("seq")
            .and_then(Value::as_u64)
            .ok_or("invalid_seq")?;
        let payload = request.get("event").ok_or("invalid_event")?;
        if let Some((previous, response)) = e.events.get(&seq) {
            return if previous == payload {
                Ok(response.clone())
            } else {
                Err("sequence_conflict".into())
            };
        }
        if !e.start || e.host_child.is_none() || e.completion.is_some() {
            return Err("not_running".into());
        }
        let bytes = payload.to_string().len();
        if seq != e.next_seq || e.events.len() >= MAX_EVENTS || e.event_bytes + bytes > 4 * MAX_BODY
        {
            return Err("out_of_order".into());
        }
        let child = e.host_child.as_deref().ok_or("not_opened")?;
        let mut response = json!({"ok": true});
        match field(payload, "kind")? {
            "step" => {
                if e.context
                    .control
                    .refuse_tool()
                    .map_err(|e| format!("{e:?}"))?
                    .is_some()
                    || e.budget.as_mut().is_some_and(|b| b.refuse_tool().is_some())
                {
                    return Err("token_budget".into());
                }
                if e.steps >= e.request.max_steps {
                    e.stop = true;
                    return Err("step_budget".into());
                }
                e.steps += 1;
            }
            "message" => {
                let id = field(payload, "message_id")?;
                if let Some(previous) = e.messages.get(id) {
                    if previous != payload {
                        return Err("message_conflict".into());
                    }
                } else {
                    let role = field(payload, "role")?.to_string();
                    let text = payload
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or("invalid_text")?
                        .to_string();
                    e.observer
                        .observe(
                            child,
                            ChildEvent::Message {
                                message_id: id.into(),
                                role,
                                text,
                            },
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    e.messages.insert(id.into(), payload.clone());
                }
            }
            "usage" => {
                let id = field(payload, "message_id")?;
                let u = usage(payload.get("usage").ok_or("invalid_usage")?)?;
                if let Some((previous, ack)) = e.meters.get(id) {
                    if previous != payload {
                        return Err("usage_conflict".into());
                    }
                    response = ack.clone();
                } else {
                    let completed = payload
                        .get("completed")
                        .and_then(Value::as_bool)
                        .ok_or("invalid_completed")?;
                    let action = e
                        .context
                        .control
                        .charge_usage(&format!("{}:{id}", e.child), &u, completed, true)
                        .map_err(|e| format!("{e:?}"))?;
                    let local = e
                        .budget
                        .as_mut()
                        .map(|b| b.charge(u.input, u.cache_read, u.cache_write, completed, true))
                        .transpose()
                        .map_err(str::to_string)?;
                    response["budget_action"] = json!(if action == BudgetAction::Stop
                        || local == Some(BudgetAction::Stop)
                    {
                        "stop"
                    } else if action == BudgetAction::Finalize
                        || local == Some(BudgetAction::Finalize)
                    {
                        "finalize"
                    } else {
                        "continue"
                    });
                    e.total.input = e.total.input.saturating_add(u.input);
                    e.total.output = e.total.output.saturating_add(u.output);
                    e.total.cache_read = e.total.cache_read.saturating_add(u.cache_read);
                    e.total.cache_write = e.total.cache_write.saturating_add(u.cache_write);
                    e.meters
                        .insert(id.into(), (payload.clone(), response.clone()));
                    e.observer
                        .observe(
                            child,
                            ChildEvent::Usage {
                                message_id: id.into(),
                                usage: u,
                            },
                        )
                        .map_err(|e| format!("{e:?}"))?;
                }
            }
            "receipt" => {
                // Receipt payloads come only from TaskToolRouter::execute below;
                // claimant events reference its cached call, never invent effect evidence.
                let call_id = field(payload, "call_id")?;
                if !e.calls.contains_key(call_id) {
                    return Err("unknown_receipt".into());
                }
            }
            "complete" => {
                let text = payload
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or("invalid_text")?;
                let length_capped = payload
                    .get("length_capped")
                    .and_then(Value::as_bool)
                    .ok_or("invalid_length_capped")?;
                e.completion = Some(Completion {
                    text: text.into(),
                    length_capped,
                    usage: e.total.clone(),
                });
            }
            _ => return Err("invalid_event_kind".into()),
        }
        e.event_bytes += bytes;
        e.events.insert(seq, (payload.clone(), response.clone()));
        e.next_seq += 1;
        Ok(response)
    }

    fn tool(e: &mut Entry, request: &Value) -> Result<Value, String> {
        if !e.start || e.completion.is_some() {
            return Err("not_running".into());
        }
        let call_id = field(request, "call_id")?;
        let tool = field(request, "tool")?;
        let arguments = request.get("arguments").ok_or("invalid_arguments")?;
        let input = json!({"tool": tool, "arguments": arguments});
        if let Some((previous, result)) = e.calls.get(call_id) {
            return if previous == &input {
                Ok(result.clone())
            } else {
                Err("call_conflict".into())
            };
        }
        let bytes = input.to_string().len();
        if e.calls.len() >= MAX_EVENTS || e.call_bytes + bytes > 4 * MAX_BODY {
            return Err("too_many_calls".into());
        }
        if !e.request.allowed_tools.contains(&tool) {
            return Err("tool_not_admitted".into());
        }
        if e.context
            .control
            .refuse_tool()
            .map_err(|e| format!("{e:?}"))?
            .is_some()
            || e.budget.as_mut().is_some_and(|b| b.refuse_tool().is_some())
        {
            return Err("token_budget".into());
        }
        let child = e.host_child.as_deref().ok_or("not_opened")?;
        let result = e
            .router
            .execute(child, tool, arguments)
            .map_err(|e| format!("{e:?}"))?;
        let mut response = json!({"ok": true, "output": result.output,
            "receipt": result.receipt.as_ref().map(|r| json!({"tool": r.tool, "affected_ids": r.affected_ids, "details": r.details}))});
        if response.to_string().len() > MAX_BODY {
            e.stop = true;
            response = json!({"ok": false, "refusal": "tool_output_too_large", "outcome": "effect_may_have_applied"});
        }
        // Cache before observation: even an observer failure must never replay an effect.
        e.call_bytes += bytes + response.to_string().len();
        e.calls.insert(call_id.into(), (input, response.clone()));
        if let Some(receipt) = result.receipt {
            if let Err(err) = e.observer.observe(child, ChildEvent::Receipt(receipt)) {
                e.stop = true;
                return Err(format!("observer_failed: {err:?}"));
            }
        }
        Ok(response)
    }
}

/// The task executor supplies its router and observer so admitted calls and their
/// receipts reach the task host that owns the captured context, not a foreground writer.
/// fence_root stores active-attempt markers: keep it private to prevent tampering
/// and stable across restarts so unknown remote children still block replacement.
pub struct HostCarrier {
    queue: Arc<DreamQueue>,
    context: Arc<TaskContext>,
    router: Arc<dyn TaskToolRouter>,
    observer: Arc<dyn ChildObserver>,
    store: Arc<mc_store::McStore>,
    scheduler: Arc<SqliteDreamScheduler>,
    fence_root: PathBuf,
    used_children: Vec<String>,
    active: Option<String>,
}

impl HostCarrier {
    pub fn new(
        queue: Arc<DreamQueue>,
        context: Arc<TaskContext>,
        router: Arc<dyn TaskToolRouter>,
        observer: Arc<dyn ChildObserver>,
        store: Arc<mc_store::McStore>,
        scheduler: Arc<SqliteDreamScheduler>,
        fence_root: &Path,
    ) -> Self {
        Self {
            queue,
            context,
            router,
            observer,
            store,
            scheduler,
            fence_root: fence_root.into(),
            used_children: Vec::new(),
            active: None,
        }
    }
}

struct OpenGuard {
    queue: Arc<DreamQueue>,
    id: String,
    armed: bool,
}
impl Drop for OpenGuard {
    fn drop(&mut self) {
        if self.armed {
            self.queue.stop(&self.id);
        }
    }
}
impl Drop for HostCarrier {
    fn drop(&mut self) {
        if let Some(id) = &self.active {
            self.queue.stop(id);
        }
    }
}

impl DreamCarrier for HostCarrier {
    async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
        if self.active.is_some() || self.used_children.len() >= MAX_EVENTS {
            return Err(error("prior_cleanup_required"));
        }
        let id = self.queue.enqueue(self, request)?;
        let mut guard = OpenGuard {
            queue: self.queue.clone(),
            id: id.clone(),
            armed: true,
        };
        loop {
            {
                let mut entries = self
                    .queue
                    .entries
                    .lock()
                    .map_err(|_| error("queue_poisoned"))?;
                let e = entries.get_mut(&id).ok_or_else(|| error("entry_lost"))?;
                if e.cleaned {
                    entries.remove(&id);
                    return Err(error("unavailable"));
                }
                e.live().map_err(error)?;
                if let Some(child) = &e.host_child {
                    if self.used_children.contains(child) {
                        return Err(error("child_reused"));
                    }
                    self.used_children.push(child.clone());
                    self.active = Some(id.clone());
                    guard.armed = false;
                    return Ok(child.clone());
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn complete(
        &mut self,
        child: &str,
        _request: &ChildRequest,
    ) -> Result<Completion, CarrierError> {
        let id = self.active.as_ref().ok_or_else(|| error("not_opened"))?;
        loop {
            {
                let mut entries = self
                    .queue
                    .entries
                    .lock()
                    .map_err(|_| error("queue_poisoned"))?;
                let e = entries.get_mut(id).ok_or_else(|| error("entry_lost"))?;
                if e.host_child.as_deref() != Some(child) {
                    return Err(error("child_mismatch"));
                }
                if let Some(c) = &e.completion {
                    return Ok(c.clone());
                }
                e.live().map_err(error)?;
                e.start = true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn close(&mut self, child: &str, prompt_settled: bool) -> Result<(), CarrierError> {
        let id = self.active.clone().ok_or_else(|| error("not_opened"))?;
        {
            let mut entries = self
                .queue
                .entries
                .lock()
                .map_err(|_| error("queue_poisoned"))?;
            let e = entries.get_mut(&id).ok_or_else(|| error("entry_lost"))?;
            if e.host_child.as_deref() != Some(child) {
                return Err(error("child_mismatch"));
            }
            e.settled = prompt_settled;
            e.stop = true;
        }
        let result = tokio::time::timeout(Duration::from_millis(CLEANUP_MS), async {
            loop {
                {
                    let mut entries = self
                        .queue
                        .entries
                        .lock()
                        .map_err(|_| error("queue_poisoned"))?;
                    if entries.get(&id).is_some_and(|e| e.cleaned) {
                        entries.remove(&id);
                        return Ok(());
                    }
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .map_err(|_| error("cleanup_unknown"))?;
        if result.is_ok() {
            self.active = None;
        }
        result
    }
}
