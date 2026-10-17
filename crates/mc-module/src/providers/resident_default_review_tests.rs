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
        assert!(h.provider_resident.is_enabled(), "default configuration serves step transforms through the resident engine");
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
            // The persisted hygiene baseline is part of the default transcript;
            // drop only its wall-clock stamp, which differs between runs.
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

/// Residency is not a setting. A user config naming the removed
/// `rust_provider_resident` key, with any value, builds the same handler that
/// `main` builds (only the charged-memory cap is read from user config), and
/// that handler serves its folds through the resident engine. No shipped source
/// may read the removed key again.
#[tokio::test]
async fn config_value_cannot_select_the_non_resident_step_path() {
    let removed_key = concat!("rust_provider_", "resident");
    for value in ["false", "true", "0", "\"off\""] {
        let config_dir = tempfile::tempdir().unwrap();
        let path = config_dir.path().join("magic-context.jsonc");
        std::fs::write(&path, format!("{{\"{removed_key}\":{value}}}")).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (mut h, binding, store, key) = handler(dir.path(), Arc::new(NoReads::default()));
        h.provider_resident = McHandler::new()
            .with_startup_provider_resident_process_cap(
                crate::config::user_provider_resident_process_cap_at(&path),
            )
            .provider_resident
            .clone();
        assert!(h.provider_resident.is_enabled(), "{removed_key}={value}");
        seed(&h, &binding, &store).await;
        assert_eq!(
            h.provider_resident.session_stats(store.tag_cache_namespace(), &key)["ready"],
            json!(true),
            "{removed_key}={value}: the fold must publish a resident session"
        );
    }
    let quoted = format!("{removed_key}\"");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut pending = vec![root];
    let mut scanned = 0;
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.is_dir() {
                if name != "tests" {
                    pending.push(path);
                }
            } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") {
                scanned += 1;
                let source = std::fs::read_to_string(&path).unwrap();
                assert!(
                    !source.contains(&quoted),
                    "{} reads the removed {removed_key} key",
                    path.display()
                );
            }
        }
    }
    assert!(scanned > 50, "source census must cover the crate, scanned {scanned}");
}
