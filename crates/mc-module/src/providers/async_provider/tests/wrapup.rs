use super::super::wrapup::{AsyncWrapupAdmission, AsyncWrapupTarget};
use super::*;
use crate::providers::session_runner_fake::FakeSessionRunner;

async fn fixture(dir: &Path) -> (Rig, Arc<FakeSessionRunner>) {
    let child = FakeSessionRunner::for_project(dir);
    let factory = child.factory();
    let rig = Rig::configured(
        dir,
        "thalamus-harness",
        "opencode",
        json!({"serializer_profile":"opencode-aisdk"}),
        move |handler| {
            handler.producer_factory = factory;
            handler
                .fixed_config
                .as_mut()
                .unwrap()
                .rust_background_enabled = true;
            let mut binding = handler.facade_binding(7).unwrap();
            binding.config.rust_background_enabled = true;
            handler.bind_route(7, binding);
            handler
                .store
                .get()
                .unwrap()
                .set_route_identity_for_test(&dir.to_string_lossy(), "git:wrapup-fixture");
            handler.provider_historian_budget =
                super::super::super::historian_budget::Budget::new(1, 128);
            handler.fixed_historian_settings = Some(json!({"historian":{"opencode":{
                "model":"fixture/main", "fallback_models":["fixture/backup"]
            }}}));
        },
    )
    .await;
    (rig, child)
}

impl Rig {
    /// Inject command intent without pretending that a provider slash-command
    /// operation exists. Production command delivery still needs a contract.
    async fn wrapup_command(&self, command: &str) -> AsyncWrapupAdmission {
        assert_eq!(command, "/ctx-wrapup");
        self.h
            .request_async_wrapup(
                &self.h.facade_binding(7).unwrap(),
                &AsyncWrapupTarget {
                    reference: self.reference.clone(),
                    lineage: "L".into(),
                },
                20,
            )
            .await
            .unwrap()
    }

    fn narrative(&self, count: u64) {
        *self.runner.entries.lock().unwrap() = (0..count).map(|n| {
            ReadMessage::new(n, format!("m{n}"), json!({
                "info":{"id":format!("m{n}"),"role":"user","time":{"created":1}},
                "parts":[{"id":format!("p{n}"),"type":"text","text":format!("narrative message {n} with substantive user intent")}]
            })).with_tags(vec![tags::PartTag::tagged("0",format!("§{}§",100+n*3))])
        }).collect();
    }

    async fn historian_evaluation_done(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while self
                .h
                .provider_store
                .async_runtime
                .historian_inflight
                .load(std::sync::atomic::Ordering::SeqCst)
                != 0
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("initial autonomous evaluation finished");
    }

    async fn wrapup_done(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if self.h.wrapup_sessions.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("wrapup background drive finished");
    }
}

#[tokio::test]
async fn async_wrapup_command_runs_child_and_defers_identical_bytes_until_permitted_view() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    let before = rig
        .ride("ttl_expired")
        .await
        .expect("initial permitted view");
    rig.notice(2, 1_000, Some(before.view_version)).await;
    let before_bytes = serde_json::to_vec(&rig.get(before.view_version).await).unwrap();
    let before_render = rig.render(&before);

    let accepted = tokio::time::timeout(Duration::from_secs(1), rig.wrapup_command("/ctx-wrapup"))
        .await
        .expect("admission does not await the child");
    assert_eq!(accepted, AsyncWrapupAdmission::Accepted);
    let send = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .expect("summarizer child started");
    assert_eq!(send.route.module_id(), "thalamus-harness");
    assert_eq!(send.route.parent_session(), "s");
    assert_eq!(send.model, "fixture/main");
    assert!(
        send.system.contains("compartment"),
        "the shared historian system prompt is used"
    );
    assert!(send.prompt.contains("narrative message 0"));
    assert!(
        !send.prompt.contains("narrative message 25"),
        "the raw tail is not sent for summarization"
    );
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::AlreadyRunning
    );
    let output = r#"<output><compartments>
      <compartment start="0" end="10" title="first" episode_type="feature" importance="60"><p1>wrapup durable history</p1><p2>first</p2><p3>first</p3><p4 /></compartment>
      <compartment start="11" end="24" title="last" episode_type="feature" importance="60"><p1>final history</p1><p2>last</p2><p3>last</p3><p4 /></compartment>
      </compartments><facts><PROJECT_RULES>* [at_compartment=1] Keep wrapup memory durable
