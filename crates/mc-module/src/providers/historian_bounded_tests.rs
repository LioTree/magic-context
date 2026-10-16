fn bounded_prefix(h: &McHandler, end: u64) {
    let rows: Vec<_> = (1..=end).map(|n| mc_store::StoredCompartment {
        sequence: n as i64, start_message: n as i64, end_message: n as i64,
        start_message_id: format!("m{n}#0"), end_message_id: format!("m{n}#0"),
        title: if n % 5 == 0 { String::new() } else { format!("Prior chapter {n}: café 🦀") },
        content: if n % 5 == 0 { String::new() } else { format!("Published summary {n}.") },
        p1: (n % 3 == 0).then(|| format!("A shorter summary of chapter {n}.")),
        importance: ((n * 7) % 100) as i32, ..Default::default()
    }).collect();
    h.store.get().unwrap().replace_compartments("s", &rows).unwrap();
}

fn bounded_prompt_equal(actual: &PreparedHistorianAction, expected: &PreparedHistorianAction) {
    assert_eq!(signature(actual), signature(expected));
    let (PreparedHistorianAction::FireReady(actual), PreparedHistorianAction::FireReady(expected)) = (actual, expected) else {
        panic!("the bounded differential must exercise a real prompt");
    };
    review_bytes("bounded prompt", actual.task.firing.prompt.as_bytes(), expected.task.firing.prompt.as_bytes());
    review_bytes("bounded raw chunk", actual.task.firing.raw_chunk_messages.as_bytes(), expected.task.firing.raw_chunk_messages.as_bytes());
    assert_eq!(actual.task.firing.selected_range_identities, expected.task.firing.selected_range_identities);
}

#[tokio::test]
async fn bounded_ingest_reads_only_unsummarized_rows_and_matches_full_prompt() {
    for prefix in [10, 40, 60] {
        let dir = tempfile::tempdir().unwrap();
        let reference_dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        let reference = handler(reference_dir.path());
        declare(&h).await;
        let entries = corpus();
        let inputs = json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}});
        review_sync(&h, &entries, inputs.clone());
        bounded_prefix(&h, prefix);
        bounded_prefix(&reference, prefix);
        let actual = h.provider_historian_worker().prepare_provider_historian(&binding(&h), &key(&h)).await.unwrap().unwrap();
        let expected = oracle(&reference, &entries, &["test/model".into()], inputs);
        assert_eq!(h.provider_historian_scan_rows.load(Ordering::Relaxed), 80-prefix,
            "covered native rows must never be read by ingest");
        bounded_prompt_equal(&actual, &expected);
    }
}

#[tokio::test]
async fn restart_mid_ingest_retries_claimed_barrier_without_prefix_reads() {
    let dir = tempfile::tempdir().unwrap();
    let reference_dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    let reference = handler(reference_dir.path());
    declare(&h).await;
    let entries = corpus();
    let inputs = json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}});
    review_sync(&h, &entries, inputs.clone());
    bounded_prefix(&h, 40);
    bounded_prefix(&reference, 40);
    let budget = Arc::clone(&h.provider_historian_budget);
    let worker = h.provider_historian_worker();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel();
    *worker.provider_historian_ingest_pause.lock().unwrap() = Some((entered, held));
    let b = binding(&h);
    let k = key(&h);
    let task = tokio::spawn(async move { worker.prepare_provider_historian(&b, &k).await });
    tokio::time::timeout(Duration::from_secs(5), started).await.unwrap().unwrap();
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    assert_eq!(budget.stats()["active"], 1, "uncancelled blocking decode still owns its budget");
    release.send(()).unwrap();
    let drained = budget.acquire(usize::MAX).await;
    drop(drained);
    drop(h);
    let mut restarted = handler(dir.path());
    restarted.provider_historian_budget = budget;
    let actual = tokio::time::timeout(Duration::from_secs(30), restarted.provider_historian_worker().prepare_provider_historian(&binding(&restarted), &key(&restarted)))
        .await.unwrap().unwrap().expect("a persisted in-progress evaluation is retried on restart");
    let expected = oracle(&reference, &entries, &["test/model".into()], inputs);
    assert_eq!(restarted.provider_historian_scan_rows.load(Ordering::Relaxed), 40);
    bounded_prompt_equal(&actual, &expected);
}

