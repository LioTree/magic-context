use super::*;

#[tokio::test]
async fn cc_expired_cache_endpoint_covers_rerendered_tail() {
    summary_with_tail(Some("expired_cache")).await;
}

#[tokio::test]
async fn cc_fold_endpoint_covers_rerendered_tail() {
    summary_with_tail(None).await;
}

#[tokio::test]
async fn cc_model_switch_endpoint_covers_rerendered_tail() {
    summary_with_tail(Some("pipeline_switch")).await;
}

async fn summary_with_tail(reason: Option<&str>) {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    native_setup_for_lineage(&h, "L", None).await;
    let entries = (0..11).map(|ordinal| {
        let role = if ordinal % 2 == 0 { "user" } else { "assistant" };
        let mut message = json!({"role":role,"content":[
            {"type":"text","text":format!("message {ordinal}")},
            {"type":"text","text":format!("last part {ordinal}")}
        ]});
        if ordinal == 9 {
            message["content"].as_array_mut().unwrap().insert(0, json!({"type":"thinking","thinking":"private tail reasoning","signature":"sig-tail"}));
        }
        let raw = message.to_string();
        json!({"mid":format!("m{ordinal}"),"ordinal":ordinal,"message":serde_json::from_str::<Value>(&raw).unwrap(),"raw_message":raw})
    }).collect::<Vec<_>>();
    let mut status = step(r#"{"role":"user","content":"unused"}"#);
    status["messages"] = json!(&entries[..9]);
    status["newest"] = json!({"mid":"m8","ordinal":8});
    let first = response(call(&h, "compaction.step", status.clone()).await);
    assert_eq!(first["compaction"]["range"], json!({"from":0,"to":1}));
    status["last_applied"] = json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    status["messages"] = json!(entries);
    status["newest"] = json!({"mid":"m10","ordinal":10});
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap();
    store
        .replace_compartments(
            &key.engine_key(),
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 8,
                end_message_id: "m8#1".into(),
                title: "history".into(),
                content: "summary through eight".into(),
                p1: Some("summary through eight".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    status["request_id"] = json!("summarized-step");
    if let Some(reason) = reason {
        status["prefix_rebuilding"] = json!({"reason":reason});
    } else {
        // Reach 65% of the 100,000-token window so pressure permits the fold.
        // The host supplies no timestamp from which to infer idle expiry.
        status["estimate"]["request_tokens"] = json!(65000);
    }
    if reason == Some("pipeline_switch") {
        status["model"] = json!("next-model");
    }
    let answer = response(call(&h, "compaction.step", status.clone()).await);
    assert_eq!(answer["answer"], "compaction_message", "{answer}");
    assert_eq!(answer["compaction"]["range"], json!({"from":0,"to":11}));
    assert_eq!(
        answer["coverage"],
        json!({"end_mid":"m10","ordinal":10,"endpoint":{"message_id":"m10","part_index":1}})
    );
    let frozen: compact::view::FrozenView =
        serde_json::from_value(answer["compaction"]["raw_view"].clone()).unwrap();
    assert_eq!(frozen.retained_tail, Some(vec![]));
    let bytes = native_read(&h, &frozen.view).await;
    assert!(bytes.contains("summary through eight"));
    assert!(!bytes.contains("sig-tail"));
    assert!(bytes.contains("message 9"));
    assert!(bytes.contains("last part 9"));
    assert!(bytes.contains(entries[10]["raw_message"].as_str().unwrap()));
    assert_eq!(
        native_read(&h, frozen.cut_replacement_ref.as_ref().unwrap()).await,
        bytes
    );
    let meta = store.load_meta(&key.engine_key()).unwrap().meta;
    assert_eq!(meta.coverage_ordinal, Some(8));
    assert_eq!(
        store.load(&key.engine_key()).unwrap().core.boundary_id,
        "m8#1"
    );
}
