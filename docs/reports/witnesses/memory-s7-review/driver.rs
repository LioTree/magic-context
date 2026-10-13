// run.py injects this into historian::tests only when MC_S7_REVIEW=1.
fn s7_store(dir: &std::path::Path, ts_owned: bool) -> McStore {
    let store = store(dir);
    store.install_context_domain(std::sync::Arc::new(
        crate::single_store_reads::ModuleContextDomain::open(&dir.join("context.db")).unwrap(),
    ));
    store.with_context_conn_for_test(|conn| {
        conn.execute("INSERT INTO compartment_history_versions(session_id,generation,version,rewrite_version,seeded) VALUES ('ses','review-fixed-generation',0,0,0)", [])?;
        if ts_owned {
            conn.execute("INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES ('git:other','review',1)", [])?;
        }
        Ok(())
    }).unwrap();
    seed_prior_compartment(&store);
    store
}

fn s7_counts(store: &McStore) -> Vec<i64> {
    store
        .with_context_conn_for_test(|conn| {
            [
                "memory_publications",
                "memory_stage_attempts",
                "memory_activity_ledger",
                "memory_pending_facts",
                "memories",
                "memory_tool_proposals",
            ]
            .iter()
            .map(|table| conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)))
            .collect()
        })
        .unwrap()
}

fn s7_xml(content: &str, facts: bool) -> String {
    let xml = historian_xml(content);
    if facts {
        xml.replace("<meta>", "<facts><ARCHITECTURE>* [at_compartment=1] Keep a deterministic review fact.</ARCHITECTURE></facts><meta>")
    } else {
        xml
    }
}

