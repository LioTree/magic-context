use super::context::*;
use super::dispatcher::*;
use super::domain_control::{available, SystemClock};
use crate::config_parity::{
    ConfigResolveRequest, CoreConfig, CoreConfigResolver, ProtectedTokenTiers, TrustFlags,
};
use mc_store::dream_scheduler::{
    schedules::{RunOutcome, RunStatus, ScheduleState, TaskConfig, TaskName},
    SqliteDreamScheduler,
};
use mc_store::parity_schema_manifest::*;
use mc_store::McStore;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Effects {
    path: PathBuf,
    store: Arc<McStore>,
    gate: bool,
    gate_error: bool,
    lose_lease: bool,
    charge: bool,
}

impl TaskExecutor for Effects {
    fn operational_tasks(&self) -> &[TaskName] {
        &[TaskName::Classify]
    }
    fn gate(&mut self, _: TaskName, _: &StoreScope, _: &ScheduleState) -> Result<bool, String> {
        if self.gate_error {
            Err("fixture read failed".into())
        } else {
            Ok(self.gate)
        }
    }
    async fn run(&mut self, context: &TaskContext) -> RunOutcome {
        assert_eq!(context.task, TaskName::Classify);
        assert!(context.config.activated);
        if self.charge {
            let usage = crate::dream_runner::Usage {
                input: 100,
                cache_read: 20,
                cache_write: 3,
                output: 999,
            };
            assert_eq!(
                context
                    .control
                    .charge_usage("child:message", &usage, true, false)
                    .unwrap(),
                mc_store::dream_scheduler::budget::BudgetAction::Continue
            );
            context
                .control
                .charge_usage("child:message", &usage, true, false)
                .unwrap();
        }
        if self.lose_lease {
            self.store
                .release_dream_domain(&context.domain_lease)
                .unwrap();
            self.store
                .acquire_dream_domain(&context.domain_lease.key, "successor", context.now_ms())
                .unwrap()
                .unwrap();
            assert_eq!(context.check_control(), Err(ControlError::LeaseLost));
        }
        let mut db = Connection::open(&self.path).unwrap();
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let write = (|| {
            mc_store::dream_domain::require_tx(&tx, &context.domain_lease, context.now_ms())?;
            tx.execute("INSERT INTO dream_state(key,value) VALUES ('fixture-effect','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1", [])?;
            Ok::<_, rusqlite::Error>(())
        })();
        if self.lose_lease {
            assert!(write.is_err());
            return RunOutcome::new(RunStatus::Failed);
        }
        write.unwrap();
        tx.commit().unwrap();
        RunOutcome::new(RunStatus::Completed)
    }
}

fn fixture() -> (Dispatcher<Effects>, tempfile::TempDir, Arc<TestClock>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                .replace(":applied_at", "1"),
        )
        .unwrap();
    let store =
        Arc::new(McStore::open(&crate::dev_descriptor_at(dir.path().to_str().unwrap())).unwrap());
    store.install_context_domain(Arc::new(
        mc_store::SqliteContextDomain::open(&path).unwrap(),
    ));
    let scheduler =
        Arc::new(SqliteDreamScheduler::open(dir.path().join("scheduler.db"), true).unwrap());
    let clock = Arc::new(TestClock(AtomicI64::new(60_000)));
    let effects = Effects {
        path: dir.path().join("context.db"),
        store: store.clone(),
        gate: true,
        gate_error: false,
        lose_lease: false,
        charge: false,
    };
    (
        Dispatcher {
            store,
            scheduler,
            scope: StoreScope {
                project: ProjectId("project".into()),
                session: SessionId("session".into()),
                generation: Generation(1),
            },
            config: Arc::new(CapturedConfig {
                activated: true,
                route: crate::McModuleConfig::default(),
                effective: json!({}),
                harness: "opencode".into(),
                directory: dir.path().into(),
            }),
            clock: clock.clone(),
            executor: effects,
        },
        dir,
        clock,
    )
}

fn config() -> TaskConfig {
    TaskConfig {
        task: TaskName::Classify,
        schedule: "* * * * *".into(),
        has_input: true,
        legacy_last_run_at: None,
    }
}

fn effects(path: &std::path::Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM dream_state WHERE key='fixture-effect'",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
        .unwrap_or(0)
}

