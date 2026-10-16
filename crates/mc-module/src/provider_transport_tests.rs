//! Offline SDK ingress for provider witnesses and timing drivers.
use crate::*;
use subc_client_rs::{BindDecision, CallOptions, ConsumerOptions, SubcConsumer};
use subc_daemon::{serve_listener, ConnectedClients, ControlHandler, Registry, Router, ServerAuth};
use subc_transport::{
    generate_daemon_id, generate_key, write_atomic, ConnectionInfo, Endpoint, SCHEMA_VERSION,
};

type Registered = Arc<Mutex<HashMap<String, (std::sync::Weak<McHandler>, SessionBinding)>>>;

struct Ingress {
    registered: Registered,
    routes: Mutex<HashMap<u16, std::sync::Weak<McHandler>>>,
}

#[async_trait]
impl ModuleHandler for Ingress {
    async fn on_bind(&self, req: &RouteBindRequest) -> BindDecision {
        let (handler, binding) = self.registered.lock().unwrap()[&req.identity.session].clone();
        // Fixtures already own isolated stores and frozen configuration. Only the
        // SDK's freshly allocated channel is substituted for their direct-test channel.
        handler
            .upgrade()
            .unwrap()
            .bind_route(req.handle.channel, binding);
        self.routes
            .lock()
            .unwrap()
            .insert(req.handle.channel, handler);
        BindDecision::accept()
    }

    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        let handler = self.routes.lock().unwrap()[&ctx.route_handle().channel]
            .upgrade()
            .unwrap();
        providers::hook_probe::take();
        let before = handler.provider_historian_budget.stats();
        let started = Instant::now();
        let cpu = cpu_time::ProcessTime::now();
        let scheduler_before = scheduler_wait_ms();
        let outcome = handler.handle(ctx, body).await;
        let module_ms = started.elapsed().as_secs_f64() * 1000.0;
        let stages = providers::hook_probe::take();
        let (acquire, callback, finish) = mc_store::provider_meters::last_transaction_timing();
        let mut measured = json!({"module_ms":module_ms,"cpu_ms":cpu.elapsed().as_secs_f64()*1000.0,
            "admission_ms":crate::transport_admission::LAST_WAIT_MS.with(|last| last.get()),
            "scheduler_wait_ms":(scheduler_wait_ms()-scheduler_before).max(0.0),
            "hook_stages":stages,"db_acquire_ms":acquire,"db_callback_ms":callback,"db_finish_ms":finish,
            "historian_before":before,"historian_after":handler.provider_historian_budget.stats()});
        match outcome {
            HandlerOutcome::Response(bytes) => {
                measured["ok"] = serde_json::from_slice(&bytes).unwrap();
                measured["raw"] = json!(String::from_utf8(bytes).unwrap());
            }
            HandlerOutcome::Error { code, message } => {
                measured["error"] = json!({"code":code,"message":message});
            }
            HandlerOutcome::ErrorWithDetail {
                code,
                message,
                detail,
            } => {
                measured["error"] = json!({"code":code,"message":message,"detail":detail});
            }
            other => panic!("unexpected provider outcome: {other:?}"),
        }
        HandlerOutcome::Response(serde_json::to_vec(&measured).unwrap())
    }
}

fn scheduler_wait_ms() -> f64 {
    std::fs::read_to_string("/proc/thread-self/schedstat")
        .ok()
        .and_then(|raw| raw.split_whitespace().nth(1)?.parse::<u64>().ok())
        .unwrap_or(0) as f64
        / 1_000_000.0
}

pub(crate) struct Transport {
    registered: Registered,
    aliases: Mutex<HashMap<String, String>>,
    consumer: SubcConsumer,
    daemon: tokio::task::JoinHandle<()>,
    module: tokio::task::JoinHandle<()>,
    _directory: tempfile::TempDir,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.module.abort();
        self.daemon.abort();
    }
}

impl Transport {
    pub(crate) async fn start(resident: bool) -> Self {
        let (ready, receive) = tokio::sync::oneshot::channel();
        let (shutdown, stopped) = tokio::sync::oneshot::channel();
        // Fixture editing and stdin handling are not module control-plane work.
        // Give SDK ingress its own current-thread runtime, as the binary has.
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let transport = Self::start_inner(resident, shutdown).await;
                if ready.send(transport).is_ok() {
                    let _ = stopped.await;
                }
            });
        });
        receive.await.unwrap()
    }

    async fn start_inner(resident: bool, shutdown: tokio::sync::oneshot::Sender<()>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let connection = directory.path().join("connection.json");
        let info = ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: Some(subc_protocol::PROTOCOL_VERSION),
            endpoints: vec![Endpoint {
                host: "127.0.0.1".into(),
                port: listener.local_addr().unwrap().port(),
            }],
            key: generate_key().unwrap(),
            daemon_id: generate_daemon_id().unwrap(),
            pid: std::process::id(),
            daemon_ver: "provider-transport-test".into(),
        };
        write_atomic(&connection, &info).unwrap();
        let connected = ConnectedClients::new();
        let control = Arc::new(
            ControlHandler::new(Arc::new(Registry::default()))
                .with_connected_clients(connected.clone()),
        );
        let router = Arc::new(Router::with_control_handler(control));
        let auth = ServerAuth::new(info.key, info.daemon_id, info.daemon_ver)
            .with_connected_clients(connected);
        let daemon = tokio::spawn(async move {
            serve_listener(listener, router, auth).await.unwrap();
        });
        let registered = Registered::default();
        let (_, serving) = subc_client_rs::serve_with_handle(
            &connection,
            crate::manifest(DEFAULT_MODULE_ID),
            McTransportHandler::new(Ingress {
                registered: registered.clone(),
                routes: Mutex::default(),
            })
            .with_resident_admission(resident),
        )
        .await
        .unwrap();
        let module = tokio::spawn(async move {
            serving.await.unwrap();
        });
        let consumer = SubcConsumer::connect(&connection, ConsumerOptions::default())
            .await
            .unwrap();
        Self {
            registered,
            aliases: Mutex::default(),
            consumer,
            daemon,
            module,
            _directory: directory,
            _shutdown: shutdown,
        }
    }

    pub(crate) fn register(&self, name: &str, handler: Arc<McHandler>, binding: SessionBinding) {
        let mut registered = self.registered.lock().unwrap();
        let alias = format!("{name}-{}", registered.len());
        registered.insert(alias.clone(), (Arc::downgrade(&handler), binding));
        self.aliases.lock().unwrap().insert(name.into(), alias);
    }

    pub(crate) async fn call(&self, name: &str, body: Value) -> Value {
        let alias = self.aliases.lock().unwrap()[name].clone();
        let bytes = self
            .consumer
            .call(
                crate::route_targets::catalog_provider_target_for_test(),
                subc_protocol::BindIdentity::new(self._directory.path(), "runner", alias),
                serde_json::to_vec(&body).unwrap(),
                CallOptions {
                    timeout: Duration::from_secs(30),
                    ..Default::default()
                },
            )
            .await;
        match bytes {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap(),
            Err(error) => json!({"error":{"message":error.to_string()}}),
        }
    }
}
