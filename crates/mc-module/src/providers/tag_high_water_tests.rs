use super::*;

async fn setup_lineage(h: &McHandler, lineage: &str, descent: Option<Value>) {
    response(
        call(
            h,
            "transform.declare",
            json!({"session":"cc","harness":"claude-code","params":plan(),"preset":"head"}),
        )
        .await,
    );
    let mut request = json!({"session":"cc","harness":"claude-code","request_id":format!("setup-{lineage}"),"params":plan(),"preset":"head","model":"fixture","context_window":100000,"composition":{},"lineage_id":lineage,"now":1});
    if let Some(descent) = descent {
        request["descends_from"] = descent;
    }
    assert_eq!(
        response(call(h, "compaction.setup", request).await)["answer"],
        "ready"
    );
}

fn admission(lineage: &str, mid: &str, ordinal: u64, texts: &[&str]) -> Value {
    let assistant = ordinal % 2 == 1;
    let message = json!({
        "role": if assistant { "assistant" } else { "user" },
        "content": texts.iter().map(|text| json!({"type":"text","text":text})).collect::<Vec<_>>()
    });
    json!({"session":"cc","harness":"claude-code","lineage_id":lineage,"step_id":mid,"params":plan(),
        "subject_mid":mid,"subject_ordinal":ordinal,"message":message,"raw_message":message.to_string(),
        "hook":if assistant {"post_assistant"} else {"pre_user"},"blocks":texts})
}

async fn tagged(h: &McHandler, request: Value, numbers: &[u64]) {
    let answer = response(call(h, "transform.hook", request).await);
    assert_admission_answer(
        &answer,
        true,
        &numbers.iter().copied().enumerate().collect::<Vec<_>>(),
    );
}

fn recorded_hooks() -> Vec<Value> {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../testdata/compaction/cc-descent-four-hooks.json"
    ))
    .unwrap();
    fixture["hooks"].as_array().unwrap().clone()
}

async fn parent(h: &McHandler) {
    setup_lineage(h, "L", None).await;
    let mut messages = Vec::new();
    for ordinal in 0..=4 {
        let texts = if ordinal == 3 {
            vec!["a", "b"]
        } else {
            vec!["text"]
        };
        let request = admission("L", &format!("parent-{ordinal}"), ordinal, &texts);
        messages.push(json!({"mid":request["subject_mid"],"ordinal":ordinal,
            "message":request["message"],"raw_message":request["raw_message"]}));
        let first = ordinal + 1 + u64::from(ordinal > 3);
        let numbers = if ordinal == 3 {
            vec![4, 5]
        } else {
            vec![first]
        };
        tagged(h, request, &numbers).await;
    }
    let mut status = step(r#"{"role":"user","content":"text"}"#);
    status["lineage_id"] = json!("L");
    status["messages"] = json!(messages);
    status["newest"] = json!({"mid":"parent-4","ordinal":4});
    status["served_through_ordinal"] = json!(4);
    let produced = native_step(h, &status).await;
    assert_eq!(produced["answer"], "compaction_message", "{produced}");
    status["last_applied"] = json!({"compaction_id":produced["compaction"]["compaction_id"],"version":produced["compaction"]["version"]});
    status["request_id"] = json!("ack-parent");
    assert_eq!(native_step(h, &status).await["answer"], "noop");
    for hook in recorded_hooks().iter().take(2) {
        let actual = response(call(h, "transform.hook", hook["params"].clone()).await);
        assert_eq!(
            actual,
            serde_json::from_str::<Value>(hook["answer"].as_str().unwrap()).unwrap()
        );
    }
}

#[tokio::test]
async fn cc_descent_below_forwarded_tags_never_reuses_session_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler_with_admission_tags(dir.path(), true);
    parent(&h).await;
    setup_lineage(
        &h,
        "L2",
        Some(json!({"lineage_id":"L","through_ordinal":2})),
    )
    .await;
    for (hook, number) in recorded_hooks().iter().skip(2).zip([9, 10]) {
        tagged(&h, hook["params"].clone(), &[number]).await;
    }
}

