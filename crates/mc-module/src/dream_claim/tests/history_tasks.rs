//! Retrospective and primer runs end to end: a real handler and store, the
//! production executor, tick and Host carrier, and the scripted dream-claim-v1
//! claimant of `tick`. Neither task is in `OPERATIONAL_TASKS`, so these tests
//! wire them explicitly; with the production wiring neither is ever published.

use super::tick::{finished, join, serve_child, Project, Script, PLUGIN};
use super::*;
use crate::dream_dispatch::dispatcher::{DispatchOutcome, OPERATIONAL_TASKS};
use crate::dream_dispatch::ownership::Wiring;
use crate::dream_dispatch::tick::ManualRun;
use mc_store::dream_scheduler::schedules::RunStatus;
use rusqlite::params;
use serde_json::{json, Value};

const DAY_MS: i64 = crate::dream_tasks::primers::DAY_MS;

fn wired(extra: &[TaskName]) -> Wiring {
    let mut tasks = OPERATIONAL_TASKS.to_vec();
    tasks.extend_from_slice(extra);
    Wiring {
        tasks,
        broca: false,
    }
}

/// Archive one OpenCode session's messages for the project, as an ingesting
/// bridge would: session-to-project row, activity time and raw messages.
fn archive(p: &Project, session: &str, messages: &[(&str, &str, i64, Value)]) {
    p.handler
        .store
        .get()
        .unwrap()
        .with_context_conn_for_test(|tx| {
            crate::dream_dispatch::session_reader::install_archive_for_test(tx)?;
            tx.execute(
                "INSERT OR IGNORE INTO session_projects(session_id,harness,project_path,updated_at) VALUES(?1,'opencode',?2,0)",
                params![session, p.project],
            )?;
            let mut ordinal: i64 = tx.query_row(
                "SELECT COALESCE(MAX(message_ordinal),0) FROM raw_archive_messages WHERE session_id=?1",
                [session],
                |r| r.get(0),
            )?;
            for (id, role, ts, parts) in messages {
                ordinal += 1;
                let message = json!({"id": id, "role": role, "parts": parts, "ordinal": ordinal,
                    "createdAt": ts, "completedAt": null, "version": null});
                crate::dream_dispatch::session_reader::archive_for_test(tx, session, &message)?;
                tx.execute(
                    "INSERT INTO schema_migrations_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![format!("retrospective_activity:{session}"), ts.to_string()],
                )?;
            }
            Ok(())
        })
        .unwrap();
}

fn text(t: &str) -> Value {
    json!([{"type": "text", "text": t}])
}

fn history(p: &Project, at: i64) {
    archive(
        p,
        "ses-a",
        &[
            (
                "a1",
                "user",
                at,
                text("Please run the focused tests before you report the change as done."),
            ),
            (
                "a2",
                "assistant",
                at + 1_000,
                json!([{"type": "text", "text": "Done."}, {"type": "tool", "tool": "bash", "state": {"status": "completed", "output": "ok"}}]),
            ),
            (
                "a3",
                "user",
                at + 2_000,
                text("You skipped the tests again; run the focused tests before reporting done."),
            ),
        ],
    );
}

const GATE: &str = "y: 3";
const LEARNINGS: &str = r#"<learnings><learning route="memory" category="PROJECT_RULES">Run the focused test suite and report its result before calling a change done.</learning><learning route="observation">Prefers explicit verification evidence in completion summaries.</learning></learnings>"#;

fn effects(p: &Project) -> (i64, i64, i64, i64) {
    (
        p.scalar(&format!("SELECT COUNT(*) FROM memories WHERE project_path='{}' AND source_type='dreamer' AND metadata_json='{{\"source\":\"retrospective\"}}'", p.project)),
        p.scalar("SELECT COUNT(*) FROM user_memory_candidates WHERE session_id='ses-a'"),
        p.scalar("SELECT COUNT(*) FROM retrospective_processed_windows"),
        p.scalar(&format!("SELECT COALESCE(MAX(retrospective_watermark_ms),0) FROM task_schedule_state WHERE project_path='{}' AND task='retrospective'", p.project)),
    )
}

