use super::*;
use cortexkit_role_tool_provider::user_command;
use subc_protocol::scope::{ScopeAttributes, ScopeKind, ScopeStamp};

fn stamp() -> ScopeStamp {
    ScopeStamp::new(
        subc_protocol::Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "person-session",
        1,
        ScopeKind::Head,
    )
    .with_owner_authorized(true)
}
fn attest(rig: &Rig, scope: Option<ScopeStamp>) {
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.scope = scope;
    rig.h.bind_route(7, binding);
}
async fn invoke(rig: &Rig, key: &str, command: &str, input: &str) -> HandlerOutcome {
    rig.h.dispatch_value(7, json!({"name":"user_command.invoke","call_key":key,"arguments":{"command":command,"input":input}})).await
}
async fn pull(rig: &Rig) -> Value {
    response(
        rig.h
            .dispatch_value(7, json!({"name":"late_results","arguments":{"since":null}}))
            .await,
    )
}
async fn terminal(rig: &Rig) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let reply = pull(rig).await;
            if reply["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["kind"] == "result")
            {
                return reply;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("command settled")
}
fn refusal(outcome: HandlerOutcome) -> (String, Value) {
    match outcome {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => (code, detail),
        other => panic!("expected named refusal: {other:?}"),
    }
}
async fn ready(dir: &Path) -> Rig {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    rig.notice(1, 1000, None).await;
    // Finish the notice's historian evaluation before measuring command writes.
    tokio::time::timeout(Duration::from_secs(10), async {
        while rig
            .h
            .provider_store
            .async_runtime
            .historian_inflight
            .load(std::sync::atomic::Ordering::SeqCst)
            != 0
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("notice historian settled");
    attest(&rig, Some(stamp()));
    rig
}
fn pending_history(rig: &Rig) {
    rig.h
        .store
        .get()
        .unwrap()
        .replace_compartments(
            &rig.state().namespace(),
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 9,
                end_message_id: "m9#0".into(),
                title: "history".into(),
                content: "user-command history".into(),
                p1: Some("user-command history".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
}

#[tokio::test]
async fn person_admission_refuses_run_flow_and_unscoped_invokes() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    assert!(user_command::admitted(Some(&stamp())));
    for scope in [
        Some(
            stamp().with_attributes(
                ScopeAttributes::new()
                    .with_agent_id(Some("agent".into()))
                    .with_run_id(Some("run".into())),
            ),
        ),
        Some(stamp().with_attributes(ScopeAttributes::new().with_flow_id(Some("flow".into())))),
        None,
    ] {
        attest(&rig, scope);
        assert_eq!(
            refusal(invoke(&rig, "admit", "ctx-status", "").await).0,
            "user_command_not_admitted"
        );
    }
    attest(&rig, Some(stamp()));
    assert_eq!(
        response(invoke(&rig, "plain", "ctx-status", "").await)["state"],
        "done"
    );
}

#[tokio::test]
async fn declared_status_is_read_only_and_resolves_async_before_every_harness() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    rig.queue(&[103]).await;
    let store = rig.h.store.get().unwrap();
    let before = store.load_meta(&rig.state().namespace()).unwrap();
    for harness in ["runner", "opencode", "opencode2", "claude-code", "pi"] {
        let mut binding = rig.h.facade_binding(7).unwrap();
        binding.harness = harness.into();
        rig.h.bind_route(7, binding);
        let reply = response(invoke(&rig, harness, "ctx-status", " \t").await);
        assert_eq!(reply["state"], "done");
        let text = reply["text"].as_str().unwrap();
        for fact in [
            "1000 / 100000 estimated tokens (1.0%)",
            "Queued drops: 1",
            "Rebuild:",
            "Cache expiry: runner-owned",
            "History:",
        ] {
            assert!(text.contains(fact), "{text}");
        }
    }
    assert_eq!(
        store
            .load_meta(&rig.state().namespace())
            .unwrap()
            .row_version,
        before.row_version
    );
    assert_eq!(rig.pending_targets().len(), 1);
    assert_eq!(
        rig.resolver
            .calls
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

#[tokio::test]
async fn call_key_returns_first_reply_without_dispatching_changed_command() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    let first = response(invoke(&rig, "replay", "ctx-status", "").await);
    pending_history(&rig);
    let before = rig.newest();
    let replay = response(invoke(&rig, "replay", "ctx-flush", "").await);
    assert_eq!(replay, first);
    assert_eq!(rig.newest(), before);
    assert!(pull(&rig).await["entries"].as_array().unwrap().is_empty());
    let restarted = McHandler::new();
    restarted
        .store
        .set(Arc::clone(rig.h.store.get().unwrap()))
        .ok()
        .unwrap();
    restarted.bind_route(7, rig.h.facade_binding(7).unwrap());
    assert_eq!(response(restarted.dispatch_value(7, json!({"name":"user_command.invoke","call_key":"replay","arguments":{"command":"ctx-flush","input":""}})).await), first);
}

#[tokio::test]
async fn user_flush_publishes_once_under_shared_permission_and_nothing_when_idle() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    rig.queue(&[103]).await;
    let store = rig.h.store.get().unwrap();
    assert!(
        !store
            .load_meta(&rig.state().namespace())
            .unwrap()
            .meta
            .soft_refresh_pending
    );
    let before = rig.newest().unwrap_or(0);
    assert_eq!(
        response(invoke(&rig, "flush", "ctx-flush", "").await)["state"],
        "accepted"
    );
    let result = terminal(&rig).await;
    let final_reply = &result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "result")
        .unwrap()["result"];
    assert_eq!(final_reply["state"], "done", "{result}");
    assert_eq!(rig.newest(), Some(before + 1));
    assert!(rig.pending_targets().is_empty());
    let meta = store.load_meta(&rig.state().namespace()).unwrap().meta;
    assert!(!meta.soft_refresh_pending);
    let idle = response(invoke(&rig, "idle", "ctx-flush", "").await);
    assert_eq!(idle["state"], "done");
    assert!(idle["text"].as_str().unwrap().contains("Nothing to flush"));
    assert_eq!(rig.newest(), Some(before + 1));
}

#[tokio::test]
async fn flush_applies_pending_history_in_published_view() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    pending_history(&rig);
    let before = rig.newest().unwrap_or(0);
    assert_eq!(
        response(invoke(&rig, "history", "ctx-flush", "").await)["state"],
        "accepted"
    );
    let result = terminal(&rig).await;
    assert_eq!(
        result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["kind"] == "result")
            .unwrap()["result"]["state"],
        "done"
    );
    assert_eq!(rig.newest(), Some(before + 1));
    assert_eq!(
        rig.h
            .store
            .get()
            .unwrap()
            .load_meta(&rig.state().namespace())
            .unwrap()
            .meta
            .coverage_ordinal,
        Some(9)
    );
    let view = rig.get(before + 1).await;
    assert!(String::from_utf8(rig.render(&view))
        .unwrap()
        .contains("user-command history"));
}

