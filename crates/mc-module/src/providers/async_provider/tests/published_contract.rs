use super::*;

#[tokio::test]
async fn descending_setup_uses_kept_head_without_runner_calls() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(180);
    rig.history(130, "completed history");
    rig.notice(1, 90_000, None).await;
    let state = rig.state();
    let first = *state
        .published_cuts
        .keys()
        .next_back()
        .expect("published adoptable cut");
    let version = state.published_cuts[&first].version;
    let view = rig.get(version).await;
    assert_eq!(view.cut.as_ref().unwrap().through_ordinal, first - 1);
    let reads = rig
        .runner
        .routed_reads
        .load(std::sync::atomic::Ordering::Relaxed);
    let describes = rig
        .runner
        .describes
        .load(std::sync::atomic::Ordering::Relaxed);
    let mut request = serde_json::to_value(&state.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":first - 1});
    request["request_id"] = json!("descent");
    let answer = rig.op("compaction.setup", request.clone()).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(answer["initial"]["range"], json!({"from":first,"to":first}));
    assert!(!answer["initial"]["replacement"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(answer.get("checkpoint").is_none());
    assert_eq!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed),
        reads
    );
    assert_eq!(
        rig.runner
            .describes
            .load(std::sync::atomic::Ordering::Relaxed),
        describes
    );
    assert!(rig.state().entries.keys().all(|n| *n >= first));
    request["request_id"] = json!("retry");
    let retry = rig.op("compaction.setup", request).await;
    assert_eq!(retry["initial"], answer["initial"]);
}

#[tokio::test]
async fn unknown_cut_setup_is_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let mut request = serde_json::to_value(&rig.state().setup).unwrap();
    request["lineage_id"] = json!("unknown");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":999});
    for _ in 0..2 {
        let answer = rig.op("compaction.setup", request.clone()).await;
        let decoded: compact::setup::SetupAnswer = decode(&answer).unwrap();
        assert_eq!(answer["code"], "unknown_cut", "{answer}");
        assert_eq!(decoded.retryable(), Some(false));
    }
    assert_eq!(rig.state().lineage.as_deref(), Some("L"));
}

#[tokio::test]
async fn setup_ride_wait_is_capped_and_frozen() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.bind_shared_setup_route();
    for (session, cap, expected) in [
        ("short", Some(700), Some(700)),
        ("long", Some(90_000), Some(10_000)),
        ("absent", None, None),
    ] {
        let mut request = serde_json::to_value(&rig.state().setup).unwrap();
        request["session"] = json!(session);
        if let Some(cap) = cap {
            request["ride_wait_max_ms"] = json!(cap);
        }
        let answer = rig.op("compaction.setup", request.clone()).await;
        assert_eq!(answer["answer"], "ready", "{answer}");
        assert_eq!(answer["ride_wait_ms"].as_u64(), expected);
        request["ride_wait_max_ms"] = json!(1);
        assert_eq!(
            rig.op("compaction.setup", request).await["ride_wait_ms"].as_u64(),
            expected
        );
    }
}

#[tokio::test]
async fn model_change_answers_carry_cache_ttl_even_with_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let expected = json!({"model":"fixture","ms":300_000,"configured":false});
    assert_eq!(rig.state().initial["cache_ttl"], expected);
    let answer = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"model_change","deadline_ms":1000}),
        )
        .await;
    assert_eq!(answer["answer"], "nothing");
    assert_eq!(answer["cache_ttl"], expected);
    rig.fill(180);
    rig.history(130, "history");
    rig.notice(1, 90_000, None).await;
    let reads = rig
        .runner
        .routed_reads
        .load(std::sync::atomic::Ordering::Relaxed);
    let answer = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"model_change","deadline_ms":10_000}),
        )
        .await;
    assert_eq!(answer["cache_ttl"], expected);
    assert_eq!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed),
        reads
    );
    let view = rig.get(rig.newest().unwrap()).await;
    assert_eq!(serde_json::to_value(view.cache_ttl).unwrap(), expected);
}

#[tokio::test]
async fn folded_ctx_expand_reads_session_history_by_summary_mids() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1000, None).await;
    let mut state = rig.state();
    state.lineage_first_ordinal = 6;
    state.save(rig.h.store.get().unwrap(), &[]).unwrap();
    let mut summary = mc_store::StoredCompartment {
        start_message: 0,
        end_message: 5,
        start_message_id: "m0".into(),
        end_message_id: "m5#0".into(),
        ..Default::default()
    };
    let binding = rig.h.facade_binding(7).unwrap();
    let recovered = rig
        .h
        .async_history_expand(&binding, &state.namespace(), &[summary.clone()], 1, 4)
        .await
        .unwrap()
        .unwrap();
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    let expected = rig
        .runner
        .entries
        .lock()
        .unwrap()
        .iter()
        .filter(|entry| (1..=4).contains(&entry.ordinal))
        .map(|entry| {
            decoded_entry(
                codec,
                &InboundMessage {
                    ordinal: entry.ordinal,
                    mid: entry.mid.clone(),
                    message: entry.message.clone(),
                },
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        crate::render_durable_range_expand(1, 4, &recovered),
        crate::render_durable_range_expand(1, 4, &expected)
    );
    let calls = rig.runner.history_requests.lock().unwrap().clone();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0]["from_mid"], "m0");
    assert!(calls[0].get("from_ordinal").is_none());
    summary.start_message_id = "missing".into();
    let refusal = rig
        .h
        .async_history_expand(&binding, &state.namespace(), &[summary], 0, 4)
        .await
        .unwrap_err();
    assert!(matches!(refusal, HandlerOutcome::Error { code, .. } if code == "unknown_mid"));
}

#[test]
fn cache_policy_uses_mc_resolution_and_session_frozen_defaults() {
    let config = McModuleConfig {
        cache_ttl_by_model: BTreeMap::from([
            ("acme/m-1-x".into(), "never".into()),
            ("m-1".into(), "2m".into()),
            ("acme/*".into(), "3m".into()),
            ("default".into(), "4m".into()),
        ]),
        cache_ttl: "4m".into(),
        ..Default::default()
    };
    let policy = contract_policy::CachePolicy::freeze(&config);
    for (model, ms) in [
        ("acme/m-1-x", None),
        ("acme/m-1-y", Some(120_000)),
        ("acme/other", Some(180_000)),
        ("other/model", Some(240_000)),
    ] {
        assert_eq!(
            policy.resolve(model),
            compact::cache_ttl::CacheTtl::new(model, ms, true)
        );
    }
    let defaults = contract_policy::CachePolicy::freeze(&McModuleConfig::default());
    for (model, ms) in [
        ("openai/gpt-5.6", 1_800_000),
        ("gpt-5.7-mini", 1_800_000),
        ("openai/gpt-6-tiny", 1_800_000),
        ("gpt-5.5", 300_000),
        ("acme/model", 300_000),
    ] {
        assert_eq!(
            defaults.resolve(model),
            compact::cache_ttl::CacheTtl::new(model, Some(ms), false)
        );
    }
}