#[tokio::test]
async fn a_retrospective_runs_over_archived_history_and_commits_its_window_once() {
    let p = Project::open_wired(
        true,
        &["retrospective", "review-user-memories"],
        None,
        Some(wired(&[TaskName::Retrospective])),
    );
    let published = p.declare().await;
    assert!(
        published["published"]
            .as_array()
            .unwrap()
            .contains(&json!("retrospective")),
        "{published}"
    );
    let at = crate::now_ms() - 10 * 60_000;
    history(&p, at);
    let due = p.due_in_typescript("retrospective");
    let job = p.start(None).expect("a run starts");
    serve_child(&p, Script::Complete(GATE.into())).await;
    serve_child(&p, Script::Complete(LEARNINGS.into())).await;
    let report = join(job).await.unwrap().unwrap().unwrap();
    assert!(finished(&report, TaskName::Retrospective), "{report:?}");
    // One memory, one observation, the processed window and the watermark at
    // the newest message, all from one commit.
    assert_eq!(effects(&p), (1, 1, 1, at + 2_000));
    assert_eq!(
        p.scalar("SELECT COUNT(*) FROM memory_journal WHERE operation='agent_save'"),
        1
    );
    assert!(
        p.scalar(&format!(
            "SELECT next_due_at FROM task_schedule_state WHERE project_path='{}' AND task='retrospective'",
            p.project
        )) > due
    );
    // The same period runs nothing more.
    let again = join(p.start(None).unwrap())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(again.is_empty(), "{again:?}");
    assert_eq!(effects(&p), (1, 1, 1, at + 2_000));
    assert_eq!(p.pending(), 0);
}

