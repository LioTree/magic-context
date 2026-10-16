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

fn admission_answer(outcome: HandlerOutcome, tags_on: bool, number: u64) -> Value {
    let answer = response(outcome);
    assert_admission_answer(&answer, tags_on, &[(0, number)]);
    answer
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
    for tags_on in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler_with_admission_tags(dir.path(), tags_on);
        setup(&h).await;
        admission_answer(
            call(
                &h,
                "transform.hook",
                hook(USER, "user", 0, "pre_user", &["read files"]),
            )
            .await,
            tags_on,
            1,
        );
        let assistant = if two_calls { TWO_CALLS } else { CALL };
        let result = if two_calls { TWO_RESULTS } else { RESULT };
        admission_answer(
            call(
                &h,
                "transform.hook",
                hook(assistant, "assistant", 1, "post_assistant", &["reading"]),
            )
            .await,
            tags_on,
            2,
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

        let h = handler_with_admission_tags(dir.path(), tags_on);
        declare(&h).await;
        let first_tool = admission_answer(
            call(&h, "transform.hook", post_tool(result, "call-a", "file a")).await,
            tags_on,
            3,
        );
        if two_calls {
            admission_answer(
                call(&h, "transform.hook", post_tool(result, "call-b", "file b")).await,
                tags_on,
                4,
            );
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
        let served_user = if tags_on {
            USER.replacen("read files", "§1§ read files", 1)
        } else {
            USER.into()
        };
        let served_assistant = if tags_on {
            assistant.replacen("reading", "§2§ reading", 1)
        } else {
            assistant.into()
        };
        let served_result = if tags_on {
            let result = result.replacen("file a", "§3§ file a", 1);
            if two_calls {
                result.replacen("file b", "§4§ file b", 1)
            } else {
                result
            }
        } else {
            result.into()
        };
        assert_stored_and_served_raw(&h, "user", USER, &served_user);
        assert_stored_and_served_raw(&h, "assistant", assistant, &served_assistant);
        assert_stored_and_served_raw(&h, "result", result, &served_result);
        assert!(store
            .load_provider_hook_answers(&key.store_key())
            .unwrap()
            .iter()
            .all(|answer| answer.state != "pending"));
        drop(h);
        let h = handler_with_admission_tags(dir.path(), tags_on);
        declare(&h).await;
        assert_eq!(
            admission_answer(
                call(&h, "transform.hook", post_tool(result, "call-a", "file a")).await,
                tags_on,
                3
            ),
            first_tool
        );
    }
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
    for tags_on in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler_with_admission_tags(dir.path(), tags_on);
        setup(&h).await;
        admission_answer(
            call(
                &h,
                "transform.hook",
                hook(USER, "user", 0, "pre_user", &["read files"]),
            )
            .await,
            tags_on,
            1,
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
        let served = if tags_on {
            USER.replacen("read files", "§1§ read files", 1)
        } else {
            USER.into()
        };
        assert_stored_and_served_raw(&h, "user", USER, &served);
    }
}

#[tokio::test]
async fn cc_burned_post_assistant_keeps_immutable_ingest_for_pairing() {
    for tags_on in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler_with_admission_tags(dir.path(), tags_on);
        setup(&h).await;
        admission_answer(
            call(
                &h,
                "transform.hook",
                hook(USER, "user", 0, "pre_user", &["read files"]),
            )
            .await,
            tags_on,
            1,
        );
        admission_answer(
            call(
                &h,
                "transform.hook",
                hook(CALL, "assistant", 1, "post_assistant", &["reading"]),
            )
            .await,
            tags_on,
            2,
        );
        let mut burn = hook(USER, "user", 0, "pre_user", &["read files"]);
        burn["unserved_subjects"] = json!([{"subject_mid":"assistant","hook":"post_assistant"}]);
        admission_answer(call(&h, "transform.hook", burn).await, tags_on, 1);
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        let answers = store.load_provider_hook_answers(&key.store_key()).unwrap();
        let assistant_answers = answers
            .iter()
            .filter(|answer| answer.answer.subject.hook == "post_assistant")
            .collect::<Vec<_>>();
        assert_eq!(assistant_answers.len(), 1);
        assert_eq!(assistant_answers[0].state, "burned");
        assert_stored_and_served_raw(&h, "assistant", CALL, CALL);
        assert_eq!(
            store
                .load_provider_messages(&key.store_key(), "L")
                .unwrap()
                .len(),
            2
        );
        drop(h);
        let h = handler_with_admission_tags(dir.path(), tags_on);
        declare(&h).await;
        admission_answer(
            call(&h, "transform.hook", post_tool(RESULT, "call-a", "file a")).await,
            tags_on,
            3,
        );
        let served = if tags_on {
            RESULT.replacen("file a", "§3§ file a", 1)
        } else {
            RESULT.into()
        };
        assert_stored_and_served_raw(&h, "result", RESULT, &served);
    }
}
