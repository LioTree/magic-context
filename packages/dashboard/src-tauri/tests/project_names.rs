use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use magic_context_dashboard_lib::project_names::{
    pj_label, ProjectNameCache, ENTORHINAL_RESOLVE_DEADLINE_MS,
};
use serde_json::Value;
use subc_control::{ClientControlRequest, ClientControlResponse};
use subc_protocol::{ErrorBody, Flags, Frame, FrameType, Priority, RouteTarget};
use subc_transport::{
    authenticate_server, generate_daemon_id, generate_key, read_frame, write_atomic, write_frame,
    ConnectionInfo, Endpoint, SCHEMA_VERSION,
};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

fn vector() -> Value {
    serde_json::from_str::<Value>(include_str!(
        "../../../../test-vectors/project-resolve-v1/enumerate.json"
    ))
    .unwrap()[0]
        .clone()
}

#[derive(Clone, Copy)]
enum Behavior {
    Answer,
    UnknownModule,
    HangHandshake,
    HangRoute,
    HangReply,
    LateReply,
}

#[derive(Default)]
struct Log {
    connections: usize,
    targets: Vec<RouteTarget>,
    requests: Vec<Value>,
}

struct FakeEntorhinal {
    path: PathBuf,
    log: Arc<Mutex<Log>>,
    reply: Arc<Mutex<Value>>,
    task: tokio::task::JoinHandle<()>,
    _temp: tempfile::TempDir,
}

impl Drop for FakeEntorhinal {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn fake(behavior: Behavior) -> FakeEntorhinal {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let key = generate_key().unwrap();
    let daemon_id = generate_daemon_id().unwrap();
    let path = temp.path().join("subc-connection.json");
    write_atomic(
        &path,
        &ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: Some(subc_protocol::PROTOCOL_VERSION),
            endpoints: vec![Endpoint {
                host: addr.ip().to_string(),
                port: addr.port(),
            }],
            key: key.clone(),
            daemon_id,
            pid: std::process::id(),
            daemon_ver: "fake".to_string(),
        },
    )
    .unwrap();
    let log = Arc::new(Mutex::new(Log::default()));
    let reply = Arc::new(Mutex::new(vector()["reply"].clone()));
    let server_log = log.clone();
    let server_reply = reply.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            server_log.lock().await.connections += 1;
            if matches!(behavior, Behavior::HangHandshake) {
                std::future::pending::<()>().await;
            }
            if authenticate_server(
                &mut stream,
                &key,
                &daemon_id,
                "fake",
                Duration::from_secs(2),
            )
            .await
            .is_err()
            {
                continue;
            }
            while let Ok(Some(frame)) = read_frame(&mut stream).await {
                if frame.header.ty != FrameType::Request {
                    continue;
                }
                let (ty, body) = if frame.header.channel == 0 {
                    let request: ClientControlRequest =
                        serde_json::from_slice(&frame.body).unwrap();
                    if let ClientControlRequest::RouteOpen { target, .. } = request {
                        server_log.lock().await.targets.push(target);
                        if matches!(behavior, Behavior::HangRoute) {
                            std::future::pending::<()>().await;
                        }
                        if matches!(behavior, Behavior::UnknownModule) {
                            (
                                FrameType::Error,
                                serde_json::to_vec(&ErrorBody::new("unknown_module", "not loaded"))
                                    .unwrap(),
                            )
                        } else {
                            (
                                FrameType::Response,
                                serde_json::to_vec(&ClientControlResponse::RouteOpen {
                                    route_channel: 10,
                                    route_epoch: 1,
                                })
                                .unwrap(),
                            )
                        }
                    } else {
                        continue;
                    }
                } else {
                    server_log
                        .lock()
                        .await
                        .requests
                        .push(serde_json::from_slice(&frame.body).unwrap());
                    if matches!(behavior, Behavior::HangReply) {
                        std::future::pending::<()>().await;
                    }
                    if matches!(behavior, Behavior::LateReply) {
                        tokio::time::sleep(Duration::from_millis(
                            ENTORHINAL_RESOLVE_DEADLINE_MS + 150,
                        ))
                        .await;
                    }
                    (
                        FrameType::Response,
                        serde_json::to_vec(&*server_reply.lock().await).unwrap(),
                    )
                };
                let response = Frame::build(
                    ty,
                    Flags::new(false, Priority::Interactive, false),
                    frame.header.channel,
                    frame.header.epoch,
                    frame.header.corr,
                    body,
                )
                .unwrap();
                if write_frame(&mut stream, &response).await.is_err() {
                    break;
                }
            }
        }
    });
    FakeEntorhinal {
        path,
        log,
        reply,
        task,
        _temp: temp,
    }
}

