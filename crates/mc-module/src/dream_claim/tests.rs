use super::*;

mod history_tasks;
mod ownership;
mod restart;
mod tick;
mod vectors;
use crate::dream_dispatch::context::*;
use crate::dream_dispatch::domain_control::available;
use crate::dream_dispatch::host_carrier::HostCarrier;
use crate::dream_runner::{ChildRequest, Completion, DreamCarrier, ModelEntry, Usage};
use crate::historian_runner::{HistorianRunnerKind, ResolvedRunner, RunnerSource};
use crate::{McModuleConfig, SessionBinding};
use mc_store::dream_scheduler::budget::{BudgetAction, TokenBudget};
use mc_store::dream_scheduler::schedules::TaskName;
use mc_store::dream_scheduler::{schedules::TaskConfig, SqliteDreamScheduler};
use mc_store::parity_schema_manifest::*;
use mc_store::McStore;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

// Lease and budget knobs isolate the queue's pre-tool admission checks. The effect
// router deliberately has no second fence, so removing a queue guard causes an
// observable execution rather than a masked refusal. Production routers also fence writes.
struct Control {
    lease: AtomicBool,
    budget: Mutex<TokenBudget>,
    charges: AtomicUsize,
}
impl TaskControl for Control {
    fn check_control(&self) -> Result<(), ControlError> {
        if self.lease.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(ControlError::LeaseLost)
        }
    }
    fn charge_usage(
        &self,
        _: &str,
        u: &Usage,
        completed: bool,
        can_finalize: bool,
    ) -> Result<BudgetAction, ControlError> {
        self.charges.fetch_add(1, Ordering::SeqCst);
        self.budget
            .lock()
            .unwrap()
            .charge(
                u.input,
                u.cache_read,
                u.cache_write,
                completed,
                can_finalize,
            )
            .map_err(|_| ControlError::BudgetExhausted)
    }
    fn refuse_tool(&self) -> Result<Option<(&'static str, bool)>, ControlError> {
        Ok(self.budget.lock().unwrap().refuse_tool())
    }
}
#[derive(Default)]
struct Effects {
    calls: Mutex<Vec<(String, String, Value)>>,
    observations: Mutex<Vec<(String, ChildEvent)>>,
    retired: AtomicUsize,
}
impl TaskToolRouter for Effects {
    fn execute(&self, child: &str, tool: &str, arguments: &Value) -> Result<ToolResult, ToolError> {
        self.calls
            .lock()
            .unwrap()
            .push((child.into(), tool.into(), arguments.clone()));
        Ok(ToolResult {
            output: json!({"effect": "applied"}),
            receipt: Some(ToolReceipt {
                tool: tool.into(),
                affected_ids: vec!["memory-1".into()],
                details: json!({"committed": true}),
            }),
        })
    }
}
impl ChildObserver for Effects {
    fn observe(&self, child: &str, event: ChildEvent) -> Result<(), ToolError> {
        if matches!(event, ChildEvent::Closed { .. }) {
            self.retired.fetch_add(1, Ordering::SeqCst);
        }
        self.observations
            .lock()
            .unwrap()
            .push((child.into(), event));
        Ok(())
    }
}
struct Fixture {
    root: tempfile::TempDir,
    handler: Arc<McHandler>,
    scheduler: Arc<SqliteDreamScheduler>,
    context: Arc<TaskContext>,
    control: Arc<Control>,
    clock: Arc<TestClock>,
    effects: Arc<Effects>,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join("magic-context/i5-c1");
        std::fs::create_dir_all(&base).unwrap();
        let root = tempfile::tempdir_in(base).unwrap();
        let directory = root.path().canonicalize().unwrap();
        let store = Arc::new(
            McStore::open(&crate::dev_descriptor_at(root.path().to_str().unwrap())).unwrap(),
        );
        let context_path = root.path().join("context.db");
        rusqlite::Connection::open(&context_path)
            .unwrap()
            .execute_batch(
                &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                    .replace(":applied_at", "1"),
            )
            .unwrap();
        store.install_context_domain(Arc::new(
            mc_store::SqliteContextDomain::open(&context_path).unwrap(),
        ));
        let handler = Arc::new(McHandler::new());
        assert!(handler.store.set(store).is_ok());
        handler.bind_route(
            7,
            SessionBinding {
                principal: None,
                scope: None,
                project_root: directory.clone(),
                harness: "opencode2".into(),
                session: "parent".into(),
                model_key: None,
                config: McModuleConfig::default(),
                history_budget_tokens: 1000.0,
            },
        );
        let scope = StoreScope {
            project: ProjectId(directory.to_string_lossy().into()),
            session: SessionId("parent".into()),
            generation: Generation(4),
        };
        let scheduler =
            Arc::new(SqliteDreamScheduler::open(root.path().join("scheduler.db"), true).unwrap());
        let task = TaskName::Curate;
        let config = TaskConfig {
            task,
            schedule: "* * * * *".into(),
            has_input: true,
            legacy_last_run_at: None,
        };
        let lease = available(scheduler.claim_task(
            &DreamClaimRequest {
                scope: scope.clone(),
                invocation: InvocationId("invocation-1".into()),
                task: BackgroundTask::Curate,
                domain: task.lease_key(&scope.project.0),
                now_ms: 60_000,
                lease_ms: 120_000,
                token_budget: 100,
                manual_force: true,
            },
            task,
            Some(&config),
            |_| true,
        ))
        .unwrap();
        let control = Arc::new(Control {
            lease: AtomicBool::new(true),
            budget: Mutex::new(TokenBudget::new(100).unwrap()),
            charges: AtomicUsize::new(0),
        });
        let clock = Arc::new(TestClock(AtomicI64::new(60_000)));
        let context = Arc::new(TaskContext {
            task: TaskName::Curate,
            scope: scope.clone(),
            config: Arc::new(CapturedConfig {
                activated: true,
                route: McModuleConfig::default(),
                effective: json!({}),
                harness: "opencode2".into(),
                directory,
            }),
            domain_lease: handler
                .store
                .get()
                .unwrap()
                .acquire_dream_domain("dreaming", "owner", 60_000)
                .unwrap()
                .unwrap(),
            task_lease: lease,
            cancellation: Cancellation::default(),
            clock: clock.clone(),
            deadline_ms: 180_000,
            control: control.clone(),
        });
        Self {
            root,
            handler,
            scheduler,
            context,
            control,
            clock,
            effects: Arc::default(),
        }
    }
    fn request(&self) -> ChildRequest {
        ChildRequest {
            runner: ResolvedRunner {
                kind: HistorianRunnerKind::Host,
                source: RunnerSource::HarnessDefault,
            },
            parent_session_id: "parent".into(),
            directory: self.context.config.directory.clone(),
            agent: "curator",
            allowed_tools: &["ctx_memory"],
            max_steps: 3,
            model: Some(ModelEntry {
                model: "provider/model/with/slash".into(),
                qualifier: Some("high".into()),
            }),
            system: "system".into(),
            prompt: "prompt".into(),
            timeout: Duration::from_secs(10),
            token_budget: Some(100),
            temperature: None,
        }
    }
    fn carrier(&self) -> HostCarrier {
        HostCarrier::new(
            self.handler.dream_queue(),
            self.context.clone(),
            self.effects.clone(),
            self.effects.clone(),
            self.handler.store.get().unwrap().clone(),
            self.scheduler.clone(),
            &self.root.path().join("claim-fences"),
        )
    }
    async fn call(&self, channel: u16, mut request: Value) -> Value {
        request["v"] = json!(1);
        match Box::pin(self.handler.dispatch_value(channel, request)).await {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            HandlerOutcome::Error { code, .. } => json!({"error": code}),
            other => panic!("unexpected outcome {other:?}"),
        }
    }
    async fn pending(&self) -> Value {
        let response = self.call(7, json!({"method": "dream.child.pending"})).await;
        assert_eq!(response["ok"], true, "pending route refused: {response}");
        response
    }
    async fn claim(&self, id: &Value) -> Value {
        self.call(7, json!({"method": "dream.child.claim", "entry_id": id, "claimant_epoch": "epoch-1", "capabilities": capabilities()})).await
    }
    async fn send(&self, claim: &Value, method: &str, mut body: Value) -> Value {
        body["method"] = json!(method);
        body["entry_id"] = claim["entry_id"].clone();
        body["token"] = claim["token"].clone();
        body["child_id"] = claim["descriptor"]["child_id"].clone();
        body["claimant_epoch"] = json!("epoch-1");
        self.call(7, body).await
    }
    async fn tool(&self, claim: &Value, id: &str, tool: &str, args: Value) -> Value {
        self.send(
            claim,
            "dream.child.tool",
            json!({"call_id": id, "tool": tool, "arguments": args}),
        )
        .await
    }
    async fn event(&self, claim: &Value, seq: u64, event: Value) -> Value {
        self.send(
            claim,
            "dream.child.event",
            json!({"seq": seq, "event": event}),
        )
        .await
    }
    fn child_resource(&self, child: &str) -> std::path::PathBuf {
        self.root
            .path()
            .join(format!("{:x}.child", Sha256::digest(child.as_bytes())))
    }

    async fn open(&self) -> (HostCarrier, Value, String) {
        let mut carrier = self.carrier();
        let request = self.request();
        let opener = async { carrier.open(&request).await.unwrap() };
        let claimant = async {
            let id = wait_for(
                async || self.pending().await["entries"][0]["entry_id"].clone(),
                |v| v.is_string(),
            )
            .await;
            let claim = self.claim(&id).await;
            assert_eq!(claim["ok"], true, "{claim}");
            let host_child = format!("host-{}", id.as_str().unwrap());
            std::fs::write(self.child_resource(&host_child), "running child").unwrap();
            let ack = self
                .send(
                    &claim,
                    "dream.child.opened",
                    json!({"host_child_id": host_child}),
                )
                .await;
            assert_eq!(ack["ok"], true);
            claim
        };
        let (child, claim) = bounded(async { tokio::join!(opener, claimant) }).await;
        (carrier, claim, child)
    }
    async fn running(
        &self,
    ) -> (
        tokio::task::JoinHandle<(
            HostCarrier,
            Result<Completion, crate::dream_runner::CarrierError>,
        )>,
        Value,
        String,
    ) {
        let (mut carrier, claim, child) = self.open().await;
        let request = self.request();
        let child_copy = child.clone();
        let job = tokio::spawn(async move {
            let result = carrier.complete(&child_copy, &request).await;
            (carrier, result)
        });
        wait_for(
            async || self.send(&claim, "dream.child.heartbeat", json!({})).await,
            |v| v["start"] == true,
        )
        .await;
        (job, claim, child)
    }
    async fn cleanup(&self, carrier: &mut HostCarrier, claim: &Value, child: &str, settled: bool) {
        let close = carrier.close(child, settled);
        let ack = async {
            wait_for(
                async || self.send(claim, "dream.child.heartbeat", json!({})).await,
                |v| v["stop"] == true,
            )
            .await;
            std::fs::remove_file(self.child_resource(child)).unwrap();
            let ack = self
                .send(
                    claim,
                    "dream.child.cleanup",
                    json!({"quiescent": true, "retired": true}),
                )
                .await;
            assert_eq!(ack["ok"], true, "{ack}");
        };
        let (result, ()) = bounded(async { tokio::join!(close, ack) }).await;
        result.unwrap();
    }
}
fn capabilities() -> Value {
    json!({"tools": ["ctx_memory"], "child_guard": true, "steps": true, "tokens": true,
        "stop": true, "retire": true, "task_tools": true, "filesystem_fence": true, "default_model": true})
}
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("dream claimant fixture timeout")
}
async fn wait_for<F, Fut>(mut call: F, check: impl Fn(&Value) -> bool) -> Value
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Value>,
{
    bounded(async {
        loop {
            let response = call().await;
            if check(&response) {
                return response;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
}

#[tokio::test]
async fn concrete_child_forbidden_tool_never_executes() {
    let f = Fixture::new();
    let (job, claim, child) = f.running().await;
    assert_eq!(
        f.tool(&claim, "allowed", "ctx_memory", json!({})).await["ok"],
        true
    );
    let refused = f
        .tool(&claim, "forbidden", "bash", json!({"command": "effect"}))
        .await;
    assert_eq!(
        f.effects.calls.lock().unwrap().len(),
        1,
        "forbidden tool reached the effect router"
    );
    assert_eq!(refused["refusal"], "tool_not_admitted");
    assert_eq!(
        f.event(
            &claim,
            1,
            json!({"kind": "complete", "text": "done", "length_capped": false})
        )
        .await["ok"],
        true
    );
    let (mut carrier, result) = bounded(job).await.unwrap();
    result.unwrap();
    f.cleanup(&mut carrier, &claim, &child, true).await;
}

#[tokio::test]
async fn concrete_child_lease_loss_refuses_effect() {
    let f = Fixture::new();
    let (job, claim, _) = f.running().await;
    assert_eq!(
        f.tool(&claim, "allowed", "ctx_memory", json!({})).await["ok"],
        true
    );
    f.control.lease.store(false, Ordering::SeqCst);
    let refused = f.tool(&claim, "revoked", "ctx_memory", json!({})).await;
    assert_eq!(
        f.effects.calls.lock().unwrap().len(),
        1,
        "revoked lease executed an effect"
    );
    assert_eq!(refused["refusal"], "LeaseLost");
    job.abort();
    let _ = job.await;
}

#[tokio::test]
async fn concrete_child_token_overflow_refuses_next_tool() {
    let f = Fixture::new();
    let (job, claim, _) = f.running().await;
    assert_eq!(
        f.tool(&claim, "allowed", "ctx_memory", json!({})).await["ok"],
        true
    );
    let report = json!({"kind": "usage", "message_id": "message-1", "completed": false,
        "usage": {"input": 60, "output": 1000, "cache_read": 30, "cache_write": 10}});
    assert_eq!(
        f.event(&claim, 1, report.clone()).await["budget_action"],
        "stop"
    );
    assert_eq!(
        f.event(&claim, 1, report.clone()).await["budget_action"],
        "stop"
    );
    assert_eq!(f.event(&claim, 2, report).await["ok"], true);
    assert_eq!(f.control.charges.load(Ordering::SeqCst), 1);
    let refused = f.tool(&claim, "over-budget", "ctx_memory", json!({})).await;
    assert_eq!(
        f.effects.calls.lock().unwrap().len(),
        1,
        "exhausted budget executed an effect"
    );
    assert_eq!(refused["refusal"], "token_budget");
    job.abort();
    let _ = job.await;
}

#[tokio::test]
async fn concrete_child_cancel_during_open_retires_late_child() {
    let f = Fixture::new();
    // Retiring an ordinary opened child exercises the same cleanup route before
    // the adversarial late-create path, proving the observer is reachable.
    let (mut control, control_claim, control_child) = f.open().await;
    f.cleanup(&mut control, &control_claim, &control_child, false)
        .await;
    let mut carrier = f.carrier();
    let request = f.request();
    let mut future = Box::pin(carrier.open(&request));
    let id = tokio::select! {
        result = &mut future => panic!("unexpected open {result:?}"),
        id = wait_for(async || f.pending().await["entries"][0]["entry_id"].clone(), |v| v.is_string()) => id,
    };
    let claim = f.claim(&id).await;
    drop(future);
    std::fs::write(f.child_resource("late-child"), "late running child").unwrap();
    let late = f
        .send(
            &claim,
            "dream.child.opened",
            json!({"host_child_id": "late-child"}),
        )
        .await;
    if late["stop"] == true {
        std::fs::remove_file(f.child_resource("late-child")).unwrap();
        assert_eq!(
            f.send(
                &claim,
                "dream.child.cleanup",
                json!({"quiescent": true, "retired": true})
            )
            .await["ok"],
            true
        );
    }
    assert!(
        !f.child_resource("late-child").exists(),
        "cancelled open left a real claimant-owned child resource running"
    );
    assert_eq!(
        late["stop"], true,
        "late child must be retired, not handed off"
    );
    assert_eq!(
        f.tool(&claim, "cancelled", "ctx_memory", json!({})).await["refusal"],
        "stopped"
    );
    assert_eq!(f.effects.retired.load(Ordering::SeqCst), 2);
    assert!(f.effects.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn concrete_child_timeout_aborts_and_refuses_effect() {
    let f = Fixture::new();
    let (job, claim, child) = f.running().await;
    assert_eq!(
        f.tool(&claim, "allowed", "ctx_memory", json!({})).await["ok"],
        true
    );
    // The 10-second attempt and its claim expire at 70000 ms, well before
    // the task deadline. No subsequent tool effect may pass that temporal fence.
    f.clock.0.store(70_001, Ordering::SeqCst);
    let refused = f.tool(&claim, "too-late", "ctx_memory", json!({})).await;
    assert_eq!(
        f.effects.calls.lock().unwrap().len(),
        1,
        "expired child executed an effect"
    );
    assert_eq!(refused["refusal"], "deadline");
    assert_eq!(
        f.send(&claim, "dream.child.heartbeat", json!({})).await["stop"],
        true
    );
    std::fs::remove_file(f.child_resource(&child)).unwrap();
    assert!(!f.child_resource(&child).exists());
    assert_eq!(
        f.send(
            &claim,
            "dream.child.cleanup",
            json!({"quiescent": true, "retired": true})
        )
        .await["ok"],
        true
    );
    assert_eq!(f.effects.retired.load(Ordering::SeqCst), 1);
    assert_eq!(f.effects.calls.lock().unwrap().len(), 1);
    job.abort();
    let _ = job.await;
}

#[tokio::test]
async fn dream_claim_admission_races_identity_and_replay() {
    let f = Fixture::new();
    assert_eq!(
        f.call(99, json!({"method": "dream.child.pending"})).await["error"],
        "route_unbound"
    );
    let (job, claim, child) = f.running().await;
    let id = &claim["entry_id"];
    assert_eq!(f.claim(id).await["refusal"], "already_claimed");
    let mut forged = claim.clone();
    forged["token"] = json!("old-token");
    assert_eq!(
        f.tool(&forged, "stale", "ctx_memory", json!({})).await["refusal"],
        "stale_attempt"
    );
    let mut binding = f.handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.session = "another-session".into();
    f.handler.bind_route(8, binding.clone());
    assert!(
        f.call(8, json!({"method": "dream.child.pending"})).await["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(f.call(8, json!({"method": "dream.child.claim", "entry_id": id, "claimant_epoch": "epoch-1", "capabilities": capabilities()})).await["refusal"], "not_found");
    binding.session = "parent".into();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "intruder".into(),
    });
    f.handler.bind_route(9, binding.clone());
    assert_eq!(
        f.call(9, json!({"method": "dream.child.pending"})).await["error"],
        "host_lane_requires_harness_module"
    );
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    });
    f.handler.bind_route(10, binding);
    assert_eq!(
        f.call(10, json!({"method": "dream.child.pending"})).await["error"],
        "host_lane_scope_missing"
    );
    assert_eq!(
        f.tool(
            &claim,
            "real",
            "ctx_memory",
            json!({"child_id": "forged", "token": "model-token"})
        )
        .await["ok"],
        true
    );
    assert_eq!(
        f.tool(
            &claim,
            "real",
            "ctx_memory",
            json!({"child_id": "forged", "token": "model-token"})
        )
        .await["ok"],
        true
    );
    assert_eq!(f.effects.calls.lock().unwrap().len(), 1);
    assert_eq!(f.effects.calls.lock().unwrap()[0].0, child);
    assert_eq!(
        f.tool(&claim, "real", "ctx_memory", json!({})).await["refusal"],
        "call_conflict"
    );
    assert_eq!(
        f.event(
            &claim,
            2,
            json!({"kind": "message", "message_id": "m", "role": "assistant", "text": "hi"})
        )
        .await["refusal"],
        "out_of_order"
    );
    let message = json!({"kind": "message", "message_id": "m", "role": "assistant", "text": "hi"});
    assert_eq!(f.event(&claim, 1, message.clone()).await["ok"], true);
    assert_eq!(f.event(&claim, 1, message).await["ok"], true);
    assert_eq!(
        f.event(&claim, 2, json!({"kind": "receipt", "call_id": "real"}))
            .await["ok"],
        true
    );
    let terminal = json!({"kind": "complete", "text": "done", "length_capped": false});
    assert_eq!(f.event(&claim, 3, terminal.clone()).await["ok"], true);
    assert_eq!(f.event(&claim, 3, terminal).await["ok"], true);
    let (mut carrier, result) = bounded(job).await.unwrap();
    result.unwrap();
    f.cleanup(&mut carrier, &claim, &child, true).await;
    assert_eq!(
        f.tool(&claim, "after-cleanup", "ctx_memory", json!({}))
            .await["refusal"],
        "not_found"
    );
    assert_eq!(
        f.effects
            .observations
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, e)| matches!(e, ChildEvent::Message { .. }))
            .count(),
        1
    );
    assert_eq!(
        f.effects
            .observations
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, e)| matches!(e, ChildEvent::Receipt(_)))
            .count(),
        1
    );
}

