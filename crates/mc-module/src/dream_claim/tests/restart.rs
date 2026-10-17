use super::*;
use crate::dream_dispatch::host_carrier::RESTART_GRACE_MS;
use crate::dream_runner::CarrierError;
use tracing_subscriber::prelude::*;

pub(super) fn marker_path(f: &Fixture) -> std::path::PathBuf {
    let key = format!(
        "{}\0{}",
        f.context.scope.project.0, f.context.domain_lease.key
    );
    f.root
        .path()
        .join("claim-fences")
        .join(format!("{:x}.active", Sha256::digest(key.as_bytes())))
}

pub(super) fn marker(f: &Fixture) -> Value {
    serde_json::from_slice(&std::fs::read(marker_path(f)).unwrap()).unwrap()
}

/// Replace both the serving coordinator and its durable leases. Old Rust objects
/// may still exist in this fixture, but no old authority is carried to the new route.
pub(super) fn restart(f: &mut Fixture, now: i64, invocation: &str) {
    let store = f.handler.store.get().unwrap().clone();
    let old = f.context.clone();
    f.control.lease.store(false, Ordering::SeqCst);
    store.release_dream_domain(&old.domain_lease).unwrap();
    available(f.scheduler.abandon(&old.task_lease)).unwrap();
    assert!(!store.owns_dream_domain(&old.domain_lease, now).unwrap());
    assert!(available(f.scheduler.token_budget(&old.task_lease, now)).is_err());
    let binding = f.handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    let handler = Arc::new(McHandler::new());
    assert!(handler.store.set(store.clone()).is_ok());
    handler.bind_route(7, binding);
    f.handler = handler;
    f.clock.0.store(now, Ordering::SeqCst);
    let domain = store
        .acquire_dream_domain(&old.domain_lease.key, invocation, now)
        .unwrap()
        .unwrap();
    let task = old.task;
    let config = TaskConfig {
        task,
        schedule: "* * * * *".into(),
        has_input: true,
        legacy_last_run_at: None,
    };
    let lease = available(f.scheduler.claim_task(
        &DreamClaimRequest {
            scope: old.scope.clone(),
            invocation: InvocationId(invocation.into()),
            task: BackgroundTask::Curate,
            domain: task.lease_key(&old.scope.project.0),
            now_ms: now,
            lease_ms: 120_000,
            token_budget: 100,
            manual_force: true,
        },
        task,
        Some(&config),
        |_| true,
    ))
    .unwrap();
    f.control = Arc::new(Control {
        lease: AtomicBool::new(true),
        budget: Mutex::new(TokenBudget::new(100).unwrap()),
        charges: AtomicUsize::new(0),
    });
    f.context = Arc::new(TaskContext {
        task,
        scope: old.scope.clone(),
        config: old.config.clone(),
        domain_lease: domain,
        task_lease: lease,
        cancellation: Cancellation::default(),
        clock: f.clock.clone(),
        deadline_ms: now + 120_000,
        control: f.control.clone(),
    });
}

/// Drive a real claimant if work is exposed. An early-replacement regression
/// therefore opens an observable child resource instead of merely changing a flag.
pub(super) async fn try_open(
    f: &Fixture,
) -> (HostCarrier, Result<String, CarrierError>, Option<Value>) {
    let mut carrier = f.carrier();
    let request = f.request();
    let (result, claim) = {
        let mut open = Box::pin(carrier.open(&request));
        tokio::select! {
            result = &mut open => (result, None),
            id = wait_for(async || f.pending().await["entries"][0]["entry_id"].clone(), |v| v.is_string()) => {
                let claim = f.claim(&id).await;
                assert_eq!(claim["ok"], true, "{claim}");
                let child = format!("host-{}", id.as_str().unwrap());
                std::fs::write(f.child_resource(&child), "running child").unwrap();
                assert_eq!(f.send(&claim, "dream.child.opened", json!({"host_child_id": child})).await["ok"], true);
                (bounded(open).await, Some(claim))
            }
        }
    };
    (carrier, result, claim)
}

pub(super) async fn exercise(f: &Fixture, mut carrier: HostCarrier, claim: &Value, child: &str) {
    let request = f.request();
    let owned_child = child.to_string();
    let job = tokio::spawn(async move {
        let result = carrier.complete(&owned_child, &request).await;
        (carrier, result)
    });
    wait_for(
        async || f.send(claim, "dream.child.heartbeat", json!({})).await,
        |v| v["start"] == true,
    )
    .await;
    assert_eq!(
        f.tool(claim, "permitted", "ctx_memory", json!({})).await["ok"],
        true
    );
    assert_eq!(
        f.event(
            claim,
            1,
            json!({"kind": "complete", "text": "done", "length_capped": false})
        )
        .await["ok"],
        true
    );
    let (mut carrier, result) = bounded(job).await.unwrap();
    result.unwrap();
    f.cleanup(&mut carrier, claim, child, true).await;
}

