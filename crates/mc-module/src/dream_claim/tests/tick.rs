//! The Rust dreamer end to end: a real handler and store, the production executor,
//! tick and Host carrier, and a scripted dream-claim-v1 claimant declared on an
//! attested harness route. No real host runs; the claimant is this test.

use super::*;
use crate::config_parity::{
    ConfigResolveRequest, CoreConfig, CoreConfigResolver, ProtectedTokenTiers, TrustFlags,
};
use crate::dream_dispatch::dispatcher::DispatchOutcome;
use crate::dream_dispatch::tick::{ManualRun, RunReport};
use mc_store::dream_scheduler::schedules::RunStatus;
use rusqlite::params;

pub(super) const HARNESS: u16 = 9;
pub(super) const PLUGIN: u16 = 7;

pub(super) struct FixedResolver {
    pub on: bool,
    pub settings: Value,
}

impl CoreConfigResolver for FixedResolver {
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn resolve(&self, _: &ConfigResolveRequest) -> CapabilityResult<CoreConfig> {
        CapabilityResult::Available {
            value: CoreConfig {
                effective: McModuleConfig {
                    rust_background_enabled: self.on,
                    ..Default::default()
                },
                generation: Generation(1),
                settings: self.settings.clone(),
                warnings: Vec::new(),
                trust: TrustFlags::default(),
                protected_token_tiers: ProtectedTokenTiers::default(),
            },
        }
    }
}

/// The trusted dreamer settings: a model for the claimant's harness and the
/// schedules of the given tasks. Tasks left out have no schedule and never run.
pub(super) fn settings(scheduled: &[&str]) -> Value {
    let mut tasks = serde_json::Map::new();
    for task in scheduled {
        tasks.insert((*task).into(), json!({"schedule": "* * * * *"}));
    }
    json!({"dreamer": {"tasks": tasks, "opencode": {"model": "provider/model"}}})
}

/// What a claimant that can carry the classifier and the curator declares.
pub(super) fn claimant() -> Value {
    json!({"capabilities": claimant_capabilities(),
        "agents": {"dreamer-classifier": [], "dreamer": ["ctx_memory"]}})
}

pub(super) fn claimant_capabilities() -> Value {
    json!({"tools": ["ctx_memory"], "child_guard": true, "steps": true, "tokens": true,
        "stop": true, "retire": true, "task_tools": true})
}

pub(super) struct Project {
    /// Owns a fresh root; `None` when the test reopened a root it was handed.
    pub _owned: Option<tempfile::TempDir>,
    pub handler: Arc<McHandler>,
    pub project: String,
}

impl Project {
    /// A handler over a fresh store in `root`, or over an existing one when the
    /// root is given (a restarted process).
    pub fn open(on: bool, scheduled: &[&str], at: Option<&std::path::Path>) -> Self {
        let owned = at.is_none().then(|| {
            let base = std::env::temp_dir().join("magic-context/i5-stage-e");
            std::fs::create_dir_all(&base).unwrap();
            tempfile::tempdir_in(base).unwrap()
        });
        let root = at.map_or_else(
            || owned.as_ref().unwrap().path().to_owned(),
            |p| p.to_owned(),
        );
        let directory = root.canonicalize().unwrap();
        // The test store installs its own context.db (with the test schema) beside
        // store.db, and admits fixture memory rows.
        let store = Arc::new(
            McStore::open_for_test(&crate::dev_descriptor_at(root.to_str().unwrap())).unwrap(),
        );
        let mut handler = McHandler::new();
        assert!(handler.store.set(store).is_ok());
        handler.fixed_config = Some(McModuleConfig {
            rust_background_enabled: on,
            ..Default::default()
        });
        handler.fixed_dream_settings = Some(settings(scheduled));
        let resolver = Arc::new(FixedResolver {
            on,
            settings: settings(scheduled),
        });
        handler.dream_runs.use_resolver(resolver.clone());
        let plugin = SessionBinding {
            connection_incarnation: 1,
            native_generation: None,
            principal: None,
            scope: None,
            project_root: directory.clone(),
            harness: "opencode".into(),
            session: "parent".into(),
            model_key: None,
            config: McModuleConfig::default(),
            history_budget_tokens: 1000.0,
        };
        handler.bind_route(
            HARNESS,
            super::ownership::attested(plugin.clone(), "opencode"),
        );
        handler.bind_route(PLUGIN, plugin.clone());
        let project = handler
            .historian_lane_project(&plugin, handler.store.get().unwrap())
            .unwrap();
        Self {
            _owned: owned,
            handler: Arc::new(handler),
            project,
        }
    }