/// The hard rule for publication: retrospective stays with TypeScript in this
/// build, whatever the claimant can carry and whether or not Rust can see any of
/// the project's sessions. It must never be published for a project whose
/// history the module cannot read.
#[tokio::test]
async fn retrospective_and_primers_are_never_published_by_the_production_wiring() {
    let p = Project::open(
        true,
        &["retrospective", "promote-primers", "refresh-primers"],
        None,
    );
    for with_history in [false, true] {
        if with_history {
            history(&p, crate::now_ms() - 60_000);
        }
        let published = p.declare().await;
        let names: Vec<&str> = published["published"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for task in ["retrospective", "promote-primers", "refresh-primers"] {
            assert!(!names.contains(&task), "{task} published: {published}");
            assert!(
                published["withheld"]
                    .as_array()
                    .unwrap()
                    .contains(&json!({"task": task, "reason": "host_unwired"})),
                "{published}"
            );
        }
        // The plugin route reads the same list, so TypeScript keeps running them.
        assert_eq!(
            p.call(PLUGIN, json!({"method": "dream.ownership"})).await["published"],
            published["published"]
        );
        let refused = p
            .call(
                PLUGIN,
                json!({"method": "dream.run", "task": "retrospective", "command_id": format!("c-{with_history}")}),
            )
            .await;
        assert_eq!(refused["refusal"], "not_published", "{refused}");
    }
}

/// Real time shifted by an adjustable offset, so a restarted process can look
/// past the dead process's leases and its child's frozen retirement horizon.
struct Shifted(std::sync::atomic::AtomicI64);

impl Clock for Shifted {
    fn now_ms(&self) -> i64 {
        crate::now_ms() + self.0.load(Ordering::SeqCst)
    }
}

const KILL_ROOT: &str = "MC_I5F1_KILLED_RETROSPECTIVE_ROOT";
const KILL_CHILD: &str =
    "dream_claim::tests::history_tasks::killed_process_runs_a_retrospective_until_it_is_killed";

/// The process the recovery test kills: it starts a Rust retrospective, lets the
/// claimant answer the gate child, open and start the deepen child, announces
/// that, and waits to be killed. It does nothing unless the recovery test
/// launched it.
#[tokio::test]
#[ignore = "child process of killed_ck_mc_during_a_retrospective_recovers_without_a_duplicate_effect"]
async fn killed_process_runs_a_retrospective_until_it_is_killed() {
    let Ok(root) = std::env::var(KILL_ROOT) else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let p = Project::open_wired(
        true,
        &["retrospective", "review-user-memories"],
        Some(&root),
        Some(wired(&[TaskName::Retrospective])),
    );
    p.declare().await;
    let at: i64 = std::fs::read_to_string(root.join("history-at"))
        .unwrap()
        .parse()
        .unwrap();
    history(&p, at);
    p.due_in_typescript("retrospective");
    let _job = p.start(None).expect("a run starts");
    serve_child(&p, Script::Complete(GATE.into())).await;
    serve_child(&p, Script::Hang).await;
    std::fs::write(root.join("child-started"), "started").unwrap();
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// ck-mc is killed (SIGKILL) after the retrospective gate answered and while its
/// deepen child runs, before any effect was committed. The restarted process
/// first finds the dead run's domain lease, then the child's restart quarantine;
/// neither starts work or writes. Past the frozen horizon the run starts over and
/// commits its memory, observation, processed window and watermark exactly once;
/// a later run in the same period adds nothing.
#[tokio::test]
async fn killed_ck_mc_during_a_retrospective_recovers_without_a_duplicate_effect() {
    let base = std::env::temp_dir().join("magic-context/i5-stage-f1");
    std::fs::create_dir_all(&base).unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    let at = crate::now_ms() - 10 * 60_000;
    std::fs::write(root.path().join("history-at"), at.to_string()).unwrap();
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
            "the child process never started its retrospective"
        );
        assert!(
            child.try_wait().unwrap().is_none(),
            "the child process exited"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    child.kill().unwrap();
    child.wait().unwrap();

    let p = Project::open_wired(
        true,
        &["retrospective", "review-user-memories"],
        Some(root.path()),
        Some(wired(&[TaskName::Retrospective])),
    );
    let clock = Arc::new(Shifted(std::sync::atomic::AtomicI64::new(0)));
    p.handler.dream_runs.use_clock(clock.clone());
    p.declare().await;
    let due = format!(
        "SELECT next_due_at FROM task_schedule_state WHERE project_path='{}' AND task='retrospective'",
        p.project
    );
    let slot = p.scalar(&due);
    // The killed run committed nothing: its effects and frontier commit together.
    assert_eq!(effects(&p), (0, 0, 0, 0));

    // The review-user-memories schedule (which turns observation collection on)
    // also comes due; only the retrospective entries matter here.
    let retrospective = |report: crate::dream_dispatch::tick::RunReport| {
        report
            .into_iter()
            .filter(|(task, _)| *task == TaskName::Retrospective)
            .collect::<Vec<_>>()
    };
    let report = join(p.start(None).unwrap())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        retrospective(report),
        vec![(
            TaskName::Retrospective,
            DispatchOutcome::Refused("domain_busy".into())
        )]
    );
    clock.0.store(3 * 60_000, Ordering::SeqCst);
    let report = retrospective(
        join(p.start(None).unwrap())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    );
    assert!(
        matches!(&report[..], [(TaskName::Retrospective, DispatchOutcome::Refused(e))]
            if e.starts_with("abandon:") && e.contains("dream_restart_quarantine_until")),
        "{report:?}"
    );
    assert_eq!(p.pending(), 0);
    assert_eq!(effects(&p), (0, 0, 0, 0));
    assert_eq!(p.scalar(&due), slot, "the quarantined slot stays due");

    clock.0.store(40 * 60_000, Ordering::SeqCst);
    let job = p.start(None).unwrap();
    serve_child(&p, Script::Complete(GATE.into())).await;
    serve_child(&p, Script::Complete(LEARNINGS.into())).await;
    let report = join(job).await.unwrap().unwrap().unwrap();
    assert!(finished(&report, TaskName::Retrospective), "{report:?}");
    assert_eq!(p.handler.dream_queue().retired_attempts(), 1);
    assert_eq!(effects(&p), (1, 1, 1, at + 2_000));
    assert!(p.scalar(&due) > slot);
    // A forced rerun reads nothing new and commits nothing again.
    let job = p
        .start(Some(ManualRun {
            task: TaskName::Retrospective,
            command_id: "after-recovery".into(),
        }))
        .unwrap();
    let report = join(job).await.unwrap().unwrap().unwrap();
    assert!(finished(&report, TaskName::Retrospective), "{report:?}");
    assert_eq!(effects(&p), (1, 1, 1, at + 2_000));
    assert_eq!(p.pending(), 0);
}

/// Primer candidates as the historian records them: two clusters of three with
/// support spread over eight days, so both clear the promotion rules.
fn primer_candidates(p: &Project, now: i64) {
    p.exec(&{
        let mut sql = String::new();
        for id in 1..=6 {
            let question = if id <= 3 {
                "How does routing work"
            } else {
                "Second subsystem"
            };
            let day = 12 - ((id - 1) % 3) * 4;
            sql.push_str(&format!(
                "INSERT INTO primer_candidates(id,project_path,harness,session_id,question,normalized_question,source_compartment_start,source_compartment_end,source_start_message_id,source_end_message_id,source_message_time,created_at) VALUES ({id},'{}','opencode','source-{id}','{question}','{}',1,3,'m{id}','m{id}',{},1);",
                p.project,
                question.to_lowercase(),
                now - day * DAY_MS
            ));
        }
        sql
    });
}

#[tokio::test]
async fn primer_promotion_and_refresh_run_through_rust_when_wired() {
    let p = Project::open_wired(
        true,
        &["promote-primers", "refresh-primers"],
        None,
        Some(wired(&[TaskName::PromotePrimers, TaskName::RefreshPrimers])),
    );
    let published = p.declare().await;
    for task in ["promote-primers", "refresh-primers"] {
        assert!(
            published["published"]
                .as_array()
                .unwrap()
                .contains(&json!(task)),
            "{published}"
        );
    }
    primer_candidates(&p, crate::now_ms());
    // Promotion asks no model; refresh opens one investigator child per primer.
    let job = p
        .start(Some(ManualRun {
            task: TaskName::PromotePrimers,
            command_id: "promote".into(),
        }))
        .unwrap();
    let report = join(job).await.unwrap().unwrap().unwrap();
    assert!(finished(&report, TaskName::PromotePrimers), "{report:?}");
    assert_eq!(p.pending(), 0);
    // Without a module-side embedder the clusters come from the normalized
    // question text, as in the TypeScript dreamer when embedding fails.
    assert_eq!(
        p.scalar(&format!("SELECT COUNT(*) FROM primers WHERE project_path='{}' AND total_support=3 AND question_embedding IS NULL AND answer=''", p.project)),
        2
    );
    assert_eq!(
        p.scalar("SELECT COUNT(*) FROM primer_candidates WHERE question_embedding IS NOT NULL"),
        0
    );

    let job = p
        .start(Some(ManualRun {
            task: TaskName::RefreshPrimers,
            command_id: "refresh".into(),
        }))
        .unwrap();
    for _ in 0..2 {
        serve_child(
            &p,
            Script::Complete(json!({"answer": "Routing is dispatched by lib.rs."}).to_string()),
        )
        .await;
    }
    let report = join(job).await.unwrap().unwrap().unwrap();
    assert!(
        report.iter().any(|(t, o)| *t == TaskName::RefreshPrimers
            && *o == DispatchOutcome::Finished(RunStatus::Completed)),
        "{report:?}"
    );
    // The investigator's read tools run inside the host, so Rust sees no
    // investigation tool call and, like the TypeScript grounding gate for a
    // transcript without tool calls, keeps the current answer.
    assert_eq!(
        p.scalar(
            "SELECT COUNT(*) FROM primers WHERE answer<>'' OR answer_refreshed_at IS NOT NULL"
        ),
        0
    );
    assert_eq!(p.pending(), 0);
}