#[tokio::test]
async fn startup_enumerates_once_and_manual_refresh_updates_cache() {
    let server = fake(Behavior::Answer).await;
    let cache = ProjectNameCache::default();
    let ((), ()) = tokio::join!(
        cache.initialize(&server.path),
        cache.initialize(&server.path)
    );
    let names = cache.snapshot();
    assert_eq!(
        pj_label("pj-dashboard-editor", &names).as_deref(),
        Some("Editor")
    );
    assert_eq!(
        pj_label("pj-dashboard-terminal", &names).as_deref(),
        Some("Terminal")
    );
    for _ in 0..5 {
        assert_eq!(cache.snapshot(), names);
        cache.initialize(&server.path).await;
    }
    assert_eq!(server.log.lock().await.requests.len(), 1);
    server.reply.lock().await["result"]["projects"][0]["name"] =
        Value::String("Renamed Editor".to_string());
    cache.refresh(&server.path).await;
    assert_eq!(cache.snapshot()["pj-dashboard-editor"], "Renamed Editor");
    let log = server.log.lock().await;
    assert_eq!(log.connections, 2);
    assert_eq!(
        log.targets,
        vec![
            RouteTarget::ManagementSurface {
                module_id: "entorhinal".to_string()
            };
            2
        ]
    );
    assert_eq!(
        log.requests,
        vec![vector()["request"].clone(); 2],
        "only enumerate {{}} is sent, never resolve"
    );
}

#[tokio::test]
async fn absent_connection_file_makes_no_connection_or_call() {
    let server = fake(Behavior::Answer).await;
    std::fs::remove_file(&server.path).unwrap();
    let cache = ProjectNameCache::default();
    cache.initialize(&server.path).await;
    cache.initialize(&server.path).await;
    cache.refresh(&server.path).await;
    assert!(cache.snapshot().is_empty());
    assert_eq!(server.log.lock().await.connections, 0);
    assert!(server.log.lock().await.requests.is_empty());
    assert_eq!(
        pj_label("pj-dashboard-editor", &cache.snapshot()).unwrap(),
        "pj-dashboard-…"
    );
}

#[tokio::test]
async fn unloaded_entorhinal_makes_no_module_call_and_is_cached_until_refresh() {
    let server = fake(Behavior::UnknownModule).await;
    let cache = ProjectNameCache::default();
    cache.initialize(&server.path).await;
    cache.initialize(&server.path).await;
    assert!(cache.snapshot().is_empty());
    assert_eq!(server.log.lock().await.targets.len(), 1);
    assert!(server.log.lock().await.requests.is_empty());
    cache.refresh(&server.path).await;
    assert_eq!(server.log.lock().await.targets.len(), 2);
    assert!(server.log.lock().await.requests.is_empty());
}

async fn assert_deadline(behavior: Behavior) {
    let server = fake(behavior).await;
    let cache = ProjectNameCache::default();
    let start = Instant::now();
    cache.initialize(&server.path).await;
    assert!(start.elapsed() < Duration::from_millis(ENTORHINAL_RESOLVE_DEADLINE_MS + 250));
    assert!(cache.snapshot().is_empty());
    cache.initialize(&server.path).await;
    assert_eq!(server.log.lock().await.connections, 1);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        cache.snapshot().is_empty(),
        "late replies must not populate the map"
    );
}

#[tokio::test]
async fn handshake_that_never_completes_is_bounded() {
    assert_deadline(Behavior::HangHandshake).await;
}

#[tokio::test]
async fn route_that_never_opens_is_bounded() {
    assert_deadline(Behavior::HangRoute).await;
}

#[tokio::test]
async fn late_enumeration_is_discarded() {
    assert_deadline(Behavior::LateReply).await;
}

#[tokio::test]
async fn reply_that_never_completes_is_bounded() {
    assert_deadline(Behavior::HangReply).await;
}

#[tokio::test]
async fn malformed_reply_clears_names_without_failing_refresh() {
    let server = fake(Behavior::Answer).await;
    let cache = ProjectNameCache::default();
    cache.initialize(&server.path).await;
    assert_eq!(cache.snapshot().len(), 2);
    server.reply.lock().await["result"]["projects"][0]["projectId"] = Value::Null;
    cache.refresh(&server.path).await;
    assert!(cache.snapshot().is_empty());
}
