//! The cortexkit/commons setup-descent vectors exercise the attested Claude Code route.
use super::*;
use crate::providers::claude_code_tests::{call, handler, thalamus};
use std::cell::Cell;

thread_local! {
    static HISTORY_CHECKS: Cell<u64> = const { Cell::new(0) };
}

pub(super) fn record_history_check() {
    HISTORY_CHECKS.with(|count| count.set(count.get() + 1));
}

fn plan() -> Value {
    json!({"serializer_profile":"claude-code-anthropic","observation":"answer"})
}

fn accepted(outcome: HandlerOutcome) -> Value {
    let HandlerOutcome::Response(bytes) = outcome else {
        panic!("{outcome:?}")
    };
    serde_json::from_slice(&bytes).unwrap()
}

fn lane_request(mut request: Value, method: &str) -> Value {
    // The upstream vectors use a generic OpenCode host. Only the route and native
    // ingress requirements change here; declarations and expected results do not.
    request["session"] = json!("cc");
    request["harness"] = json!("claude-code");
    request["params"] = plan();
    request["context_window"] = json!(100000);
    request["preset"] = json!("head");
    if method == "transform.hook" {
        let raw = r#"{"role":"user","content":"next"}"#;
        request["subject_mid"] = json!("next");
        request["subject_ordinal"] = json!(3);
        request["message"] = serde_json::from_str(raw).unwrap();
        request["raw_message"] = json!(raw);
    }
    request
}

async fn check_case(name: &str) {
    // The setup-descent vectors are copied byte-for-byte from cortexkit/commons
    // at commit 563e0984e2765710672220bbfecfb46a3b7f56c7.
    let vectors: Value =
        serde_json::from_str(include_str!("../../testdata/compaction/setup-descent.json")).unwrap();
    let cases = vectors["checks"].as_array().unwrap();
    assert_eq!(cases.len(), 13);
    let case = cases.iter().find(|case| case["name"] == name).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    accepted(
        call(
            &h,
            "transform.declare",
            json!({"session":"cc","harness":"claude-code","params":plan(),"preset":"head"}),
        )
        .await,
    );
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    for (parent, ordinals) in case["provider_state"]["parents"].as_object().unwrap() {
        let lineage = ProviderLineage {
            lineage_id: parent.clone(),
            first_ordinal: 0,
            descends_from: None,
            through_ordinal: None,
        };
        store
            .start_provider_root_lineage(&key.store_key(), &lineage)
            .unwrap();
        let messages = ordinals
            .as_array()
            .unwrap()
            .iter()
            .map(|ordinal| {
                let ordinal = ordinal.as_u64().unwrap();
                let raw = format!(r#"{{"role":"user","content":"parent {ordinal}"}}"#);
                let native: Value = serde_json::from_str(&raw).unwrap();
                let stored =
                    super::super::codec_claude_code::from_wire(&native, Some(&raw)).unwrap();
                ProviderMessage {
                    ordinal,
                    mid: format!("{parent}-{ordinal}"),
                    message_bytes: serde_json::to_vec(&stored).unwrap(),
                }
            })
            .collect::<Vec<_>>();
        store
            .commit_provider_status_page(
                &key.store_key(),
                mc_store::provider_records::ProviderStatusPage {
                    lineage: &lineage,
                    messages: &messages,
                    served: None,
                    unserved: &[],
                    newest: None,
                    more: true,
                },
            )
            .unwrap();
    }
    let saved = &case["provider_state"]["descends_from"];
    if !saved.is_null() {
        let parent: compact::status::DescendsFrom = serde_json::from_value(saved.clone()).unwrap();
        store
            .start_provider_descendant_lineage(
                &key.store_key(),
                &ProviderLineage {
                    lineage_id: "child".into(),
                    first_ordinal: parent.through_ordinal + 1,
                    descends_from: Some(parent.lineage_id),
                    through_ordinal: Some(parent.through_ordinal),
                },
            )
            .unwrap();
    }
    if case["calls"][0]["method"] != "compaction.setup" {
        accepted(call(&h, "compaction.setup", lane_request(json!({"request_id":"seed","lineage_id":"child","model":"m","composition":{},"now":0}), "compaction.setup")).await);
    }
    for (index, expected) in case["calls"].as_array().unwrap().iter().enumerate() {
        let method = expected["method"].as_str().unwrap();
        let before = store.load_provider_conversation(&key.store_key()).unwrap();
        HISTORY_CHECKS.with(|count| count.set(0));
        let outcome = call(
            &h,
            method,
            lane_request(expected["request"].clone(), method),
        )
        .await;
        if let Some(refusal) = expected.get("refusal") {
            let (code, field) = match outcome {
                HandlerOutcome::Response(bytes) => {
                    let answer: Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(answer["answer"], "refuse", "{name} call {index}");
                    (answer["code"].clone(), answer["detail"]["field"].clone())
                }
                HandlerOutcome::Error { code, .. } => (json!(code), Value::Null),
                HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
                    (json!(code), detail["field"].clone())
                }
                other => panic!("{name} call {index}: {other:?}"),
            };
            assert_eq!(code, refusal["code"], "{name} call {index}");
            assert_eq!(field, refusal["detail"]["field"], "{name} call {index}");
            assert_eq!(
                serde_json::to_value(store.load_provider_conversation(&key.store_key()).unwrap())
                    .unwrap(),
                serde_json::to_value(before).unwrap(),
                "{name}: refusal saved conversation state"
            );
        } else {
            let answer = accepted(outcome);
            assert!(
                matches!(
                    answer["answer"].as_str(),
                    Some("ready" | "noop" | "compaction_message" | "pass")
                ),
                "{name} call {index}: {answer}"
            );
        }
        HISTORY_CHECKS.with(|count| {
            assert_eq!(
                json!(count.get()),
                expected["history_checks"],
                "{name} call {index}: descent prefix checks"
            )
        });
        let row = store
            .load_provider_lineage(&key.store_key(), "child")
            .unwrap();
        let saved = row
            .as_ref()
            .and_then(|row| row.descends_from.as_ref().zip(row.through_ordinal))
            .map(|(parent, cut)| json!({"lineage_id":parent,"through_ordinal":cut}))
            .unwrap_or(Value::Null);
        assert_eq!(
            saved, expected["saved_descends_from"],
            "{name} call {index}"
        );
    }
}

macro_rules! vector_tests {
    ($($name:ident),+ $(,)?) => { $(
        #[tokio::test]
        async fn $name() { check_case(stringify!($name)).await; }
    )+ };
}

vector_tests!(
    setup_descent_parent_unknown,
    setup_descent_cut_not_held,
    setup_descent_prefix_gap,
    setup_descent_conflict_parent,
    setup_descent_conflict_cut,
    setup_descent_repeat_and_later_step_omits,
    step_only_descent,
    setup_and_step_agree,
    setup_and_step_conflict,
    hook_first_descent_and_repeat,
    step_conflicts_with_hook_descent,
    hook_conflicts_with_setup_descent,
    never_declared_stays_root,
);