fn ts(path: &std::path::Path, action: &str, key: &str, holder: &str) -> Value {
    let output = std::process::Command::new("bun")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/dream_domain.ts"))
        .args([path.to_str().unwrap(), action, key, holder])
        .output()
        .expect("Bun is required for the real TS lease proof");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn ts_held_domain_blocks_rust_canonical_dispatch() {
    let (mut dispatcher, _dir, _) = fixture();
    dispatcher.clock = Arc::new(SystemClock);
    let key = TaskName::Classify.lease_key(&dispatcher.scope.project.0);
    assert_eq!(
        ts(&dispatcher.executor.path, "acquire", &key, "typescript")["owns"],
        true
    );
    let outcome = dispatcher
        .manual(&config(), "manual", TIMEOUT, Cancellation::default())
        .await;
    assert_eq!(outcome, DispatchOutcome::Refused("domain_busy".into()));
    assert!(available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify)
    )
    .unwrap()
    .is_none());
    assert_eq!(effects(&dispatcher.executor.path), 0);
    ts(&dispatcher.executor.path, "release", &key, "typescript");
    assert_eq!(
        dispatcher
            .manual(&config(), "manual", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(effects(&dispatcher.executor.path), 1);
}

#[tokio::test]
async fn rust_held_domain_blocks_actual_ts_acquire_during_dispatch() {
    struct TsProbe(Effects);
    impl TaskExecutor for TsProbe {
        fn operational_tasks(&self) -> &[TaskName] {
            self.0.operational_tasks()
        }
        fn gate(&mut self, _: TaskName, _: &StoreScope, _: &ScheduleState) -> Result<bool, String> {
            Ok(true)
        }
        async fn run(&mut self, context: &TaskContext) -> RunOutcome {
            let value = ts(
                &self.0.path,
                "acquire",
                &context.domain_lease.key,
                "typescript",
            );
            assert!(
                value["lease"].is_null(),
                "TS acquired Rust-owned domain: {value}"
            );
            self.0.run(context).await
        }
    }
    let (dispatcher, _dir, _) = fixture();
    let mut dispatcher = Dispatcher {
        store: dispatcher.store,
        scheduler: dispatcher.scheduler,
        scope: dispatcher.scope,
        config: dispatcher.config,
        clock: Arc::new(SystemClock),
        executor: TsProbe(dispatcher.executor),
    };
    assert_eq!(
        dispatcher
            .manual(&config(), "rust-first", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(effects(&dispatcher.executor.0.path), 1);
    assert_eq!(
        ts(
            &dispatcher.executor.0.path,
            "acquire",
            &TaskName::Classify.lease_key("project"),
            "typescript"
        )["owns"],
        true
    );
}

#[tokio::test]
async fn due_tick_and_manual_replay_run_once_across_reopen() {
    let (mut dispatcher, dir, clock) = fixture();
    assert!(dispatcher
        .tick(&[config()], true, TIMEOUT)
        .await
        .unwrap()
        .is_empty());
    clock.0.store(120_000, Ordering::SeqCst);
    assert_eq!(
        dispatcher.tick(&[config()], true, TIMEOUT).await.unwrap(),
        vec![(
            TaskName::Classify,
            DispatchOutcome::Finished(RunStatus::Completed)
        )]
    );
    assert!(dispatcher
        .tick(&[config()], true, TIMEOUT)
        .await
        .unwrap()
        .is_empty());
    dispatcher.executor.charge = true;
    assert_eq!(
        dispatcher
            .manual(&config(), "command", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    dispatcher.scheduler =
        Arc::new(SqliteDreamScheduler::open(dir.path().join("scheduler.db"), true).unwrap());
    assert!(matches!(
        dispatcher
            .manual(&config(), "command", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Refused(_)
    ));
    assert_eq!(effects(&dispatcher.executor.path), 2);
    let db = Connection::open(dir.path().join("scheduler.db")).unwrap();
    let spent: u64 = db.query_row("SELECT json_extract(state,'$.spent_tokens') FROM dream_runs WHERE invocation='command'", [], |r| r.get(0)).unwrap();
    assert_eq!(spent, 123);
}

#[tokio::test]
async fn lease_loss_aborts_effects_without_advancing_schedule() {
    let (mut dispatcher, _dir, _) = fixture();
    available(
        dispatcher
            .scheduler
            .plan_due(&dispatcher.scope, &[config()], 60_000, true),
    )
    .unwrap();
    let before = available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify),
    )
    .unwrap();
    dispatcher.executor.lose_lease = true;
    assert_eq!(
        dispatcher
            .manual(&config(), "lost", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Aborted(ControlError::LeaseLost)
    );
    assert_eq!(effects(&dispatcher.executor.path), 0);
    assert_eq!(
        available(
            dispatcher
                .scheduler
                .schedule(&dispatcher.scope, TaskName::Classify)
        )
        .unwrap(),
        before
    );
}

#[tokio::test]
async fn unavailable_and_due_manual_gate_matrix_preserve_schedules() {
    let (mut dispatcher, _dir, clock) = fixture();
    let mut unsupported = config();
    unsupported.task = TaskName::EvaluateSmartNotes;
    assert_eq!(
        dispatcher
            .manual(&unsupported, "missing", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Unavailable
    );
    assert!(dispatcher
        .tick(&[unsupported.clone()], true, TIMEOUT)
        .await
        .unwrap()
        .is_empty());
    assert!(available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, unsupported.task)
    )
    .unwrap()
    .is_none());
    available(
        dispatcher
            .scheduler
            .plan_due(&dispatcher.scope, &[unsupported.clone()], 0, true),
    )
    .unwrap();
    let before = available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, unsupported.task),
    )
    .unwrap();
    unsupported.schedule.clear();
    dispatcher
        .tick(&[unsupported], true, TIMEOUT)
        .await
        .unwrap();
    assert_eq!(
        available(
            dispatcher
                .scheduler
                .schedule(&dispatcher.scope, TaskName::EvaluateSmartNotes)
        )
        .unwrap(),
        before
    );
    assert!(dispatcher
        .tick(&[config()], false, TIMEOUT)
        .await
        .unwrap()
        .is_empty());
    assert!(available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify)
    )
    .unwrap()
    .is_none());
    dispatcher.tick(&[config()], true, TIMEOUT).await.unwrap();
    let before = available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify),
    )
    .unwrap();
    clock.0.store(120_000, Ordering::SeqCst);
    dispatcher.executor.gate_error = true;
    assert!(matches!(
        &dispatcher.tick(&[config()], true, TIMEOUT).await.unwrap()[0].1,
        DispatchOutcome::Refused(_)
    ));
    assert_eq!(
        available(
            dispatcher
                .scheduler
                .schedule(&dispatcher.scope, TaskName::Classify)
        )
        .unwrap(),
        before
    );
    dispatcher.executor.gate_error = false;
    dispatcher.executor.gate = false;
    assert!(matches!(
        &dispatcher.tick(&[config()], true, TIMEOUT).await.unwrap()[0].1,
        DispatchOutcome::Refused(_)
    ));
    let after = available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify),
    )
    .unwrap()
    .unwrap();
    assert_eq!(after.last_status, Some(RunStatus::Skipped));
    assert_eq!(after.last_run_at, None);
    let mut disabled = config();
    disabled.schedule.clear();
    assert_eq!(
        dispatcher
            .manual(
                &disabled,
                "force-disabled",
                TIMEOUT,
                Cancellation::default()
            )
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert!(OPERATIONAL_TASKS.is_empty());
}

