//! Stdio oracle for the TypeScript relay vectors; all stores are disposable.
use super::*;
use std::io::{BufRead, Write};

struct NoRunner;
#[async_trait]
impl session_resolver::ProviderRunner for NoRunner {
    async fn call(
        &self,
        _: &Path,
        _: &str,
        _: &str,
        _: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        panic!("relay oracle must not read an external runner");
    }
}

fn handler(dir: &Path) -> McHandler {
    let descriptor = StorageDescriptor {
        module_id: DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("oracle.db").to_string_lossy().into_owned(),
        },
    };
    let mut handler = McHandler::new();
    handler
        .store
        .set(Arc::new(McStore::open_for_test(&descriptor).unwrap()))
        .ok()
        .unwrap();
    handler.provider_runner = Arc::new(NoRunner);
    handler.bind_route(
        7,
        SessionBinding {
            connection_incarnation: 0,
            native_generation: None,
            principal: None,
            // Compaction IDs hash the project identity; a temporary directory would change them.
            project_root: "/relay-conformance/project".into(),
            harness: "opencode".into(),
            session: "relay-v1".into(),
            model_key: None,
            history_budget_tokens: 4000.0,
            config: McModuleConfig {
                inject_docs: false,
                memory_enabled: false,
                protected_tokens_user: Some(0),
                protected_tools: BTreeMap::new(),
                cache_ttl: "10m".into(),
                ..Default::default()
            },
        },
    );
    handler
}

#[tokio::test]
async fn oracle() {
    // Normal cargo test runs do not start the interactive generator service.
    if std::env::var_os("MC_RELAY_ORACLE").is_none() {
        return;
    }
    let mut dir = tempfile::tempdir().unwrap();
    let mut mc = handler(dir.path());
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let answer = match request["control"].as_str() {
            Some("reset") => {
                drop(mc);
                dir = tempfile::tempdir().unwrap();
                mc = handler(dir.path());
                String::new()
            }
            Some("restart") => {
                drop(mc);
                mc = handler(dir.path());
                String::new()
            }
            Some("publish") => {
                let ordinal = request["ordinal"].as_u64().unwrap() as i64;
                mc.store
                    .get()
                    .unwrap()
                    .replace_compartments(
                        "relay-v1",
                        &[mc_store::StoredCompartment {
                            sequence: 0,
                            start_message: 1,
                            end_message: ordinal,
                            end_message_id: format!("{}#0", request["end_mid"].as_str().unwrap()),
                            title: "relay history".into(),
                            content: request["content"].as_str().unwrap().into(),
                            p1: Some(request["content"].as_str().unwrap().into()),
                            importance: 50,
                            ..Default::default()
                        }],
                    )
                    .unwrap();
                String::new()
            }
            _ => match mc.dispatch_value(7, request).await {
                HandlerOutcome::Response(bytes) => String::from_utf8(bytes).unwrap(),
                other => panic!("relay oracle request failed: {other:?}"),
            },
        };
        println!("RELAY_ORACLE {}", serde_json::to_string(&answer).unwrap());
        std::io::stdout().flush().unwrap();
    }
}