    pub async fn call(&self, channel: u16, mut request: Value) -> Value {
        request["v"] = json!(1);
        match Box::pin(self.handler.dispatch_value(channel, request)).await {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            HandlerOutcome::Error { code, .. } => json!({"error": code}),
            other => panic!("unexpected outcome {other:?}"),
        }
    }

    pub async fn declare(&self) -> Value {
        self.call(
            HARNESS,
            json!({"method": "dream.ownership", "claimant": claimant()}),
        )
        .await
    }

    pub fn exec(&self, sql: &str) {
        self.handler
            .store
            .get()
            .unwrap()
            .with_context_conn_for_test(|tx| tx.execute_batch(sql))
            .unwrap();
    }

    pub fn scalar(&self, sql: &str) -> i64 {
        self.handler
            .store
            .get()
            .unwrap()
            .with_context_read(|db| db.query_row(sql, [], |r| r.get(0)))
            .unwrap()
    }

    /// Ten unclassified memories of this project.
    pub fn memories(&self, category: &str) {
        self.handler
            .store
            .get()
            .unwrap()
            .with_context_conn_for_test(|tx| {
                for id in 1..=10 {
                    let content = format!("{category} entry {id} describes one durable fact.");
                    tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at,metadata_json) VALUES(?1,?2,?3,?4,?5,'source',1,1,1,1,'{}')",
                        params![id, self.project, category, content, mc_store::compute_normalized_memory_hash(&content)])?;
                }
                Ok(())
            })
            .unwrap();
    }

    /// The TypeScript scheduler's row for `task`, due a minute ago.
    pub fn due_in_typescript(&self, task: &str) -> i64 {
        let due = (crate::now_ms() / 60_000 - 1) * 60_000;
        self.exec(&format!(
            "INSERT INTO task_schedule_state(project_path,task,next_due_at,schedule,retry_count) VALUES('{}','{task}',{due},'* * * * *',0)",
            self.project
        ));
        due
    }

    pub fn pending(&self) -> usize {
        self.handler
            .dream_queue()
            .route(
                &self.project,
                "harness-session",
                "dream.child.pending",
                &json!({"v": 1}),
            )
            .ok()
            .and_then(|v| v["entries"].as_array().map(Vec::len))
            .unwrap_or(0)
    }

    pub fn start(&self, manual: Option<ManualRun>) -> Option<crate::dream_dispatch::tick::Job> {
        self.handler.dream_handles().start(&self.project, manual)
    }
}

/// Wait for a worker without blocking the runtime that serves the claimant.
pub(super) async fn join<T: Send + 'static>(job: std::thread::JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !job.is_finished() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("dream worker did not finish");
    job.join().unwrap()
}

/// What the scripted claimant does with one child.
pub(super) enum Script {
    /// Answer with this completion text.
    Complete(String),
    /// Run these ctx_memory calls, then answer with this text.
    Tools(Vec<Value>, String),
    /// Stop after the child started, as a host that is killed mid-run would.
    Hang,
}

async fn send(p: &Project, claim: &Value, method: &str, mut body: Value) -> Value {
    body["method"] = json!(method);
    body["entry_id"] = claim["entry_id"].clone();
    body["token"] = claim["token"].clone();
    body["child_id"] = claim["descriptor"]["child_id"].clone();
    body["claimant_epoch"] = json!("epoch-1");
    p.call(HARNESS, body).await
}

