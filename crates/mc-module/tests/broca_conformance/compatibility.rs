//! Schema-95 writer/restart compatibility and master executable comparisons on
//! disposable databases, with no access to installed stores.
use super::*;
use harness::*;
use std::path::PathBuf;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schema95_and_populated63_survive_provider_restart() {
    let mut rig = Rig::start(None, false).await;
    let store = rig.store();
    assert_eq!(store.module_store_schema_version().unwrap(), 65);
    assert_eq!(
        store.load_tags_for_session("legacy-fixture").unwrap()[0].tag_number,
        11
    );
    assert_eq!(
        store.load_pending_agent_drops("legacy-fixture").unwrap()[0].target_id,
        "m0#0"
    );
    drop(store);
    for preset in ["head", "worker", "reader"] {
        let session = format!("compat-{preset}");
        let identity = rig.identity(&session);
        let mut request = setup(&session);
        request["preset"] = json!(preset);
        let ready = rig.method(&identity, "compaction.setup", request).await;
        assert_eq!(ready["answer"], "ready");
        let declare = rig
            .method(
                &identity,
                "transform.declare",
                json!({"preset":preset,"params":{}}),
            )
            .await;
        assert!(!declare["subscriptions"].as_array().unwrap().is_empty());
        let mut hook = super::hooks::post_assistant(&session);
        hook["preset"] = json!(preset);
        let hooked = rig.method(&identity, "transform.hook", hook).await;
        assert_eq!(hooked["answer"], "ops");
        let answer = rig
            .method(
                &identity,
                "compaction.step",
                step(&session, "idle", &[], 0, &ready["initial"]),
            )
            .await;
        assert_eq!(answer["answer"], "noop");
    }
    rig.module.take();
    rig.spawn(None);
    rig.wait_ready().await;
    for preset in ["head", "worker", "reader"] {
        let session = format!("compat-{preset}");
        let record = rig.record(&session);
        assert!(
            record["setup"]["state"]["version_high_water"]
                .as_u64()
                .unwrap()
                > 0
        );
    }
    rig.assert_context_95();
}

fn baseline() -> PathBuf {
    PathBuf::from(
        std::env::var_os("MC_PROVIDER_BASELINE_CK_MC")
            .expect("set MC_PROVIDER_BASELINE_CK_MC to a debug ck-mc built from pinned master"),
    )
}

#[ignore = "requires a debug master ck-mc via MC_PROVIDER_BASELINE_CK_MC"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn master_catalog_tool_bytes_match_candidate() {
    let old = Rig::start_binary(None, false, baseline()).await;
    let candidate = Rig::start(None, false).await;
    for preset in ["head", "worker", "reader"] {
        let request = json!({"name":"tool.catalog","arguments":{"preset":preset}});
        let old_bytes = old
            .try_call_bytes(&old.identity("catalog"), request.clone())
            .await
            .unwrap();
        let new_bytes = candidate
            .try_call_bytes(&candidate.identity("catalog"), request)
            .await
            .unwrap();
        assert_eq!(new_bytes, old_bytes, "catalog bytes changed for {preset}");
    }
}

#[ignore = "requires a debug master ck-mc via MC_PROVIDER_BASELINE_CK_MC"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn master_binary_refuses_provider65_without_modifying_either_schema() {
    let mut rig = Rig::start(None, false).await;
    let descriptor = mc_module::dev_descriptor_at(rig.dir.path().join("data").to_str().unwrap());
    let cortexkit_store_types::StorageBackend::Sqlite { path } = descriptor.backend else {
        unreachable!()
    };
    rig.module.take();
    let before = database_snapshot(&path);
    rig.spawn_binary(baseline());
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let failure = rig
            .try_call(&rig.identity("older-fence"), json!({"kind":"health"}))
            .await;
        if failure
            .as_ref()
            .err()
            .is_some_and(|e| e.code() == Some("store_ahead_of_binary"))
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "older binary did not refuse: {failure:?}: {}",
            rig.stderr()
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    rig.module.take();
    assert_eq!(database_snapshot(&path), before);
    rig.assert_context_95();
}