* Unanchored final chunk memory must be suppressed</PROJECT_RULES></facts>
      <meta><messages_processed>0-24</messages_processed><unprocessed_from>25</unprocessed_from></meta></output>"#.to_string();
    child.finish(&send.run_id, output);
    rig.wrapup_done().await;
    let namespace = rig.state().namespace();
    let compartments = rig
        .h
        .store
        .get()
        .unwrap()
        .load_compartments(&namespace)
        .unwrap();
    assert_eq!(compartments.iter().map(|c| c.end_message).max(), Some(24));
    assert_eq!(child.fixed_connects(), 0, "never use the configured runner");
    assert!(!child.connects().is_empty());
    let memories = rig
        .h
        .store
        .get()
        .unwrap()
        .load_active_memories("git:wrapup-fixture", 0)
        .unwrap();
    assert!(
        memories
            .iter()
            .any(|memory| memory.content.contains("Keep wrapup memory durable")),
        "wrapup uses the shared memory extraction and promotion path"
    );
    assert!(
        !memories
            .iter()
            .any(|memory| memory.content.contains("Unanchored final chunk")),
        "final weak-tail extraction is filtered exactly as standalone"
    );

    rig.notice(3, 1_000, Some(before.view_version)).await;
    assert_eq!(
        rig.newest(),
        Some(before.view_version),
        "defer cannot rebuild history"
    );
    assert_eq!(
        serde_json::to_vec(&rig.get(before.view_version).await).unwrap(),
        before_bytes
    );
    assert_eq!(
        rig.render(&rig.get(before.view_version).await),
        before_render
    );

    let after = rig
        .ride("ttl_expired")
        .await
        .expect("a permitted pass materializes history");
    assert!(after.view_version > before.view_version);
    let after_bytes = rig.render(&after);
    assert!(String::from_utf8_lossy(&after_bytes).contains("wrapup durable history"));
    let before_messages: Vec<Value> = serde_json::from_slice(&before_render).unwrap();
    let after_messages: Vec<Value> = serde_json::from_slice(&after_bytes).unwrap();
    assert_eq!(
        &after_messages[after_messages.len() - 20..],
        &before_messages[before_messages.len() - 20..],
        "the newest twenty messages remain byte-equivalent raw messages"
    );
    assert_eq!(
        after_messages[after_messages.len() - 20]["info"]["id"],
        "m25"
    );
    assert_eq!(child.sends().len(), 1);
}

#[tokio::test]
async fn async_wrapup_refuses_unknown_conversation_and_retired_lineage() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    let binding = rig.h.facade_binding(7).unwrap();
    for target in [
        AsyncWrapupTarget {
            reference: "unknown".into(),
            lineage: "L".into(),
        },
        AsyncWrapupTarget {
            reference: rig.reference.clone(),
            lineage: "retired".into(),
        },
    ] {
        assert_eq!(
            rig.h
                .request_async_wrapup(&binding, &target, 20)
                .await
                .unwrap(),
            AsyncWrapupAdmission::UnknownConversation
        );
    }
    assert!(child.sends().is_empty());
    assert!(rig.h.wrapup_sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn async_wrapup_refuses_another_runner() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "another-runner".into(),
    });
    let result = rig
        .h
        .request_async_wrapup(
            &binding,
            &AsyncWrapupTarget {
                reference: rig.reference.clone(),
                lineage: "L".into(),
            },
            20,
        )
        .await;
    let error = result.expect_err("another runner must not drive the owner's conversation");
    assert!(format!("{error:?}").contains("owned by another runner"));
    assert!(child.sends().is_empty());
    assert!(rig.h.wrapup_sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn async_wrapup_refuses_another_project() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.project_root = dir.path().join("other");
    assert!(rig
        .h
        .request_async_wrapup(
            &binding,
            &AsyncWrapupTarget {
                reference: rig.reference.clone(),
                lineage: "L".into()
            },
            20
        )
        .await
        .is_err());
    assert!(child.sends().is_empty());
}