#[tokio::test]
async fn dream_restart_quarantine_blocks_immediate_replacement() {
    let mut f = Fixture::new();
    let (carrier, _, child) = f.open().await;
    assert!(f.child_resource(&child).exists());
    drop(carrier);
    restart(&mut f, 61_000, "restart-1");
    let (_, result, claim) = try_open(&f).await;
    assert!(
        claim.is_none(),
        "quarantine exposed paid replacement work immediately after restart"
    );
    assert_eq!(
        result.unwrap_err().message,
        "unavailable: dream_restart_quarantine_until:75000"
    );
    assert_eq!(
        marker(&f)["recovery"]["retire_at_ms"],
        70_000 + RESTART_GRACE_MS
    );
    assert!(f.effects.calls.lock().unwrap().is_empty());
}

struct RetirementLogs(Arc<AtomicUsize>);
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for RetirementLogs {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        struct Name(bool);
        impl tracing::field::Visit for Name {
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                if field.name() == "event" && value == "dream_child_restart_retired" {
                    self.0 = true;
                }
            }
            fn record_debug(&mut self, _: &tracing::field::Field, _: &dyn std::fmt::Debug) {}
        }
        let mut name = Name(false);
        event.record(&mut name);
        if name.0 {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn dream_restart_quarantine_retires_at_frozen_horizon() {
    let count = Arc::new(AtomicUsize::new(0));
    let subscriber = tracing_subscriber::registry().with(RetirementLogs(count.clone()));
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let mut f = Fixture::new();
    let (carrier, old, _) = f.open().await;
    drop(carrier);
    restart(&mut f, 61_000, "restart-1");
    assert!(try_open(&f).await.1.is_err());
    f.clock.0.store(75_000, Ordering::SeqCst);
    let (carrier, result, claim) = try_open(&f).await;
    let child = result.expect("expired quarantine never retired its old attempt");
    let claim = claim.unwrap();
    assert_ne!(claim["entry_id"], old["entry_id"]);
    assert!(f.child_resource(&child).exists());
    exercise(&f, carrier, &claim, &child).await;
    assert_eq!(f.effects.calls.lock().unwrap().len(), 1);
    assert!(!marker_path(&f).exists());
    let (mut carrier, claim, child) = f.open().await;
    f.cleanup(&mut carrier, &claim, &child, false).await;
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "retirement must log exactly once, not on ordinary subsequent work"
    );
}