fn database_snapshot(path: &str) -> Vec<(String, Vec<String>)> {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let mut snapshot = vec![(
        "sqlite_master".into(),
        conn.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
            .unwrap()
            .query_map([], |row| {
                Ok(format!(
                    "{:?}",
                    (
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?
                    )
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap(),
    )];
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for table in tables {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM \"{}\"", table.replace('"', "\"\"")))
            .unwrap();
        let count = statement.column_count();
        let mut rows = statement
            .query_map([], |row| {
                (0..count)
                    .map(|index| row.get::<_, rusqlite::types::Value>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map(|values| format!("{values:?}"))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows.sort();
        snapshot.push((table, rows));
    }
    snapshot
}

#[ignore = "requires a debug master ck-mc via MC_PROVIDER_BASELINE_CK_MC"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_opencode_and_claude_ck_bytes_match_master() {
    let old = Rig::start_binary(None, false, baseline()).await;
    let candidate = Rig::start(None, false).await;
    let messages: Vec<Value> =
        serde_json::from_str(include_str!("../../testdata/ck_wire_golden.json")).unwrap();
    let ingress = messages
        .into_iter()
        .enumerate()
        .map(|(ordinal, ck)| json!({"mid":format!("golden-{ordinal}"),"ordinal":ordinal,"ck":ck}))
        .collect::<Vec<_>>();
    for (harness, profile) in [
        ("opencode", "opencode-aisdk"),
        ("claude-code", "claude-code-anthropic"),
    ] {
        let old_identity =
            subc_protocol::BindIdentity::new(old.dir.path().join("project"), harness, harness);
        let new_identity = subc_protocol::BindIdentity::new(
            candidate.dir.path().join("project"),
            harness,
            harness,
        );
        let request = json!({"kind":"transform","v":2,"serializer_profile":profile,"session_id":harness,"render_config":"cfg0","messages":ingress,"tool_present":true,"auto_search_enabled":false,"execute_threshold_percentage":65,"usage":{"current_total_input_tokens":1000,"context_limit":100000}});
        let before = old.call(&old_identity, request.clone()).await;
        let after = candidate.call(&new_identity, request.clone()).await;
        assert_eq!(before["status"], "ok", "{before}");
        assert_eq!(after["status"], "ok", "{after}");
        assert_eq!(after["action"], before["action"]);
        assert_eq!(
            serde_json::to_vec(&after["ck_messages"]).unwrap(),
            serde_json::to_vec(&before["ck_messages"]).unwrap(),
            "{harness} payload changed"
        );
        assert!(
            !after["ck_messages"].is_null(),
            "must compare actual output, not two absent fields"
        );
        let replay = candidate.call(&new_identity, request).await;
        assert_eq!(
            serde_json::to_vec(&replay["ck_messages"]).unwrap(),
            serde_json::to_vec(&after["ck_messages"]).unwrap()
        );
    }
}

struct FailOneContextWrite(
    std::sync::Arc<mc_module::single_store_reads::ModuleContextDomain>,
    std::sync::atomic::AtomicBool,
);
impl mc_store::single_store_domain::ContextDomain for FailOneContextWrite {
    fn read(
        &self,
        read: &mut dyn FnMut(&rusqlite::Connection) -> rusqlite::Result<()>,
    ) -> Result<(), mc_store::McStoreError> {
        self.0.read(read)
    }
    fn write(
        &self,
        tables: &[&str],
        write: &mut dyn FnMut(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<(), mc_store::McStoreError> {
        if self.1.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(mc_store::McStoreError::Serde(
                "isolated context write fault".into(),
            ));
        }
        self.0.write(tables, write)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn existing_writers_pending_publication_and_revert_recover_on_context95() {
    use mc_store::*;
    let mut rig = Rig::start(None, false).await;
    let identity = rig.identity("publication");
    rig.method(&identity, "compaction.setup", setup("publication"))
        .await;
    let written = rig.call(&identity, json!({"name":"ctx_memory","arguments":{"action":"write","category":"CONSTRAINTS","content":"provider fixture memory","command_id":"write-1"}})).await;
    assert_ne!(written["isError"], true, "{written}");
    let context_path = rig
        .dir
        .path()
        .join("data/cortexkit/magic-context/context.db");
    let conn = rusqlite::Connection::open_with_flags(
        &context_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE content='provider fixture memory'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    drop(conn);
    let store = rig.store();
    let domain = mc_module::single_store_reads::attach(&store, &context_path).unwrap();
    let selected = vec![HistorianSelectedMessageIdentity {
        mid: "m10".into(),
        block_identities: vec![BlockIdentity {
            kind_tag: "text".into(),
            byte_fingerprint: "content-a".into(),
        }],
    }];
    let meta = ModuleMeta {
        block_identity_by_mid: selected
            .iter()
            .map(|item| (item.mid.clone(), item.block_identities.clone()))
            .collect(),
        historian: HistorianDurableState {
            state: HistorianPhase::Publishing,
            firing_seq: 7,
            chunk_range: Some(HistorianChunkRange {
                from_ordinal: 10,
                to_ordinal: 20,
            }),
            chunk_fingerprint: "fp".into(),
            selected_range_identities: selected.clone(),
            producer_session_id: Some("producer-session".into()),
            producer_run_id: Some("run-1".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    let version = store
        .commit(
            "historian-fixture",
            None,
            &mc_core::CoreState::default(),
            &meta,
        )
        .unwrap();
    let predicate = HistorianPublishPredicate {
        firing_seq: 7,
        producer_run_id: "run-1".into(),
        producer_attempt: 0,
        chunk_fingerprint: "fp".into(),
        selected_range_identities: selected,
        compartment_set_generation: Default::default(),
    };
    let compartment = StoredCompartment {
        start_message: 10,
        end_message: 20,
        start_message_id: "m10".into(),
        end_message_id: "m20".into(),
        title: "published".into(),
        content: "recovered historian summary".into(),
        ..Default::default()
    };
    let facts = vec![FactCandidate {
        category: "CONSTRAINTS".into(),
        content: "recovered historian fact".into(),
        ..Default::default()
    }];
    store.install_context_domain(std::sync::Arc::new(FailOneContextWrite(
        domain,
        std::sync::atomic::AtomicBool::new(true),
    )));
    let publish = store.publish_historian_chunk(HistorianPublishRequest {
        session_id: "historian-fixture",
        harness: Some("broca"),
        expected_row_version: Some(version),
        expected_revert_epoch: 0,
        predicate: &predicate,
        project_path: "fixture-project",
        compartments: &[compartment],
        facts: &facts,
        promote_facts: true,
        events: &[],
        primer_candidates: &[],
        user_memory_candidates: &[],
        publication_floor_ordinal: 21,
        chunk_transcript: Some("historian transcript"),
        raw_chunk_messages: None,
    });
    // Store-side publication succeeds once its context replay is durable.
    assert!(publish.is_ok());
    assert!(store
        .has_pending_context_write("historian-fixture")
        .unwrap());
    drop(store);
    rig.module.take();
    rig.spawn(None);
    rig.wait_ready().await;
    let store = rig.store();
    mc_module::single_store_reads::attach(&store, &context_path).unwrap();
    assert!(!store
        .has_pending_context_write("historian-fixture")
        .unwrap());
    assert_eq!(
        store.load_compartments("historian-fixture").unwrap().len(),
        1
    );
    assert_eq!(
        store
            .load_active_memories("fixture-project", 0)
            .unwrap()
            .iter()
            .filter(|m| m.content == "recovered historian fact")
            .count(),
        1
    );
    assert!(!store
        .resume_pending_context_write("historian-fixture")
        .unwrap());
    let current = store.load_meta("historian-fixture").unwrap();
    let reverted = store
        .truncate_compartments_for_revert("historian-fixture", 0, current.row_version)
        .unwrap();
    assert_eq!(reverted.revert_epoch, 1);
    assert!(store
        .load_compartments("historian-fixture")
        .unwrap()
        .is_empty());
    // Reconnect must see the incremented revert epoch and the deleted
    // compartment boundary, not coverage cached before the revert.
    drop(store);
    rig.module.take();
    rig.spawn(None);
    rig.wait_ready().await;
    let store = rig.store();
    mc_module::single_store_reads::attach(&store, &context_path).unwrap();
    assert_eq!(
        store
            .load_meta("historian-fixture")
            .unwrap()
            .meta
            .revert_epoch,
        1
    );
    assert!(store
        .load_compartment_boundaries("historian-fixture")
        .unwrap()
        .is_empty());
    let status = store.load_meta("historian-fixture").unwrap();
    assert!(status.meta.historian.state == HistorianPhase::Idle);
    let mut context_status = None;
    store
        .with_context_conn_for_test(|conn| {
            context_status = Some(conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE content='recovered historian fact'",
                [],
                |r| r.get::<_, i64>(0),
            )?);
            Ok(())
        })
        .unwrap();
    assert_eq!(context_status, Some(1));
    rig.assert_context_95();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review_runner_admission_requires_runner_bind() {
    let rig = Rig::start(None, false).await;
    let session = "route-admission";
    for bind_harness in ["opencode", "opencode2", "claude-code", "broca"] {
        let identity =
            subc_protocol::BindIdentity::new(rig.dir.path().join("project"), bind_harness, session);
        for body_harness in ["runner", "broca"] {
            let mut setup_request = setup(session);
            setup_request["harness"] = json!(body_harness);
            let mut hook_request = super::hooks::post_assistant(session);
            hook_request["harness"] = json!(body_harness);
            let mut step_request = step(
                session,
                "admission",
                &[],
                0,
                &json!({"compaction_id":"unallocated","version":1}),
            );
            step_request["harness"] = json!(body_harness);
            for (method, params) in [
                (
                    "transform.declare",
                    json!({"harness":body_harness,"params":{}}),
                ),
                ("transform.hook", hook_request),
                ("compaction.setup", setup_request),
                ("compaction.step", step_request),
            ] {
                let result = rig
                    .try_call(&identity, json!({"method":method,"params":params}))
                    .await;
                let failure = result.expect_err(&format!(
                    "{method} admitted bind {bind_harness} from body {body_harness}"
                ));
                assert_eq!(
                    failure.code(),
                    Some("route_unbound"),
                    "{method}: {failure:?}"
                );
                let malformed = rig
                    .try_call(&identity, json!({"method":method,"params":null}))
                    .await
                    .expect_err("non-runner bind must be refused before decoding");
                assert_eq!(malformed.code(), Some("route_unbound"));
            }
        }
    }
    assert!(
        rig.script.callbacks().is_empty(),
        "unadmitted calls reached the runner"
    );
    assert!(
        rig.store()
            .provider_records_for_session(rig.dir.path().join("project").to_str().unwrap(), session)
            .unwrap()
            .is_empty(),
        "unadmitted calls allocated provider state"
    );
    let identity = rig.identity(session);
    let mut ids = Vec::new();
    for body_harness in ["broca", "runner"] {
        let mut request = setup(session);
        request["harness"] = json!(body_harness);
        let ready = rig.method(&identity, "compaction.setup", request).await;
        assert_eq!(ready["answer"], "ready");
        ids.push(ready["initial"]["compaction_id"].clone());
        let declared = rig
            .method(&identity, "transform.declare", json!({"params":{}}))
            .await;
        assert!(!declared["subscriptions"].as_array().unwrap().is_empty());
        let mut hook = super::hooks::post_assistant(session);
        hook["harness"] = json!(body_harness);
        assert_eq!(
            rig.method(&identity, "transform.hook", hook).await["answer"],
            "ops"
        );
        let mut request = step(session, "admitted", &[], 0, &ready["initial"]);
        request["harness"] = json!(body_harness);
        assert_eq!(
            rig.method(&identity, "compaction.step", request).await["answer"],
            "noop"
        );
    }
    assert_ne!(
        ids[0], ids[1],
        "body harness coordinates must stay distinct under the admitted runner bind"
    );
    let mut harnesses = rig
        .store()
        .provider_records_for_session(rig.dir.path().join("project").to_str().unwrap(), session)
        .unwrap()
        .into_iter()
        .map(|(harness, _)| harness)
        .collect::<Vec<_>>();
    harnesses.sort();
    assert_eq!(harnesses, vec!["broca", "runner"]);
}