#[tokio::test]
async fn async_wrapup_refuses_ceiling_and_releases_admission_for_retry() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    let held = rig.h.provider_historian_budget.acquire(0).await;
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Ceiling
    );
    assert!(rig.h.wrapup_sessions.lock().unwrap().is_empty());
    assert!(child.sends().is_empty());
    drop(held);
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Accepted
    );
    rig.wrapup_done().await;
    assert_eq!(rig.h.provider_historian_budget.stats()["active"], 0);
}

#[tokio::test]
async fn async_wrapup_drains_partial_chunks_without_moving_the_raw_tail() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Accepted
    );
    let first = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .unwrap();
    let output = r#"<output><compartments>
      <compartment start="0" end="5" title="first" episode_type="feature" importance="60"><p1>first history</p1><p2>first</p2><p3>first</p3><p4 /></compartment>
      <compartment start="6" end="10" title="second" episode_type="feature" importance="60"><p1>second history</p1><p2>second</p2><p3>second</p3><p4 /></compartment>
      </compartments><meta><messages_processed>0-10</messages_processed><unprocessed_from>11</unprocessed_from></meta></output>"#;
    child.finish(&first.run_id, output.into());
    let second = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .unwrap();
    assert_ne!(first.run_id, second.run_id);
    assert!(!second.prompt.contains("narrative message 25"));
    child.finish(
        &second.run_id,
        crate::tests::historian_output_for_prompt(&second.prompt),
    );
    rig.wrapup_done().await;
    let compartments = rig
        .h
        .store
        .get()
        .unwrap()
        .load_compartments(&rig.state().namespace())
        .unwrap();
    assert_eq!(child.sends().len(), 2);
    assert_eq!(compartments.iter().map(|c| c.end_message).max(), Some(24));
}

#[tokio::test]
async fn async_wrapup_validates_output_and_tries_the_configured_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            tokio::select! {
                send = child.next_unfinished() => child.finish(&send.run_id, "invalid historian output".into()),
                _ = rig.wrapup_done() => break,
            }
        }
    }).await.expect("invalid outputs terminate the model chain");
    let models: Vec<_> = child
        .sends()
        .iter()
        .map(|send| send.model.clone())
        .collect();
    assert_eq!(models, ["fixture/main", "fixture/backup"]);
    assert!(rig
        .h
        .store
        .get()
        .unwrap()
        .load_compartments(&rig.state().namespace())
        .unwrap()
        .is_empty());
    assert_eq!(rig.newest(), None, "invalid summaries cannot become a view");
}

#[tokio::test]
async fn async_wrapup_does_not_bless_conflicting_source_identities() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    let namespace = rig.state().namespace();
    let store = rig.h.store.get().unwrap();
    let mut loaded = store.load(&namespace).unwrap();
    loaded
        .meta
        .block_identity_by_mid
        .insert("m0".into(), Vec::new());
    store
        .commit(&namespace, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        tokio::select! {
            send = child.next_unfinished() => {
                child.finish(&send.run_id, crate::tests::historian_output_for_prompt(&send.prompt));
                rig.wrapup_done().await;
            }
            _ = rig.wrapup_done() => {}
        }
    })
    .await
    .expect("conflicting sources terminate without overwriting their identity");
    assert!(
        child.sends().is_empty(),
        "a conflicting source is refused before model work"
    );
    assert!(store.load(&namespace).unwrap().meta.block_identity_by_mid["m0"].is_empty());
    assert!(store.load_compartments(&namespace).unwrap().is_empty());
}

#[tokio::test]
async fn async_wrapup_refuses_an_already_running_historian() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    let LiveHistorianSessionClaim::Acquired(held) = rig
        .h
        .try_claim_live_historian_session(&rig.state().namespace())
    else {
        panic!("a new conversation has no active historian");
    };
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::AlreadyRunning
    );
    assert!(child.sends().is_empty());
    assert!(rig.h.wrapup_sessions.lock().unwrap().is_empty());
    assert_eq!(rig.h.provider_historian_budget.stats()["active"], 0);
    drop(held);
}
