//! Hooks can precede the first declaration without committing an edited root.
use super::*;

const CALL: &str = r#"{ "role":"assistant", "content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"tool_use","id":"toolu_inherited","name":"Read","input":{"path":"x"}}] }"#;
const RESULT: &str = r#"{ "role" : "user", "content" : [{"type":"tool_result","tool_use_id":"toolu_inherited","content":"result"}] }"#;
const NEXT: &str = r#"{ "role" : "user", "content" : "next" }"#;

fn hook(raw: &str, mid: &str, ordinal: u64, kind: &str, blocks: &[&str]) -> Value {
    let mut hook = json!({"session":"cc","harness":"claude-code","lineage_id":"child","step_id":"hook","params":plan(),
        "subject_mid":mid,"subject_ordinal":ordinal,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,"hook":kind,"blocks":blocks});
    if kind == "post_tool" {
        hook["subject_part"] = json!("toolu_inherited");
        hook["tool"] = json!("Read");
        hook["tool_call_id"] = json!("toolu_inherited");
        hook["is_error"] = json!(false);
    }
    hook
}

fn pass_bytes(outcome: HandlerOutcome, raw: &str) -> Vec<u8> {
    let answer: hooks::answer::HookAnswer = serde_json::from_value(response(outcome)).unwrap();
    assert_eq!(answer, hooks::answer::HookAnswer::Pass);
    // A wire Pass serves the caller's native bytes without an edit or rendering.
    raw.as_bytes().to_vec()
}

async fn sequence(declare_on_hooks: bool) -> Vec<Vec<u8>> {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    native_setup_for_lineage(&h, "parent", None).await;
    let mut parent = step(CALL);
    parent["lineage_id"] = json!("parent");
    parent["messages"][0]["mid"] = json!("call");
    parent["newest"]["mid"] = json!("call");
    parent["more"] = json!(true);
    assert_eq!(native_step(&h, &parent).await["answer"], "wait");
    native_setup_for_lineage(&h, "parent", None).await;
    native_setup_for_lineage(&h, "parent", None).await;

    // Setup, pre_user, post_tool, then step reproduce the late-declaration order.
    let ready = native_setup_for_lineage(&h, "child", None).await;
    assert_eq!(ready["initial"]["version"], 4);
    assert_eq!(ready["initial"]["range"], json!({"from":0,"to":0}));
    let descent = json!({"lineage_id":"parent","through_ordinal":0});
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    let mut pre = hook(NEXT, "next", 2, "pre_user", &["next"]);
    let mut post = hook(RESULT, "result", 1, "post_tool", &["result"]);
    if declare_on_hooks {
        pre["descends_from"] = descent.clone();
        post["descends_from"] = descent.clone();
    }
    let served_pre = pass_bytes(call(&h, "transform.hook", pre).await, NEXT);
    if declare_on_hooks {
        assert_eq!(
            store
                .load_provider_lineage(&key.store_key(), "child")
                .unwrap()
                .unwrap()
                .descends_from
                .as_deref(),
            Some("parent")
        );
    }
    let outcome = call(&h, "transform.hook", post.clone()).await;
    let served_result = if declare_on_hooks {
        pass_bytes(outcome, RESULT)
    } else {
        assert_eq!(code(outcome), "unpaired_tool_result");
        let declared = declaration(&json!({"params":plan(),"preset":"head"})).unwrap();
        assert!(declared
            .subscriptions
            .iter()
            .any(|sub| sub.hook == hooks::subscription::Hook::PostTool
                && sub.on_unavailable == Some(hooks::subscription::OnUnavailable::Pass)));
        assert!(store
            .load_provider_hook_answers(&key.store_key())
            .unwrap()
            .iter()
            .filter(|answer| answer.lineage_id == "child")
            .all(|answer| answer.answer.subject.hook == "pre_user"));
        // The host's declared unavailable-pass fallback also serves the original
        // bytes. A transport error is not a durable hook answer or a served edit.
        RESULT.as_bytes().to_vec()
    };
    let mut status = step(RESULT);
    status["lineage_id"] = json!("child");
    status["request_id"] = json!("late-step");
    status["descends_from"] = descent;
    let mut result = status["messages"][0].clone();
    result["mid"] = json!("result");
    result["ordinal"] = json!(1);
    let mut next = step(NEXT)["messages"][0].clone();
    next["mid"] = json!("next");
    next["ordinal"] = json!(2);
    status["messages"] = json!([result, next]);
    status["newest"] = json!({"mid":"next","ordinal":2});
    status["last_applied"] = json!({"compaction_id":ready["initial"]["compaction_id"],"version":4});
    let answer = native_step(&h, &status).await;
    assert!(
        matches!(
            answer["answer"].as_str(),
            Some("noop" | "compaction_message")
        ),
        "{answer}"
    );
    let saved = store
        .load_provider_lineage(&key.store_key(), "child")
        .unwrap()
        .unwrap();
    assert_eq!(saved.descends_from.as_deref(), Some("parent"));
    assert_eq!(saved.through_ordinal, Some(0));
    // The same result now pairs with inherited history even without a repeated declaration.
    post.as_object_mut().unwrap().remove("descends_from");
    let later_result = pass_bytes(call(&h, "transform.hook", post).await, RESULT);
    assert_eq!(later_result, served_result);
    let held = store
        .load_provider_messages(&key.store_key(), "child")
        .unwrap();
    assert_eq!(held.len(), 3);
    for (message, raw) in held.iter().zip([CALL, RESULT, NEXT]) {
        let envelope: Value = serde_json::from_slice(&message.message_bytes).unwrap();
        assert_eq!(
            envelope["raw_message"].as_str().unwrap().as_bytes(),
            raw.as_bytes()
        );
    }
    vec![served_pre, served_result, later_result]
}

