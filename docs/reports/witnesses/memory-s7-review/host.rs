// run.py injects this into tests::gate_a2 only when MC_S7_REVIEW=1.
fn s7_host_domain(store: &McStore, dir: &std::path::Path) -> std::path::PathBuf {
    let descriptor = dev_descriptor_at(dir.join("data").to_str().unwrap());
    let cortexkit_store_types::StorageBackend::Sqlite { path } = descriptor.backend else {
        unreachable!()
    };
    let context = std::path::Path::new(&path)
        .parent()
        .unwrap()
        .join("context.db");
    store.install_context_domain(Arc::new(
        single_store_reads::ModuleContextDomain::open(&context).unwrap(),
    ));
    context
}

#[tokio::test(flavor = "current_thread")]
async fn s7_review_snapshot_randomized_host_claims() {
    let mut seed = 0x7057_7337_1012_u64;
    for index in 0..24 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let producer = Arc::new(ProducerState::default());
        let (handler, store, dir, project) = handler_with_store(producer, host_runner_config());
        let context = s7_host_domain(&store, dir.path());
        let project_key = lane_project_key(&store, &project);
        a2_queue_run(
            &store,
            "ses",
            "review-host-run",
            &project_key,
            "review-host-prompt",
            now_ms(),
        );
        let mut claim = call_dispatch_request(
            &handler,
            json!({"method":"historian.claim","v":1,
            "run_id":"review-host-run","claimant_instance_id":"review-host"}),
        )
        .await;
        assert_eq!(claim["ok"], true, "{claim}");
        let token = claim["token"].as_str().unwrap().to_string();
        let report = if seed & 1 == 0 {
            json!({"method":"historian.complete","v":1,"run_id":"review-host-run","token":token,
                "output":{"text":"review-output","length_capped":seed & 2 != 0}})
        } else {
            json!({"method":"historian.complete","v":1,"run_id":"review-host-run","token":token,
                "error":{"code":"timeout","message":"review timeout"}})
        };
        let stale = call_dispatch_request(
            &handler,
            json!({"method":"historian.complete","v":1,
            "run_id":"review-host-run","token":"obsolete","output":{"text":"obsolete"}}),
        )
        .await;
        let accepted = call_dispatch_request(&handler, report).await;
        claim["token"] = json!("TOKEN");
        claim["claim_deadline_ms"] = json!(0);
        let lifecycle = claim.as_object_mut().unwrap().remove("lifecycle");
        let conn = Connection::open(context).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_stage_attempts", [], |r| {
                r.get(0)
            })
            .unwrap();
        println!(
            "S7_SNAPSHOT host-{index} {}",
            json!({"claim":claim,"stale":stale,"accepted":accepted,
            "stage_rows":count,"lifecycle_present":lifecycle.is_some(),
            "report_kind":gate_queue_rows(&dir.path().join("data"))[0].report_kind})
        );
    }
}

#[cfg(mc_s7_head)]
#[tokio::test(flavor = "current_thread")]
async fn s7_review_control_reclaimed_host_preserves_pinned_child() {
    let _lane = historian_stage::enabled_test_lane();
    let producer = Arc::new(ProducerState::default());
    let (handler, store, dir, project) = handler_with_store(producer, host_runner_config());
    s7_host_domain(&store, dir.path());
    let project_key = lane_project_key(&store, &project);
    a2_queue_run(
        &store,
        "ses",
        "review-host-run",
        &project_key,
        "review-host-prompt",
        now_ms(),
    );
    let claim = call_dispatch_request(
        &handler,
        json!({"method":"historian.claim","v":1,
        "run_id":"review-host-run","claimant_instance_id":"host-a"}),
    )
    .await;
    let state = store.load_meta("ses").unwrap().meta.historian;
    let stage = historian_stage::HistorianStage::turn_one(&project_key, "ses", &state);
    // Crash after child metadata is committed but before delivery or durable report storage.
    stage
        .record_host_child(
            &store,
            "child-a",
            &json!({"stage_key":stage.stage_key,"child_session_id":"child-a"}),
        )
        .unwrap();
    let mc_store::HistorianClaimOutcome::Claimed(next) = store
        .claim_historian_run(
            &project_key,
            "review-host-run",
            "host-b",
            claim["claim_deadline_ms"].as_i64().unwrap(),
        )
        .unwrap()
    else {
        panic!("must reclaim")
    };
    let request = json!({"method":"historian.complete","v":1,
        "run_id":"review-host-run","token":next.token,"output":{"text":"new child's output","length_capped":false},
        "lifecycle":{"stage_key":stage.stage_key,"child_session_id":"child-b"}});
    let response = handler.handle_historian_complete_value(7, &request);
    assert!(
        matches!(response, HandlerOutcome::Error { ref code, .. } if code == "single_store_sqlite_error"),
        "a claimant must not substitute another provider child for the pinned one: {response:?}"
    );
    let mut retained = request;
    retained["lifecycle"]["child_session_id"] = json!("child-a");
    let accepted = call_dispatch_request(&handler, retained).await;
    assert_eq!(
        accepted["ok"], true,
        "replacement claimant must be able to report using the retained child: {accepted}"
    );
}