#[tokio::test]
async fn dream_claim_capability_mismatch_is_unavailable_before_open() {
    let f = Fixture::new();
    let mut carrier = f.carrier();
    let request = f.request();
    let open = carrier.open(&request);
    let claimant = async {
        let id = wait_for(
            async || f.pending().await["entries"][0]["entry_id"].clone(),
            |v| v.is_string(),
        )
        .await;
        let mut caps = capabilities();
        caps["tokens"] = json!(false);
        let response = f.call(7, json!({"method": "dream.child.claim", "entry_id": id, "claimant_epoch": "epoch-1", "capabilities": caps})).await;
        assert_eq!(response, json!({"ok": false, "refusal": "unavailable"}));
        assert!(response.get("descriptor").is_none());
    };
    let (result, ()) = bounded(async { tokio::join!(open, claimant) }).await;
    assert_eq!(result.unwrap_err().message, "unavailable");
    assert!(f.effects.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dream_claim_restart_and_unknown_cleanup_block_replacement() {
    let f = Fixture::new();
    let (mut carrier, claim, child) = f.open().await;
    // An empty replacement queue still sees the prior attempt's active marker
    // because it uses the same persistent marker directory as the old queue.
    let mut restarted = HostCarrier::new(
        Arc::default(),
        f.context.clone(),
        f.effects.clone(),
        f.effects.clone(),
        f.handler.store.get().unwrap().clone(),
        f.scheduler.clone(),
        &f.root.path().join("claim-fences"),
    );
    assert!(restarted
        .open(&f.request())
        .await
        .unwrap_err()
        .message
        .contains("dream_restart_quarantine_until"));
    let close = carrier.close(&child, false);
    let claimant = async {
        wait_for(
            async || f.send(&claim, "dream.child.heartbeat", json!({})).await,
            |v| v["stop"] == true,
        )
        .await;
        assert_eq!(
            f.send(
                &claim,
                "dream.child.cleanup",
                json!({"quiescent": true, "retired": false})
            )
            .await["refusal"],
            "cleanup_unknown"
        );
    };
    let (result, ()) = bounded(async { tokio::join!(close, claimant) }).await;
    assert_eq!(result.unwrap_err().message, "cleanup_unknown");
    assert!(restarted
        .open(&f.request())
        .await
        .unwrap_err()
        .message
        .contains("dream_restart_quarantine_until"));
    assert_eq!(
        f.send(
            &claim,
            "dream.child.cleanup",
            json!({"quiescent": true, "retired": true})
        )
        .await["ok"],
        true
    );
    // Now the same carrier can observe late cleanup and free its active entry.
    carrier.close(&child, false).await.unwrap();
}

#[tokio::test]
async fn dream_claim_fallbacks_have_fresh_children_and_exact_models() {
    use crate::dream_runner::{run_dream_task, DreamRequest, DreamRole};
    let f = Fixture::new();
    let mut carrier = f.carrier();
    let request = DreamRequest {
        task: "curate",
        role: DreamRole::Curate,
        harness: "opencode2",
        parent_session_id: "parent",
        directory: &f.context.config.directory,
        system: "system",
        prompt: "prompt",
        timeout: Duration::from_secs(4),
        token_budget: Some(100),
        allow_empty: false,
    };
    let route = McModuleConfig {
        dreamer_runner: Some(HistorianRunnerKind::Host),
        ..McModuleConfig::default()
    };
    let config = json!({"dreamer": {"opencode": {"tasks": {"curate": {"model": "provider/first/with/slash", "variant": "high", "fallback_models": [{"model": "provider/second", "variant": "low"}]}}}}});
    let run = run_dream_task(true, &route, &config, &request, &mut carrier, |c| {
        if c.text == "good" {
            Ok(())
        } else {
            Err("invalid".into())
        }
    });
    let peer = async {
        let mut children = Vec::new();
        let mut models = Vec::new();
        for text in ["bad", "good"] {
            let id = wait_for(
                async || f.pending().await["entries"][0]["entry_id"].clone(),
                |v| v.is_string(),
            )
            .await;
            let claim = f.claim(&id).await;
            assert_eq!(claim["ok"], true, "{claim}");
            children.push(claim["descriptor"]["child_id"].clone());
            models.push(claim["descriptor"]["model"].clone());
            assert!(claim["descriptor"].get("temperature").is_none());
            f.send(
                &claim,
                "dream.child.opened",
                json!({"host_child_id": format!("host-{text}")}),
            )
            .await;
            wait_for(
                async || f.send(&claim, "dream.child.heartbeat", json!({})).await,
                |v| v["start"] == true,
            )
            .await;
            assert_eq!(f.event(&claim, 1, json!({"kind": "usage", "message_id": "same-message-id", "completed": true, "usage": {"input": 10, "output": 1, "cache_read": 0, "cache_write": 0}})).await["ok"], true);
            assert_eq!(
                f.event(
                    &claim,
                    2,
                    json!({"kind": "complete", "text": text, "length_capped": false})
                )
                .await["ok"],
                true
            );
            wait_for(
                async || f.send(&claim, "dream.child.heartbeat", json!({})).await,
                |v| v["stop"] == true,
            )
            .await;
            assert_eq!(
                f.send(
                    &claim,
                    "dream.child.cleanup",
                    json!({"quiescent": true, "retired": true})
                )
                .await["ok"],
                true
            );
        }
        assert_ne!(children[0], children[1]);
        assert_eq!(
            models,
            vec![
                json!({"model": "provider/first/with/slash", "qualifier": "high"}),
                json!({"model": "provider/second", "qualifier": "low"})
            ]
        );
    };
    let (result, ()) = bounded(async { tokio::join!(run, peer) }).await;
    assert!(result.result.is_ok(), "{result:?}");
    assert_eq!(result.attempts.len(), 2);
    assert_eq!(f.control.charges.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn dream_claim_attested_harness_and_foreground_arguments() {
    let f = Fixture::new();
    let mut binding = f.handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    });
    binding.scope = Some(subc_protocol::scope::ScopeStamp {
        owner: subc_protocol::Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        scope_ref: "parent".into(),
        scope_epoch: 1,
        kind: subc_protocol::scope::ScopeKind::Head,
        parent: None,
        parent_state: None,
        attributes: Default::default(),
        owner_authorized: true,
    });
    for harness in ["opencode", "opencode2", "pi", "omp"] {
        binding.harness = harness.into();
        f.handler.bind_route(11, binding.clone());
        assert_eq!(
            f.call(11, json!({"method": "dream.child.pending"})).await["ok"],
            true
        );
    }
    let _ = f.call(7, json!({"name": "ctx_memory", "arguments": {"agent": "dreamer", "child_id": "forged", "token": "forged", "action": "add", "content": "not task authority"}})).await;
    assert!(f.effects.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dream_claim_real_task_and_domain_leases_refuse_effects() {
    use crate::dream_dispatch::domain_control::{available, DomainControl};
    use mc_store::dream_scheduler::schedules::TaskConfig;
    for lose_task in [false, true] {
        let mut f = Fixture::new();
        let store = f.handler.store.get().unwrap();
        let scheduler = f.scheduler.clone();
        available(scheduler.abandon(&f.context.task_lease)).unwrap();
        let task = TaskName::Curate;
        let key = task.lease_key(&f.context.scope.project.0);
        let domain = store
            .acquire_dream_domain(&key, "owner", 60_000)
            .unwrap()
            .unwrap();
        let config = TaskConfig {
            task,
            schedule: "* * * * *".into(),
            has_input: true,
            legacy_last_run_at: None,
        };
        let lease = available(scheduler.claim_task(
            &DreamClaimRequest {
                scope: f.context.scope.clone(),
                invocation: InvocationId("real-invocation".into()),
                task: BackgroundTask::Curate,
                domain: key,
                now_ms: 60_000,
                lease_ms: 120_000,
                token_budget: 100,
                manual_force: true,
            },
            task,
            Some(&config),
            |_| true,
        ))
        .unwrap();
        let context = &f.context;
        f.context = Arc::new(TaskContext {
            task,
            scope: context.scope.clone(),
            config: context.config.clone(),
            domain_lease: domain.clone(),
            task_lease: lease.clone(),
            cancellation: context.cancellation.clone(),
            clock: f.clock.clone(),
            deadline_ms: context.deadline_ms,
            control: Arc::new(DomainControl::new(
                store.clone(),
                scheduler.clone(),
                domain.clone(),
                lease.clone(),
                context.cancellation.clone(),
                f.clock.clone(),
                context.deadline_ms,
            )),
        });
        let (job, claim, _) = f.running().await;
        assert_eq!(
            f.tool(&claim, "allowed", "ctx_memory", json!({})).await["ok"],
            true
        );
        if lose_task {
            available(scheduler.abandon(&lease)).unwrap();
        } else {
            store.release_dream_domain(&domain).unwrap();
        }
        assert_eq!(
            f.tool(&claim, "revoked", "ctx_memory", json!({})).await["refusal"],
            "LeaseLost"
        );
        assert_eq!(f.effects.calls.lock().unwrap().len(), 1);
        job.abort();
        let _ = job.await;
    }
}

#[tokio::test]
async fn dream_claim_step_and_usage_ordering() {
    let f = Fixture::new();
    let (job, claim, _) = f.running().await;
    let output_only = json!({"kind": "usage", "message_id": "output-only", "completed": false,
        "usage": {"input": 0, "output": 1000000, "cache_read": 0, "cache_write": 0}});
    assert_eq!(
        f.event(&claim, 1, output_only).await["budget_action"],
        "continue"
    );
    assert_eq!(
        f.tool(&claim, "after-output", "ctx_memory", json!({}))
            .await["ok"],
        true
    );
    for seq in 2..=4 {
        assert_eq!(
            f.event(&claim, seq, json!({"kind": "step"})).await["ok"],
            true
        );
    }
    assert_eq!(
        f.event(&claim, 5, json!({"kind": "step"})).await["refusal"],
        "step_budget"
    );
    assert_eq!(
        f.tool(&claim, "after-steps", "ctx_memory", json!({})).await["refusal"],
        "stopped"
    );
    assert_eq!(f.effects.calls.lock().unwrap().len(), 1);
    job.abort();
    let _ = job.await;
}

#[tokio::test]
async fn dream_claim_remaining_task_budget_and_finalization_refuse_more_work() {
    let f = Fixture::new();
    available(
        f.scheduler
            .update_budget(&f.context.task_lease, 60_000, |b| {
                b.charge(30, 0, 0, false, true)
            }),
    )
    .unwrap();
    let (job, claim, _) = f.running().await;
    assert_eq!(claim["descriptor"]["token_budget"], 70);
    assert_eq!(
        f.tool(&claim, "permitted", "ctx_memory", json!({})).await["ok"],
        true
    );
    let report = json!({"kind": "usage", "message_id": "finalize", "completed": false,
        "usage": {"input": 56, "output": 1000, "cache_read": 0, "cache_write": 0}});
    assert_eq!(
        f.event(&claim, 1, report.clone()).await["budget_action"],
        "finalize"
    );
    assert_eq!(
        f.event(&claim, 2, report).await["budget_action"],
        "finalize"
    );
    assert_eq!(
        f.event(&claim, 3, json!({"kind": "step"})).await["refusal"],
        "token_budget"
    );
    assert_eq!(
        f.tool(&claim, "after-finalize", "ctx_memory", json!({}))
            .await["refusal"],
        "token_budget"
    );
    assert_eq!(f.effects.calls.lock().unwrap().len(), 1);
    job.abort();
    let _ = job.await;
}

#[tokio::test]
async fn dream_claim_claimant_declines_descriptor_before_paid_work() {
    let f = Fixture::new();
    let mut carrier = f.carrier();
    let request = f.request();
    let open = carrier.open(&request);
    let peer = async {
        let id = wait_for(
            async || f.pending().await["entries"][0]["entry_id"].clone(),
            |v| v.is_string(),
        )
        .await;
        let claim = f.claim(&id).await;
        assert_eq!(claim["ok"], true);
        let response = f
            .send(
                &claim,
                "dream.child.unavailable",
                json!({"quiescent": true, "retired": true}),
            )
            .await;
        assert_eq!(response["ok"], true);
    };
    let (result, ()) = bounded(async { tokio::join!(open, peer) }).await;
    assert_eq!(result.unwrap_err().message, "unavailable");
    assert!(f.effects.calls.lock().unwrap().is_empty());
}
