// The runner adds these witnesses to a temporary copy of historian::tests so
// they can use private fixtures without changing the production crate.
fn r2_reopen(dir: &std::path::Path) -> McStore {
    let store = store(dir);
    store.install_context_domain(std::sync::Arc::new(
        crate::single_store_reads::ModuleContextDomain::open(&dir.join("context.db")).unwrap(),
    ));
    store
}

fn r2_conn_inventory(conn: &rusqlite::Connection) -> std::collections::BTreeMap<String, Vec<String>> {
        let tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap()
            .query_map([], |row| row.get::<_, String>(0)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();
        let mut result = std::collections::BTreeMap::new();
        for table in tables {
            let mut query = conn.prepare(&format!("SELECT * FROM \"{}\"", table.replace('"', "\"\""))).unwrap();
            let count = query.column_count();
            let mut rows = query.query_map([], |row| Ok((0..count)
                .map(|column| format!("{:?}", row.get_ref(column).unwrap()))
                .collect::<Vec<_>>().join("|"))).unwrap()
                .collect::<Result<Vec<_>, _>>().unwrap();
            rows.sort();
            result.insert(table, rows);
        }
        result
}

fn r2_inventory(store: &McStore) -> std::collections::BTreeMap<String, Vec<String>> {
    store.with_context_conn_for_test(|conn| Ok(r2_conn_inventory(conn))).unwrap()
}

fn r2_main_inventory(dir: &std::path::Path) -> std::collections::BTreeMap<String, Vec<String>> {
    let conn = rusqlite::Connection::open_with_flags(dir.join("store.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    r2_conn_inventory(&conn)
}

#[tokio::test]
async fn s7_r2_dormant_rust_all_tables() {
    for memory_enabled in [false, true] {
        for ts_owned in [false, true] {
            for auto_promote in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let store = s7_store(dir.path(), ts_owned);
                let chunk = historian_chunk();
                let prior = prior_ranges();
                let models = vec!["test/first".into()];
                let mut request = fire_request(&store, "p", &models, &chunk, &prior);
                request.validate_options.memory_enabled = memory_enabled;
                request.validate_options.auto_promote = auto_promote;
                let before = r2_inventory(&store);
                let main_before = r2_main_inventory(dir.path());
                let mut producer = ScriptedProducer::default()
                    .with_start(Ok(run_handle("r2-normal")))
                    .with_output(Ok(producer_output(s7_xml("ordinary publish", true))));
                run_historian_firing(&mut producer, request).await.unwrap();
                let after = r2_inventory(&store);
                let changed: std::collections::BTreeMap<_, _> = after.iter()
                    .filter(|(table, rows)| before.get(*table) != Some(*rows))
                    .map(|(table, rows)| (table.clone(), serde_json::json!({
                        "before":before[table].len(), "after":rows.len(),
                        "removed":before[table].iter().filter(|row| !rows.contains(row)).count(),
                        "added":rows.iter().filter(|row| !before[table].contains(row)).count()
                    }))).collect();
                let main_after = r2_main_inventory(dir.path());
                let main_changed: Vec<_> = main_after.iter().filter(|(table, rows)| main_before.get(*table) != Some(*rows)).map(|(table, _)| table.clone()).collect();
                let counts = s7_counts(&store);
                assert_eq!(&counts[..3], &[1, 0, 1]);
                assert_eq!(counts[3], i64::from(memory_enabled && auto_promote && ts_owned));
                assert_eq!(counts[4], i64::from(memory_enabled && auto_promote && !ts_owned));
                assert_eq!(counts[5], 0);
                println!("S7_R2_RUST {}", serde_json::json!({"memory_enabled":memory_enabled,
                    "ts_owned":ts_owned,"auto_promote":auto_promote,"table_count":after.len(),
                    "changes":changed,"counts":counts,"main_table_count":main_after.len(),"main_changed":main_changed}));
            }
        }
    }
}

#[tokio::test]
async fn s7_r2_default_fence_survives_reopen_and_releases_once() {
    let dir = tempfile::tempdir().unwrap();
    let first = s7_store(dir.path(), false);
    let chunk = historian_chunk();
    let prior = prior_ranges();
    let models = vec!["test/first".into()];
    let original = crate::historian_producer::stage_submission_handle("old-child",
        &serde_json::json!({"method":"session.send","params":{"send_id":"old-key","prompt":"p"}}));
    let mut producer = ScriptedProducer::default().with_start(Ok(original))
        .with_output(Err(HistorianProducerError::TimedOut));
    assert!(run_historian_firing(&mut producer, fire_request(&first, "p", &models, &chunk, &prior)).await.is_err());
    assert_eq!(producer.observed_starts.len(), 1);
    let read_record = |store: &McStore| {
        let state = store.load_meta("ses").unwrap().meta.historian;
        let record: serde_json::Value = serde_json::from_str(state.producer_run_id.as_deref().unwrap().strip_prefix("mc-broca-stage:").unwrap()).unwrap();
        (state, record)
    };
    assert_eq!(read_record(&first).1["recovery"]["attempts"], 1);
    drop(first);
    for (now, attempts) in [(124, 2), (125, 3)] {
        let store = r2_reopen(dir.path());
        let mut probe = ScriptedProducer::default().with_status(Ok(RunState::Active))
            .with_output(Err(HistorianProducerError::TimedOut));
        let mut request = reattach_request(&store, &chunk, &prior);
        request.now_ms = now;
        assert!(reattach_historian_producer(&mut probe, request).await.is_err());
        assert!(probe.observed_starts.is_empty());
        assert_eq!(read_record(&store).1["recovery"]["attempts"], attempts);
    }
    let store = r2_reopen(dir.path());
    let (retired, record) = read_record(&store);
    assert_eq!(retired.state, HistorianPhase::Idle);
    assert_eq!(record["recovery"]["expires_at_ms"], 600_123);
    assert_eq!(record["recovery"]["fence_expires_at_ms"], 1_800_123);
    assert!(record.get("request").is_none());
    for now in [600_123, 1_800_122] {
        let mut blocked = ScriptedProducer::default().with_start(Ok(run_handle("too-early")))
            .with_output(Ok(producer_output(historian_xml("too early output"))));
        let mut request = fire_request(&store, "p", &models, &chunk, &prior);
        request.now_ms = now;
        assert!(matches!(run_historian_firing(&mut blocked, request).await.unwrap(), HistorianDriveOutcome::Busy(_)), "fresh dispatch happened before the default 30-minute fence");
        assert!(blocked.observed_starts.is_empty());
    }
    let mut fresh = ScriptedProducer::default().with_start(Ok(run_handle("new-run")))
        .with_output(Ok(producer_output(historian_xml("fresh output"))));
    let mut request = fire_request(&store, "p", &models, &chunk, &prior);
    request.now_ms = 1_800_123;
    assert!(matches!(run_historian_firing(&mut fresh, request).await.unwrap(), HistorianDriveOutcome::Completed(_)));
    assert_eq!(fresh.observed_starts.len(), 1);
    assert_eq!(store.load_meta("ses").unwrap().meta.historian.firing_seq, 2);
    println!("S7_R2_FENCE dispatch=123 timeout=600000 probes=3 expiry=600123 fence=1800123 reopen=3 pre_fence_starts=0 boundary_starts=1");
}

#[tokio::test]
async fn s7_r2_late_typed_error_must_not_abandon_fresh_attempt() {
    #[derive(Clone)]
    struct Capture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { self.0.lock().unwrap().extend_from_slice(bytes); Ok(bytes.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    let logs = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let writer = Capture(logs.clone());
    let _trace = tracing::subscriber::set_default(tracing_subscriber::fmt().with_ansi(false)
        .with_writer(move || writer.clone()).finish());
    let dir = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(s7_store(dir.path(), false));
    let chunk = historian_chunk();
    let prior = prior_ranges();
    let models = vec!["test/first".into()];
    let original = crate::historian_producer::stage_submission_handle("old-child",
        &serde_json::json!({"method":"session.send","params":{"send_id":"old-key","prompt":"p"}}));
    let mut first = ScriptedProducer::default().with_start(Ok(original))
        .with_output(Err(HistorianProducerError::TimedOut));
    assert!(run_historian_firing(&mut first, fire_request(&store, "p", &models, &chunk, &prior)).await.is_err());
    let other = store.clone();
    // Simulate a waiting observation of attempt 1 returning after attempt 2 starts.
    // The hook expires attempt 1 and reserves attempt 2 at the redispatch deadline;
    // its late terminal error must not clear the new attempt's durable state.
    let hook = move || {
        let current = other.load_meta("ses").unwrap().meta.historian;
        assert!(crate::historian_recovery::reserve_probe(&other, "ses", &current, 600_123,
            Duration::from_secs(600), 999).is_err());
        let retired = other.load_meta("ses").unwrap().meta.historian;
        let FireOutcome::Fired(new) = fire(&retired, 2, 4, "fp".into(), test_selected_range_identities(), 0,
            retired.compartment_set_generation.clone(), 1_800_123, None).unwrap() else { panic!("fence did not release") };
        let new = producer_started(&new, "fresh-child".into(), "fresh-run".into()).unwrap();
        persist_historian_state(&other, "ses", new).unwrap();
    };
    let mut old_probe = ScriptedProducer::default().with_status(Ok(RunState::Active))
        .with_output(Err(HistorianProducerError::RunFailed {
            run_id: "old-provider-run".into(), detail: "late old failure".into(),
            classification: Some(crate::historian_producer::ErrorClassification {
                class: ErrorClass::Transient, retry_after_secs: None,
            }), class_field_present: true,
        }))
        .with_await_output_hook(hook);
    let mut request = reattach_request(&store, &chunk, &prior);
    request.now_ms = 124;
    request.completion_now_ms = || 1_800_124;
    assert!(reattach_historian_producer(&mut old_probe, request).await.is_err());
    let current = store.load_meta("ses").unwrap().meta.historian;
    println!("S7_R2_LATE_ERROR seq={} state={:?} run={:?} failure={:?}", current.firing_seq, current.state, current.producer_run_id, current.last_failure);
    assert_eq!(current.firing_seq, 2);
    assert_eq!(current.state, HistorianPhase::AwaitingProducer, "late error from attempt 1 abandoned attempt 2");
    assert_eq!(current.producer_run_id.as_deref(), Some("fresh-run"));
    let logs = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
    assert_eq!(logs.matches("discarded stale historian observation").count(), 1);
    assert!(logs.contains("late_error"));
}

#[tokio::test]
async fn s7_r2_enabled_rust_writes_turn_one_stage() {
    let _lane = crate::historian_stage::enabled_test_lane();
    let dir = tempfile::tempdir().unwrap();
    let store = s7_store(dir.path(), false);
    let chunk = historian_chunk();
    let prior = prior_ranges();
    let models = vec!["test/first".into()];
    let mut request = fire_request(&store, "enabled stage fixture", &models, &chunk, &prior);
    request.validate_options.memory_enabled = false;
    let mut producer = ScriptedProducer::default().with_start(Ok(run_handle("enabled-run")))
        .with_output(Ok(producer_output(s7_xml("enabled stage fixture", false))));
    run_historian_firing(&mut producer, request).await.unwrap();
    assert_eq!(s7_counts(&store), vec![1,1,1,0,0,0]);
    store.with_context_conn_for_test(|conn| {
        let stage: (String,String,i64,String) = conn.query_row(
            "SELECT stage,state,run_attempt,request_json FROM memory_stage_attempts", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;
        assert_eq!((&*stage.0,&*stage.1,stage.2), ("turn_one","committed",1));
        let request: serde_json::Value = serde_json::from_str(&stage.3).unwrap();
        assert_eq!(request["prompt"], "enabled stage fixture");
        Ok(())
    }).unwrap();
}
