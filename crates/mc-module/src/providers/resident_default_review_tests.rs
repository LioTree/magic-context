use super::*;

fn remove_conversation_id(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if let Some(id) = object.get_mut("compaction_id") { *id = json!("independent-conversation"); }
            for value in object.values_mut() { remove_conversation_id(value); }
        }
        Value::Array(values) => for value in values { remove_conversation_id(value); },
        _ => {}
    }
}

#[tokio::test]
async fn review_default_config_transcript() {
    let mut transcript = Vec::new();
    for harness in ["opencode", "opencode2"] {
        let dir = tempfile::tempdir().unwrap();
        let (h, mut binding, store, _) = handler(dir.path(), Arc::new(NoReads::default()));
        assert!(!h.provider_resident.is_enabled(), "default configuration must keep residency off");
        binding.harness = harness.into();
        let key = Key::new(&binding, "s", harness).unwrap();
        let mut start = setup(); start["harness"] = json!(harness);
        transcript.push(answer(h.provider_setup(binding.clone(), &start).await));
        let mut boot = step("default-initial", (1..=30).map(message).collect(), 30);
        boot["harness"] = json!(harness);
        let mut view = answer(h.provider_step(binding.clone(), &boot).await);
        transcript.push(view.clone());
        let mut newest = 30;
        for pass in 0..24 {
            let mut rows = vec![mc_store::StoredCompartment {
                sequence: 1, start_message: 1, end_message: 20, end_message_id: "m20#0".into(),
                title: "default history".into(), content: format!("default body {pass}"),
                p1: Some(format!("default body {pass}")), importance: 50, ..Default::default()
            }];
            if pass == 13 { rows.clear(); }
            store.replace_compartments("s", &rows).unwrap();
            store.arm_soft_refresh("s").unwrap();
            let mut appended = Vec::new();
            if pass % 3 == 0 { newest += 1; appended.push(message(newest)); }
            if pass % 5 == 0 {
                let lineage = ProviderLineage { lineage_id: "L".into(), first_ordinal: 1, descends_from: None, through_ordinal: None };
                hook_answer(&store, &key, &lineage, &message(newest), "pre_user",
                    ("", json!([{"op":"append","block":0,"text":" default hook café 🦀"}]), &[0]));
                appended.clear();
            }
            let mut request = step(&format!("default-{pass}"), appended, newest);
            request["harness"] = json!(harness);
            request["served_through_ordinal"] = json!(newest);
            request["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
            if pass == 10 {
                request["model"] = json!("different-model");
                request["prefix_rebuilding"] = json!({"reason":"model_switch"});
            }
            let response = answer(h.provider_step(binding.clone(), &request).await);
            if response["answer"] == "compaction_message" { view = response.clone(); }
            transcript.push(response);
            // With the setting disabled, the persisted hygiene baseline must also
            // match the base build; drop only its wall-clock stamp, which differs
            // between runs.
            let mut baseline = serde_json::to_value(store.load("s").unwrap().meta.tail_hygiene_baseline).unwrap();
            if let Some(object) = baseline.as_object_mut() { object.remove("computed_at_ms"); }
            transcript.push(baseline);
        }
    }
    for value in &mut transcript { remove_conversation_id(value); }
    assert_eq!(transcript.len(), 100);
    if let Some(path) = std::env::var_os("MC_REVIEW_DEFAULT_OUTPUT") {
        std::fs::write(path, serde_json::to_vec(&transcript).unwrap()).unwrap();
    }
    println!("DEFAULT_REVIEW_RESPONSES={}", transcript.len());
}