/// One dream-claim-v1 child, claimed from the attested harness route: claim,
/// open, wait for start, act, complete, wait for stop, clean up.
pub(super) async fn serve_child(p: &Project, script: Script) -> Value {
    let pending = wait_for(
        async || {
            p.call(HARNESS, json!({"method": "dream.child.pending"}))
                .await
        },
        |v| v["entries"][0]["entry_id"].is_string(),
    )
    .await;
    let id = pending["entries"][0]["entry_id"].clone();
    let claim = p
        .call(
            HARNESS,
            json!({"method": "dream.child.claim", "entry_id": id, "claimant_epoch": "epoch-1",
                "capabilities": claimant_capabilities()}),
        )
        .await;
    assert_eq!(claim["ok"], true, "{claim}");
    let host_child = format!("host-{}", id.as_str().unwrap());
    assert_eq!(
        send(
            p,
            &claim,
            "dream.child.opened",
            json!({"host_child_id": host_child})
        )
        .await["ok"],
        true
    );
    wait_for(
        async || send(p, &claim, "dream.child.heartbeat", json!({})).await,
        |v| v["start"] == true,
    )
    .await;
    let text = match script {
        Script::Hang => return claim,
        Script::Complete(text) => text,
        Script::Tools(calls, text) => {
            for (n, arguments) in calls.into_iter().enumerate() {
                let answer = send(
                    p,
                    &claim,
                    "dream.child.tool",
                    json!({"call_id": format!("call-{n}"), "tool": "ctx_memory", "arguments": arguments}),
                )
                .await;
                assert_eq!(answer["ok"], true, "{answer}");
            }
            text
        }
    };
    let done = send(
        p,
        &claim,
        "dream.child.event",
        json!({"seq": 1, "event": {"kind": "complete", "text": text, "length_capped": false}}),
    )
    .await;
    assert_eq!(done["ok"], true, "{done}");
    wait_for(
        async || send(p, &claim, "dream.child.heartbeat", json!({})).await,
        |v| v["stop"] == true,
    )
    .await;
    let cleaned = send(
        p,
        &claim,
        "dream.child.cleanup",
        json!({"quiescent": true, "retired": true}),
    )
    .await;
    assert_eq!(cleaned["ok"], true, "{cleaned}");
    claim
}

pub(super) fn classify_answer() -> String {
    format!(
        "<classify>{}</classify>",
        (1..=10)
            .map(|id| format!(
                "<memory id=\"{id}\" importance=\"80\" scope=\"project\" shareable=\"false\" />"
            ))
            .collect::<String>()
    )
}

fn finished(report: &RunReport, task: TaskName) -> bool {
    report
        .iter()
        .any(|(t, o)| *t == task && *o == DispatchOutcome::Finished(RunStatus::Completed))
}

#[tokio::test]
async fn a_declared_claimant_runs_classify_through_rust_and_its_effect_lands() {
    let p = Project::open(true, &["classify-memories"], None);
    let published = p.declare().await;
    assert!(
        published["published"]
            .as_array()
            .unwrap()
            .contains(&json!("classify-memories")),
        "{published}"
    );
    // The plugin route reads the same list, so TypeScript skips classify.
    assert_eq!(
        p.call(PLUGIN, json!({"method": "dream.ownership"})).await["published"],
        published["published"]
    );
    p.memories("ARCHITECTURE");
    let due = p.due_in_typescript("classify-memories");
    let job = p.start(None).expect("a run starts");
    serve_child(&p, Script::Complete(classify_answer())).await;
    let report = join(job).await.unwrap().unwrap().unwrap();
    assert!(finished(&report, TaskName::Classify), "{report:?}");
    assert_eq!(
        p.scalar("SELECT COUNT(*) FROM memories WHERE classified_at IS NOT NULL"),
        10
    );
    // The TypeScript row now carries Rust's progress past the slot it ran.
    assert!(
        p.scalar(&format!(
            "SELECT next_due_at FROM task_schedule_state WHERE project_path='{}' AND task='classify-memories'",
            p.project
        )) > due
    );
    assert_eq!(
        p.scalar(&format!(
            "SELECT COUNT(*) FROM task_schedule_state WHERE project_path='{}' AND task='classify-memories' AND last_status='completed'",
            p.project
        )),
        1
    );
    // A second tick in the same period runs nothing.
    let again = join(p.start(None).unwrap())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(again.is_empty(), "{again:?}");
    assert_eq!(p.pending(), 0);
}

