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
            principal: Some(subc_protocol::Principal::Reserved {
                module_id: "thalamus-harness".into(),
            }),
            scope: Some(super::host_lane_tests::scope()),
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
            Some("scheduler") => {
                serde_json::to_string(&crate::scheduler::ORACLE_OUTCOME.lock().unwrap().take())
                    .unwrap()
            }
            Some("input_decisions") => serde_json::to_string(
                &request["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|case| {
                        super::compaction::oracle_input_decision(
                            &case["frame"],
                            case["now"].as_u64().unwrap(),
                            case["mid_tool_use"].as_bool().unwrap(),
                        )
                    })
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
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

/// Serve the real module to the TypeScript pending-versus-clean bridge test.
/// This separate endpoint leaves the existing relay-v1 JSON examples unchanged.
#[tokio::test]
async fn pending_watermark_oracle() {
    let Some(root) = std::env::var_os("MC_PENDING_WATERMARK_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let allowed = std::env::temp_dir().join("magic-context/bridge-tag-reference");
    assert!(root.starts_with(&allowed), "probe stores must be synthetic");
    std::fs::create_dir_all(&root).unwrap();
    let mc = handler(&root);
    let mut binding = mc.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.project_root = root.clone();
    mc.bind_route(7, binding);
    let mut fixture_pressure = None;
    let mut publications = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let mut request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let answer = if request["control"] == "pressure" {
            // The bridge cannot supply measured usage to its compaction controls.
            // Set a synthetic token estimate on the next compaction request so
            // both delivery modes can exercise the engine's force-band decision.
            fixture_pressure = Some(request["tokens"].as_u64().unwrap());
            "{}".into()
        } else if request["control"] == "publish" {
            let ordinal = request["ordinal"].as_i64().unwrap();
            publications.push(mc_store::StoredCompartment {
                sequence: request["sequence"].as_i64().unwrap(),
                start_message: request["start_ordinal"].as_i64().unwrap(),
                end_message: ordinal,
                start_message_id: format!("{}#0", request["start_mid"].as_str().unwrap()),
                end_message_id: format!("{}#1", request["end_mid"].as_str().unwrap()),
                title: "synthetic history".into(),
                content: request["content"].as_str().unwrap().into(),
                p1: Some(request["content"].as_str().unwrap().into()),
                importance: 50,
                ..Default::default()
            });
            mc.store
                .get()
                .unwrap()
                .replace_compartments("relay-v1", &publications)
                .unwrap();
            "{}".into()
        } else {
            let declaration = request["method"] == "transform.declare";
            if request["method"] == "compaction.step" {
                if let Some(tokens) = fixture_pressure.take() {
                    request["params"]["estimate"]["request_tokens"] = json!(tokens);
                }
            }
            match mc.dispatch_value(7, request).await {
                HandlerOutcome::Response(bytes) if declaration => {
                    // Slow shared-runner I/O must not burn tags because a hook
                    // timed out. Pending and clean delivery use identical budgets.
                    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
                    for subscription in value["subscriptions"].as_array_mut().unwrap() {
                        subscription["budget_ms"] = json!(10_000);
                    }
                    serde_json::to_string(&value).unwrap()
                }
                HandlerOutcome::Response(bytes) => String::from_utf8(bytes).unwrap(),
                other => panic!("pending watermark oracle request failed: {other:?}"),
            }
        };
        println!("PENDING_ORACLE {}", serde_json::to_string(&answer).unwrap());
        std::io::stdout().flush().unwrap();
    }
}