struct FlipResolver {
    on: AtomicBool,
    flip_to: bool,
    reads: AtomicUsize,
}
impl CoreConfigResolver for FlipResolver {
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn resolve(&self, _: &ConfigResolveRequest) -> CapabilityResult<CoreConfig> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let effective = crate::McModuleConfig {
            rust_background_enabled: self.on.swap(self.flip_to, Ordering::SeqCst),
            ..Default::default()
        };
        CapabilityResult::Available {
            value: CoreConfig {
                effective,
                generation: Generation(1),
                settings: json!({}),
                warnings: vec![],
                trust: TrustFlags::default(),
                protected_token_tiers: ProtectedTokenTiers::default(),
            },
        }
    }
}

#[test]
fn captured_on_to_off_tick_dispatches_and_off_to_on_tick_dispatches_none() {
    for on in [true, false] {
        let (mut dispatcher, _dir, clock) = fixture();
        available(
            dispatcher
                .scheduler
                .plan_due(&dispatcher.scope, &[config()], 60_000, true),
        )
        .unwrap();
        clock.0.store(120_000, Ordering::SeqCst);
        let path = dispatcher.executor.path.clone();
        let resolver = Arc::new(FlipResolver {
            on: AtomicBool::new(on),
            flip_to: !on,
            reads: AtomicUsize::new(0),
        });
        let input = crate::background::ConfigInput {
            resolver: resolver.clone(),
            request: ConfigResolveRequest {
                user_config_path: String::new(),
                project_root: "/fixture".into(),
                generation: Generation(1),
            },
        };
        let joined = crate::background::dreamer_tick(input, move |unit| {
            dispatcher.config =
                unit.captured_dream_config("opencode".into(), dispatcher.config.directory.clone());
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(dispatcher.tick(&[config()], true, TIMEOUT))
                .unwrap()
        })
        .unwrap()
        .join()
        .unwrap()
        .unwrap();
        assert_eq!(resolver.reads.load(Ordering::SeqCst), 1);
        assert_eq!(resolver.on.load(Ordering::SeqCst), !on);
        if on {
            assert_eq!(
                joined.unwrap(),
                vec![(
                    TaskName::Classify,
                    DispatchOutcome::Finished(RunStatus::Completed)
                )]
            );
        } else {
            assert!(joined.is_none());
        }
        assert_eq!(effects(&path), i64::from(on));
    }
}

