// Handler-level tests for `subagent_invocations.read`, included into lib.rs's test
// module so they can use its store-backed handler fixtures. The query logic itself
// is tested in `subagent_invocations_read.rs`.

fn subagent_context_db(dir: &tempfile::TempDir) -> rusqlite::Connection {
    let descriptor = dev_descriptor_at(dir.path().join("data").to_str().unwrap());
    let StorageBackend::Sqlite { path } = descriptor.backend else {
        panic!("test store is SQLite");
    };
    rusqlite::Connection::open(PathBuf::from(path).parent().unwrap().join("context.db")).unwrap()
}

#[tokio::test]
async fn subagent_invocations_read_answers_in_the_management_envelope() {
    let (handler, _store, dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let conn = subagent_context_db(&dir);
    conn.execute(
        "INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error) \
         VALUES ('ses', 'opencode', 'historian', NULL, 90, 100, 'failed', 'quota exhausted')",
        [],
    )
    .unwrap();
    let reply = call_dispatch_request(
        &handler,
        json!({"method": "subagent_invocations.read", "params": {"query": "window", "after": 0, "until": 1_000}}),
    )
    .await;
    assert_eq!(
        reply,
        json!({"result": {"rows": [{
            "id": 1, "session_id": "ses", "subagent": "historian", "task": null,
            "started_at": 90, "ended_at": 100, "status": "failed", "error": "quota exhausted",
            "parent_invocation_id": null
        }], "more": false}})
    );
    let after_cursor = call_dispatch_request(
        &handler,
        json!({"method": "subagent_invocations.read", "params": {
            "query": "after_cursor", "cursor": {"ended_at": 100, "id": 1}, "settled_before": 1_000
        }}),
    )
    .await;
    assert_eq!(after_cursor, json!({"result": {"rows": [], "more": false}}));
}

#[tokio::test]
async fn subagent_invocations_read_refuses_an_unknown_argument_by_name() {
    let (handler, _store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let (code, message) = error_frame(
        handler
            .dispatch_value(
                7,
                json!({"method": "subagent_invocations.read", "params": {
                    "query": "window", "after": 0, "until": 1, "session_id": "ses"
                }}),
            )
            .await,
    );
    assert_eq!(code, "invalid_params");
    assert!(message.contains("unknown argument `session_id`"), "{message}");
}

#[test]
fn manifest_declares_subagent_invocations_read_as_a_management_query() {
    let manifest = crate::manifest(DEFAULT_MODULE_ID);
    let operations: Vec<_> = manifest
        .provides
        .iter()
        .filter_map(|role| match role {
            ProviderRole::ManagementSurface { operations, .. } => Some(operations),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(operations.len(), 1, "{operations:?}");
    assert_eq!(operations[0].name, "subagent_invocations.read");
    assert_eq!(
        operations[0].kind,
        subc_protocol::manifest::ManagementOperationKind::Query
    );
    // Other tests in this crate read the tool provider as `provides[0]`, so it stays first.
    assert!(matches!(manifest.provides[0], ProviderRole::ToolProvider { .. }));
}
