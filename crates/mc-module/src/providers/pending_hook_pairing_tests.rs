use super::*;

const USER: &str = r#"{ "role":"user", "content":"read files" }"#;
const CALL: &str = r#"{ "role":"assistant", "content":[{"type":"thinking","thinking":"private","signature":"signed"},{"type":"text","text":"reading"},{"type":"tool_use","id":"call-a","name":"Read","input":{"path":"a"}}] }"#;
const RESULT: &str = r#"{ "role":"user", "content":[{"type":"tool_result","tool_use_id":"call-a","content":"file a"}] }"#;
const TWO_CALLS: &str = r#"{ "role":"assistant", "content":[{"type":"thinking","thinking":"private","signature":"signed"},{"type":"text","text":"reading"},{"type":"tool_use","id":"call-a","name":"Read","input":{"path":"a"}},{"type":"tool_use","id":"call-b","name":"Read","input":{"path":"b"}}] }"#;
const TWO_RESULTS: &str = r#"{ "role":"user", "content":[{"type":"tool_result","tool_use_id":"call-a","content":"file a"},{"type":"tool_result","tool_use_id":"call-b","content":"file b"}] }"#;

fn hook(raw: &str, mid: &str, ordinal: u64, kind: &str, blocks: &[&str]) -> Value {
    json!({"session":"cc","harness":"claude-code","lineage_id":"L","step_id":"hook","params":plan(),
        "subject_mid":mid,"subject_ordinal":ordinal,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,"hook":kind,"blocks":blocks})
}

fn post_tool(raw: &str, part: &str, text: &str) -> Value {
    let mut params = hook(raw, "result", 2, "post_tool", &[text]);
    params["subject_part"] = json!(part);
    params["tool_call_id"] = json!(part);
    params["tool"] = json!("Read");
    params["is_error"] = json!(false);
    params
}

fn pass(outcome: HandlerOutcome) {
    let answer: hooks::answer::HookAnswer = serde_json::from_value(response(outcome)).unwrap();
    assert_eq!(answer, hooks::answer::HookAnswer::Pass);
}

async fn declare(h: &McHandler) {
    response(
        call(
            h,
            "transform.declare",
            json!({"session":"cc","harness":"claude-code","params":plan(),"preset":"head"}),
        )
        .await,
    );
}

async fn ordinary_turn(two_calls: bool) {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    pass(
        call(
            &h,
            "transform.hook",
            hook(USER, "user", 0, "pre_user", &["read files"]),
        )
        .await,
    );
    let assistant = if two_calls { TWO_CALLS } else { CALL };
    let result = if two_calls { TWO_RESULTS } else { RESULT };
    pass(
        call(
            &h,
            "transform.hook",
            hook(assistant, "assistant", 1, "post_assistant", &["reading"]),
        )
        .await,
    );
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    assert_eq!(
        h.store
            .get()
            .unwrap()
            .load_provider_messages(&key.store_key(), "L")
            .unwrap()
            .len(),
        2
    );
    drop(h);

    let h = handler(dir.path(), thalamus());
    declare(&h).await;
    pass(call(&h, "transform.hook", post_tool(result, "call-a", "file a")).await);
    if two_calls {
        pass(call(&h, "transform.hook", post_tool(result, "call-b", "file b")).await);
    }
    let mut status = step(USER);
    status["messages"] = json!([USER, assistant, result].iter().enumerate().map(|(ordinal, raw)| {
        json!({"mid":(["user","assistant","result"][ordinal]),"ordinal":ordinal,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw})
    }).collect::<Vec<_>>());
    status["newest"] = json!({"mid":"result","ordinal":2});
    status["served_through_ordinal"] = json!(2);
    let answer = native_step(&h, &status).await;
    assert!(
        matches!(
            answer["answer"].as_str(),
            Some("noop" | "compaction_message")
        ),
        "{answer}"
    );
    let store = h.store.get().unwrap();
    let held = store.load_provider_messages(&key.store_key(), "L").unwrap();
    assert_eq!(held.len(), 3);
    for (message, raw) in held.iter().zip([USER, assistant, result]) {
        assert_eq!(
            serde_json::from_slice::<Value>(&message.message_bytes).unwrap()["raw_message"],
            raw
        );
    }
    assert!(store
        .load_provider_hook_answers(&key.store_key())
        .unwrap()
        .iter()
        .all(|answer| answer.state != "pending"));
    drop(h);
    let h = handler(dir.path(), thalamus());
    declare(&h).await;
    pass(call(&h, "transform.hook", post_tool(result, "call-a", "file a")).await);
}

#[tokio::test]
async fn cc_pending_post_assistant_pairs_post_tool_after_restart_and_step() {
    ordinary_turn(false).await;
}

#[tokio::test]
async fn cc_pending_two_calls_pair_two_results_in_one_message() {
    ordinary_turn(true).await;
}

#[tokio::test]
async fn cc_missing_post_assistant_is_permanent_unpaired_tool_result() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    pass(
        call(
            &h,
            "transform.hook",
            hook(USER, "user", 0, "pre_user", &["read files"]),
        )
        .await,
    );
    for _ in 0..2 {
        assert_eq!(
            code(call(&h, "transform.hook", post_tool(RESULT, "call-a", "file a")).await),
            "unpaired_tool_result"
        );
    }
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    assert!(h
        .store
        .get()
        .unwrap()
        .load_provider_hook_answers(&key.store_key())
        .unwrap()
        .iter()
        .all(|answer| answer.answer.subject.hook == "pre_user"));
}

#[tokio::test]
async fn cc_burned_post_assistant_keeps_immutable_ingest_for_pairing() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    pass(
        call(
            &h,
            "transform.hook",
            hook(USER, "user", 0, "pre_user", &["read files"]),
        )
        .await,
    );
    pass(
        call(
            &h,
            "transform.hook",
            hook(CALL, "assistant", 1, "post_assistant", &["reading"]),
        )
        .await,
    );
    let mut burn = hook(USER, "user", 0, "pre_user", &["read files"]);
    burn["unserved_subjects"] = json!([{"subject_mid":"assistant","hook":"post_assistant"}]);
    pass(call(&h, "transform.hook", burn).await);
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    let answers = store.load_provider_hook_answers(&key.store_key()).unwrap();
    let assistant_answers = answers
        .iter()
        .filter(|answer| answer.answer.subject.hook == "post_assistant")
        .collect::<Vec<_>>();
    assert_eq!(assistant_answers.len(), 1);
    assert_eq!(assistant_answers[0].state, "burned");
    assert_eq!(
        store
            .load_provider_messages(&key.store_key(), "L")
            .unwrap()
            .len(),
        2
    );
    drop(h);
    let h = handler(dir.path(), thalamus());
    declare(&h).await;
    pass(call(&h, "transform.hook", post_tool(RESULT, "call-a", "file a")).await);
}