#[tokio::test]
async fn budget_cancellation_deadline_and_failed_heartbeat_stop_run_control() {
    struct Probe {
        store: Arc<McStore>,
        scheduler: Arc<SqliteDreamScheduler>,
        mode: u8,
    }
    impl TaskExecutor for Probe {
        fn operational_tasks(&self) -> &[TaskName] {
            &[TaskName::Classify]
        }
        fn gate(&mut self, _: TaskName, _: &StoreScope, _: &ScheduleState) -> Result<bool, String> {
            Ok(true)
        }
        async fn run(&mut self, context: &TaskContext) -> RunOutcome {
            match self.mode {
                0 => {
                    let usage = crate::dream_runner::Usage {
                        input: 2_500_000,
                        ..Default::default()
                    };
                    assert_eq!(
                        context
                            .control
                            .charge_usage("budget", &usage, false, false)
                            .unwrap(),
                        mc_store::dream_scheduler::budget::BudgetAction::Stop
                    );
                    assert_eq!(context.check_control(), Err(ControlError::BudgetExhausted));
                    assert!(context.control.refuse_tool().unwrap().is_some());
                }
                1 => context.cancellation.cancel(),
                2 => {
                    std::future::pending::<()>().await;
                }
                3 => {
                    let control = super::domain_control::DomainControl::new(
                        self.store.clone(),
                        self.scheduler.clone(),
                        context.domain_lease.clone(),
                        context.task_lease.clone(),
                        context.cancellation.clone(),
                        context.clock.clone(),
                        context.deadline_ms,
                    );
                    control.heartbeat().unwrap();
                    self.store
                        .release_dream_domain(&context.domain_lease)
                        .unwrap();
                    self.store
                        .acquire_dream_domain(
                            &context.domain_lease.key,
                            "replacement",
                            context.now_ms(),
                        )
                        .unwrap()
                        .unwrap();
                    assert_eq!(control.heartbeat(), Err(ControlError::LeaseLost));
                    assert_eq!(control.check_control(), Err(ControlError::LeaseLost));
                }
                _ => unreachable!(),
            }
            RunOutcome::new(RunStatus::Failed)
        }
    }
    for mode in 0..4 {
        let (d, _dir, _) = fixture();
        let mut d = Dispatcher {
            executor: Probe {
                store: d.store.clone(),
                scheduler: d.scheduler.clone(),
                mode,
            },
            store: d.store,
            scheduler: d.scheduler,
            scope: d.scope,
            config: d.config,
            clock: d.clock,
        };
        let timeout = if mode == 2 {
            Duration::from_millis(5)
        } else {
            TIMEOUT
        };
        let result = d
            .manual(&config(), "control", timeout, Cancellation::default())
            .await;
        let expected = match mode {
            0 => DispatchOutcome::Finished(RunStatus::Failed),
            1 => DispatchOutcome::Aborted(ControlError::Cancelled),
            2 => DispatchOutcome::Aborted(ControlError::Deadline),
            _ => DispatchOutcome::Aborted(ControlError::LeaseLost),
        };
        assert_eq!(result, expected);
        let now = d.clock.now_ms();
        // The task worker has stopped, so a new holder can immediately acquire.
        let lease = d
            .store
            .acquire_dream_domain(&TaskName::Classify.lease_key("project"), "after", now)
            .unwrap();
        if mode != 3 {
            assert!(lease.is_some());
        }
    }
}