#[tokio::test]
async fn long_command_reports_progress_then_one_result_and_acknowledges() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    rig.queue(&[103]).await;
    let reply = response(
        tokio::time::timeout(
            Duration::from_secs(5),
            invoke(&rig, "long", "ctx-flush", ""),
        )
        .await
        .expect("prompt command admission"),
    );
    assert_eq!(reply["state"], "accepted");
    assert!(reply["job"].as_str().unwrap().starts_with("ctx-flush-"));
    let held = rig.h.provider_serial.lock_for(&rig.state().key).await;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(6)).await;
        drop(held);
    })
    .await
    .unwrap();
    let late = terminal(&rig).await;
    let entries = late["entries"].as_array().unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["progress", "result"]
    );
    assert!(entries[0]["text"]
        .as_str()
        .unwrap()
        .contains("user-permitted"));
    assert_eq!(entries[1]["result"]["state"], "done");
    assert_eq!(response(invoke(&rig, "long", "ctx-flush", "").await), reply);
    assert_eq!(pull(&rig).await, late);
    assert_eq!(
        response(
            rig.h
                .dispatch_value(
                    7,
                    json!({"name":"late_results.ack","arguments":{"through":late["cursor"]}})
                )
                .await
        )["ok"],
        true
    );
    assert!(pull(&rig).await["entries"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn non_async_worker_unknown_and_bad_arguments_are_named_refusals() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    assert_eq!(
        refusal(invoke(&rig, "unknown", "ctx-dream", "").await),
        (
            "unknown_user_command".into(),
            json!({"command":"ctx-dream"})
        )
    );
    assert_eq!(
        refusal(invoke(&rig, "bad", "ctx-status", "extra").await).1["field"],
        "input"
    );
    attest(
        &rig,
        Some(ScopeStamp::new(
            stamp().owner,
            "worker",
            1,
            ScopeKind::Worker,
        )),
    );
    assert_eq!(
        refusal(invoke(&rig, "worker", "ctx-status", "").await).0,
        "no_person"
    );
    attest(&rig, Some(stamp()));
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.session = "not-compacting".into();
    rig.h.bind_route(7, binding);
    assert_eq!(
        refusal(invoke(&rig, "other", "ctx-status", "").await).0,
        "async_compaction_required"
    );
}