fn s7_rng(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

#[tokio::test]
async fn s7_review_snapshot_randomized_driver_runs() {
    let mut rng = 0x7337_d1ff_2026_1012;
    for index in 0..96 {
        let bits = s7_rng(&mut rng);
        let scenario = (bits % 6) as usize;
        let dir = tempfile::tempdir().unwrap();
        let store = s7_store(dir.path(), bits & 8 != 0);
        let chunk = historian_chunk();
        let prior = prior_ranges();
        let models = vec!["test/first".to_string(), "test/second".to_string()];
        let prompt = format!("review input {bits:x}");
        let mut request = fire_request(&store, &prompt, &models, &chunk, &prior);
        request.validate_options.memory_enabled = bits & 16 != 0;
        request.validate_options.auto_promote = bits & 32 != 0;
        let mut producer = ScriptedProducer::default();
        match scenario {
            0 => {
                producer = producer
                    .with_start(Ok(run_handle("r1")))
                    .with_output(Ok(producer_output(s7_xml(&prompt, bits & 64 != 0))));
            }
            1 => {
                for _ in 0..2 {
                    producer = producer.with_start(Err(HistorianProducerError::Subc(
                        crate::historian_producer::ProducerErrorBody::untagged(
                            "open_failed",
                            "run resolution failed: unknown model 'review'",
                        ),
                    )));
                }
            }
            2 => {
                producer = producer
                    .with_start(Ok(run_handle("r1")))
                    .with_output(Err(HistorianProducerError::TimedOut))
                    .with_output(Err(HistorianProducerError::TimedOut))
                    .with_start(Ok(run_handle("r2")))
                    .with_output(Ok(producer_output(s7_xml(&prompt, false))));
            }
            3 => {
                for id in ["r1", "r2"] {
                    producer =
                        producer
                            .with_start(Ok(run_handle(id)))
                            .with_output(Ok(ProducerOutput {
                                text: s7_xml(&prompt, true),
                                length_capped: true,
                                usage: None,
                            }));
                }
            }
            4 => {
                for id in ["r1", "r2"] {
                    producer = producer
                        .with_start(Ok(run_handle(id)))
                        .with_output(Ok(producer_output("not a historian document".into())));
                }
            }
            _ => {
                producer = producer
                    .with_start(Err(HistorianProducerError::retryable_model_failure(
                        "review transient",
                    )))
                    .with_start(Ok(run_handle("r2")))
                    .with_output(Ok(producer_output(s7_xml(&prompt, true))));
            }
        }
        let result = run_historian_firing(&mut producer, request).await;
        let snapshot = serde_json::json!({
            "result": format!("{result:?}"),
            "state": store.load_meta("ses").unwrap().meta.historian,
            "compartments": store.load_compartments("ses").unwrap(),
            "starts": producer.observed_starts,
            "sessions": producer.observed_sessions,
            "prompts": producer.observed_prompts,
            "cancels": producer.cancels,
            "closes": producer.closes,
            "counts": s7_counts(&store),
            "scenario": scenario,
            "memory_enabled": bits & 16 != 0,
            "auto_promote": bits & 32 != 0,
            "ts_owned": bits & 8 != 0,
        });
        println!("S7_SNAPSHOT driver-{index} {snapshot}");
    }
}

#[tokio::test]
async fn s7_review_snapshot_crash_before_ack() {
    let dir = tempfile::tempdir().unwrap();
    let store = s7_store(dir.path(), false);
    seed_test_selected_range_identities(&store);
    let state = fire(
        &store.load_meta("ses").unwrap().meta.historian,
        2,
        4,
        "fp".into(),
        test_selected_range_identities(),
        0,
        store
            .load_historian_assembly_snapshot("ses")
            .unwrap()
            .compartment_set_generation,
        123,
        None,
    )
    .unwrap();
    let FireOutcome::Fired(state) = state else {
        panic!("must fire")
    };
    persist_historian_state(&store, "ses", state.clone()).unwrap();
    #[cfg(mc_s7_head)]
    crate::historian_stage::HistorianStage::turn_one("git:proj", "ses", &state)
        .persist(
            &store,
            "ses",
            "opencode",
            "broca",
            Some("retained-child"),
            &serde_json::json!({"system":"s","prompt":"p","model":"test/first"}),
            123,
        )
        .unwrap();
    let action = handle_restart_load(&store, "ses", 124, 999).unwrap();
    println!(
        "S7_SNAPSHOT crash-before-ack {}",
        serde_json::json!({
            "action": format!("{action:?}"), "state": store.load_meta("ses").unwrap().meta.historian,
            "counts": s7_counts(&store)
        })
    );
}

#[cfg(mc_s7_head)]
#[tokio::test]
async fn s7_review_witness_dormant_publish_has_no_new_rows() {
    assert!(!crate::historian_stage::RUST_LIFECYCLE_ENABLED);
    let dir = tempfile::tempdir().unwrap();
    let store = s7_store(dir.path(), false);
    let chunk = historian_chunk();
    let prior = prior_ranges();
    let models = vec!["test/first".into()];
    let mut producer = ScriptedProducer::default()
        .with_start(Ok(run_handle("r1")))
        .with_output(Ok(producer_output(s7_xml("a normal fold", false))));
    run_historian_firing(
        &mut producer,
        fire_request(&store, "p", &models, &chunk, &prior),
    )
    .await
    .unwrap();
    assert_eq!(
        s7_counts(&store),
        vec![1, 0, 1, 0, 0, 0],
        "dormant Rust keeps publication/activity bookkeeping and its accepted no-stage divergence from TypeScript"
    );
}

#[cfg(mc_s7_head)]
#[tokio::test]
async fn s7_review_witness_disabled_memory_does_not_queue_facts() {
    for ts_owned in [false, true] {
    for auto_promote in [false, true] {
    let dir = tempfile::tempdir().unwrap();
    let store = s7_store(dir.path(), ts_owned);
    let chunk = historian_chunk();
    let prior = prior_ranges();
    let models = vec!["test/first".into()];
    let mut request = fire_request(&store, "p", &models, &chunk, &prior);
    request.validate_options.memory_enabled = false;
    request.validate_options.auto_promote = auto_promote;
    let mut producer = ScriptedProducer::default()
        .with_start(Ok(run_handle("r1")))
        .with_output(Ok(producer_output(s7_xml("a normal fold", true))));
    run_historian_firing(&mut producer, request).await.unwrap();
    assert_eq!(
        s7_counts(&store)[3],
        0,
        "memory.enabled=false still persisted a provider-emitted fact"
    );
    assert_eq!(s7_counts(&store)[4], 0, "disabled memory wrote an authoritative row");
    }
    }
}

#[cfg(mc_s7_head)]
#[tokio::test]
async fn s7_review_witness_unknown_outcome_has_a_deadline() {
    use crate::historian_producer::stage_submission_handle;
    let dir = tempfile::tempdir().unwrap();
    let store = s7_store(dir.path(), false);
    let chunk = historian_chunk();
    let prior = prior_ranges();
    let models = vec!["test/first".into()];
    let handle = stage_submission_handle(
        "review-child",
        &serde_json::json!({"method":"session.send","params":{"send_id":"review","prompt":"p"}}),
    );
    let mut producer = ScriptedProducer::default()
        .with_start(Ok(handle))
        .with_output(Err(HistorianProducerError::TimedOut));
    assert!(run_historian_firing(
        &mut producer,
        fire_request(&store, "p", &models, &chunk, &prior)
    )
    .await
    .is_err());
    for attempt in 1..=8 {
        let mut producer = ScriptedProducer::default()
            .with_status(Ok(RunState::Active))
            .with_output(Err(HistorianProducerError::TimedOut));
        let mut request = reattach_request(&store, &chunk, &prior);
        request.now_ms = 123 + attempt * 86_400_000;
        request.await_timeout = Duration::from_millis(1);
        assert!(reattach_historian_producer(&mut producer, request)
            .await
            .is_err());
    }
    let state = store.load_meta("ses").unwrap().meta.historian;
    assert_eq!(
        state.state,
        HistorianPhase::Idle,
        "eight later reattachments, eight days later, still have no recovery deadline: {state:?}"
    );
}