#[tokio::test]
async fn cc_every_hook_declares_descent_and_inherited_post_tool_passes() {
    let all_pass = sequence(true).await;
    assert_eq!(all_pass[1], RESULT.as_bytes());
}

#[tokio::test]
async fn cc_four_calls_late_descent_after_pass_and_orphan_fallback_match_all_pass_bytes() {
    let fallback = sequence(false).await;
    let all_pass = sequence(true).await;
    assert_eq!(fallback, all_pass);
}

#[tokio::test]
async fn cc_orphan_result_is_permanent_even_with_inherited_history_and_pass_unavailability() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    identity_parent_after_empty_fork(&h).await;
    native_setup_for_lineage(
        &h,
        "child",
        Some(json!({"lineage_id":"parent","through_ordinal":0})),
    )
    .await;
    let key = Key::new(
        &h.facade_binding(7).unwrap(),
        "fresh-provider-session",
        "claude-code",
    )
    .unwrap();
    let store = h.store.get().unwrap();
    let before = store
        .load_provider_hook_answers(&key.store_key())
        .unwrap()
        .len();
    let mut request = hook(RESULT, "orphan", 1, "post_tool", &["result"]);
    request["session"] = json!("fresh-provider-session");
    for _ in 0..2 {
        assert_eq!(
            code(call(&h, "transform.hook", request.clone()).await),
            "unpaired_tool_result"
        );
        assert_eq!(
            store
                .load_provider_hook_answers(&key.store_key())
                .unwrap()
                .len(),
            before
        );
    }
    let declared = declaration(&json!({"params":plan(),"preset":"head"})).unwrap();
    let post_tool = declared
        .subscriptions
        .iter()
        .find(|sub| sub.hook == hooks::subscription::Hook::PostTool)
        .expect("post_tool subscription");
    assert_eq!(
        post_tool.on_unavailable,
        Some(hooks::subscription::OnUnavailable::Pass)
    );
}
