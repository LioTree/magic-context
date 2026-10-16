use magic_context_dashboard_lib::{db, memory_bridge};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn fixture(path: &std::path::Path) -> Connection {
    mc_store::single_store_domain::create_test_context_db(path).unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute("INSERT INTO memories(project_path,category,content,normalized_hash,source_type,importance,scope,shareable,status,first_seen_at,created_at,updated_at,last_seen_at) VALUES('git:idle','CONFIG_VALUES',?1,?2,'agent',50,'project',0,'active',1,1,1,1)", params!["cache_ttl=5m", mc_store::memory_history::normalized_hash("cache_ttl=5m")]).unwrap();
    conn
}
fn edit_request() -> Value {
    json!({ "projectPath":"git:idle", "operationId":"edit", "expectedRevisions":[{"memoryId":1,"revision":1}], "changes":[{"memoryId":1,"content":"cache_ttl=10m"}] })
}

#[tokio::test]
async fn ts_owned_dashboard_edit_works_without_any_host_process() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    let conn = fixture(&path);
    drop(conn);
    let receipt = db::memory_request(&path, "memory.edit", edit_request())
        .await
        .unwrap();
    assert_eq!(receipt["state"], "applied");
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT content,revision FROM memories WHERE id=1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        )
        .unwrap(),
        ("cache_ttl=10m".into(), 2)
    );
}

#[tokio::test]
async fn module_owned_idle_host_keeps_history_readable_and_refuses_without_sql_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    let mut conn = fixture(&path);
    let edited = mc_store::memory_history::local_write(&mut conn, &edit_request(), 1000).unwrap();
    conn.execute("INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES('git:idle','idle-context',1000)", []).unwrap();
    drop(conn);
    // A live daemon endpoint cannot grant the external editor local ownership.
    let _daemon = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let before = std::fs::read(&path).unwrap();
    let history =
        memory_bridge::request(&path, "memory.history", json!({ "projectPath":"git:idle" }))
            .await
            .unwrap();
    assert_eq!(history["decisions"].as_array().unwrap().len(), 1);
    let request = json!({ "projectPath":"git:idle", "decisionKey":edited["decisionKey"], "operationId":"undo", "expectedRevisions":[{"memoryId":1,"revision":2}] });
    let preview = memory_bridge::request(
        &path,
        "memory.restore.preview",
        json!({ "projectPath":"git:idle", "decisionKey":edited["decisionKey"] }),
    )
    .await
    .unwrap();
    assert_eq!(preview["state"], "ready");
    let receipt = memory_bridge::request(&path, "memory.restore", request.clone())
        .await
        .unwrap();
    assert_eq!(receipt["state"], "refused");
    assert_eq!(receipt["reason"], "authority_unavailable");
    assert_eq!(receipt["detail"], "module_host_not_running");
    assert_eq!(receipt["restoredDecisionKey"], Value::Null);
    assert_eq!(receipt["revisions"], json!([]));
    assert_eq!(
        memory_bridge::request(&path, "memory.restore", request)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let edit = memory_bridge::request(&path, "memory.edit", edit_request())
        .await
        .unwrap();
    assert_eq!(edit["detail"], "module_host_not_running");
    assert_eq!(edit["decisionKey"], Value::Null);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn review_module_bridge_authenticates_and_never_falls_back_after_http_refusal() {
    use std::io::{Read, Write};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    let conn = fixture(&path);
    conn.execute("INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES('git:idle','review-context',1)", []).unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let rpc = directory.path().join("rpc/review");
    std::fs::create_dir_all(&rpc).unwrap();
    std::fs::write(rpc.join("port-review.json"), serde_json::to_vec(&json!({"projectPath":"git:idle", "port":port, "token":"throwaway-review-token", "started_at":1})).unwrap()).unwrap();
    // This listener observes the real HTTP request, not a mock of bearer_auth.
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 1024];
        while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            let count = socket.read(&mut buffer).unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&buffer[..count]);
        }
        let headers = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
        assert!(headers.starts_with("post /rpc/memory.edit http/1.1"));
        assert!(headers.contains("authorization: bearer throwaway-review-token\r\n"));
        socket
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
    });
    assert_eq!(
        memory_bridge::request(&path, "memory.edit", edit_request())
            .await
            .unwrap_err(),
        "authority_unavailable"
    );
    server.join().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
