//! The production executor over a Broca transport: a classify run dispatched by
//! the real `Dispatcher` and `DreamExecutor`, with the fake Broca as its port.

use super::*;
use crate::dream_dispatch::dispatcher::{DispatchOutcome, Dispatcher};
use crate::dream_dispatch::executor::{BrocaPorts, DreamExecutor, Transport};
use mc_store::dream_scheduler::schedules::RunStatus as ScheduleStatus;
use mc_store::McStore;

impl BrocaPorts for FakeBroca {
    type Port = FakeBroca;
    fn port(&self) -> FakeBroca {
        self.clone()
    }
}

struct Wall;
impl Clock for Wall {
    fn now_ms(&self) -> i64 {
        crate::now_ms()
    }
}

struct BrocaRun {
    _root: tempfile::TempDir,
    store: Arc<McStore>,
    broca: FakeBroca,
    outcome: DispatchOutcome,
}

fn classify_text() -> &'static str {
    Box::leak(
        format!(
            "<classify>{}</classify>",
            (1..=10)
                .map(|id| format!(
                    "<memory id=\"{id}\" importance=\"80\" scope=\"project\" shareable=\"false\" />"
                ))
                .collect::<String>()
        )
        .into_boxed_str(),
    )
}

/// One manual classify run through the production executor with the user's
/// configured Broca runner, against a fake Broca with `capabilities`.
async fn classify_through_broca(capabilities: &[&str], steps: Vec<Step>) -> BrocaRun {
    let base = std::env::temp_dir().join("magic-context/i5-stage-e");
    std::fs::create_dir_all(&base).unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    let directory = root.path().canonicalize().unwrap();
    let project = directory.to_string_lossy().into_owned();
    let store = Arc::new(
        McStore::open_for_test(&crate::dev_descriptor_at(root.path().to_str().unwrap())).unwrap(),
    );
    store
        .with_context_conn_for_test(|tx| {
            for id in 1..=10 {
                let content = format!("ARCHITECTURE entry {id} describes one durable fact.");
                tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at,metadata_json) VALUES (?1,?2,'ARCHITECTURE',?3,?4,'source',1,1,1,1,'{}')",
                    rusqlite::params![id, project, content, mc_store::compute_normalized_memory_hash(&content)])?;
            }
            Ok(())
        })
        .unwrap();
    let scheduler =
        Arc::new(SqliteDreamScheduler::open(root.path().join("scheduler.db"), true).unwrap());
    let handler = Arc::new(McHandler::new());
    let broca = FakeBroca {
        state: Arc::new(Mutex::new(State {
            describe: describe(capabilities, 1_000_000, 600_000),
            steps,
            ..State::default()
        })),
        handler: handler.clone(),
        directory: directory.clone(),
    };
    let mut dispatcher = Dispatcher {
        store: store.clone(),
        scheduler: scheduler.clone(),
        scope: StoreScope {
            project: ProjectId(project),
            session: SessionId("parent".into()),
            generation: Generation(1),
        },
        config: Arc::new(CapturedConfig {
            activated: true,
            // The user named Broca as the dreamer runner.
            route: McModuleConfig {
                rust_background_enabled: true,
                dreamer_runner: Some(HistorianRunnerKind::Broca),
                ..Default::default()
            },
            effective: json!({"dreamer": {"claude-code": {"model": "provider/model"},
                "tasks": {"classify-memories": {"schedule": "* * * * *"}}}}),
            harness: "claude-code".into(),
            directory,
        }),
        clock: Arc::new(Wall),
        executor: DreamExecutor::new(
            store.clone(),
            scheduler,
            Transport::Broca {
                ports: broca.clone(),
                routes: handler.broca_dream_tools(),
                module_id: "magic-context".into(),
            },
            &[TaskName::Classify],
        ),
    };
    let config = TaskConfig {
        task: TaskName::Classify,
        schedule: "* * * * *".into(),
        has_input: true,
        legacy_last_run_at: None,
    };
    let outcome = bounded(dispatcher.manual(
        &config,
        "command",
        Duration::from_secs(30),
        Cancellation::default(),
    ))
    .await;
    BrocaRun {
        _root: root,
        store,
        broca,
        outcome,
    }
}

fn classified(store: &McStore) -> i64 {
    store
        .with_context_read(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM memories WHERE classified_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
        })
        .unwrap()
}

fn input_cap(run: &BrocaRun) -> Option<u64> {
    let sends = run.broca.ops("session.send");
    assert!(
        !sends.is_empty(),
        "no send: {:?} log {:?}",
        run.outcome,
        run.broca.state().log
    );
    sends[0]["budget"]["max_input_tokens"].as_u64()
}

#[tokio::test]
async fn broca_executor_sends_the_cap_only_to_a_runner_that_advertises_it() {
    let mut capped = BASE.to_vec();
    capped.push("input_token_cap");
    let with_cap = classify_through_broca(&capped, vec![answer(classify_text())]).await;
    assert_eq!(
        with_cap.outcome,
        DispatchOutcome::Finished(ScheduleStatus::Completed)
    );
    // The whole classify task budget is the cap: nothing was spent before.
    assert_eq!(input_cap(&with_cap), Some(2_500_000));
    assert_eq!(classified(&with_cap.store), 10);

    let without = classify_through_broca(BASE, vec![answer(classify_text())]).await;
    assert_eq!(
        without.outcome,
        DispatchOutcome::Finished(ScheduleStatus::Completed)
    );
    assert_eq!(input_cap(&without), None);
    assert!(without.broca.ops("session.send")[0].get("budget").is_none());
    assert_eq!(classified(&without.store), 10);
}

#[tokio::test]
async fn broca_budget_exhausted_ends_the_run_cleanly_without_an_effect() {
    let mut capped = BASE.to_vec();
    capped.push("input_token_cap");
    let mut over = answer(classify_text());
    over.input = 3_000_000;
    let run = classify_through_broca(&capped, vec![over]).await;
    // The run finishes (failed, recorded), it is not aborted or left leased.
    assert_eq!(
        run.outcome,
        DispatchOutcome::Finished(ScheduleStatus::Failed)
    );
    assert_eq!(classified(&run.store), 0);
    let state = run.broca.state();
    assert_eq!(
        state.run.as_ref().unwrap().terminal.as_ref().unwrap().state,
        "budget_exhausted"
    );
    assert!(!state.released.is_empty(), "the Broca session was released");
    drop(state);
    // The domain lease was released: TypeScript can take the next run.
    assert!(run
        .store
        .acquire_dream_domain(
            &TaskName::Classify.lease_key(&run.store_project()),
            "typescript",
            crate::now_ms()
        )
        .unwrap()
        .is_some());
}

impl BrocaRun {
    fn store_project(&self) -> String {
        self._root
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }
}
