// run.py injects this into historian_producer::tests only when MC_S7_REVIEW=1.
#[tokio::test]
async fn s7_review_snapshot_real_broca_wire() {
    for queued in [false, true] {
        let response = if queued {
            json!({"result":{"state":"pending","submission_id":"queued-review"}})
        } else {
            json!({"result":{"state":"active","run_id":"run-review"}})
        };
        let server = fake_server(response, vec![]).await;
        let mut producer = client(&server).await;
        #[cfg(mc_s7_head)]
        let result = producer
            .start_stage_with_generation(
                "mc-historian:review:1",
                "review-stage-key",
                "s",
                "p",
                "prov/model",
                None,
                100,
                None,
            )
            .await;
        #[cfg(not(mc_s7_head))]
        let result = producer
            .start_with_generation(
                "mc-historian:review:1",
                "s",
                "p",
                "prov/model",
                None,
                100,
                None,
            )
            .await;
        let (kind, outcome) = match result {
            Ok(handle) => {
                #[cfg(mc_s7_head)]
                let staged = is_stage_submission(&handle.run_id);
                #[cfg(not(mc_s7_head))]
                let staged = false;
                if staged {
                    let _ = producer
                        .await_output_with_timeout(&handle.run_id, Duration::from_millis(150))
                        .await;
                }
                (
                    "ok",
                    if staged {
                        "durable-submission".to_string()
                    } else {
                        handle.run_id
                    },
                )
            }
            Err(error) => ("error", format!("{error:?}")),
        };
        producer.close().await;
        let log = server.log.lock().await;
        println!(
            "S7_SNAPSHOT wire-{queued} {}",
            json!({"kind":kind,"outcome":outcome,"sends":log.sends,
            "retracts":log.retracts,"route_sessions":log.route_sessions,"subscribes":log.subscribes})
        );
    }
}

#[cfg(mc_s7_head)]
#[tokio::test]
async fn s7_review_control_recovery_resends_identical_request() {
    let _lane = crate::historian_stage::enabled_test_lane();
    let server = fake_server(
        json!({"result":{"state":"pending","submission_id":"queued-review"}}),
        vec![],
    )
    .await;
    let mut producer = client(&server).await;
    let handle = producer
        .start_stage_with_generation(
            "review-child",
            "original-key",
            "s",
            "p",
            "prov/model",
            None,
            100,
            None,
        )
        .await
        .unwrap();
    assert!(is_stage_submission(&handle.run_id));
    assert!(matches!(
        producer
            .await_output_with_timeout(&handle.run_id, Duration::from_millis(250))
            .await,
        Err(HistorianProducerError::TimedOut)
    ));
    producer.close().await;
    let log = server.log.lock().await;
    assert!(
        log.sends.len() >= 2,
        "queued request must reach the resend path"
    );
    assert!(
        log.sends.iter().all(|send| send == &log.sends[0]),
        "recovery changed a durable request identity or payload"
    );
    assert!(log.retracts.is_empty());
    assert!(log
        .route_sessions
        .iter()
        .all(|session| session == "review-child"));
}

#[cfg(mc_s7_head)]
#[tokio::test]
async fn s7_review_control_ordinary_stage_send_preserves_payload() {
    let _lane = crate::historian_stage::enabled_test_lane();
    let server = fake_server(json!({"run_id":"ordinary-review-run"}), vec![]).await;
    let mut producer = client(&server).await;
    let handle = producer
        .start_stage_with_generation(
            "ordinary-child",
            "ordinary-key",
            "review-system",
            "review-prompt",
            "prov/model",
            None,
            100,
            None,
        )
        .await
        .unwrap();
    assert_eq!(handle.run_id, "ordinary-review-run");
    producer.close().await;
    let log = server.log.lock().await;
    assert_eq!(log.sends.len(), 1);
    assert_eq!(log.sends[0]["send_id"], "ordinary-key");
    assert_eq!(log.sends[0]["prompt"], "review-prompt");
    assert_eq!(log.sends[0]["system"], "review-system");
}
