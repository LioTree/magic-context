//! Process-death recovery at each provider commit boundary, using the real executable.
use super::{compaction::ViewRunner, harness::*, *};
use subc_client_rs::{CallError, ConsumerOptions, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};
use tokio::task::JoinHandle;

type Pending = JoinHandle<Result<Vec<u8>, CallError>>;

async fn begin(rig: &Rig, identity: &BindIdentity, method: &str, params: Value) -> Pending {
    let caller = SubcConsumer::connect(&rig.connection, ConsumerOptions::default())
        .await
        .unwrap();
    let identity = identity.clone();
    let body = serde_json::to_vec(&json!({"method":method,"params":params})).unwrap();
    tokio::spawn(async move {
        let result = caller
            .call(
                RouteTarget::ToolProvider {
                    module_id: "magic-context".into(),
                },
                identity,
                body,
                options(),
            )
            .await;
        caller.close().await;
        result
    })
}

async fn reached_before_answer(rig: &Rig, pending: &mut Pending, point: &str) {
    tokio::select! {
        _ = rig.wait_fault(point) => {},
        response = pending => panic!("{point} answered before its kill cut: {response:?}; {}",rig.stderr()),
    }
}

async fn kill_wait(rig: &mut Rig, pending: Pending, recorded: &Value) {
    rig.module.take();
    // The crash marker parks a background task, so Wait may still be queued
    // for socket delivery when we kill the module. A delivered reply must match
    // committed JSON; an undelivered call may fail. Each case then restarts and
    // checks that its waiting state survives either delivery outcome.
    if let Ok(bytes) = pending.await.unwrap() {
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), *recorded);
    }
}

fn assert_cursor(record: &Value, expected: &[Value]) {
    let messages = record["messages"][LINEAGE]
        .as_object()
        .expect("persisted lineage cursor");
    assert_eq!(messages.len(), expected.len());
    for message in expected {
        let ordinal = message["ordinal"].as_u64().unwrap().to_string();
        assert_eq!(
            messages.get(&ordinal),
            Some(message),
            "changed or missing ordinal {ordinal}"
        );
    }
}

fn assert_stale(answer: Value, view: &Value, transcript: &[Value], latest: &str) {
    let mut runner = ViewRunner::new(view.clone(), transcript.to_vec());
    runner.newest_request = latest.into();
    let before = runner.prompt();
    assert_eq!(
        runner.accept(serde_json::from_value(answer).unwrap()),
        "superseded_request"
    );
    assert_eq!(
        runner.prompt(),
        before,
        "a stale caller changed the served view"
    );
}

async fn ready_callback(rig: &Rig, request: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if rig.script.callbacks().iter().any(|call| {
                call.request["method"] == "compaction.ready"
                    && call.request["params"]["request_id"] == request
            }) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("ready callback must follow durable wait work");
}

fn waiting(session: &str, request: &str, transcript: &[Value], initial: &Value) -> Value {
    let mut status = step(session, request, transcript, 70_000, initial);
    status["messages"] = json!([transcript[0]]);
    status["prefix_rebuilding"] = json!({"reason":"flush"});
    status
}