#[tokio::test]
async fn without_a_claimant_rust_publishes_and_runs_nothing() {
    let p = Project::open(true, &["classify-memories", "curate"], None);
    let answer = p.call(PLUGIN, json!({"method": "dream.ownership"})).await;
    assert_eq!(answer["published"], json!([]), "{answer}");
    assert_eq!(answer["claimant_declared"], false);
    p.memories("ARCHITECTURE");
    p.due_in_typescript("classify-memories");
    let report = join(p.start(None).expect("the project was seen"))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(report.is_empty(), "{report:?}");
    assert_eq!(p.pending(), 0);
    assert_eq!(
        p.scalar("SELECT COUNT(*) FROM memories WHERE classified_at IS NOT NULL"),
        0
    );
    // The TypeScript row is untouched: TypeScript still runs the task.
    assert_eq!(
        p.scalar("SELECT COUNT(*) FROM task_schedule_state WHERE last_status IS NOT NULL"),
        0
    );
}

#[tokio::test]
async fn with_the_switch_off_nothing_is_recorded_published_or_started() {
    let p = Project::open(false, &["classify-memories"], None);
    let answer = p.declare().await;
    assert_eq!(answer["activated"], false);
    assert_eq!(answer["published"], json!([]));
    // A worker may start for the declared claimant, but it reads the switch
    // first and does no work at all.
    if let Some(job) = p.start(None) {
        assert_eq!(join(job).await, Ok(None));
    }
    assert_eq!(p.pending(), 0);
    assert_eq!(p.scalar("SELECT COUNT(*) FROM task_schedule_state"), 0);
}

#[tokio::test]
async fn a_curate_edit_runs_through_the_task_router_with_history_and_revisions() {
    let p = Project::open(true, &["curate"], None);
    p.declare().await;
    p.memories("ARCHITECTURE");
    p.due_in_typescript("curate");
    let job = p.start(None).expect("a run starts");
    let update = json!({"action": "update", "ids": [1],
        "content": "ARCHITECTURE entry 1 states its durable fact in clearer present-tense words."});
    serve_child(
        &p,
        Script::Tools(vec![update], "Updated one memory.".into()),
    )
    .await;
    let report = join(job).await.unwrap().unwrap().unwrap();
    assert!(finished(&report, TaskName::Curate), "{report:?}");
    assert_eq!(
        p.scalar("SELECT revision FROM memories WHERE id=1"),
        2,
        "the edit bumped the revision"
    );
    // The audited history row holds everything needed to restore the prior text.
    assert_eq!(
        p.scalar("SELECT COUNT(*) FROM memory_history WHERE memory_id=1 AND revision=1 AND previous_text='ARCHITECTURE entry 1 describes one durable fact.' AND json_extract(before_json,'$.content')=previous_text AND json_extract(after_json,'$.revision')=2"),
        1
    );
    assert_eq!(p.scalar("SELECT COUNT(*) FROM memory_journal"), 1);
}

#[tokio::test]
async fn a_manual_run_forces_one_published_task_once_per_command() {
    let p = Project::open(true, &["classify-memories"], None);
    p.declare().await;
    p.memories("ARCHITECTURE");
    let manual = || ManualRun {
        task: TaskName::Classify,
        command_id: "command-1".into(),
    };
    let job = p.start(Some(manual())).expect("a run starts");
    serve_child(&p, Script::Complete(classify_answer())).await;
    let report = join(job).await.unwrap().unwrap().unwrap();
    assert!(finished(&report, TaskName::Classify), "{report:?}");
    // Replaying the command id never runs the task again.
    let replay = join(p.start(Some(manual())).unwrap())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            replay[..],
            [(TaskName::Classify, DispatchOutcome::Refused(_))]
        ),
        "{replay:?}"
    );
    assert_eq!(p.pending(), 0);
    // A task Rust has not published is refused on the route and stays with TypeScript.
    let refused = p
        .call(
            PLUGIN,
            json!({"method": "dream.run", "task": "retrospective", "command_id": "c2"}),
        )
        .await;
    assert_eq!(refused["refusal"], "not_published", "{refused}");
}

/// Real time shifted by an adjustable offset, so a restarted process can look
/// past the dead process's leases and its child's frozen retirement horizon.
struct Shifted(std::sync::atomic::AtomicI64);

impl Clock for Shifted {
    fn now_ms(&self) -> i64 {
        crate::now_ms() + self.0.load(Ordering::SeqCst)
    }
}