#[tokio::test]
async fn provider_ingest_obeys_shared_budget_and_queued_hook_does_not_wait() {
    let dirs: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let budget = historian_budget::Budget::new(2, 512);
    let mut handlers = Vec::new();
    let mut tasks = Vec::new();
    let mut releases = Vec::new();
    for (index, dir) in dirs.iter().enumerate() {
        let mut h = handler(dir.path());
        h.provider_historian_budget = Arc::clone(&budget);
        declare(&h).await;
        review_sync(&h, &corpus(), json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}));
        bounded_prefix(&h, 40);
        let worker = h.provider_historian_worker();
        if index < 2 {
            let (entered, started) = tokio::sync::oneshot::channel();
            let (release, held) = std::sync::mpsc::channel();
            *worker.provider_historian_ingest_pause.lock().unwrap() = Some((entered, held));
            releases.push(release);
            let b = binding(&h); let k = key(&h);
            tasks.push(tokio::spawn(async move { worker.prepare_provider_historian(&b, &k).await }));
            tokio::time::timeout(Duration::from_secs(5), started).await.unwrap().unwrap();
        } else {
            let b = binding(&h); let k = key(&h);
            tasks.push(tokio::spawn(async move { worker.prepare_provider_historian(&b, &k).await }));
        }
        handlers.push(h);
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while budget.stats()["queued"] != 1 && !tasks[2].is_finished() { tokio::task::yield_now().await; }
    }).await.unwrap();
    assert_eq!(budget.stats()["queued"], 1, "third conversation must queue before reading or decoding native rows");
    assert_eq!(budget.stats()["active"], 2);
    assert_eq!(handlers[2].provider_historian_scan_rows.load(Ordering::Relaxed), 0);
    let hook = tokio::time::timeout(Duration::from_secs(1), handlers[2].handle_provider_value(7, "transform.hook", &hook(corpus().last().unwrap(), true)))
        .await.expect("budget waiting must not hold the conversation lock");
    assert!(matches!(hook, HandlerOutcome::Response(_)), "queued historian cannot refuse a hook: {hook:?}");
    for release in releases { release.send(()).unwrap(); }
    for task in tasks { tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap().unwrap(); }
    assert_eq!(budget.stats()["peak_active"], 2);
    assert_eq!(budget.stats()["active"], 0);
}

#[tokio::test]
async fn current_resident_decoded_tail_avoids_native_reads_and_stale_tail_pages() {
    let dir = tempfile::tempdir().unwrap();
    let reference_dir = tempfile::tempdir().unwrap();
    let mut h = handler(dir.path());
    h.provider_resident = Arc::new(super::super::resident_hooks::ResidentHooks::enabled(true));
    let reference = handler(reference_dir.path());
    declare(&h).await;
    let entries = corpus();
    let inputs = json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}});
    review_sync(&h, &entries, inputs.clone());
    bounded_prefix(&h, 40); bounded_prefix(&reference, 40);
    let store = h.store.get().unwrap(); let k = key(&h);
    let mut lease = h.provider_resident.begin(store.tag_cache_namespace(), &k).unwrap().unwrap();
    let mut request: TransformRequest = decode(&json!({"v":2,"session_id":"s","render_config":"provider-policy","serializer_profile":"opencode-aisdk","messages":[]})).unwrap();
    codec::Codec::OpencodeAiSdk.prepare_request(&mut request, &entries[40..]).unwrap();
    lease.state.fold_working = Some(super::super::fold_working::FoldWorking::build(&mut lease.state.fold_arena,
        super::super::fold_working::TailKey {through:40,newest:Some(80),answers:(0,0)}, &request, 40).unwrap());
    lease.state.fold_lineage = Some("L".into());
    lease.state.fold_data_version = Some(store.provider_external_data_version().unwrap());
    lease.publish();
    let actual = h.provider_historian_worker().prepare_provider_historian(&binding(&h), &k).await.unwrap().unwrap();
    let expected = oracle(&reference, &entries, &["test/model".into()], inputs);
    assert_eq!(h.provider_historian_scan_rows.load(Ordering::Relaxed), 0);
    bounded_prompt_equal(&actual, &expected);
    assert!(h.provider_resident.historian_tail(store, &k, "different-lineage", 41, 80).is_none());
    assert!(h.provider_resident.historian_tail(store, &k, "L", 41, 81).is_none());
}