fn assert_parent_suffix(h: &McHandler, state: &str) {
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let answers = h
        .store
        .get()
        .unwrap()
        .load_provider_hook_answers(&key.store_key())
        .unwrap();
    for number in [7, 8] {
        let answer = answers
            .iter()
            .find(|answer| answer.answer.tags.iter().any(|tag| tag.number == number))
            .unwrap();
        assert_eq!(answer.state, state, "tag {number}");
        assert_eq!(answer.lineage_id, "L");
    }
}

#[tokio::test]
async fn cc_descent_then_restart_and_redeclare_keeps_retired_pending_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler_with_admission_tags(dir.path(), true);
    parent(&h).await;
    assert_parent_suffix(&h, "pending");
    setup_lineage(
        &h,
        "L2",
        Some(json!({"lineage_id":"L","through_ordinal":2})),
    )
    .await;
    assert_parent_suffix(&h, "burned");
    drop(h);
    let h = handler_with_admission_tags(dir.path(), true);
    setup_lineage(&h, "L2", None).await;
    for (hook, number) in recorded_hooks().iter().skip(2).zip([9, 10]) {
        tagged(&h, hook["params"].clone(), &[number]).await;
    }
    assert_parent_suffix(&h, "burned");
}

#[tokio::test]
async fn cc_two_successive_descents_never_reissue_either_pending_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler_with_admission_tags(dir.path(), true);
    parent(&h).await;
    setup_lineage(
        &h,
        "L2",
        Some(json!({"lineage_id":"L","through_ordinal":2})),
    )
    .await;
    for (hook, number) in recorded_hooks().iter().skip(2).zip([9, 10]) {
        tagged(&h, hook["params"].clone(), &[number]).await;
    }
    setup_lineage(
        &h,
        "L3",
        Some(json!({"lineage_id":"L2","through_ordinal":2})),
    )
    .await;
    tagged(
        &h,
        admission("L3", "third-3", 3, &["third assistant"]),
        &[11],
    )
    .await;
    tagged(&h, admission("L3", "third-4", 4, &["third user"]), &[12]).await;
    assert_parent_suffix(&h, "burned");
}

#[tokio::test]
async fn cc_descent_below_promoted_served_numbers_leaves_them_served() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler_with_admission_tags(dir.path(), true);
    parent(&h).await;
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    let lineage = store
        .load_provider_lineage(&key.store_key(), "L")
        .unwrap()
        .unwrap();
    store
        .commit_provider_status(&key.store_key(), &lineage, &[], Some(6), &[])
        .unwrap();
    assert_parent_suffix(&h, "live");
    setup_lineage(
        &h,
        "L2",
        Some(json!({"lineage_id":"L","through_ordinal":2})),
    )
    .await;
    assert_parent_suffix(&h, "live");
    for (hook, number) in recorded_hooks().iter().skip(2).zip([9, 10]) {
        tagged(&h, hook["params"].clone(), &[number]).await;
    }
    assert_parent_suffix(&h, "live");
}

#[tokio::test]
async fn cc_pairing_only_pass_preserves_nonzero_high_water_after_descent() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler_with_admission_tags(dir.path(), true);
    parent(&h).await;
    setup_lineage(
        &h,
        "L2",
        Some(json!({"lineage_id":"L","through_ordinal":2})),
    )
    .await;
    let mut pairing = admission("L2", "already-served-assistant", 3, &["already served"]);
    pairing["served_through_ordinal"] = json!(3);
    assert_eq!(
        response(call(&h, "transform.hook", pairing).await),
        json!({"answer":"pass"})
    );
    tagged(&h, admission("L2", "next-user", 4, &["next user"]), &[9]).await;
}

#[tokio::test]
async fn cc_unrelated_setup_reset_never_reuses_pending_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler_with_admission_tags(dir.path(), true);
    parent(&h).await;
    setup_lineage(&h, "new-root", None).await;
    tagged(
        &h,
        admission("new-root", "new-root-user", 0, &["new root"]),
        &[9],
    )
    .await;
}