async fn acknowledge(
    rig: &Rig,
    identity: &BindIdentity,
    session: &str,
    transcript: &[Value],
    view: &Value,
) {
    let answer = rig
        .method(
            identity,
            "compaction.step",
            step(session, "acknowledged", transcript, 1000, view),
        )
        .await;
    assert_eq!(
        answer["answer"], "noop",
        "an applied recovered view must not be duplicated: {answer}"
    );
    assert_eq!(
        rig.record(session)["setup"]["state"]["last_applied"]["version"],
        view["version"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn setup_recorded_survives_process_death() {
    let mut rig = Rig::start(Some("SetupRecorded"), false).await;
    let identity = rig.identity(SESSION);
    let mut pending = begin(&rig, &identity, "compaction.setup", setup(SESSION)).await;
    reached_before_answer(&rig, &mut pending, "SetupRecorded").await;
    let cut = rig.record(SESSION);
    assert!(
        cut["setup"].is_object(),
        "SetupRecorded lost the Setup inputs"
    );
    assert_eq!(cut["setup"]["request"]["request_id"], "setup");
    assert_eq!(cut["setup"]["state"]["version_high_water"], 0);
    assert!(cut["setup"]["state"]["last_produced"].is_null());
    assert!(cut["last_answer"].is_null());
    rig.module.take();
    assert!(
        pending.await.unwrap().is_err(),
        "the killed setup must not deliver an answer"
    );
    rig.spawn(None);
    rig.wait_ready().await;
    let mut request = setup(SESSION);
    request["request_id"] = json!("setup-retry");
    let ready = rig
        .method(&identity, "compaction.setup", request.clone())
        .await;
    assert_eq!(
        ready["initial"]["compaction_id"],
        cut["setup"]["state"]["compaction_id"]
    );
    assert_eq!(ready["request_id"], "setup-retry");
    assert!(ready["initial"]["version"].as_u64().unwrap() > 0);
    let saved = rig.record(SESSION);
    assert_eq!(
        saved["setup"]["request"], cut["setup"]["request"],
        "restart replaced persisted Setup inputs"
    );
    let repeated = rig.method(&identity, "compaction.setup", request).await;
    assert!(
        repeated["initial"]["version"].as_u64().unwrap()
            > ready["initial"]["version"].as_u64().unwrap()
    );
    assert_eq!(
        repeated["initial"]["replacement"],
        ready["initial"]["replacement"]
    );
    assert_stale(
        json!({"answer":"compaction_message","request_id":"setup","compaction":ready["initial"]}),
        &repeated["initial"],
        &[],
        "setup-retry",
    );
    acknowledge(&rig, &identity, SESSION, &[], &repeated["initial"]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn messages_ingested_survive_process_death() {
    let mut rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    let ready = rig
        .method(&identity, "compaction.setup", setup(SESSION))
        .await;
    let transcript = vec![
        user(0, "cut message zero"),
        user(1, "cut message one"),
        user(2, "cut message two"),
    ];
    rig.script.transcript(transcript.clone());
    rig.publish_history(SESSION);
    rig.module.take();
    rig.spawn(Some("MessagesIngested"));
    rig.wait_ready().await;
    let mut status = step(
        SESSION,
        "messages-crashed",
        &transcript,
        70_000,
        &ready["initial"],
    );
    status["prefix_rebuilding"] = json!({"reason":"flush"});
    let mut pending = begin(&rig, &identity, "compaction.step", status.clone()).await;
    reached_before_answer(&rig, &mut pending, "MessagesIngested").await;
    let cut = rig.record(SESSION);
    assert_cursor(&cut, &transcript);
    assert_eq!(
        cut["setup"]["state"]["version_high_water"],
        ready["initial"]["version"]
    );
    rig.module.take();
    assert!(pending.await.unwrap().is_err());
    rig.spawn(None);
    rig.wait_ready().await;
    status["request_id"] = json!("messages-retry");
    status["messages"] = json!([]);
    let recovered = rig.method(&identity, "compaction.step", status).await;
    assert_eq!(
        recovered["answer"], "compaction_message",
        "persisted cursor should need no transcript refetch: {recovered}"
    );
    assert_eq!(recovered["compaction"]["range"], json!({"from":0,"to":3}));
    assert!(
        recovered["compaction"]["version"].as_u64().unwrap()
            > ready["initial"]["version"].as_u64().unwrap()
    );
    assert_cursor(&rig.record(SESSION), &transcript);
    assert!(
        rig.script.callbacks().is_empty(),
        "restart lost the ingested cursor and refetched it"
    );
    assert_stale(
        json!({"answer":"compaction_message","request_id":"messages-crashed","compaction":ready["initial"]}),
        &recovered["compaction"],
        &transcript,
        "messages-retry",
    );
    acknowledge(
        &rig,
        &identity,
        SESSION,
        &transcript,
        &recovered["compaction"],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_answered_survives_process_death() {
    let mut rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    let ready = rig
        .method(&identity, "compaction.setup", setup(SESSION))
        .await;
    let transcript = vec![
        user(0, "wait prefix"),
        user(1, "wait page one"),
        user(2, "wait page two"),
    ];
    rig.script.transcript(transcript.clone());
    rig.publish_history(SESSION);
    *rig.script.page_size.lock().unwrap() = 1;
    rig.module.take();
    rig.spawn(Some("WaitAnswered"));
    rig.wait_ready().await;
    let request = waiting(SESSION, "wait-old", &transcript, &ready["initial"]);
    let pending = begin(&rig, &identity, "compaction.step", request.clone()).await;
    rig.wait_fault("WaitAnswered").await;
    let cut = rig.record(SESSION);
    let old_wait = cut["last_answer"].clone();
    assert_eq!(old_wait["answer"], "wait");
    assert_eq!(
        cut["wait_request"], "wait-old",
        "WaitAnswered lost the active request fence"
    );
    assert_eq!(cut["last_answer"], old_wait);
    assert_cursor(&cut, &transcript[..1]);
    assert_eq!(
        cut["setup"]["state"]["version_high_water"],
        ready["initial"]["version"]
    );
    assert!(
        rig.script.callbacks().is_empty(),
        "wait work ran before its selected cut"
    );
    kill_wait(&mut rig, pending, &old_wait).await;
    rig.spawn(None);
    rig.wait_ready().await;
    let mut request = request;
    request["request_id"] = json!("wait-new");
    request["messages"] = json!([]);
    let new_wait = rig
        .method(&identity, "compaction.step", request.clone())
        .await;
    assert_eq!(new_wait["answer"], "wait");
    ready_callback(&rig, "wait-new").await;
    assert!(
        !rig.script
            .callbacks()
            .iter()
            .any(|call| call.request["method"] == "compaction.ready"
                && call.request["params"]["request_id"] == "wait-old"),
        "dead wait caller received a ready callback"
    );
    let durable = rig.record(SESSION);
    assert_cursor(&durable, &transcript);
    assert!(durable["wait_request"].is_null());
    assert!(durable["wait_view"].is_object());
    assert_eq!(
        durable["wait_view"]["version"],
        durable["setup"]["state"]["version_high_water"]
    );
    assert!(
        rig.script
            .callbacks()
            .iter()
            .any(|call| call.request["method"] == "session.read"
                && call.request["params"]["from_ordinal"] == 1),
        "restarted wait did not resume at its persisted cursor"
    );
    assert_stale(old_wait, &ready["initial"], &transcript, "wait-new");
    request["request_id"] = json!("after-ready");
    request.as_object_mut().unwrap().remove("prefix_rebuilding");
    let recovered = rig.method(&identity, "compaction.step", request).await;
    assert_eq!(recovered["answer"], "compaction_message");
    assert!(
        recovered["compaction"]["version"].as_u64().unwrap()
            > durable["wait_view"]["version"].as_u64().unwrap(),
        "reused an allocated wait-work version"
    );
    acknowledge(
        &rig,
        &identity,
        SESSION,
        &transcript,
        &recovered["compaction"],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_work_durable_survives_process_death() {
    let mut rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    let ready = rig
        .method(&identity, "compaction.setup", setup(SESSION))
        .await;
    let transcript = vec![
        user(0, "durable prefix"),
        user(1, "durable page one"),
        user(2, "durable page two"),
    ];
    rig.script.transcript(transcript.clone());
    rig.publish_history(SESSION);
    *rig.script.page_size.lock().unwrap() = 1;
    rig.module.take();
    rig.spawn(Some("WaitWorkDurable"));
    rig.wait_ready().await;
    let mut request = waiting(SESSION, "work-old", &transcript, &ready["initial"]);
    let pending = begin(&rig, &identity, "compaction.step", request.clone()).await;
    rig.wait_fault("WaitWorkDurable").await;
    let cut = rig.record(SESSION);
    let old_wait = cut["last_answer"].clone();
    assert_eq!(old_wait["answer"], "wait");
    assert_cursor(&cut, &transcript);
    assert!(cut["wait_request"].is_null());
    assert!(
        cut["wait_view"].is_object(),
        "WaitWorkDurable lost the produced view"
    );
    assert_eq!(
        cut["wait_view"]["version"],
        cut["setup"]["state"]["version_high_water"]
    );
    assert_eq!(cut["wait_view"], cut["setup"]["state"]["last_produced"]);
    assert!(
        cut["wait_view"]["version"].as_u64().unwrap()
            > ready["initial"]["version"].as_u64().unwrap()
    );
    assert!(
        !rig.script
            .callbacks()
            .iter()
            .any(|call| call.request["method"] == "compaction.ready"),
        "ready preceded durable-work kill cut"
    );
    kill_wait(&mut rig, pending, &old_wait).await;
    rig.spawn(None);
    rig.wait_ready().await;
    let reads = rig
        .script
        .callbacks()
        .iter()
        .filter(|call| call.request["method"] == "session.read")
        .count();
    request["request_id"] = json!("work-retry");
    request["messages"] = json!([]);
    request.as_object_mut().unwrap().remove("prefix_rebuilding");
    let recovered = rig.method(&identity, "compaction.step", request).await;
    assert_eq!(
        recovered["answer"], "compaction_message",
        "restart discarded completed wait work: {recovered}"
    );
    assert!(
        recovered["compaction"]["version"].as_u64().unwrap()
            > cut["wait_view"]["version"].as_u64().unwrap()
    );
    assert_eq!(
        recovered["compaction"]["compaction_id"],
        cut["wait_view"]["compaction_id"]
    );
    assert_eq!(recovered["compaction"]["range"], json!({"from":0,"to":3}));
    assert_eq!(
        rig.script
            .callbacks()
            .iter()
            .filter(|call| call.request["method"] == "session.read")
            .count(),
        reads,
        "restart refetched already durable pages"
    );
    assert_cursor(&rig.record(SESSION), &transcript);
    assert_stale(
        old_wait,
        &recovered["compaction"],
        &transcript,
        "work-retry",
    );
    acknowledge(
        &rig,
        &identity,
        SESSION,
        &transcript,
        &recovered["compaction"],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hook_state_recorded_survives_process_death() {
    let mut rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    let ready = rig
        .method(&identity, "compaction.setup", setup(SESSION))
        .await;
    let mut transcript = vec![
        user(0, "hook prefix"),
        message(
            1,
            "assistant",
            json!([{"type":"tool_call","tool_call_id":"cut-call","tool_name":"read","input":{"path":"a"}}]),
        ),
    ];
    rig.script.transcript(transcript.clone());
    rig.module.take();
    rig.spawn(Some("HookStateRecorded"));
    rig.wait_ready().await;
    let hook = json!({"session":SESSION,"harness":"broca","lineage_id":LINEAGE,"hook":"post_tool","step_id":"tool-cut","tool":"read","tool_call_id":"cut-call","blocks":["cut tool output"],"is_error":false,"params":{"reminder_every":1}});
    let mut pending = begin(&rig, &identity, "transform.hook", hook.clone()).await;
    reached_before_answer(&rig, &mut pending, "HookStateRecorded").await;
    let cut = rig.record(SESSION);
    assert_eq!(
        cut["hook"]["high_water"], 1,
        "HookStateRecorded lost the reserved tag number"
    );
    assert_eq!(cut["hook"]["answers"][0]["tags"], json!([1]));
    assert_eq!(cut["hook"]["answers"][0]["observed"], false);
    assert_eq!(
        cut["setup"]["state"]["version_high_water"],
        ready["initial"]["version"]
    );
    assert_cursor(&cut, &transcript);
    let prefix = cut["messages"][LINEAGE].clone();
    rig.module.take();
    assert!(
        pending.await.unwrap().is_err(),
        "the killed hook must not deliver ops"
    );
    rig.spawn(None);
    rig.wait_ready().await;
    assert_eq!(rig.record(SESSION)["messages"][LINEAGE], prefix);
    let retry = rig.method(&identity, "transform.hook", hook).await;
    let transform::answer::HookAnswer::Ops { ops } = serde_json::from_value(retry).unwrap() else {
        panic!("expected a new tool tag");
    };
    let rendered = transform::answer::apply_ops(&["cut tool output".into()], &ops).unwrap();
    assert!(
        rendered[0].starts_with("§2§ "),
        "restart reused the lost answer's tag: {rendered:?}"
    );
    let record = rig.record(SESSION);
    assert_eq!(record["hook"]["high_water"], 2);
    assert!(
        record["hook"]["burned"]
            .as_array()
            .unwrap()
            .contains(&json!(1)),
        "superseded hook tag was not fenced"
    );
    transcript.push(message(2,"tool",json!([{"type":"tool_result","tool_call_id":"cut-call","output":{"kind":"text","text":rendered[0]},"is_error":false}])));
    rig.script.transcript(transcript.clone());
    let mut observe = super::hooks::pre_user(SESSION);
    observe["lineage_id"] = json!(LINEAGE);
    rig.method(&identity, "transform.hook", observe).await;
    let observed = rig.record(SESSION);
    assert_cursor(&observed, &transcript);
    assert!(
        observed["hook"]["live"].get("2").is_some(),
        "the delivered tag was not observed"
    );
    assert!(
        observed["hook"]["live"].get("1").is_none(),
        "the lost hook tag became live"
    );
    assert_eq!(
        rig.store()
            .load_tags_for_session(&rig.engine_key(SESSION))
            .unwrap()
            .iter()
            .map(|tag| tag.tag_number)
            .collect::<Vec<_>>(),
        vec![2]
    );
    rig.module.take();
    rig.spawn(None);
    rig.wait_ready().await;
    assert_eq!(rig.record(SESSION)["hook"]["high_water"], 2);
    assert_cursor(&rig.record(SESSION), &transcript);
}
