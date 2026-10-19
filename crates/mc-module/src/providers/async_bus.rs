//! Modules authenticate to the bus through ck-bus; the signing seed never
//! leaves the issuer. Reconnects obtain a fresh credential, not a local fallback.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use subc_client_rs::{CallOptions, ConsumerIdentity, ConsumerOptions, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};

async fn call(
    consumer: &SubcConsumer,
    identity: &ConsumerIdentity,
    connection: &Path,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let bytes = consumer
        .call(
            RouteTarget::ManagementSurface {
                module_id: "ckbus".into(),
            },
            BindIdentity::new(
                connection.parent().unwrap_or(Path::new("/")),
                "runner",
                "async-compaction-bus",
            ),
            serde_json::to_vec(&json!({"method":method,"params":params}))
                .map_err(|e| e.to_string())?,
            CallOptions {
                timeout: Duration::from_secs(5),
                consumer_identity: Some(identity.clone()),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(value.get("result").cloned().unwrap_or(value))
}

async fn bootstrap(
    connection: PathBuf,
) -> Result<(Arc<cortexkit_bus_nats::NatsConnection>, String), String> {
    let identity = ConsumerIdentity {
        module_id: std::env::var("SUBC_MODULE_ID").map_err(|e| e.to_string())?,
        launch_nonce: subc_client_rs::launch_nonce()
            .map_err(|e| e.to_string())?
            .ok_or("module launch identity unavailable")?
            .value()
            .to_string(),
    };
    let consumer = Arc::new(
        SubcConsumer::connect(&connection, ConsumerOptions::default())
            .await
            .map_err(|e| e.to_string())?,
    );
    let credential = call(
        &consumer,
        &identity,
        &connection,
        "ckbus.credential",
        json!({}),
    )
    .await?;
    let field = |name: &str| {
        credential[name]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("credential missing {name}"))
    };
    let public = field("credential_public")?;
    let server = field("server_url")?;
    let account = field("acct")?;
    let config = cortexkit_bus_nats::ConnectConfig::new(&public).map_err(|e| e.to_string())?;
    let options = async_nats::ConnectOptions::with_jwt(field("jwt")?, move |nonce| {
        let consumer = consumer.clone();
        let identity = identity.clone();
        let connection = connection.clone();
        let public = public.clone();
        let task = tokio::spawn(async move {
            let answer = call(
                &consumer,
                &identity,
                &connection,
                "ckbus.nonce_sign",
                json!({"nonce_b64":STANDARD.encode(nonce),"credential_public":public}),
            )
            .await?;
            STANDARD
                .decode(
                    answer["signature_b64"]
                        .as_str()
                        .ok_or("signature missing")?,
                )
                .map_err(|e| e.to_string())
        });
        async move {
            task.await
                .map_err(async_nats::AuthError::new)?
                .map_err(async_nats::AuthError::new)
        }
    })
    .connection_timeout(Duration::from_secs(5))
    .max_reconnects(0);
    let bus = cortexkit_bus_nats::NatsConnection::connect(server, options, config)
        .await
        .map_err(|e| e.to_string())?;
    Ok((Arc::new(bus), account))
}

impl McHandler {
    pub(crate) fn start_async_compaction_background(&self) {
        let runtime = &self.provider_store.async_runtime;
        let Some(connection) = runtime
            .connection_file
            .lock()
            .expect("bus connection file")
            .clone()
        else {
            return;
        };
        if runtime.bootstrapped.set(()).is_err() {
            return;
        }
        let handler = self.provider_historian_worker();
        tokio::spawn(async move {
            let mut delay = Duration::from_secs(1);
            loop {
                let result = async {
                    let (bus, account) = bootstrap(connection.clone()).await?;
                    let names = cortexkit_bus_naming::AccountNames::derive(&account)
                        .map_err(|e| e.to_string())?;
                    let stream = Arc::new(bus.stream(names.streams().event.clone()));
                    let task = handler
                        .clone()
                        .start_compaction_bus(stream, account)
                        .await?;
                    task.await.map_err(|e| e.to_string())
                }
                .await;
                if delay == Duration::from_secs(1) {
                    tracing::warn!(
                        ?result,
                        "async compaction bus not ready; retrying authenticated bootstrap"
                    );
                }
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(30));
            }
        });
    }
}