const KILL_ROOT: &str = "MC_I5E_KILLED_DREAM_ROOT";
const KILL_CHILD: &str = "dream_claim::tests::tick::killed_process_runs_a_dream_until_it_is_killed";

/// The process the recovery test kills: it starts a Rust classify run, lets the
/// claimant open and start the child, announces that, and waits to be killed.
/// It does nothing unless the recovery test launched it.
#[tokio::test]
#[ignore = "child process of killed_ck_mc_during_a_rust_dream_recovers_without_a_duplicate_effect"]
async fn killed_process_runs_a_dream_until_it_is_killed() {
    let Ok(root) = std::env::var(KILL_ROOT) else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let p = Project::open(true, &["classify-memories"], Some(&root));
    p.declare().await;
    p.memories("ARCHITECTURE");
    p.due_in_typescript("classify-memories");
    let _job = p.start(None).expect("a run starts");
    serve_child(&p, Script::Hang).await;
    std::fs::write(root.join("child-started"), "started").unwrap();
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// ck-mc is killed (SIGKILL) while a Rust classify child runs. The restarted
/// process first finds the dead run's domain lease, then the child's restart
/// quarantine; neither starts work, consumes the slot or writes an effect. Past
/// the frozen horizon the old attempt is retired and the task runs once.
#[tokio::test]
async fn killed_ck_mc_during_a_rust_dream_recovers_without_a_duplicate_effect() {
    let base = std::env::temp_dir().join("magic-context/i5-stage-e");
    std::fs::create_dir_all(&base).unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            KILL_CHILD,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(KILL_ROOT, root.path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let started = root.path().join("child-started");
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !started.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "the child process never started its dream"
        );
        assert!(
            child.try_wait().unwrap().is_none(),
            "the child process exited"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    child.kill().unwrap();
    child.wait().unwrap();

    let p = Project::open(true, &["classify-memories"], Some(root.path()));
    let clock = Arc::new(Shifted(std::sync::atomic::AtomicI64::new(0)));
    p.handler.dream_runs.use_clock(clock.clone());
    p.declare().await;
    let classified = "SELECT COUNT(*) FROM memories WHERE classified_at IS NOT NULL";
    let due = format!(
        "SELECT next_due_at FROM task_schedule_state WHERE project_path='{}' AND task='classify-memories'",
        p.project
    );
    let slot = p.scalar(&due);

    // The dead run's domain lease has not expired: nothing is claimed.
    let report = join(p.start(None).unwrap())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        report,
        vec![(
            TaskName::Classify,
            DispatchOutcome::Refused("domain_busy".into())
        )]
    );
    // The lease expired, but the killed child may still run until its frozen
    // horizon: no new child is queued and the slot is given back.
    clock.0.store(3 * 60_000, Ordering::SeqCst);
    let report = join(p.start(None).unwrap())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(&report[..], [(TaskName::Classify, DispatchOutcome::Refused(e))]
            if e.starts_with("abandon:") && e.contains("dream_restart_quarantine_until")),
        "{report:?}"
    );
    assert_eq!(p.pending(), 0);
    assert_eq!(p.scalar(classified), 0);
    assert_eq!(p.scalar(&due), slot, "the quarantined slot stays due");
    assert_eq!(p.handler.dream_queue().retired_attempts(), 0);

    // Past the horizon the old attempt is retired and the task runs once.
    clock.0.store(40 * 60_000, Ordering::SeqCst);
    let job = p.start(None).unwrap();
    {
        let served = serve_child(&p, Script::Complete(classify_answer()));
        tokio::pin!(served);
        loop {
            tokio::select! {
                _ = &mut served => break,
                _ = tokio::time::sleep(Duration::from_millis(10)) => {
                    assert!(!job.is_finished(), "run ended before its child: {:?}", job.join());
                }
            }
        }
    }
    let report = join(job).await.unwrap().unwrap().unwrap();
    assert!(finished(&report, TaskName::Classify), "{report:?}");
    assert_eq!(p.handler.dream_queue().retired_attempts(), 1);
    assert_eq!(p.scalar(classified), 10);
    assert!(p.scalar(&due) > slot);
    // Domain released after the run: TypeScript could acquire it now.
    assert_eq!(
        p.scalar("SELECT COUNT(*) FROM dream_state WHERE key LIKE 'lease:memory:%:holder'"),
        0
    );
}