#[tokio::test]
async fn dream_restart_quarantine_second_restart_keeps_horizon() {
    let mut f = Fixture::new();
    let (carrier, _, _) = f.open().await;
    drop(carrier);
    restart(&mut f, 61_000, "restart-1");
    assert!(try_open(&f).await.1.is_err());
    assert_eq!(marker(&f)["recovery"]["retire_at_ms"], 75_000);
    restart(&mut f, 74_000, "restart-2");
    assert!(try_open(&f).await.1.is_err());
    assert_eq!(
        marker(&f)["recovery"]["retire_at_ms"],
        75_000,
        "second restart moved the persisted retirement horizon"
    );
    f.clock.0.store(75_000, Ordering::SeqCst);
    let (carrier, result, claim) = try_open(&f).await;
    let child = result.expect("second restart postponed replacement past the original bound");
    exercise(&f, carrier, &claim.unwrap(), &child).await;
    assert_eq!(f.effects.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn dream_restart_zombie_claim_cannot_write_or_complete() {
    let mut f = Fixture::new();
    let (job, old_claim, _) = f.running().await;
    assert_eq!(
        f.tool(&old_claim, "old-permitted", "ctx_memory", json!({}))
            .await["ok"],
        true
    );
    job.abort();
    let _ = job.await;
    restart(&mut f, 61_000, "restart-1");
    assert_eq!(
        f.tool(&old_claim, "zombie", "ctx_memory", json!({})).await["refusal"],
        "not_found"
    );
    assert_eq!(
        f.event(
            &old_claim,
            1,
            json!({"kind": "complete", "text": "zombie output", "length_capped": false})
        )
        .await["refusal"],
        "not_found"
    );
    assert_eq!(
        f.effects.calls.lock().unwrap().len(),
        1,
        "zombie wrote after restart"
    );
    assert!(try_open(&f).await.1.is_err());
    f.clock.0.store(75_000, Ordering::SeqCst);
    let (carrier, result, new_claim) = try_open(&f).await;
    let child = result.unwrap();
    let new_claim = new_claim.unwrap();
    assert_ne!(old_claim["token"], new_claim["token"]);
    exercise(&f, carrier, &new_claim, &child).await;
    assert_eq!(
        f.tool(&old_claim, "zombie-again", "ctx_memory", json!({}))
            .await["refusal"],
        "not_found"
    );
    assert_eq!(f.effects.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn dream_restart_corrupt_marker_keeps_deadline_unknown() {
    for damage in ["malformed", "unreadable", "oversized", "missing_deadline"] {
        let mut f = Fixture::new();
        let (carrier, _, _) = f.open().await;
        drop(carrier);
        let path = marker_path(&f);
        match damage {
            "unreadable" => {
                std::fs::remove_file(&path).unwrap();
                std::fs::create_dir(&path).unwrap();
            }
            "oversized" => std::fs::write(&path, vec![b' '; 16 * 1024 + 1]).unwrap(),
            "missing_deadline" => {
                let mut value = marker(&f);
                value.as_object_mut().unwrap().remove("deadline_ms");
                std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            _ => std::fs::write(&path, b"{corrupt marker").unwrap(),
        }
        restart(&mut f, 1_000_000, "restart-1");
        let (_, result, claim) = try_open(&f).await;
        assert_eq!(
            result.unwrap_err().message,
            "unavailable: deadline_unknown",
            "{damage}"
        );
        assert!(claim.is_none());
        assert!(path.exists());
        assert!(f.effects.calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn dream_restart_renewal_bound_reads_live_heartbeat() {
    let mut f = Fixture::new();
    let (carrier, _, _) = f.open().await;
    drop(carrier);
    restart(&mut f, 61_000, "restart-1");
    f.clock.0.store(80_000, Ordering::SeqCst);
    let store = f.handler.store.get().unwrap();
    assert!(store
        .renew_dream_domain(&f.context.domain_lease, 80_000)
        .unwrap());
    assert_eq!(
        store
            .dream_domain_timing(&f.context.domain_lease.key)
            .unwrap()
            .unwrap()
            .renewed_at_ms,
        80_000
    );
    let (_, result, claim) = try_open(&f).await;
    assert!(claim.is_none());
    assert_eq!(
        result.unwrap_err().message,
        "unavailable: dream_restart_quarantine_until:85000"
    );
    assert_eq!(marker(&f)["recovery"]["renewal_bound_ms"], 80_000);
    f.clock.0.store(85_000, Ordering::SeqCst);
    let (mut carrier, result, claim) = try_open(&f).await;
    let child = result.unwrap();
    f.cleanup(&mut carrier, &claim.unwrap(), &child, false)
        .await;
}

#[tokio::test]
async fn dream_restart_late_cleanup_preserves_replacement_marker() {
    let mut f = Fixture::new();
    let (carrier, old_claim, old_child) = f.open().await;
    drop(carrier);
    let old_handler = f.handler.clone();
    restart(&mut f, 61_000, "restart-1");
    assert!(try_open(&f).await.1.is_err());
    f.clock.0.store(75_000, Ordering::SeqCst);
    let (carrier, result, claim) = try_open(&f).await;
    let child = result.unwrap();
    let claim = claim.unwrap();
    let new_handler = f.handler.clone();
    f.handler = old_handler;
    std::fs::remove_file(f.child_resource(&old_child)).unwrap();
    assert_eq!(
        f.send(
            &old_claim,
            "dream.child.cleanup",
            json!({"quiescent": true, "retired": true})
        )
        .await["ok"],
        true
    );
    assert_eq!(
        marker(&f)["entry_id"],
        claim["entry_id"],
        "late old cleanup removed the replacement's restart fence"
    );
    f.handler = new_handler;
    exercise(&f, carrier, &claim, &child).await;
    assert_eq!(f.effects.calls.lock().unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn dream_restart_marker_permissions_remain_private_after_freeze() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    let (carrier, _, _) = f.open().await;
    drop(carrier);
    let path = marker_path(&f);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    restart(&mut f, 61_000, "restart-1");
    assert!(try_open(&f).await.1.is_err());
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
