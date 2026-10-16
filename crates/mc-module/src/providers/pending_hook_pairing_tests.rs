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

#[tokio::test]
async fn cc_first_managed_bulk_arcs_pair_and_retire_unserved_assistants() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler_with_admission_tags(dir.path(), true);
    setup(&h).await;
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let assistants = [
        r#"{"role":"assistant","content":[{"type":"text","text":"old zero"},{"type":"tool_use","id":"call-a","name":"Read","input":{}}]}"#,
        r#"{"role":"assistant","content":[{"type":"text","text":"held"},{"type":"thinking","thinking":"private","signature":"signed"},{"type":"text","text":"old one"},{"type":"tool_use","id":"call-a","name":"Read","input":{}}]}"#,
        r#"{"role":"assistant","content":[{"type":"text","text":"newest"},{"type":"tool_use","id":"call-a","name":"Read","input":{}}]}"#,
    ];
    for (arc, raw) in assistants.iter().enumerate() {
        let mid = format!("a{arc}");
        let text = ["old zero", "old one", "newest"][arc];
        let blocks = if arc == 1 {
            vec!["held", text]
        } else {
            vec![text]
        };
        let answer = response(
            call(
                &h,
                "transform.hook",
                hook(raw, &mid, (arc * 2) as u64, "post_assistant", &blocks),
            )
            .await,
        );
        assert_admission_answer(
            &answer,
            true,
            &[(if arc == 1 { 1 } else { 0 }, [1, 4, 6][arc])],
        );
        let mut tool = post_tool(RESULT, "call-a", "file a");
        tool["subject_mid"] = json!(format!("r{arc}"));
        tool["subject_ordinal"] = json!(arc * 2 + 1);
        if arc < 2 {
            tool["unserved_subjects"] = json!([{"subject_mid":mid,"hook":"post_assistant"}]);
        }
        admission_answer(call(&h, "transform.hook", tool).await, true, [2, 5, 7][arc]);
        assert_stored_and_served_raw(
            &h,
            &mid,
            raw,
            &if arc < 2 {
                raw.to_string()
            } else {
                raw.replacen(text, &format!("§{}§ {text}", [1, 4, 6][arc]), 1)
            },
        );
        assert_stored_and_served_raw(
            &h,
            &format!("r{arc}"),
            RESULT,
            &RESULT.replacen("file a", &format!("§{}§ file a", [2, 5, 7][arc]), 1),
        );
    }
    let store = h.store.get().unwrap();
    let burned = store
        .load_provider_hook_answers(&key.store_key())
        .unwrap()
        .into_iter()
        .filter(|a| a.state == "burned")
        .collect::<Vec<_>>();
    assert_eq!(burned.len(), 2);
    assert_eq!(
        burned
            .iter()
            .flat_map(|a| a.answer.tags.iter().map(|t| t.number))
            .collect::<Vec<_>>(),
        [1, 4]
    );
    for (arc, raw) in assistants.iter().take(2).enumerate() {
        let blocks = if arc == 1 {
            vec!["held", "old one"]
        } else {
            vec!["old zero"]
        };
        let mut retry = hook(
            raw,
            &format!("a{arc}"),
            (arc * 2) as u64,
            "post_assistant",
            &blocks,
        );
        retry["served_through_ordinal"] = json!(5);
        assert_eq!(
            response(call(&h, "transform.hook", retry).await),
            json!({"answer":"pass"})
        );
    }
    let counters: Value = serde_json::from_str(
        &store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap()
            .hook_counters_json,
    )
    .unwrap();
    assert_eq!(counters["reserved_tag_high_water"], 7);
}

#[tokio::test]
async fn cc_assistant_watermarks_pass_without_reserving_and_keep_pairing() {
    for held_watermark in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler_with_admission_tags(dir.path(), true);
        setup(&h).await;
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        if held_watermark {
            let mut held = h
                .store
                .get()
                .unwrap()
                .load_provider_conversation(&key.store_key())
                .unwrap()
                .unwrap();
            held.served_through_ordinal = Some(0);
            h.store
                .get()
                .unwrap()
                .save_provider_conversation(&key.store_key(), &held)
                .unwrap();
        }
        let mut params = hook(CALL, "assistant", 0, "post_assistant", &["reading"]);
        if !held_watermark {
            params["served_through_ordinal"] = json!(0);
        }
        assert_eq!(
            response(call(&h, "transform.hook", params).await),
            json!({"answer":"pass"})
        );
        assert_stored_and_served_raw(&h, "assistant", CALL, CALL);
        let counters: Value = serde_json::from_str(
            &h.store
                .get()
                .unwrap()
                .load_provider_conversation(&key.store_key())
                .unwrap()
                .unwrap()
                .hook_counters_json,
        )
        .unwrap();
        assert_eq!(counters["reserved_tag_high_water"], 0);
        let mut result = post_tool(RESULT, "call-a", "file a");
        result["subject_ordinal"] = json!(1);
        admission_answer(call(&h, "transform.hook", result).await, true, 1);
        assert_stored_and_served_raw(
            &h,
            "result",
            RESULT,
            &RESULT.replacen("file a", "§1§ file a", 1),
        );
    }
}

#[tokio::test]
async fn cc_fork_assistant_cut_and_parent_mid_pass_but_new_reply_tags() {
    for retained_assistant in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler_with_admission_tags(dir.path(), true);
        setup(&h).await;
        let parent_user = hook(USER, "user", 0, "pre_user", &["read files"]);
        admission_answer(call(&h, "transform.hook", parent_user).await, true, 1);
        assert_stored_and_served_raw(
            &h,
            "user",
            USER,
            &USER.replacen("read files", "§1§ read files", 1),
        );
        admission_answer(
            call(
                &h,
                "transform.hook",
                hook(CALL, "assistant", 1, "post_assistant", &["reading"]),
            )
            .await,
            true,
            2,
        );
        assert_stored_and_served_raw(
            &h,
            "assistant",
            CALL,
            &CALL.replacen("reading", "§2§ reading", 1),
        );
        let cut = if retained_assistant { 1 } else { 0 };
        response(call(&h, "compaction.setup", json!({
            "session":"cc","harness":"claude-code","request_id":"fork","params":plan(),
            "preset":"head","model":"fixture","context_window":100000,"composition":{},
            "lineage_id":"child","descends_from":{"lineage_id":"L","through_ordinal":cut},"now":3
        })).await);
        let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        let high = || -> Value {
            let c: Value = serde_json::from_str(
                &store
                    .load_provider_conversation(&key.store_key())
                    .unwrap()
                    .unwrap()
                    .hook_counters_json,
            )
            .unwrap();
            c["reserved_tag_high_water"].clone()
        };
        let before = high();
        let mut old = hook(CALL, "assistant", 1, "post_assistant", &["reading"]);
        old["lineage_id"] = json!("child");
        assert_eq!(
            response(call(&h, "transform.hook", old).await),
            json!({"answer":"pass"})
        );
        assert_eq!(high(), before);
        let mut new = hook(CALL, "new-assistant", 2, "post_assistant", &["reading"]);
        new["lineage_id"] = json!("child");
        let answer = response(call(&h, "transform.hook", new).await);
        assert_admission_answer(&answer, true, &[(0, 3)]);
        assert_stored_and_served_raw_in_lineage(
            &h,
            "child",
            "new-assistant",
            CALL,
            &CALL.replacen("reading", "§3§ reading", 1),
        );
    }
}
